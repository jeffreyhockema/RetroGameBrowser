// Serves games to the browser engines.
//
// Three engines run in the browser. ScummVM reads game data over HTTP from /data/...: every
// folder has an index.json mapping names to file sizes (or {} for sub-folders), and files
// are fetched by URL; each playable version is presented as /data/games/<gameId>-<n>/,
// backed by its eXo folder. DOSBox (js-dos) loads a game's whole eXoDOS zip into memory,
// with a dosbox.conf rewritten for the browser (see dosbox.js). EmulatorJS runs console
// games: each ROM file is a version, fetched whole from /data/rom/<versionId>/<file>
// (see emulatorjs.js). Arcade games run in MAME 0.244's own browser build: a game's zips, disk
// images and samples are fetched whole from /data/mame/<versionId>/<path> (see mame.js).

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PathResolver } from './paths.js';
import { dataJson } from './util.js';
import { parseExoLauncher, parseIni, buildVersions, labelVersions, defaultSound, webArguments, own } from './scummvm.js';
import {
  parseDosboxConf, confValue, browserConf, mediaOf, midiDeviceOf, wantsAspect, wantsMouseLock, wantsIpx, confLabel, pathFixerFor, listZip, readZipText,
  listZipEntries, foldersNeededBefore, launcherIssue, isConfFile, zipNameFor, SOUND_LABELS as DOS_SOUND_LABELS, MIDI_SOUNDS, readZipBytes,
} from './dosbox.js';
import { parseNetworkBat, multiplayerAutoexec } from './netbat.js';
import { CORES, BIOS_FILES, isRomFile, romTags, romRegions, romKind, romLabel, biosNameFor, discSetName, frameRateFor } from './emulatorjs.js';
import { worthUnpacking, folderListing, storedZipSize } from './romcache.js';
import { isWin3xCollection, skipInBundle, win3xIssue } from './win3x.js';
import {
  win9xLayout, parseWin9xAutoexec, win9xConf, win9xIssue, inBundle as inWin9xBundle, nameTracksAsCues, ORIGIN_PLACEHOLDER, SYSTEM_DISK_EDITION,
} from './win9x.js';
import { classifyVersion, makeKind } from './versionkind.js';
import { ENGINE_NAME as MAME_ENGINE_NAME, mameSets, isMameEmulator, setNameOf, arcadeKind, arcadeLabel, arcadeRegions, mameFiles, mameIssue } from './mame.js';
import { setFolderExtras } from './library.js';
import {
  IIGS_BUNDLE, exoIIgsLauncher, parseGsplusConfig, parseExceptionBat, parseExceptionMenu, parseExceptionNotes, iigsNotesInPlace, iigsPlan, iigsSpareDisks, iigsArgs, iigsRomSets, iigsBram, isDiskCopy, RAW_800K, iigsKnownIssue,
} from './iigs.js';

const engineMap = dataJson('scummvm-engines.json');
// ScummVM engines (or specific game IDs) known to crash in the current browser build.
const knownIssues = dataJson('web-known-issues.json');
// Console releases the browser core can't run, by platform and ROM file name.
const consoleIssues = dataJson('console-known-issues.json');

export const ENGINE_NAMES = { scummvm: 'ScummVM', dosbox: 'DOSBox', emulatorjs: 'EmulatorJS', mame: MAME_ENGINE_NAME };

/**
 * The ScummVM engines that could run a version, for a download that has to carry their
 * plugins (see standalone.js). Usually one: the ID a version was matched to names its engine.
 * Empty when nothing is known, which means ScummVM would work it out from the game's files
 * and every engine has to come along.
 */
export function scummvmEnginesFor(version) {
  const id = version.gameId ?? '';
  if (id.includes(':')) return [id.split(':')[0]];
  const target = version.target ?? '';
  const engines = own(engineMap, target) ?? own(engineMap, lowerCaseKeys().get(target.toLowerCase()));
  return engines ?? [];
}

let lowerCased = null;
const lowerCaseKeys = () => (lowerCased ??= new Map(Object.keys(engineMap).map((k) => [k.toLowerCase(), k])));

/** A known problem with running this version in the browser, or null. */
export function knownIssueFor(version) {
  if (version.engine === 'dosbox' || version.engine === 'emulatorjs' || version.engine === 'mame') return version.knownIssue ?? null;
  const [engine, id] = (version.gameId ?? '').includes(':') ? version.gameId.split(':') : [null, version.gameId];
  return knownIssues.games?.[id] ?? knownIssues.engines?.[engine] ?? null;
}

export const DATA_URL = '/data';
export const GAMES_URL = `${DATA_URL}/games`;
export const MT32_URL = `${DATA_URL}/mt32`;
export const DOS_URL = `${DATA_URL}/dos`;
export const ROM_URL = `${DATA_URL}/rom`;
export const DISK_URL = `${DATA_URL}/disk`;
export const MAME_URL = `${DATA_URL}/mame`;

const INDEX_CONCURRENCY = 16;
/** The shape of cache/dos-launchers.json. Bump it when a cached record gains or loses a field. */
export const INDEX_FORMAT = 4;
const INDEX_RETRY_MS = 5 * 60 * 1000; // how soon a run that couldn't read some launchers is retried

export class WebPlay {
  /** Version id -> its parsed network.bat, or null when it hasn't got a usable one. */
  #netBats = new Map();

  /**
   * @param {import('./library.js').Library} library
   * @param {PathResolver} resolver
   * @param {object} options
   * @param {string} options.scummvmDir holds scummvm.js, scummvm.wasm and data/
   * @param {string} options.jsdosDir the js-dos dist folder
   * @param {string} [options.emulatorDir] vendor/emulatorjs, with data/loader.js and data/cores/
   * @param {string} [options.mameDir] vendor/mame, with a <bundle>.js and <bundle>.wasm per bundle
   * @param {number} [options.maxMameBytes] biggest arcade game (its zips and disk images) offered to the browser
   * @param {number} [options.maxZipBytes] biggest eXoDOS zip offered to the browser
   * @param {number} [options.maxRomBytes] biggest console ROM offered to the browser
   * @param {string|null} [options.indexFile] where the DOS launcher index is cached
   * @param {'dosbox'|'dosboxX'} [options.dosBackend] js-dos build for games without MIDI music
   * @param {import('./romcache.js').RomCache|null} [options.romCache] unpacks CD archives on the server
   * @param {number} [options.unpackMinBytes] smallest archive worth unpacking on the server
   */
  constructor(library, resolver, {
    scummvmDir, jsdosDir, emulatorDir = null, mameDir = null, maxMameBytes = Infinity, maxZipBytes = Infinity, maxRomBytes = Infinity,
    maxWin3xBytes = Infinity, maxWin9xBytes = Infinity, indexFile = null,
    dosBackend = 'dosboxX', romCache = null, unpackMinBytes = 32 * 1024 * 1024,
  }) {
    this.library = library;
    this.resolver = resolver;
    this.scummvmDir = scummvmDir;
    this.jsdosDir = jsdosDir;
    this.emulatorDir = emulatorDir;
    this.mameDir = mameDir;
    this.maxMameBytes = maxMameBytes;
    this.maxZipBytes = maxZipBytes;
    // Windows 3.x games aren't zipped, so the browser gets an uncompressed copy: both it and
    // its unpacked files sit in the emulator's memory, twice the size of the game's folder.
    this.maxWin3xBytes = maxWin3xBytes;
    // Windows 9x games read their hard disks a piece at a time; only their CD images and zips
    // are loaded into memory.
    this.maxWin9xBytes = maxWin9xBytes;
    this.maxRomBytes = maxRomBytes;
    this.romCache = romCache;
    this.unpackMinBytes = unpackMinBytes;
    this.roms = new Map();           // ROM rel path -> { abs, size }, or null when missing (see #romInfo)
    this.cores = new Map();          // EmulatorJS core -> installed?
    this.mameBundles = new Map();    // MAME bundle -> installed?
    this.indexFile = indexFile;
    this.dosBackend = dosBackend; // js-dos backend for games without MIDI: 'dosbox' or 'dosboxX'
    this.cacheGeneration = -1;
    this.versionsByGame = new Map(); // game id -> versions (or [])
    this.versionsById = new Map();   // version id -> version
    this.scummvmVersions = new WeakMap(); // game record -> versions read from its ScummVM launcher
    this.stats = new Map();          // version id -> size stats
    this.inis = new Map();           // eXo root -> parsed scummvm.ini
    this.mt32Listings = new Map();   // eXo root -> { at, names } (see #mt32Files)
    this.systemDisks = new Map();    // stamp -> eXo's Windows 9x disk (see #win9xDiskUrls)
    this.gameDisks = new Map();      // "version id|stamp" -> { at, disk } (see gameDisk)
    this.engines = null;             // engine -> installed?, for the version lists of this generation
    this.dosIndex = new Map();       // game id -> DOS versions, built by ensureIndexed()
    this.dosExtras = new Map();      // game id -> file names in its launcher folder's Extras folder
    this.dosUnreadable = new Set();  // game ids whose launcher folder couldn't be read in the last run
    this.indexedStamp = null;      // #dosStamp() of the library the DOS index was built for
    this.indexing = null;
    this.retryIndexAt = 0;           // when to index again after a run that couldn't read everything
  }

  engineAvailable(engine) {
    if (engine === 'scummvm') return fs.existsSync(path.join(this.scummvmDir, 'scummvm.wasm'));
    if (engine === 'dosbox') return fs.existsSync(path.join(this.jsdosDir, 'js-dos.js'));
    if (engine === 'emulatorjs') return Boolean(this.emulatorDir) && fs.existsSync(path.join(this.emulatorDir, 'data', 'loader.js'));
    if (engine === 'mame') return Boolean(this.mameDir) && fs.existsSync(this.mameDir);
    return false;
  }

  /** Whether a MAME bundle was fetched (npm run fetch-mame). */
  mameBundleAvailable(bundle) {
    if (!this.mameBundles.has(bundle)) {
      this.mameBundles.set(bundle, Boolean(this.mameDir) && fs.existsSync(path.join(this.mameDir, `${bundle}.wasm`)));
    }
    return this.mameBundles.get(bundle);
  }

  /** Whether LaunchBox runs a game with MAME (its arcade games). */
  isMameGame(game) {
    return isMameEmulator(this.library.emulators?.get(game.emulatorId)?.applicationRel);
  }

  /** Whether an EmulatorJS core was fetched (npm run fetch-emulators). */
  coreAvailable(core) {
    if (!this.cores.has(core)) {
      this.cores.set(core, Boolean(this.emulatorDir) && fs.existsSync(path.join(this.emulatorDir, 'data', 'cores', `${core}-wasm.data`)));
    }
    return this.cores.get(core);
  }

  #checkGeneration() {
    if (this.cacheGeneration === this.library.generation) return;
    this.cacheGeneration = this.library.generation;
    this.versionsByGame.clear();
    this.versionsById.clear();
    this.stats.clear();
    this.inis.clear();
    this.cores.clear();
    this.mameBundles.clear();
    this.mameRomDirs = null; // where MAME's own ROM sets are (see #mameSystemRom)
    this.#netBats.clear(); // a game's zip may have been replaced by an eXo update
    this.engines = null;
    // ROMs that were missing may have been added since; found ones keep their size.
    for (const [rel, info] of this.roms) if (!info) this.roms.delete(rel);
  }

  /**
   * Stamp of the platforms that hold eXoDOS games: it changes only when one of them is read
   * again, so a change to a console's XML doesn't re-read thousands of DOS launchers.
   */
  #dosStamp() {
    if (!this.library.platforms) return `generation:${this.library.generation}`;
    return [...this.library.platforms.values()]
      .filter((p) => (p.hasDos ??= p.games.some((g) => dosLayout(g))))
      .map((p) => `${p.name}:${p.stamp ?? this.library.generation}`)
      .join('|');
  }

  // ---------- DOS index ----------

  /**
   * Finds every DOS launcher in the loaded library. DOS launchers live on a network share
   * here, so they're read in parallel, once per library load, and the result is kept in a
   * cache file. With a cache, the server starts right away and re-reads the launchers in the
   * background; without one, the first start waits for the index. When a run couldn't read
   * some launchers (the share was down), it's repeated in the background a few minutes later.
   * The index also lists each launcher folder's Extras folder, so the shelf can show a game's
   * extras without reading its folder (see attachFolderExtras).
   */
  async ensureIndexed() {
    const stamp = this.#dosStamp();
    if (this.indexedStamp === stamp) {
      if (this.retryIndexAt && Date.now() >= this.retryIndexAt && !this.indexing) {
        this.retryIndexAt = 0;
        this.indexing = this.#indexAll().finally(() => { this.indexing = null; });
        this.indexing.catch((err) => console.warn(`Indexing the DOS launchers again failed: ${err.message}`));
      }
      return;
    }
    if (this.indexing) {
      // The run under way is for an older stamp and will drop its result (see #indexAll), so
      // waiting for it gains nothing: answer from the index in hand, and the first request after
      // it ends starts a run for this stamp. With no index yet, there's nothing else to answer from.
      if (this.dosIndex.size || this.dosExtras.size) return;
      return this.indexing;
    }
    const cached = this.dosIndex.size || this.dosExtras.size
      ? { versions: this.dosIndex, extras: this.dosExtras }
      : await this.#readIndexFile();
    // Another request started a run, or took the cache, while the file was being read.
    if (this.indexing || this.indexedStamp === stamp) return this.ensureIndexed();
    this.indexing = this.#indexAll().finally(() => { this.indexing = null; });
    if (!cached) return this.indexing;
    // Runs on in the background from here, where nothing else would hear of a failure.
    this.indexing.catch((err) => console.warn(`Indexing the DOS launchers failed; keeping the cached index: ${err.message}`));
    // Use what we have; the fresh index replaces it when it's ready.
    this.dosIndex = cached.versions;
    this.dosExtras = cached.extras;
    this.indexedStamp = stamp;
    this.cacheGeneration = -1; // versions built before the cached index was taken are stale
  }

  /**
   * Fills in a game's folder extras from the index, once per index, so building the shelf
   * doesn't read thousands of folders. Games the index doesn't know are left to folderExtras().
   */
  attachFolderExtras(game) {
    const names = this.dosExtras.get(game.id);
    if (!names || game.folderExtrasFrom === this.dosExtras) return;
    setFolderExtras(game, names);
    game.folderExtrasFrom = this.dosExtras;
  }

  async #indexAll() {
    const stamp = this.#dosStamp();
    const started = Date.now();
    const games = [...this.library.gamesById.values()].filter((g) => dosLayout(g));
    // A collection folder that can't be read (the share is down) makes every game in it a
    // failure, not a game without a launcher; checking it once saves a probe per game.
    const readable = new Map();
    for (const game of games) {
      const { collection } = dosLayout(game);
      if (!readable.has(collection)) readable.set(collection, this.resolver.resolve(collection) !== null);
    }
    const index = new Map();
    const extras = new Map();
    const failed = [];
    let next = 0;
    await Promise.all(Array.from({ length: INDEX_CONCURRENCY }, async () => {
      for (;;) {
        const game = games[next++];
        if (!game) return;
        try {
          if (!readable.get(dosLayout(game).collection)) throw new Error('its collection folder can\'t be read');
          const found = exoIIgsLauncher(game.applicationRel) ? await this.#indexIIgs(game) : await this.#indexDos(game);
          if (found?.versions) index.set(game.id, found.versions);
          if (found?.extras) extras.set(game.id, found.extras);
        } catch (err) {
          // A few examples are enough; the summary below gives the count.
          if (failed.push(game) <= 5) console.warn(`Couldn't index the DOS launcher of "${game.title}": ${err.message}`);
        }
      }
    }));
    if (stamp !== this.#dosStamp()) return; // a DOS platform was read again meanwhile; it'll be redone
    // A launcher that fails while its collection is still there (a damaged zip, a folder that
    // can't be opened) will fail the same way next time: only a collection that went away is
    // worth trying again, and only an index missing one is too incomplete to cache.
    const stillThere = new Map();
    const unreachable = failed.filter((game) => {
      const { collection } = dosLayout(game);
      if (!stillThere.has(collection)) stillThere.set(collection, this.resolver.resolve(collection) !== null);
      return !stillThere.get(collection);
    });
    // Games whose launcher couldn't be read keep what the previous index knew about them, so
    // a run with the share down never loses versions or extras that were known.
    const previous = this.dosIndex;
    const previousExtras = this.dosExtras;
    for (const game of failed) {
      if (previous.has(game.id)) index.set(game.id, previous.get(game.id));
      if (previousExtras.has(game.id)) extras.set(game.id, previousExtras.get(game.id));
    }
    this.dosIndex = index;
    this.dosExtras = extras;
    this.dosUnreadable = new Set(failed.map((g) => g.id));
    this.indexedStamp = stamp;
    this.cacheGeneration = -1; // versions built from the old index are stale
    this.retryIndexAt = unreachable.length ? Date.now() + INDEX_RETRY_MS : 0;
    if (index.size) console.log(`DOS launchers indexed: ${index.size} games in ${Date.now() - started} ms`);
    if (failed.length) {
      console.warn(`${failed.length} DOS launcher${failed.length === 1 ? '' : 's'} couldn't be read; kept what the previous index had for them${unreachable.length ? ', trying again in a few minutes' : ''}`);
    }
    // With nothing to carry over, a run that couldn't reach a collection isn't worth caching:
    // the next start would trust an incomplete index.
    if (unreachable.length && !previous.size && !previousExtras.size) return;
    await this.#writeIndexFile(index, extras);
  }

  /** The cached index: { versions, extras } maps, or null. */
  async #readIndexFile() {
    if (!this.indexFile) return null;
    try {
      const data = JSON.parse(await fsp.readFile(this.indexFile, 'utf8'));
      if (data.format !== INDEX_FORMAT) return null;
      const versions = new Map(Object.entries(data.games));
      const extras = new Map(Object.entries(data.extras ?? {}));
      console.log(`Using the DOS launcher index cached on ${data.builtAt} (${versions.size} games); refreshing it in the background`);
      return { versions, extras };
    } catch {
      return null;
    }
  }

  async #writeIndexFile(index, extras) {
    if (!this.indexFile) return;
    try {
      await fsp.mkdir(path.dirname(this.indexFile), { recursive: true });
      const tmp = `${this.indexFile}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({
        format: INDEX_FORMAT,
        builtAt: new Date().toISOString(),
        games: Object.fromEntries(index),
        extras: Object.fromEntries(extras),
      }));
      await fsp.rename(tmp, this.indexFile);
    } catch (err) {
      console.warn(`Couldn't write the DOS launcher index: ${err.message}`);
    }
  }

  /**
   * What a game's launcher folder holds: `versions`, its eXoDOS versions, or null when the
   * folder has no dosbox.conf (ScummVM launchers, for instance); and `extras`, the file names
   * in its Extras folder, or null when that can't be told. Returns null when the launcher
   * folder is missing. Throws when the folder or a file in it can't be read, so the caller can
   * tell a share that's down (or a damaged launcher) from a game that isn't a DOS game.
   */
  /**
   * An eXo Apple IIGS game's versions, played with MAME's Apple IIgs (see lib/iigs.js): one from
   * its GSplus config (beside the launcher, or in the game's zip) or from the disks eXo hands MAME,
   * or one per choice when its launcher asks which part to play first.
   */
  async #indexIIgs(game) {
    const layout = dosLayout(game);
    const { gameName } = exoIIgsLauncher(game.applicationRel);
    const launcherAbs = this.resolver.resolve(layout.launcherDir);
    if (!launcherAbs) throw Object.assign(new Error('its launcher folder can\'t be read'), { code: 'ENOENT' });
    const collectionAbs = this.resolver.resolve(layout.collection);
    const zipAbs = collectionAbs && path.join(collectionAbs, `${gameName}.zip`);
    const read = (name) => fsp.readFile(path.join(launcherAbs, name), 'latin1')
      .catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)));
    // The game's disks, found by name without regard to case (the configs aren't consistent).
    const entries = zipAbs && fs.existsSync(zipAbs) ? (await listZipEntries(zipAbs)).filter((e) => !e.name.endsWith('/')) : [];
    const inZip = new Map(entries.map((e) => [path.basename(e.name).toLowerCase(), e]));

    const setups = [];
    const exception = await read('exception.bat');
    const menu = exception ? parseExceptionMenu(exception) : [];
    // What eXo tells the player before the game starts ("double click Start"): shown on the
    // game's page and as the game starts.
    // Some of eXo's are about GSplus, and are said differently here (see iigsNotesInPlace).
    const inPlace = iigsNotesInPlace(layout.gameDir);
    const notes = inPlace !== undefined ? { general: inPlace, sections: new Map() }
      : exception ? parseExceptionNotes(exception) : null;
    const joinNotes = (...texts) => texts.filter(Boolean).join('\n\n') || null;
    if (menu.length) {
      for (const choice of menu) {
        const text = await read(choice.config);
        if (text) setups.push({ label: choice.label, setup: { gsplus: parseGsplusConfig(text) }, howToPlay: joinNotes(notes.general, choice.notes) });
      }
    } else {
      const config = (await read('config.txt'))
        ?? (inZip.has('config.txt') ? await readZipText(zipAbs, (n) => path.basename(n).toLowerCase() === 'config.txt') : null);
      const disks = exception ? parseExceptionBat(exception) : [];
      const howToPlay = notes && joinNotes(notes.general, ...notes.sections.values());
      if (config) setups.push({ label: null, setup: { gsplus: parseGsplusConfig(config) }, howToPlay });
      else if (disks.length) setups.push({ label: null, setup: { mameDisks: disks }, howToPlay });
    }
    if (!setups.length) setups.push({ label: null, setup: { gsplus: { rom: 'ROM1', drives: [] } } });
    const versions = [];
    for (const [index, { label, setup, howToPlay = null }] of setups.entries()) {
      versions.push(await this.#iigsVersion(game, { label, setup, zipAbs, inZip, index, howToPlay }));
    }
    return { versions };
  }

  async #iigsVersion(game, { label, setup, zipAbs, inZip, index, howToPlay }) {
    const plan = iigsPlan(setup, (file) => inZip.get(file.toLowerCase()) ?? null);
    // The game's other floppies, for a player to swap in with MAME's File Manager.
    const spares = iigsSpareDisks(plan, [...inZip.values()]);
    // A disk the size of a DiskCopy image that isn't one is a raw 800K disk with bytes after it:
    // MAME is sent the disk alone (see isDiskCopy).
    const takes = new Map();
    for (const m of [...plan.media, ...spares].filter((x) => x.type === '.dc42')) {
      const entry = inZip.get(m.file.toLowerCase());
      if (isDiskCopy(await readZipBytes(zipAbs, entry.name, 0x54))) continue;
      m.type = m.as?.startsWith('hard') ? '.hdv' : '.img';
      if (m.name) m.name = m.name.replace(/\.dc42$/, '.img');
      takes.set(m, RAW_800K);
    }
    const roms = iigsRomSets(plan).map((name) => {
      const abs = this.#mameSystemRom(game, name);
      return { name: `roms/${name}`, abs, size: abs ? fs.statSync(abs).size : 0, system: true };
    });
    // Each disk by its place and the type MAME is to take it as ("media/1.hdv"), read from the zip.
    const media = plan.media.map((m, i) => {
      const entry = inZip.get(m.file.toLowerCase());
      const take = takes.get(m) ?? null;
      return { name: `media/${i + 1}${m.type}`, zip: zipAbs, member: entry.name, size: take ?? entry.size, take, system: false };
    });
    const args = iigsArgs(plan, (file) => `/${media[plan.media.findIndex((m) => m.file === file)].name}`);
    for (const s of spares) {
      const entry = inZip.get(s.file.toLowerCase());
      const take = takes.get(s) ?? null;
      media.push({ name: `media/${s.name}`, zip: zipAbs, member: entry.name, size: take ?? entry.size, take, system: false });
    }
    const missingRoms = roms.filter((f) => !f.abs).map((f) => path.basename(f.name));
    // Found by trying it (server/data/iigs-known-issues.json), else something missing.
    let knownIssue = iigsKnownIssue(dosLayout(game).gameDir);
    if (!knownIssue && !plan.media.length) knownIssue = 'None of the disks the game\'s setup names are in its zip.';
    else if (missingRoms.length) knownIssue = `MAME's Apple IIgs ROMs weren't found (${missingRoms.join(', ')}).`;
    const files = [...roms, ...media];
    return {
      engine: 'mame',
      engineName: MAME_ENGINE_NAME,
      id: `${game.id}-${index}`,
      label: label ?? 'Apple IIgs',
      gameId: null,
      platform: game.platform,
      setName: plan.machine,
      bundle: IIGS_BUNDLE,
      computer: true,
      sounds: [{ driver: 'default', label: 'Standard' }],
      kind: makeKind('', 'Apple IIgs'),
      regions: [],
      files,
      args,
      // The Control Panel's settings eXo's GSplus config gives the machine (its startup slot among them).
      bram: iigsBram(setup, plan),
      romSize: files.reduce((n, f) => n + f.size, 0),
      knownIssue,
      howToPlay,
    };
  }

  /**
   * Where one of MAME's own ROM sets for a computer is (the Apple IIgs's): with the arcade
   * games' sets, which LaunchBox's MAME keeps in one folder, else in eXo's own MAME.
   */
  #mameSystemRom(game, name) {
    this.mameRomDirs ??= (() => {
      const dirs = [];
      for (const other of this.library.gamesById.values()) {
        if (!this.isMameGame(other)) continue;
        const abs = this.resolver.resolve(other.applicationRel);
        if (abs) { dirs.push(path.dirname(abs)); break; }
      }
      return dirs;
    })();
    const exoMame = this.resolver.resolve(path.join(dosLayout(game).exoRoot, 'emulators', 'MAME', 'roms'));
    for (const dir of [...this.mameRomDirs, exoMame].filter(Boolean)) {
      const abs = path.join(dir, name);
      if (fs.existsSync(abs)) return abs;
    }
    return null;
  }

  async #indexDos(game) {
    const layout = dosLayout(game);
    const launcherDir = this.resolver.resolve(layout.launcherDir);
    if (!launcherDir) {
      // Missing from a readable collection means really missing; otherwise the share went away.
      if (!this.resolver.resolve(layout.collection)) throw new Error('its collection folder can\'t be read');
      return null;
    }
    let entries;
    try {
      entries = await fsp.readdir(launcherDir);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
      throw err;
    }
    const extras = await this.#extrasIn(game, layout, launcherDir, entries);
    if (layout.win9x) return { versions: await this.#win9xVersions(game, layout, launcherDir, entries), extras };
    const confs = entries.filter(isConfFile).sort((a, b) => (/^dosbox\.conf$/i.test(a) ? -1 : /^dosbox\.conf$/i.test(b) ? 1 : a.localeCompare(b)));
    if (!confs.some((c) => /^dosbox\.conf$/i.test(c))) return { versions: null, extras };

    const exceptionBat = entries.some((e) => /^exception\.bat$/i.test(e))
      ? await fsp.readFile(path.join(launcherDir, 'exception.bat'), 'latin1').catch(() => '')
      : '';
    // eXoDOS keeps a game as one zip; eXoWin3x installs it into a folder with its own Windows.
    const win3x = isWin3xCollection(layout.collection);
    const game3x = win3x ? await this.#win3xFolder(layout) : null;
    const zipAbs = win3x ? null : this.resolver.resolve(path.join(layout.collection, zipNameFor(game.applicationRel)));
    const zipSize = zipAbs ? (await fsp.stat(zipAbs)).size : 0;
    const issue = win3x
      ? win3xIssue({ ...game3x, maxBytes: this.maxWin3xBytes }) ?? launcherIssue({ exceptionBat })
      : zipAbs
        ? launcherIssue({ exceptionBat, zipSize, maxZipBytes: this.maxZipBytes })
        : `The game's zip (${zipNameFor(game.applicationRel)}) wasn't found in the eXoDOS folder.`;
    const midiSounds = this.#dosMidiSounds(layout.exoRoot);

    const versions = [];
    for (const [i, confName] of confs.entries()) {
      const confAbs = path.join(launcherDir, confName);
      const sections = parseDosboxConf(await fsp.readFile(confAbs, 'latin1'));
      const autoexec = sections.get('autoexec') ?? [];
      const media = mediaOf(autoexec);
      const midi = midiDeviceOf(sections);
      const sounds = [{ driver: 'default', label: DOS_SOUND_LABELS.default }];
      // eXo set the game up for a MIDI synthesizer: offer the ones we have files for.
      if (midi) for (const driver of midiSounds) sounds.push({ driver, label: `${DOS_SOUND_LABELS[driver]} (DOSBox-X)` });
      versions.push({
        engine: 'dosbox',
        id: `${game.id}-${i}`,
        label: confLabel(confName, game.title),
        gameId: null,
        autoDetect: false,
        platform: 'pc',
        language: null,
        sounds,
        // eXo's own MIDI choice is the default when we can honour it.
        preferredSound: midi && midiSounds.includes(midi) ? midi : 'default',
        kind: makeKind(media, win3x ? 'Windows' : 'DOS'),
        exoRoot: layout.exoRoot,
        confAbs,
        confName,
        zipAbs,
        zipSize,
        // Windows 3.x: where the installed game is, and how big its bundle will be.
        win3x,
        gameDir: layout.gameDir,
        dataAbs: game3x?.dataAbs ?? null,
        dataBytes: game3x?.totalBytes ?? 0,
        aspect: wantsAspect(sections),
        // Windows steers with the mouse and draws its own pointer, so it needs the mouse
        // locked to the game unless the conf says otherwise.
        mouseLock: win3x ? (confValue(sections, 'sdl', 'autolock') ?? 'true').trim().toLowerCase() !== 'false' : wantsMouseLock(sections),
        // eXo turned IPX on, so the game has LAN multiplayer we can offer (see lib/ipx.js).
        ipx: wantsIpx(sections),
        knownIssue: issue,
      });
    }
    return { versions, extras };
  }

  /**
   * File names in the Extras folder of a launcher folder (with `entries`, its listing), or
   * null when the launcher folder isn't the game's root folder, where extras are looked for,
   * or the Extras folder can't be read.
   */
  async #extrasIn(game, layout, launcherDir, entries) {
    const folder = (rel) => path.normalize(rel).replace(/[\\/]+$/, '').toLowerCase();
    if (!game.rootFolder || folder(game.rootFolder) !== folder(layout.launcherDir)) return null;
    const name = entries.find((e) => /^extras$/i.test(e));
    if (!name) return [];
    try {
      const found = await fsp.readdir(path.join(launcherDir, name), { withFileTypes: true });
      return found.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return null;
    }
  }

  /**
   * The installed folder of a Windows 3.x game ("<collection>\<GameDir>"), with the size and
   * file count that say whether eXo's install finished. Null when the folder isn't there.
   */
  async #win3xFolder(layout) {
    const dataAbs = this.resolver.resolve(path.join(layout.collection, layout.gameDir));
    if (!dataAbs) return null;
    const listing = await folderListing(dataAbs, skipInBundle).catch(() => null);
    if (!listing) return null;
    return { dataAbs, totalBytes: listing.totalBytes, fileCount: listing.files.length, emptyCount: listing.emptyCount };
  }

  /**
   * Whether a Windows 3.x version gets a browser's copy (see win3xBundle). A game too big for the
   * browser doesn't: copying it would only fill the cache. Its folder can still be downloaded
   * as it is, for an emulator of one's own, where the browser's memory doesn't matter.
   */
  win3xBundles(version) {
    return Boolean(version.win3x && version.dataAbs && version.dataBytes <= this.maxWin3xBytes);
  }

  /**
   * The browser's copy of a Windows 3.x game: its installed folder, copied into the cache once
   * (see RomCache.packedFolder) so it can be sent as a zip without reading the games drive
   * again, with the swap file Windows left in it dropped.
   */
  async win3xBundle(version, { onlyIfReady = false } = {}) {
    if (!this.win3xBundles(version) || !this.romCache) return null;
    const options = { as: version.gameDir, skip: skipInBundle };
    return onlyIfReady
      ? this.romCache.packedFolderReady(version.dataAbs, options)
      : this.romCache.packedFolder(version.dataAbs, options);
  }

  /**
   * A Windows 9x game's version, from its launcher folder (with `entries`, its listing): what
   * Play.conf mounts, and whether the game's zip and eXo's Windows disk are there.
   */
  async #win9xVersions(game, layout, launcherDir, entries) {
    // A launcher without Play.conf runs the game in 86Box or PCBox. It still gets a version, with
    // that as its problem, so the shelf counts it among the games that don't run in the browser
    // (and hides it by default) and its page says why; its zip can still be downloaded.
    const confName = entries.find((e) => /^play\.conf$/i.test(e)) ?? null;
    const confAbs = confName && path.join(launcherDir, confName);
    const sections = confAbs ? parseDosboxConf(await fsp.readFile(confAbs, 'latin1')) : new Map();
    const mounts = parseWin9xAutoexec(sections.get('autoexec') ?? []);
    const zipAbs = this.resolver.resolve(layout.zipRel);
    const systemAbs = mounts ? this.resolver.resolve(path.join(layout.exoRoot, mounts.systemDisk)) : null;
    let zipEntries = [];
    if (zipAbs) zipEntries = await listZipEntries(zipAbs);
    const names = new Map(zipEntries.map((e) => [e.name.toLowerCase(), e]));
    const gameDisk = mounts && names.get(mounts.gameDisk.toLowerCase());
    const bundleBytes = zipEntries.filter((e) => inWin9xBundle(e.name)).reduce((n, e) => n + e.size, 0);
    const missing = mounts ? mounts.drives.flatMap((d) => d.files).filter((f) => zipAbs && !names.has(f.toLowerCase())) : [];
    const issue = win9xIssue({
      confFound: Boolean(confAbs), mounts, zipFound: Boolean(zipAbs), systemFound: Boolean(systemAbs), gameDiskFound: Boolean(gameDisk),
      bundleBytes, maxBytes: this.maxWin9xBytes,
    }) ?? (missing.length ? `The game's zip doesn't have ${path.basename(missing[0])}, which its launcher mounts.` : null);
    // Without a conf to say, the zip tells whether the game comes on a CD.
    const onCd = mounts ? mounts.media === 'CD' : zipEntries.some((e) => /\.(iso|cue|ccd|bin)$/i.test(e.name));
    // Windows games play General MIDI music, which DOSBox-X plays through a soundfont.
    const soundfont = this.#dosMidiSounds(layout.exoRoot).includes('fluidsynth');
    const sounds = [{ driver: 'default', label: 'No MIDI music' }];
    if (soundfont) sounds.push({ driver: 'fluidsynth', label: DOS_SOUND_LABELS.fluidsynth });
    return [{
      engine: 'dosbox',
      id: `${game.id}-0`,
      label: game.title,
      gameId: null,
      autoDetect: false,
      platform: 'pc',
      language: null,
      sounds,
      preferredSound: soundfont ? 'fluidsynth' : 'default',
      kind: makeKind(onCd ? 'CD' : '', 'Windows'),
      exoRoot: layout.exoRoot,
      confAbs,
      confName,
      zipAbs,
      zipSize: zipAbs ? (await fsp.stat(zipAbs)).size : 0,
      win9x: true,
      gameDir: layout.gameDir,
      // eXo's Windows disk (shared by every game), and the game's own inside its zip.
      systemAbs,
      gameDisk: gameDisk?.name ?? null,
      // What the browser holds in memory: the CD images and zips, not the hard disks.
      dataBytes: bundleBytes,
      aspect: false,
      // Windows draws its own pointer and follows the mouse's movements, not its position.
      mouseLock: true,
      knownIssue: issue,
    }];
  }

  /**
   * The server's unpacked copy of a Windows 9x game's zip (made the first time; see
   * RomCache.unpacked): its hard disk is read from there, and the rest sent to the browser.
   */
  async win9xUnpacked(version, { onlyIfReady = false } = {}) {
    if (!version.win9x || !version.zipAbs || !this.romCache || version.dataBytes > this.maxWin9xBytes) return null;
    return onlyIfReady ? this.romCache.peek(version.zipAbs) : this.romCache.unpacked(version.zipAbs, { zipped: inWin9xBundle });
  }

  /**
   * What a Windows 9x game loads into the browser's memory, from its unpacked zip: everything but
   * its hard disk, with CD tracks named as their cue sheets spell them (see nameTracksAsCues).
   * { dir, files, zipSize }, or null when the zip isn't unpacked (and `onlyIfReady` is set) or
   * can't be.
   */
  async win9xBundle(version, { onlyIfReady = false } = {}) {
    const unpacked = await this.win9xUnpacked(version, { onlyIfReady });
    if (!unpacked) return null;
    const kept = unpacked.files.filter((f) => inWin9xBundle(f.name));
    const cues = new Map();
    for (const f of kept.filter((file) => /\.cue$/i.test(file.name) && file.size < 64 * 1024)) {
      cues.set(f.name, await fsp.readFile(path.join(unpacked.dir, ...f.name.split('/')), 'latin1').catch(() => ''));
    }
    const files = nameTracksAsCues(kept, cues);
    return { dir: unpacked.dir, files, zipSize: storedZipSize(files) };
  }

  /** MIDI drivers whose files exist in eXo's mt32 folder. */
  #dosMidiSounds(exoRoot) {
    const files = this.#mt32Files(exoRoot);
    const sounds = [];
    if (files.some((f) => /^mt32_control\.rom$/i.test(f)) && files.some((f) => /^mt32_pcm\.rom$/i.test(f))) sounds.push('mt32');
    if (files.some((f) => /\.sf2$/i.test(f))) sounds.push('fluidsynth');
    return sounds;
  }

  // ---------- Versions ----------

  /** Playable versions of a game (engines whose browser build is installed), or []. */
  versionsFor(game) {
    this.#checkGeneration();
    if (this.versionsByGame.has(game.id)) return this.versionsByGame.get(game.id);
    // Which engines are installed is checked once per generation, not once per version: the
    // first pass over thousands of games would otherwise spend a second probing the same files.
    this.engines ??= {
      scummvm: this.engineAvailable('scummvm'),
      dosbox: this.engineAvailable('dosbox'),
      emulatorjs: this.engineAvailable('emulatorjs'),
      mame: this.engineAvailable('mame'),
    };
    // A launcher the index couldn't read is on a share that's down, or damaged: reading it again
    // here, synchronously and once per game, would only stall the request.
    let found;
    try {
      found = this.isMameGame(game) ? this.#loadMameVersions(game)
        : CORES[game.platform]
        ? this.#loadRomVersions(game)
        : this.dosIndex.get(game.id) ?? (this.dosUnreadable.has(game.id) ? [] : this.#scummvmVersions(game));
    } catch (err) {
      if (!err.code) throw err; // a bug, not a file that couldn't be read
      // One unreadable launcher or ROM (locked, or the share dropped) mustn't fail every list the
      // game is in. Nothing is kept, so the next call reads it again.
      console.warn(`Couldn't read the versions of "${game.title}": ${err.message}`);
      return [];
    }
    const versions = found.filter((v) => this.engines[v.engine] ?? false);
    this.versionsByGame.set(game.id, versions);
    for (const v of versions) this.versionsById.set(v.id, v);
    return versions;
  }

  /**
   * A ScummVM game's versions, read from its launcher once per game record. library.js makes a
   * new record only when the game's platform XML (or a shared file) is read again, so another
   * platform's XML being rewritten doesn't re-read hundreds of launchers, synchronously.
   */
  #scummvmVersions(game) {
    const cached = this.scummvmVersions.get(game);
    if (cached) return cached;
    const { versions, settled } = this.#loadScummvmVersions(game);
    // A launcher or data folder that couldn't be found (a drive not ready yet) is looked for again next time.
    if (settled) this.scummvmVersions.set(game, versions);
    return versions;
  }

  #loadScummvmVersions(game) {
    // eXo layout: <eXo root>\<collection>\!<Name>\<GameDir>\<GameDir>.bat
    const m = /^(.*)[\\/]![^\\/]+[\\/]([^\\/]+)$/.exec(game.rootFolder);
    if (!m || !/\.bat$/i.test(game.applicationRel)) return { versions: [], settled: true };
    const exoRoot = path.dirname(m[1]);
    const gameDir = m[2];
    const bat = this.resolver.resolve(game.applicationRel);
    if (!bat) return { versions: [], settled: false };
    const text = fs.readFileSync(bat, 'latin1');
    if (!/scummvm\.exe/i.test(text)) return { versions: [], settled: true };

    const found = buildVersions(parseExoLauncher(text, gameDir), this.#exoIni(exoRoot), engineMap)
      // A game's data stays inside the eXo folder: a launcher's "-p..\Data" would otherwise
      // serve LaunchBox's own settings as the game's files.
      .map((v) => ({ ...v, dir: PathResolver.within(path.resolve(exoRoot), v.dataRel) && this.resolver.resolve(path.join(exoRoot, v.dataRel)) }));
    const versions = found.filter((v) => v.dir && fs.statSync(v.dir).isDirectory());
    const labels = labelVersions(versions, gameDir, game.title);
    return { settled: versions.length === found.length, versions: versions.map((v, i) => ({
      ...v,
      engine: 'scummvm',
      id: `${game.id}-${i}`,
      label: labels[i],
      exoRoot,
      kind: classifyVersion({ label: labels[i], platform: v.platform, gameId: v.gameId }, gameDir),
      note: cdAudioNote(v.dir),
    })) };
  }

  /**
   * A console game's versions: its own ROM, then the other regional releases LaunchBox lists
   * with it. Each is named and ranked by the region in its file name ("USA, Rev 1").
   */
  #loadRomVersions(game) {
    const core = CORES[game.platform];
    if (!this.coreAvailable(core.core)) return [];
    const roms = [{ rel: game.applicationRel }, ...(game.alternates ?? []).map((a) => ({ ...a, alternate: true }))]
      .filter((r) => r.rel && isRomFile(r.rel) && !Object.hasOwn(BIOS_FILES, path.basename(r.rel).toLowerCase()));
    const seen = new Set();
    const versions = [];
    for (const rom of roms) {
      const key = path.normalize(rom.rel).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const info = this.#romInfo(rom.rel);
      const fileName = path.basename(rom.rel);
      const tags = romTags(fileName);
      let knownIssue = null;
      if (!info) knownIssue = `The game file (${fileName}) wasn't found.`;
      else if (info.size > this.maxRomBytes) knownIssue = `Too big to load in the browser (${Math.round(info.size / 1024 ** 2)} MB).`;
      // The C64 core can't run disks made for the Commodore 128; those boot to READY.
      else if (game.platform === 'Commodore 64' && tags.includes('C128')) knownIssue = 'Made for the Commodore 128, which the browser emulator here can\'t run.';
      else knownIssue = own(consoleIssues[game.platform] ?? {}, fileName) ?? null;
      versions.push({
        engine: 'emulatorjs',
        engineName: core.name,
        id: `${game.id}-${versions.length}`,
        label: romLabel(fileName, game.title, { alternate: rom.alternate }),
        // The discs of one release share a memory card (see the ROM route in index.js).
        discSet: discSetName(fileName),
        gameId: null,
        platform: game.platform,
        sounds: [{ driver: 'default', label: 'Standard' }],
        kind: romKind(tags, game.platform),
        regions: romRegions(tags),
        romRel: rom.rel,
        romAbs: info?.abs ?? null,
        romSize: info?.size ?? 0,
        knownIssue,
      });
    }
    // Two versions with the same name can't be told apart (nor their save states): add the file.
    const counts = new Map();
    for (const v of versions) counts.set(v.label, (counts.get(v.label) ?? 0) + 1);
    for (const v of versions) {
      if (counts.get(v.label) > 1) v.label = `${v.label} (${path.basename(v.romRel).replace(/\.[^.]+$/, '')})`;
    }
    return versions;
  }

  /**
   * An arcade game's versions: its own set, then the other sets LaunchBox lists with it (a
   * game's clones: other regions, revisions, bootlegs). Each is named from MAME's description
   * of the set ("World 920513") and ranked like a console release by the region it names.
   */
  #loadMameVersions(game) {
    const samplesDir = this.#mameSamplesDir(game);
    const roms = [{ rel: game.applicationRel }, ...(game.alternates ?? []).map((a) => ({ ...a, alternate: true }))]
      .filter((r) => r.rel && /\.(zip|7z)$/i.test(r.rel));
    const seen = new Set();
    const versions = [];
    for (const rom of roms) {
      const setName = setNameOf(rom.rel);
      if (seen.has(setName)) continue;
      seen.add(setName);
      const set = mameSets()[setName] ?? null;
      const romAbs = this.resolver.resolve(rom.rel);
      const files = set && romAbs ? mameFiles(setName, { romDir: path.dirname(romAbs), samplesDir }) : [];
      let knownIssue = !romAbs ? `The game file (${path.basename(rom.rel)}) wasn't found.` : mameIssue(setName, files, { maxBytes: this.maxMameBytes });
      if (!knownIssue && !this.mameBundleAvailable(set.bundle)) {
        knownIssue = 'The browser version of MAME for this game\'s hardware isn\'t installed. Run "npm run fetch-mame" on the server.';
      }
      versions.push({
        engine: 'mame',
        engineName: MAME_ENGINE_NAME,
        id: `${game.id}-${versions.length}`,
        label: arcadeLabel(set?.title, game.title),
        gameId: null,
        platform: game.platform,
        setName,
        bundle: set?.bundle ?? null,
        sounds: [{ driver: 'default', label: 'Standard' }],
        kind: arcadeKind(set?.title ?? path.basename(rom.rel), game.platform),
        regions: arcadeRegions(set?.title),
        files,
        romSize: files.reduce((n, f) => n + f.size, 0),
        knownIssue,
      });
    }
    // Two versions with the same name can't be told apart (nor their saves): add the set's name.
    const counts = new Map();
    for (const v of versions) counts.set(v.label, (counts.get(v.label) ?? 0) + 1);
    for (const v of versions) if (counts.get(v.label) > 1) v.label = `${v.label} (${v.setName})`;
    return versions;
  }

  /** MAME's samples folder, next to the mame.exe LaunchBox starts the game with. */
  #mameSamplesDir(game) {
    const exe = this.library.emulators?.get(game.emulatorId)?.applicationRel;
    return exe ? this.resolver.resolve(path.join(path.dirname(exe), 'samples')) : null;
  }

  /**
   * One of the files a MAME version loads, by its path in MAME's folders, or null: { abs } for a
   * file on disk, { zip, member } for one read out of a zip (an Apple IIgs game's disks).
   */
  mameFile(version, name) {
    return version?.engine === 'mame' ? version.files.find((f) => f.name === name && (f.abs || f.zip)) ?? null : null;
  }

  /**
   * What the MAME player page needs for an arcade version: the bundle to load, the set to start,
   * the files to put in MAME's folders first, and the game's screen and controls.
   */
  mameLaunch(game, version) {
    if (version.computer) return this.#mameComputerLaunch(game, version);
    if (!version.files.some((f) => f.abs)) {
      throw Object.assign(new Error(version.knownIssue ?? 'The game file wasn\'t found.'), { status: 404 });
    }
    // Not even to try: the page would load all of it into memory first (13 GB for a laserdisc).
    if (version.romSize > this.maxMameBytes) throw Object.assign(new Error(version.knownIssue), { status: 413 });
    const set = mameSets()[version.setName];
    return {
      engineName: MAME_ENGINE_NAME,
      bundle: version.bundle,
      setName: version.setName,
      // Names the game's settings, high scores and save states in the browser.
      gameName: `${version.label === game.title ? game.title : `${game.title} (${version.label})`} [${version.setName}]`,
      files: version.files.filter((f) => f.abs).map((f) => ({
        name: f.name,
        size: f.size,
        // BIOS sets, devices and samples load as the system files; the set's zip and disks as the game.
        system: f.name !== `roms/${version.setName}.zip` && !f.name.endsWith('.chd'),
        url: `${MAME_URL}/${encodeURIComponent(version.id)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
      })),
      screen: set?.screen ?? null,
      screens: set?.screens ?? 1,
      players: set?.players ?? 1,
      buttons: set?.buttons ?? 0,
      controls: set?.controls ?? [],
      savestate: set?.savestate !== 'unsupported',
    };
  }

  /**
   * What the MAME player page needs for a computer (an Apple IIgs game): the machine to start and
   * its options (its disks, see lib/iigs.js), and the files to put in MAME's folders first. The
   * whole keyboard is the computer's, so none of the arcade games' key layout is laid over it.
   */
  #mameComputerLaunch(game, version) {
    const missing = version.files.find((f) => !f.abs && !f.zip);
    if (version.knownIssue || missing) {
      throw Object.assign(new Error(version.knownIssue ?? 'One of the game\'s files wasn\'t found.'), { status: 404 });
    }
    return {
      engineName: MAME_ENGINE_NAME,
      bundle: version.bundle,
      setName: version.setName,
      computer: true,
      args: version.args,
      bram: version.bram ?? null,
      // A computer's settings, battery RAM and save states belong to the game, not to the machine.
      store: `${version.setName}/${version.id}`,
      gameName: `${version.label === 'Apple IIgs' ? game.title : `${game.title} (${version.label})`} [${version.setName}]`,
      files: version.files.map((f) => ({
        name: f.name,
        size: f.size,
        system: f.system,
        url: `${MAME_URL}/${encodeURIComponent(version.id)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
      })),
      screen: null,
      screens: 1,
      players: 1,
      buttons: 0,
      controls: ['keyboard', 'mouse'],
      savestate: true,
    };
  }

  /**
   * Where a ROM is and how big: kept for the life of the server (ROM files don't change),
   * except for missing ones, which are looked for again after the library reloads.
   */
  #romInfo(rel) {
    if (!this.roms.has(rel)) {
      const abs = this.resolver.resolve(rel);
      const stat = abs && fs.statSync(abs, { throwIfNoEntry: false });
      this.roms.set(rel, stat?.isFile() ? { abs, size: stat.size } : null);
    }
    return this.roms.get(rel);
  }

  /**
   * Where a BIOS file the cores ask for (by the name they use, see BIOS_FILES) is: RetroArch's
   * system folder first, then the ROM folders of the platforms that need it (the Neo Geo BIOS
   * set sits with the Neo Geo games). Null when it's nowhere.
   */
  biosPath(name) {
    const candidates = BIOS_FILES[name];
    if (!candidates) return null;
    const dirs = [];
    if (this.library.retroarchSystemDir) dirs.push(this.library.retroarchSystemDir);
    for (const [platform, core] of Object.entries(CORES)) {
      if (!Object.values(core.bios ?? {}).includes(name)) continue;
      const game = this.library.platforms.get(platform)?.games.find((g) => g.applicationRel);
      if (game) dirs.push(path.dirname(game.applicationRel));
    }
    for (const dir of dirs) {
      for (const file of candidates) {
        const abs = this.resolver.resolve(path.join(dir, file));
        if (abs) return abs;
      }
    }
    return null;
  }

  /**
   * Whether a console version's ROM is a CD archive the server unpacks before sending (see
   * romcache.js), and whether that's already been done.
   */
  #unpacks(version) {
    return Boolean(this.romCache?.available && version.romAbs && version.romSize <= this.maxRomBytes
      && worthUnpacking(version.romAbs, version.romSize, this.unpackMinBytes, { disc: Boolean(CORES[version.platform]?.disc) }));
  }

  /** The unpacked files of a version's CD archive (unpacking them the first time), or null. */
  async unpackedRom(version) {
    return this.#unpacks(version) ? this.romCache.unpacked(version.romAbs) : null;
  }

  /**
   * What the EmulatorJS player page needs for a console version: the core, where to fetch
   * the ROM (and BIOS), and whether the server still has to unpack the ROM first.
   */
  async emuLaunch(game, version) {
    const core = CORES[version.platform];
    if (!version.romAbs) throw Object.assign(new Error(version.knownIssue ?? 'The game file wasn\'t found.'), { status: 404 });
    const fileName = path.basename(version.romAbs);
    const unpacks = this.#unpacks(version);
    // An unpacked archive is sent as a plain zip of its files.
    const served = unpacks ? fileName.replace(/\.[^.]+$/, '.zip') : fileName;
    const biosName = biosNameFor(version.platform, version.regions);
    const bios = biosName && this.biosPath(biosName) ? biosName : null;
    return {
      core: core.core,
      coreName: core.name,
      // Names the game's save states in the browser; the platform keeps the same title on two
      // consoles (Aladdin on SNES and Genesis) apart.
      gameName: `${version.label === game.title ? game.title : `${game.title} (${version.label})`} [${version.platform}]`,
      // EmulatorJS works the system out from the core name, and gets it wrong when a core serves
      // several (Genesis Plus GX counts as Master System): the controls come from this instead.
      controlScheme: core.system,
      keyboard: Boolean(core.keyboard),
      // Core settings the platform needs (the Neo Geo's home-console mode), as starting values.
      coreOptions: core.options ?? {},
      // The platform's names for its buttons, where EmulatorJS doesn't know them.
      buttonNames: core.buttons ?? {},
      // Whether, and how, this game can be played with friends (see CORES), and the frame rate
      // rollback keeps time at.
      netplay: core.netplay ?? null,
      fps: frameRateFor(version.platform, version.regions),
      gameUrl: `${ROM_URL}/${encodeURIComponent(version.id)}/${encodeURIComponent(served)}`,
      // The page asks for this first when the archive hasn't been unpacked yet.
      prepareUrl: unpacks ? `/api/emu/${encodeURIComponent(version.id)}/prepare` : null,
      // A bare name: EmulatorJS stores a BIOS under the last part of its URL, which is where
      // the core looks for it. The page is at /emu/play.html, so it's fetched from /emu/<name>.
      biosUrl: bios,
      keepBiosZipped: Boolean(bios && core.keepBiosZipped),
    };
  }

  #exoIni(exoRoot) {
    if (!this.inis.has(exoRoot)) {
      const file = this.resolver.resolve(path.join(exoRoot, 'scmvm', 'scummvm.ini'));
      this.inis.set(exoRoot, file ? parseIni(fs.readFileSync(file, 'latin1')) : {});
    }
    return this.inis.get(exoRoot);
  }

  /** Every version of every loaded game. */
  allVersions() {
    for (const game of this.library.gamesById.values()) this.versionsFor(game);
    return [...this.versionsById.values()];
  }

  version(id) {
    this.#checkGeneration();
    if (!this.versionsById.has(id)) {
      const game = this.library.gamesById.get(id.replace(/-\d+$/, ''));
      if (game) this.versionsFor(game);
    }
    return this.versionsById.get(id) ?? null;
  }

  /**
   * A version's size without reading the disk, for the shelf: the zip, folder or ROM it's
   * made of is already known. `packed` marks a CD archive the server will unpack, whose real
   * size is about twice this. A ScummVM version's size means walking its folder (see
   * statsFor), which the shelf can't do for thousands of games, so it comes back as 0.
   */
  sizeOf(version) {
    if (version.engine === 'dosbox') return { bytes: (version.win3x ? version.dataBytes : version.zipSize) ?? 0 };
    if (version.engine === 'mame') return { bytes: version.romSize ?? 0 };
    if (version.engine !== 'emulatorjs') return { bytes: 0 };
    const cached = this.stats.get(version.id);
    if (cached) return { bytes: cached.totalBytes };
    return { bytes: version.romSize ?? 0, packed: this.#unpacks(version) };
  }

  /** Total and largest file size of a version's data. */
  async statsFor(version) {
    if (!this.stats.has(version.id)) {
      const acc = { totalBytes: 0, largestBytes: 0, largestFile: '' };
      if (version.engine === 'dosbox' && version.win3x) {
        acc.totalBytes = acc.largestBytes = version.dataBytes;
        acc.largestFile = version.gameDir ?? '';
      } else if (version.engine === 'dosbox') {
        acc.totalBytes = acc.largestBytes = version.zipSize;
        acc.largestFile = version.zipAbs ? path.basename(version.zipAbs) : '';
      } else if (version.engine === 'mame') {
        acc.totalBytes = version.romSize;
        for (const f of version.files) {
          if (f.size <= acc.largestBytes) continue;
          acc.largestBytes = f.size;
          acc.largestFile = path.basename(f.name);
        }
      } else if (version.engine === 'emulatorjs') {
        acc.totalBytes = acc.largestBytes = version.romSize;
        acc.largestFile = version.romAbs ? path.basename(version.romAbs) : '';
        // A CD archive the server unpacks is sent unpacked, about twice its size. Once that's
        // been done its real size is known; until then the size shown is the packed one.
        if (this.#unpacks(version)) {
          // Looking isn't using: a game page shown doesn't keep its unpacked copy from being trimmed.
          const manifest = await this.romCache.peek(version.romAbs, { touch: false });
          if (manifest) acc.totalBytes = acc.largestBytes = manifest.zipSize;
          else acc.packed = true;
        }
      } else {
        await walk(version.dir, async (file, size) => {
          acc.totalBytes += size;
          if (size > acc.largestBytes) {
            acc.largestBytes = size;
            acc.largestFile = path.relative(version.dir, file);
          }
        });
      }
      // A packed size is only until the archive is unpacked, so it isn't kept.
      if (acc.packed) return acc;
      this.stats.set(version.id, acc);
    }
    return this.stats.get(version.id);
  }

  mt32Dir(exoRoot) {
    return this.resolver.resolve(path.join(exoRoot, 'mt32'));
  }

  /**
   * The file names in eXo's mt32 folder. Every DOS and ScummVM launch asks, and the folder
   * (a handful of ROMs and a soundfont) doesn't change, so it's read once a minute at most.
   */
  #mt32Files(exoRoot) {
    const cached = this.mt32Listings.get(exoRoot);
    if (cached && Date.now() - cached.at < 60_000) return cached.names;
    const dir = this.mt32Dir(exoRoot);
    let names = [];
    try {
      names = dir ? fs.readdirSync(dir) : [];
    } catch {
      // A share that went away: no MIDI files this time, looked for again next minute.
    }
    this.mt32Listings.set(exoRoot, { at: Date.now(), names });
    return names;
  }

  /** The music choice a version starts with. */
  defaultSound(version) {
    if (version.engine === 'dosbox') return version.preferredSound ?? 'default';
    if (version.engine === 'emulatorjs' || version.engine === 'mame') return 'default';
    return defaultSound(version);
  }

  /**
   * Player URL (and, for ScummVM, its arguments) for one version and music choice.
   * `autoDetect` forces ScummVM's detection instead of the game ID.
   */
  launchFor(game, version, driver, { autoDetect = false } = {}) {
    const chosen = version.sounds.some((s) => s.driver === driver) ? driver : this.defaultSound(version);
    const query = new URLSearchParams({ title: game.title, version: version.label });
    if (version.engine === 'dosbox') {
      query.set('v', version.id);
      query.set('sound', chosen);
      return { engine: 'dosbox', engineName: ENGINE_NAMES.dosbox, sound: chosen, url: `/playdos.html?${query}` };
    }
    if (version.engine === 'emulatorjs') {
      query.set('v', version.id);
      return { engine: 'emulatorjs', engineName: version.engineName, sound: chosen, url: `/emu/play.html?${query}` };
    }
    if (version.engine === 'mame') {
      query.set('v', version.id);
      return { engine: 'mame', engineName: version.engineName, sound: chosen, url: `/mame/play.html?${query}` };
    }
    // A path in ScummVM's own file system, not a URL, so it goes as it is; the web build splits
    // its arguments on spaces, so a soundfont with one in its name can't be passed at all.
    const sf2 = this.#mt32Files(version.exoRoot).find((f) => /\.sf2$/i.test(f) && !/\s/.test(f));
    const args = webArguments(autoDetect ? { ...version, autoDetect: true } : version, chosen, {
      dataPath: `${GAMES_URL}/${version.id}`,
      mt32Path: MT32_URL,
      soundfont: sf2 ? `${MT32_URL}/${sf2}` : null,
    });
    return { engine: 'scummvm', engineName: ENGINE_NAMES.scummvm, args, sound: chosen, url: `/play.html?${query}#${encodeURI(args.join(' '))}` };
  }

  /**
   * What eXo's network.bat says about starting a game for two people (see lib/netbat.js), or
   * null when the game hasn't got one or it isn't one of eXo's usual ones. Read once per
   * version: it means opening the game's zip, which for a CD game is a big file to reach into.
   */
  async dosMultiplayer(version) {
    if (!version?.ipx || !version.zipAbs) return null;
    if (this.#netBats.has(version.id)) return this.#netBats.get(version.id);
    try {
      const text = await readZipText(version.zipAbs, (name) => /(^|\/)network\.bat$/i.test(name));
      const parsed = text ? parseNetworkBat(text) : null;
      this.#netBats.set(version.id, parsed);
      return parsed;
    } catch (err) {
      // Not kept: a share that blipped shouldn't turn off guided multiplayer until a restart.
      console.warn(`Couldn't read the network.bat in ${version.zipAbs}: ${err.message}`);
      return null;
    }
  }

  /**
   * What the DOSBox player page needs for a version: the rewritten conf, where to fetch the
   * zip, and extra files (MT-32 ROMs, soundfont) to place in the emulated file system.
   */
  async dosLaunch(version, driver, { backend = null, multiplayer = null } = {}) {
    if (version.win9x) return this.#win9xLaunch(version, driver);
    // "Try anyway" on a game whose files are missing: say so rather than fail on a null path.
    if (!version.zipAbs && !version.dataAbs) {
      throw Object.assign(new Error(version.knownIssue ?? 'The game\'s files weren\'t found.'), { status: 404 });
    }
    const sound = version.sounds.some((s) => s.driver === driver) ? driver : this.defaultSound(version);
    const sections = parseDosboxConf(await fsp.readFile(version.confAbs, 'latin1'));
    // The names in the bundle: a DOS game's zip as eXo packed it, a Windows game's installed
    // folder as the server packs it (the game folder at the root, where the conf mounts it).
    const ready = version.win3x ? await this.win3xBundle(version, { onlyIfReady: true }) : null;
    const entries = version.win3x
      ? ready?.files.map((f) => f.name)
        ?? (await (this.romCache?.listing(version.dataAbs, skipInBundle) ?? folderListing(version.dataAbs, skipInBundle))).files.map((f) => `${version.gameDir}/${f.rel}`)
      : await listZip(version.zipAbs);
    const fixPath = pathFixerFor(entries);
    const mt32Files = this.#mt32Files(version.exoRoot);
    const soundfont = mt32Files.find((f) => /\.sf2$/i.test(f)) ?? null;
    const files = [];
    if (sound === 'mt32') {
      for (const f of mt32Files.filter((f) => /\.rom$/i.test(f))) files.push({ path: `mt32/${f}`, url: `${MT32_URL}/${encodeURIComponent(f)}` });
    } else if (sound === 'fluidsynth' && soundfont) {
      files.push({ path: `mt32/${soundfont}`, url: `${MT32_URL}/${encodeURIComponent(soundfont)}` });
    }
    // Playing with a friend starts the game's multiplayer mode instead of its usual one.
    const together = multiplayer === 'host' || multiplayer === 'join' ? await this.dosMultiplayer(version) : null;
    const side = together?.[multiplayer] ?? null;
    return {
      conf: browserConf(sections, {
        sound,
        soundfont,
        fixPath,
        autoexec: side ? multiplayerAutoexec(sections.get('autoexec') ?? [], side.commands) : null,
      }),
      // What the player has to do in the game's own menus once it's up (eXo's own words), and
      // whether we could start its multiplayer mode for them at all.
      multiplayer: multiplayer ? { role: multiplayer, steps: side?.steps ?? [], guided: Boolean(side) } : null,
      // MIDI needs DOSBox-X's synthesizers; otherwise the configured backend (or a requested one).
      backend: MIDI_SOUNDS.has(sound) ? 'dosboxX' : (['dosbox', 'dosboxX'].includes(backend) ? backend : this.dosBackend),
      aspect: version.aspect,
      mouseLock: Boolean(version.mouseLock),
      bundleUrl: `${DOS_URL}/${version.id}/game.zip`,
      // A Windows game is sent uncompressed, so its bundle is about its folder's size; the
      // exact size is known once the server has made its copy.
      bundleSize: version.win3x ? (ready?.zipSize ?? version.dataBytes) : version.zipSize,
      // Windows games are copied into the server's cache first, which takes a while once.
      prepareUrl: version.win3x && !ready ? `/api/dos/${version.id}/prepare` : null,
      // Folders the player must create before unpacking the zip (see foldersNeededBefore).
      folders: foldersNeededBefore(entries),
      files,
      sound,
    };
  }

  // ---------- Windows 9x disks ----------

  /**
   * What the DOSBox player page needs for a Windows 9x version (see win9x.js): a conf that
   * boots eXo's Windows disk and the game's disk as sockdrives, and the CD images and zips to
   * load into memory, which the server unpacks from the game's zip first.
   */
  async #win9xLaunch(version, driver) {
    if (!version.zipAbs || !version.systemAbs || !version.gameDisk) {
      throw Object.assign(new Error(version.knownIssue ?? 'The game\'s files weren\'t found.'), { status: 404 });
    }
    const sound = version.sounds.some((s) => s.driver === driver) ? driver : this.defaultSound(version);
    const sections = parseDosboxConf(await fsp.readFile(version.confAbs, 'latin1'));
    const mounts = parseWin9xAutoexec(sections.get('autoexec') ?? []);
    if (!mounts) throw Object.assign(new Error('The game\'s launcher has changed and no longer starts Windows.'), { status: 404 });
    const bundle = await this.win9xBundle(version, { onlyIfReady: true });
    const fixPath = pathFixerFor(bundle ? bundle.files.map((f) => f.name) : await listZip(version.zipAbs));
    const urls = await this.#win9xDiskUrls(version);
    const soundfont = this.#mt32Files(version.exoRoot).find((f) => /\.sf2$/i.test(f)) ?? null;
    const files = sound === 'fluidsynth' && soundfont ? [{ path: `mt32/${soundfont}`, url: `${MT32_URL}/${encodeURIComponent(soundfont)}` }] : [];
    return {
      conf: win9xConf(sections, {
        mounts, systemUrl: `${ORIGIN_PLACEHOLDER}${urls.system}`, gameUrl: `${ORIGIN_PLACEHOLDER}${urls.game}`, sound, soundfont, fixPath,
      }),
      // The page puts its own origin here: the emulator only takes whole URLs for its disks.
      originPlaceholder: ORIGIN_PLACEHOLDER,
      backend: 'dosboxX',
      aspect: false,
      mouseLock: true,
      bundleUrl: `${DOS_URL}/${version.id}/game.zip`,
      bundleSize: bundle?.zipSize ?? version.dataBytes,
      prepareUrl: bundle ? null : `/api/dos/${version.id}/prepare`,
      folders: [],
      files,
      sound,
      // The one disk whose changes are kept between plays (the game's saves and settings, as on
      // eXo's own game disk); Windows' disk starts as eXo made it every time.
      keepDisk: urls.game,
    };
  }

  /**
   * A short stamp of a file as it is now: it changes when the file's size or date does, or the
   * `edition` of what the server changes in it on the way (see SYSTEM_DISK_EDITION).
   */
  async #fileStamp(abs, edition = '') {
    const stat = await fsp.stat(abs);
    return crypto.createHash('sha1').update(`${abs}|${stat.size}|${stat.mtimeMs}|${edition}`).digest('hex').slice(0, 16);
  }

  /**
   * The sockdrive URLs of a Windows 9x version's disks. eXo's Windows disk has one URL for every
   * game, so the pieces a browser keeps of it serve them all; the game's disk has its own. Both
   * change when the file behind them does, so kept pieces of an older copy are never used.
   */
  async #win9xDiskUrls(version) {
    const systemStamp = await this.#fileStamp(version.systemAbs, SYSTEM_DISK_EDITION);
    this.systemDisks.set(systemStamp, version.systemAbs);
    return {
      system: `${DISK_URL}/system/${systemStamp}`,
      game: `${DISK_URL}/game/${encodeURIComponent(version.id)}/${await this.#fileStamp(version.zipAbs)}`,
    };
  }

  /** eXo's Windows disk behind a system disk URL: { abs, stamp }, or null. */
  async systemDisk(stamp) {
    if (!this.systemDisks.has(stamp)) {
      // A browser that was playing before the server restarted: look through the disks the games use.
      const files = new Set(this.allVersions().filter((v) => v.win9x && v.systemAbs).map((v) => v.systemAbs));
      for (const abs of files) {
        const found = await this.#fileStamp(abs, SYSTEM_DISK_EDITION).catch(() => null);
        if (found) this.systemDisks.set(found, abs);
      }
    }
    const abs = this.systemDisks.get(stamp);
    return abs ? { abs, stamp, system: true } : null;
  }

  /**
   * A Windows 9x version's own disk, in the server's unpacked copy of its zip: { abs, stamp, dir },
   * or null when the stamp is of another copy of the zip or the zip hasn't been unpacked.
   */
  async gameDisk(version, stamp) {
    if (!version?.win9x || !version.gameDisk || !version.zipAbs) return null;
    // A boot asks for dozens of pieces of the disk; the zip and its unpacked copy are looked up
    // once a minute, not once a piece (the zip is on the slow games drive).
    const key = `${version.id}|${stamp}`;
    const known = this.gameDisks.get(key);
    if (known && Date.now() - known.at < 60_000) return known.disk;
    let disk = null;
    if (await this.#fileStamp(version.zipAbs).catch(() => null) === stamp) {
      const unpacked = await this.win9xUnpacked(version, { onlyIfReady: true });
      const abs = unpacked && PathResolver.within(unpacked.dir, version.gameDisk);
      if (abs) disk = { abs, stamp, dir: unpacked.dir };
    }
    for (const [k, entry] of this.gameDisks) if (Date.now() - entry.at >= 60_000) this.gameDisks.delete(k);
    if (disk) this.gameDisks.set(key, { at: Date.now(), disk });
    return disk;
  }
}

/**
 * A note for a ScummVM version whose CD music can't play in the browser: its CD audio tracks
 * are FLAC files, and the browser build of ScummVM plays Ogg Vorbis but not FLAC. The game
 * runs (after ScummVM says the tracks are missing), without its CD music. Null otherwise.
 */
export function cdAudioNote(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const flac = names.some((n) => /^track\d+\.flac$/i.test(n));
  const playable = names.some((n) => /^track\d+\.(ogg|mp3|wav)$/i.test(n));
  return flac && !playable ? 'No CD music in the browser: its CD tracks are FLAC, which the browser version of ScummVM can\'t play.' : null;
}

/**
 * The eXoDOS layout of a game's launcher: "<collection>\!dos\<GameDir>\<Game (Year)>.bat"
 * with the game zip in <collection>. Returns null for anything else.
 */
export function dosLayout(game) {
  // eXoWin9x has a year folder between "!win9x" and the game's folder (see win9x.js).
  const win9x = win9xLayout(game.applicationRel);
  if (win9x) return { ...win9x, win9x: true };
  const m = /^(.*)[\\/](![^\\/]+)[\\/]([^\\/]+)[\\/][^\\/]+\.bat$/i.exec(game.applicationRel ?? '');
  if (!m) return null;
  return {
    collection: m[1],
    exoRoot: path.dirname(m[1]),
    launcherDir: path.join(m[1], m[2], m[3]),
    gameDir: m[3],
  };
}

/** index.json content for a real folder: file sizes, and {} for sub-folders. */
export async function listingFor(dir) {
  const listing = {};
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'index.json' || entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) listing[entry.name] = {};
    else if (entry.isFile()) listing[entry.name] = (await fsp.stat(path.join(dir, entry.name))).size;
  }
  return listing;
}

/**
 * Handles a request below a virtual folder backed by `rootDir`: ".../index.json" returns
 * a listing, anything else a file. Returns false when the path doesn't exist.
 */
export async function serveTree(res, rootDir, segments) {
  const wantsIndex = segments.length === 0 || segments.at(-1) === 'index.json';
  const rel = (wantsIndex ? segments.slice(0, -1) : segments).join(path.sep);
  const target = PathResolver.within(rootDir, rel);
  if (!target) return false;
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat) return false;
  if (wantsIndex) {
    if (!stat.isDirectory()) return false;
    res.set('Cache-Control', 'no-cache').json(await listingFor(target));
    return true;
  }
  if (!stat.isFile()) return false;
  await new Promise((resolve, reject) => {
    res.sendFile(target, { dotfiles: 'allow', headers: { 'Cache-Control': 'private, max-age=86400' } }, (err) => {
      if (err && !res.headersSent) return reject(err);
      // Partway through (a network share dropping): end the connection so the file ends short
      // rather than leaving the browser waiting for the rest.
      if (err && !res.writableEnded) res.destroy();
      resolve();
    });
  });
  return true;
}

async function walk(dir, onFile) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, onFile);
    else if (entry.isFile()) await onFile(p, (await fsp.stat(p)).size);
  }
}
