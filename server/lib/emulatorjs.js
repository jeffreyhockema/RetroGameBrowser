// Console platforms played in the browser through EmulatorJS: RetroArch's emulator cores
// compiled to WebAssembly (fetched by `npm run fetch-emulators` into vendor/emulatorjs/).
//
// LaunchBox keeps console games as one ROM file each (usually a .zip or .7z) in
// "Games\<Platform>\", plus AdditionalApplications that point at other regional releases
// ("Play (Japan) Version..."). Each ROM becomes a version; the region in its No-Intro file
// name ("(USA) (Rev 1)") gives the version's name and kind.

import path from 'node:path';

/**
 * LaunchBox platform -> EmulatorJS system and core. Only cores that ran a game from this
 * collection in testing are listed. `name` is shown to people ("runs in Snes9x").
 * `bios` is the file the core looks for, by game region where that matters.
 * `buttons` renames buttons in Control Settings and on a phone's gamepad, by RetroArch button
 * number (0 B, 1 Y, 8 A, 9 X).
 * `netplay` says how games are played with friends: 'rollback' (public/player/netplay-fixes.js)
 * where the core is deterministic and its states are small and quick enough to save every frame
 * and re-run a few on a misprediction, so everyone runs the game; 'stream'
 * (public/player/netplay-stream.js) for the rest, where only the host runs it and a friend gets
 * it as video and sends presses back, with the delay that brings. The PlayStation's, the
 * Nintendo 64's and the Jaguar's cores use recompilers and threads, so two copies can't be
 * relied on to run alike; the Sega CD's is deterministic but its states (the CD cache, the PCM
 * chip) are too big to save every frame, and so are the Saturn's.
 * `disc` marks CD platforms, whose big zips the server unpacks too (see worthUnpacking): a
 * cartridge zip, or an arcade set the core wants zipped, is left as it is.
 */
export const CORES = {
  'Nintendo Entertainment System': { system: 'nes', core: 'fceumm', name: 'FCEUmm', netplay: 'rollback' },
  'Super Nintendo Entertainment System': { system: 'snes', core: 'snes9x', name: 'Snes9x', netplay: 'rollback' },
  'Sega Genesis': { system: 'segaMD', core: 'genesis_plus_gx', name: 'Genesis Plus GX', netplay: 'rollback' },
  'Sega 32X': { system: 'sega32x', core: 'picodrive', name: 'PicoDrive', netplay: 'rollback' },
  'Sega CD': {
    system: 'segaCD', core: 'genesis_plus_gx', name: 'Genesis Plus GX', netplay: 'stream', disc: true,
    bios: { USA: 'bios_CD_U.bin', Europe: 'bios_CD_E.bin', Japan: 'bios_CD_J.bin', default: 'bios_CD_U.bin' },
  },
  // Yabause, the core LaunchBox runs these with too. Without a Saturn BIOS in RetroArch's system
  // folder it starts games with its own stand-in for one, which most of them accept.
  'Sega Saturn': {
    system: 'segaSaturn', core: 'yabause', name: 'Yabause', netplay: 'stream', disc: true,
    bios: { default: 'saturn_bios.bin' }, options: { yabause_frameskip: 'enabled' },
  },
  // EmulatorJS has no PlayStation controls of its own and names the buttons after a SNES pad.
  'Sony Playstation': {
    netplay: 'stream', disc: true,
    system: 'psx', core: 'pcsx_rearmed', name: 'PCSX-ReARMed', bios: { default: 'scph5501.bin' },
    buttons: { 0: '✕ Cross', 1: '□ Square', 8: '○ Circle', 9: '△ Triangle', 10: 'L1', 11: 'R1' },
  },
  'Nintendo 64': { system: 'n64', core: 'mupen64plus_next', name: 'Mupen64Plus-Next', netplay: 'stream' },
  'Atari 2600': { system: 'atari2600', core: 'stella2014', name: 'Stella', netplay: 'rollback' },
  'Atari 5200': { system: 'atari5200', core: 'a5200', name: 'a5200', netplay: 'rollback' },
  'Atari 7800': { system: 'atari7800', core: 'prosystem', name: 'ProSystem', netplay: 'rollback' },
  'Atari Jaguar': { system: 'jaguar', core: 'virtualjaguar', name: 'Virtual Jaguar', netplay: 'stream' },
  'NEC TurboGrafx-16': { system: 'pce', core: 'mednafen_pce', name: 'Mednafen PCE', netplay: 'rollback' },
  // Neo Geo games are arcade ROM sets; FinalBurn Neo needs the Neo Geo BIOS set as a zip,
  // unextracted, next to the game. It boots as the home console (the AES, English BIOS
  // neo-epo.bin from that set) rather than the arcade machine, so Start plays without a coin.
  'SNK Neo Geo AES': {
    system: 'arcade', core: 'fbneo', name: 'FinalBurn Neo', bios: { default: 'neogeo.zip' }, keepBiosZipped: true,
    options: { 'fbneo-neogeo-mode': 'AES_EUR' }, netplay: 'rollback',
  },
  // A computer, not a console: it has a keyboard of its own as well as a joystick port. Keys
  // work the joystick to start with, which is what most games here want, and the player's bar
  // switches them to typing on the C64 keyboard for the games that ask you to press a key
  // (text adventures, "press F1", RUN/STOP). See public/emu/play.html.
  'Commodore 64': { system: 'c64', core: 'vice_x64sc', name: 'VICE', keyboard: true, netplay: 'rollback' },
};

/**
 * BIOS files the cores look for, with the names they're kept under in RetroArch's system
 * folder (or a platform's ROM folder). The first one found is served under the core's name.
 */
export const BIOS_FILES = {
  'bios_CD_U.bin': ['bios_CD_U.bin', 'us_scd1_9210.bin', 'us_scd2_9303.bin'],
  'bios_CD_E.bin': ['bios_CD_E.bin', 'eu_mcd1_9210.bin', 'eu_mcd2_9306.bin'],
  'bios_CD_J.bin': ['bios_CD_J.bin', 'jp_mcd1_9112.bin', 'jp_mcd2_921222.bin'],
  'scph5501.bin': ['scph5501.bin', 'scph1001.bin', 'scph7001.bin', 'scph5500.bin', 'scph5502.bin'],
  'neogeo.zip': ['neogeo.zip'],
  'saturn_bios.bin': ['saturn_bios.bin', 'sega_101.bin', 'mpr-17933.bin'],
};

/** Extensions of files an emulator can start (archives are unpacked in the browser). */
const ROM_EXTENSIONS = new Set([
  'zip', '7z', 'rar', 'nes', 'fds', 'unf', 'sfc', 'smc', 'md', 'gen', 'smd', 'bin', '32x', 'cue', 'iso', 'chd', 'img', 'pbp',
  'n64', 'z64', 'v64', 'a26', 'a52', 'a78', 'j64', 'jag', 'pce', 'd64', 't64', 'prg', 'crt', 'tap', 'g64', 'm3u',
]);

export const isRomFile = (file) => ROM_EXTENSIONS.has(path.extname(file).slice(1).toLowerCase());

// No-Intro region names grouped into the kinds people rank; more specific countries count
// as "Other regions".
const REGION_KINDS = [
  [/^(usa|us|america|north america|canada)$/i, 'USA'],
  [/^world$/i, 'World'],
  [/^(europe|eu|uk|united kingdom|australia|germany|france|spain|italy|netherlands|sweden|scandinavia)$/i, 'Europe'],
  [/^(japan|jp)$/i, 'Japan'],
];
const REGION_WORDS = /^(usa|us|america|north america|canada|world|europe|eu|uk|united kingdom|australia|germany|france|spain|italy|netherlands|sweden|scandinavia|japan|jp|asia|korea|china|taiwan|hong kong|brazil|russia|argentina|mexico|portugal|greece|poland|india|unknown)$/i;
// Unfinished releases. Pirate copies and hacks are finished games and rank by their region.
const PRERELEASE = /\b(beta|proto|prototype|demo|sample|kiosk|preview|debug)\b/i;
// A fan translation: "(T)", "[T+Eng]", "(T-En v1.1)". Upper-case T only: "[t1]" is a trainer.
const TRANSLATION = /^T(?:[+-]\s*([A-Za-z]{2,4})\b.*)?$/;
// GoodTools dump codes in lower case ("[!]", "[a1]", "[b2]", "[h1C]", "[t1]", "[o1]", "[p1]", "[f1]").
const DUMP_CODE = /^(!|[abhtopf]\d*\w?)$/;
// GoodTools region codes, found in older sets ("Contra (U).nes").
const GOOD_REGIONS = {
  U: 'USA', E: 'Europe', J: 'Japan', W: 'World', UE: 'USA, Europe', JU: 'Japan, USA', JUE: 'Japan, USA, Europe',
  UK: 'UK', F: 'France', G: 'Germany', S: 'Spain', I: 'Italy', A: 'Australia', K: 'Korea', C: 'China', B: 'Brazil',
};
const LANGUAGES = {
  En: 'English', Ja: 'Japanese', Fr: 'French', De: 'German', Es: 'Spanish', It: 'Italian', Pt: 'Portuguese',
  Nl: 'Dutch', Sv: 'Swedish', No: 'Norwegian', Da: 'Danish', Fi: 'Finnish', Zh: 'Chinese', Ko: 'Korean',
  Ru: 'Russian', Pl: 'Polish', Ca: 'Catalan', El: 'Greek',
};

/** The parenthesised and bracketed tags of a ROM file name: "Sonic (USA) (Rev 1).zip" -> ["USA", "Rev 1"]. */
export function romTags(fileName) {
  const base = path.basename(fileName).replace(/\.[^.]+$/, '');
  return [...base.matchAll(/[([]([^()[\]]+)[)\]]/g)].map((m) => m[1].trim()).filter(Boolean);
}

/** Region names in a ROM's tags, in order: "(Japan, USA)" -> ["Japan", "USA"], "(U)" -> ["USA"]. */
export function romRegions(tags) {
  for (const tag of tags) {
    const parts = (GOOD_REGIONS[tag] ?? tag).split(/\s*,\s*/);
    if (parts.every((p) => REGION_WORDS.test(p))) return parts;
  }
  return [];
}

/** Whether a ROM is a fan translation, and into which language when it says. */
export function romTranslation(tags) {
  for (const tag of tags) {
    const m = TRANSLATION.exec(tag);
    if (m) return { language: m[1] ? m[1].toLowerCase().startsWith('en') ? 'English' : m[1] : null };
  }
  return null;
}

/**
 * The kind of a console release, for the version ranking: "Beta, demo or prototype" for
 * pre-releases, "Fan translation", else its best region ("USA" beats "World" beats "Europe"
 * beats "Japan").
 */
export function romKind(tags, platform) {
  const kind = (key) => ({ key, platform, media: '' });
  if (tags.some((t) => PRERELEASE.test(t))) return kind('Beta, demo or prototype');
  // A translated file may keep its original "(Japan)" tag, so this comes before the regions.
  if (romTranslation(tags)) return kind('Fan translation');
  const regions = romRegions(tags);
  for (const [re, key] of REGION_KINDS) if (regions.some((r) => re.test(r))) return kind(key);
  return kind(regions.length ? 'Other regions' : 'Other');
}

/** A tag as people read it: "U" -> "USA", "En,Fr,De" -> "3 languages", "Unl" -> "Unlicensed". */
function readableTag(tag) {
  if (GOOD_REGIONS[tag]) return GOOD_REGIONS[tag];
  const translation = romTranslation([tag]);
  if (translation) return translation.language ? `${translation.language} translation` : 'Fan translation';
  if (tag === 'Unl') return 'Unlicensed';
  const languages = tag.split(/\s*[,+]\s*/);
  if (languages.every((l) => LANGUAGES[l])) {
    return languages.length > 2 ? `${languages.length} languages` : languages.map((l) => LANGUAGES[l]).join(' and ');
  }
  return tag;
}

// Titles compared loosely: "Legend of Zelda, The - A Link" and "The Legend of Zelda: A Link" match.
const looseTitle = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/,\s*the\b/g, ' ').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');

/**
 * A version's name from its ROM file: its tags made readable ("USA, Rev 1"). A file for
 * another title than the game's (an alternate like "Probotector II" for Contra, or a Neo Geo
 * set "ips") leads with that title. With nothing to tell it apart, the game's title.
 * @param {{ alternate?: boolean }} options `alternate`: the file is one of the game's other releases
 */
export function romLabel(fileName, title, { alternate = false } = {}) {
  const tags = romTags(fileName).filter((t) => !DUMP_CODE.test(t)).map(readableTag);
  const fileTitle = path.basename(fileName).replace(/\.[^.]+$/, '').split(/\s*[([]/)[0].trim();
  const ownTitle = alternate && fileTitle && looseTitle(fileTitle) !== looseTitle(title) ? fileTitle : null;
  if (ownTitle) return tags.length ? `${ownTitle} (${tags.join(', ')})` : ownTitle;
  return tags.length ? tags.join(', ') : title;
}

/**
 * The name shared by the discs of a multi-disc release, from one disc's file name:
 * "Final Fantasy VII (USA) (Disc 2).7z" -> "Final Fantasy VII (USA)". Null for other files.
 */
export function discSetName(fileName) {
  const base = path.basename(fileName).replace(/\.[^.]+$/, '');
  if (!/\(Disc\s*\d+\)/i.test(base)) return null;
  return base.replace(/\s*\(Disc\s*\d+\)/i, '').trim();
}

// Each core's frame rate, from its libretro timing, for NTSC and PAL releases. Rollback
// netplay keeps time itself (RetroArch's audio pacing is off then, see
// public/player/netplay-fixes.js) and needs the console's own rate: a PAL game at 60 would
// run a fifth too fast, and even 60 for an NTSC NES (60.0988) would drift the sound.
const FRAME_RATES = {
  fceumm: { ntsc: 60.0988, pal: 50.007 },
  snes9x: { ntsc: 60.0988, pal: 50.007 },
  genesis_plus_gx: { ntsc: 59.9228, pal: 49.7015 },
  picodrive: { ntsc: 59.9228, pal: 49.7015 },
  mednafen_pce: { ntsc: 59.8261, pal: 59.8261 },
  stella2014: { ntsc: 59.9227, pal: 49.8607 },
  a5200: { ntsc: 59.9227, pal: 49.8607 },
  prosystem: { ntsc: 59.9227, pal: 49.8607 },
  fbneo: { ntsc: 59.1856, pal: 59.1856 },
  // VICE runs a PAL C64 unless told otherwise, whatever the game's origin.
  vice_x64sc: { ntsc: 50.1245, pal: 50.1245 },
};
// Brazil isn't one: its PAL-M television runs at 60 Hz, and the cores run Brazilian releases as NTSC.
const PAL_REGIONS = /^(europe|eu|uk|united kingdom|australia|germany|france|spain|italy|netherlands|sweden|scandinavia|russia|poland|portugal|greece)$/i;
// A release shared with the USA or Japan ("USA, Europe") is one ROM whose header names those
// regions too, and the cores pick them before Europe (Genesis Plus GX goes USA, Japan, Europe;
// PicoDrive USA, Europe, Japan), so it runs at NTSC.
const NTSC_REGIONS = /^(usa|us|america|north america|canada|japan|jp)$/i;

/** The frame rate a core runs a release at: PAL for a release made only for 50 Hz regions, else NTSC. */
export function frameRateFor(platform, regions = []) {
  const rates = FRAME_RATES[CORES[platform]?.core];
  if (!rates) return 60;
  const pal = regions.some((r) => PAL_REGIONS.test(r)) && !regions.some((r) => NTSC_REGIONS.test(r));
  return pal ? rates.pal : rates.ntsc;
}

/** The BIOS name the core expects for a game, or null when the platform needs none. */
export function biosNameFor(platform, regions = []) {
  const bios = CORES[platform]?.bios;
  if (!bios) return null;
  for (const [re, key] of REGION_KINDS) {
    if (bios[key] && regions.some((r) => re.test(r))) return bios[key];
  }
  return bios.default ?? null;
}
