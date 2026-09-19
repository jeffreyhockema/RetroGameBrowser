// App settings shared by every browser that uses this server, and the games played in the
// browser, stored as JSON in the project folder (never in LaunchBox).

import fs from 'node:fs/promises';
import path from 'node:path';
import { isMap, invalid, parseJson, renameWhenFree } from './util.js';

let tmpCount = 0;

/**
 * Writes JSON to a temporary file, then renames it over `file`, so a crash or a power cut never
 * leaves half a file. `mode`: the new file's permissions (0o600 for sessions, say).
 */
export async function writeJson(file, data, { mode } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // A name of its own per write: two writes sharing one would rename each other's half-written file.
  const tmp = `${file}.${process.pid}.${++tmpCount}.tmp`;
  try {
    const handle = await fs.open(tmp, 'w', mode);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
      // The rename is journaled but the data isn't: without this a power cut can leave `file` full of zeros.
      await handle.sync();
    } finally {
      await handle.close(); // Windows won't rename a file that's still open
    }
    await renameWhenFree(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * A JSON file's contents, or `fallback` when there's no file yet. Any other failure (a file
 * another program has locked, say) is thrown: taking it for "no file" would have the next
 * save write the defaults over what was there.
 */
export async function readJson(file, fallback) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  return parseJson(text, file) ?? fallback;
}

// What the shelf shows: which games it holds back, and what the Multiplayer menu counts. The
// owner sets what everyone starts with (ServerSettings.shelfDefaults, on the admin page); each
// account can change the ones in PERSONAL_FILTERS for itself, from the profile menu.
export const SHELF_FLAGS = ['showBroken', 'showNonEnglish', 'showPrereleases', 'showNoImage', 'pcMultiplayerWithoutNetwork'];
export const PERSONAL_FILTERS = ['showNonEnglish', 'showBroken'];
const SHELF_DEFAULTS = Object.freeze({
  showBroken: false,       // show games that don't run in the browser build
  showNonEnglish: false,   // show games that never had an English release
  showPrereleases: false,  // show betas, demos and prototypes
  showNoImage: false,      // show games with no picture (box art or screenshot) to put on the shelf
  pcMultiplayerWithoutNetwork: false, // Multiplayer menu: DOS and Windows games count as 2+/3+ without eXo's network play
});

// An account's own settings: its changes to the shelf's defaults, each player's controller
// layout in console games, and the three per-game things this app remembers. The order it
// prefers versions in isn't among them: that's a fixed ranking (see versionkind.js), which a
// game page can override for one game at a time.
const DEFAULTS = {
  filters: {},             // one of PERSONAL_FILTERS -> true/false, where it differs from the owner's default
  favorites: {},           // game id -> true/false, overriding the mark LaunchBox has
  gameDefaults: {},        // game id -> version id chosen as that game's default
  controllerLayouts: [1, 1, 1, 1], // console games: players 1-4's controller layout (see LAYOUTS)
  touchButtons: {},        // game id -> a DOS game's on-screen buttons on a phone (see TOUCH_SLOTS)
};

/** The shelf's flags as someone sees them: their own changes over the owner's defaults. */
export function shelfFlags(defaults, filters = {}) {
  return Object.fromEntries(SHELF_FLAGS.map((flag) => [flag, PERSONAL_FILTERS.includes(flag) && typeof filters[flag] === 'boolean' ? filters[flag] : Boolean(defaults[flag])]));
}

/**
 * The controller layouts a player can have in a console game (public/player/emulatorjs-fixes.js):
 * 1 puts each console button where it was on the console's own controller (a Super Nintendo's B
 * at the bottom), 2 makes the Xbox controller's A the game's A.
 */
export const LAYOUTS = [1, 2];
export const PLAYERS = 4;

/** Players 1-4's layouts from a request's text ("1,2,1,1"), each one it doesn't give being 1. */
export function parseLayouts(text) {
  const given = String(text ?? '').split(',').map(Number);
  return Array.from({ length: PLAYERS }, (_, i) => (LAYOUTS.includes(given[i]) ? given[i] : LAYOUTS[0]));
}

/**
 * The on-screen buttons a DOS game has on a phone (public/js/touchbuttons.js), which a game's
 * entry in touchButtons changes: { show: true/false, keys: { a: 'ControlLeft', l: '' } }, each
 * slot given the key it presses (a KeyboardEvent code) or '' for no button there. Anything it
 * leaves out stays as it was by default.
 */
export const TOUCH_SLOTS = ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'select', 'start', 'l', 'r'];

function validTouchButtons(entry) {
  if (entry === null) return true;
  if (!isMap(entry) || !Object.keys(entry).every((k) => k === 'show' || k === 'keys')) return false;
  if (Object.hasOwn(entry, 'show') && typeof entry.show !== 'boolean') return false;
  if (!Object.hasOwn(entry, 'keys')) return true;
  return isMap(entry.keys) && Object.entries(entry.keys)
    .every(([slot, key]) => TOUCH_SLOTS.includes(slot) && typeof key === 'string' && /^[A-Za-z0-9]{0,24}$/.test(key));
}

/** The settings of someone who hasn't saved any (or isn't signed in, and so can't). */
export const defaultSettings = () => structuredClone(DEFAULTS);

export class SettingsStore {
  constructor(file) {
    this.file = file;
    this.cache = null;
    this.queue = Promise.resolve(); // updates run one after another, so none is lost
  }

  async get() {
    if (!this.cache) {
      const saved = await readJson(this.file, {});
      // Only the fields still in use, so a file written by an older version (which let you
      // rank version kinds) doesn't carry settings this one no longer has.
      // The shelf's flags were once kept here for each account; the owner's defaults stand for
      // them now (see SHELF_FLAGS).
      this.cache = { ...DEFAULTS, ...(isMap(saved) ? Object.fromEntries(Object.entries(saved).filter(([k]) => Object.hasOwn(DEFAULTS, k))) : {}) };
      this.cache.filters = Object.fromEntries(Object.entries(isMap(this.cache.filters) ? this.cache.filters : {})
        .filter(([k, v]) => PERSONAL_FILTERS.includes(k) && typeof v === 'boolean'));
    }
    return structuredClone(this.cache);
  }

  /**
   * Merges known, valid fields into the saved settings and returns the result.
   *
   * The settings come from anyone who signs in, so only real games are kept: `isGame(id)` and
   * `isVersion(gameId, versionId)` say what's real (by default anything is), and changes for
   * anything else are dropped. That keeps each map no bigger than the library.
   */
  update(patch, { isGame = () => true, isVersion = () => true, shelfDefaults = SHELF_DEFAULTS } = {}) {
    const run = this.queue.then(async () => {
      const current = await this.get();
      const next = structuredClone(current);
      // Only these are an account's own. The shelf's other flags are the owner's (shelfDefaults),
      // and one sent by a page from before is left alone rather than turned down.
      for (const flag of PERSONAL_FILTERS) {
        if (!Object.hasOwn(patch, flag)) continue;
        if (patch[flag] !== null && typeof patch[flag] !== 'boolean') throw invalid(`${flag} must be true, false or null.`);
        // The same as the owner's default is no change: it follows the default from then on.
        if (patch[flag] === null || patch[flag] === Boolean(shelfDefaults[flag])) delete next.filters[flag];
        else next.filters[flag] = patch[flag];
      }
      if (Object.hasOwn(patch, 'controllerLayouts')) {
        const layouts = patch.controllerLayouts;
        if (!Array.isArray(layouts) || layouts.length !== PLAYERS || !layouts.every((n) => LAYOUTS.includes(n))) {
          throw invalid(`controllerLayouts must be ${PLAYERS} of ${LAYOUTS.join(' or ')}.`);
        }
        next.controllerLayouts = [...layouts];
      }
      if (Object.hasOwn(patch, 'favorites')) {
        // A partial map: true or false marks a game, null goes back to what LaunchBox says.
        const changes = patch.favorites;
        if (!isMap(changes) || !Object.entries(changes).every(([k, v]) => k.length < 80 && (v === null || typeof v === 'boolean'))) {
          throw invalid('favorites must map game ids to true, false or null.');
        }
        for (const [gameId, on] of Object.entries(changes)) {
          if (on === null) delete next.favorites[gameId];
          else if (isGame(gameId)) next.favorites[gameId] = on;
        }
      }
      if (Object.hasOwn(patch, 'gameDefaults')) {
        // A partial map: a version id sets a game's default, null removes it.
        const changes = patch.gameDefaults;
        if (!isMap(changes) || !Object.entries(changes).every(([k, v]) => k.length < 80 && (v === null || (typeof v === 'string' && v.length < 100)))) {
          throw invalid('gameDefaults must map game ids to version ids.');
        }
        for (const [gameId, versionId] of Object.entries(changes)) {
          if (versionId === null) delete next.gameDefaults[gameId];
          else if (isGame(gameId) && isVersion(gameId, versionId)) next.gameDefaults[gameId] = versionId;
        }
      }
      if (Object.hasOwn(patch, 'touchButtons')) {
        // A partial map: a game's buttons replace what it had, null goes back to the defaults.
        const changes = patch.touchButtons;
        if (!isMap(changes) || !Object.entries(changes).every(([k, v]) => k.length < 80 && validTouchButtons(v))) {
          throw invalid('touchButtons must map game ids to { show, keys } or null.');
        }
        for (const [gameId, entry] of Object.entries(changes)) {
          if (entry === null) delete next.touchButtons[gameId];
          else if (isGame(gameId)) next.touchButtons[gameId] = structuredClone(entry);
        }
      }
      // Nothing changed (a favorite marked again, say): nothing to write.
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        await writeJson(this.file, next);
        this.cache = next;
      }
      return structuredClone(next);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

/**
 * Settings of the server itself rather than of anyone's account, which only the owner changes
 * (on the admin page): whether guests (anyone not signed in) may play and download games, as for
 * a demo, and optionally until when; the public address invite links are made with; and what
 * the shelf shows everyone who hasn't changed it for themselves (shelfDefaults, see SHELF_FLAGS);
 * whether local accounts can sign in (localLogins, see lib/localusers.js) and whether anyone may
 * make one for themselves (localSignup). Kept in memory once loaded, since every request asks.
 */
export class ServerSettings {
  static DEFAULTS = Object.freeze({ guestsCanPlay: false, guestsUntil: null, publicUrl: null, shelfDefaults: SHELF_DEFAULTS, localLogins: false, localSignup: false });

  constructor(file) {
    this.file = file;
    this.values = { ...ServerSettings.DEFAULTS };
    this.queue = Promise.resolve();
  }

  /** Reads the file (once, at start-up). A file that can't be read is an error, not "defaults". */
  async load() {
    const saved = await readJson(this.file, {});
    this.values = { ...ServerSettings.DEFAULTS };
    if (isMap(saved) && typeof saved.guestsCanPlay === 'boolean') this.values.guestsCanPlay = saved.guestsCanPlay;
    if (isMap(saved) && this.values.guestsCanPlay && isTime(saved.guestsUntil)) this.values.guestsUntil = saved.guestsUntil;
    if (isMap(saved) && typeof saved.publicUrl === 'string') this.values.publicUrl = publicOrigin(saved.publicUrl);
    if (isMap(saved) && isMap(saved.shelfDefaults)) this.values.shelfDefaults = shelfFlags(saved.shelfDefaults);
    for (const key of ['localLogins', 'localSignup']) if (isMap(saved) && typeof saved[key] === 'boolean') this.values[key] = saved[key];
    return this.get();
  }

  /** The settings as they stand now: guests who were let in until a time that's passed aren't. */
  get(now = Date.now()) {
    return {
      guestsCanPlay: this.guestsCanPlayAt(now),
      guestsUntil: this.guestsCanPlayAt(now) ? this.values.guestsUntil : null,
      publicUrl: this.values.publicUrl,
      shelfDefaults: { ...this.values.shelfDefaults },
      localLogins: this.values.localLogins,
      localSignup: this.values.localSignup,
    };
  }

  get guestsCanPlay() {
    return this.guestsCanPlayAt(Date.now());
  }

  guestsCanPlayAt(now) {
    return this.values.guestsCanPlay && (!this.values.guestsUntil || Date.parse(this.values.guestsUntil) > now);
  }

  /**
   * Changes the known fields given and saves them: guestsCanPlay (true or false) and guestsUntil
   * (a time to let guests in until, or null for until they're turned off). Turning guests off
   * clears the time. guestsForMinutes, when given, says how long instead, counted from this
   * server's clock, and guestsUntil is then ignored: a device whose clock is behind would
   * otherwise send a time already past, or let guests in for less time than was asked.
   * publicUrl is an http(s) address (only its origin is kept), or null or '' to clear it;
   * `isKnownHost`, when given, turns down one whose host this server wouldn't answer to.
   * shelfDefaults changes any of SHELF_FLAGS given, each true or false. localLogins and
   * localSignup are true or false (the admin page turns local accounts on through
   * POST /api/admin/local-logins, which makes sure there's an owner to sign in as first).
   */
  update(patch, { isKnownHost } = {}) {
    const run = this.queue.then(async () => {
      const next = { ...this.values };
      if (Object.hasOwn(patch ?? {}, 'guestsCanPlay')) {
        if (typeof patch.guestsCanPlay !== 'boolean') throw invalid('guestsCanPlay must be true or false.');
        next.guestsCanPlay = patch.guestsCanPlay;
      }
      if (Object.hasOwn(patch ?? {}, 'guestsForMinutes')) {
        const minutes = patch.guestsForMinutes;
        if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_GUEST_MINUTES) {
          throw invalid(`guestsForMinutes must be more than 0 and at most ${MAX_GUEST_MINUTES}.`);
        }
        next.guestsUntil = new Date(Date.now() + minutes * 60_000).toISOString();
      } else if (Object.hasOwn(patch ?? {}, 'guestsUntil')) {
        const until = patch.guestsUntil;
        if (until !== null && (!isTime(until) || Date.parse(until) <= Date.now())) throw invalid('guestsUntil must be a time still to come, or null.');
        next.guestsUntil = until === null ? null : new Date(until).toISOString();
      }
      // Off, or back on after a time that has passed: no time left over from before.
      if (!next.guestsCanPlay || (next.guestsUntil && Date.parse(next.guestsUntil) <= Date.now())) next.guestsUntil = null;
      if (Object.hasOwn(patch ?? {}, 'publicUrl')) {
        const given = patch.publicUrl;
        if (given === null || given === '') {
          next.publicUrl = null;
        } else {
          const origin = typeof given === 'string' ? publicOrigin(given) : null;
          if (!origin) throw invalid('The public address must be a web address starting with https:// (or http://).');
          const { host, hostname } = new URL(origin);
          if (isKnownHost && !isKnownHost(host)) {
            throw invalid(`This server doesn't answer to ${hostname} yet: add "${hostname}" to allowedHosts in config.local.json and restart it first.`);
          }
          next.publicUrl = origin;
        }
      }
      for (const key of ['localLogins', 'localSignup']) {
        if (!Object.hasOwn(patch ?? {}, key)) continue;
        if (typeof patch[key] !== 'boolean') throw invalid(`${key} must be true or false.`);
        next[key] = patch[key];
      }
      if (Object.hasOwn(patch ?? {}, 'shelfDefaults')) {
        const given = patch.shelfDefaults;
        if (!isMap(given) || !Object.entries(given).every(([k, v]) => SHELF_FLAGS.includes(k) && typeof v === 'boolean')) {
          throw invalid(`shelfDefaults must map ${SHELF_FLAGS.join(', ')} to true or false.`);
        }
        next.shelfDefaults = { ...next.shelfDefaults, ...given };
      }
      await writeJson(this.file, next);
      this.values = next;
      return this.get();
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

const MAX_GUEST_MINUTES = 7 * 24 * 60; // a week

/** An http(s) address's origin ("https://games.example.com"), or null when it isn't one. Typed without a scheme, https is assumed. */
export function publicOrigin(text) {
  const trimmed = String(text).trim();
  if (!trimmed || trimmed.length > 200) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}
const isTime = (v) => typeof v === 'string' && v.length < 40 && !Number.isNaN(Date.parse(v));

/**
 * Games played in this app: game id -> { lastPlayed (ISO date), playCount }, in a file of
 * their own. LaunchBox keeps its own play history, which this app never writes; the server
 * adds the two together when it answers (see mergePlays).
 */
export class PlayStore {
  constructor(file) {
    this.file = file;
    this.cache = null;
    this.queue = Promise.resolve(); // writes run one after another, so none is lost
    this.version = 0;               // bumped by every play, so lists built from these know to refresh
  }

  async load() {
    if (!this.cache) {
      const data = await readJson(this.file, {});
      this.cache = isMap(data) ? data : {};
    }
    return this.cache;
  }

  /** A game's plays in this app, or null. Call load() once first. */
  get(gameId) {
    return this.cache?.[gameId] ?? null;
  }

  /** Counts one play of a game, now, and returns its entry. */
  record(gameId, when = new Date()) {
    const run = this.queue.then(async () => {
      const plays = await this.load();
      const entry = { lastPlayed: when.toISOString(), playCount: (Number(plays[gameId]?.playCount) || 0) + 1 };
      const next = { ...plays, [gameId]: entry };
      await writeJson(this.file, next);
      this.cache = next;
      this.version++;
      return { ...entry };
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

const timeOf = (iso) => (iso ? Date.parse(iso) : NaN);

/**
 * A game's play count and last-played date: LaunchBox's and this app's (from PlayStore)
 * together. The dates carry different time zone offsets, so they're compared as times.
 */
export function mergePlays({ playCount = 0, lastPlayed = null } = {}, ours = null) {
  if (!ours) return { playCount: playCount ?? 0, lastPlayed: lastPlayed ?? null };
  const theirs = timeOf(lastPlayed);
  const mine = timeOf(ours.lastPlayed);
  return {
    playCount: (playCount ?? 0) + (Number(ours.playCount) || 0),
    lastPlayed: Number.isNaN(mine) || mine < theirs ? lastPlayed : ours.lastPlayed,
  };
}
