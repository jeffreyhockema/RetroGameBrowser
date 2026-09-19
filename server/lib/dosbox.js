// eXoDOS launchers for the browser: turns a game's DOSBox config into one the browser build
// (js-dos) can run.
//
// eXoDOS keeps each game as "<collection>\<Game (Year)>.zip" plus a folder of launcher files
// in "<collection>\!dos\<GameDir>\": a stub .bat, a dosbox.conf (sometimes more than one, for
// Tandy/CGA/… variants), an optional exception.bat menu and an Extras folder. The conf mounts
// the unpacked game with host paths like ".\eXoDOS\<GameDir>"; in the browser the zip is
// unpacked at the root of the emulated file system, so those paths become ".\<GameDir>".

import path from 'node:path';
import yauzl from 'yauzl';

export const SOUND_LABELS = {
  default: 'Standard',
  mt32: 'Roland MT-32',
  fluidsynth: 'Roland Sound Canvas',
};

/** Sound choices that need DOSBox-X (the plain browser DOSBox has no MIDI synthesizer). */
export const MIDI_SOUNDS = new Set(['mt32', 'fluidsynth']);

// Sections passed through to the browser build, in this order. [sdl] is the host window and
// is left out; DOSBox-X-only sections (pci, voodoo, …) too.
const KEEP_SECTIONS = ['dosbox', 'render', 'cpu', 'mixer', 'midi', 'sblaster', 'gus', 'speaker', 'joystick', 'serial', 'dos', 'ipx'];

// Keys that name host files or are for other DOSBox builds.
const DROP_KEYS = /^(mapperfile|captures|language|fluid\..*|mt32\..*|soundfont|romdir|midiconfig|mididevice|glshader|texture_renderer|priority)$/;

/**
 * Parses a DOSBox .conf into a map of section name -> entries. Sections hold
 * [{ key, value }] pairs; the autoexec section holds its lines verbatim.
 */
export function parseDosboxConf(text) {
  const sections = new Map();
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1].toLowerCase();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current === null) continue;
    if (current === 'autoexec') {
      if (line) sections.get(current).push(line);
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (kv) sections.get(current).push({ key: kv[1].trim().toLowerCase(), value: kv[2].trim() });
  }
  return sections;
}

/** First value of a key in a section, or null. */
export function confValue(sections, section, key) {
  return sections.get(section)?.find((e) => e.key === key)?.value ?? null;
}

/** "CD" when the game runs from a CD image, else "Floppy". */
export function mediaOf(autoexec) {
  for (const line of autoexec) {
    if (/^@?imgmount\b/i.test(line) && (/-t\s+(cdrom|iso)\b/i.test(line) || /\.(cue|iso|ccd|mds|gog|ins)\b/i.test(line))) return 'CD';
  }
  return 'Floppy';
}

/**
 * The MIDI device eXo set up for the game: "mt32", "fluidsynth", or "default" when the conf
 * only points at the MT-32 ROMs or soundfont (the game then uses the host's own synthesizer).
 * Null when the game isn't set up for MIDI music at all.
 */
export function midiDeviceOf(sections) {
  const device = (confValue(sections, 'midi', 'mididevice') ?? '').toLowerCase();
  if (device === 'none') return null;
  if (device && device !== 'default') return device;
  const midi = sections.get('midi') ?? [];
  return midi.some((e) => /^(mt32\.|fluid\.)/.test(e.key)) ? 'default' : null;
}

/** Splits a command's arguments, keeping quoted parts together and remembering the quotes. */
export function splitArgs(text) {
  const args = [];
  for (const m of text.matchAll(/"([^"]*)"|(\S+)/g)) args.push({ value: m[1] ?? m[2], quoted: m[1] !== undefined });
  return args;
}

/**
 * Rewrites an eXo autoexec for the browser: host paths under the collection folder become
 * paths under the bundle root, backslashes become slashes (the emulated host is Unix-like)
 * and `fixPath` corrects their case against the zip's contents. Host-side "cd .." lines
 * before the first mount are dropped.
 */
export function rewriteAutoexec(lines, fixPath = (p) => p) {
  const result = [];
  let mounted = false;
  for (const line of lines) {
    const m = /^(@?)(mount|imgmount|boot)\s+(.*)$/i.exec(line);
    if (!m) {
      if (!mounted && /^@?cd\s+\.\.\s*$/i.test(line)) continue;
      result.push(line);
      continue;
    }
    if (!/^boot$/i.test(m[2])) mounted = true;
    const args = splitArgs(m[3]).map((a) => (
      a.value.startsWith('-') || /^[a-z]:?$/i.test(a.value) ? a : { ...a, value: hostPath(a.value, fixPath) }));
    result.push(`${m[1]}${m[2]} ${args.map((a) => (a.quoted || /\s/.test(a.value) ? `"${a.value}"` : a.value)).join(' ')}`);
  }
  return result;
}

function hostPath(p, fixPath) {
  let s = p.replace(/\\/g, '/');
  // eXo mounts the game's folder inside the collection ("./eXoDOS/Abuse", "./eXoWin3x/JezzBall");
  // in the browser that folder is at the root of the emulated drive.
  s = s.replace(/^\.\/exo(dos|win3x)\/?/i, './');
  if (s === './') s = '.';
  return fixPath(s);
}

/**
 * The conf text for the browser build.
 * @param {Map} sections from parseDosboxConf
 * @param {{ sound?: string, soundfont?: string|null, fixPath?: (p: string) => string, autoexec?: string[]|null }} options
 *   `sound`: default | mt32 | fluidsynth (the MIDI ones need DOSBox-X and files under ./mt32).
 *   `autoexec`: start-up lines to use instead of the conf's own, which is how a game is
 *   started for two people (see lib/netbat.js). They're rewritten for the browser just the same.
 */
export function browserConf(sections, { sound = 'default', soundfont = null, fixPath, autoexec = null } = {}) {
  const out = [];
  for (const name of KEEP_SECTIONS) {
    const entries = (sections.get(name) ?? []).filter(({ key }) => !DROP_KEYS.test(key));
    if (name === 'midi') {
      entries.push({ key: 'mididevice', value: MIDI_SOUNDS.has(sound) ? sound : 'none' });
      if (sound === 'mt32') entries.push({ key: 'mt32.romdir', value: './mt32' });
      if (sound === 'fluidsynth' && soundfont) entries.push({ key: 'fluid.soundfont', value: `./mt32/${soundfont}` });
    }
    if (!entries.length) continue;
    out.push(`[${name}]`, ...entries.map((e) => `${e.key}=${e.value}`), '');
  }
  out.push('[autoexec]', ...rewriteAutoexec(autoexec ?? sections.get('autoexec') ?? [], fixPath), '');
  return out.join('\n');
}

/**
 * Whether eXo set the game up for network play: its conf turns DOSBox's IPX on. That flag is
 * how eXoDOS marks the 255 games with LAN multiplayer, and most of those also carry a
 * network.bat that knows how to start them (see lib/netbat.js).
 */
export const wantsIpx = (sections) => (confValue(sections, 'ipx', 'ipx') ?? 'false').trim().toLowerCase() === 'true';

/** Whether the conf asks for aspect-corrected output (320×200 shown as 4:3). */
export const wantsAspect = (sections) => (confValue(sections, 'render', 'aspect') ?? 'false').toLowerCase() === 'true';

/** Whether the conf locks the mouse to the game (autolock), as games that steer with it do. */
export const wantsMouseLock = (sections) => (confValue(sections, 'sdl', 'autolock') ?? 'false').trim().toLowerCase() === 'true';

/**
 * Readable name for one of a game's confs: dosbox.conf is the game itself; the others
 * ("tandy.conf", "dosbox_cga.conf", "dosbox2.conf") describe a variant.
 */
export function confLabel(fileName, title) {
  const base = fileName.replace(/\.conf$/i, '');
  if (/^dosbox$/i.test(base)) return title;
  const variant = base.replace(/^dosbox[_ -]?/i, '').replace(/_/g, ' ').trim();
  if (!variant) return title;
  if (/^\d+$/.test(variant)) return `${title} (alternative ${variant})`;
  const words = variant.split(/\s+/).map((w) => (/^(cga|ega|vga|pcjr|mcga|svga|gus|sb|mt32)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  return `${title} (${words.join(' ')})`;
}

/**
 * Builds a path fixer from a zip's entry names: "./megarace/CD/x.iso" becomes the entry's
 * real spelling, because the emulated file system is case-sensitive and eXo's confs aren't.
 */
export function pathFixerFor(entryNames) {
  const root = new Map(); // lower-cased segment -> { name, children }
  for (const entry of entryNames) {
    let node = root;
    for (const seg of entry.split('/').filter(Boolean)) {
      const key = seg.toLowerCase();
      if (!node.has(key)) node.set(key, { name: seg, children: new Map() });
      node = node.get(key).children;
    }
  }
  return (p) => {
    const m = /^(\.\/)(.*)$/.exec(p);
    if (!m) return p;
    let node = root;
    const fixed = m[2].split('/').map((seg) => {
      const hit = node?.get(seg.toLowerCase());
      node = hit?.children;
      return hit ? hit.name : seg;
    });
    return `./${fixed.join('/')}`;
  };
}

/**
 * Folders that must exist before the browser unpacks a zip. js-dos creates the parents of
 * every file it extracts, but a folder entry ("Abuse/ABUSE/ADDON/") is created as-is, so
 * when it comes before any file in its parent folder the extraction fails. Returns those
 * parents, deepest last, in extraction order.
 */
export function foldersNeededBefore(entryNames) {
  const exists = new Set();
  const needed = [];
  const addParents = (dir) => {
    const parts = dir.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) exists.add(parts.slice(0, i).join('/'));
  };
  for (const name of entryNames) {
    if (name.endsWith('/')) {
      const dir = name.slice(0, -1);
      const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
      if (parent && !exists.has(parent)) {
        needed.push(parent);
        addParents(parent);
      }
      exists.add(dir);
    } else if (name.includes('/')) {
      addParents(name.slice(0, name.lastIndexOf('/')));
    }
  }
  return needed;
}

/** Names of every entry in a zip (reads only its central directory). */
export function listZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: false, autoClose: true }, (err, zipfile) => {
      if (err) return reject(err);
      const names = [];
      zipfile.on('entry', (entry) => names.push(entry.fileName));
      zipfile.on('end', () => resolve(names));
      zipfile.on('error', reject);
    });
  });
}

/** Every file in a zip with its unpacked size, [{ name, size }] (reads only its central directory). */
export function listZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: false, autoClose: true }, (err, zipfile) => {
      if (err) return reject(err);
      const entries = [];
      zipfile.on('entry', (entry) => entries.push({ name: entry.fileName, size: entry.uncompressedSize }));
      zipfile.on('end', () => resolve(entries));
      zipfile.on('error', reject);
    });
  });
}

/**
 * The text of one small file in a zip, found without regard to case (eXo's own paths aren't
 * consistent about it), or null when the zip hasn't got one. `maxBytes` guards against a name
 * that matches something far larger than expected. A matching file that can't be read rejects,
 * rather than reading as missing, so a caller can tell a share that blipped from no file.
 */
export function readZipText(zipPath, matches, { maxBytes = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) return reject(err);
      let done = false;
      const finish = (value) => { if (!done) { done = true; resolve(value); } };
      const fail = (e) => { if (!done) { done = true; reject(e); zipfile.close(); } };
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (!matches(entry.fileName) || entry.uncompressedSize > maxBytes) return zipfile.readEntry();
        return zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return fail(streamErr);
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => { finish(Buffer.concat(chunks).toString('latin1')); zipfile.close(); });
          stream.on('error', fail);
          return undefined;
        });
      });
      zipfile.on('end', () => finish(null));
      zipfile.on('close', () => finish(null));
      zipfile.on('error', reject);
    });
  });
}

/** The first `count` bytes of a file in a zip (the one named `member`), or null when it isn't there. */
export async function readZipBytes(zipPath, member, count) {
  const entry = await openZipEntry(zipPath, (name) => name === member);
  if (!entry) return null;
  const chunks = [];
  let got = 0;
  for await (const chunk of entry.stream) {
    chunks.push(chunk);
    got += chunk.length;
    if (got >= count) break;
  }
  entry.stream.destroy();
  return Buffer.concat(chunks).subarray(0, count);
}

/**
 * One file in a zip, to send on: { stream, size } for the first entry `matches` picks, or null when
 * there's none. The zip closes when the stream ends or is destroyed.
 */
export function openZipEntry(zipPath, matches) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) return reject(err);
      let done = false;
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (!matches(entry.fileName)) return zipfile.readEntry();
        return zipfile.openReadStream(entry, (streamErr, stream) => {
          done = true;
          if (streamErr) {
            zipfile.close();
            return reject(streamErr);
          }
          stream.on('close', () => zipfile.close());
          return resolve({ stream, size: entry.uncompressedSize });
        });
      });
      zipfile.on('end', () => { if (!done) resolve(null); });
      zipfile.on('error', (e) => { if (!done) reject(e); });
    });
  });
}

/** A problem that stops a launcher from working in the browser, or null. */
export function launcherIssue({ exceptionBat = '', zipSize = 0, maxZipBytes = Infinity } = {}) {
  if (zipSize > maxZipBytes) {
    return `Too big to load in the browser (${(zipSize / 1024 ** 3).toFixed(1)} GB of game data would have to fit in memory).`;
  }
  if (/sciaudio/i.test(exceptionBat)) return 'Needs a Windows helper program (sciAudio) that the browser can\'t run.';
  return null;
}

export const isConfFile = (name) => /\.conf$/i.test(name);

/** The zip that holds a launcher's game: "<Game (Year)>.bat" -> "<Game (Year)>.zip". */
export const zipNameFor = (batName) => `${path.basename(batName).replace(/\.bat$/i, '')}.zip`;
