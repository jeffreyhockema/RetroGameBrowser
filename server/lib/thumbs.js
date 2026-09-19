import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const WIDTHS = [160, 240, 320, 480, 640, 960, 1280, 1920];
// Requests this wide are for backdrops, where a heavy original that's already narrow enough
// is still worth re-encoding; smaller ones (screenshots, box art, logos) keep their original.
const LARGE_WIDTH = 1280;
const HEAVY_BYTES = 200 * 1024;
// Box art and backdrops are a few megapixels; a picture far bigger than any of them isn't
// decoded (a 100-megapixel one takes 400 MB to hold).
const MAX_INPUT_PIXELS = 100_000_000;
// Resizes run on the same few threads Node reads files with (4, unless UV_THREADPOOL_SIZE says
// otherwise), so a shelf asking for a thousand thumbnails at once would hold up game downloads.
const MAX_JOBS = 3;
// The shelf's thumbnails are made once and kept; when there are more than this many bytes of
// them, the oldest go (see trimThumbs). Checked again after this many new ones.
const TRIM_EVERY = 500;
const REMEMBERED_ORIGINALS = 50_000;
// Thumbnails waiting their turn past this many: the original is sent instead of joining the
// queue, so a flood of requests for new ones can't hold up everyone else's for minutes.
const MAX_WAITING = 300;

// sharp keeps files it has read open for a while by default, which on Windows stops LaunchBox
// from replacing or deleting those pictures.
sharp.cache({ files: 0 });

const inFlight = new Map();
const unreadable = new Set(); // images sharp couldn't read, so each is only warned about once
// Thumbnail paths whose request is answered with the original (small enough already, or
// unreadable), so a repeat request doesn't read the picture again to find that out.
const originals = new Map();
let running = 0;
const waiting = [];
let written = 0;
let trimming = null; // { maxBytes, promise } of the trim running, or the last one waiting

/** Rounds a requested width up to one of a few fixed sizes so the cache stays small. */
export function snapWidth(requested) {
  const w = Number.parseInt(requested, 10);
  if (!Number.isFinite(w) || w <= 0) return null;
  return WIDTHS.find((x) => x >= w) ?? WIDTHS.at(-1);
}

/** Runs `job` once fewer than MAX_JOBS are running. */
async function slot(job) {
  if (running >= MAX_JOBS) await new Promise((resolve) => waiting.push(resolve));
  running++;
  try {
    return await job();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function keepOriginal(out, absPath) {
  if (originals.size >= REMEMBERED_ORIGINALS) originals.clear();
  originals.set(out, absPath);
  return absPath;
}

/**
 * Returns a path to a WebP copy of `absPath` at most `width` wide, cached under
 * `cacheDir`. Returns the original when it's no wider than `width` (unless the request is
 * a large one and the file is heavy, when it's re-encoded at its own width), or when sharp
 * can't read it (BMP, or a damaged file): the browser may still show the original. A
 * missing file still throws.
 * `trim` cuts away the see-through edge around the picture first (a logo drawn on a canvas the
 * size of the screen), and always makes a copy. `mayMake()`, asked before making one that isn't
 * cached yet, can say no (the asker's made too many lately): the original is sent this time.
 * @param {{ maxCacheBytes?: number, trim?: boolean, mayMake?: () => boolean }} [options] the thumbnail cache's size limit
 */
export async function thumbnail(absPath, width, cacheDir, { maxCacheBytes = Infinity, trim = false, mayMake = () => true } = {}) {
  const stat = await fs.stat(absPath);
  const key = crypto.createHash('sha1')
    .update(`${absPath}|${stat.size}|${stat.mtimeMs}|${width}${trim ? '|trim' : ''}`)
    .digest('hex');
  const out = path.join(cacheDir, 'thumbs', key.slice(0, 2), `${key}.webp`);
  if (originals.has(out)) return originals.get(out);

  if (inFlight.has(out)) return inFlight.get(out);
  if (!(await exists(out)) && (waiting.length >= MAX_WAITING || !mayMake())) return absPath;
  const job = (async () => {
    if (await exists(out)) return out;
    return slot(async () => {
      const tmp = `${out}.${process.pid}.tmp`;
      try {
        const meta = await sharp(absPath, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
        if (!meta.width || (!trim && meta.width <= width && (width < LARGE_WIDTH || stat.size <= HEAVY_BYTES))) return keepOriginal(out, absPath);
        await fs.mkdir(path.dirname(out), { recursive: true });
        // Trimmed to a buffer first: sharp would otherwise resize before it trims.
        const input = trim ? await sharp(absPath, { limitInputPixels: MAX_INPUT_PIXELS }).trim().toBuffer() : absPath;
        await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).resize({ width, withoutEnlargement: true }).webp({ quality: 82 }).toFile(tmp);
        await fs.rename(tmp, out);
        if (++written % TRIM_EVERY === 0 && Number.isFinite(maxCacheBytes)) {
          trimThumbs(cacheDir, maxCacheBytes).catch((err) => console.warn(`Couldn't trim the thumbnails: ${err.message}`));
        }
        return out;
      } catch (err) {
        // The key includes the file's size and date, so a repaired file gets its thumbnail
        // once it changes.
        await fs.rm(tmp, { force: true });
        if (!unreadable.has(absPath)) {
          unreadable.add(absPath);
          console.warn(`Couldn't make a thumbnail of ${absPath}, sending the original: ${err.message}`);
        }
        return keepOriginal(out, absPath);
      }
    });
  })().finally(() => inFlight.delete(out));
  inFlight.set(out, job);
  return job;
}

/**
 * Deletes the oldest thumbnails until they come to no more than 90% of `maxBytes`, so that
 * someone asking for every picture of every game at every width can't fill the disk. One
 * trim at a time; a thumbnail deleted here is simply made again when it's next asked for.
 */
export function trimThumbs(cacheDir, maxBytes) {
  // A running (or waiting) trim to this limit or a lower one already does the job; a stricter
  // one (the admin page's clear, to 0) waits for it and then runs.
  if (trimming && trimming.maxBytes <= maxBytes) return trimming.promise;
  const previous = trimming?.promise.catch(() => {});
  const current = { maxBytes };
  current.promise = Promise.resolve(previous)
    .then(() => trimOnce(cacheDir, maxBytes))
    .finally(() => { if (trimming === current) trimming = null; });
  trimming = current;
  return current.promise;
}

async function trimOnce(cacheDir, maxBytes) {
  const dir = path.join(cacheDir, 'thumbs');
  const files = [];
  let total = 0;
  for (const sub of await fs.readdir(dir).catch(() => [])) {
    for (const name of await fs.readdir(path.join(dir, sub)).catch(() => [])) {
      const file = path.join(dir, sub, name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      files.push({ file, size: stat.size, time: stat.mtimeMs });
      total += stat.size;
    }
  }
  if (total <= maxBytes) return 0;
  files.sort((a, b) => a.time - b.time);
  let removed = 0;
  for (const f of files) {
    if (total <= maxBytes * 0.9) break;
    await fs.rm(f.file, { force: true }).then(() => {
      total -= f.size;
      removed++;
    }, () => {});
  }
  return removed;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
