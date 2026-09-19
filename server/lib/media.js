import fs from 'node:fs/promises';
import path from 'node:path';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v', '.flv', '.wmv']);

/**
 * LaunchBox's media file naming: the game title with characters that are invalid in
 * Windows file names (plus the apostrophe) replaced by underscores.
 */
export function sanitizeTitle(title) {
  return title.replace(/[\\/:*?"<>|']/g, '_');
}

const titleKey = (title) => sanitizeTitle(title).toLowerCase();

/**
 * A media key without a year in brackets at the end of it. eXoDOS names its videos
 * "Wolfenstein 3D (1992).mp4" rather than the "Wolfenstein 3D.mp4" LaunchBox looks for, and
 * its year is its own: it says 1995 for a game LaunchBox dates to 1994. Dropping the year from
 * both sides matches them anyway — it takes the MS-DOS videos from 100 games to 2,760.
 */
const YEAR_SUFFIX = /\s*\((?:1[89]|20)\d\d\)\s*$/;
const looseKey = (key) => key.replace(YEAR_SUFFIX, '').trim();
const yearIn = (key) => key.match(YEAR_SUFFIX)?.[0].replace(/\D/g, '') ?? null;

/**
 * Of files that share a name bar the year they carry, the ones belonging to the game asked
 * for: those of the year nearest its own. One game can have several files of the same year
 * (screenshot 1, screenshot 2), so it's the whole year that's kept, not one file. With no
 * year to go on, or only one year among them, they all belong to the same game.
 *
 * Nearest, with no limit on how far: where one file has to serve two games of the same name
 * there is nothing to tell them apart by, and the years are too unreliable to refuse a match
 * on. Nearly every match here is within a year, but the far ones are mostly a game whose date
 * is simply disputed (Softporn Adventure is filed under 1981 and its video under 1991), so a
 * cut-off would lose more right answers than wrong ones.
 */
function nearestYear(files, gameYear) {
  const years = new Set(files.map((f) => f.year).filter(Boolean));
  if (!gameYear || years.size < 2) return files;
  const nearest = [...years].reduce((a, b) => (Math.abs(a - gameYear) <= Math.abs(b - gameYear) ? a : b));
  return files.filter((f) => f.year === nearest);
}

/** Splits "Some Title-02.png" into { key: "some title", seq: 2 }. */
export function parseMediaFileName(fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, -ext.length || undefined);
  const m = /^(.*)-(\d{2,3})$/.exec(base);
  return m
    ? { key: m[1].toLowerCase(), seq: Number(m[2]), ext: ext.toLowerCase() }
    : { key: base.toLowerCase(), seq: 0, ext: ext.toLowerCase() };
}

/**
 * Index of media files for one platform, keyed by media type then by title.
 * Built from the platform's PlatformFolder mappings in Data\Platforms.xml.
 */
export class MediaIndex {
  /**
   * @param {Array<{mediaType: string, folderPath: string}>} folders
   * @param {import('./paths.js').PathResolver} resolver
   */
  constructor(folders, resolver) {
    this.folders = folders;
    this.resolver = resolver;
    /** @type {Map<string, Map<string, Array<{rel: string, region: string|null, seq: number, ext: string}>>>} */
    this.byType = new Map();
    // The same files under their name without a trailing year, for the ones named that way.
    /** @type {Map<string, Map<string, Array<object>>>} */
    this.looseByType = new Map();
  }

  async build() {
    // A mapped folder can sit inside another (Videos\ScummVM\Theme inside Videos\ScummVM);
    // don't count the inner folder's files as the outer type's region.
    const mapped = new Set(this.folders.map((f) => path.normalize(f.folderPath).toLowerCase()));
    await Promise.all(this.folders.map((f) => this.#indexFolder(f, mapped)));
    return this;
  }

  async #indexFolder({ mediaType, folderPath }, mapped) {
    const abs = this.resolver.resolve(folderPath);
    const entries = new Map();
    const loose = new Map();
    this.byType.set(mediaType, entries);
    this.looseByType.set(mediaType, loose);
    if (!abs) return;

    const allowed = mediaType.toLowerCase().includes('video') ? VIDEO_EXT : IMAGE_EXT;
    const add = (fileName, relDir, region) => {
      const info = parseMediaFileName(fileName);
      if (!allowed.has(info.ext)) return;
      const file = { rel: path.join(relDir, fileName), region, seq: info.seq, ext: info.ext, year: yearIn(info.key) };
      entries.set(info.key, [...(entries.get(info.key) ?? []), file]);
      // Only files that carry a year go in the loose index; everything else is already
      // findable by its own name, and putting it in twice would only cost memory.
      const bare = looseKey(info.key);
      if (bare !== info.key) loose.set(bare, [...(loose.get(bare) ?? []), file]);
    };

    for (const dirent of await readdirSafe(abs)) {
      if (dirent.isFile()) {
        add(dirent.name, folderPath, null);
      } else if (dirent.isDirectory()) {
        const relDir = path.join(folderPath, dirent.name);
        if (mapped.has(path.normalize(relDir).toLowerCase())) continue;
        for (const sub of await readdirSafe(path.join(abs, dirent.name))) {
          if (sub.isFile()) add(sub.name, relDir, dirent.name);
        }
      }
    }
  }

  /**
   * Media of one type for a title, best first: the game's own region, then the
   * user's region priorities, then un-regioned files, then everything else.
   *
   * A title nothing is filed under is looked for again among the files named with a year
   * after them (see looseKey). Games do share a name ("Pac-Man", "Prince of Persia"), and
   * each one's files carry its own year, so only the files of the nearest year are kept —
   * otherwise one game would take another's pictures, and say it had twice as many videos as
   * it has. Nearest rather than equal because eXo's year is its own: it says 1995 for a game
   * LaunchBox dates to 1994.
   */
  find(mediaType, title, { gameRegion = '', regionPriorities = [], gameYear = null } = {}) {
    const key = titleKey(title);
    let list = this.byType.get(mediaType)?.get(key);
    // A title that ends in a number after a dash ("F-15", "Area-51") reads like a file's
    // sequence number when its file has none of its own ("F-15.mp4" is filed under "f", 15).
    const numbered = !list && /^(.*)-(\d{2,3})$/.exec(key);
    if (numbered) {
      const seq = Number(numbered[2]);
      const found = this.byType.get(mediaType)?.get(numbered[1])?.filter((f) => f.seq === seq);
      if (found?.length) list = found.map((f) => ({ ...f, seq: 0 }));
    }
    if (!list) {
      const loose = this.looseByType.get(mediaType)?.get(looseKey(titleKey(title)));
      if (!loose) return [];
      list = nearestYear(loose, gameYear);
    }
    const order = [gameRegion, ...regionPriorities].filter(Boolean).map((r) => r.toLowerCase());
    const rank = (region) => {
      if (region == null) return order.length;
      const i = order.indexOf(region.toLowerCase());
      return i === -1 ? order.length + 1 : i;
    };
    return [...list].sort((a, b) =>
      rank(a.region) - rank(b.region)
      || (a.region ?? '').localeCompare(b.region ?? '')
      || a.seq - b.seq
      || a.ext.localeCompare(b.ext));
  }

  get mediaTypes() {
    return [...this.byType.keys()];
  }
}

async function readdirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
