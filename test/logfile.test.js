import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LogFile } from '../server/lib/logfile.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-log-'));

test('lines are stamped, marked by stream, and read back newest last', () => {
  const dir = tempDir();
  const log = new LogFile(dir, { now: () => new Date(2026, 8, 18, 9, 5, 7, 42) });
  log.write('out', 'Library loaded');
  log.write('err', 'first\nsecond');
  const text = fs.readFileSync(path.join(dir, 'server-2026-09-18.log'), 'utf8');
  assert.equal(text, '2026-09-18 09:05:07.042     Library loaded\n2026-09-18 09:05:07.042 err first\n2026-09-18 09:05:07.042 err second\n');
  assert.deepEqual(log.tail(2), ['2026-09-18 09:05:07.042 err first', '2026-09-18 09:05:07.042 err second']);
  assert.equal(log.tail(10, { errorsOnly: true }).length, 2);
});

test('terminal colours are left out', () => {
  const dir = tempDir();
  const log = new LogFile(dir, { now: () => new Date(2026, 8, 18) });
  log.write('out', '\x1b[31mred\x1b[0m');
  assert.match(log.tail(1)[0], / red$/);
});

test('a new day starts a new file, a full one goes on in a second part, and old days are deleted', () => {
  const dir = tempDir();
  let now = new Date(2026, 7, 1, 12);
  fs.writeFileSync(path.join(dir, 'server-2026-06-01.log'), 'old\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours\n');
  const log = new LogFile(dir, { keepDays: 30, maxFileBytes: 100, now: () => now });
  log.write('out', 'a'.repeat(120));
  log.write('out', 'next');
  now = new Date(2026, 7, 2, 12);
  log.write('out', 'tomorrow');
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, ['notes.txt', 'server-2026-08-01-2.log', 'server-2026-08-01.log', 'server-2026-08-02.log']);
  assert.deepEqual(log.tail(3).map((l) => l.slice(28)), ['a'.repeat(120), 'next', 'tomorrow']);
});

test('a server started again the same day carries on in that day\'s last part', () => {
  const dir = tempDir();
  const now = () => new Date(2026, 8, 18, 10);
  fs.writeFileSync(path.join(dir, 'server-2026-09-18-3.log'), 'earlier\n');
  new LogFile(dir, { now }).write('out', 'again');
  assert.equal(fs.readFileSync(path.join(dir, 'server-2026-09-18-3.log'), 'utf8').split('\n')[1].slice(28), 'again');
});
