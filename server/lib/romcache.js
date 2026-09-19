// Faster starts for disc-based console games.
//
// LaunchBox keeps CD games (PlayStation, Sega CD) as .7z archives of a few hundred MB, and
// Saturn games as zips of about the same size. EmulatorJS can unpack those in the browser, but
// a .7z takes about a minute every time, and either holds the archive and its tracks in memory. So
// the server unpacks an archive once, with the 7-Zip that ships with LaunchBox, into cache/,
// and hands the browser the same files as an uncompressed ("stored") zip, which EmulatorJS
// opens in a second or two. The cache is trimmed to a size limit, least recently used first.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { renameWhenFree } from './util.js';

const MANIFEST = 'manifest.json';
const MAX_ZIP32 = 0xffffffff;
const MAX_ZIP32_ENTRIES = 0xffff;
const DOS_DATE = 0x0021;
// The archive formats unpacked here: console CD archives, and eXoWin9x's game zips (whose hard
// disk has to be read in pieces, which a compressed zip can't give). 7-Zip reads many more,
// whatever the file is called; an archive that turns out to be something else isn't worth the risk.
const ARCHIVE_TYPES = new Set(['7z', 'rar', 'rar5', 'zip']);
// The oldest 7-Zip trusted with archives from the collection: 25.00 fixed links inside a zip
// writing outside the folder being unpacked into (CVE-2025-11001, CVE-2025-11002).
const MIN_SEVEN_ZIP = [25, 0];
const LIST_TIMEOUT_MS = 2 * 60 * 1000;
// Unpacking a large CD image from the slow games drive takes minutes; one that takes this
// long is stuck (on a network share that went away, say), and holds a job slot until killed.
const UNPACK_TIMEOUT_MS = 30 * 60 * 1000;
// How long a game folder's listing is trusted. eXo's installs don't change while being played;
// one that does is noticed (and copied again) a few minutes later.
const LISTING_TTL_MS = 5 * 60 * 1000;

// Cache folders being read right now (a zip on its way to a browser, a download being packed),
// with how many readers each has. trim() leaves these alone. See holdCacheDir.
const busy = new Map();

/**
 * Marks a cache folder as being read, so trim() doesn't delete it meanwhile. Returns the
 * function that says reading is done.
 */
export function holdCacheDir(dir) {
  busy.set(dir, (busy.get(dir) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = busy.get(dir) - 1;
    if (left > 0) busy.set(dir, left);
    else busy.delete(dir);
  };
}

/**
 * Whether an archive is worth unpacking on the server (the browser handles small ones fine).
 * A zip is only when it holds a CD (`disc`): other zips go to the core as they are.
 */
export const worthUnpacking = (file, size, minBytes, { disc = false } = {}) =>
  (disc ? /\.(7z|rar|zip)$/i : /\.(7z|rar)$/i).test(file) && size >= minBytes;

export class RomCache {
  /**
   * @param {{ dir: string, sevenZip: string|null, maxBytes: number }} options
   *   `sevenZip` is the path to 7z.exe; without it nothing is unpacked.
   */
  constructor({ dir, sevenZip, maxBytes, maxJobs = 2 }) {
    this.dir = dir;
    this.sevenZip = sevenZip;
    this.maxBytes = maxBytes;
    this.jobs = new Map(); // key -> promise of manifest
    // Unpacks run a few at a time: each writes hundreds of MB, and several at once only
    // compete for the same disk.
    this.maxJobs = maxJobs;
    this.running = 0;
    this.waiting = [];
    this.cleaned = null;
    // Archives and folders already found too big to serve as a plain zip, by cache key (which
    // changes when they do), so asking again doesn't copy or unpack them all over again.
    this.refused = new Set();
    this.sevenZipChecked = null;
    this.sevenZipFound = null;
    this.listings = new Map(); // installed game folder -> { at, skip, promise } (see listing)
  }

  /**
   * The files of an installed game folder (see folderListing), kept for a few minutes. Starting
   * a Windows game asks several times over (what the player needs, the copy, the zip), and each
   * walk of a folder of a few thousand files on the slow games drive takes seconds.
   */
  listing(source, skip = () => false) {
    // Listings past their time go, so the ones kept are only of games played lately.
    for (const [key, entry] of this.listings) if (Date.now() - entry.at >= LISTING_TTL_MS) this.listings.delete(key);
    const cached = this.listings.get(source);
    if (cached && cached.skip === skip && Date.now() - cached.at < LISTING_TTL_MS) return cached.promise;
    const promise = folderListing(source, skip);
    this.listings.set(source, { at: Date.now(), skip, promise });
    promise.catch(() => this.listings.delete(source));
    return promise;
  }

  /** The biggest set of files served whole from here: what the zip format holds, and what the cache does. */
  get #limit() {
    return Math.min(MAX_ZIP32, this.maxBytes);
  }

  /**
   * Checks once that 7-Zip is recent enough to trust (see MIN_SEVEN_ZIP); rejects when it isn't,
   * and the browser unpacks the archive itself instead.
   */
  #checkSevenZip() {
    this.sevenZipChecked ??= run(this.sevenZip, ['i'], { timeoutMs: LIST_TIMEOUT_MS, output: true }).then((text) => {
      const m = /7-Zip(?: \(a\))? (\d+)\.(\d+)/.exec(text);
      const version = m ? [Number(m[1]), Number(m[2])] : null;
      if (!version || version[0] < MIN_SEVEN_ZIP[0] || (version[0] === MIN_SEVEN_ZIP[0] && version[1] < MIN_SEVEN_ZIP[1])) {
        throw new Error(`${this.sevenZip} is 7-Zip ${version ? version.join('.') : '(unknown version)'}; archives are only unpacked on the server with ${MIN_SEVEN_ZIP.join('.')} or later.`);
      }
    });
    return this.sevenZipChecked;
  }

  /**
   * Removes unpack folders a stopped or crashed server left half-written ("<key>.<pid>.tmp"):
   * they're never finished, and trim() doesn't count them. Done once, before the first unpack.
   */
  #cleanStale() {
    this.cleaned ??= (async () => {
      const mine = `.${process.pid}.tmp`;
      for (const name of await fsp.readdir(this.dir).catch(() => [])) {
        if (name.endsWith('.tmp') && !name.endsWith(mine)) {
          await fsp.rm(path.join(this.dir, name), { recursive: true, force: true }).catch(() => {});
        }
      }
    })();
    return this.cleaned;
  }

  /** Runs `job` when fewer than maxJobs unpacks are running. */
  async #slot(job) {
    if (this.running >= this.maxJobs) await new Promise((resolve) => this.waiting.push(resolve));
    this.running++;
    try {
      return await job();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** Whether there's a 7-Zip to unpack with. Looked for once: the game lists ask for every console game. */
  get available() {
    this.sevenZipFound ??= Boolean(this.sevenZip && fs.existsSync(this.sevenZip));
    return this.sevenZipFound;
  }

  /** Starts `work` for a cache key, or joins the one already running; a null result is remembered. */
  #job(key, work) {
    if (!this.jobs.has(key)) {
      const job = this.#cleanStale()
        .then(() => this.#slot(work))
        .then((manifest) => {
          if (!manifest) this.refused.add(key);
          return manifest;
        });
      this.jobs.set(key, job.finally(() => this.jobs.delete(key)));
    }
    return this.jobs.get(key);
  }

  /** Cache folder name for an installed game folder: changes when anything in it does. */
  static folderKey(source, top, listing) {
    return crypto.createHash('sha1')
      // Empty folders change the key only when there are some: copies of games without any stay current.
      .update(`folder3|${source}|${top}|${listing.files.length}|${listing.totalBytes}|${listing.newest}${listing.emptyDirs?.length ? `|${listing.emptyDirs.length}` : ''}`)
      .digest('hex').slice(0, 20);
  }

  /** Cache folder name for an archive: changes when the archive does. */
  static key(archive, stat) {
    return crypto.createHash('sha1').update(`${archive}|${stat.size}|${stat.mtimeMs}`).digest('hex').slice(0, 20);
  }

  /**
   * An archive that's already unpacked ({ dir, files, zipSize }, as unpacked() gives), or null.
   * Never unpacks, but marks it recently used unless `touch` is false: a Windows 9x game is only
   * ever looked up this way once unpacked (its launch, its zip, its hard disk), and trim() would
   * otherwise take the one played every day for the oldest.
   */
  async peek(archive, { touch = true } = {}) {
    const stat = await fsp.stat(archive).catch(() => null);
    if (!stat) return null;
    const dir = path.join(this.dir, RomCache.key(archive, stat));
    const manifestFile = path.join(dir, MANIFEST);
    try {
      const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
      if (touch) {
        const now = new Date();
        await fsp.utimes(manifestFile, now, now).catch(() => {});
      }
      return { dir, ...manifest };
    } catch {
      return null;
    }
  }

  /**
   * The unpacked files of an archive, unpacking it first when needed. Resolves to
   * { dir, files: [{ name, size, crc }], zipSize }, or null when the files can't be served as
   * a plain zip (too big for the zip format, or nothing inside).
   * @param {{ zipped?: (name: string) => boolean }} options
   *   `zipped` says which files will be sent as a zip (all of them by default); the rest are only
   *   read from the cache folder (a Windows 9x game's hard disk), so the zip format's limits
   *   don't apply to them, only the cache's size.
   */
  async unpacked(archive, { zipped = null } = {}) {
    const stat = await fsp.stat(archive);
    const key = RomCache.key(archive, stat);
    const dir = path.join(this.dir, key);
    const manifestFile = path.join(dir, MANIFEST);
    try {
      const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
      const now = new Date();
      await fsp.utimes(manifestFile, now, now).catch(() => {}); // marks it recently used
      return { dir, ...manifest };
    } catch {
      // Not unpacked yet.
    }
    if (this.refused.has(key)) return null;
    const manifest = await this.#job(key, () => this.#unpack(archive, dir, zipped));
    return manifest && { dir, ...manifest };
  }

  /**
   * The cached copy of an installed game folder (Windows 3.x games aren't zipped), copying it
   * first when needed, so the browser can be sent it as a zip without reading the slow games
   * drive again. Resolves like unpacked(): { dir, files, zipSize }, or null when the files
   * can't be served as a plain zip.
   * @param {{ as?: string, skip?: (name: string) => boolean,
   *           rewrite?: (name: string) => ((text: string) => string)|null }} options
   *   `as` is the folder name inside the zip (the source folder's own name by default),
   *   `skip` leaves files out, and `rewrite` replaces a file's content.
   */
  async packedFolder(source, { as = null, skip = () => false, rewrite = () => null } = {}) {
    const listing = await this.listing(source, skip);
    if (!listing.files.length) return null;
    const top = as ?? path.basename(source);
    const key = RomCache.folderKey(source, top, listing);
    const dir = path.join(this.dir, key);
    const manifestFile = path.join(dir, MANIFEST);
    try {
      const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
      const now = new Date();
      await fsp.utimes(manifestFile, now, now).catch(() => {});
      return { dir, ...manifest };
    } catch {
      // Not copied yet.
    }
    // Too big to send, which the listing already says: don't copy it only to find that out.
    if (listing.totalBytes > this.#limit || listing.files.length > MAX_ZIP32_ENTRIES) this.refused.add(key);
    if (this.refused.has(key)) return null;
    const manifest = await this.#job(key, () => this.#copyFolder(source, dir, listing, top, rewrite));
    return manifest && { dir, ...manifest };
  }

  /** Whether an installed game folder has already been copied (never copies). Like peek(). */
  async packedFolderReady(source, { as = null, skip = () => false } = {}) {
    const listing = await this.listing(source, skip).catch(() => null);
    if (!listing?.files.length) return null;
    const top = as ?? path.basename(source);
    const key = RomCache.folderKey(source, top, listing);
    return fsp.readFile(path.join(this.dir, key, MANIFEST), 'utf8').then(JSON.parse, () => null);
  }

  async #copyFolder(source, dir, listing, top, rewrite) {
    const tmp = `${dir}.${process.pid}.tmp`;
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.mkdir(tmp, { recursive: true });
    try {
      const files = [];
      for (const entry of listing.files) {
        const name = `${top}/${entry.rel}`;
        const target = path.join(tmp, ...name.split('/'));
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const change = rewrite(entry.rel);
        let size = entry.size;
        let crc;
        if (change) {
          const text = change(await fsp.readFile(path.join(source, ...entry.rel.split('/')), 'latin1'));
          const data = Buffer.from(text, 'latin1');
          await fsp.writeFile(target, data);
          size = data.length;
          crc = zlib.crc32(data, 0) >>> 0;
        } else {
          // The size copied, not the listing's: the file may have changed since it was listed.
          ({ crc, size } = await copyWithCrc(path.join(source, ...entry.rel.split('/')), target));
        }
        files.push({ name, size, crc });
      }
      // Folders with nothing in them are part of the install too (a TEMP or save folder the game
      // expects to find). Their names go through folderEntries with the files', so every parent
      // folder gets its entry as well.
      const emptyDirs = (listing.emptyDirs ?? []).map((rel) => `${top}/${rel}/`);
      for (const name of emptyDirs) await fsp.mkdir(path.join(tmp, ...name.split('/')), { recursive: true });
      files.push(...folderEntries([...files, ...emptyDirs.map((name) => ({ name }))]));
      files.sort((a, b) => a.name.localeCompare(b.name));
      const zipSize = storedZipSize(files);
      if (!fitsZip32(files, zipSize)) {
        await fsp.rm(tmp, { recursive: true, force: true });
        return null;
      }
      await fsp.writeFile(path.join(tmp, MANIFEST), JSON.stringify({ files, zipSize }));
      await this.#moveIntoPlace(tmp, dir);
      return { files, zipSize };
    } catch (err) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  async #unpack(archive, dir, zipped = null) {
    const tmp = `${dir}.${process.pid}.tmp`;
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.mkdir(tmp, { recursive: true });
    try {
      await this.#checkSevenZip();
      // What's inside, before anything is written: an archive whose files wouldn't fit (or that
      // unpacks to far more than it looks, on purpose or not) isn't unpacked at all. When only
      // some of the files are zipped, which ones isn't known yet: the whole has to fit the cache.
      const contents = await listArchive(this.sevenZip, archive);
      if (!ARCHIVE_TYPES.has(contents.type)) throw new Error(`${archive} is a ${contents.type || 'unknown'} archive, not 7z, RAR or zip.`);
      const limit = zipped ? this.maxBytes : this.#limit;
      if (contents.totalBytes > limit || (!zipped && contents.fileCount > MAX_ZIP32_ENTRIES)) {
        await fsp.rm(tmp, { recursive: true, force: true });
        return null;
      }
      // "--" ends the switches, so no archive name can be read as one. A password it would ask
      // for gets this one instead, and fails at once rather than waiting.
      await run(this.sevenZip, ['x', '-y', '-bd', '-pRetroGameBrowser', `-o${tmp}`, '--', archive], { timeoutMs: UNPACK_TIMEOUT_MS });
      const files = [];
      await walk(tmp, async (abs) => {
        const name = path.relative(tmp, abs).split(path.sep).join('/');
        files.push({ name, size: (await fsp.stat(abs)).size, crc: await crc32File(abs) });
      });
      files.sort((a, b) => a.name.localeCompare(b.name));
      const zipSize = storedZipSize(files);
      const served = zipped ? files.filter((f) => zipped(f.name)) : files;
      if (!files.length || !fitsZip32(served, storedZipSize(served))) {
        await fsp.rm(tmp, { recursive: true, force: true });
        return null;
      }
      await fsp.writeFile(path.join(tmp, MANIFEST), JSON.stringify({ files, zipSize }));
      await this.#moveIntoPlace(tmp, dir);
      return { files, zipSize };
    } catch (err) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * Renames a finished unpack or copy into place and trims the cache. The folder is held
   * meanwhile, so another trim running now (another job's, or the admin page's clear) doesn't
   * delete it before whoever asked for it has it.
   */
  async #moveIntoPlace(tmp, dir) {
    const release = holdCacheDir(dir);
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      await renameWhenFree(tmp, dir, { tries: 10, delayMs: 100 }); // a virus scanner reading the new files can hold the folder a while
      // The files are ready either way; a cache that couldn't be trimmed is trimmed next time.
      await this.trim(dir).catch((err) => console.warn(`Couldn't trim ${this.dir}: ${err.message}`));
    } finally {
      release();
    }
  }

  /**
   * Deletes the least recently used unpacked archives until the cache fits its limit (or
   * `maxBytes`: 0 empties it, from the admin page). Folders being read are left alone.
   */
  async trim(keep, maxBytes = this.maxBytes) {
    const entries = [];
    for (const name of await fsp.readdir(this.dir).catch(() => [])) {
      const dir = path.join(this.dir, name);
      if (name.endsWith('.tmp')) {
        // Unpacks still being written ("<key>.<pid>.tmp", manifest and all while they wait to be
        // renamed) aren't entries yet. Folders an eviction couldn't finish deleting are tried
        // again, and not counted.
        if (name.includes('.evict.')) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      const manifest = await fsp.readFile(path.join(dir, MANIFEST), 'utf8').then(JSON.parse, () => null);
      if (!manifest) continue;
      // Gone meanwhile (another trim moved it aside): not an entry any more.
      const used = await fsp.stat(path.join(dir, MANIFEST)).then((s) => s.mtimeMs, () => null);
      if (used === null) continue;
      entries.push({ dir, used, bytes: manifest.files.reduce((n, f) => n + f.size, 0) });
    }
    entries.sort((a, b) => a.used - b.used);
    let total = entries.reduce((n, e) => n + e.bytes, 0);
    for (const e of entries) {
      if (total <= maxBytes) break;
      if (e.dir === keep || busy.has(e.dir)) continue;
      // Moved aside first, in one step, then deleted: a delete that stops halfway (the server
      // restarting, a file in use) would otherwise leave a manifest naming files that are gone.
      // A folder left aside is removed with the other leftovers (see #cleanStale).
      const aside = `${e.dir}.evict.${process.pid}.tmp`;
      try {
        await fsp.rename(e.dir, aside);
      } catch (err) {
        // Already gone (another trim got to it first), so no longer counted; otherwise in use
        // (a virus scanner reading it, say), and tried again next time.
        if (err.code === 'ENOENT') total -= e.bytes;
        continue;
      }
      await fsp.rm(aside, { recursive: true, force: true }).catch(() => {});
      total -= e.bytes;
    }
  }
}

/** Whether files can go in a plain (not ZIP64) zip: sizes, offsets and the entry count all fit. */
const fitsZip32 = (files, zipSize) => zipSize <= MAX_ZIP32 && files.length <= MAX_ZIP32_ENTRIES && files.every((f) => f.size <= MAX_ZIP32);

/**
 * What 7-Zip says is in an archive, without unpacking it: its format ("7z", "rar5", …, lower
 * case), how many files it holds and what they come to unpacked.
 */
export async function listArchive(sevenZip, archive) {
  return parseArchiveListing(await run(sevenZip, ['l', '-slt', '-bd', '-pRetroGameBrowser', '--', archive], { timeoutMs: LIST_TIMEOUT_MS, output: true }));
}

/** Reads the output of `7z l -slt`: a block about the archive, then one block per entry after a line of dashes. */
export function parseArchiveListing(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^-{10}$/.test(l.trim()));
  const head = start === -1 ? lines : lines.slice(0, start);
  const type = head.map((l) => /^Type = (.+)$/.exec(l.trim())?.[1]).find(Boolean) ?? '';
  let fileCount = 0;
  let totalBytes = 0;
  let folder = false;
  let size = 0;
  const endEntry = () => {
    if (!folder) {
      fileCount++;
      totalBytes += size;
    }
    folder = false;
    size = 0;
  };
  let inEntry = false;
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    const l = line.trim();
    if (!l) {
      if (inEntry) endEntry();
      inEntry = false;
      continue;
    }
    inEntry = true;
    const m = /^(\w[\w ]*?) = (.*)$/.exec(l);
    if (m?.[1] === 'Size') size = Number(m[2]) || 0;
    // Formats say a folder is one differently: "Folder = +", or a D among Windows' attribute
    // letters ("Attributes = D", "DA", "D_ drwxr-xr-x").
    else if (m?.[1] === 'Folder') folder ||= m[2] === '+';
    else if (m?.[1] === 'Attributes') folder ||= /^[A-Z]*D/.test(m[2]);
  }
  if (inEntry) endEntry();
  return { type: type.toLowerCase(), fileCount, totalBytes };
}

/**
 * Runs 7-Zip. Resolves with what it printed when `output` is set; rejects when it fails, or is
 * killed for taking longer than `timeoutMs`.
 */
function run(file, args, { timeoutMs, output = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', output ? 'pipe' : 'ignore', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf8').on('data', (d) => { out += d; });
    // Only the start of an error is shown, so only that much is kept.
    child.stderr.setEncoding('utf8').on('data', (d) => { if (err.length < 1000) err += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`7-Zip took longer than ${Math.round(timeoutMs / 60000)} minutes and was stopped.`));
      else if (code === 0) resolve(out);
      else reject(new Error(`7-Zip failed (${code}): ${err.trim().slice(0, 300)}`));
    });
  });
}

async function walk(dir, onFile, onDir = null) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await onDir?.(p);
      await walk(p, onFile, onDir);
    } else if (entry.isFile()) await onFile(p);
  }
}

/**
 * Every file under `dir`, with its path relative to `dir` ("WINDOWS/SYSTEM.INI"), plus the
 * totals that say whether a copy of it is still current. `skip` leaves files out.
 * `emptyDirs` are the folders with no (listed) files anywhere inside them.
 */
export async function folderListing(dir, skip = () => false) {
  const files = [];
  const dirs = [];
  let totalBytes = 0;
  let newest = 0;
  const relative = (abs) => path.relative(dir, abs).split(path.sep).join('/');
  await walk(dir, async (abs) => {
    const rel = relative(abs);
    if (skip(rel)) return;
    const stat = await fsp.stat(abs);
    files.push({ rel, size: stat.size });
    totalBytes += stat.size;
    newest = Math.max(newest, Math.round(stat.mtimeMs));
  }, (abs) => { dirs.push(relative(abs)); });
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const holding = new Set(folderEntries(files.map((f) => ({ name: f.rel }))).map((e) => e.name.slice(0, -1)));
  const emptyDirs = dirs.filter((d) => !holding.has(d) && !skip(`${d}/`)).sort((a, b) => a.localeCompare(b));
  return { files, totalBytes, newest, emptyCount: files.filter((f) => !f.size).length, emptyDirs };
}

/** Copies a file, returning its CRC-32 and size, so the bytes are read only once. */
async function copyWithCrc(from, to) {
  let crc = 0;
  let size = 0;
  await pipeline(
    fs.createReadStream(from, { highWaterMark: 1 << 20 }),
    async function* (source) {
      for await (const chunk of source) {
        crc = zlib.crc32(chunk, crc);
        size += chunk.length;
        yield chunk;
      }
    },
    fs.createWriteStream(to),
  );
  return { crc: crc >>> 0, size };
}

async function crc32File(file) {
  let crc = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) crc = zlib.crc32(chunk, crc);
  return crc >>> 0;
}

// ---------- Stored zip ----------

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;

// A file's name inside the zip: `as` when it's served under another name (see storedZip).
const zipName = (f) => f.as ?? f.name;

// An entry that makes a folder rather than a file (an empty entry whose name ends in "/").
const isFolder = (f) => zipName(f).endsWith('/');

/**
 * Folder entries for every folder these files are in. The emulator's unzip makes a file's own
 * folder but not its grandparents, so a zip we build ourselves carries a folder entry for each
 * one; sorted with the rest, every folder comes before what's inside it.
 */
export function folderEntries(files) {
  const dirs = new Set();
  for (const f of files) {
    const parts = f.name.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  return [...dirs].map((name) => ({ name, size: 0, crc: 0 }));
}

/** Byte size of the stored zip that storedZip() writes for these files. */
export function storedZipSize(files) {
  let size = END_RECORD;
  for (const f of files) {
    const n = Buffer.byteLength(zipName(f));
    size += LOCAL_HEADER + n + f.size + CENTRAL_HEADER + n;
  }
  return size;
}

function localHeader(f, name) {
  const b = Buffer.alloc(LOCAL_HEADER);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);        // version needed
  b.writeUInt16LE(0x0800, 6);    // UTF-8 names
  b.writeUInt16LE(0, 8);         // stored
  b.writeUInt16LE(0, 10);        // time: midnight
  b.writeUInt16LE(DOS_DATE, 12); // date: 1 January 1980, the earliest a zip holds (zeros are no date at all)
  b.writeUInt32LE(f.crc, 14);
  b.writeUInt32LE(f.size, 18);
  b.writeUInt32LE(f.size, 22);
  b.writeUInt16LE(name.length, 26);
  b.writeUInt16LE(0, 28);
  return Buffer.concat([b, name]);
}

function centralHeader(f, name, offset) {
  const b = Buffer.alloc(CENTRAL_HEADER);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(20, 4);        // made by
  b.writeUInt16LE(20, 6);        // version needed
  b.writeUInt16LE(0x0800, 8);
  b.writeUInt16LE(0, 10);
  b.writeUInt16LE(0, 12);        // time
  b.writeUInt16LE(DOS_DATE, 14); // date
  b.writeUInt32LE(f.crc, 16);
  b.writeUInt32LE(f.size, 20);
  b.writeUInt32LE(f.size, 24);
  b.writeUInt16LE(name.length, 28);
  b.writeUInt32LE(offset, 42);
  return Buffer.concat([b, name]);
}

/**
 * Writes the files of an unpacked archive to `out` (a writable stream, e.g. an HTTP
 * response) as an uncompressed zip, without building it on disk. A file with an `as` field
 * is stored under that name. Rejects when `out` closes before the end (the browser went
 * away); the file being read is closed then too.
 */
export async function storedZip(unpacked, out) {
  const write = (buf) => new Promise((resolve, reject) => {
    if (out.destroyed) return reject(new Error('Connection closed'));
    if (out.write(buf)) return resolve();
    // Waiting for room to write: a connection that closes meanwhile never drains.
    const done = (err) => {
      out.off('drain', onDrain);
      out.off('close', onClose);
      err ? reject(err) : resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(new Error('Connection closed'));
    out.once('drain', onDrain);
    out.once('close', onClose);
  });
  // The cache isn't trimmed from under a zip on its way out.
  const release = holdCacheDir(unpacked.dir);
  try {
    const central = [];
    let offset = 0;
    for (const f of unpacked.files) {
      const name = Buffer.from(zipName(f));
      central.push(centralHeader(f, name, offset));
      const header = localHeader(f, name);
      await write(header);
      if (!isFolder(f)) {
        for await (const chunk of fs.createReadStream(path.join(unpacked.dir, ...f.name.split('/')), { highWaterMark: 1 << 20 })) {
          await write(chunk);
        }
      }
      offset += header.length + f.size;
    }
    const dir = Buffer.concat(central);
    const end = Buffer.alloc(END_RECORD);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(unpacked.files.length, 8);
    end.writeUInt16LE(unpacked.files.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    await write(Buffer.concat([dir, end]));
  } finally {
    release();
  }
}
