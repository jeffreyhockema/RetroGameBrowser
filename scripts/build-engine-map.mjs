// Builds server/data/scummvm-engines.json: game ID -> engine IDs, from the ScummVM builds
// that ship with eXo (`scummvm.exe --list-games`). Newer ScummVM needs engine-qualified IDs
// ("scumm:tentacle") on the command line, while eXo's launchers use bare ones ("tentacle").
//
//   node scripts/build-engine-map.mjs [eXo root]
//
// The eXo root defaults to the eXo folder of the configured launchboxRoot (see server/config.js).
//
// The executables are copied to a temp folder and run with their config and log file there,
// so nothing is written inside the LaunchBox folder.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../server/config.js';

const exoRoot = process.argv[2] ?? path.join(config.launchboxRoot, 'eXo');
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'data', 'scummvm-engines.json');
const builds = ['scmvm', 'scmvm\\stable', 'scmvm\\svn', 'scmvm\\svn2.3'].map((b) => path.join(exoRoot, b));

const engines = {};
let listed = 0;
let failed = 0;
for (const dir of builds) {
  const exe = path.join(dir, 'scummvm.exe');
  if (!fs.existsSync(exe)) continue;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-scummvm-'));
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/\.(exe|dll)$/i.test(f)) fs.copyFileSync(path.join(dir, f), path.join(tmp, f));
    }
    // The timeout also ends a build stuck behind an error dialog, which would otherwise wait forever.
    const output = execFileSync(path.join(tmp, 'scummvm.exe'),
      [`--config=${path.join(tmp, 'scummvm.ini')}`, `--logfile=${path.join(tmp, 'scummvm.log')}`, '--list-games'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, windowsHide: true });
    let count = 0;
    for (const line of output.split(/\r?\n/)) {
      const m = /^([a-z0-9_]+):([\w-]+)\s/i.exec(line);
      if (!m) continue;
      const [, engine, gameId] = m;
      engines[gameId] ??= [];
      if (!engines[gameId].includes(engine)) engines[gameId].push(engine);
      count++;
    }
    console.log(`${path.relative(exoRoot, dir)}: ${count} games`);
    listed++;
  } catch (err) {
    console.error(`${path.relative(exoRoot, dir)}: ${err.message}`);
    failed++;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The map is committed: a share that's offline, or a build that failed, would otherwise replace
// it with an empty or partial one.
if (!listed || failed) {
  console.error(failed ? `${failed} build(s) failed; ${out} left as it was.` : `No ScummVM builds found under ${exoRoot}; nothing written.`);
  process.exit(1);
}

const sorted = Object.fromEntries(Object.entries(engines).sort(([a], [b]) => a.localeCompare(b)));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(sorted, null, 1)}\n`);
const ambiguous = Object.entries(sorted).filter(([, e]) => e.length > 1);
console.log(`${Object.keys(sorted).length} game IDs written to ${out} (${ambiguous.length} used by more than one engine)`);
