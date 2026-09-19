// Turns eXo ScummVM launchers (.bat menus) into playable versions for the browser build.
//
// An eXo launcher is a menu of `scummvm.exe … -p"<data folder>" <target>` lines, one per
// version (floppy / CD / Mac …) and music device (AdLib / MT-32 / Sound Canvas …).
// We don't interpret the menu; every scummvm.exe line is one choice, grouped by version.

import fs from 'node:fs/promises';
import path from 'node:path';
import { flagPlatformName } from './versionkind.js';

/**
 * Reads the ScummVM game ID from an eXo launcher, i.e. the last argument on the line
 * that runs scummvm.exe (`… -p".\eXoScummVM\Foo (DOS)" ootopos`).
 */
export function parseScummvmId(batText) {
  for (const line of batText.split(/\r?\n/)) {
    if (!/scummvm\.exe/i.test(line)) continue;
    const m = /\s([a-z0-9][\w-]*)\s*$/i.exec(line.trim());
    if (m) return m[1];
  }
  return null;
}

export async function readScummvmId(absBat) {
  try {
    return parseScummvmId(await fs.readFile(absBat, 'latin1'));
  } catch {
    return null;
  }
}

export const SOUND_LABELS = {
  default: 'Standard',
  adlib: 'AdLib',
  mt32: 'Roland MT-32',
  fluidsynth: 'Roland Sound Canvas',
  pcjr: 'IBM PCjr',
  cms: 'Creative Music System',
  pcspk: 'PC speaker',
};

// Options carried over to the browser build as-is (value-less ones map to true).
const PASSTHROUGH = new Set([
  'platform', 'language', 'music-volume', 'speech-volume', 'sfx-volume', 'midi-gain',
  'talkspeed', 'subtitles', 'alt-intro', 'aspect-ratio', 'multi-midi', 'native-mt32',
]);

/** Splits a command line into arguments, honouring double quotes (cmd style). */
export function splitCommandLine(line) {
  const args = [];
  let current = '';
  let inQuotes = false;
  let started = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; started = true; continue; }
    if (!inQuotes && /\s/.test(ch)) {
      if (started) args.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) args.push(current);
  return args;
}

/** Parses the [section] key=value pairs of an ini file. */
/**
 * An object's own property, or undefined. Names here come from launchers ("toString" would
 * otherwise find a function every object has).
 */
export const own = (object, key) => (key != null && Object.hasOwn(object, key) ? object[key] : undefined);

export function parseIni(text) {
  const sections = {};
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) { section = sections[header[1]] = {}; continue; }
    const kv = /^([^=;#]+)=(.*)$/.exec(line);
    if (section && kv) section[kv[1].trim()] = kv[2].trim();
  }
  return sections;
}

/**
 * Reads every scummvm.exe command in a launcher.
 * @param {string} batText
 * @param {string} gameDir name of the launcher's folder (eXo's %GameDir%)
 * @returns {Array<{dataRel: string, target: string|null, autoDetect: boolean, config: string|null, sound: string, options: object}>}
 *   `dataRel` is relative to the eXo root folder (the launcher's working directory).
 */
export function parseExoLauncher(batText, gameDir) {
  const lines = batText.split(/\r?\n/).map((l) => l.trim()).filter((l) => !/^(rem\b|::)/i.test(l));

  // Some launchers pick the game through a variable set by the menu
  // (`set TYPE=ultima6` / `set TYPE=ultima6_enh`, then `scummvm.exe … %TYPE%`).
  const vars = new Map();
  for (const line of lines) {
    const m = /^@?set\s+"?([A-Za-z_]\w*)=([^"]*)"?$/i.exec(line);
    if (!m || /^(gamedir|var)$/i.test(m[1])) continue;
    const values = vars.get(m[1].toLowerCase()) ?? [];
    if (!values.includes(m[2])) values.push(m[2]);
    vars.set(m[1].toLowerCase(), values);
  }

  const commands = [];
  for (const line of lines) {
    if (!/scummvm\.exe/i.test(line)) continue;
    for (const expanded of expandVariables(line.replace(/%GameDir%/gi, gameDir), vars)) {
      const cmd = parseScummvmLine(expanded);
      if (cmd) commands.push(cmd);
    }
  }
  return commands;
}

/**
 * Every combination of the values a line's %VARIABLES% can take. Each variable is expanded once,
 * so a value that names its own variable (`set OPT=%OPT% -f`) can't recurse forever, and one
 * that isn't set is left as it is without stopping the ones after it.
 */
function expandVariables(line, vars, seen = new Set()) {
  const name = [...line.matchAll(/%(\w+)%/g)].map((m) => m[1].toLowerCase()).find((n) => vars.has(n) && !seen.has(n));
  if (!name) return [line];
  const next = new Set(seen).add(name);
  return vars.get(name).flatMap((v) => expandVariables(line.replace(new RegExp(`%${name}%`, 'gi'), () => v), vars, next));
}

/** One `scummvm.exe …` command line, or null when it has no data path. */
function parseScummvmLine(line) {
  const args = splitCommandLine(line);
  const exeIndex = args.findIndex((a) => /scummvm\.exe$/i.test(a));
  const cmd = { dataRel: null, target: null, autoDetect: false, config: null, sound: 'default', options: {} };

  for (const arg of args.slice(exeIndex + 1)) {
    if (arg.startsWith('-p') && !arg.startsWith('--')) cmd.dataRel = arg.slice(2);
    else if (arg.startsWith('--path=')) cmd.dataRel = arg.slice(7);
    else if (arg === '--auto-detect') cmd.autoDetect = true;
    else if (arg.startsWith('--config=')) cmd.config = arg.slice(9);
    else if (/^-e[a-z0-9]+$/i.test(arg)) cmd.sound = arg.slice(2).toLowerCase();
    else if (arg.startsWith('--music-driver=')) cmd.sound = arg.slice(15).toLowerCase();
    else if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      if (PASSTHROUGH.has(key)) cmd.options[key] = rest.length ? rest.join('=') : true;
    } else if (!arg.startsWith('-') && !/%\w+%/.test(arg)) {
      cmd.target = arg;
    }
  }
  if (!cmd.dataRel || /%\w+%/.test(cmd.dataRel)) return null;
  cmd.dataRel = path.normalize(cmd.dataRel.replace(/^\.[\\/]/, '')).replace(/[\\/]+$/, '');
  return cmd;
}

/**
 * Groups launcher commands into versions, each with its music choices.
 * @param {ReturnType<typeof parseExoLauncher>} commands
 * @param {object} exoIni parsed eXo scummvm.ini, for targets defined there (e.g. "kq6-cd-win")
 * @param {Record<string, string[]>} engineMap game ID -> engine IDs (server/data/scummvm-engines.json)
 */
export function buildVersions(commands, exoIni = {}, engineMap = {}) {
  const versions = [];
  const byKey = new Map();
  for (const cmd of commands) {
    const resolved = resolveTarget(cmd, exoIni);
    const { target, extraOptions } = resolved;
    const gameId = qualifyGameId(resolved.gameId, engineMap);
    const options = { ...extraOptions, ...cmd.options };
    const key = JSON.stringify([cmd.dataRel.toLowerCase(), gameId, cmd.autoDetect, options.platform ?? '', options.language ?? '']);
    let version = byKey.get(key);
    if (!version) {
      version = {
        dataRel: cmd.dataRel,
        target,
        gameId,
        autoDetect: cmd.autoDetect || !gameId,
        platform: options.platform ?? null,
        language: options.language ?? null,
        sounds: [],
      };
      byKey.set(key, version);
      versions.push(version);
    }
    if (!version.sounds.some((s) => s.driver === cmd.sound)) {
      version.sounds.push({ driver: cmd.sound, label: own(SOUND_LABELS, cmd.sound) ?? cmd.sound, options });
    }
  }
  return versions;
}

/** Maps a launcher's target to a ScummVM game ID, expanding eXo's own config targets. */
function resolveTarget(cmd, exoIni) {
  const section = cmd.config && cmd.target ? own(exoIni, cmd.target) : null;
  if (!section?.gameid) return { target: cmd.target, gameId: cmd.target, extraOptions: {} };
  const extraOptions = {};
  if (section.platform) extraOptions.platform = section.platform;
  if (section.language) extraOptions.language = section.language;
  const gameId = section.engineid ? `${section.engineid}:${section.gameid}` : section.gameid;
  return { target: cmd.target, gameId, extraOptions };
}

/**
 * Current ScummVM only accepts bare game IDs from the command line when they're unambiguous
 * across all engines (and not always even then), so qualify them as "engine:game". Returns
 * null when the engine can't be determined, which makes the version fall back to auto-detect.
 */
export function qualifyGameId(gameId, engineMap) {
  if (!gameId || gameId.includes(':')) return gameId;
  // Exact match first (some IDs are mixed case, like "Soccer2004"), then ignoring case
  // (eXo writes a few, like "Sky" and "BRA", differently from ScummVM).
  const id = own(engineMap, gameId) ? gameId : lowerCaseIndex(engineMap).get(gameId.toLowerCase());
  const engines = id && own(engineMap, id);
  return engines?.length === 1 ? `${engines[0]}:${id}` : null;
}

const lowerCaseIndexes = new WeakMap();
function lowerCaseIndex(engineMap) {
  if (!lowerCaseIndexes.has(engineMap)) {
    lowerCaseIndexes.set(engineMap, new Map(Object.keys(engineMap).map((k) => [k.toLowerCase(), k])));
  }
  return lowerCaseIndexes.get(engineMap);
}

/**
 * Readable names for a game's versions: each version's own data folder name, or the game
 * title when it uses the game's top folder. Versions that would share a name get their
 * platform, then language, appended.
 */
export function labelVersions(versions, gameDir, title) {
  const labels = versions.map((v) => {
    const folder = path.basename(v.dataRel);
    return folder.toLowerCase() === gameDir.toLowerCase() ? title : folder;
  });
  // Within each group of identical labels, add a detail only if it tells them apart.
  const disambiguate = (extra) => {
    const groups = new Map();
    labels.forEach((label, i) => groups.set(label, [...(groups.get(label) ?? []), i]));
    for (const [label, indexes] of groups) {
      if (indexes.length < 2) continue;
      const suffixes = indexes.map((i) => extra(versions[i]));
      if (new Set(suffixes).size < 2) continue;
      indexes.forEach((i, k) => { if (suffixes[k]) labels[i] = `${label}, ${suffixes[k]}`; });
    }
  };
  // Platform names match the version kinds ranked in Settings ("Macintosh", not "Mac").
  disambiguate((v) => flagPlatformName(v.platform) ?? v.platform);
  disambiguate((v) => v.language);
  // eXo offers ScummVM's "enhanced" variants of some games (ultima4_enh, …) alongside the originals.
  disambiguate((v) => (/_enh$/.test(v.gameId ?? v.target ?? '') ? 'enhanced' : 'original'));
  disambiguate((v) => v.target);
  return labels;
}

/** The music choice to use when none is picked: standard music when offered, else the first. */
export function defaultSound(version) {
  return (version.sounds.find((s) => s.driver === 'default') ?? version.sounds[0])?.driver ?? 'default';
}

/**
 * Arguments for the browser build. Values must not contain spaces: the web shell splits
 * its URL fragment on spaces.
 * @param {object} version from buildVersions
 * @param {string} driver one of version.sounds[].driver
 * @param {{ dataPath: string, mt32Path: string, soundfont: string|null }} paths virtual paths
 */
export function webArguments(version, driver, { dataPath, mt32Path, soundfont }) {
  const sound = version.sounds.find((s) => s.driver === driver) ?? version.sounds[0];
  const args = [];
  if (version.autoDetect) args.push('--auto-detect');
  args.push(`--path=${dataPath}`);
  for (const [key, value] of Object.entries(sound?.options ?? {})) {
    args.push(value === true ? `--${key}` : `--${key}=${value}`);
  }
  if (sound && sound.driver !== 'default') {
    args.push(`--music-driver=${sound.driver}`);
    if (sound.driver === 'mt32') args.push(`--extrapath=${mt32Path}`);
    if (sound.driver === 'fluidsynth' && soundfont) args.push(`--soundfont=${soundfont}`);
  }
  if (!version.autoDetect) args.push(version.gameId);
  for (const a of args) {
    if (/\s/.test(a)) throw new Error(`Argument contains a space and can't be passed to the web build: ${a}`);
  }
  return args;
}
