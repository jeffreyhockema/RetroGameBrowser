// Downloads a WebAssembly build of ScummVM into vendor/scummvm-web/.
//
//   node scripts/fetch-scummvm-web.mjs [--update] [baseUrl]
//
// Default source is the unofficial demo build by the Emscripten port's author. Only the
// engine (scummvm.js/.wasm) and its data folder (engine plugins, themes, engine data files)
// are fetched; the demo's page, games and third-party scripts are not.
//
// The engine runs on this app's own origin, so the build is pinned by SHA-256 (PINNED below).
// Anything else the site serves is refused unless --update is passed, which installs it and
// prints the new values to paste in. Everything goes into a staging folder that replaces
// vendor/scummvm-web only once the whole build is in and checked, so a failed run never leaves
// a new engine next to old plugins. Re-running reuses data files already on disk, but only
// while the engine itself is unchanged.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The build installed on 2026-09-11 from https://scummvm.kuendig.io. `data` is the SHA-256 of
// the sorted "<sha256>  <path>" list of every file in the data tree (as in SHA256SUMS), without
// the folders in SKIP_DIRS.
const PINNED = {
  'scummvm.js': '505a7058c6d98032cb91045f57582f85635951ce1fe2ad43d04b7769d596f309',
  'scummvm.wasm': 'a31d2162bd4032bc475fe4fe90a86805a3f8750ea6d9b4fdde4321995f9489fa',
  data: '498e96362c1f646a5bd3ab9c6981f922e9e15f60af78b226fb59d8eb39f0733f',
};

const args = process.argv.slice(2);
const update = args.includes('--update');
const base = (args.find((a) => !a.startsWith('--')) ?? 'https://scummvm.kuendig.io').replace(/\/$/, '');
if (!/^https:\/\//i.test(base)) {
  console.error(`Refusing ${base}: the engine is only fetched over https.`);
  process.exit(1);
}
const dest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'scummvm-web');
const staging = `${dest}.new`;
const CONCURRENCY = 6;
const ENGINE = ['scummvm.js', 'scummvm.wasm'];
// Folders in the data tree that point elsewhere or that we serve ourselves, and gui-icons: 200 MB
// of pictures for ScummVM's own game list, which never shows here (the app starts each game
// directly). The server lists the data folder from what's on disk (GET /data/index.json), so
// ScummVM is never told of a folder that isn't there.
const SKIP_DIRS = new Set(['games', 'gui-icons']);

async function fetchOk(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res;
    } catch (err) {
      if (attempt >= 3) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/**
 * Where a file the remote index names goes, under `root`. The names come from another site, so
 * anything but plain names inside the folder ("..", a backslash, a drive) is refused.
 */
function outPath(rel, root = staging) {
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || /[\\:]/.test(p))) throw new Error(`Refusing a file name from the server: ${rel}`);
  return path.join(root, ...parts);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function sizeOf(file) {
  return fs.stat(file).then((s) => s.size, () => -1);
}

const hashes = new Map(); // rel -> sha256 of the staged file

/** Walks the HTTP filesystem's index.json tree and returns [{rel, size}] for every file. */
async function listDataTree(rel = 'data') {
  const index = await (await fetchOk(`${base}/${rel}/index.json`)).json();
  const text = JSON.stringify(index);
  await fs.mkdir(outPath(rel), { recursive: true });
  await fs.writeFile(path.join(outPath(rel), 'index.json'), text);
  hashes.set(`${rel}/index.json`, sha256(text));
  const files = [];
  for (const [name, value] of Object.entries(index)) {
    const childRel = `${rel}/${name}`;
    outPath(childRel); // checked before anything is fetched for it
    if (typeof value === 'number') files.push({ rel: childRel, size: value });
    else if (value && typeof value === 'object' && !value.baseUrl && !(rel === 'data' && SKIP_DIRS.has(name))) {
      files.push(...await listDataTree(childRel));
    }
  }
  return files;
}

/** Puts one file in staging: the copy already installed when `reuse` allows it, else a download. */
async function stage({ rel, size }, reuse) {
  const out = outPath(rel);
  await fs.mkdir(path.dirname(out), { recursive: true });
  // Unlinked first: writing through a hard link made by an earlier pass would change the installed copy.
  await fs.rm(out, { force: true });
  const installed = outPath(rel, dest);
  if (reuse && size >= 0 && (await sizeOf(installed)) === size) {
    // A hard link costs nothing and the old folder is deleted afterwards anyway.
    await fs.link(installed, out).catch(() => fs.copyFile(installed, out));
    hashes.set(rel, sha256(await fs.readFile(out)));
    return false;
  }
  const res = await fetchOk(`${base}/${rel.split('/').map(encodeURIComponent).join('/')}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (size >= 0 && buf.length !== size) throw new Error(`${rel}: expected ${size} bytes, got ${buf.length}`);
  await fs.writeFile(out, buf);
  hashes.set(rel, sha256(buf));
  return true;
}

async function runQueue(items, fn) {
  let done = 0;
  const queue = [...items];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let f; (f = queue.shift());) {
      await fn(f);
      done++;
      if (done % 25 === 0 || done === items.length) console.log(`  ${done}/${items.length}`);
    }
  }));
}

console.log(`Fetching ScummVM web build from ${base}`);
await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
try {
  const refuse = (what) => new Error(`${base} serves a different build than the pinned one (${what} changed). ` +
    'Nothing was installed. If you trust the new build, run again with --update.');
  for (const rel of ENGINE) await stage({ rel, size: -1 }, false);
  // Checked before the data tree, so a changed engine doesn't cost a 600 MB download first.
  const engineChanged = ENGINE.filter((rel) => PINNED[rel] !== hashes.get(rel));
  if (engineChanged.length && !update) throw refuse(engineChanged.join(', '));
  // Plugins and data files belong to one engine build: keep the installed ones only for the same engine.
  const installedEngine = await Promise.all(ENGINE.map((rel) => fs.readFile(outPath(rel, dest)).then(sha256, () => null)));
  const sameEngine = ENGINE.every((rel, i) => installedEngine[i] === hashes.get(rel));

  const files = await listDataTree();
  const totalMB = files.reduce((n, f) => n + Math.max(f.size, 0), 0) / 1048576;
  console.log(`${files.length} data files, about ${totalMB.toFixed(0)} MB${sameEngine ? ' (engine unchanged, reusing files on disk)' : ''}`);
  let fetched = 0;
  const stageData = (reuse) => runQueue(files, async (f) => { if (await stage(f, reuse)) fetched++; });
  const dataSums = () => [...hashes].filter(([rel]) => rel.startsWith('data/'))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([rel, hash]) => `${hash}  ${rel}\n`).join('');
  await stageData(sameEngine);
  let sums = dataSums();
  // A reused file can differ from the site's at the same size (damaged on disk, or rebuilt there
  // without the engine changing), so a mismatch is only judged on a full download.
  if (sameEngine && sha256(sums) !== PINNED.data) {
    console.log('The data files on disk differ from the pinned build; downloading all of them.');
    fetched = 0;
    await stageData(false);
    sums = dataSums();
  }
  const got = { 'scummvm.js': hashes.get('scummvm.js'), 'scummvm.wasm': hashes.get('scummvm.wasm'), data: sha256(sums) };
  const changed = Object.keys(PINNED).filter((k) => PINNED[k] !== got[k]);
  if (changed.length && !update) throw refuse(changed.join(', '));

  await fs.writeFile(path.join(staging, 'SHA256SUMS'), `${ENGINE.map((rel) => `${hashes.get(rel)}  ${rel}\n`).join('')}${sums}`);
  await fs.writeFile(path.join(staging, 'SOURCE.txt'),
    `Downloaded from ${base} on ${new Date().toISOString()}\n` +
    'ScummVM is licensed under the GNU GPL v3. Source: https://github.com/scummvm/scummvm\n');

  // Swap the folders. The old one moves aside first so a failed rename can be put back.
  const old = `${dest}.old`;
  await fs.rm(old, { recursive: true, force: true });
  const hadOld = await fs.rename(dest, old).then(() => true, (err) => {
    if (err.code === 'ENOENT') return false;
    throw new Error(`Could not replace ${dest} (${err.code}). Stop the server and run again.`);
  });
  try {
    await fs.rename(staging, dest);
  } catch (err) {
    if (hadOld) await fs.rename(old, dest);
    throw new Error(`Could not replace ${dest} (${err.code}). Stop the server and run again.`);
  }
  if (hadOld) await fs.rm(old, { recursive: true, force: true });

  console.log(`Done. ${fetched} downloaded, ${files.length - fetched} reused. Saved to ${dest}`);
  if (changed.length) {
    console.log('\nNew build installed. Paste this over PINNED in scripts/fetch-scummvm-web.mjs:');
    console.log(`const PINNED = ${JSON.stringify(got, null, 2).replace(/"/g, "'")};`);
  }
} catch (err) {
  await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  console.error(err.message);
  process.exit(1);
}
