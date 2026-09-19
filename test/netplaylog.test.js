import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NetplayLog } from '../server/lib/netplaylog.js';
import { NetplayRooms } from '../server/lib/netplay.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'rgb-netplay-log-'));
const room = (code) => ({ code, title: 'Contra', platform: 'NES', mode: 'rollback', gameId: 'g1', versionId: 'g1-0', hostName: 'Jeff' });

test('A session is written as it goes and summarised at its end', async () => {
  const dir = await tmp();
  const log = new NetplayLog({ dir, keep: 10 });
  const name = log.start(room('abc'));
  // Named by the time and a random id, never the room's code (a live room's code is its invitation).
  assert.match(name, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{12}\.jsonl$/);
  assert.ok(!name.includes('abc'));
  log.event('abc', 2, 'Ann', 'joined');
  assert.equal(log.sample('abc', 1, 'Jeff', { lag: 42.26, ping: 3, transport: 'direct', mode: 'rollback', ahead: 0, stalls: 0, rollbacks: 2, junk: 'x', hidden: false, peers: [{ p: 2, rtt: 3, transport: 'direct' }], events: ['f10 sync: state of 100 bytes', 7] }), true);
  assert.equal(log.sample('abc', 1, 'Jeff', { lag: 99 }), false, 'a second sample within the second is dropped');
  assert.equal(log.sample('abc', 2, 'Ann', { lag: 60, ping: 4, transport: 'server', stalls: 1, stalled: 30, hidden: true }), true);
  assert.equal(log.sample('nope', 1, 'Jeff', { lag: 1 }), false);

  const live = await log.list();
  assert.equal(live.length, 1);
  assert.equal(live[0].live, true);
  assert.equal(live[0].samples, 2);
  assert.deepEqual(live[0].players.map((p) => [p.p, p.name, p.lag, p.ping, p.transport]), [[1, 'Jeff', 42.3, 3, 'direct'], [2, 'Ann', 60, 4, 'server']]);

  const summary = await log.end('abc');
  assert.equal(summary.samples, 2);
  assert.equal(summary.events, 2, 'the join and the engine\'s line');
  assert.equal(await log.end('abc'), null);

  const lines = (await fs.readFile(path.join(dir, name), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ['session', 'event', 'sample', 'event', 'sample', 'end']);
  assert.equal(lines[0].title, 'Contra');
  assert.equal(lines[0].mode, 'rollback');
  assert.deepEqual(Object.keys(lines[2]).sort(), ['ahead', 'at', 'lag', 'mode', 'name', 'p', 'peers', 'ping', 'rollbacks', 'stalls', 'transport', 'type'], 'only known fields, and no junk');
  assert.equal(lines[2].lag, 42.3);
  assert.deepEqual(lines[2].peers, [{ p: 2, rtt: 3, transport: 'direct' }]);
  assert.equal(lines[3].what, 'f10 sync: state of 100 bytes');
  assert.equal(lines[4].hidden, true);
  assert.equal(lines[5].players[1].lag, 60);

  const listed = await log.list();
  assert.equal(listed[0].live, false);
  assert.equal(listed[0].ended, true);
  assert.equal(listed[0].players.length, 2);
  assert.ok(listed[0].duration >= 0);

  const full = await log.read(name);
  assert.equal(full.samples.length, 2);
  assert.equal(full.events.length, 2);
  assert.equal(full.end.samples, 2);
  assert.equal(await log.read('../etc/passwd'), null);
  assert.equal(await log.read('missing.jsonl'), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('Only the newest sessions are kept', async (t) => {
  const dir = await tmp();
  let now = Date.parse('2026-01-01T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const log = new NetplayLog({ dir, keep: 2 });
  for (const code of ['a', 'b', 'c']) {
    log.start(room(code));
    now += 1100; // the file names carry the second
    await log.end(code);
  }
  const names = (await fs.readdir(dir)).sort();
  assert.equal(names.length, 2);
  // The first one's gone: the two left are from the later seconds.
  assert.ok(names.every((n) => !n.startsWith('2026-01-01T00-00-00')));
  assert.equal((await log.list()).length, 2);
  await fs.rm(dir, { recursive: true, force: true });
});

test('The rooms feed the log: open starts it, joins and leaves are events, reports are samples, closing ends it', async (t) => {
  const dir = await tmp();
  const log = new NetplayLog({ dir, keep: 10 });
  // The rooms don't wait for a session's last write; the test does.
  t.mock.method(log, 'end');
  const rooms = new NetplayRooms({ log });
  const { code, key } = rooms.create({ gameId: 'g1', versionId: 'g1-0', title: 'Contra', hostName: 'Jeff', mode: 'rollback' });
  const mk = () => ({ emit() {}, disconnect() {} });
  const host = mk();
  const friend = mk();
  const extra = (userid, name) => ({ domain: 'x', game_id: 1, room_name: 'x', player_name: name, userid, sessionid: code });
  rooms.open({ extra: extra('h', 'Jeff'), key }, host);
  rooms.join({ extra: extra('f', 'Ann') }, friend);
  assert.equal(rooms.report(host, { lag: 40, ping: 2, transport: 'direct' }), true);
  assert.equal(rooms.report(friend, { lag: 50, ping: 2, transport: 'direct', events: ['f1 frame 0 found after 1 tick(s)'] }), true);
  assert.equal(rooms.report(mk(), { lag: 1 }), false, 'not in a room');
  rooms.leave(friend);
  rooms.leave(host);
  assert.equal(log.end.mock.callCount(), 1);
  await Promise.all(log.end.mock.calls.map((call) => call.result));
  const [listed] = await log.list();
  assert.equal(listed.ended, true);
  const full = await log.read(listed.name);
  assert.deepEqual(full.events.map((e) => [e.p, e.what]), [[2, 'joined'], [2, 'f1 frame 0 found after 1 tick(s)'], [2, 'left']]);
  assert.deepEqual(full.samples.map((s) => [s.p, s.name, s.lag]), [[1, 'Jeff', 40], [2, 'Ann', 50]]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('A log that goes missing mid-listing costs its own line, not the page', async (t) => {
  const dir = await tmp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = new NetplayLog({ dir, keep: 10 });
  const name = log.start(room('abc'));
  await log.end('abc');

  // An older session, which is pruned away between the listing and the read — the race the
  // page really runs into, since ending a session prunes the oldest (see #prune).
  const older = '2020-01-01T00-00-00-zzz.jsonl';
  await fs.writeFile(path.join(dir, older), `${JSON.stringify({ type: 'session', at: 1, title: 'Gone', platform: 'NES', mode: 'rollback', host: 'Jeff' })}\n`);
  const open = fs.open;
  t.mock.method(fs, 'open', (file, ...rest) => (String(file).endsWith(older)
    ? Promise.reject(Object.assign(new Error('no such file'), { code: 'ENOENT' }))
    : open.call(fs, file, ...rest)));

  const listed = await log.list();
  assert.deepEqual(listed.map((s) => s.name), [name], 'the session still there comes back, and the listing holds');
});

test('A log that can\'t be deleted stays for a later prune instead of failing the session\'s end', async (t) => {
  const dir = await tmp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const older = '2020-01-01T00-00-00-old.jsonl';
  await fs.writeFile(path.join(dir, older), `${JSON.stringify({ type: 'session', at: 1, title: 'Old', platform: 'NES', mode: 'rollback', host: 'Jeff' })}\n`);
  const log = new NetplayLog({ dir, keep: 1 });
  // What Windows says when another program holds the file open without sharing delete.
  const rm = fs.rm;
  t.mock.method(fs, 'rm', (file, ...rest) => (String(file).endsWith(older)
    ? Promise.reject(Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }))
    : rm.call(fs, file, ...rest)));
  t.mock.method(console, 'warn', () => {});

  log.start(room('abc'));
  const summary = await log.end('abc');
  assert.equal(summary.samples, 0, 'the session still ends with its summary');
  assert.ok((await fs.readdir(dir)).includes(older), 'the locked one is still there');
  assert.equal(console.warn.mock.callCount(), 1);
});

test('A session stops taking records at its size limit, and says so once', async (t) => {
  const dir = await tmp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-01-01T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const log = new NetplayLog({ dir, keep: 10, maxBytes: 2000 });
  const name = log.start(room('abc'));
  let accepted = 0;
  for (let i = 0; i < 50; i += 1) {
    now += 1000;
    if (log.sample('abc', 1, 'Jeff', { lag: 40, ping: 3, events: ['x'.repeat(150)] })) accepted += 1;
  }
  assert.ok(accepted > 0 && accepted < 50, `some samples got in, then no more (${accepted})`);
  assert.equal(log.event('abc', 2, 'Ann', 'joined'), false);
  const summary = await log.end('abc');
  assert.equal(summary.samples, accepted, 'the summary counts only what was written');

  const full = await log.read(name);
  assert.equal(full.samples.length, accepted);
  assert.equal(full.events.filter((e) => /size limit/.test(e.what)).length, 1);
  assert.ok(full.end, 'the end record is still written');
  const { size } = await fs.stat(path.join(dir, name));
  assert.ok(size < 4000, `the file stays near its limit (${size} bytes)`);
});
