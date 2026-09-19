// Windows 95/98 games from eXoWin9x, for the browser build of DOSBox-X (js-dos).
//
// eXoWin9x is built differently from eXoDOS and eXoWin3x. Every game starts the same copy of
// Windows 98, a VHD in eXo's emulators folder, through a throwaway differencing disk made at
// each launch, so Windows is always as eXo set it up. The game is a zip in
// "<collection>\<year>\" holding its own VHD (drive D:, with a shortcut and registry entries
// that Windows' start-up script copies in and runs) and usually CD images or a zip mounted as
// drive E:. The launcher folder, "<collection>\!win9x\<year>\<GameDir>\", has Play.conf, the
// DOSBox-X config that mounts them all and boots.
//
// In the browser the two VHDs are read piece by piece over HTTP as sockdrives (see vhd.js):
// the Windows disk alone is ~400 MB and the same for every game, so the browser keeps the
// pieces it has read. Windows' changes to it stay in the tab and are gone at the next start,
// as with eXo's differencing disk. The CD images and zips are loaded into memory like a DOS
// game's zip, from the server's unpacked copy of the game's zip.

import path from 'node:path';
import { splitArgs } from './dosbox.js';

/** Stands in for the page's own origin in the conf's sockdrive URLs, which must be absolute. */
export const ORIGIN_PLACEHOLDER = '{origin}';

/**
 * Where a Windows 9x game's files are, from its launcher path
 * ("eXo\eXoWin9x\!win9x\1995\Apache (1995)\Apache (1995).bat"), or null for other launchers.
 */
export function win9xLayout(applicationRel) {
  const m = /^(.*)[\\/](!win9x)[\\/](\d{4})[\\/]([^\\/]+)[\\/][^\\/]+\.bat$/i.exec(applicationRel ?? '');
  if (!m) return null;
  return {
    collection: m[1],
    exoRoot: path.dirname(m[1]),
    launcherDir: path.join(m[1], m[2], m[3], m[4]),
    year: m[3],
    gameDir: m[4],
    zipRel: path.join(m[1], m[3], `${m[4]}.zip`),
  };
}

/** eXo's host path for a file of the game ".\eXoWin9x\1995\Apache (1995)\x.iso" as a path inside the game's zip. */
function gamePath(hostPath) {
  const m = /^\.?[\\/]?exowin9x[\\/]\d{4}[\\/](.+)$/i.exec(hostPath.trim());
  return m ? m[1].replace(/\\/g, '/') : null;
}

/** eXo's host path of a file in the eXo folder (".\emulators\dosbox\x98\parent/W98-C.vhd"), relative to that folder. */
function exoPath(hostPath) {
  return path.normalize(hostPath.trim().replace(/^\.[\\/]/, ''));
}

/**
 * What a Play.conf's autoexec mounts: `systemDisk`, the Windows VHD relative to the eXo folder
 * (the parent of the differencing disk it makes); `gameDisk`, the game's VHD inside its zip;
 * `drives`, the other mounts (CD images, zips) as { letter, command, files, options }, with
 * paths inside the zip; `media`, "CD" when a CD image is mounted. Null when the autoexec
 * doesn't boot Windows from a VHD as eXo's DOSBox-X launchers do.
 */
export function parseWin9xAutoexec(lines) {
  const made = new Map(); // differencing disk -> its parent, both relative to the eXo folder
  let systemDisk = null;
  let gameDisk = null;
  let boots = false;
  const drives = [];
  for (const line of lines) {
    const m = /^@?(\w+)\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const command = m[1].toLowerCase();
    const args = splitArgs(m[2]);
    const isOption = (a) => !a.quoted && a.value.startsWith('-');
    if (command === 'vhdmake') {
      const plain = args.filter((a) => !isOption(a));
      if (args.some((a) => /^-(l|link)$/i.test(a.value)) && plain.length >= 2) {
        made.set(exoPath(plain[1].value).toLowerCase(), exoPath(plain[0].value));
      }
    } else if (command === 'imgmount' || command === 'mount') {
      // "imgmount e "a.cue" "b.cue" -t cdrom -ide 2m": the drive, its files, then the options.
      const firstOption = args.findIndex(isOption);
      const positional = firstOption < 0 ? args : args.slice(0, firstOption);
      const letter = positional[0]?.value.toLowerCase();
      const files = positional.slice(1).map((a) => a.value);
      if (!letter || !files.length) continue;
      if (command === 'imgmount' && letter === 'c') {
        const disk = exoPath(files[0]);
        systemDisk = made.get(disk.toLowerCase()) ?? disk;
      } else if (command === 'imgmount' && letter === 'd' && /\.vhd$/i.test(files[0])) {
        gameDisk = gamePath(files[0]);
      } else {
        const inZip = files.map(gamePath);
        if (inZip.some((f) => f === null)) return null; // a mount of something outside the game
        const options = firstOption < 0 ? '' : args.slice(firstOption).map((a) => a.value).join(' ');
        drives.push({ letter, command, files: inZip, options });
      }
    } else if (command === 'boot') {
      boots = true;
    }
  }
  if (!systemDisk || !gameDisk || !boots) return null;
  const media = drives.some((d) => /-t\s+(cdrom|iso)\b/i.test(d.options) || d.files.some((f) => /\.(cue|iso|ccd|img|bin)$/i.test(f))) ? 'CD' : 'Hard disk';
  return { systemDisk, gameDisk, drives, media };
}

// Sections that describe the host, not the emulated PC; and keys naming host files or devices.
const DROP_SECTIONS = new Set(['sdl', 'log', 'autoexec', 'config', '4dos', 'mapper', 'ethernet, pcap', 'ethernet, slirp']);
const DROP_KEYS = /^(captures|autosave|savefile|language|glshader|pixelshader|midiconfig|mididevice|fluid\..*|mt32\..*|soundfont|romdir|phonebookfile|font|fontbold|fontital|fontboit|dongle)$/;

/**
 * The conf the browser runs for a Windows 9x game. Everything that describes the emulated PC is
 * kept as eXo set it: its Windows was installed on that hardware, and knows each Plug and Play
 * device by the number the BIOS gives it, in the order devices are added. A device that's missing
 * moves every later one down, and Windows then finds "new hardware", asks to restart, and loses
 * the CD drive (registered under the second IDE controller's number). So only what the browser
 * build lacks is changed, for something that takes the same place:
 * - the printer port (the build has no printer) is a Disney Sound Source on the same port;
 * - MMX, which the build names jsdos_pentium_mmx;
 * - the network card is connected to nothing (its host side needs a network driver; eXo's
 *   network-ready Windows complains when the card is missing).
 * The disks are sockdrives, which only mount by BIOS number (2 = C:, 3 = D:), so the boot is
 * "boot c:"; commands that copy between drive letters before booting are left out.
 * @param {Map} sections from parseDosboxConf
 * @param {{ mounts: ReturnType<typeof parseWin9xAutoexec>, systemUrl: string, gameUrl: string,
 *   sound?: string, soundfont?: string|null, fixPath?: (p: string) => string }} options
 */
export function win9xConf(sections, { mounts, systemUrl, gameUrl, sound = 'default', soundfont = null, fixPath = (p) => p }) {
  const out = [];
  for (const [name, entries] of sections) {
    if (DROP_SECTIONS.has(name)) continue;
    const kept = entries.filter(({ key }) => !DROP_KEYS.test(key)).map(({ key, value }) => {
      if (name === 'cpu' && key === 'cputype' && /^pentium_mmx$/i.test(value)) return { key, value: 'jsdos_pentium_mmx' };
      if (name === 'ne2000' && key === 'backend') return { key, value: 'nothing' };
      if (name === 'parallel' && /^parallel\d$/.test(key) && /^printer\b/i.test(value)) return { key, value: 'disney' };
      return { key, value };
    });
    if (name === 'ne2000' && !kept.some((e) => e.key === 'backend')) kept.push({ key: 'backend', value: 'nothing' });
    if (name === 'midi') {
      kept.push({ key: 'mididevice', value: sound === 'fluidsynth' && soundfont ? 'fluidsynth' : 'none' });
      if (sound === 'fluidsynth' && soundfont) kept.push({ key: 'fluid.soundfont', value: `./mt32/${soundfont}` });
    }
    if (!kept.length) continue;
    out.push(`[${name}]`, ...kept.map((e) => `${e.key}=${e.value}`), '');
  }
  const quote = (p) => `"${fixPath(`./${p}`)}"`;
  out.push(
    '[autoexec]',
    'echo off',
    `imgmount 2 sockdrive ${systemUrl}`,
    `imgmount 3 sockdrive ${gameUrl}`,
    ...mounts.drives.map((d) => `${d.command} ${d.letter} ${d.files.map(quote).join(' ')}${d.options ? ` ${d.options}` : ''}`),
    'boot c:',
    '',
  );
  return out.join('\n');
}

// ---------- The Windows disk, as the browser gets it ----------

/**
 * The biggest screen the browser's DOSBox-X can show. js-dos builds it with the render scalers
 * reduced to save memory, which caps video modes at 800x600: a mode past that is refused as if
 * the card didn't have it. eXo's Windows is set to 1024x768, so it would fall back to 16
 * colours, where no DirectX game starts. See fitDisplaySettings.
 */
export const MAX_SCREEN = { width: 800, height: 600 };

/** Changes when fitDisplaySettings does, so a browser's kept pieces of the disk from before aren't used. */
export const SYSTEM_DISK_EDITION = 'screen-800x600';

// A string value in a Windows 9x registry file: type 1, four bytes of 0xff, the lengths of the
// name and the data, then both. Matched where the name is "Resolution".
const RESOLUTION_VALUE = /\x01\x00\x00\x00\xff\xff\xff\xff\x0a\x00([\x07-\x0b])\x00Resolution(\d+),(\d+)/g;

/**
 * Sets every screen resolution in Windows' registry that's bigger than MAX_SCREEN to MAX_SCREEN,
 * in `buffer` (disk data, changed in place), and returns how many it changed. The new value takes
 * exactly the room of the old one ("1024,768" becomes "0800,600", which Windows reads as
 * 800x600), so nothing else in the registry file moves.
 */
export function fitDisplaySettings(buffer) {
  const maxWidth = String(MAX_SCREEN.width);
  const maxHeight = String(MAX_SCREEN.height);
  let changed = 0;
  for (const m of buffer.toString('latin1').matchAll(RESOLUTION_VALUE)) {
    const [, dataLength, width, height] = m;
    const value = `${width},${height}`;
    if (dataLength.charCodeAt(0) !== value.length) continue; // not a whole value
    if (Number(width) <= MAX_SCREEN.width && Number(height) <= MAX_SCREEN.height) continue;
    if (width.length < maxWidth.length || height.length < maxHeight.length) continue;
    buffer.write(`${maxWidth.padStart(width.length, '0')},${maxHeight.padStart(height.length, '0')}`, m.index + m[0].length - value.length, 'latin1');
    changed++;
  }
  return changed;
}

// How far a piece is read past each end, so a registry value that crosses from one piece into
// the next is still found: longer than a whole Resolution value.
const PIECE_OVERLAP = 64;

/** Reads `length` bytes of eXo's Windows disk at `offset`, with its screen resolution fitted to the browser. */
export async function readSystemDisk(vhd, offset, length) {
  const start = Math.max(0, offset - PIECE_OVERLAP);
  const data = await vhd.read(start, length + (offset - start) + PIECE_OVERLAP);
  fitDisplaySettings(data);
  return data.subarray(offset - start, offset - start + length);
}

/**
 * The files of a CD game's bundle with each track named the way its cue sheet spells it. Windows
 * doesn't mind "UDOOM.BIN" for udoom.bin, but the browser's file system does, and DOSBox-X then
 * can't load the CD at all. `cues` maps a cue sheet's name in the bundle to its text. A file the
 * sheets name in no other spelling keeps its name; the files themselves are the same.
 */
export function nameTracksAsCues(files, cues) {
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const renamed = new Map();
  for (const [cue, text] of cues) {
    const dir = cue.includes('/') ? cue.slice(0, cue.lastIndexOf('/') + 1) : '';
    for (const m of text.matchAll(/^\s*FILE\s+(?:"([^"]+)"|(\S+))/gim)) {
      const wanted = `${dir}${(m[1] ?? m[2]).replace(/\\/g, '/')}`;
      const file = byName.get(wanted.toLowerCase());
      if (file && file.name !== wanted && !renamed.has(file)) renamed.set(file, wanted);
    }
  }
  return files.map((f) => (renamed.has(f) ? { ...f, as: renamed.get(f) } : f));
}

/** Files of a game's unpacked zip that go into the browser's memory: everything but its hard disk. */
export const inBundle = (name) => !/\.vhd$/i.test(name);

/** A problem that stops a Windows 9x launcher from working in the browser, or null. */
export function win9xIssue({ confFound = true, mounts = null, zipFound = true, systemFound = true, gameDiskFound = true, bundleBytes = 0, maxBytes = Infinity } = {}) {
  if (!confFound) return 'Runs in 86Box or PCBox, which the browser can\'t run.';
  if (!mounts) return 'Its launcher doesn\'t start Windows the way the browser can.';
  if (!zipFound) return 'The game\'s zip wasn\'t found in the eXoWin9x folder.';
  if (!gameDiskFound) return 'The game\'s zip has no hard disk image in it.';
  if (!systemFound) return `eXo's Windows disk (${path.basename(mounts.systemDisk)}) wasn't found.`;
  if (bundleBytes > maxBytes) {
    return `Too big to load in the browser (${(bundleBytes / 1024 ** 3).toFixed(1)} GB of CD images would have to fit in memory).`;
  }
  return null;
}
