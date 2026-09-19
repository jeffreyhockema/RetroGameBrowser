import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalUsers, localEmail, localUsername, usernameProblem, passwordProblem } from '../server/lib/localusers.js';
import { Auth } from '../server/lib/auth.js';
import { Accounts } from '../server/lib/accounts.js';

const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-local-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const fakeResponse = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });

test('Local accounts are known by an address no Google account can have', () => {
  assert.equal(localEmail(' Jeff '), 'jeff@local');
  assert.equal(localUsername('jeff@local'), 'jeff');
  assert.equal(localUsername('jeff@local.example.com'), null);
  assert.equal(localUsername('jeff@gmail.com'), null);
  assert.equal(localUsername('bad name@local'), null);
  assert.equal(usernameProblem('ok.name_1'), null);
  assert.ok(usernameProblem('a'), 'too short');
  assert.ok(usernameProblem('has space'));
  assert.ok(usernameProblem('-starts-with-dash'));
  assert.ok(passwordProblem('short'));
  assert.equal(passwordProblem('long enough'), null);
});

test('LocalUsers keeps only a hash, checks passwords, and survives a restart', async (t) => {
  const file = path.join(tempDir(t), 'local-users.json');
  const users = await new LocalUsers(file).load();
  const made = await users.create({ username: 'Jeff', name: 'Jeff H', password: 'correct horse' });
  assert.deepEqual(made, { email: 'jeff@local', name: 'Jeff H', picture: '' });

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('correct horse'), 'the password itself is never written');
  assert.match(JSON.parse(text).users.jeff.hash, /^scrypt\$32768\$8\$3\$/);

  const again = await new LocalUsers(file).load();
  assert.equal((await again.verify('JEFF', 'correct horse'))?.email, 'jeff@local', 'usernames ignore case');
  assert.equal(await again.verify('jeff', 'wrong password'), null);
  assert.equal(await again.verify('nobody', 'correct horse'), null);
  assert.equal(await again.verify('jeff', 12345678), null);

  await assert.rejects(again.create({ username: 'jeff', password: 'another one' }), /taken/);
  await assert.rejects(again.create({ username: 'x', password: 'another one' }), /username/);
  await assert.rejects(again.create({ username: 'bob', password: 'short' }), /8 characters/);

  await again.setPassword('jeff', 'battery staple');
  assert.equal(await again.verify('jeff', 'correct horse'), null, 'the old password stops working');
  assert.ok(await again.verify('jeff', 'battery staple'));
});

test('LocalUsers has one owner at most, whose account can\'t be deleted', async (t) => {
  const file = path.join(tempDir(t), 'local-users.json');
  const users = await new LocalUsers(file).load();
  await users.create({ username: 'boss', password: 'owner password', owner: true });
  await assert.rejects(users.create({ username: 'boss2', password: 'owner password', owner: true }), /owner/);
  await users.create({ username: 'kid', password: 'kid password' });
  assert.equal(users.owner(), 'boss');
  await assert.rejects(users.remove('boss'), /owner/);
  await users.remove('kid');
  assert.equal(users.has('kid'), false);
  assert.equal((await new LocalUsers(file).load()).has('kid'), false, 'kept on disk');

  // A file edited by hand to name two owners keeps only the first.
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.users.second = { ...data.users.boss, owner: true };
  fs.writeFileSync(file, JSON.stringify(data));
  const reread = await new LocalUsers(file).load();
  assert.equal(reread.list().filter((u) => u.owner).length, 1);
});

test('A local account signs in only while local accounts are on, and its owner is the owner', async (t) => {
  const dir = tempDir(t);
  const users = await new LocalUsers(path.join(dir, 'local-users.json')).load();
  await users.create({ username: 'boss', name: 'Boss', password: 'owner password', owner: true });
  await users.create({ username: 'kid', password: 'kid password' });
  let on = true;
  const accounts = await new Accounts({ file: path.join(dir, 'accounts.json'), localOwner: () => localEmail(users.owner()) }).load();
  const auth = new Auth({ settings: {}, file: path.join(dir, 'sessions.json'), accounts, localUsers: users, localLogins: () => on });

  assert.equal(auth.google, false);
  assert.equal(auth.enabled, true, 'local accounts alone are accounts');
  const res = fakeResponse();
  await auth.signIn({ secure: false }, res, users.user('boss'));
  const req = { headers: { cookie: res.headers['Set-Cookie'].split(';')[0] } };
  const boss = await auth.userFor(req);
  assert.deepEqual(boss, { email: 'boss@local', name: 'Boss', picture: '', local: true, username: 'boss' });
  assert.equal(auth.permissionsFor(boss).owner, true);

  // Someone on the local network who isn't signed in isn't the owner any more.
  assert.equal(auth.permissionsFor(null, { local: true }).owner, false);
  const kid = users.user('kid');
  assert.deepEqual(auth.permissionsFor(kid), { owner: false, admin: false, play: false, favorites: true }, 'a new account browses');

  // Off: the session counts for nothing, and with no accounts left everyone local is the owner again.
  on = false;
  assert.equal(await auth.userFor(req), null);
  assert.equal(auth.enabled, false);
  assert.equal(auth.permissionsFor(null, { local: true }).owner, true);

  // On again, but the account deleted: its session counts for nothing either.
  on = true;
  const kidRes = fakeResponse();
  await auth.signIn({ secure: false }, kidRes, kid);
  await users.remove('kid');
  assert.equal(await auth.userFor({ headers: { cookie: kidRes.headers['Set-Cookie'].split(';')[0] } }), null);

  // Ending every local account's sessions leaves the others.
  await auth.signIn({ secure: false }, fakeResponse(), { email: 'someone@example.com', name: '', picture: '' });
  const ended = await auth.endSessions((email) => email.endsWith('@local'));
  assert.equal(ended, 2);
  assert.equal([...(await auth.load()).values()].map((s) => s.email).join(), 'someone@example.com');
});

test('With Google set up, the config\'s owner stays the owner and a Google session needs Google', async (t) => {
  const dir = tempDir(t);
  const users = await new LocalUsers(path.join(dir, 'local-users.json')).load();
  await users.create({ username: 'boss', password: 'owner password', owner: true });
  // index.js hands Accounts a local owner only when the config names none.
  const accounts = await new Accounts({ file: path.join(dir, 'accounts.json'), owner: 'me@example.com', localOwner: () => null }).load();
  const auth = new Auth({ settings: { googleClientId: 'id', owner: 'me@example.com' }, file: path.join(dir, 'sessions.json'), accounts, localUsers: users, localLogins: () => true });
  assert.equal(auth.permissionsFor(users.user('boss')).owner, false);
  assert.equal(auth.permissionsFor({ email: 'me@example.com' }).owner, true);
});

test('A password that\'s among the most common, or the username, isn\'t allowed', () => {
  assert.match(passwordProblem('password1'), /most commonly used/);
  assert.match(passwordProblem('QwErTyUiOp'), /most commonly used/, 'whatever the case');
  assert.match(passwordProblem('jeffhockema', { username: 'jeffhockema' }), /username/);
  assert.match(passwordProblem('retrogamebrowser1'), /easy to guess/);
  assert.equal(passwordProblem('mauve tractor lantern'), null);
});

test('A new password, or a deleted and remade account, ends every earlier session (its uid)', async (t) => {
  const dir = tempDir(t);
  const users = await new LocalUsers(path.join(dir, 'local-users.json')).load();
  await users.create({ username: 'kid', password: 'kid password 1' });
  const auth = new Auth({ settings: {}, file: path.join(dir, 'sessions.json'), localUsers: users, localLogins: () => true });
  const res = fakeResponse();
  await auth.signIn({ secure: false }, res, users.user('kid'));
  const req = { headers: { cookie: res.headers['Set-Cookie'].split(';')[0] } };
  assert.equal((await auth.userFor(req))?.username, 'kid');

  // A new password: the session counts for nothing, even left in the file (a save that failed).
  await users.setPassword('kid', 'kid password 2');
  assert.equal(await auth.userFor(req), null);

  const res2 = fakeResponse();
  await auth.signIn({ secure: false }, res2, users.user('kid'));
  const req2 = { headers: { cookie: res2.headers['Set-Cookie'].split(';')[0] } };
  await users.remove('kid');
  await users.create({ username: 'kid', password: 'someone else 3' });
  assert.equal(await auth.userFor(req2), null, 'a new account with the same username doesn\'t get the old one\'s sessions');
});

test('Sessions: hashed at rest, a __Host- cookie over https, and an http one not honoured from the internet', async (t) => {
  const dir = tempDir(t);
  const auth = new Auth({ settings: { googleClientId: 'id' }, file: path.join(dir, 'sessions.json') });
  const user = { email: 'a@example.com', name: 'A', picture: '' };
  const secure = fakeResponse();
  await auth.signIn({ secure: true }, secure, user);
  assert.match(secure.headers['Set-Cookie'], /^__Host-rgb_session=[^;]+; Path=\/; .*Secure/);
  const token = secure.headers['Set-Cookie'].split(';')[0].split('=')[1];
  assert.ok(!fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8').includes(token), 'only the hash is written');
  assert.equal((await auth.userFor({ secure: true, headers: { cookie: `__Host-rgb_session=${token}` } }, { internet: true }))?.email, 'a@example.com');
  assert.equal(await auth.userFor({ secure: true, headers: { cookie: `rgb_session=${token}` } }), null, 'the plain name isn\'t read over https');

  const plain = fakeResponse();
  await auth.signIn({ secure: false }, plain, user);
  const cookie = plain.headers['Set-Cookie'].split(';')[0];
  assert.match(cookie, /^rgb_session=/);
  assert.equal((await auth.userFor({ secure: false, headers: { cookie } }))?.email, 'a@example.com', 'on the local network');
  assert.equal(await auth.userFor({ secure: false, headers: { cookie } }, { internet: true }), null, 'a session made over http, from outside');
});

test('A damaged stored hash matches no password, and one with an older cost is made again', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'local-users.json');
  // A key that decodes to nothing would once have matched any password.
  fs.writeFileSync(file, JSON.stringify({ users: { victim: { name: '', hash: 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$!!!!', uid: 'u' }, cheap: { name: '', hash: 'scrypt$2$1$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA', uid: 'u2' } } }));
  t.mock.method(console, 'warn', () => {});
  const users = await new LocalUsers(file).load();
  assert.equal(await users.verify('victim', 'anything at all'), null);
  assert.equal(await users.verify('cheap', 'anything at all'), null);

  // An account from before today's cost signs in, and its hash is brought up to date.
  const crypto = await import('node:crypto');
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync('old password 1', salt, 64, { N: 16384, r: 8, p: 1 });
  fs.writeFileSync(file, JSON.stringify({ users: { old: { name: '', hash: ['scrypt', 16384, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$') } } }));
  const reread = await new LocalUsers(file).load();
  assert.ok(await reread.verify('old', 'old password 1'));
  assert.match(JSON.parse(fs.readFileSync(file, 'utf8')).users.old.hash, /^scrypt\$32768\$8\$3\$/);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).users.old.uid, 'an account from before uids gets one');
});

test('Two requests making the same username at once: one gets it, the other is told it\'s taken', async (t) => {
  const users = await new LocalUsers(path.join(tempDir(t), 'local-users.json')).load();
  const results = await Promise.allSettled([
    users.create({ username: 'bob', password: 'first password 1' }),
    users.create({ username: 'bob', password: 'second password 2' }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /taken/);
  assert.ok(await users.verify('bob', 'first password 1'), 'the first one\'s password stands');
});

test('Counter: only what\'s counted counts, clearing forgets, and a flood of new keys can\'t evict one that\'s held back', async () => {
  const { Counter } = await import('../server/lib/ratelimit.js');
  const c = new Counter({ windowMs: 60_000, max: 3 });
  for (let i = 0; i < 3; i++) c.hit('target');
  assert.equal(c.over('target'), true);
  for (let i = 0; i < 20_000; i++) c.hit(`flood${i}`);
  assert.equal(c.over('target'), true, 'still held back after 20,000 other keys');
  c.clear('target');
  assert.equal(c.over('target'), false);
});
