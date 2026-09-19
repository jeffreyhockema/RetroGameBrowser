import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebPlay, dosLayout, knownIssueFor, INDEX_FORMAT } from '../server/lib/webplay.js';
import { PathResolver } from '../server/lib/paths.js';
import { folderExtras } from '../server/lib/library.js';

/** A temporary folder with stand-ins for the browser engines, so their versions count. */
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-webplay-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scummvmDir = path.join(dir, 'scummvm');
  const jsdosDir = path.join(dir, 'jsdos');
  fs.mkdirSync(scummvmDir);
  fs.mkdirSync(jsdosDir);
  fs.writeFileSync(path.join(scummvmDir, 'scummvm.wasm'), '');
  fs.writeFileSync(path.join(jsdosDir, 'js-dos.js'), '');
  return { dir, scummvmDir, jsdosDir, indexFile: path.join(dir, 'cache', 'dos-launchers.json') };
}

const libraryOf = (...games) => ({ generation: 1, gamesById: new Map(games.map((g) => [g.id, g])) });

const dosGame = {
  id: 'dos1',
  title: 'Foo',
  applicationRel: 'eXo/eXoDOS/!dos/Foo/Foo (1990).bat',
  rootFolder: 'eXo/eXoDOS/!dos/Foo',
};
const dosVersion = {
  engine: 'dosbox', id: 'dos1-0', label: 'Foo', sounds: [{ driver: 'default', label: 'Standard' }], kind: { key: 'DOS' },
};

test('dosLayout finds the collection, eXo root and launcher folder of an eXo launcher', () => {
  // The function uses the platform's path module, so the expected paths are built with it too.
  const collection = 'eXo\\eXoDOS';
  assert.deepEqual(dosLayout({ applicationRel: 'eXo\\eXoDOS\\!dos\\funball\\Funball (1995).bat' }), {
    collection,
    exoRoot: path.dirname(collection),
    launcherDir: path.join(collection, '!dos', 'funball'),
    gameDir: 'funball',
  });
  const forward = dosLayout({ applicationRel: 'eXo/eXoDOS/!dos/funball/Funball (1995).bat' });
  assert.equal(forward.collection, 'eXo/eXoDOS');
  assert.equal(forward.gameDir, 'funball');
  assert.equal(forward.launcherDir, path.join('eXo/eXoDOS', '!dos', 'funball'));

  // It's only a pre-filter: an eXoScummVM launcher matches too. The two are told apart later,
  // by whether the launcher folder has a dosbox.conf (#indexDos).
  const scummvm = dosLayout({ applicationRel: 'eXo\\eXoScummVM\\!ScummVM\\Oo-Topos (DOS)\\Oo-Topos (DOS).bat' });
  assert.equal(scummvm.collection, 'eXo\\eXoScummVM');
  assert.equal(scummvm.gameDir, 'Oo-Topos (DOS)');
});

test('dosLayout returns null for anything that isn\'t an eXo launcher', () => {
  assert.equal(dosLayout({}), null);
  assert.equal(dosLayout({ applicationRel: '' }), null);
  assert.equal(dosLayout({ applicationRel: 'eXo\\eXoDOS\\!dos\\funball\\Funball.exe' }), null, 'not a .bat');
  assert.equal(dosLayout({ applicationRel: 'Games\\foo\\bar.bat' }), null, 'no "!" folder');
});

test('knownIssueFor looks up ScummVM games and engines in web-known-issues.json', () => {
  const { engines, games } = JSON.parse(fs.readFileSync(new URL('../server/data/web-known-issues.json', import.meta.url), 'utf8'));
  const engine = Object.keys(engines)[0];
  const game = Object.keys(games)[0];
  assert.equal(knownIssueFor({ gameId: `${engine}:anything` }), engines[engine]);
  assert.equal(knownIssueFor({ gameId: game }), games[game]);
  assert.equal(knownIssueFor({ gameId: `someengine:${game}` }), games[game]);
  if (games[game] !== engines[engine]) {
    assert.equal(knownIssueFor({ gameId: `${engine}:${game}` }), games[game], 'a game\'s entry wins over its engine\'s');
  }
  assert.equal(knownIssueFor({ gameId: 'nosuchengine:nosuchgame' }), null);
  assert.equal(knownIssueFor({}), null);
});

test('knownIssueFor passes a DOSBox version\'s own issue through', () => {
  assert.equal(knownIssueFor({ engine: 'dosbox', knownIssue: 'msg' }), 'msg');
  assert.equal(knownIssueFor({ engine: 'dosbox' }), null);
});

test('a DOS index run that can\'t read the launchers keeps the previous entries', async (t) => {
  const env = setup(t);
  fs.mkdirSync(path.dirname(env.indexFile));
  fs.writeFileSync(env.indexFile, JSON.stringify({ format: INDEX_FORMAT, builtAt: 'earlier', games: { dos1: [dosVersion] }, extras: { dos1: ['Map.pdf'] } }));
  const scummGame = {
    id: 'scumm1',
    title: 'Bar',
    applicationRel: 'eXo/eXoDOS/!dos/Bar/Bar.bat',
    rootFolder: 'eXo/eXoDOS/!dos/Bar',
  };
  // The share is down: nothing resolves.
  const asked = [];
  const resolver = { resolve: (rel) => { asked.push(rel); return null; } };
  const webPlay = new WebPlay(libraryOf(dosGame, scummGame), resolver, env);

  await webPlay.ensureIndexed();
  await webPlay.indexing;

  assert.deepEqual(webPlay.versionsFor(dosGame).map((v) => v.id), ['dos1-0']);
  assert.ok(webPlay.retryIndexAt > 0, 'another run is scheduled');
  const cached = JSON.parse(fs.readFileSync(env.indexFile, 'utf8'));
  assert.deepEqual(Object.keys(cached.games), ['dos1'], 'the cache still has the game');
  assert.deepEqual(cached.extras, { dos1: ['Map.pdf'] }, 'and its extras');

  // A game the run couldn't read, with nothing to carry over, isn't probed again per request.
  asked.length = 0;
  assert.deepEqual(webPlay.versionsFor(scummGame), []);
  assert.deepEqual(asked, []);
});

test('a first DOS index run that can\'t read the launchers isn\'t cached', async (t) => {
  const env = setup(t);
  const webPlay = new WebPlay(libraryOf(dosGame), { resolve: () => null }, env);
  await webPlay.ensureIndexed();
  assert.equal(fs.existsSync(env.indexFile), false);
  assert.deepEqual(webPlay.versionsFor(dosGame), []);
});

test('a readable launcher folder without dosbox.conf still gets its ScummVM versions', async (t) => {
  const env = setup(t);
  const root = path.join(env.dir, 'LaunchBox');
  fs.mkdirSync(path.join(root, 'eXo/eXoScummVM/!ScummVM/Game'), { recursive: true });
  fs.mkdirSync(path.join(root, 'eXo/eXoScummVM/Game'), { recursive: true });
  fs.writeFileSync(path.join(root, 'eXo/eXoScummVM/Game/data.000'), 'x');
  fs.writeFileSync(path.join(root, 'eXo/eXoScummVM/!ScummVM/Game/Game.bat'),
    '".\\scmvm\\scummvm.exe" --no-console -p"./eXoScummVM/Game" tentacle\r\n');
  const game = {
    id: 'scumm1',
    title: 'Game',
    applicationRel: 'eXo/eXoScummVM/!ScummVM/Game/Game.bat',
    rootFolder: 'eXo/eXoScummVM/!ScummVM/Game',
  };
  // Its launcher folder is readable; another game's is simply missing.
  const missing = { ...dosGame, id: 'gone', applicationRel: 'eXo/eXoScummVM/!ScummVM/Gone/Gone.bat' };
  const webPlay = new WebPlay(libraryOf(game, missing), new PathResolver(root), env);

  await webPlay.ensureIndexed();

  assert.equal(webPlay.retryIndexAt, 0, 'nothing failed');
  const versions = webPlay.versionsFor(game);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].engine, 'scummvm');
  assert.deepEqual(webPlay.versionsFor(missing), []);
  assert.ok(fs.existsSync(env.indexFile));
});

test('a Windows 9x game that runs in 86Box gets a version saying so, which counts as not running in the browser', async (t) => {
  const env = setup(t);
  const root = path.join(env.dir, 'LaunchBox');
  const launcher = path.join(root, 'eXo/eXoWin9x/!win9x/1996/Quake (1996)');
  fs.mkdirSync(launcher, { recursive: true });
  fs.writeFileSync(path.join(launcher, 'Quake (1996).bat'), '.\\util\\9xlaunch86Box.bat\r\n');
  fs.writeFileSync(path.join(launcher, 'Play.cfg'), '[Machine]\r\n');
  const game = {
    id: 'quake',
    title: 'Quake',
    applicationRel: 'eXo/eXoWin9x/!win9x/1996/Quake (1996)/Quake (1996).bat',
    rootFolder: 'eXo/eXoWin9x/!win9x/1996/Quake (1996)',
  };
  const webPlay = new WebPlay(libraryOf(game), new PathResolver(root), env);

  await webPlay.ensureIndexed();

  const versions = webPlay.versionsFor(game);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].win9x, true);
  assert.match(knownIssueFor(versions[0]), /86Box/);
  await assert.rejects(webPlay.dosLaunch(versions[0], 'default'), /86Box/, '"Try anyway" says why');
});

test('the DOS index lists each launcher\'s Extras folder for the shelf', async (t) => {
  const env = setup(t);
  const root = path.join(env.dir, 'LaunchBox');
  const write = (rel, text = '') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('eXo/eXoDOS/!dos/Foo/Foo (1990).bat');
  write('eXo/eXoDOS/!dos/Foo/dosbox.conf', '[autoexec]\r\nmount c .\\eXoDOS\\Foo\r\nc:\r\nfoo.exe\r\n');
  write('eXo/eXoDOS/!dos/Foo/Extras/Map.pdf');
  write('eXo/eXoDOS/!dos/Foo/Extras/Manual.txt');
  write('eXo/eXoDOS/!dos/Foo/Extras/setup.bat');
  write('eXo/eXoDOS/!dos/Foo/Extras/Scans/page1.jpg');
  // A launcher without dosbox.conf still has its extras listed, minus the ones LaunchBox lists.
  write('eXo/eXoDOS/!dos/Bar/Bar.bat');
  write('eXo/eXoDOS/!dos/Bar/Extras/Hints.pdf');
  write('eXo/eXoDOS/!dos/Bar/Extras/Cheats.txt');
  const foo = () => ({ ...dosGame, extras: [] });
  const listed = { id: 'guid-1', name: 'Hints', rel: 'eXo/eXoDOS/!dos/Bar/Extras/Hints.pdf', ext: 'pdf', priority: 0 };
  const bar = () => ({
    id: 'bar1', title: 'Bar', applicationRel: 'eXo/eXoDOS/!dos/Bar/Bar.bat', rootFolder: 'eXo/eXoDOS/!dos/Bar', extras: [listed],
  });
  const library = libraryOf(foo(), bar());
  const webPlay = new WebPlay(library, new PathResolver(root), env);
  await webPlay.ensureIndexed();

  const game = foo();
  webPlay.attachFolderExtras(game);
  assert.deepEqual(game.extras.map((e) => e.id), ['folder:Manual.txt', 'folder:Map.pdf']);
  assert.equal(game.extras[1].rel, path.join('eXo/eXoDOS/!dos/Foo', 'Extras', 'Map.pdf'));
  assert.equal(game.folderExtrasLoaded, true, 'the game page doesn\'t list the folder again');
  webPlay.attachFolderExtras(game);
  assert.equal(game.extras.length, 2, 'attaching again adds nothing');
  assert.equal(webPlay.versionsFor(game).length, 1);

  const other = bar();
  webPlay.attachFolderExtras(other);
  assert.deepEqual(other.extras.map((e) => e.id), ['guid-1', 'folder:Cheats.txt']);

  // The next index replaces the folder extras instead of adding to them.
  write('eXo/eXoDOS/!dos/Foo/Extras/Novel.pdf');
  library.generation++;
  await webPlay.ensureIndexed();
  await webPlay.indexing;
  webPlay.attachFolderExtras(game);
  assert.deepEqual(game.extras.map((e) => e.id), ['folder:Manual.txt', 'folder:Map.pdf', 'folder:Novel.pdf']);

  // A server starting with the share down gets them from the cache file.
  const later = new WebPlay(libraryOf(foo(), bar()), { resolve: () => null }, env);
  await later.ensureIndexed();
  const cachedGame = foo();
  later.attachFolderExtras(cachedGame);
  assert.deepEqual(cachedGame.extras.map((e) => e.id), ['folder:Manual.txt', 'folder:Map.pdf', 'folder:Novel.pdf']);
  await later.indexing;
});

test('extras read from a game\'s own folder stay out of its shelf summary', async (t) => {
  const env = setup(t);
  const root = path.join(env.dir, 'LaunchBox');
  fs.mkdirSync(path.join(root, 'Games/Baz/Extras'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Games/Baz/Extras/Map.pdf'), '');
  const resolver = new PathResolver(root);
  const listed = { id: 'guid-1', name: 'Hints', rel: 'Games/Baz/Hints.pdf', ext: 'pdf', priority: 0 };
  const record = () => ({ id: 'baz', title: 'Baz', rootFolder: 'Games/Baz', extras: [listed] });

  const game = record();
  const [first, second] = await Promise.all([folderExtras(resolver, game), folderExtras(resolver, game)]);
  assert.deepEqual(first.map((e) => e.id), ['guid-1', 'folder:Map.pdf']);
  assert.deepEqual(second, first, 'a request that came in meanwhile gets them too');
  assert.deepEqual(game.extras, [listed], 'the list the shelf summary reads is unchanged');

  // A library reload makes a new record; its folder extras are still found (the extras route).
  assert.deepEqual((await folderExtras(resolver, record())).map((e) => e.id), ['guid-1', 'folder:Map.pdf']);
});

test('installed engines are checked once per library generation', async (t) => {
  const env = setup(t);
  fs.mkdirSync(path.dirname(env.indexFile));
  const second = { ...dosGame, id: 'dos2' };
  fs.writeFileSync(env.indexFile, JSON.stringify({
    format: INDEX_FORMAT, builtAt: 'earlier', games: { dos1: [dosVersion], dos2: [{ ...dosVersion, id: 'dos2-0' }] },
  }));
  const library = libraryOf(dosGame, second);
  const webPlay = new WebPlay(library, { resolve: () => null }, env);
  await webPlay.ensureIndexed();
  await webPlay.indexing;

  assert.equal(webPlay.versionsFor(dosGame).length, 1);
  fs.rmSync(path.join(env.jsdosDir, 'js-dos.js'));
  assert.equal(webPlay.engineAvailable('dosbox'), false, 'the file routes see it at once');
  assert.equal(webPlay.versionsFor(second).length, 1, 'version lists keep this generation\'s answer');
  library.generation++;
  assert.deepEqual(webPlay.versionsFor(second), []);
});

test('a launcher that can\'t be read while its collection is there isn\'t retried or left out of the cache', async (t) => {
  const env = setup(t);
  const root = path.join(env.dir, 'LaunchBox');
  const launcher = path.join(root, 'eXo/eXoWin9x/!win9x/1996/Broken (1996)');
  fs.mkdirSync(launcher, { recursive: true });
  fs.writeFileSync(path.join(launcher, 'Broken (1996).bat'), '');
  fs.writeFileSync(path.join(launcher, 'Play.conf'), '[autoexec]\r\n');
  // A damaged zip: reading its entries fails every time.
  fs.mkdirSync(path.join(root, 'eXo/eXoWin9x/1996'));
  fs.writeFileSync(path.join(root, 'eXo/eXoWin9x/1996/Broken (1996).zip'), 'not a zip');
  const game = {
    id: 'broken',
    title: 'Broken',
    applicationRel: 'eXo/eXoWin9x/!win9x/1996/Broken (1996)/Broken (1996).bat',
    rootFolder: 'eXo/eXoWin9x/!win9x/1996/Broken (1996)',
  };
  const webPlay = new WebPlay(libraryOf(game), new PathResolver(root), env);
  await webPlay.ensureIndexed();

  assert.equal(webPlay.retryIndexAt, 0, 'it would only fail the same way again');
  assert.ok(fs.existsSync(env.indexFile));
  assert.deepEqual(webPlay.versionsFor(game), []);
});

test('a new DOS stamp during an index run answers from the index in hand instead of waiting', async (t) => {
  const env = setup(t);
  const root = path.join(env.dir, 'LaunchBox');
  fs.mkdirSync(path.join(root, 'eXo/eXoDOS/!dos/Foo'), { recursive: true });
  fs.mkdirSync(path.dirname(env.indexFile));
  fs.writeFileSync(env.indexFile, JSON.stringify({ format: INDEX_FORMAT, builtAt: 'earlier', games: { dos1: [dosVersion] } }));
  // The launchers are slow to read: the run stays under way until let go.
  let letGo;
  const gate = new Promise((resolve) => { letGo = resolve; });
  const readdir = fsp.readdir;
  t.mock.method(fsp, 'readdir', async (...args) => { await gate; return readdir(...args); });
  const library = libraryOf(dosGame);
  const webPlay = new WebPlay(library, new PathResolver(root), env);

  await webPlay.ensureIndexed();
  const run = webPlay.indexing;
  assert.ok(run, 'the cache is used and a run goes on in the background');
  library.generation++;
  const answer = await Promise.race([
    webPlay.ensureIndexed().then(() => 'answered'),
    new Promise((resolve) => setTimeout(resolve, 100, 'waited')),
  ]);
  assert.equal(answer, 'answered');
  assert.equal(webPlay.indexing, run, 'no second run alongside the first');
  assert.deepEqual(webPlay.versionsFor(dosGame).map((v) => v.id), ['dos1-0']);

  letGo();
  await run;
  await webPlay.ensureIndexed();
  assert.notEqual(webPlay.indexing, null, 'the next request starts a run for the new stamp');
  await webPlay.indexing;
  assert.equal(webPlay.indexedStamp, `generation:${library.generation}`);
});

test('requests arriving together with no index start one DOS index run', async (t) => {
  const env = setup(t);
  let probes = 0;
  const resolver = { resolve: (rel) => { if (rel === 'eXo/eXoDOS') probes++; return null; } };
  const library = libraryOf(dosGame);
  const webPlay = new WebPlay(library, resolver, env);
  await webPlay.ensureIndexed();
  const perRun = probes;
  assert.ok(perRun > 0);

  probes = 0;
  library.generation++;
  await Promise.all([webPlay.ensureIndexed(), webPlay.ensureIndexed(), webPlay.ensureIndexed()]);
  await webPlay.indexing;
  assert.equal(probes, perRun);
});

test('a launcher that can\'t be read gives no versions for now, and is read again next time', (t) => {
  const env = setup(t);
  const root = path.join(env.dir, 'LaunchBox');
  const bat = path.join(root, 'eXo/eXoScummVM/!ScummVM/Game/Game.bat');
  fs.mkdirSync(path.join(root, 'eXo/eXoScummVM/Game'), { recursive: true });
  fs.writeFileSync(path.join(root, 'eXo/eXoScummVM/Game/data.000'), 'x');
  // A folder where the launcher should be: reading it fails (EISDIR), as a locked file would.
  fs.mkdirSync(bat, { recursive: true });
  const game = {
    id: 'scumm1',
    title: 'Game',
    applicationRel: 'eXo/eXoScummVM/!ScummVM/Game/Game.bat',
    rootFolder: 'eXo/eXoScummVM/!ScummVM/Game',
  };
  const webPlay = new WebPlay(libraryOf(game), new PathResolver(root), env);
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(webPlay.versionsFor(game), []);
  assert.deepEqual(webPlay.allVersions(), [], 'the lists the game is in still come back');

  fs.rmSync(bat, { recursive: true });
  fs.writeFileSync(bat, '".\scmvm\scummvm.exe" --no-console -p"./eXoScummVM/Game" tentacle\r\n');
  assert.equal(webPlay.versionsFor(game).length, 1);
});

test('ScummVM launchers are read once per game record, not once per library generation', (t) => {
  const env = setup(t);
  const root = path.join(env.dir, 'LaunchBox');
  fs.mkdirSync(path.join(root, 'eXo/eXoScummVM/!ScummVM/Game'), { recursive: true });
  fs.mkdirSync(path.join(root, 'eXo/eXoScummVM/Game'), { recursive: true });
  fs.writeFileSync(path.join(root, 'eXo/eXoScummVM/Game/data.000'), 'x');
  fs.writeFileSync(path.join(root, 'eXo/eXoScummVM/!ScummVM/Game/Game.bat'),
    '".\scmvm\scummvm.exe" --no-console -p"./eXoScummVM/Game" tentacle\r\n');
  const game = {
    id: 'scumm1',
    title: 'Game',
    applicationRel: 'eXo/eXoScummVM/!ScummVM/Game/Game.bat',
    rootFolder: 'eXo/eXoScummVM/!ScummVM/Game',
  };
  const inner = new PathResolver(root);
  let resolved = 0;
  const resolver = { resolve: (rel) => { resolved++; return inner.resolve(rel); } };
  const library = libraryOf(game);
  const webPlay = new WebPlay(library, resolver, env);
  assert.equal(webPlay.versionsFor(game).length, 1);

  // Another platform's XML was read again: same record, nothing read.
  library.generation++;
  resolved = 0;
  assert.equal(webPlay.versionsFor(game).length, 1);
  assert.equal(resolved, 0);

  // Its own platform's XML was read again: a new record, so the launcher is read again.
  const reread = { ...game };
  library.gamesById.set(reread.id, reread);
  library.generation++;
  assert.equal(webPlay.versionsFor(reread).length, 1);
  assert.ok(resolved > 0);
});

test('a Windows 3.x game too big for the browser gets no browser copy', async () => {
  const webPlay = new WebPlay(libraryOf(), { resolve: () => null }, { maxWin3xBytes: 100, romCache: {} });
  const version = { engine: 'dosbox', win3x: true, dataAbs: 'X:\\eXo\\eXoWin3x\\Big', dataBytes: 101, gameDir: 'Big' };
  assert.equal(webPlay.win3xBundles(version), false);
  assert.equal(await webPlay.win3xBundle(version), null);
  assert.equal(webPlay.win3xBundles({ ...version, dataBytes: 100 }), true);
  assert.equal(webPlay.win3xBundles({ ...version, dataAbs: null }), false);
});
