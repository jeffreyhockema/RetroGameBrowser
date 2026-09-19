// Arcade games, through MAME 0.244 compiled to WebAssembly: the same MAME LaunchBox runs them
// with, so its ROM and CHD set loads as it is. (The build scripts: github.com/jeffreyhockema/
// mame-wasm-build; `npm run fetch-mame` puts the builds into vendor/mame/.)
//
// A whole MAME is too big for a browser, so it's built in bundles of drivers
// (server/data/mame-bundles.json), and a game loads the one its driver is in. What a game loads
// besides its own zip — the BIOS sets it's built on, devices with ROMs of their own, disk images,
// samples — comes from MAME's own list of sets (server/data/mame0244.json, made by
// scripts/build-mame-data.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { dataJson } from './util.js';

export const MAME_VERSION = '0.244';
export const ENGINE_NAME = `MAME ${MAME_VERSION}`;

let sets = null;
let bundles = null;

/** Every set the browser bundles can run, by name (see scripts/build-mame-data.mjs). Read once. */
export function mameSets() {
  sets ??= dataJson('mame0244.json');
  return sets;
}

let knownIssues = null;

/**
 * Why a set is known not to play in the browser build, or null: by the set, or by its driver
 * file for everything that driver runs (server/data/mame-known-issues.json, from booting one
 * game per driver in the browser).
 */
export function mameKnownIssue(setName) {
  knownIssues ??= dataJson('mame-known-issues.json');
  const set = mameSets()[setName];
  return knownIssues.sets?.[setName] ?? (set && knownIssues.sources?.[set.source]) ?? null;
}

let netplayData = null;

// What a game is played with, where the friends' side carries a press and nothing else: a wheel,
// a paddle, a trackball or a gun is read from the player's own pointer, which the other copies of
// the game never see, so those games are streamed from the host's screen instead.
const ANALOG_CONTROLS = ['dial', 'paddle', 'pedal', 'positional', 'stick', 'trackball', 'mouse', 'lightgun'];

/**
 * How a set is played with friends: 'rollback' where every player's copy of MAME is known to stay
 * in step with the others (server/data/mame-netplay.json, from running each driver's games through
 * saves, loads and replays in the browser, and only drivers MAME can save the state of), else
 * 'stream', the host's game sent as video.
 */
export function mameNetplayMode(setName) {
  const set = mameSets()[setName];
  if (!set) return null;
  netplayData ??= dataJson('mame-netplay.json');
  const rollback = netplayData.rollback ?? {};
  const listed = (rollback.sets ?? []).includes(setName) || (rollback.sources ?? []).includes(set.source);
  const excluded = (rollback.notSets ?? []).includes(setName);
  const analog = (set.controls ?? []).some((c) => ANALOG_CONTROLS.includes(c));
  if (listed && !excluded && set.savestate !== 'unsupported' && !analog) return 'rollback';
  return 'stream';
}

/** What a set is played with: { players, buttons, lightgun }, or null for a set MAME doesn't know. */
export function mameControls(setName) {
  const set = mameSets()[setName];
  return set ? { players: set.players ?? 1, buttons: set.buttons ?? 0, lightgun: (set.controls ?? []).includes('lightgun') } : null;
}

/** Bundle name -> the driver source files built into it. */
export function mameBundles() {
  bundles ??= dataJson('mame-bundles.json');
  return bundles;
}

/** Whether a LaunchBox emulator is MAME, by the program it starts. */
export const isMameEmulator = (applicationRel) => /(^|[\\/])mame(64)?\.exe$/i.test(applicationRel ?? '');

/** A set's name from its ROM path: "Games\MAME 0.244\sf2ce.zip" -> "sf2ce". */
export const setNameOf = (rel) => path.basename(rel ?? '').replace(/\.(zip|7z)$/i, '').toLowerCase();

// The words MAME's descriptions name regions with: "(World 940223)", "(US, Rev 1)", "(Euro)".
const REGIONS = [
  [/^(us|usa|america|americas|north america|canada)$/i, 'USA'],
  [/^world$/i, 'World'],
  [/^(euro|europe|uk|germany|france|spain|italy|oceania|australia)$/i, 'Europe'],
  [/^japan$/i, 'Japan'],
  [/^(asia|korea|taiwan|hong kong|china|hispanic|brazil|latin america|mexico|argentina)$/i, 'Other regions'],
];
const REGION_WORD = /\b(US|USA|Americas?|North America|Canada|World|Euro|Europe|UK|Germany|France|Spain|Italy|Oceania|Australia|Japan|Asia|Korea|Taiwan|Hong Kong|China|Hispanic|Brazil|Latin America|Mexico|Argentina)\b/g;
const PRERELEASE = /\b(prototype|proto|beta|location test|demo|preview|sample)\b/i;

/** The "(…)" groups of a MAME description: "Street Fighter II' (World 920513)" -> ["World 920513"]. */
export const descriptionTags = (title) => [...(title ?? '').matchAll(/\(([^()]*)\)/g)].map((m) => m[1].trim());

/** Region names a description mentions, in order: "(US 940223, Rev B)" -> ["US"]. */
export function arcadeRegions(title) {
  return descriptionTags(title).flatMap((tag) => tag.match(REGION_WORD) ?? []);
}

/**
 * The kind of an arcade version, for the version ranking, in the terms console releases use:
 * a prototype or location test, else its best region. Bootlegs and hacks rank by their region
 * like a console game's pirate copies.
 */
export function arcadeKind(title, platform) {
  const kind = (key) => ({ key, platform, media: '' });
  if (descriptionTags(title).some((t) => PRERELEASE.test(t))) return kind('Beta, demo or prototype');
  const regions = arcadeRegions(title);
  for (const [re, key] of REGIONS) if (regions.some((r) => re.test(r))) return kind(key);
  return kind('Other');
}

const loose = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * How a version is named in the version list: what MAME's description adds to the game's title
 * ("World 920513"), or the whole description when it's a different game's name (a clone sold
 * under another title, "Champion Edition"), or the title when the description says nothing more.
 */
export function arcadeLabel(description, gameTitle) {
  if (!description) return gameTitle;
  const own = description.split(/\s*\(/)[0].trim();
  const tags = descriptionTags(description);
  if (loose(own) !== loose(gameTitle) && !loose(gameTitle).startsWith(loose(own))) return description;
  return tags.length ? tags.join(', ') : gameTitle;
}

/**
 * The files a set loads, where they are and how big: its own zip, then the other zips it needs,
 * its disk images and its samples. `romDir` is the folder of the set's own zip, where LaunchBox
 * keeps all of them; a disk image a clone shares is in its parent's folder. Each file is
 * { name, abs, size } with `name` its path in MAME's folders ("roms/neogeo.zip",
 * "roms/kinst2/kinst2.chd", "samples/005.zip"); a missing one has abs null.
 */
export function mameFiles(setName, { romDir, samplesDir = null, statFile = defaultStat }) {
  const set = mameSets()[setName];
  if (!set) return null;
  const file = (name, abs) => {
    const size = abs ? statFile(abs) : null;
    return { name, abs: size === null ? null : abs, size: size ?? 0 };
  };
  const files = [file(`roms/${setName}.zip`, path.join(romDir, `${setName}.zip`))];
  for (const zip of set.zips ?? []) files.push(file(`roms/${zip}.zip`, path.join(romDir, `${zip}.zip`)));
  for (const disk of set.disks ?? []) {
    // MAME looks in the set's own folder and then up the chain of sets it's a clone of.
    const owners = [setName];
    for (let s = set; s?.romof && !owners.includes(s.romof); s = mameSets()[s.romof]) owners.push(s.romof);
    const found = owners.map((owner) => file(`roms/${owner}/${disk}.chd`, path.join(romDir, owner, `${disk}.chd`))).find((f) => f.abs);
    files.push(found ?? { name: `roms/${setName}/${disk}.chd`, abs: null, size: 0, disk: true });
  }
  if (set.samples && samplesDir) {
    const samples = file(`samples/${set.samples}.zip`, path.join(samplesDir, `${set.samples}.zip`));
    // A game plays without its samples (they're missing sounds, not missing code).
    if (samples.abs) files.push({ ...samples, optional: true });
  }
  return files;
}

function defaultStat(abs) {
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  return stat?.isFile() ? stat.size : null;
}

/**
 * Why a set can't be played in the browser, or null. `files` is mameFiles' answer; games bigger
 * than `maxBytes` stay out, because the browser holds every file in memory.
 */
export function mameIssue(setName, files, { maxBytes = Infinity } = {}) {
  const set = mameSets()[setName];
  if (!set) return 'This game\'s hardware isn\'t in the browser version of MAME.';
  const missing = files.filter((f) => !f.abs && !f.optional);
  if (missing.length) return `Missing ${missing.map((f) => path.basename(f.name)).join(', ')}.`;
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > maxBytes) return `Too big to load in the browser (${Math.round(total / 1024 ** 2)} MB).`;
  if (set.status === 'preliminary') return 'MAME doesn\'t run this game properly yet.';
  return mameKnownIssue(setName);
}
