import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Auth, isLocalNetwork, isThisPc } from '../server/lib/auth.js';
import { hostChecker } from '../server/lib/hosts.js';
import { PathResolver } from '../server/lib/paths.js';
import { rateLimit } from '../server/lib/ratelimit.js';
import { trimThumbs } from '../server/lib/thumbs.js';
import { ServerSettings } from '../server/lib/settings.js';
import { ROOM_COOKIE, mayPlay, roomGuards, sameOrigin, fromThisApp, ownerOnly } from '../server/lib/access.js';

test('PathResolver keeps paths inside its roots, and refuses file streams', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-paths-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-paths-out-'));
  t.after(() => [root, outside].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  fs.mkdirSync(path.join(root, 'Manuals'));
  fs.writeFileSync(path.join(root, 'Manuals', 'Game.pdf'), 'x');
  fs.writeFileSync(path.join(outside, 'notes.txt'), 'x');
  const resolver = new PathResolver(root);
  assert.equal(resolver.resolve('Manuals\\Game.pdf'), path.join(root, 'Manuals', 'Game.pdf'));
  assert.equal(resolver.resolve(path.join(root, 'Manuals', 'Game.pdf')), path.join(root, 'Manuals', 'Game.pdf'), 'absolute, under the root');
  assert.equal(resolver.resolve(path.join(outside, 'notes.txt')), null, 'absolute, elsewhere');
  assert.equal(resolver.resolve('..\\notes.txt'), null);
  assert.equal(resolver.resolve('Manuals\\Game.pdf:Zone.Identifier'), null);
  assert.equal(resolver.resolve('Manuals\\Game.pdf::$DATA'), null);
  assert.equal(PathResolver.within(root, 'Manuals/Game.pdf:x'), null);
});

test('hostChecker allows localhost, the PC\'s name, IP addresses and configured names only', () => {
  const known = hostChecker(['Games.Example.com'], 'GAMING-PC');
  for (const ok of ['localhost:3000', 'localhost', '127.0.0.1:3000', '192.168.1.20:3000', '[::1]:3000', '[fe80::1]',
    'gaming-pc:3000', 'gaming-pc.local', 'games.example.com', 'GAMES.example.com.']) {
    assert.ok(known(ok), ok);
  }
  for (const bad of ['evil.example:3000', 'localhost.evil.example', '127.0.0.1.nip.io', 'games.example.com.evil', '', undefined]) {
    assert.ok(!known(bad), String(bad));
  }
});

test('rateLimit answers 429 past the limit, per client', () => {
  const limit = rateLimit({ windowMs: 60_000, max: 2 });
  const call = (ip) => {
    let status = 0;
    let passed = false;
    const res = { set: () => res, status: (code) => { status = code; return res; }, json: () => res };
    limit({ ip }, res, () => { passed = true; });
    return passed ? 200 : status;
  };
  assert.deepEqual([call('1.1.1.1'), call('1.1.1.1'), call('1.1.1.1'), call('2.2.2.2')], [200, 200, 429, 200]);
});

test('rateLimit counts an IPv6 /64 as one client, and keeps a bounded map', () => {
  const limit = rateLimit({ windowMs: 60_000, max: 1, key: (req) => req.key });
  const call = (key) => {
    let status = 200;
    const res = { set: () => res, status: (code) => { status = code; return res; }, json: () => res };
    limit({ key }, res, () => {});
    return status;
  };
  assert.equal(call('2a01:4f8::1:2:3:4'), 200);
  assert.equal(call('2a01:4f8:0:0:5::'), 429, 'the same /64, written differently');
  assert.equal(call('2A01:4F8:0:0:ffff::9'), 429);
  assert.equal(call('2a01:4f8:0:1::1'), 200, 'the next /64');
  assert.equal(call('1.2.3.4'), 200);
  assert.equal(call('::ffff:1.2.3.5'), 200, 'an IPv4 address is one client');
  assert.equal(call('p@example.com'), 200);
  assert.equal(call('p@example.com'), 429);
  // A flood of addresses: the map stays bounded (checked by timing rather than size, since it's private).
  const started = Date.now();
  for (let i = 0; i < 30_000; i++) call(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
  assert.ok(Date.now() - started < 2000, 'no full pass over the map on each request');
});

test('isLocalNetwork: private and loopback addresses, never a request through Cloudflare', () => {
  const cases = [
    [{ ip: '127.0.0.1' }, true],
    [{ ip: '::1' }, true],
    [{ ip: '::ffff:192.168.1.5' }, true],
    [{ ip: '10.1.2.3' }, true],
    [{ ip: '172.15.255.255' }, false],
    [{ ip: '172.16.0.1' }, true],
    [{ ip: '172.31.255.255' }, true],
    [{ ip: '172.32.0.1' }, false],
    [{ ip: '169.254.10.1' }, true],
    [{ ip: '192.169.1.1' }, false],
    [{ ip: 'fd12:3456::1' }, true],
    [{ ip: 'fc00::1' }, true],
    [{ ip: 'fe80::1' }, true],
    [{ ip: 'febf::1' }, true],
    [{ ip: 'fec0::1' }, false],
    [{ ip: 'fd1::1' }, false, 'fd1:: is 0fd1::, not a private address'],
    [{ ip: '100.64.0.1' }, false],
    [{ ip: '203.0.113.9' }, false],
    [{ ip: '2001:db8::1' }, false],
    [{ ip: '127.0.0.1', headers: { 'cf-ray': 'x' } }, false],
    [{ ip: '127.0.0.1', headers: { 'cf-connecting-ip': '1.2.3.4' } }, false],
    [{ ip: undefined }, false],
  ];
  for (const [req, local, why] of cases) assert.equal(isLocalNetwork({ headers: {}, ...req }), local, why ?? `${req.ip} ${JSON.stringify(req.headers ?? {})}`);
});

test('Only a request made on this PC itself counts as this PC', () => {
  assert.equal(isThisPc({ headers: { host: 'localhost:6502' }, ip: '127.0.0.1' }), true);
  assert.equal(isThisPc({ headers: { host: 'localhost:6502' }, ip: '::1' }), true);
  assert.equal(isThisPc({ headers: { host: '192.168.1.20:6502' }, ip: '192.168.1.31' }), false, 'another device on the network');
  assert.equal(isThisPc({ headers: { host: 'games.example.com' }, ip: '127.0.0.1' }), false, 'a proxy on this PC');
  assert.equal(isThisPc({ headers: { host: 'localhost:6502', 'cf-ray': 'x' }, ip: '127.0.0.1' }), false, 'through Cloudflare');
});

test('Without accounts, the local network can do everything but the admin page, which is for this PC alone, and the internet only browse', () => {
  const none = new Auth({ settings: {}, file: 'unused' });
  const household = { owner: true, admin: false, play: true, favorites: true };
  assert.deepEqual(none.permissionsFor(null, { local: true }), household);
  assert.deepEqual(none.permissionsFor(null, { local: false, internet: false }), household);
  assert.deepEqual(none.permissionsFor(null, { local: true, thisPc: true }), { owner: true, admin: true, play: true, favorites: true }, 'at localhost');
  assert.equal(none.permissionsFor(null, { internet: true, thisPc: true }).admin, false, 'a tunnel on this PC is still the internet');
  assert.deepEqual(none.permissionsFor(null, { internet: true }), { owner: false, admin: false, play: false, favorites: false });
  const accounts = new Auth({ settings: { googleClientId: 'id', owner: 'me@example.com', players: ['p@example.com'] }, file: 'unused' });
  assert.deepEqual(accounts.permissionsFor({ email: 'me@example.com' }, { internet: true }), { owner: true, admin: true, play: true, favorites: true });
  assert.deepEqual(accounts.permissionsFor({ email: 'p@example.com' }, { internet: true }), { owner: false, admin: false, play: true, favorites: true });
  assert.deepEqual(accounts.permissionsFor(null, { internet: true }), { owner: false, admin: false, play: false, favorites: false });
});

test('The owner letting guests in gives anyone not signed in play and favorites, never the owner\'s things', () => {
  const guest = { owner: false, admin: false, play: true, favorites: true };
  const accounts = new Auth({ settings: { googleClientId: 'id', owner: 'me@example.com', players: ['p@example.com'] }, file: 'unused' });
  const on = { guestsCanPlay: true };
  assert.deepEqual(accounts.permissionsFor(null, { internet: true, ...on }), guest, 'through the tunnel');
  assert.deepEqual(accounts.permissionsFor(null, { local: true, ...on }), guest, 'on the network');
  assert.deepEqual(accounts.permissionsFor({ email: 'someone@example.com' }, { internet: true, ...on }), guest, 'an account not listed has as much as a guest');
  assert.deepEqual(accounts.permissionsFor({ email: 'me@example.com' }, { internet: true, ...on }), { owner: true, admin: true, play: true, favorites: true });
  // Off again: back to browsing.
  assert.deepEqual(accounts.permissionsFor(null, { internet: true, guestsCanPlay: false }), { owner: false, admin: false, play: false, favorites: false });
  assert.deepEqual(accounts.permissionsFor({ email: 'someone@example.com' }, { internet: true }), { owner: false, admin: false, play: false, favorites: true });
  // A server without accounts: the internet gets a guest's share while it's on.
  const none = new Auth({ settings: {}, file: 'unused' });
  assert.deepEqual(none.permissionsFor(null, { internet: true, ...on }), guest);
  assert.deepEqual(none.permissionsFor(null, { local: true, ...on }), { owner: true, admin: false, play: true, favorites: true });
});

// What the shelf shows by default, until the owner changes it (see SHELF_FLAGS).
const SHELF = { showBroken: false, showNonEnglish: false, showPrereleases: false, showNoImage: false, pcMultiplayerWithoutNetwork: false };

test('ServerSettings keeps the guests switch, and refuses anything but true or false', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-server-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'server.json');
  const store = new ServerSettings(file);
  const off = { guestsCanPlay: false, guestsUntil: null, publicUrl: null, shelfDefaults: SHELF, localLogins: false, localSignup: false };
  assert.deepEqual(await store.load(), off, 'off until turned on');
  assert.deepEqual(await store.update({ guestsCanPlay: true }), { guestsCanPlay: true, guestsUntil: null, publicUrl: null, shelfDefaults: SHELF, localLogins: false, localSignup: false });
  assert.equal(store.guestsCanPlay, true);
  assert.equal((await new ServerSettings(file).load()).guestsCanPlay, true, 'kept on disk');
  await assert.rejects(store.update({ guestsCanPlay: 'yes' }), /true or false/);
  assert.equal(store.guestsCanPlay, true, 'a refused change changes nothing');
  await store.update({ guestsCanPlay: false, somethingElse: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), off, 'only known settings are saved');
});

test('ServerSettings lets guests in until a time, then not', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-server-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'server.json');
  const store = new ServerSettings(file);
  const until = new Date(Date.now() + 60 * 60_000).toISOString();
  assert.deepEqual(await store.update({ guestsCanPlay: true, guestsUntil: until }), { guestsCanPlay: true, guestsUntil: until, publicUrl: null, shelfDefaults: SHELF, localLogins: false, localSignup: false });
  assert.equal(store.guestsCanPlayAt(Date.parse(until) - 1), true);
  assert.equal(store.guestsCanPlayAt(Date.parse(until)), false, 'over at that time');
  assert.deepEqual(store.get(Date.parse(until) + 1), { guestsCanPlay: false, guestsUntil: null, publicUrl: null, shelfDefaults: SHELF, localLogins: false, localSignup: false });
  assert.equal((await new ServerSettings(file).load()).guestsUntil, until, 'kept on disk');
  await assert.rejects(store.update({ guestsUntil: new Date(Date.now() - 1000).toISOString() }), /still to come/);
  await assert.rejects(store.update({ guestsUntil: 'soon' }), /still to come/);
  assert.deepEqual(await store.update({ guestsCanPlay: true, guestsUntil: null }), { guestsCanPlay: true, guestsUntil: null, publicUrl: null, shelfDefaults: SHELF, localLogins: false, localSignup: false }, 'until turned off');
  await store.update({ guestsCanPlay: true, guestsUntil: until });
  assert.deepEqual(await store.update({ guestsCanPlay: false }), { guestsCanPlay: false, guestsUntil: null, publicUrl: null, shelfDefaults: SHELF, localLogins: false, localSignup: false }, 'turning off forgets the time');
});

test('ServerSettings keeps a public address for invite links, only one this server answers to', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-server-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'server.json');
  const store = new ServerSettings(file);
  await store.load();
  const isKnownHost = hostChecker(['rgb.example.com'], 'gamepc');
  assert.equal((await store.update({ publicUrl: 'https://rgb.example.com/join/ABC?x=1' }, { isKnownHost })).publicUrl, 'https://rgb.example.com', 'only the origin is kept');
  assert.equal((await store.update({ publicUrl: '  rgb.example.com ' }, { isKnownHost })).publicUrl, 'https://rgb.example.com', 'https when typed without one');
  assert.equal((await new ServerSettings(file).load()).publicUrl, 'https://rgb.example.com', 'kept on disk');
  await assert.rejects(store.update({ publicUrl: 'https://elsewhere.example.net' }, { isKnownHost }), /allowedHosts/);
  for (const bad of ['ftp://rgb.example.com', 'javascript:alert(1)', 'https://user:pw@rgb.example.com', 42]) {
    await assert.rejects(store.update({ publicUrl: bad }, { isKnownHost }), /web address/, String(bad));
  }
  assert.equal(store.get().publicUrl, 'https://rgb.example.com', 'a refused address changes nothing');
  assert.equal((await store.update({ guestsCanPlay: true })).publicUrl, 'https://rgb.example.com', 'other changes leave it be');
  assert.equal((await store.update({ publicUrl: '' })).publicUrl, null, 'cleared');
});

test('trimThumbs deletes the oldest thumbnails once they pass the limit', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-thumbs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < 10; i++) {
    const file = path.join(dir, 'thumbs', `0${i % 2}`, `${i}.webp`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(100));
    const when = new Date(Date.now() - (10 - i) * 60000);
    fs.utimesSync(file, when, when);
  }
  assert.equal(await trimThumbs(dir, 2000), 0, 'under the limit: nothing goes');
  assert.equal(await trimThumbs(dir, 500), 6, 'down to 90% of the limit');
  const left = fs.readdirSync(path.join(dir, 'thumbs'), { recursive: true }).filter((n) => n.endsWith('.webp')).map((n) => path.basename(n)).sort();
  assert.deepEqual(left, ['6.webp', '7.webp', '8.webp', '9.webp']);
});

test('trimThumbs: a Clear (limit 0) that arrives during a trim still empties the cache', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-thumbs-clear-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < 20; i++) {
    const file = path.join(dir, 'thumbs', `0${i % 2}`, `${i}.webp`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(100));
  }
  const limitTrim = trimThumbs(dir, 1e12);
  const clear = trimThumbs(dir, 0);
  assert.equal(await limitTrim, 0);
  assert.equal(await clear, 20);
});

// The guards the server's routes use (see server/lib/access.js), with requests and responses faked.
function guardCall(guard, req) {
  const out = { status: 200, passed: false, body: null, headers: {} };
  const res = {
    set: (k, v) => { out.headers[k] = v; return res; },
    status: (code) => { out.status = code; return res; },
    json: (body) => { out.body = body; return res; },
  };
  guard({ headers: {}, params: {}, method: 'GET', can: {}, ...req }, res, () => { out.passed = true; });
  return out;
}

test('mayPlay lets players through and tells anyone else only "Not found"', () => {
  assert.equal(guardCall(mayPlay, { can: { play: true } }).passed, true);
  const refused = guardCall(mayPlay, { can: { play: false } });
  assert.deepEqual([refused.passed, refused.status, refused.body], [false, 404, { error: 'Not found' }]);
});

test('A room cookie lets a friend have its own version\'s files only, and a bad cookie is no cookie', () => {
  const rooms = { grants: (code, versionId) => code === 'ROOM1' && (versionId == null || versionId === 'v1') };
  const { roomGrant, mayPlayVersion, mayPlayShared } = roomGuards(rooms);
  const friend = (cookie, versionId) => ({ headers: { cookie }, params: { versionId }, can: { play: false } });
  assert.equal(roomGrant({ headers: { cookie: `a=b; ${ROOM_COOKIE}=ROOM1` } }), true);
  assert.equal(roomGrant({ headers: { cookie: `${ROOM_COOKIE}=%E0` } }), false, 'a malformed escape doesn\'t throw');
  assert.equal(roomGrant({ headers: {} }), false);
  assert.equal(roomGrant({ headers: { cookie: `x${ROOM_COOKIE}=ROOM1` } }), false, 'only the cookie of that name');

  assert.equal(guardCall(mayPlayVersion, friend(`${ROOM_COOKIE}=ROOM1`, 'v1')).passed, true);
  const otherVersion = guardCall(mayPlayVersion, friend(`${ROOM_COOKIE}=ROOM1`, 'v2'));
  assert.deepEqual([otherVersion.passed, otherVersion.status], [false, 404], 'another game gets the same 404 as anything missing');
  assert.equal(guardCall(mayPlayVersion, friend(`${ROOM_COOKIE}=%E0`, 'v1')).status, 404);
  assert.equal(guardCall(mayPlayVersion, { params: { versionId: 'v9' }, can: { play: true } }).passed, true, 'a player needs no room');

  // The MT-32 ROMs and soundfont every DOS game shares: any live room will do.
  assert.equal(guardCall(mayPlayShared, friend(`${ROOM_COOKIE}=ROOM1`)).passed, true);
  assert.equal(guardCall(mayPlayShared, friend(`${ROOM_COOKIE}=GONE`)).status, 404);
  assert.equal(guardCall(mayPlayShared, friend(undefined)).status, 404);
});

test('fromThisApp takes changes only with the app\'s header and no other site\'s origin', () => {
  const req = (headers) => ({ headers: { host: 'games.example.com', ...headers } });
  const header = { 'x-requested-with': 'RetroGameBrowser' };
  assert.equal(fromThisApp(req(header)), true, 'no Origin (same-origin GET-style requests)');
  assert.equal(fromThisApp(req({ ...header, origin: 'https://games.example.com' })), true);
  assert.equal(fromThisApp(req({ ...header, origin: 'https://evil.example' })), false);
  assert.equal(fromThisApp(req({ ...header, origin: 'null' })), false, 'an origin that isn\'t a URL');
  assert.equal(fromThisApp(req({})), false, 'without the header');
  assert.equal(fromThisApp(req({ 'x-requested-with': 'XMLHttpRequest' })), false);
  assert.equal(sameOrigin(req({ origin: 'http://games.example.com:8080' })), false, 'another port is another host');
});

test('The admin API answers the owner only, and takes changes only from the app', () => {
  const header = { 'x-requested-with': 'RetroGameBrowser', host: 'h' };
  const anon = guardCall(ownerOnly, { can: { play: true } });
  assert.deepEqual([anon.passed, anon.status, anon.headers['Cache-Control']], [false, 401, 'no-store']);
  const player = guardCall(ownerOnly, { user: { email: 'p@example.com' }, can: { play: true } });
  assert.deepEqual([player.passed, player.status], [false, 403]);
  assert.equal(guardCall(ownerOnly, { can: { owner: true, admin: true } }).passed, true, 'the owner reads');
  const household = guardCall(ownerOnly, { can: { owner: true, admin: false, play: true } });
  assert.deepEqual([household.passed, household.status], [false, 403], 'no accounts: the local network, but not this PC');
  const forged = guardCall(ownerOnly, { method: 'POST', headers: { host: 'h' }, can: { owner: true, admin: true } });
  assert.deepEqual([forged.passed, forged.status], [false, 403], 'a change without the app\'s header');
  assert.equal(guardCall(ownerOnly, { method: 'PUT', headers: header, can: { owner: true, admin: true } }).passed, true);
});

function fakeResponse() {
  const headers = {};
  return { headers, setHeader: (k, v) => { headers[k] = v; } };
}

test('Auth keeps an account\'s newest sessions only, and ignores a cookie it can\'t decode', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sessions.json');
  const auth = new Auth({ settings: { googleClientId: 'id', owner: 'me@example.com' }, file });
  const user = { email: 'someone@example.com', name: 'S', picture: '' };
  const cookies = [];
  for (let i = 0; i < 15; i++) {
    const res = fakeResponse();
    await auth.signIn({ secure: false }, res, user);
    cookies.push(res.headers['Set-Cookie'].split(';')[0]);
    await new Promise((r) => setTimeout(r, 2)); // distinct expiry times
  }
  await auth.signIn({ secure: false }, fakeResponse(), { ...user, email: 'other@example.com' });
  await auth.writing;
  const saved = Object.values(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(saved.filter((s) => s.email === user.email).length, 10);
  assert.equal(saved.filter((s) => s.email === 'other@example.com').length, 1);
  assert.equal(await auth.userFor({ headers: { cookie: cookies[0] } }), null, 'oldest session is gone');
  assert.equal((await auth.userFor({ headers: { cookie: cookies[14] } })).email, user.email);
  assert.equal(await auth.userFor({ headers: { cookie: 'rgb_session=%E0%A4' } }), null);
});

test('Auth doesn\'t save over a sessions file it can\'t read', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-auth-bad-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sessions.json');
  const broken = '{"tok": {"email": "a@example.com", "expi';
  fs.writeFileSync(file, broken);
  const auth = new Auth({ settings: { googleClientId: 'id' }, file });
  t.mock.method(console, 'warn', () => {});
  assert.equal(await auth.userFor({ headers: { cookie: 'rgb_session=tok' } }), null);
  await assert.rejects(auth.signIn({ secure: false }, fakeResponse(), { email: 'b@example.com' }), /isn't valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
});

test('Auth fails a sign-in whose session can\'t be saved, and still signs out when saving fails', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-auth-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sessions.json');
  const auth = new Auth({ settings: { googleClientId: 'id' }, file });
  const res = fakeResponse();
  await auth.signIn({ secure: false }, res, { email: 'a@example.com' });
  const cookie = res.headers['Set-Cookie'].split(';')[0];

  t.mock.method(console, 'warn', () => {});
  t.mock.method(fsp, 'open', async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  const failed = fakeResponse();
  await assert.rejects(auth.signIn({ secure: false }, failed, { email: 'b@example.com' }), /disk full/);
  assert.equal(failed.headers['Set-Cookie'], undefined, 'no cookie for a session that wasn\'t kept');
  assert.equal([...auth.sessions.values()].some((s) => s.email === 'b@example.com'), false);

  const out = fakeResponse();
  await auth.signOut({ secure: false, headers: { cookie } }, out);
  assert.match(out.headers['Set-Cookie'], /Max-Age=0/);
  t.mock.restoreAll();
  await auth.signIn({ secure: false }, fakeResponse(), { email: 'c@example.com' });
  assert.deepEqual(Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))).map((s) => s.email), ['c@example.com'], 'later saves still work');
});

test('isLocalNetwork: a request through this PC\'s loopback for a name that isn\'t local came through a tunnel', async () => {
  const os = await import('node:os');
  const local = (ip, host) => isLocalNetwork({ ip, headers: { host } });
  assert.equal(local('127.0.0.1', 'localhost:3000'), true);
  assert.equal(local('::1', '[::1]:3000'), true);
  assert.equal(local('127.0.0.1', '192.168.1.5:3000'), true);
  assert.equal(local('127.0.0.1', `${os.hostname()}:3000`), true, 'this PC\'s own name');
  assert.equal(local('127.0.0.1', 'games.example.com'), false, 'a public name through an ssh or other tunnel');
  assert.equal(local('192.168.1.20', 'games.example.com'), true, 'another machine on the network, however it names the server');
});
