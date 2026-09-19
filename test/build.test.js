import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInfo, collectFiles, fileHash, gitState, recentBuild } from '../server/lib/build.js';

test('collectFiles hashes the code files under a folder by their URL path, and nothing else', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-build-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'js'));
  fs.writeFileSync(path.join(dir, 'js', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>');
  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.alloc(4));
  const files = collectFiles(dir);
  assert.deepEqual(Object.keys(files), ['/index.html', '/js/app.js']);
  assert.equal(files['/js/app.js'], fileHash('console.log(1)'));
  assert.match(files['/index.html'], /^[0-9a-f]{12}$/);
  fs.writeFileSync(path.join(dir, 'js', 'app.js'), 'console.log(2)');
  assert.notEqual(collectFiles(dir)['/js/app.js'], files['/js/app.js'], 'a changed file changes its hash');
  assert.deepEqual(collectFiles(path.join(dir, 'nowhere')), {});
});

test('buildInfo names the build from the commit and the code, and carries the file hashes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-build-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'public'));
  fs.mkdirSync(path.join(root, 'server'));
  fs.writeFileSync(path.join(root, 'public', 'a.js'), 'a');
  fs.writeFileSync(path.join(root, 'server', 'index.js'), 'b');
  const info = buildInfo(root);
  assert.match(info.build, /^(nogit|[0-9a-f]{7,}\+?)\.[0-9a-f]{8}$/);
  assert.equal(info.files['/a.js'], fileHash('a'));
  assert.equal(info.files['/index.js'], undefined, 'server files are in the build, not the file list');
  assert.match(info.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  const again = buildInfo(root);
  assert.equal(again.codeHash, info.codeHash, 'the same code hashes the same');
  fs.writeFileSync(path.join(root, 'server', 'index.js'), 'c');
  assert.notEqual(buildInfo(root).codeHash, info.codeHash, 'a server change changes the build');
});

test('recentBuild works the build out again only once it is a few seconds old', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-build-recent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'public'));
  fs.writeFileSync(path.join(root, 'public', 'a.js'), 'a');
  let clock = 1000;
  const first = buildInfo(root);
  const current = recentBuild(root, { first, maxAgeMs: 5000, now: () => clock });
  fs.writeFileSync(path.join(root, 'public', 'a.js'), 'b');
  assert.equal(current(), first, 'within the time: the one it has');
  clock += 5001;
  assert.equal(current().files['/a.js'], fileHash('b'), 'then the file as it is now');
  assert.equal(recentBuild(root)().files['/a.js'], fileHash('b'), 'without a first build, one is worked out at once');
});

test('gitState answers for a folder that is no repository', () => {
  const state = gitState(os.tmpdir());
  assert.equal(typeof state, 'object');
  assert.ok('commit' in state && 'dirty' in state);
});
