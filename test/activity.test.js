import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityLog, clientOf, whoFor, summarize, filterEvents } from '../server/lib/activity.js';
import { Accounts } from '../server/lib/accounts.js';
import { Auth } from '../server/lib/auth.js';
import { LivePlays } from '../server/lib/playing.js';

const tempDir = (t, name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rgb-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('ActivityLog writes a file a month, reads it back, and keeps only known fields', async (t) => {
  const dir = tempDir(t, 'activity');
  const log = new ActivityLog({ dir });
  await log.record({ type: 'play', who: 'account', email: 'p@example.com', ip: '1.2.3.4', gameId: 'g1', title: 'Loom\u0000', secret: 'dropped' }, new Date('2026-08-31T23:00:00Z'));
  await log.record({ type: 'download', who: 'local', ip: '192.168.1.5', gameId: 'g1', bytes: 1234.4, complete: false }, new Date('2026-09-01T10:00:00Z'));
  assert.equal(await log.record({ type: 'nonsense', who: 'account' }), null);
  assert.equal(await log.record({ type: 'play', who: 'somebody' }), null);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-08.jsonl', '2026-09.jsonl']);

  const events = await new ActivityLog({ dir }).all();
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { t: '2026-08-31T23:00:00.000Z', type: 'play', who: 'account', email: 'p@example.com', ip: '1.2.3.4', gameId: 'g1', title: 'Loom ' });
  assert.deepEqual(events[1], { t: '2026-09-01T10:00:00.000Z', type: 'download', who: 'local', ip: '192.168.1.5', gameId: 'g1', bytes: 1234, complete: false });

  // A line cut short by a crash is skipped, not fatal, and the next event starts a line of its own.
  fs.appendFileSync(path.join(dir, '2026-09.jsonl'), '{"t":"2026-09-02T');
  const after = new ActivityLog({ dir });
  assert.equal((await after.all()).length, 2);
  await after.record({ type: 'visit', who: 'visitor', ip: '5.5.5.5' }, new Date('2026-09-03T00:00:00Z'));
  const reread = await new ActivityLog({ dir }).all();
  assert.equal(reread.length, 3);
  assert.equal(reread[2].ip, '5.5.5.5');
});

test('ActivityLog has an event on its way to disk as soon as record() is called', async (t) => {
  const dir = tempDir(t, 'activity');
  const log = new ActivityLog({ dir });
  await log.record({ type: 'visit', who: 'visitor', ip: '1.1.1.1' }, new Date('2026-09-16T10:00:00Z'));
  // As stopping the server does: plays ended without waiting, then only `writing` awaited.
  const plays = new LivePlays({ onEnd: (play, how) => log.record({ ...play, type: 'stop', how }) });
  plays.start({ who: 'guest', title: 'A' });
  plays.start({ who: 'guest', title: 'B' });
  for (const play of plays.list()) plays.end(play.id, 'lost');
  await log.writing;
  const onDisk = fs.readdirSync(dir).flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  assert.equal(onDisk.filter((e) => e.type === 'visit').length, 1);
  assert.deepEqual(onDisk.filter((e) => e.type === 'stop').map((e) => e.title).sort(), ['A', 'B']);
});

test('ActivityLog still writes events while a month can\'t be read, and reads them once it can', async (t) => {
  const dir = tempDir(t, 'activity');
  fs.mkdirSync(path.join(dir, '2026-07.jsonl')); // reading it fails (EISDIR)
  const log = new ActivityLog({ dir });
  t.mock.method(console, 'warn', () => {});
  await log.record({ type: 'play', who: 'owner' }, new Date('2026-09-01T00:00:00Z'));
  assert.match(fs.readFileSync(path.join(dir, '2026-09.jsonl'), 'utf8'), /"type":"play"/);
  fs.rmdirSync(path.join(dir, '2026-07.jsonl'));
  await log.record({ type: 'play', who: 'owner' }, new Date('2026-09-02T00:00:00Z'));
  assert.equal((await log.all()).length, 2, 'both, once each');
});

test('ActivityLog never gives two events the same millisecond, so paging by time skips none', async (t) => {
  const dir = tempDir(t, 'activity');
  const log = new ActivityLog({ dir });
  const when = new Date('2026-09-16T12:00:00.000Z');
  for (let i = 0; i < 5; i++) await log.record({ type: 'stop', who: 'guest', title: `G${i}` }, when);
  const events = await log.all();
  assert.equal(new Set(events.map((e) => e.t)).size, 5);
  const seen = [];
  let before = '';
  for (let page; (page = filterEvents(events, { before, limit: 2 })).length; before = page.at(-1).t) seen.push(...page.map((e) => e.title));
  assert.deepEqual(seen, ['G4', 'G3', 'G2', 'G1', 'G0']);
  // A log written before, with events sharing a millisecond, is read with them a millisecond apart.
  fs.writeFileSync(path.join(dir, '2026-08.jsonl'), ['a', 'b', 'c'].map((title) => JSON.stringify({ t: '2026-08-01T00:00:00.000Z', type: 'stop', who: 'guest', title })).join('\n'));
  const old = (await new ActivityLog({ dir }).all()).filter((e) => e.t < '2026-09');
  assert.deepEqual(old.map((e) => e.t.slice(20)), ['000Z', '001Z', '002Z']);
  // An event from long before is kept at its own time.
  assert.equal((await log.record({ type: 'play', who: 'owner' }, new Date('2026-07-01T00:00:00Z'))).t, '2026-07-01T00:00:00.000Z');
});

test('ActivityLog counts only so many visits from people not signed in each hour, and remembers at most so many visitors', async (t) => {
  const dir = tempDir(t, 'activity');
  const log = new ActivityLog({ dir, anonymousVisitsPerHour: 2 });
  const now = Date.parse('2026-09-16T12:10:00Z');
  assert.ok(await log.visit({ who: 'visitor', ip: '1.0.0.1' }, now));
  assert.ok(await log.visit({ who: 'visitor', ip: '1.0.0.2' }, now));
  assert.equal(log.visit({ who: 'visitor', ip: '1.0.0.3' }, now), null, 'over the hour\'s budget');
  assert.ok(await log.visit({ who: 'account', email: 'p@x', ip: '1.0.0.3' }, now), 'signed in: always counted');
  assert.ok(await log.visit({ who: 'visitor', ip: '1.0.0.3' }, now + 60 * 60_000), 'the next hour');

  const many = new ActivityLog({ dir: tempDir(t, 'activity'), maxVisitors: 50 });
  for (let i = 0; i < 50; i++) many.visit({ who: 'account', email: `p${i}@x` }, now);
  assert.equal(many.visits.size, 50);
  assert.equal(many.visit({ who: 'account', email: 'q@x' }, now + 1), null, 'full');
  assert.ok(many.visit({ who: 'account', email: 'q@x' }, now + 7 * 60 * 60_000), 'once the others\' time is up');
  assert.equal(many.visits.size, 1);
  await many.writing;
});

test('ActivityLog counts a visit once every few hours per person and address, and prunes old months', async (t) => {
  const dir = tempDir(t, 'activity');
  const log = new ActivityLog({ dir, keepMonths: 2 });
  const now = Date.parse('2026-09-16T12:00:00Z');
  assert.ok(await log.visit({ who: 'visitor', ip: '8.8.8.8' }, now));
  assert.equal(log.visit({ who: 'visitor', ip: '8.8.8.8' }, now + 60_000), null);
  assert.ok(await log.visit({ who: 'visitor', ip: '9.9.9.9' }, now + 60_000), 'another address');
  assert.ok(await log.visit({ who: 'visitor', ip: '8.8.8.8' }, now + 7 * 60 * 60_000), 'hours later');

  await log.record({ type: 'play', who: 'owner' }, new Date('2026-07-01T00:00:00Z'));
  await log.record({ type: 'play', who: 'owner' }, new Date('2026-08-15T00:00:00Z'));
  assert.equal(await log.prune(new Date('2026-09-16T00:00:00Z')), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-08.jsonl', '2026-09.jsonl']);
  assert.ok((await log.all()).every((e) => e.t >= '2026-08'));
});

test('clientOf takes the visitor\'s address from a tunnel on this PC only', () => {
  const headers = { 'cf-connecting-ip': '203.0.113.9', 'cf-ipcountry': 'NL', 'user-agent': 'Firefox' };
  assert.deepEqual(clientOf({ headers, ip: '127.0.0.1', socketAddress: '::ffff:127.0.0.1', internet: true }), { ip: '203.0.113.9', country: 'NL', via: 'internet', agent: 'Firefox' });
  // Someone on the network sending the header themselves is logged under their own address.
  assert.deepEqual(clientOf({ headers, ip: '::ffff:192.168.1.7', socketAddress: '::ffff:192.168.1.7' }), { ip: '192.168.1.7', country: undefined, via: 'local', agent: 'Firefox' });
});

test('whoFor tells the owner, accounts, the local network, guests, visitors and friends apart', () => {
  const nobody = { owner: false, admin: false, play: false, favorites: false };
  assert.equal(whoFor({ user: { email: 'me' }, can: { owner: true } }), 'owner');
  assert.equal(whoFor({ user: { email: 'p' }, can: { owner: false } }), 'account');
  assert.equal(whoFor({ user: null, can: { owner: true } }), 'owner', 'no accounts on this server');
  assert.equal(whoFor({ user: null, can: nobody, local: true }), 'local');
  assert.equal(whoFor({ user: null, can: nobody, local: false, guestsCanPlay: true }), 'guest');
  assert.equal(whoFor({ user: null, can: nobody, local: false }), 'visitor');
  assert.equal(whoFor({ user: null, can: nobody, friend: true }), 'friend');
});

test('summarize counts by who, day, game and person, within the period', () => {
  const now = Date.parse('2026-09-16T12:00:00');
  const at = (daysAgo) => new Date(now - daysAgo * 24 * 60 * 60_000).toISOString();
  const events = [
    { t: at(40), type: 'play', who: 'owner', email: 'me@x', gameId: 'old', title: 'Old', platform: 'MS-DOS' },
    { t: at(2), type: 'play', who: 'account', email: 'p@x', name: 'P', ip: '1.1.1.1', gameId: 'a', title: 'A', platform: 'SNES' },
    { t: at(2), type: 'play', who: 'local', ip: '192.168.1.2', gameId: 'a', title: 'A', platform: 'SNES' },
    { t: at(1), type: 'play', who: 'guest', ip: '5.5.5.5', country: 'DE', gameId: 'b', title: 'B', platform: 'MS-DOS' },
    { t: at(1), type: 'download', who: 'guest', ip: '5.5.5.5', gameId: 'b', title: 'B', bytes: 100, complete: false },
    { t: at(1), type: 'download', who: 'account', email: 'p@x', gameId: 'a', title: 'A', bytes: 50, complete: true },
    { t: at(0), type: 'failed', who: 'local', ip: '192.168.1.2', gameId: 'c', versionId: 'c-1', title: 'C', message: 'Didn\'t start' },
    { t: at(0), type: 'visit', who: 'visitor', ip: '6.6.6.6' },
    { t: at(0), type: 'join', who: 'friend', ip: '7.7.7.7', name: 'Sam' },
    { t: at(2), type: 'stop', who: 'account', email: 'p@x', ip: '1.1.1.1', gameId: 'a', title: 'A', platform: 'SNES', seconds: 600, how: 'left' },
    { t: at(1), type: 'stop', who: 'guest', ip: '5.5.5.5', gameId: 'b', title: 'B', platform: 'MS-DOS', seconds: 90, how: 'lost' },
  ];
  const s = summarize(events, { days: 7, now });
  assert.deepEqual(s.totals.plays, { owner: 0, account: 1, local: 1, guest: 1, visitor: 0, friend: 0 });
  assert.deepEqual(s.totals.downloads, { owner: 0, account: 1, local: 0, guest: 1, visitor: 0, friend: 0 });
  assert.equal(s.totals.downloadBytes.guest, 100);
  assert.equal(s.totals.downloadsUnfinished, 1);
  assert.equal(s.totals.failures, 1);
  assert.equal(s.totals.joined, 1);
  assert.equal(s.totals.visits.visitor, 1);
  assert.equal(s.byDay.length, 7, 'every day of the period');
  assert.deepEqual(s.byDay.at(-3), { day: s.byDay.at(-3).day, signedIn: 1, notSignedIn: 1, downloads: 0, seconds: 600 });
  assert.deepEqual(s.totals.seconds, { owner: 0, account: 600, local: 0, guest: 90, visitor: 0, friend: 0 });
  assert.deepEqual(s.topGames.map((g) => [g.gameId, g.plays, g.people, g.seconds]), [['a', 2, 2, 600], ['b', 1, 1, 90]]);
  assert.deepEqual(s.topDownloads.map((g) => g.gameId).sort(), ['a', 'b']);
  assert.deepEqual(s.platforms, [{ platform: 'SNES', plays: 2, seconds: 600 }, { platform: 'MS-DOS', plays: 1, seconds: 90 }]);
  assert.deepEqual(s.people.map((p) => [p.email, p.plays, p.downloads, p.seconds]), [['p@x', 1, 1, 600]]);
  assert.equal(s.accountsActive, 1);
  assert.equal(s.anonymousAddresses, 4, 'the local network, the guest, the visitor and the friend');
  assert.deepEqual(s.failures.map((f) => [f.versionId, f.count]), [['c-1', 1]]);

  const all = summarize(events, { days: 0, now });
  assert.equal(all.totals.plays.owner, 1, 'all time includes the old play');
  assert.equal(all.byDay.length, 41);
});

test('summarize counts the same calendar days as the chart shows', () => {
  const now = new Date(2026, 8, 16, 10, 0).getTime();
  const events = [
    { t: new Date(2026, 8, 15, 23, 0).toISOString(), type: 'play', who: 'guest', ip: '5.5.5.5', gameId: 'a' },
    { t: new Date(2026, 8, 16, 0, 30).toISOString(), type: 'play', who: 'guest', ip: '5.5.5.5', gameId: 'b' },
  ];
  const today = summarize(events, { days: 1, now });
  assert.equal(today.totals.plays.guest, 1, "last night's play isn't today's");
  assert.deepEqual(today.topGames.map((g) => g.gameId), ['b']);
  assert.equal(today.byDay.length, 1);
  assert.equal(today.byDay[0].notSignedIn, 1);
  assert.equal(Date.parse(today.from), new Date(2026, 8, 16).getTime());
  assert.equal(summarize(events, { days: 2, now }).totals.plays.guest, 2);
});

test('filterEvents goes newest first, narrows by type, who and words, and pages by time', () => {
  const events = Array.from({ length: 5 }, (_, i) => ({ t: `2026-09-0${i + 1}T00:00:00.000Z`, type: i % 2 ? 'play' : 'visit', who: i < 2 ? 'account' : 'guest', email: i < 2 ? 'p@x' : undefined, ip: `10.0.0.${i}`, title: i === 3 ? 'Monkey Island' : undefined }));
  assert.deepEqual(filterEvents(events).map((e) => e.t.slice(8, 10)), ['05', '04', '03', '02', '01']);
  assert.deepEqual(filterEvents(events, { type: 'play' }).map((e) => e.t.slice(8, 10)), ['04', '02']);
  assert.deepEqual(filterEvents(events, { who: 'signed-in' }).map((e) => e.t.slice(8, 10)), ['02', '01']);
  assert.deepEqual(filterEvents(events, { who: 'not-signed-in', limit: 2 }).map((e) => e.t.slice(8, 10)), ['05', '04']);
  assert.deepEqual(filterEvents(events, { q: 'monkey' }).map((e) => e.t.slice(8, 10)), ['04']);
  assert.deepEqual(filterEvents(events, { before: '2026-09-03T00:00:00.000Z' }).map((e) => e.t.slice(8, 10)), ['02', '01']);
});

test('Accounts: config players can play until the owner says otherwise, and the owner can\'t be changed', async (t) => {
  const dir = tempDir(t, 'accounts');
  const file = path.join(dir, 'accounts.json');
  const accounts = await new Accounts({ file, owner: 'Me@Example.com', players: ['p@example.com'] }).load();
  assert.equal(accounts.access('me@example.com'), 'owner');
  assert.equal(accounts.access('P@example.com'), 'play');
  assert.equal(accounts.access('new@example.com'), 'browse');

  await accounts.seen({ email: 'new@example.com', name: 'New', picture: 'https://lh3.googleusercontent.com/x' }, { signIn: true, now: new Date('2026-09-16T10:00:00Z') });
  await accounts.setAccess('p@example.com', 'browse');
  await accounts.setAccess('friend@example.com', 'play');
  await assert.rejects(accounts.setAccess('me@example.com', 'blocked'), /owner/);
  await assert.rejects(accounts.setAccess('new@example.com', 'admin'), /Access must be/);
  await assert.rejects(accounts.setAccess('not an address', 'play'), /email/);

  const again = await new Accounts({ file, owner: 'me@example.com', players: ['p@example.com'] }).load();
  assert.equal(again.access('p@example.com'), 'browse', 'the owner\'s choice beats the config');
  assert.equal(again.access('friend@example.com'), 'play', 'added before signing in');
  const list = again.list();
  assert.deepEqual(list.map((a) => [a.email, a.access, a.fromConfig, a.isNew]).sort(), [
    ['friend@example.com', 'play', false, false], ['me@example.com', 'owner', false, false], ['new@example.com', 'browse', false, true], ['p@example.com', 'browse', false, false],
  ]);
  await again.setAccess('new@example.com', 'browse');
  assert.equal(again.list().find((a) => a.email === 'new@example.com').isNew, false, 'decided: no longer new, though still browsing');
  const config = await new Accounts({ file: path.join(dir, 'none.json'), players: ['listed@example.com'] }).load();
  assert.deepEqual(config.list().map((a) => [a.email, a.fromConfig, a.isNew]), [['listed@example.com', true, false]], 'a config player who never signed in');
  assert.equal(list[0].email, 'new@example.com', 'most recently seen first');
  assert.equal(list[0].name, 'New');
});

test('Auth: a blocked account can\'t sign in, loses its sessions, and plays by the rules for someone not signed in', async (t) => {
  const dir = tempDir(t, 'auth');
  const accounts = await new Accounts({ file: path.join(dir, 'accounts.json'), owner: 'me@example.com', players: ['p@example.com'] }).load();
  const auth = new Auth({ settings: { googleClientId: 'id', owner: 'me@example.com' }, file: path.join(dir, 'sessions.json'), accounts });
  const res = { setHeader: () => {} };
  const user = { email: 'p@example.com', name: 'P', picture: '' };
  // The cookie the browser is given: the file keeps only its token's hash.
  const first = { setHeader(name, value) { this.cookie = value.split(';')[0]; } };
  await auth.signIn({ secure: false }, first, user);
  await auth.signIn({ secure: false }, res, user);
  await auth.signIn({ secure: false }, res, { email: 'other@example.com' });
  assert.deepEqual(auth.permissionsFor(user, { internet: true }), { owner: false, admin: false, play: true, favorites: true }, 'a config player plays');
  assert.equal((await auth.sessionCounts()).get('p@example.com').sessions, 2);

  const req = { headers: { cookie: first.cookie } };
  assert.ok(![...auth.sessions.keys()].includes(first.cookie.split('=')[1]), 'the token itself isn\'t kept');
  assert.equal((await auth.userFor(req)).email, 'p@example.com');

  await accounts.setAccess('p@example.com', 'blocked');
  assert.equal(await auth.userFor(req), null, 'a blocked session counts for nothing');
  await assert.rejects(auth.signIn({ secure: false }, res, user), /can't sign in/);
  assert.equal(await auth.endSessions('p@example.com'), 2);
  assert.equal((await auth.sessionCounts()).get('p@example.com'), undefined);
  assert.equal((await auth.sessionCounts()).get('other@example.com').sessions, 1, 'others keep theirs');

  await accounts.setAccess('p@example.com', 'browse');
  assert.deepEqual(auth.permissionsFor(user, { internet: true }), { owner: false, admin: false, play: false, favorites: true });
});

test('LivePlays counts the time a game was on screen, and ends plays that stop checking in', () => {
  const ended = [];
  const plays = new LivePlays({ onEnd: (play, how) => ended.push([play.title, play.seconds, how]), timeoutMs: 150_000, maxGapMs: 90_000 });
  const t0 = 1_000_000;
  const a = plays.start({ title: 'A', email: 'p@x' }, t0);
  const b = plays.start({ title: 'B' }, t0);
  assert.equal(plays.beat(a, { visible: true }, t0 + 30_000), true);
  assert.equal(plays.beat(a, { visible: false }, t0 + 60_000), true, 'on screen until now, then hidden');
  assert.equal(plays.beat(a, { visible: true }, t0 + 120_000), true, 'the hidden minute isn\'t counted');
  assert.deepEqual(plays.list(t0 + 130_000).map((p) => [p.title, p.seconds]), [['A', 70], ['B', 90]], 'time so far, a quiet one at most the longest gap');
  assert.equal(plays.end(a, 'left', t0 + 150_000), true);
  assert.equal(plays.end(a, 'left', t0 + 151_000), false, 'once');
  assert.deepEqual(ended, [['A', 90, 'left']]);
  // B never checked in: past the timeout it's lost, counting nothing after its last check-in, and
  // its check-in then starts a new stretch.
  assert.equal(plays.beat(b, {}, t0 + 200_000), true);
  assert.deepEqual(ended[1], ['B', 0, 'lost']);
  plays.end(b, 'left', t0 + 230_000);
  assert.deepEqual(ended[2], ['B', 30, 'left']);
  // A computer that slept between check-ins counts the longest gap allowed at most.
  const c = plays.start({ title: 'C' }, t0);
  plays.beat(c, {}, t0 + 140_000);
  plays.end(c, 'left', t0 + 140_000);
  assert.deepEqual(ended[3], ['C', 90, 'left']);
  assert.equal(plays.list(t0 + 140_000).length, 0);
});

test('LivePlays picks a play back up when its page checks in again after going quiet', () => {
  const ended = [];
  const plays = new LivePlays({ onEnd: (play, how) => ended.push([play.title, play.seconds, how, play.email]), resumeMs: 3_600_000, max: 3 });
  const t0 = 1_000_000;
  // A phone switched to another app for three minutes, then back on the game for a minute.
  const a = plays.start({ title: 'A', email: 'p@x' }, t0);
  plays.beat(a, { visible: true }, t0 + 30_000);
  plays.sweep(t0 + 210_000);
  assert.deepEqual(ended, [['A', 30, 'lost', 'p@x']]);
  assert.equal(plays.beat(a, { visible: true }, t0 + 210_000), true, 'back');
  assert.equal(plays.beat(a, { visible: true }, t0 + 240_000), true);
  assert.deepEqual(plays.list(t0 + 240_000).map((p) => [p.title, p.seconds, p.email]), [['A', 30, 'p@x']], 'the time away isn\'t counted');
  assert.equal(plays.end(a, 'left', t0 + 270_000), true);
  assert.deepEqual(ended[1], ['A', 60, 'left', 'p@x'], 'the new stretch, logged on its own');

  // A page that said it left doesn't come back; nor does one gone longer than resumeMs.
  const b = plays.start({ title: 'B' }, t0);
  plays.sweep(t0 + 200_000);
  assert.equal(plays.end(b, 'left', t0 + 200_000), false);
  assert.equal(plays.beat(b, {}, t0 + 201_000), false);
  const c = plays.start({ title: 'C' }, t0);
  assert.equal(plays.beat(c, {}, t0 + 2 * 3_600_000), false, 'lost, and too long ago');
  const d = plays.start({ title: 'D' }, t0);
  plays.sweep(t0 + 200_000);
  assert.equal(plays.lost.has(d), true);
  plays.sweep(t0 + 3_600_001);
  assert.equal(plays.lost.has(d), false, 'forgotten by the sweep');

  // At most max are remembered.
  for (let i = 0; i < 5; i++) plays.start({ title: `L${i}` }, t0);
  plays.sweep(t0 + 200_000);
  assert.ok(plays.lost.size <= 3);
});

test('LivePlays past its limit ends the play that checked in longest ago', () => {
  const ended = [];
  const plays = new LivePlays({ max: 2, onEnd: (play, how) => ended.push([play.title, how]) });
  const real = plays.start({ title: 'Real' }, 0);
  plays.start({ title: 'Fake' }, 1);
  plays.beat(real, {}, 30_000);
  plays.start({ title: 'New' }, 30_001);
  assert.deepEqual(ended, [['Fake', 'lost']]);
});

test('LivePlays keeps at most `max` plays, ending the oldest', () => {
  const ended = [];
  const plays = new LivePlays({ max: 2, onEnd: (play, how) => ended.push([play.title, how]) });
  plays.start({ title: 'A' }, 0);
  plays.start({ title: 'B' }, 1);
  plays.start({ title: 'C' }, 2);
  assert.deepEqual(ended, [['A', 'lost']]);
  assert.deepEqual(plays.list(3).map((p) => p.title), ['B', 'C']);
});

test('Accounts: an account added before it signs in is first seen when it does, and a pending lastSeen is saved on flush', async (t) => {
  const dir = tempDir(t, 'accounts');
  const file = path.join(dir, 'accounts.json');
  const accounts = await new Accounts({ file, owner: 'me@example.com' }).load();
  await accounts.setAccess('friend@example.com', 'play');
  assert.equal(accounts.list().find((a) => a.email === 'friend@example.com').firstSeen, null, 'not come yet');
  await accounts.seen({ email: 'friend@example.com', name: 'F' }, { signIn: true, now: new Date('2026-09-16T10:00:00Z') });
  assert.equal(accounts.list().find((a) => a.email === 'friend@example.com').firstSeen, '2026-09-16T10:00:00.000Z');

  accounts.seen({ email: 'friend@example.com' }, { now: new Date('2026-09-16T11:00:00Z') });
  assert.ok(accounts.timer, 'saved a little later');
  await accounts.flush();
  assert.equal(accounts.timer, null);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['friend@example.com'].lastSeen, '2026-09-16T11:00:00.000Z');
});
