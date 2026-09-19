// Which build this is: a fingerprint of the app's own code, worked out once when the server
// starts. The pages show it (and the multiplayer stats page checks it file by file), so that
// "are we running the latest code?" has an answer that doesn't depend on a cache somewhere
// between the browser and this PC: the git commit, whether anything is changed on top of it,
// and a hash of every file of the app's own, page by page.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** The first 12 hex digits of a SHA-256: enough to tell any two versions of a file apart. */
export const fileHash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);

const CODE = /\.(?:js|mjs|html|css|json)$/i;

/**
 * Every code file under `dir`, by its path from there with forward slashes and a leading
 * slash (the URL it's served at, for the public folder), to its hash.
 */
export function collectFiles(dir, root = dir, out = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(abs, root, out);
    else if (entry.isFile() && CODE.test(entry.name)) out[`/${path.relative(root, abs).split(path.sep).join('/')}`] = fileHash(fs.readFileSync(abs));
  }
  return out;
}

/**
 * The app's version as people see it: package.json's, without a patch number of 0 ("0.9" for
 * 0.9.0). The installer is named for it too (see installer/package.ps1).
 */
export function appVersion(root) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '').replace(/^(\d+\.\d+)\.0$/, '$1') || null;
  } catch {
    return null;
  }
}

/**
 * The git commit the working copy is at, and whether files are changed on top of it. An installed
 * copy has no git: installer/package.ps1 writes what the working copy was in build-info.json.
 */
export function gitState(root) {
  try {
    const baked = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8'));
    return { commit: baked.commit ?? null, dirty: baked.dirty ?? null };
  } catch {
    // Not an installed copy.
  }
  try {
    const rev = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 });
    if (rev.status !== 0) return { commit: null, dirty: null };
    // Without optional locks, so this never takes .git/index.lock while the owner is using git.
    const status = spawnSync('git', ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8', timeout: 5000 });
    return { commit: rev.stdout.trim() || null, dirty: status.status === 0 ? status.stdout.trim().length > 0 : null };
  } catch {
    return { commit: null, dirty: null };
  }
}

/**
 * The build: `build` is what a page shows ("99fb720+.3a1f9c2e": the commit, a plus when
 * something's changed on top of it, and the hash of all the code). `files` is each public
 * file's own hash, for checking what a browser actually got.
 */
export function buildInfo(root, { publicDir = path.join(root, 'public'), serverDir = path.join(root, 'server') } = {}) {
  const files = collectFiles(publicDir);
  const server = collectFiles(serverDir);
  const all = fileHash([...Object.entries(files), ...Object.entries(server).map(([k, v]) => [`server${k}`, v])].map(([k, v]) => `${k}=${v}`).join('\n'));
  const git = gitState(root);
  return {
    version: appVersion(root),
    build: `${git.commit ?? 'nogit'}${git.dirty ? '+' : ''}.${all.slice(0, 8)}`,
    commit: git.commit,
    dirty: git.dirty,
    codeHash: all,
    files,
    startedAt: new Date().toISOString(),
    node: process.version,
  };
}

/**
 * The build as it is now, for a server that's asked again and again: worked out afresh at most
 * every `maxAgeMs`, since that runs git and hashes every file, which holds the whole server up
 * for most of a tenth of a second. A file edited while the server runs still shows soon after.
 * `first`: the build worked out at startup, answered until then.
 */
export function recentBuild(root, { first = null, maxAgeMs = 5000, now = Date.now } = {}) {
  let info = first;
  let at = first ? now() : -Infinity;
  return () => {
    if (now() - at > maxAgeMs) {
      info = buildInfo(root);
      at = now();
    }
    return info;
  };
}
