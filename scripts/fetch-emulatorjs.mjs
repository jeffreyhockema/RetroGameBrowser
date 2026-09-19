// Downloads EmulatorJS (the RetroArch-in-the-browser frontend) and the emulator cores the
// console platforms use into vendor/emulatorjs/.
//
//   npm run fetch-emulators
//
// The packages come straight from the npm registry as tarballs, checked against the
// registry's integrity hash. Installing them with npm would also pull in EmulatorJS's own
// build tools (minifiers, a web server, socket.io …), which this app doesn't need.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { CORES } from '../server/lib/emulatorjs.js';

const VERSION = '4.2.3';
const REGISTRY = 'https://registry.npmjs.org';
const dest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'emulatorjs');

// The order EmulatorJS's loader.js loads its scripts in; concatenated into emulator.min.js.
const SCRIPTS = ['emulator.js', 'nipplejs.js', 'shaders.js', 'storage.js', 'gamepad.js', 'GameManager.js', 'socket.io.min.js', 'compression.js'];

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res;
}

/** Downloads a package's tarball and checks it against the registry's integrity hash. */
async function tarball(name) {
  const meta = await (await fetchOk(`${REGISTRY}/${name.replace('/', '%2f')}/${VERSION}`)).json();
  const buf = Buffer.from(await (await fetchOk(meta.dist.tarball)).arrayBuffer());
  const [algo, expected] = meta.dist.integrity.split('-');
  const actual = crypto.createHash(algo).update(buf).digest('base64');
  if (actual !== expected) throw new Error(`${name}: integrity check failed`);
  return zlib.gunzipSync(buf);
}

/** Files in a (gunzipped) tar archive as [{ name, data }]. Handles ustar prefixes and pax paths. */
export function untar(buf) {
  const files = [];
  let pax = null;
  for (let off = 0; off + 512 <= buf.length;) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(str(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(345, 155);
    let name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1] ?? null;
      continue;
    }
    if (pax) { name = pax; pax = null; }
    if (type === '0' || type === '\0') files.push({ name, data });
  }
  return files;
}

async function write(rel, data) {
  // Names come from the package's tar file: only plain names inside vendor/emulatorjs.
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || /[\\:]/.test(p))) throw new Error(`Refusing a file name from the package: ${rel}`);
  const out = path.join(dest, ...parts);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(`${out}.part`, data);
  await fs.rename(`${out}.part`, out);
}

console.log(`Fetching EmulatorJS ${VERSION} into ${dest}`);
const frontend = untar(await tarball('@emulatorjs/emulatorjs'));
let count = 0;
for (const f of frontend) {
  const m = /^package\/data\/(.+)$/.exec(f.name);
  if (!m || m[1].startsWith('cores/')) continue;
  await write(`data/${m[1]}`, f.data);
  count++;
}
// The npm package has only the separate source files. The loader asks for emulator.min.js and
// emulator.min.css first (and logs errors when they're missing), so build them: the minified
// build is these files concatenated in the same order.
const src = (name) => frontend.find((f) => f.name === `package/data/src/${name}`)?.data;
await write('data/emulator.min.js', Buffer.concat(SCRIPTS.map((s) => {
  const data = src(s);
  if (!data) throw new Error(`EmulatorJS package is missing src/${s}`);
  return Buffer.concat([data, Buffer.from('\n;\n')]);
})));
await write('data/emulator.min.css', frontend.find((f) => f.name === 'package/data/emulator.css').data);
console.log(`  frontend: ${count} files`);

const cores = [...new Set(Object.values(CORES).map((c) => c.core))];
for (const core of cores) {
  let n = 0;
  for (const f of untar(await tarball(`@emulatorjs/core-${core}`))) {
    const m = /^package\/(.+)$/.exec(f.name);
    // Threaded builds need cross-origin isolation, which this app doesn't use.
    if (!m || /-thread/.test(m[1]) || !/(-wasm\.data|reports\/[^/]+\.json)$/.test(m[1])) continue;
    await write(`data/cores/${m[1]}`, f.data);
    n++;
  }
  console.log(`  core ${core}: ${n} files`);
}

await fs.writeFile(path.join(dest, 'SOURCE.txt'),
  `EmulatorJS ${VERSION} and cores (${cores.join(', ')}) from the npm registry, fetched ${new Date().toISOString()}.\n` +
  'EmulatorJS is licensed under the GNU GPL v3 (https://github.com/EmulatorJS/EmulatorJS); each core keeps its own licence.\n');
console.log('Done.');
