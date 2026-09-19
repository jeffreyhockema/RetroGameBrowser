import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeTitle, parseMediaFileName, MediaIndex } from '../server/lib/media.js';
import { parseScummvmId } from '../server/lib/scummvm.js';
import { PathResolver } from '../server/lib/paths.js';
import { list, readLaunchBoxXml, parseLaunchBoxXml } from '../server/lib/xml.js';

test('sanitizeTitle matches LaunchBox media file names', () => {
  assert.equal(sanitizeTitle("Al Emmo and the Lost Dutchman's Mine"), 'Al Emmo and the Lost Dutchman_s Mine');
  assert.equal(sanitizeTitle('Quest for Glory 2: Trial by Fire'), 'Quest for Glory 2_ Trial by Fire');
  assert.equal(sanitizeTitle('What? Where/Why*'), 'What_ Where_Why_');
});

test('parseMediaFileName splits the sequence number off', () => {
  assert.deepEqual(parseMediaFileName('Zork Zero_ The Revenge of Megaboz-01.jpg'), { key: 'zork zero_ the revenge of megaboz', seq: 1, ext: '.jpg' });
  assert.deepEqual(parseMediaFileName('Space Quest 0-Replicated.PNG'), { key: 'space quest 0-replicated', seq: 0, ext: '.png' });
});

test('MediaIndex prefers game region, then region priorities, then no region', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-media-'));
  const dir = path.join(root, 'Images', 'P', 'Box - Front');
  for (const [sub, name] of [['', 'Discworld-01.jpg'], ['Europe', 'Discworld-01.jpg'], ['North America', 'Discworld-01.jpg'],
    ['', 'Discworld-02.png'], ['', 'Discworld Noir-01.jpg']]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.writeFileSync(path.join(dir, sub, name), '');
  }
  const index = await new MediaIndex([{ mediaType: 'Box - Front', folderPath: 'Images\\P\\Box - Front' }], new PathResolver(root)).build();

  const byPriority = index.find('Box - Front', 'Discworld', { regionPriorities: ['North America'] }).map((f) => f.region);
  assert.deepEqual(byPriority, ['North America', null, null, 'Europe']);

  const byGame = index.find('Box - Front', 'Discworld', { gameRegion: 'Europe', regionPriorities: ['North America'] });
  assert.equal(byGame[0].region, 'Europe');

  assert.equal(index.find('Box - Front', 'Discworld Noir').length, 1, 'titles must match whole, not by prefix');
  fs.rmSync(root, { recursive: true, force: true });
});

test('MediaIndex finds a title ending in a dash and a number, whose file has no number of its own', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-media-dash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'Videos', 'P');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['F-15.mp4', 'F-19-01.mp4', 'F-02.mp4']) fs.writeFileSync(path.join(dir, name), '');
  const index = await new MediaIndex([{ mediaType: 'Video', folderPath: 'Videos\\P' }], new PathResolver(root)).build();
  assert.deepEqual(index.find('Video', 'F-15').map((f) => [path.basename(f.rel), f.seq]), [['F-15.mp4', 0]]);
  assert.deepEqual(index.find('Video', 'F-19').map((f) => path.basename(f.rel)), ['F-19-01.mp4']);
  assert.deepEqual(index.find('Video', 'F').map((f) => path.basename(f.rel)), ['F-02.mp4', 'F-15.mp4'], 'a game called F keeps its own');
});

test('MediaIndex matches a name with a year after it, and keeps each game to its own year', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-media-year-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'Videos', 'P');
  fs.mkdirSync(dir, { recursive: true });
  // eXo names its videos with the year; two different games are called Prince of Persia, and
  // the 1989 one has two videos of its own.
  for (const name of ['Prince of Persia (1989).mp4', 'Prince of Persia (1989)-02.mp4',
    'Prince of Persia (2008).mp4', 'Wolfenstein 3D (1992).mp4']) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  const index = await new MediaIndex([{ mediaType: 'Video', folderPath: 'Videos\\P' }], new PathResolver(root)).build();

  // LaunchBox looks for the name without a year, and its own year can differ from eXo's.
  assert.equal(index.find('Video', 'Wolfenstein 3D', { gameYear: 1994 }).length, 1);

  const older = index.find('Video', 'Prince of Persia', { gameYear: 1990 }).map((f) => path.basename(f.rel));
  assert.deepEqual(older, ['Prince of Persia (1989).mp4', 'Prince of Persia (1989)-02.mp4'],
    'both of that game\'s videos, and neither of the other game\'s');
  const newer = index.find('Video', 'Prince of Persia', { gameYear: 2008 }).map((f) => path.basename(f.rel));
  assert.deepEqual(newer, ['Prince of Persia (2008).mp4']);

  // Nothing to tell them apart by: better to offer both than to guess.
  assert.equal(index.find('Video', 'Prince of Persia').length, 3);
});

test('parseScummvmId reads the game ID from an eXo launcher', () => {
  const bat = [
    '@echo off',
    ':launch',
    '".\\scmvm\\scummvm.exe" --no-console -F -g2x --opl-driver=nuked --output-rate=44100 --aspect-ratio -p".\\eXoScummVM\\%GameDir%" ootopos',
    'goto end',
  ].join('\r\n');
  assert.equal(parseScummvmId(bat), 'ootopos');
  assert.equal(parseScummvmId('@echo off\r\necho nothing here'), null);
});

test('PathResolver refuses paths that escape the root', () => {
  const root = path.resolve('R:\\Games\\LaunchBox');
  assert.equal(PathResolver.within(root, '..\\Other\\x.txt'), null);
  assert.equal(PathResolver.within(root, 'Images\\..\\..\\secret'), null);
  assert.equal(PathResolver.within(root, 'Images\\a.png'), path.join(root, 'Images', 'a.png'));
});

test('PathResolver falls back to mirror roots', () => {
  const primary = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-primary-'));
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-mirror-'));
  fs.mkdirSync(path.join(mirror, 'eXo'));
  fs.writeFileSync(path.join(mirror, 'eXo', 'game.bat'), '');
  const resolver = new PathResolver(primary, [mirror]);
  assert.equal(resolver.resolve('eXo\\game.bat'), path.join(mirror, 'eXo', 'game.bat'));
  assert.equal(resolver.resolve('eXo\\missing.bat'), null);
  fs.rmSync(primary, { recursive: true, force: true });
  fs.rmSync(mirror, { recursive: true, force: true });
});

test('list splits LaunchBox multi-value fields', () => {
  assert.deepEqual(list('Action; Adventure;  Role-Playing '), ['Action', 'Adventure', 'Role-Playing']);
  assert.deepEqual(list(''), []);
});

test('readLaunchBoxXml parses a big file in a worker the same as inline', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-xml-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const notes = 'x'.repeat(2 * 1024 * 1024);
  const text = `\ufeff<?xml version="1.0" standalone="yes"?>\n<LaunchBox>\n<Game><ID>d1</ID><Title>1942</Title><Notes>${notes}</Notes></Game>\n</LaunchBox>\n`;
  const file = path.join(dir, 'MS-DOS.xml');
  fs.writeFileSync(file, text);
  const read = await readLaunchBoxXml(file);
  assert.deepEqual(read, parseLaunchBoxXml(text));
  assert.ok(Array.isArray(read.Game), 'one game is still a list');
  assert.equal(read.Game[0].Title, '1942', 'kept as a string');

  // A cut-off file fails in the worker as it does inline.
  fs.writeFileSync(file, text.slice(0, text.indexOf('</LaunchBox>')));
  await assert.rejects(readLaunchBoxXml(file), /MS-DOS\.xml is incomplete/);
});

test('parseLaunchBoxXml turns down an empty or cut-off document, not an empty list', () => {
  const header = '<?xml version="1.0" standalone="yes"?>\n';
  assert.throws(() => parseLaunchBoxXml(''), /incomplete/);
  assert.throws(() => parseLaunchBoxXml(`${header}<LaunchBox>\n<Game><ID>1</ID></Game>\n`), /incomplete/);
  assert.throws(() => parseLaunchBoxXml(`${header}<LaunchBox>`), /incomplete/);
  assert.deepEqual(parseLaunchBoxXml(`${header}<LaunchBox />\r\n`), {});
  assert.deepEqual(parseLaunchBoxXml(`${header}<LaunchBox>\n<Game><ID>1</ID></Game>\n</LaunchBox>`).Game, [{ ID: '1' }]);
});
