import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {
  mameSets, mameBundles, mameControls, mameNetplayMode, isMameEmulator, setNameOf, arcadeKind, arcadeLabel, arcadeRegions, mameFiles, mameIssue,
} from '../server/lib/mame.js';

test('the set list only has sets whose driver is in a bundle, each naming that bundle', () => {
  const bundleOf = new Map(Object.entries(mameBundles()).flatMap(([b, sources]) => sources.map((s) => [s, b])));
  const sets = mameSets();
  assert.ok(Object.keys(sets).length > 1000);
  assert.equal(sets.ssf2t.bundle, 'capcom');
  assert.equal(sets.mslug.bundle, 'neogeo');
  for (const set of Object.values(sets)) assert.ok([...bundleOf.values()].includes(set.bundle));
});

test('a set loads its parent\'s, BIOS and device zips, as a split set needs', () => {
  const sets = mameSets();
  assert.deepEqual(sets.mslug.zips, ['neogeo']);
  assert.deepEqual(sets.ssf2t.zips, ['qsound_hle']);
  assert.deepEqual(sets.ssf2tu.zips, ['ssf2t', 'qsound_hle'], 'a clone\'s zip has only the ROMs its parent\'s hasn\'t');
  assert.equal(sets.sf2ce.zips, undefined, 'a game of its own needs nothing else');
  assert.equal(sets.puckman.screen.rotate, 90);
});

test('mameControls says how many buttons a set has and whether it\'s a light gun game', () => {
  assert.deepEqual(mameControls('mslug'), { players: 2, buttons: 4, lightgun: false });
  assert.equal(mameControls('area51').lightgun, true);
  assert.equal(mameControls('nosuchset'), null);
});

test('isMameEmulator knows MAME by the program LaunchBox starts', () => {
  assert.ok(isMameEmulator('Emulators\\MAME 0.244\\mame.exe'));
  assert.ok(isMameEmulator('Emulators/MAME/mame64.exe'));
  assert.ok(!isMameEmulator('Emulators\\RetroArch\\retroarch.exe'));
  assert.ok(!isMameEmulator(null));
});

test('setNameOf takes the set from a ROM path', () => {
  assert.equal(setNameOf('Games\\MAME 0.244\\SF2CE.zip'), 'sf2ce');
  assert.equal(setNameOf('Games/MAME 0.244/mslug.7z'), 'mslug');
});

test('arcade versions are named and ranked by what MAME\'s description adds', () => {
  assert.equal(arcadeLabel('Super Street Fighter II Turbo (World 940223)', 'Super Street Fighter II Turbo'), 'World 940223');
  assert.equal(arcadeLabel('Street Fighter II\': Champion Edition (World 920513)', 'Street Fighter II'), 'Street Fighter II\': Champion Edition (World 920513)');
  assert.equal(arcadeLabel('Metal Slug - Super Vehicle-001', 'Metal Slug - Super Vehicle-001'), 'Metal Slug - Super Vehicle-001');
  assert.equal(arcadeLabel(undefined, 'Pac-Man'), 'Pac-Man');

  assert.deepEqual(arcadeRegions('Final Fight (US 900112)'), ['US']);
  assert.equal(arcadeKind('Final Fight (US 900112)', 'Arcade').key, 'USA');
  assert.equal(arcadeKind('Darius (World, rev 2)', 'Arcade').key, 'World');
  assert.equal(arcadeKind('Street Fighter Alpha 3 (Euro 980904)', 'Arcade').key, 'Europe');
  assert.equal(arcadeKind('Puck Man (Japan set 1)', 'Arcade').key, 'Japan');
  assert.equal(arcadeKind('Street Fighter Zero 3 (Asia 980904)', 'Arcade').key, 'Other regions');
  assert.equal(arcadeKind('Some Game (prototype)', 'Arcade').key, 'Beta, demo or prototype');
  assert.equal(arcadeKind('Some Game (bootleg)', 'Arcade').key, 'Other');
});

test('mameFiles finds a set\'s zips, a clone\'s shared disk in its parent\'s folder, and samples', () => {
  const romDir = path.join('R:', 'MAME');
  const present = new Set([
    path.join(romDir, 'mslug.zip'), path.join(romDir, 'neogeo.zip'),
    path.join(romDir, 'kinst2uk.zip'), path.join(romDir, 'kinst2.zip'), path.join(romDir, 'kinst2', 'kinst2.chd'),
    path.join('S:', 'samples', '005.zip'), path.join(romDir, '005.zip'),
  ]);
  const statFile = (abs) => (present.has(abs) ? 100 : null);

  const slug = mameFiles('mslug', { romDir, statFile });
  assert.deepEqual(slug.map((f) => [f.name, Boolean(f.abs)]), [['roms/mslug.zip', true], ['roms/neogeo.zip', true]]);
  assert.equal(mameIssue('mslug', slug), null);

  const ki2 = mameFiles('kinst2uk', { romDir, statFile });
  assert.deepEqual(ki2.map((f) => f.name), ['roms/kinst2uk.zip', 'roms/kinst2.zip', 'roms/kinst2/kinst2.chd']);
  assert.ok(ki2.every((f) => f.abs));
  assert.match(mameIssue('kinst2uk', ki2, { maxBytes: 250 }), /Too big/);

  const sega = mameFiles('005', { romDir, samplesDir: path.join('S:', 'samples'), statFile });
  assert.deepEqual(sega.map((f) => f.name), ['roms/005.zip', 'samples/005.zip']);

  const missing = mameFiles('ssf2t', { romDir, statFile });
  assert.match(mameIssue('ssf2t', missing), /Missing ssf2t\.zip, qsound_hle\.zip/);
  assert.match(mameIssue('nosuchset', []), /isn't in the browser version of MAME/);
  assert.equal(mameFiles('nosuchset', { romDir, statFile }), null);
});

test('a game is played with friends in step where MAME keeps it in step, and streamed otherwise', () => {
  const sets = mameSets();
  const sources = new Set(Object.values(sets).map((s) => s.source));
  const listed = JSON.parse(fs.readFileSync(new URL('../server/data/mame-netplay.json', import.meta.url), 'utf8'));
  assert.ok(listed.rollback.sources.length > 100);
  for (const source of listed.rollback.sources) assert.ok(sources.has(source), `${source} is a driver in this build`);

  assert.equal(mameNetplayMode('mslug'), 'rollback');
  assert.equal(mameNetplayMode('xmen'), 'rollback');
  assert.equal(mameNetplayMode('area51'), 'stream', 'a light gun is the host\'s own pointer');
  assert.equal(mameNetplayMode('atarifb'), 'stream', 'a trackball is the host\'s own pointer');
  assert.equal(mameNetplayMode('gauntlet'), 'stream', 'MAME can\'t save this driver\'s state');
  assert.equal(mameNetplayMode('unsquad'), 'rollback', 'in step once the build saves the input latch (patch 0009)');
  assert.equal(mameNetplayMode('rbisland'), 'stream', 'this one\'s frames still don\'t come out the same when a rollback runs them again');
  assert.equal(mameNetplayMode('nosuchset'), null);
});
