import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { XMLParser } from 'fast-xml-parser';

// A file this big is parsed off the main thread (see readLaunchBoxXml).
const WORKER_MIN_BYTES = 1024 * 1024;

// Elements that repeat under the LaunchBox root element.
const LIST_TAGS = new Set([
  'Game', 'AdditionalApplication', 'AlternateName', 'CustomField',
  'Platform', 'PlatformFolder', 'PlatformCategory', 'Parent',
  'Playlist', 'PlaylistGame', 'PlaylistFilter',
  'Emulator', 'EmulatorPlatform', 'ImageTypeSettings',
]);

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false, // keep everything as strings ("1942" is a title, not a number)
  trimValues: false,
  isArray: (name, jpath) => LIST_TAGS.has(name) && jpath.split('.').length === 2,
});

/**
 * Parses a LaunchBox XML file and returns the contents of its <LaunchBox> root. LaunchBox
 * rewrites a platform's XML every time a game there is played, and parsing eXoDOS's (tens of
 * megabytes) takes seconds, which on the main thread would hold up every request, the netplay
 * fallback and the IPX relay: a big file is read and parsed in a worker of its own.
 */
export async function readLaunchBoxXml(file) {
  const { size } = await fs.stat(file);
  if (size < WORKER_MIN_BYTES) return parseLaunchBoxXml(await fs.readFile(file, 'utf8'), path.basename(file));
  const worker = new Worker(new URL('./xmlworker.js', import.meta.url), { workerData: file });
  return new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => reject(new Error(`Reading ${path.basename(file)} stopped (exit ${code})`)));
  }).finally(() => worker.terminate());
}

/** The contents of the <LaunchBox> root of a LaunchBox XML document (`name` is its file's, for errors). */
export function parseLaunchBoxXml(text, name = 'The XML file') {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // LaunchBox may be part-way through saving the file, or crashed while it did. The parser takes
  // an empty or cut-off document without complaint and hands back the games read so far, so say
  // it failed instead: a reload then keeps the library as it was and tries again at the next check.
  // (An empty list is written as a self-closing root.)
  if (!/(?:<\/LaunchBox>|<LaunchBox\s*\/>)\s*$/.test(text.slice(-64))) {
    throw new Error(`${name} is incomplete (LaunchBox still saving it?)`);
  }
  const root = parser.parse(text).LaunchBox;
  return root && typeof root === 'object' ? root : {}; // an empty root parses as ''
}

export const str = (v) => (v == null || typeof v === 'object' ? '' : String(v).trim());
export const bool = (v) => str(v).toLowerCase() === 'true';
export const num = (v) => {
  const n = Number.parseFloat(str(v));
  return Number.isFinite(n) ? n : null;
};
/** Splits LaunchBox's semicolon-separated multi-value fields. */
export const list = (v) => str(v).split(';').map((s) => s.trim()).filter(Boolean);
