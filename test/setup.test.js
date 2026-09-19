import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLaunchBox, planSetup, applySetup, cleanHostname } from '../server/setup.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-setup-'));

/** A LaunchBox folder with the platforms named. */
function launchbox(platforms) {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'Data', 'Platforms'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Data', 'Platforms.xml'), '<LaunchBox />');
  for (const p of platforms) fs.writeFileSync(path.join(dir, 'Data', 'Platforms', `${p}.xml`), '<LaunchBox />');
  return dir;
}

test('a LaunchBox folder is found, with the platforms it has', async () => {
  const dir = launchbox(['MS-DOS', 'Sega Genesis', 'Amiga']);
  const r = await checkLaunchBox(`${dir}\\`, { platforms: ['MS-DOS', 'Sega Genesis', 'Arcade'], service: false, account: 'me' });
  assert.equal(r.ok, true);
  assert.equal(r.path, dir);
  assert.deepEqual(r.found, ['MS-DOS', 'Sega Genesis']);
  assert.deepEqual(r.missing, ['Arcade']);
  assert.equal(r.others, 1);
});

test('the folder above LaunchBox\'s is pointed at the one inside', async () => {
  const parent = tempDir();
  const inner = path.join(parent, 'LaunchBox');
  fs.mkdirSync(path.join(inner, 'Data'), { recursive: true });
  fs.writeFileSync(path.join(inner, 'Data', 'Platforms.xml'), '<LaunchBox />');
  const r = await checkLaunchBox(parent, { service: false });
  assert.equal(r.ok, false);
  assert.equal(r.suggestion, inner);
});

test('a folder that isn\'t LaunchBox\'s, one that isn\'t there, and a relative path are turned down', async () => {
  assert.match((await checkLaunchBox(tempDir(), { service: false })).problem, /Platforms\.xml/);
  assert.match((await checkLaunchBox(path.join(tempDir(), 'nope'), { service: false })).problem, /There's no folder/);
  assert.match((await checkLaunchBox('LaunchBox', { service: false })).problem, /whole path/);
  assert.match((await checkLaunchBox('', { service: false })).problem, /Enter the folder/);
});

test('host names are cleaned of the scheme and path', () => {
  assert.equal(cleanHostname('https://Games.Example.com/x'), 'games.example.com');
  assert.equal(cleanHostname('games.example.com'), 'games.example.com');
  assert.equal(cleanHostname(''), '');
});

const ok = async (p) => ({ ok: true, path: p });

test('setup is checked before anything is written', async () => {
  const base = { launchboxRoot: 'C:\\LaunchBox', network: 'network' };
  await assert.rejects(planSetup({ ...base, network: 'moon' }, { check: ok }), /who can open/);
  await assert.rejects(planSetup({ ...base, google: { clientId: 'x', owner: 'me@example.com' } }, { check: ok }), (err) => err.field === 'clientId');
  await assert.rejects(planSetup({ ...base, google: { clientId: '1-abc.apps.googleusercontent.com', owner: 'me@local' } }, { check: ok }), (err) => err.field === 'owner');
  await assert.rejects(planSetup({ ...base, local: { enabled: true, owner: { username: 'owner', password: 'short' } } }, { check: ok }), (err) => err.field === 'password');
  // With Google the owner is the Google address: no local owner's account is needed.
  const plan = await planSetup({ ...base, google: { clientId: '1-abc.apps.googleusercontent.com', owner: 'Me@Example.com', hostname: 'https://games.example.com/' }, local: { enabled: true } }, { check: ok });
  assert.deepEqual(plan.google, { clientId: '1-abc.apps.googleusercontent.com', owner: 'me@example.com', hostname: 'games.example.com' });
  assert.deepEqual(plan.local, { signup: false, owner: null });
  assert.equal(plan.host, '0.0.0.0');
  // Setup gone through again keeps the owner's local account made before.
  const again = await planSetup({ ...base, network: 'this-pc', local: { enabled: true, signup: true } }, { check: ok, localOwner: 'owner' });
  assert.deepEqual(again.local, { signup: true, owner: null });
  assert.equal(again.host, '127.0.0.1');
});

test('finishing writes the config, the owner\'s account and the switches, keeping settings added by hand', async () => {
  const dir = tempDir();
  const configPath = path.join(dir, 'config.local.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: 3001, auth: { owner: 'old@example.com', players: ['friend@example.com'] } }));
  const usersDir = path.join(dir, 'userdata');
  const plan = await planSetup({ launchboxRoot: 'C:\\LaunchBox', network: 'network', local: { enabled: true, signup: true, owner: { username: 'boss', name: 'Boss', password: 'plum-tiger-lantern-42' } } }, { check: ok });
  const written = await applySetup(plan, { configPath, usersDir });
  assert.deepEqual(written, { port: 3001, launchboxRoot: 'C:\\LaunchBox', host: '0.0.0.0', auth: { owner: '', players: ['friend@example.com'], googleClientId: '' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), written);
  const users = JSON.parse(fs.readFileSync(path.join(usersDir, 'local-users.json'), 'utf8'));
  assert.equal(JSON.stringify(users).includes('plum-tiger'), false, 'only a hash is kept');
  assert.match(JSON.stringify(users), /"boss"/);
  const server = JSON.parse(fs.readFileSync(path.join(usersDir, 'server.json'), 'utf8'));
  assert.equal(server.localLogins, true);
  assert.equal(server.localSignup, true);
});
