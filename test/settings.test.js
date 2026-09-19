import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore, PlayStore, ServerSettings, mergePlays, readJson, writeJson, shelfFlags } from '../server/lib/settings.js';

const DEFAULTS = {
  filters: {}, favorites: {}, gameDefaults: {}, controllerLayouts: [1, 1, 1, 1], touchButtons: {},
};

test('SettingsStore saves, merges the per-game maps and rejects bad input', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  const store = new SettingsStore(file);

  assert.deepEqual(await store.get(), DEFAULTS);

  await store.update({ gameDefaults: { a: 'a-1' } });
  await store.update({ gameDefaults: { b: 'b-0' }, showNonEnglish: true });
  assert.deepEqual(await store.get(), { ...DEFAULTS, filters: { showNonEnglish: true }, gameDefaults: { a: 'a-1', b: 'b-0' } });

  await store.update({ gameDefaults: { a: null } });
  assert.deepEqual((await new SettingsStore(file).get()).gameDefaults, { b: 'b-0' }, 'persisted to disk');

  // Favorites: true and false are both kept (false unmarks one LaunchBox calls a favorite),
  // and null goes back to what LaunchBox says.
  await store.update({ favorites: { a: true, b: false } });
  await store.update({ favorites: { c: true } });
  assert.deepEqual((await store.get()).favorites, { a: true, b: false, c: true });
  await store.update({ favorites: { b: null } });
  assert.deepEqual((await new SettingsStore(file).get()).favorites, { a: true, c: true }, 'persisted to disk');

  await store.update({ controllerLayouts: [1, 2, 1, 2] });
  assert.deepEqual((await new SettingsStore(file).get()).controllerLayouts, [1, 2, 1, 2], 'persisted to disk');

  // A game's on-screen buttons replace what it had; null goes back to the defaults.
  await store.update({ touchButtons: { a: { show: false }, b: { keys: { a: 'KeyZ', l: '' } } } });
  await store.update({ touchButtons: { a: { keys: { start: 'Escape' } } } });
  assert.deepEqual((await new SettingsStore(file).get()).touchButtons, { a: { keys: { start: 'Escape' } }, b: { keys: { a: 'KeyZ', l: '' } } }, 'persisted to disk');
  await store.update({ touchButtons: { b: null } });
  assert.deepEqual((await store.get()).touchButtons, { a: { keys: { start: 'Escape' } } });

  await assert.rejects(store.update({ touchButtons: { a: { keys: { thumb: 'KeyZ' } } } }), /touchButtons/);
  await assert.rejects(store.update({ touchButtons: { a: { keys: { a: '<b>' } } } }), /touchButtons/);
  await assert.rejects(store.update({ touchButtons: { a: { show: 'yes' } } }), /touchButtons/);
  await assert.rejects(store.update({ touchButtons: { a: { extra: 1 } } }), /touchButtons/);
  await assert.rejects(store.update({ controllerLayouts: [1, 3, 1, 1] }), /controllerLayouts/);
  await assert.rejects(store.update({ controllerLayouts: [2] }), /controllerLayouts/);
  await assert.rejects(store.update({ gameDefaults: ['nope'] }), /gameDefaults/);
  await assert.rejects(store.update({ favorites: { a: 'yes' } }), /favorites/);
});

test('SettingsStore drops settings an older version wrote', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-settings-old-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  // versionOrder was a setting until the ranking became fixed, and the shelf's flags each
  // account's own until the owner's defaults stood for them.
  fs.writeFileSync(file, JSON.stringify({ showBroken: true, showNoImage: true, versionOrder: ['CD DOS'], gameDefaults: { a: 'a-1' }, filters: { showNoImage: true, showBroken: 'yes', showNonEnglish: true } }));
  assert.deepEqual(await new SettingsStore(file).get(), { ...DEFAULTS, gameDefaults: { a: 'a-1' }, filters: { showNonEnglish: true } });
});

test('An account\'s filters are kept only where they differ from the owner\'s defaults', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-settings-filters-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SettingsStore(path.join(dir, 'settings.json'));
  const shelfDefaults = { showBroken: false, showNonEnglish: true, showPrereleases: false, showNoImage: false, pcMultiplayerWithoutNetwork: false };

  await store.update({ showNonEnglish: false, showBroken: true }, { shelfDefaults });
  assert.deepEqual((await store.get()).filters, { showNonEnglish: false, showBroken: true });
  // Back to the default: it follows the default from then on.
  await store.update({ showNonEnglish: true }, { shelfDefaults });
  await store.update({ showBroken: null }, { shelfDefaults });
  assert.deepEqual((await store.get()).filters, {});
  // The owner's flags aren't an account's to change; a page from before may still send them.
  await store.update({ showPrereleases: true, showNoImage: true }, { shelfDefaults });
  assert.deepEqual((await store.get()).filters, {});
  await assert.rejects(store.update({ showBroken: 'false' }), /showBroken/);

  // What someone sees: their own over the defaults, and never their own for the owner's flags.
  assert.deepEqual(shelfFlags(shelfDefaults, { showNonEnglish: false, showNoImage: true }),
    { showBroken: false, showNonEnglish: false, showPrereleases: false, showNoImage: false, pcMultiplayerWithoutNetwork: false });
});

test('ServerSettings keeps the owner\'s shelf defaults, and refuses anything but the shelf\'s flags', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-server-shelf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'server.json');
  const store = new ServerSettings(file);
  await store.load();
  assert.equal(store.get().shelfDefaults.showNoImage, false);
  await store.update({ shelfDefaults: { showNoImage: true } });
  await store.update({ shelfDefaults: { showNonEnglish: true } });
  const reread = await new ServerSettings(file).load();
  assert.deepEqual(reread.shelfDefaults, { showBroken: false, showNonEnglish: true, showPrereleases: false, showNoImage: true, pcMultiplayerWithoutNetwork: false }, 'kept on disk');
  await assert.rejects(store.update({ shelfDefaults: { favorites: true } }), /shelfDefaults/);
  await assert.rejects(store.update({ shelfDefaults: { showNoImage: 'yes' } }), /shelfDefaults/);
});

test('SettingsStore keeps only real games and versions, and skips writes that change nothing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-settings-known-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  const store = new SettingsStore(file);
  const known = { isGame: (id) => ['a', 'b'].includes(id), isVersion: (gameId, v) => v === `${gameId}-0` };

  await store.update({ favorites: { a: true, made_up: true }, gameDefaults: { b: 'b-0', a: 'b-0', nope: 'nope-0' }, touchButtons: { a: { show: true }, made_up: { show: true } } }, known);
  assert.deepEqual(await store.get(), { ...DEFAULTS, favorites: { a: true }, gameDefaults: { b: 'b-0' }, touchButtons: { a: { show: true } } });
  // Clearing an entry works for any id, so one left from a game no longer loaded can go.
  fs.writeFileSync(file, JSON.stringify({ favorites: { gone: true, a: true } }));
  const reread = new SettingsStore(file);
  await reread.update({ favorites: { gone: null } }, known);
  assert.deepEqual((await reread.get()).favorites, { a: true });

  const before = fs.statSync(file).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await reread.update({ favorites: { a: true } }, known);
  assert.equal(fs.statSync(file).mtimeMs, before, 'no write for a change that changes nothing');
});

test('SettingsStore applies updates made together one after another', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-settings-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  const store = new SettingsStore(file);
  await Promise.all(['a', 'b', 'c', 'd'].map((id) => store.update({ favorites: { [id]: true } })));
  assert.deepEqual((await new SettingsStore(file).get()).favorites, { a: true, b: true, c: true, d: true });
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'], 'no temporary files left');
});

test('SettingsStore and PlayStore refuse to start over from a file they can\'t read', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-settings-bad-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"favorites": {"a": tr');
  await assert.rejects(new SettingsStore(file).update({ favorites: { b: true } }), /isn't valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"favorites": {"a": tr', 'left as it was');
  const plays = path.join(dir, 'plays.json');
  fs.writeFileSync(plays, 'not json');
  await assert.rejects(new PlayStore(plays).record('a'), /isn't valid JSON/);
  assert.equal(fs.readFileSync(plays, 'utf8'), 'not json');
});

test('JSON stores read a file saved with a byte-order mark, and save past a file held open for a moment', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-settings-bom-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '﻿{"favorites": {"a": true}}');
  assert.deepEqual((await new SettingsStore(file).get()).favorites, { a: true });
  assert.deepEqual(await readJson(file, null), { favorites: { a: true } });

  // Windows refuses a rename over a file another program has open (EPERM) until it lets go.
  const rename = fsp.rename;
  let refused = 0;
  t.mock.method(fsp, 'rename', async (...args) => {
    if (refused++ < 2) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    return rename(...args);
  });
  await writeJson(file, { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
  assert.equal(refused, 3);
  // Anything else fails at once, and leaves no temporary file behind.
  t.mock.method(fsp, 'rename', async () => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); });
  await assert.rejects(writeJson(file, { a: 2 }), /no such file/);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});

test('PlayStore counts plays one after another and keeps them on disk', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-plays-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'userdata', 'plays.json');
  const store = new PlayStore(file);
  await store.load();
  assert.equal(store.get('a'), null);

  // Requests that arrive together all count.
  const when = new Date('2026-09-11T20:00:00Z');
  await Promise.all([store.record('a', when), store.record('a', when), store.record('b', when)]);
  assert.deepEqual(store.get('a'), { lastPlayed: '2026-09-11T20:00:00.000Z', playCount: 2 });

  const again = new PlayStore(file);
  await again.load();
  assert.deepEqual(again.get('b'), { lastPlayed: '2026-09-11T20:00:00.000Z', playCount: 1 }, 'persisted to disk');
  assert.deepEqual(await again.record('b', new Date('2026-09-12T08:00:00Z')), { lastPlayed: '2026-09-12T08:00:00.000Z', playCount: 2 });
});

test('mergePlays adds the counts and keeps the later date across time zones', () => {
  // 20:13 at UTC-5 is 01:13 UTC the next day, later than 23:00 UTC the day before.
  const launchbox = { playCount: 3, lastPlayed: '2021-04-05T20:13:46.1234567-05:00' };
  assert.deepEqual(mergePlays(launchbox, { playCount: 2, lastPlayed: '2021-04-05T23:00:00.000Z' }),
    { playCount: 5, lastPlayed: '2021-04-05T20:13:46.1234567-05:00' });
  assert.deepEqual(mergePlays(launchbox, { playCount: 1, lastPlayed: '2021-04-06T02:00:00.000Z' }),
    { playCount: 4, lastPlayed: '2021-04-06T02:00:00.000Z' });
  // No LaunchBox history, or none of ours.
  assert.deepEqual(mergePlays({ playCount: 0, lastPlayed: null }, { playCount: 1, lastPlayed: '2026-09-11T20:00:00.000Z' }),
    { playCount: 1, lastPlayed: '2026-09-11T20:00:00.000Z' });
  assert.deepEqual(mergePlays(launchbox, null), launchbox);
});

test('ServerSettings counts a guest window from its own clock, not the device\'s', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-server-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ServerSettings(path.join(dir, 'server-settings.json'));
  await store.load();

  // A device whose clock is two hours slow sends a time already past, along with how long it meant.
  const before = Date.now();
  const slow = new Date(before - 2 * 3_600_000 + 60 * 60_000).toISOString();
  const saved = await store.update({ guestsCanPlay: true, guestsUntil: slow, guestsForMinutes: 60 });
  assert.equal(saved.guestsCanPlay, true);
  const until = Date.parse(saved.guestsUntil);
  assert.ok(until >= before + 60 * 60_000 && until <= Date.now() + 60 * 60_000, 'an hour from now by the server');

  for (const bad of [0, -5, Infinity, NaN, '60', null, 7 * 24 * 60 + 1]) {
    await assert.rejects(store.update({ guestsCanPlay: true, guestsForMinutes: bad }), { status: 400 });
  }
  assert.equal(store.get().guestsUntil, saved.guestsUntil, 'a refused change leaves it as it was');

  // Without minutes, guestsUntil is taken as before.
  assert.equal((await store.update({ guestsCanPlay: true, guestsUntil: null })).guestsUntil, null);
  assert.equal((await store.update({ guestsCanPlay: false, guestsForMinutes: 60 })).guestsUntil, null, 'off clears the time');
});
