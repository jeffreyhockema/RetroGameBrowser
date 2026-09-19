// Classifies game versions into "kinds" (media + platform, e.g. "CD DOS", "Floppy Amiga",
// "FM Towns") so people can rank which kind of release they prefer to play.

// Platform names as they appear in eXo folder names, most specific first.
const PLATFORM_PATTERNS = [
  [/fm[- ]?towns/, 'FM Towns'],
  [/pc-?98/, 'PC-98'],
  [/apple iigs/, 'Apple IIGS'],
  [/apple ii\b/, 'Apple II'],
  [/atari st/, 'Atari ST'],
  [/amiga/, 'Amiga'],
  [/windows/, 'Windows'],
  [/\bmac(intosh)?\b/, 'Macintosh'],
  [/\b(ms-)?dos\b/, 'DOS'],
  [/\b3do\b/, '3DO'],
  [/sega[- ]?cd/, 'Sega CD'],
  [/playstation 2|\bps2\b/, 'PlayStation 2'],
  [/playstation|\bps1\b|\bpsx\b/, 'PlayStation'],
  [/\btg16\b|turbografx/, 'TurboGrafx-16'],
  [/\bnes\b/, 'NES'],
  [/xbox/, 'Xbox'],
  [/\bc64\b|commodore 64/, 'Commodore 64'],
  [/acorn/, 'Acorn'],
  [/linux/, 'Linux'],
  [/\bios\b/, 'iOS'],
];

// ScummVM --platform values, with the short aliases ScummVM also accepts ("mac", "win", …).
// This is the only map from ScummVM platform codes to names; version labels use it too.
const FLAG_PLATFORMS = {
  pc: 'DOS', dos: 'DOS', ibm: 'DOS', windows: 'Windows', win: 'Windows',
  macintosh: 'Macintosh', mac: 'Macintosh', amiga: 'Amiga', ami: 'Amiga',
  atari: 'Atari ST', 'atari-st': 'Atari ST', st: 'Atari ST', fmtowns: 'FM Towns', towns: 'FM Towns', fm: 'FM Towns',
  pc98: 'PC-98', apple2gs: 'Apple IIGS', '2gs': 'Apple IIGS', apple2: 'Apple II', '3do': '3DO',
  segacd: 'Sega CD', sega: 'Sega CD', psx: 'PlayStation', playstation: 'PlayStation',
  ps2: 'PlayStation 2', playstation2: 'PlayStation 2', xbox: 'Xbox', ios: 'iOS', linux: 'Linux',
  c64: 'Commodore 64', nes: 'NES', acorn: 'Acorn', pce: 'TurboGrafx-16',
};

/** The name of a ScummVM --platform value (any case), e.g. "mac" -> "Macintosh", or null if unknown. */
export function flagPlatformName(flag) {
  const code = (flag ?? '').toLowerCase();
  return Object.hasOwn(FLAG_PLATFORMS, code) ? FLAG_PLATFORMS[code] : null;
}

// Consoles come on one kind of media, so their kind is just the platform.
const CONSOLES = new Set(['3DO', 'Sega CD', 'PlayStation', 'PlayStation 2', 'TurboGrafx-16', 'NES', 'Xbox']);

/**
 * Suggested order for someone playing at home: the biggest PC releases first (CD and DVD
 * Windows/DOS with speech), then floppy PC, then other computers and consoles, then remakes.
 * Console games come in regional releases instead (see romKind in emulatorjs.js), ranked for
 * an English-speaking player: USA, then World, Europe and Japan, pre-releases last. Settings
 * lists only the kinds some loaded game has.
 */
export const DEFAULT_VERSION_ORDER = [
  'DVD Windows', 'DVD DOS', 'CD Windows', 'CD DOS', 'Windows', 'DOS', 'Floppy Windows', 'Floppy DOS',
  'CD FM Towns', 'FM Towns', 'DVD Macintosh', 'CD Macintosh', 'Macintosh', 'Floppy Macintosh',
  'CD Amiga', 'Amiga', 'Floppy Amiga', 'CD PC-98', 'PC-98', 'Floppy PC-98',
  'Atari ST', 'Floppy Atari ST', 'Apple IIGS', 'Floppy Apple IIGS', 'Apple II',
  '3DO', 'Sega CD', 'PlayStation', 'PlayStation 2', 'TurboGrafx-16', 'NES', 'Xbox',
  'CD Linux', 'Linux', 'iOS', 'Commodore 64', 'Floppy Commodore 64', 'Floppy Acorn', 'Acorn',
  'USA', 'World', 'Europe', 'Fan translation', 'Japan', 'Other regions', 'Beta, demo or prototype',
  'Remake', 'Fan-made', 'Other',
];

/** The last "(…)" group of a name, e.g. "CD DOS" from "Day of the Tentacle (CD DOS)". */
export function lastTag(name = '') {
  const groups = [...name.matchAll(/\(([^()]*)\)/g)];
  return groups.length ? groups.at(-1)[1] : '';
}

/**
 * @param {{ label: string, platform?: string|null, gameId?: string|null }} version
 * @param {string} gameDir the game's eXo folder name, whose tag applies when the version has none
 * @returns {{ key: string, platform: string, media: string }}
 */
export function classifyVersion(version, gameDir = '') {
  const flagPlatform = flagPlatformName(version.platform);
  // The version's own folder tag first; if it names no platform ("talkie"), the game's folder.
  const tags = [lastTag(version.label), lastTag(gameDir)].map((t) => t.toLowerCase()).filter(Boolean);

  for (const tag of tags) {
    if (/remake/.test(tag)) return kind('', 'Remake');
    if (/^(ags|scummc|scummgen|wintermute)$/.test(tag)) return kind('', 'Fan-made');
  }
  // Platform and media come from the same tag, so "(Amiga)" inside a "(CD DOS)" folder stays "Amiga".
  let platform = null;
  let media = mediaOf(tags[0] ?? '');
  for (const tag of tags) {
    const found = PLATFORM_PATTERNS.filter(([re]) => re.test(tag)).map(([, name]) => name);
    // "CD DOS, Windows" covers two platforms; ScummVM's --platform says which one this is.
    if (found.length) {
      platform = found.length > 1 && found.includes(flagPlatform) ? flagPlatform : found[0];
      media = mediaOf(tag);
      break;
    }
  }
  platform ??= flagPlatform ?? 'Other';
  return kind(CONSOLES.has(platform) ? '' : media, platform);
}

function mediaOf(tag) {
  return /\bdvd\b/.test(tag) ? 'DVD' : /\b\d?cd\b/.test(tag) ? 'CD' : /floppy/.test(tag) ? 'Floppy' : '';
}

/** A kind from its parts, e.g. makeKind('CD', 'DOS') -> { key: 'CD DOS', … }. */
export function makeKind(media, platform) {
  return { key: [media, platform].filter(Boolean).join(' '), platform, media };
}
const kind = makeKind;

/**
 * Full ranking: the saved order, then any kinds it doesn't mention in default order,
 * then anything else alphabetically.
 */
export function completeOrder(saved = [], present = []) {
  const order = [...new Set(saved)];
  for (const k of [...DEFAULT_VERSION_ORDER, ...[...present].sort()]) if (!order.includes(k)) order.push(k);
  return order;
}
