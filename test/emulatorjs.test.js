import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameRateFor } from '../server/lib/emulatorjs.js';

test('frameRateFor gives each core its NTSC or PAL rate by the release\'s region', () => {
  assert.equal(frameRateFor('Nintendo Entertainment System', ['USA']), 60.0988);
  assert.equal(frameRateFor('Nintendo Entertainment System', ['Europe']), 50.007);
  assert.equal(frameRateFor('Super Nintendo Entertainment System', ['Japan']), 60.0988);
  assert.equal(frameRateFor('Sega Genesis', ['Europe', 'Australia']), 49.7015);
  assert.equal(frameRateFor('Sega Genesis', []), 59.9228);
  // One ROM for several regions runs as the NTSC one its header names; Brazil's PAL-M is 60 Hz.
  assert.equal(frameRateFor('Sega Genesis', ['USA', 'Europe']), 59.9228);
  assert.equal(frameRateFor('Sega Genesis', ['Japan', 'Europe']), 59.9228);
  assert.equal(frameRateFor('Sega Genesis', romRegions(romTags('Contra (UE).md'))), 59.9228);
  assert.equal(frameRateFor('Sega Genesis', ['Brazil']), 59.9228);
  assert.equal(frameRateFor('Sega Genesis', ['Europe', 'Brazil']), 49.7015);
  assert.equal(frameRateFor('Commodore 64', ['USA']), 50.1245, 'VICE runs a PAL machine regardless');
  assert.equal(frameRateFor('Sony Playstation', ['USA']), 60, 'no rate known: 60');
  assert.equal(frameRateFor('Nowhere', []), 60);
});

test('CORES says which platforms play with friends, and how', () => {
  const modes = Object.fromEntries(Object.entries(CORES).map(([platform, core]) => [platform, core.netplay ?? null]));
  assert.equal(modes['Nintendo Entertainment System'], 'rollback');
  assert.equal(modes['Super Nintendo Entertainment System'], 'rollback');
  // Too big a state to save every frame, or a core two copies of which can't be kept alike:
  // the host runs the game and sends video.
  assert.equal(modes['Sega CD'], 'stream');
  assert.equal(modes['Sega Saturn'], 'stream');
  assert.equal(modes['Sony Playstation'], 'stream');
  assert.equal(modes['Nintendo 64'], 'stream');
  assert.equal(modes['Atari Jaguar'], 'stream');
  for (const [platform, mode] of Object.entries(modes)) assert.ok(['stream', 'rollback'].includes(mode), `${platform}: ${mode}`);
});
import { CORES, BIOS_FILES, isRomFile, romTags, romRegions, romKind, romLabel, biosNameFor, discSetName, romTranslation } from '../server/lib/emulatorjs.js';

test('romTags reads No-Intro and GoodTools tags from a file name', () => {
  assert.deepEqual(romTags('Games\\Sega Genesis\\Sonic the Hedgehog (USA, Europe) (Rev A).zip'), ['USA, Europe', 'Rev A']);
  assert.deepEqual(romTags('Contra (U) [!].nes'), ['U', '!']);
  assert.deepEqual(romTags('shocktr2.zip'), []);
});

test('romRegions finds the region tag among the others', () => {
  assert.deepEqual(romRegions(['Rev 1', 'Japan, USA']), ['Japan', 'USA']);
  assert.deepEqual(romRegions(['USA', 'Beta']), ['USA']);
  assert.deepEqual(romRegions(['En,Fr,De']), []);
});

test('romKind ranks releases by their best region and flags pre-releases', () => {
  const key = (name) => romKind(romTags(name), 'Nintendo Entertainment System').key;
  assert.equal(key('Game (Japan, USA).zip'), 'USA');
  assert.equal(key('Game (World).zip'), 'World');
  assert.equal(key('Game (Europe) (En,Fr,De).zip'), 'Europe');
  assert.equal(key('Game (Germany).zip'), 'Europe');
  assert.equal(key('Game (Japan).zip'), 'Japan');
  assert.equal(key('Game (Korea).zip'), 'Other regions');
  assert.equal(key('Game (USA) (Beta).zip'), 'Beta, demo or prototype');
  assert.equal(key('kof98.zip'), 'Other');
  assert.equal(key('Contra (U) [!].nes'), 'USA', 'GoodTools region codes count');
  assert.equal(key('Earthworm Jim 3 (Asia) (En) (Aftermarket) (Pirate).zip'), 'Other regions', 'pirate releases rank by region');
  assert.equal(key('Game (USA) (Hack).zip'), 'USA');
  assert.equal(key('Tales of Phantasia (Japan) (T).7z'), 'Fan translation', 'before its original region');
});

test('romLabel names a version by its tags, or the title when there are none', () => {
  assert.equal(romLabel('Suikoden (USA) (Rev 1).7z', 'Suikoden'), 'USA, Rev 1');
  assert.equal(romLabel('Contra (U) [!].nes', 'Contra'), 'USA');
  assert.equal(romLabel('kof98.zip', "The King of Fighters '98"), "The King of Fighters '98");
});

test('romLabel makes No-Intro and GoodTools tags readable', () => {
  assert.equal(romLabel('Game (Europe) (En,Fr,De,Es,It).zip', 'Game'), 'Europe, 5 languages');
  assert.equal(romLabel('Game (Japan) (En) (Rev 1) (Unl).zip', 'Game'), 'Japan, English, Rev 1, Unlicensed');
  assert.equal(romLabel('Game (Europe) (En,Fr).zip', 'Game'), 'Europe, English and French');
  assert.equal(romLabel('Tales of Phantasia (T).7z', 'Tales of Phantasia'), 'Fan translation');
  assert.equal(romLabel('Mizzurna Falls [T+Eng v1.0].7z', 'Mizzurna Falls'), 'English translation');
  assert.equal(romLabel('Game (T) (Disc 1).7z', 'Game'), 'Fan translation, Disc 1');
  assert.equal(romLabel('Game (U) [t1].nes', 'Game'), 'USA', 'a lower-case [t1] is a trainer, dropped');
});

test('romLabel names an alternate by its own title when it differs from the game', () => {
  assert.equal(romLabel('Probotector II - Return of the Evil Forces (Europe).zip', 'Contra', { alternate: true }),
    'Probotector II - Return of the Evil Forces (Europe)');
  assert.equal(romLabel('ips.zip', 'Battle Flip Shot', { alternate: true }), 'ips');
  assert.equal(romLabel('Legend of Zelda, The - A Link to the Past (USA).zip', 'The Legend of Zelda: A Link to the Past', { alternate: true }),
    'USA', 'the same title written differently');
  assert.equal(romLabel('Probotector II (Europe).zip', 'Contra'), 'Europe', 'the game\'s own ROM keeps the short name');
});

test('romTranslation reads the language of a fan translation', () => {
  assert.deepEqual(romTranslation(['T+Eng']), { language: 'English' });
  assert.deepEqual(romTranslation(['T']), { language: null });
  assert.equal(romTranslation(['t1']), null);
  assert.equal(romTranslation(['USA']), null);
});

test('discSetName gives the discs of one release the same name', () => {
  assert.equal(discSetName('Final Fantasy VII (USA) (Disc 2).7z'), 'Final Fantasy VII (USA)');
  assert.equal(discSetName('Games\\Sony Playstation\\Final Fantasy VII (USA) (Disc 1).7z'), 'Final Fantasy VII (USA)');
  assert.equal(discSetName('Crash Bandicoot (USA).7z'), null);
});

test('every core names the EmulatorJS system its controls come from', () => {
  const systems = new Set(['nes', 'snes', 'segaMD', 'sega32x', 'segaCD', 'segaSaturn', 'psx', 'n64', 'atari2600', 'atari5200', 'atari7800', 'jaguar', 'pce', 'arcade', 'c64']);
  for (const [platform, c] of Object.entries(CORES)) assert.ok(systems.has(c.system), `${platform}: ${c.system}`);
});

test('biosNameFor picks the region BIOS the core expects', () => {
  assert.equal(biosNameFor('Sega CD', ['Japan']), 'bios_CD_J.bin');
  assert.equal(biosNameFor('Sega CD', ['Europe']), 'bios_CD_E.bin');
  assert.equal(biosNameFor('Sega CD', ['USA', 'Europe']), 'bios_CD_U.bin');
  assert.equal(biosNameFor('Sega Saturn', ['Japan']), 'saturn_bios.bin');
  assert.equal(biosNameFor('Sega CD', []), 'bios_CD_U.bin');
  assert.equal(biosNameFor('Sony Playstation', ['Japan']), 'scph5501.bin');
  assert.equal(biosNameFor('Nintendo Entertainment System', ['USA']), null);
});

test('every BIOS a core asks for has known file names', () => {
  for (const [platform, c] of Object.entries(CORES)) {
    for (const name of Object.values(c.bios ?? {})) assert.ok(BIOS_FILES[name], `${platform}: ${name}`);
  }
});

test('isRomFile accepts ROMs and archives, not documents', () => {
  assert.ok(isRomFile('Games\\Nintendo 64\\Super Mario 64 (USA).zip'));
  assert.ok(isRomFile('x.7z'));
  assert.ok(isRomFile('x.sfc'));
  assert.ok(!isRomFile('Manuals\\x.pdf'));
  assert.ok(!isRomFile('x.txt'));
});

test('console-known-issues.json names loaded console platforms and ROM files', async () => {
  const fs = await import('node:fs');
  const issues = JSON.parse(fs.readFileSync(new URL('../server/data/console-known-issues.json', import.meta.url), 'utf8'));
  for (const [platform, files] of Object.entries(issues)) {
    if (platform.startsWith('_')) continue;
    assert.ok(Object.hasOwn(CORES, platform), `${platform} isn't a console platform`);
    for (const [file, message] of Object.entries(files)) {
      assert.ok(isRomFile(file), `${platform}: ${file} isn't a ROM file name`);
      assert.equal(typeof message, 'string');
    }
  }
});
