import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readLaunchBoxXml, str, bool, num, list } from './xml.js';
import { dataJson } from './util.js';
import { MediaIndex } from './media.js';

const REFRESH_INTERVAL_MS = 5000;

/** Image "slots" and the Settings.xml key holding each slot's media-type priority. */
const IMAGE_SLOTS = {
  front: 'FrontImageTypePriorities',
  back: 'BackImageTypePriorities',
  background: 'BackgroundImageTypePriorities',
  screenshot: 'ScreenshotsImageTypePriorities',
  marquee: 'MarqueeImageTypePriorities',
  box3d: 'Box3dImageTypePriorities',
  cartFront: 'CartFrontImageTypePriorities',
};

const DEFAULT_PRIORITIES = {
  front: ['Box - Front', 'Box - Front - Reconstructed', 'Advertisement Flyer - Front'],
  back: ['Box - Back', 'Box - Back - Reconstructed'],
  background: ['Fanart - Background'],
  screenshot: ['Screenshot - Gameplay', 'Screenshot - Game Title'],
  marquee: ['Arcade - Marquee', 'Banner'],
  box3d: ['Box - 3D'],
  cartFront: ['Cart - Front', 'Disc'],
};

// A game's gameplay videos. LaunchBox's "Theme Video" (Videos\<platform>\Theme) is left out:
// it's the attract-mode clip a Big Box theme loops, not a video of the game to watch.
const VIDEO_TYPES = ['Video'];

// Data files every platform depends on; a change to one reloads everything.
const SHARED_FILES = ['Data\\Settings.xml', 'Data\\Platforms.xml', 'Data\\Parents.xml', 'Data\\Emulators.xml'];
const OPTIONAL_FILES = new Set(['Data\\Parents.xml', 'Data\\Emulators.xml']);

/**
 * Read-only view of a LaunchBox library. Loads the configured platforms, their
 * games and a media index, and reloads when the source XML changes on disk. Only the
 * platforms whose XML changed are read again: LaunchBox rewrites a platform's XML whenever
 * a game's play count changes, and reading every platform again takes many seconds.
 */
export class Library {
  /**
   * @param {object} config
   * @param {import('./paths.js').PathResolver} resolver
   */
  constructor(config, resolver) {
    this.config = config;
    this.resolver = resolver;
    this.platforms = new Map();
    this.gamesById = new Map();
    this.watched = new Map(); // abs xml path -> mtimeMs
    this.shared = null;       // what the shared data files said, and their mtimes
    this.lastCheck = 0;
    this.loading = null;
    this.generation = 0; // bumped on every (re)load so dependent caches know to refresh
    this.stamp = 0;      // numbers each platform build (platform.stamp), see webplay.js
    this.retroarchSystemDir = null; // RetroArch's BIOS folder, from Data\Emulators.xml
    this.emulators = new Map();     // emulator ID -> { title, applicationRel }, from Data\Emulators.xml
  }

  async load() {
    this.loading ??= this.#load().finally(() => { this.loading = null; });
    return this.loading;
  }

  async #load() {
    const started = Date.now();
    const watched = new Map();
    const mtimeOf = async (abs) => (await fsp.stat(abs)).mtimeMs;

    // Shared files: read again only when one of them changed (or on the first load).
    const sharedMtimes = new Map();
    for (const rel of SHARED_FILES) {
      const abs = this.resolver.resolve(rel);
      if (!abs) {
        if (OPTIONAL_FILES.has(rel)) {
          // Watched where it would be, like a platform's XML, so the file coming back is noticed.
          const primary = this.resolver.primary(rel);
          if (primary) watched.set(primary, null);
          continue;
        }
        throw new Error(`LaunchBox file not found: ${rel} (root: ${this.config.launchboxRoot})`);
      }
      const mtime = await mtimeOf(abs);
      sharedMtimes.set(abs, mtime);
      watched.set(abs, mtime);
    }
    const sharedSame = this.shared && sharedMtimes.size === this.shared.mtimes.size
      && [...sharedMtimes].every(([abs, m]) => this.shared.mtimes.get(abs) === m);
    // Kept apart until the whole load has worked: a reload that fails half-way mustn't leave
    // the next one believing platforms were built from the new shared files.
    const shared = sharedSame ? this.shared : { mtimes: sharedMtimes, ...(await this.#readShared()) };
    const { settings, platformsXml, categories, retroarchSystemDir, emulators } = shared;

    const platforms = new Map();
    const gamesById = new Map();
    let reread = 0;
    for (const name of this.config.platforms) {
      const xmlRel = path.join('Data', 'Platforms', `${name}.xml`);
      const xmlAbs = this.resolver.resolve(xmlRel);
      if (!xmlAbs) {
        // Watched where it would be, so the platform comes (back) as soon as the file does.
        const primary = this.resolver.primary(xmlRel);
        if (primary) watched.set(primary, null);
        // LaunchBox saving the file can leave it missing for a moment: a platform already
        // loaded stays as it was rather than vanishing from the shelf until the next change.
        const previous = this.platforms.get(name);
        if (previous) {
          platforms.set(name, previous);
          for (const g of previous.games) gamesById.set(g.id, g);
        } else {
          console.warn(`Skipping platform "${name}": LaunchBox has no Data\\Platforms\\${name}.xml`);
        }
        continue;
      }
      const mtime = await mtimeOf(xmlAbs);
      watched.set(xmlAbs, mtime);
      const previous = this.platforms.get(name);
      let platform = sharedSame && previous?.xmlMtime === mtime ? previous : null;
      if (!platform) {
        platform = await this.#buildPlatform(name, xmlAbs, mtime, { settings, platformsXml, categories });
        reread++;
      }
      platforms.set(name, platform);
      for (const g of platform.games) gamesById.set(g.id, g);
    }

    this.platforms = platforms;
    this.gamesById = gamesById;
    this.watched = watched;
    this.shared = shared;
    this.settings = settings;
    this.retroarchSystemDir = retroarchSystemDir;
    this.emulators = emulators;
    this.generation++;
    this.lastCheck = Date.now();
    const count = [...platforms.values()].reduce((n, p) => n + p.games.length, 0);
    console.log(`Library loaded: ${count} games across ${platforms.size} platform(s)`
      + `${reread < platforms.size ? ` (${reread} read again)` : ''} in ${Date.now() - started} ms`);
  }

  /** Settings, platform definitions, platform categories and RetroArch's BIOS folder. */
  async #readShared() {
    const xml = async (rel) => {
      const abs = this.resolver.resolve(rel);
      return abs ? readLaunchBoxXml(abs) : {};
    };
    const settingsXml = await xml('Data\\Settings.xml');
    const platformsXml = await xml('Data\\Platforms.xml');
    // Parents.xml files each platform under a category: Consoles, Computers, Arcade…
    const categories = new Map();
    for (const p of (await xml('Data\\Parents.xml')).Parent ?? []) {
      const platform = str(p.PlatformName);
      const category = str(p.ParentPlatformCategoryName);
      if (platform && category) categories.set(platform, category);
    }
    const emulatorList = (await xml('Data\\Emulators.xml')).Emulator ?? [];
    // Which program each emulator starts: a game names its emulator by ID (MAME's arcade games).
    const emulators = new Map(emulatorList.filter((e) => str(e.ID))
      .map((e) => [str(e.ID), { title: str(e.Title), applicationRel: str(e.ApplicationPath) }]));
    // RetroArch's system folder holds the BIOS files console emulators need.
    const retroarch = emulatorList
      .find((e) => /retroarch/i.test(str(e.Title)) || /retroarch\.exe$/i.test(str(e.ApplicationPath)));
    const retroarchSystemDir = retroarch ? path.join(path.dirname(str(retroarch.ApplicationPath)), 'system') : null;
    return { settings: parseSettings(settingsXml.Settings ?? {}), platformsXml, categories, retroarchSystemDir, emulators };
  }

  async #buildPlatform(name, xmlAbs, xmlMtime, { settings, platformsXml, categories }) {
    const def = (platformsXml.Platform ?? []).find((p) => str(p.Name) === name);
    const folders = (platformsXml.PlatformFolder ?? [])
      .filter((f) => str(f.Platform) === name)
      .map((f) => ({ mediaType: str(f.MediaType), folderPath: str(f.FolderPath) }));
    const media = await new MediaIndex(folders, this.resolver).build();
    const games = buildGames(await readLaunchBoxXml(xmlAbs), name, { media, settings, resolver: this.resolver });
    const logo = await platformLogo(this.resolver, name);
    return {
      name,
      logoRel: logo.rel,
      logoTrim: logo.trim,
      iconRel: platformIcon(this.resolver, name),
      notes: str(def?.Notes),
      category: str(def?.Category) || categories.get(name) || '',
      releaseDate: str(def?.ReleaseDate),
      developer: str(def?.Developer),
      manufacturer: str(def?.Manufacturer),
      // The hardware LaunchBox describes for a platform, which the shelf lists beside its logo.
      // A platform that's software (ScummVM) leaves some of these empty.
      specs: {
        cpu: str(def?.Cpu),
        memory: str(def?.Memory),
        graphics: str(def?.Graphics),
        sound: str(def?.Sound),
        display: str(def?.Display),
        media: str(def?.Media),
        controllers: str(def?.MaxControllers),
      },
      games,
      media,
      xmlMtime,
      stamp: ++this.stamp,
    };
  }

  /**
   * Reloads if any source XML changed since the last load (checked at most every few seconds).
   * Once there's a library, a reload happens in the background: LaunchBox rewrites a platform's
   * XML whenever a game is played, and reading it again takes seconds, which every request would
   * otherwise spend waiting. They're answered from the library as it was until the new one is
   * ready. (To wait for a background reload anyway, await `loading` afterwards.)
   */
  async refreshIfChanged() {
    if (this.loading) return this.generation ? undefined : this.loading;
    if (Date.now() - this.lastCheck < REFRESH_INTERVAL_MS) return;
    this.lastCheck = Date.now();
    for (const [file, mtime] of this.watched) {
      const current = await fsp.stat(file).then((s) => s.mtimeMs, () => null);
      if (current !== mtime) {
        console.log(`Change detected in ${path.basename(file)}; reloading`);
        const reload = this.load();
        if (!this.generation) return reload;
        // A reload that fails keeps the library as it was, and is tried again at the next check.
        reload.catch((err) => console.warn(`Reloading the library failed, keeping the one loaded: ${err.message}`));
        return;
      }
    }
  }
}

const LOGO_EXT = /\.(png|jpe?g|gif|webp)$/i;

// Where LaunchBox keeps a platform's icon or logo under another name (server/data/platform-art.json).
const ART = dataJson('platform-art.json');

/**
 * A platform's own logo, which the shelf puts at the top of that platform's view: the file in
 * LaunchBox's "Images\Platforms\<platform>\Clear Logo", or else one listed for it in
 * platform-art.json, which has room around it to trim (`trim`). A platform with neither shows
 * its name as text instead.
 */
async function platformLogo(resolver, name) {
  const rel = path.join('Images', 'Platforms', name, 'Clear Logo');
  const abs = resolver.resolve(rel);
  const files = abs ? (await fsp.readdir(abs).catch(() => [])).filter((f) => LOGO_EXT.test(f)) : [];
  // Usually one file, named after the platform; take that one when there are several.
  const file = files.find((f) => f.replace(LOGO_EXT, '').toLowerCase() === name.toLowerCase()) ?? files[0];
  if (file) return { rel: path.join(rel, file), trim: false };
  const other = ART.logos[name];
  return other && resolver.resolve(other) ? { rel: other, trim: true } : { rel: '', trim: false };
}

/**
 * A platform's icon from LaunchBox's own set ("Images\Platform Icons\Platforms"), a small
 * picture of the machine that the sidebar lists it by, or '' when the set has none.
 */
function platformIcon(resolver, name) {
  const rel = path.join('Images', 'Platform Icons', 'Platforms', `${ART.icons[name] ?? name}.png`);
  return resolver.resolve(rel) ? rel : '';
}

function parseSettings(s) {
  const csv = (v) => str(v).split(',').map((x) => x.trim()).filter(Boolean);
  const priorities = {};
  for (const [slot, key] of Object.entries(IMAGE_SLOTS)) {
    const fromSettings = csv(s[key]);
    priorities[slot] = fromSettings.length ? fromSettings : DEFAULT_PRIORITIES[slot];
  }
  return { imagePriorities: priorities, regionPriorities: csv(s.RegionPriorities) };
}

function buildGames(xml, platform, { media, settings, resolver }) {
  const extrasByGame = groupBy(xml.AdditionalApplication ?? [], (a) => str(a.GameID));
  const altNamesByGame = groupBy(xml.AlternateName ?? [], (a) => str(a.GameID));
  const installed = installedDetector(resolver);

  return (xml.Game ?? []).map((g) => {
    const id = str(g.ID);
    const title = str(g.Title);
    const region = str(g.Region);
    const releaseDate = str(g.ReleaseDate);
    const year = /^\d{4}/.test(releaseDate) ? Number(releaseDate.slice(0, 4)) : null;

    // Every media type with at least one file for this game, best file first.
    const images = {};
    for (const type of media.mediaTypes) {
      const found = media.find(type, title, { gameRegion: region, regionPriorities: settings.regionPriorities, gameYear: year });
      if (found.length) images[type] = found.map((f) => ({ rel: f.rel, region: f.region }));
    }

    const apps = (extrasByGame.get(id) ?? [])
      .map((a) => ({
        id: str(a.Id),
        name: str(a.Name),
        rel: str(a.ApplicationPath),
        ext: path.extname(str(a.ApplicationPath)).toLowerCase().slice(1),
        priority: num(a.Priority) ?? 0,
        // Console games list their other regional releases as additional applications that
        // run in the emulator ("Play (Japan) Version..."); those are versions, not extras.
        playable: bool(a.UseEmulator),
        region: str(a.Region),
      }))
      .filter((a) => a.id && a.rel)
      .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    // Only documents and media, like the files in an Extras folder: eXo lists launchers
    // ("Alternate Launcher.bat") here too. Some games list the same file twice.
    const seen = new Set();
    const extras = apps
      .filter((a) => !a.playable && EXTRA_EXTS.has(a.ext))
      .filter((a) => !seen.has(a.rel.toLowerCase()) && seen.add(a.rel.toLowerCase()))
      .map(({ playable, region: _, ...extra }) => extra);
    const alternates = apps.filter((a) => a.playable).map(({ id: appId, name, rel, region: appRegion }) => ({ id: appId, name, rel, region: appRegion }));

    const rootFolder = str(g.RootFolder);

    return {
      id,
      platform,
      title,
      sortTitle: str(g.SortTitle) || title,
      alternateNames: (altNamesByGame.get(id) ?? []).map((a) => str(a.Name)).filter(Boolean),
      releaseDate,
      year,
      developer: str(g.Developer),
      publisher: str(g.Publisher),
      genres: list(g.Genre),
      series: list(g.Series),
      playModes: list(g.PlayMode),
      maxPlayers: num(g.MaxPlayers),
      esrb: str(g.Rating),
      source: str(g.Source),
      releaseType: str(g.ReleaseType),
      region,
      communityRating: num(g.CommunityStarRating),
      communityVotes: num(g.CommunityStarRatingTotalVotes),
      starRating: num(g.StarRatingFloat) || num(g.StarRating) || 0,
      favorite: bool(g.Favorite),
      completed: bool(g.Completed),
      broken: bool(g.Broken),
      hidden: bool(g.Hide),
      playCount: num(g.PlayCount) ?? 0,
      playTime: num(g.PlayTime) ?? 0,
      lastPlayed: str(g.LastPlayedDate) || null,
      dateAdded: str(g.DateAdded) || null,
      notes: str(g.Notes),
      databaseId: num(g.DatabaseID),
      manualRel: existingRel(resolver, str(g.ManualPath)),
      musicRel: existingRel(resolver, str(g.MusicPath)),
      applicationRel: str(g.ApplicationPath),
      emulatorId: str(g.Emulator) || null,
      configurationRel: str(g.ConfigurationPath),
      rootFolder,
      installed: installed(rootFolder),
      images,
      slots: pickSlots(images, settings.imagePriorities),
      videos: VIDEO_TYPES.flatMap((t) => images[t] ?? []),
      extras,
      alternates,
    };
  });
}

/** The media type of a game's main picture, the one its shelf tile shows, or null when it has none. */
export const coverType = (game) => game.slots.front ?? game.slots.box3d ?? game.slots.screenshot ?? null;

/** First media type per slot that this game actually has, per the user's priorities. */
function pickSlots(images, priorities) {
  const slots = {};
  for (const [slot, types] of Object.entries(priorities)) {
    const type = types.find((t) => images[t]?.length);
    if (type) slots[slot] = type;
  }
  if (images['Clear Logo']?.length) slots.clearLogo = 'Clear Logo';
  return slots;
}

function existingRel(resolver, rel) {
  return rel && resolver.resolve(rel) ? rel : '';
}

/**
 * eXo collections keep launchers in "<Collection>\!<Name>\<Game>" and unpack game data
 * to "<Collection>\<Game>". Returns a function giving true/false for a game's root folder,
 * or null when the layout isn't recognised. Each collection folder is listed once: some
 * collections have thousands of games on a network share.
 */
function installedDetector(resolver) {
  const listings = new Map(); // collection rel path -> Set of lower-cased folder names
  return (rootFolder) => {
    const m = /^(.*)[\\/]![^\\/]+[\\/]([^\\/]+)$/.exec(rootFolder);
    if (!m) return null;
    if (!listings.has(m[1])) {
      const abs = resolver.resolve(m[1]);
      let names = new Set();
      try {
        names = new Set(fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name.toLowerCase()));
      } catch {
        // Unreadable collection folder: nothing is installed.
      }
      listings.set(m[1], names);
    }
    return listings.get(m[1]).has(m[2].toLowerCase());
  };
}

const EXTRA_EXTS = new Set(['pdf', 'txt', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'mp3', 'ogg', 'mp4', 'webm', 'htm', 'html', 'doc', 'rtf']);

const FOLDER_EXTRA = 'folder:'; // id prefix of extras found in a game's Extras folder

/**
 * A game's extras with the files named in its "Extras" folder after the ones LaunchBox
 * lists, dropping any earlier folder extras. eXoDOS lists them there instead of as LaunchBox
 * additional applications. Launchers (.bat) and such are skipped, and so are files LaunchBox
 * already lists. Pass file names only, not sub-folders.
 */
function withFolderExtras(game, fileNames) {
  const listed = game.extras.filter((e) => !e.id.startsWith(FOLDER_EXTRA));
  const known = new Set(listed.map((e) => path.basename(e.rel).toLowerCase()));
  const rel = path.join(game.rootFolder, 'Extras');
  const found = [];
  for (const name of fileNames) {
    const ext = path.extname(name).slice(1).toLowerCase();
    if (!EXTRA_EXTS.has(ext) || known.has(name.toLowerCase())) continue;
    found.push({ id: `${FOLDER_EXTRA}${name}`, name: name.slice(0, -ext.length - 1), rel: path.join(rel, name), ext, priority: 1000 });
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return [...listed, ...found];
}

/**
 * Sets a game's extras from the file names in its "Extras" folder (see withFolderExtras).
 * The DOS launcher index does this for every game it knows, so their shelf summaries list
 * the folder's files too.
 */
export function setFolderExtras(game, fileNames) {
  game.extras = withFolderExtras(game, fileNames);
  game.folderExtrasLoaded = true;
  return game.extras;
}

/**
 * A game's extras with the files in its "Extras" folder. Games filled in from the DOS
 * launcher index already have them. For the rest the folder is read once per game record (reading
 * its platform's XML again makes new records, which read it again), and what it holds is kept apart from game.extras: the
 * shelf summary of a game stays the same whether or not its page has been opened.
 */
export async function folderExtras(resolver, game) {
  if (game.folderExtrasLoaded) return game.extras;
  // Requests that come in meanwhile wait for the same read.
  game.folderFiles ??= (async () => {
    const abs = game.rootFolder && resolver.resolve(path.join(game.rootFolder, 'Extras'));
    const entries = abs ? await fsp.readdir(abs, { withFileTypes: true }).catch(() => []) : [];
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  })();
  const names = await game.folderFiles;
  // The DOS index may have filled the extras in while the folder was read.
  return game.folderExtrasLoaded ? game.extras : withFolderExtras(game, names);
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}
