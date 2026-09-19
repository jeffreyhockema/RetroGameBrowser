// Downloads the browser builds of MAME 0.244 into vendor/mame/: a <bundle>.js and <bundle>.wasm
// for each bundle of drivers in server/data/mame-bundles.json (the arcade games'), and the
// Apple IIgs's (see server/lib/iigs.js).
//
//   npm run fetch-mame [release tag]
//
// The builds come from a GitHub release of github.com/jeffreyhockema/mame-wasm-build (the
// latest one unless a tag is given), which compiles MAME's own mame0244 source. Each file is
// checked against the SHA-256 GitHub lists for it, and each bundle's list of drivers against
// the one this app expects. The new files are put in place together, once all of them are in.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'jeffreyhockema/mame-wasm-build';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'vendor', 'mame');
const { IIGS_BUNDLE, IIGS_SOURCES } = await import('../server/lib/iigs.js');
const bundles = {
  ...JSON.parse(await fs.readFile(path.join(root, 'server', 'data', 'mame-bundles.json'), 'utf8')),
  [IIGS_BUNDLE]: IIGS_SOURCES,
};

async function fetchOk(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': 'retro-game-browser', ...headers } });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res;
}

const tag = process.argv[2];
const release = await (await fetchOk(`https://api.github.com/repos/${REPO}/releases/${tag ? `tags/${encodeURIComponent(tag)}` : 'latest'}`,
  { Accept: 'application/vnd.github+json' })).json();
const assets = new Map(release.assets.map((a) => [a.name, a]));
console.log(`MAME builds from ${REPO} release ${release.tag_name}`);

async function download(name) {
  const asset = assets.get(name);
  if (!asset) throw new Error(`The release has no ${name}`);
  const data = Buffer.from(await (await fetchOk(asset.browser_download_url)).arrayBuffer());
  const [algo, expected] = (asset.digest ?? '').split(':');
  if (algo === 'sha256' && crypto.createHash('sha256').update(data).digest('hex') !== expected) {
    throw new Error(`${name}: checksum mismatch`);
  }
  return data;
}

const staging = `${dest}.new`;
await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
for (const [bundle, sources] of Object.entries(bundles)) {
  // Drivers are listed by file name, and the other files a bundle needs by their path in MAME's source.
  const names = (list) => list.map((s) => path.posix.basename(s)).join(',');
  const built = (await download(`${bundle}.sources.txt`)).toString('utf8').trim().split(',');
  if (names(built) !== names(sources)) {
    await fs.rm(staging, { recursive: true, force: true });
    throw new Error(`The release's ${bundle} bundle has different drivers than this app expects`);
  }
  for (const ext of ['js', 'wasm']) {
    const data = await download(`${bundle}.${ext}`);
    await fs.writeFile(path.join(staging, `${bundle}.${ext}`), data);
    console.log(`  ${bundle}.${ext}  ${(data.length / 1048576).toFixed(1)} MB`);
  }
}
// MAME's license notice and the texts it refers to, which go wherever the builds go (the
// installer). Releases before these were added lack them.
const licenseFiles = [...assets.keys()].filter((name) => name === 'COPYING' || /^legal-[\w.-]+\.txt$/.test(name));
if (!licenseFiles.includes('COPYING')) console.warn('  This release has no COPYING: MAME\'s license isn\'t included.');
for (const name of licenseFiles) await fs.writeFile(path.join(staging, name), await download(name));
await fs.writeFile(path.join(staging, 'release.json'), `${JSON.stringify({ repo: REPO, tag: release.tag_name }, null, 2)}\n`);

// Swapped in whole, so a running server never sees one bundle's .js with another build's .wasm.
const old = `${dest}.old`;
await fs.rm(old, { recursive: true, force: true });
await fs.rename(dest, old).catch((err) => { if (err.code !== 'ENOENT') throw err; });
await fs.rename(staging, dest);
await fs.rm(old, { recursive: true, force: true });
console.log(`Done: ${Object.keys(bundles).length} bundles in ${path.relative(root, dest)}`);
