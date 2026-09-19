// eXo's Apple IIGS collection, played with MAME's Apple IIgs (the "apple2gs" bundle of the
// browser MAME build, see lib/mame.js).
//
// eXo runs most of these games with GSplus and the rest with MAME. Each game has a launcher,
// "eXo\eXoAppleIIGS\!appleiigs\<Game>\<Game>.bat", and its disks in "eXoAppleIIGS\<Game>.zip".
// Next to the launcher is either a GSplus config.txt, naming the disk in each drive and which
// IIgs ROM to start ("s7d1 = game.po", "g_cfg_rom_path = ..\GSPlus\ROM1"), or an exception.bat
// for a game eXo runs with MAME ("SET DISK1=Game.hdv"). Both are turned into MAME's own terms:
//
//   GSplus slot 7 (SmartPort)   -> a CFFA2 CompactFlash card in slot 7, its drives -hard1, -hard2
//                                  (as eXo's MAME games are set up)
//   GSplus slot 5 (3.5" drives) -> MAME's 3.5" drives, -flop3 and -flop4
//   GSplus slot 6 (5.25")       -> MAME's 5.25" drives, -flop1 and -flop2
//   ROM1 / ROM3                 -> the machines apple2gsr1 / apple2gs
//
// A IIgs set to scan for its startup disk looks in slot 7 first, so a game whose disk is in slot 7
// starts from the card, and one with only 3.5" disks starts from those.

import path from 'node:path';
import { dataJson } from './util.js';

export const IIGS_BUNDLE = 'apple2gs';

let knownIssues = null;
/** What goes wrong with a game in the browser (server/data/iigs-known-issues.json), by its folder, or null. */
export function iigsKnownIssue(gameDir) {
  knownIssues ??= dataJson('iigs-known-issues.json').games ?? {};
  return knownIssues[gameDir] ?? null;
}

let notesInPlace = null;
/**
 * What's said here in place of eXo's own notes for a game (server/data/iigs-notes.json), by its
 * folder: notes that describe GSplus (its F4 disk menu) or eXo's setup of it, which aren't so in
 * MAME. A string, null to say nothing, or undefined to use eXo's.
 */
export function iigsNotesInPlace(gameDir) {
  notesInPlace ??= dataJson('iigs-notes.json').games ?? {};
  return Object.hasOwn(notesInPlace, gameDir) ? notesInPlace[gameDir] : undefined;
}
// What the bundle is built from (bundles.json in the build repository): the IIgs, and the first
// Apple II, which the IIgs driver names as a machine its software runs on and without which
// MAME's startup check won't run it. Kept out of mame-bundles.json, whose drivers are the
// arcade games' (see scripts/build-mame-data.mjs); scripts/fetch-mame.mjs fetches both.
export const IIGS_SOURCES = ['apple2gs.cpp', 'apple2.cpp'];

// Where a game's launcher is: "eXo\eXoAppleIIGS\!appleiigs\<GameDir>\<Game (Year)>.bat".
const LAUNCHER = /(^|[\\/])eXoAppleIIGS[\\/]!appleiigs[\\/]([^\\/]+)[\\/]([^\\/]+)\.bat$/i;

// The CFFA2 card takes two drives; the rest of slot 7's disks go in whichever floppy drives are free.
const HARD = ['hard1', 'hard2'];
const THREE_AND_A_HALF = ['flop3', 'flop4'];
const FIVE_AND_A_QUARTER = ['flop1', 'flop2'];
// The biggest image a floppy drive takes: an 800K disk with a DiskCopy header and tags.
const FLOPPY_MAX_BYTES = 840 * 1024;
// DiskCopy 4.2 images with their tags (84 bytes of header, the disk, 12 tag bytes a block), an
// 800K disk and a 400K one. GSplus knows one by what's in it; MAME only by its name, and eXo has
// some called ".2mg".
const DISKCOPY_SIZES = new Set([84 + 819200 + 19200, 84 + 409600 + 9600]);

/**
 * The file type MAME is to take a disk as, which it goes by rather than what's in the file: for a
 * hard disk, a plain image is an ".hdv" (a ProDOS-order ".po" is the same bytes); for a 3.5" drive
 * an ".img" (MAME's raw 400K/800K sector image); for a 5.25" drive a ".po" stays a ".po".
 */
function mameType(file, size, as) {
  const ext = path.extname(file).toLowerCase();
  if (DISKCOPY_SIZES.has(size)) return '.dc42';
  if (as.startsWith('hard')) return ['.hdv', '.2mg', '.hd', '.chd'].includes(ext) ? ext : '.hdv';
  if (THREE_AND_A_HALF.includes(as)) return ['.2mg', '.dc42', '.woz'].includes(ext) ? ext : '.img';
  return ext;
}

/** Where an eXo IIgs game's launcher says its files are: { gameDir, gameName }, or null. */
export function exoIIgsLauncher(applicationRel) {
  const m = LAUNCHER.exec(applicationRel ?? '');
  return m ? { gameDir: m[2], gameName: m[3] } : null;
}

/**
 * A GSplus config.txt: { rom: 'ROM1'|'ROM3'|null, drives: [{ slot, drive, file }] }, the drives in
 * the order GSplus numbers them. An empty "s5d1 =" is an empty drive.
 */
export function parseGsplusConfig(text) {
  const drives = [];
  for (const m of text.matchAll(/^s(\d)d(\d)[ \t]*=[ \t]*([^\r\n]*)$/gm)) {
    const file = m[3].trim();
    if (file) drives.push({ slot: Number(m[1]), drive: Number(m[2]), file });
  }
  const romPath = /^g_cfg_rom_path[ \t]*=[ \t]*([^\r\n]*)$/m.exec(text)?.[1]?.trim() ?? '';
  const rom = /ROM3$/i.test(romPath) ? 'ROM3' : /ROM1$/i.test(romPath) ? 'ROM1' : null;
  return { rom, drives, bram: { ROM1: parseBram(text, 1), ROM3: parseBram(text, 3) } };
}

/**
 * The IIgs's battery RAM as GSplus keeps it in a config ("bram1[00] = 00 00 00 01 ..." sixteen bytes
 * a line, 256 in all; bram1 for ROM1, bram3 for ROM3): the Control Panel's settings, the startup
 * slot among them, and their checksum. As a base64 string, or null when it isn't all there or is
 * all zeros (GSplus's blank for the ROM a game doesn't use).
 */
function parseBram(text, which) {
  const bytes = new Uint8Array(256);
  let filled = 0;
  for (const m of text.matchAll(new RegExp(`^bram${which}\\[([0-9a-f]{2})\\][ \\t]*=[ \\t]*([0-9a-f \\t]+)$`, 'gim'))) {
    const at = parseInt(m[1], 16);
    const values = m[2].trim().split(/\s+/).map((b) => parseInt(b, 16));
    values.forEach((v, i) => { if (at + i < 256) bytes[at + i] = v; });
    filled += values.length;
  }
  if (filled < 256 || bytes.every((b) => b === 0)) return null;
  return Buffer.from(bytes).toString('base64');
}

/**
 * Whether the start of a disk image (its first 84 bytes or more) is a DiskCopy 4.2 header. A file
 * of a DiskCopy image's size may not be one: eXo has an 800K raw image with bytes after it, which
 * GSplus takes as the disk and MAME, which wants an 800K raw image to be exactly that, won't.
 */
export const isDiskCopy = (header) => header?.length >= 0x54 && header[0x52] === 0x01 && header[0x53] === 0x00;
// A raw 800K disk: what's sent of one with bytes after it (see isDiskCopy).
export const RAW_800K = 819200;

/** The battery RAM a plan's machine starts with, from its GSplus config (see parseBram), or null. */
export function iigsBram(setup, plan) {
  return setup.gsplus?.bram?.[plan.machine === 'apple2gs' ? 'ROM3' : 'ROM1'] ?? null;
}

/** An eXo exception.bat for a game run with MAME: the disks it sets, DISK1 first. */
export function parseExceptionBat(text) {
  const disks = [];
  // Spaces only around the "=": an empty "SET DISK2=" mustn't run on into the next line.
  for (const m of text.matchAll(/^[ \t]*SET[ \t]+DISK(\d)[ \t]*=[ \t]*([^\r\n]*)$/gim)) {
    const file = m[2].trim();
    if (file) disks[Number(m[1]) - 1] = file;
  }
  return disks.filter(Boolean);
}

/**
 * The choices an exception.bat offers before starting GSplus ("Press 1 for Cribbage King",
 * "Press 2 for Gin King"), each with the config it sets: [{ label, config }], in the menu's order.
 * Empty for one that offers none. The batch file's own flow is followed: the key chosen goes to a
 * label ("if errorlevel = 2 goto gin"), and the section under it sets CONFIGTXT.
 */
export function parseExceptionMenu(text) {
  const labels = new Map();
  for (const m of text.matchAll(MENU_LINE)) {
    labels.set(Number(m[1]), m[2].trim().replace(/[.!]+$/, ''));
  }
  const targets = new Map();
  for (const m of text.matchAll(/^[ \t]*if[ \t]+errorlevel[ \t]*=?[ \t]*(\d+)[ \t]+goto[ \t]+(\S+)/gim)) {
    targets.set(Number(m[1]), m[2].toLowerCase());
  }
  const configs = new Map();
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    const label = /^[ \t]*:(\S+)/.exec(line);
    if (label) section = label[1].toLowerCase();
    const set = /^[ \t]*SET[ \t]+CONFIGTXT[ \t]*=[ \t]*(\S+)/i.exec(line);
    if (set && section && !configs.has(section)) configs.set(section, set[1]);
  }
  const notes = parseExceptionNotes(text);
  return [...targets.keys()].sort((a, b) => a - b)
    .map((n) => ({ label: labels.get(n) ?? `Choice ${n}`, config: configs.get(targets.get(n)), notes: notes.sections.get(targets.get(n)) ?? null }))
    .filter((c) => c.config);
}

// A line of a list of keys: "d = Delete character", "alt+q = Quit".
const KEY_LINE = /^\S{1,12}[ \t]*=[ \t]*\S/;

// A menu's line: "echo Press 1 for Cribbage King".
const MENU_LINE = /^[ \t]*echo[ \t]+Press[ \t]+(\d+)[ \t]+(?:for|to play|to use|to)?[ \t]*([^\r\n]+)$/gim;

/**
 * What an exception.bat tells the player before the game starts, which eXo shows in a console
 * window: "To start the game double click "Castle.Metacus"", "When asked to insert disk 2, just
 * press enter". eXo wraps the text at the console's width, so its lines are joined back into
 * paragraphs (an empty "echo." ends one). `general`: what's said outside any of the batch file's
 * labelled sections; `sections`: what each section says, by its label in lower case (for a
 * menu, what's said once a choice is made). A menu's own lines ("Press 1 for …") are left out.
 * @returns {{ general: string | null, sections: Map<string, string> }}
 */
export function parseExceptionNotes(text) {
  const said = new Map(); // section (null before any label) -> paragraphs
  let section = null;
  let paragraph = [];
  const endParagraph = () => {
    if (!paragraph.length) return;
    if (!said.has(section)) said.set(section, []);
    // Wrapped lines rejoin, but a list of keys ("alt+a = Save game") keeps a line each.
    said.get(section).push(paragraph.reduce((text, line, i) => (i === 0 ? line
      : `${text}${KEY_LINE.test(line) || KEY_LINE.test(paragraph[i - 1]) ? '\n' : ' '}${line}`), ''));
    paragraph = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const label = /^[ \t]*:(\S+)/.exec(line);
    if (label) {
      endParagraph();
      section = label[1].toLowerCase();
      continue;
    }
    if (/^[ \t]*@?echo[.:][ \t]*$/i.test(line) || /^[ \t]*(?:cls|pause)\b/i.test(line)) {
      endParagraph();
      continue;
    }
    const echo = /^[ \t]*@?echo[ \t]+(.*)$/i.exec(line);
    if (!echo) continue;
    const words = echo[1].trim();
    if (!words || /^(?:on|off)$/i.test(words) || new RegExp(MENU_LINE.source, 'i').test(line)) {
      endParagraph();
      continue;
    }
    // The batch file's escapes: ^ before a special character, %% for a percent sign.
    paragraph.push(words.replace(/\^(.)/g, '$1').replace(/%%/g, '%'));
  }
  endParagraph();
  const join = (paragraphs) => (paragraphs?.length ? paragraphs.join('\n\n') : null);
  const sections = new Map();
  for (const [name, paragraphs] of said) if (name !== null) sections.set(name, join(paragraphs));
  return { general: join(said.get(null)), sections };
}

/**
 * How MAME starts a game: { machine, card, media: [{ file, as, type }], dropped: [file] }.
 * `media` names each disk's MAME drive (`as`, "hard1") and the file type MAME is to see it as.
 * `find(file)` says whether a disk named in the setup is actually among the game's files, and how
 * big it is ({ size }, or just true): a setup can name one that isn't there (or in another game's
 * folder), and that drive stays empty.
 * @param {{ gsplus?: ReturnType<typeof parseGsplusConfig>, mameDisks?: string[] }} setup
 */
export function iigsPlan({ gsplus = null, mameDisks = null }, find = () => true) {
  const media = [];
  const dropped = [];
  // A disk goes in the first free drive of the kinds given that can take it: a floppy drive only
  // takes a floppy-sized image. One in another game's folder, one that isn't there, or one with no
  // drive left for it is left out, and takes no drive.
  const place = (file, ...pools) => {
    const found = file && !file.includes('/') && !file.includes('\\') ? find(file) : null;
    const size = typeof found === 'object' && found ? found.size : undefined;
    const fits = (pool) => pool.length && (pool[0].startsWith('hard') || !(size > FLOPPY_MAX_BYTES));
    const as = found ? pools.find(fits)?.shift() : null;
    if (!as) return dropped.push(file);
    media.push({ file, as, type: mameType(file, size, as) });
  };

  if (mameDisks) {
    // As eXo starts them: apple2gs, the CFFA2 card with DISK1 and DISK2, and DISK3 in a 3.5" drive.
    const [first, second, third] = mameDisks;
    if (first) place(first, ['hard1']);
    if (second) place(second, ['hard2']);
    if (third) place(third, ['flop3']);
    return { machine: 'apple2gs', card: media.some((m) => m.as.startsWith('hard')), media, dropped };
  }

  const drives = gsplus?.drives ?? [];
  const free35 = [...THREE_AND_A_HALF];
  const free525 = [...FIVE_AND_A_QUARTER];
  const freeHard = [...HARD];
  for (const d of drives.filter((x) => x.slot === 5)) place(d.file, free35);
  for (const d of drives.filter((x) => x.slot === 6)) place(d.file, free525);
  for (const d of drives.filter((x) => x.slot === 7)) place(d.file, freeHard, free35);
  return {
    machine: gsplus?.rom === 'ROM3' ? 'apple2gs' : 'apple2gsr1',
    card: media.some((m) => m.as.startsWith('hard')),
    media,
    dropped,
  };
}

// Disk images by their names' endings: floppies and ProDOS images.
const DISK_IMAGE = /\.(?:2mg|2img|po|do|dsk|img|dc|dc42|woz|nib|hdv)$/i;
// A 5.25" disk: 35 tracks of 16 sectors.
const FIVE_AND_A_QUARTER_BYTES = 143360;

/**
 * The game's other floppies, which no drive starts with: the disks a game asks for later
 * ("insert Disk 2"), which eXo swaps in with GSplus's disk menu. They go into MAME's files beside
 * the others, under their own names, for MAME's File Manager (Tab, then File Manager) to put in a
 * drive: [{ file, type, name }], `name` the one MAME is to see ("Disk2.2mg"), of the type a drive
 * of the disk's size takes. `entries`: the files in the game's zip, { name, size }.
 */
export function iigsSpareDisks(plan, entries) {
  const used = new Set(plan.media.map((m) => m.file.toLowerCase()));
  const taken = new Set();
  const spares = [];
  for (const entry of entries) {
    const file = path.basename(entry.name);
    if (!DISK_IMAGE.test(file) || used.has(file.toLowerCase()) || entry.size > FLOPPY_MAX_BYTES) continue;
    const type = entry.size === FIVE_AND_A_QUARTER_BYTES ? path.extname(file).toLowerCase() : mameType(file, entry.size, 'flop3');
    // Not a bare number: the disks the game starts with are "1.2mg", "2.hdv" (see webplay.js).
    const stem = path.basename(file, path.extname(file)).replace(/^(\d+)$/, 'Disk $1');
    let name = `${stem}${type}`;
    // Two files that would come out with the same name ("Disk1.po" and "Disk1.img") get numbered.
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n})${type}`;
    taken.add(name.toLowerCase());
    spares.push({ file, type, name });
  }
  return spares;
}

/** MAME's arguments for a plan, with each disk at `mediaPath(file, type)` in MAME's files. */
export function iigsArgs(plan, mediaPath) {
  const args = ['-ramsize', '8M'];
  if (plan.card) args.push('-sl7', 'cffa2');
  for (const m of plan.media) args.push(`-${m.as}`, mediaPath(m.file, m.type));
  return args;
}

/** The ROM sets a plan's machine needs, by file name: ROM1 is a clone of ROM3, so it needs both. */
export function iigsRomSets(plan) {
  return [
    'apple2gs.zip',
    ...(plan.machine === 'apple2gsr1' ? ['apple2gsr1.zip'] : []),
    ...(plan.card ? ['a2cffa2.zip'] : []),
  ];
}
