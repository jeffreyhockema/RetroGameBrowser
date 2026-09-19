import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library } from '../server/lib/library.js';
import { PathResolver } from '../server/lib/paths.js';

const xml = (body) => `<?xml version="1.0" standalone="yes"?>\n<LaunchBox>\n${body}\n</LaunchBox>\n`;

/** A small LaunchBox folder: two platforms, categories, RetroArch, and a game with extras. */
function fakeLaunchBox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-library-'));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('Data/Settings.xml', xml('<Settings><RegionPriorities>North America</RegionPriorities></Settings>'));
  write('Data/Platforms.xml', xml([
    '<Platform><Name>Nintendo Entertainment System</Name><Category /></Platform>',
    '<Platform><Name>MS-DOS</Name><Category /></Platform>',
  ].join('\n')));
  write('Data/Parents.xml', xml([
    '<Parent><PlatformName>Nintendo Entertainment System</PlatformName><ParentPlatformCategoryName>Consoles</ParentPlatformCategoryName></Parent>',
    '<Parent><PlatformName>MS-DOS</PlatformName><ParentPlatformCategoryName>Computers</ParentPlatformCategoryName></Parent>',
  ].join('\n')));
  write('Data/Emulators.xml', xml('<Emulator><ID>e1</ID><Title>RetroArch</Title><ApplicationPath>Emulators\\RetroArch\\retroarch.exe</ApplicationPath></Emulator>'));
  write('Data/Platforms/Nintendo Entertainment System.xml', xml([
    '<Game><ID>g1</ID><Title>Ninja Jajamaru-kun</Title><ApplicationPath>Games\\NES\\Ninja Jajamaru-kun (Japan).zip</ApplicationPath></Game>',
    '<AdditionalApplication><Id>a1</Id><GameID>g1</GameID><Name>Play (World) Version...</Name>'
      + '<ApplicationPath>Games\\NES\\Ninja Jajamaru-kun (World) (Ja).zip</ApplicationPath><UseEmulator>true</UseEmulator><Region>World</Region></AdditionalApplication>',
    '<AdditionalApplication><Id>a2</Id><GameID>g1</GameID><Name>Manual</Name>'
      + '<ApplicationPath>Manuals\\NES\\Ninja.pdf</ApplicationPath><UseEmulator>false</UseEmulator></AdditionalApplication>',
    '<AdditionalApplication><Id>a3</Id><GameID>g1</GameID><Name>Manual (again)</Name>'
      + '<ApplicationPath>Manuals\\NES\\ninja.PDF</ApplicationPath><UseEmulator>false</UseEmulator></AdditionalApplication>',
    '<AdditionalApplication><Id>a4</Id><GameID>g1</GameID><Name>Pixel Perfect &amp; Shader options</Name>'
      + '<ApplicationPath>Games\\NES\\Extras\\Alternate Launcher.bat</ApplicationPath><UseEmulator>false</UseEmulator></AdditionalApplication>',
  ].join('\n')));
  write('Data/Platforms/MS-DOS.xml', xml('<Game><ID>d1</ID><Title>DOOM</Title><ApplicationPath>eXo\\eXoDOS\\!dos\\DOOM\\DOOM (1993).bat</ApplicationPath></Game>'));
  return { root, write };
}

const quiet = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
};

test('Library reads categories, the RetroArch folder, and splits regional ROMs from extras', async (t) => {
  quiet(t);
  const { root } = fakeLaunchBox();
  const library = new Library({ platforms: ['Nintendo Entertainment System', 'MS-DOS', 'Sega Saturn'], launchboxRoot: root }, new PathResolver(root));
  await library.load();

  assert.deepEqual([...library.platforms.keys()], ['Nintendo Entertainment System', 'MS-DOS'], 'a platform LaunchBox lacks is skipped');
  assert.equal(library.platforms.get('Nintendo Entertainment System').category, 'Consoles');
  assert.equal(library.platforms.get('MS-DOS').category, 'Computers');
  assert.equal(library.retroarchSystemDir, path.join('Emulators', 'RetroArch', 'system'));

  const game = library.gamesById.get('g1');
  assert.deepEqual(game.alternates.map((a) => [a.rel, a.region, a.name]),
    [['Games\\NES\\Ninja Jajamaru-kun (World) (Ja).zip', 'World', 'Play (World) Version...']]);
  assert.deepEqual(game.extras.map((e) => e.name), ['Manual'], 'documents stay extras, once each, and launchers are not extras');
  fs.rmSync(root, { recursive: true, force: true });
});

test('Library reads again only the platforms whose XML changed', async (t) => {
  quiet(t);
  const { root, write } = fakeLaunchBox();
  const library = new Library({ platforms: ['Nintendo Entertainment System', 'MS-DOS'], launchboxRoot: root }, new PathResolver(root));
  await library.load();
  const nes = library.platforms.get('Nintendo Entertainment System');
  const dos = library.platforms.get('MS-DOS');
  const generation = library.generation;

  // LaunchBox rewrote the NES XML (a play was recorded): only that platform is new.
  write('Data/Platforms/Nintendo Entertainment System.xml', fs.readFileSync(path.join(root, 'Data/Platforms/Nintendo Entertainment System.xml'), 'utf8').replace('Ninja Jajamaru-kun</Title>', 'Ninja Jajamaru-kun!</Title>'));
  fs.utimesSync(path.join(root, 'Data/Platforms/Nintendo Entertainment System.xml'), new Date(), new Date(Date.now() + 5000));
  await library.load();
  assert.notEqual(library.platforms.get('Nintendo Entertainment System'), nes);
  assert.equal(library.gamesById.get('g1').title, 'Ninja Jajamaru-kun!');
  assert.equal(library.platforms.get('MS-DOS'), dos, 'an unchanged platform keeps its records');
  assert.ok(library.platforms.get('Nintendo Entertainment System').stamp > nes.stamp);
  assert.equal(library.generation, generation + 1);

  // A shared file changed: every platform is read again.
  fs.utimesSync(path.join(root, 'Data/Settings.xml'), new Date(), new Date(Date.now() + 10000));
  await library.load();
  assert.notEqual(library.platforms.get('MS-DOS'), dos);
  fs.rmSync(root, { recursive: true, force: true });
});

test('A platform whose XML is missing for a moment stays, and comes back when the file does', async (t) => {
  quiet(t);
  const { root, write } = fakeLaunchBox();
  const dosXml = path.join(root, 'Data/Platforms/MS-DOS.xml');
  const good = fs.readFileSync(dosXml, 'utf8');
  const library = new Library({ platforms: ['Nintendo Entertainment System', 'MS-DOS'], launchboxRoot: root }, new PathResolver(root));
  await library.load();
  const dos = library.platforms.get('MS-DOS');

  // LaunchBox saving the NES list while the DOS one is briefly gone.
  fs.rmSync(dosXml);
  fs.utimesSync(path.join(root, 'Data/Platforms/Nintendo Entertainment System.xml'), new Date(), new Date(Date.now() + 5000));
  await library.load();
  assert.equal(library.platforms.get('MS-DOS'), dos, 'kept as it was');
  assert.equal(library.gamesById.get('d1')?.title, 'DOOM');

  write('Data/Platforms/MS-DOS.xml', good.replace('DOOM</Title>', 'DOOM II</Title>'));
  library.lastCheck = 0;
  await library.refreshIfChanged(); // starts the reload, and doesn't hold the caller up for it
  assert.equal(library.gamesById.get('d1').title, 'DOOM', 'the library as it was, meanwhile');
  await library.loading;
  assert.equal(library.gamesById.get('d1').title, 'DOOM II', 'the file coming back is noticed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('A reload that fails keeps the previous library and tries the new files again next time', async (t) => {
  quiet(t);
  const { root, write } = fakeLaunchBox();
  const library = new Library({ platforms: ['Nintendo Entertainment System', 'MS-DOS'], launchboxRoot: root }, new PathResolver(root));
  await library.load();
  const before = library.platforms;

  const dosXml = path.join(root, 'Data/Platforms/MS-DOS.xml');
  const good = fs.readFileSync(dosXml, 'utf8');
  fs.utimesSync(path.join(root, 'Data/Parents.xml'), new Date(), new Date(Date.now() + 5000));
  fs.rmSync(dosXml);
  fs.mkdirSync(dosXml); // unreadable as a file: the read fails
  await assert.rejects(library.load());
  assert.equal(library.platforms, before, 'the failed load changed nothing');

  fs.rmSync(dosXml, { recursive: true });
  write('Data/Platforms/MS-DOS.xml', good);
  await library.load();
  assert.notEqual(library.platforms.get('MS-DOS'), before.get('MS-DOS'), 'the shared files that changed are read now');
  fs.rmSync(root, { recursive: true, force: true });
});

test('A shared file that was missing for a moment is read again when it comes back', async (t) => {
  quiet(t);
  const { root, write } = fakeLaunchBox();
  const emulators = path.join(root, 'Data/Emulators.xml');
  const good = fs.readFileSync(emulators, 'utf8');
  const library = new Library({ platforms: ['Nintendo Entertainment System', 'MS-DOS'], launchboxRoot: root }, new PathResolver(root));
  await library.load();
  assert.ok(library.retroarchSystemDir);

  // LaunchBox saving it: caught while the file is gone.
  fs.rmSync(emulators);
  library.lastCheck = 0;
  await library.refreshIfChanged();
  await library.loading;
  assert.equal(library.retroarchSystemDir, null);

  write('Data/Emulators.xml', good);
  library.lastCheck = 0;
  await library.refreshIfChanged();
  await library.loading;
  assert.equal(library.retroarchSystemDir, path.join('Emulators', 'RetroArch', 'system'), 'the file coming back is noticed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('A platform XML caught empty or cut off keeps the platform as it was', async (t) => {
  quiet(t);
  const { root, write } = fakeLaunchBox();
  const dosXml = path.join(root, 'Data/Platforms/MS-DOS.xml');
  const good = fs.readFileSync(dosXml, 'utf8');
  const library = new Library({ platforms: ['Nintendo Entertainment System', 'MS-DOS'], launchboxRoot: root }, new PathResolver(root));
  await library.load();
  const before = library.platforms;

  for (const text of ['', good.slice(0, good.indexOf('</LaunchBox>'))]) {
    write('Data/Platforms/MS-DOS.xml', text);
    fs.utimesSync(dosXml, new Date(), new Date(Date.now() + 5000 + text.length));
    await assert.rejects(library.load(), /incomplete/);
    assert.equal(library.platforms, before, 'the failed load changed nothing');
    assert.equal(library.gamesById.get('d1')?.title, 'DOOM');
  }

  write('Data/Platforms/MS-DOS.xml', good.replace('DOOM</Title>', 'DOOM II</Title>'));
  fs.utimesSync(dosXml, new Date(), new Date(Date.now() + 20000));
  await library.load();
  assert.equal(library.gamesById.get('d1').title, 'DOOM II');

  // An empty list is written as a self-closing root, and still loads.
  write('Data/Parents.xml', '<?xml version="1.0" standalone="yes"?>\n<LaunchBox />\n');
  fs.utimesSync(path.join(root, 'Data/Parents.xml'), new Date(), new Date(Date.now() + 30000));
  await library.load();
  assert.equal(library.platforms.get('MS-DOS').category, '');
  fs.rmSync(root, { recursive: true, force: true });
});

test('A platform\'s icon and logo come from LaunchBox, under the names platform-art.json gives', async (t) => {
  quiet(t);
  const { root, write } = fakeLaunchBox();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write('Data/Platforms/Sega Saturn.xml', xml('<Game><ID>s1</ID><Title>Panzer Dragoon</Title><ApplicationPath>Games\\Saturn\\Panzer Dragoon.cue</ApplicationPath></Game>'));
  write('Images/Platforms/Nintendo Entertainment System/Clear Logo/Nintendo Entertainment System.png', 'png');
  write('Images/Platform Icons/Platforms/Nintendo Entertainment System.png', 'png');
  // LaunchBox's icon set calls MS-DOS "MS DOS".
  write('Images/Platform Icons/Platforms/MS DOS.png', 'png');
  // Saturn has no clear logo of its own; a theme's, on a screen-sized canvas, stands in.
  write('Themes/Unified/Images/Theme/Logo/Sega Saturn.png', 'png');
  const library = new Library({ platforms: ['Nintendo Entertainment System', 'MS-DOS', 'Sega Saturn'], launchboxRoot: root }, new PathResolver(root));
  await library.load();

  const nes = library.platforms.get('Nintendo Entertainment System');
  assert.equal(nes.logoRel, path.join('Images', 'Platforms', 'Nintendo Entertainment System', 'Clear Logo', 'Nintendo Entertainment System.png'));
  assert.equal(nes.logoTrim, false);
  assert.equal(nes.iconRel, path.join('Images', 'Platform Icons', 'Platforms', 'Nintendo Entertainment System.png'));
  const dos = library.platforms.get('MS-DOS');
  assert.equal(dos.iconRel, path.join('Images', 'Platform Icons', 'Platforms', 'MS DOS.png'));
  assert.equal(dos.logoRel, '', 'no logo anywhere: the heading shows the name');
  const saturn = library.platforms.get('Sega Saturn');
  assert.equal(saturn.logoRel, 'Themes\\Unified\\Images\\Theme\\Logo\\Sega Saturn.png');
  assert.equal(saturn.logoTrim, true);
  assert.equal(saturn.iconRel, '', 'no icon in the set');
});
