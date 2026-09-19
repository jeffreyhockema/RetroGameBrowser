import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import yauzl from 'yauzl';
import { RomCache, holdCacheDir, parseArchiveListing, storedZip, storedZipSize, worthUnpacking } from '../server/lib/romcache.js';

// LaunchBox's own 7-Zip, for the tests that unpack; they're skipped on a PC without it.
const SEVEN_ZIP = 'R:\\Games\\LaunchBox\\ThirdParty\\7-Zip\\7z.exe';
const noSevenZip = !fs.existsSync(SEVEN_ZIP) && '7-Zip not found';

test('parseArchiveListing counts files and their size, not folders', () => {
  const listing = [
    '7-Zip 25.01 (x64) : Copyright (c) 1999-2025 Igor Pavlov : 2025-08-03', '', 'Listing archive: t.7z', '', '--',
    'Path = t.7z', 'Type = 7z', 'Physical Size = 300227', '', '----------',
    'Path = sub', 'Size = 0', 'Attributes = D', 'Encrypted = -', '',
    'Path = b.cue', 'Size = 3', 'Attributes = A', '',
    'Path = sub\\a.bin', 'Size = 300000', 'Attributes = A', '',
    'Path = other', 'Folder = +', 'Size = 0', '',
  ].join('\r\n');
  assert.deepEqual(parseArchiveListing(listing), { type: '7z', fileCount: 2, totalBytes: 300003 });
  assert.deepEqual(parseArchiveListing('Type = Rar5\n'), { type: 'rar5', fileCount: 0, totalBytes: 0 });
});

test('RomCache unpacks 7z, RAR and zip archives only, and remembers one too big to serve', { skip: noSevenZip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-romcache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'sub', 'Game (USA).bin'), Buffer.alloc(200000, 3));
  fs.writeFileSync(path.join(dir, 'src', 'Game (USA).cue'), 'FILE "sub/Game (USA).bin" BINARY\n');
  const archive = path.join(dir, 'Game (USA).7z');
  execFileSync(SEVEN_ZIP, ['a', '-bd', '-y', archive, './*'], { cwd: path.join(dir, 'src'), stdio: 'ignore' });

  const small = new RomCache({ dir: path.join(dir, 'small'), sevenZip: SEVEN_ZIP, maxBytes: 100000 });
  assert.equal(await small.unpacked(archive), null);
  assert.equal(small.refused.size, 1, 'remembered');
  assert.ok(!fs.existsSync(path.join(dir, 'small')) || !fs.readdirSync(path.join(dir, 'small')).length, 'nothing unpacked');

  const cache = new RomCache({ dir: path.join(dir, 'cache'), sevenZip: SEVEN_ZIP, maxBytes: 10e6 });
  const unpacked = await cache.unpacked(archive);
  assert.deepEqual(unpacked.files.map((f) => [f.name, f.size]), [['Game (USA).cue', 33], ['sub/Game (USA).bin', 200000]]);

  // Files only read from the cache folder (not zipped) aren't held to the zip format's limits.
  const partly = new RomCache({ dir: path.join(dir, 'partly'), sevenZip: SEVEN_ZIP, maxBytes: 10e6 });
  const cueOnly = await partly.unpacked(archive, { zipped: (name) => name.endsWith('.cue') });
  assert.deepEqual(cueOnly.files.map((f) => f.name), ['Game (USA).cue', 'sub/Game (USA).bin'], 'every file is still unpacked');

  // Something that isn't a 7z, RAR or zip archive, whatever it's called, isn't unpacked.
  const fake = path.join(dir, 'Fake.7z');
  execFileSync(SEVEN_ZIP, ['a', '-bd', '-y', '-ttar', fake, './*'], { cwd: path.join(dir, 'src'), stdio: 'ignore' });
  await assert.rejects(cache.unpacked(fake), /tar archive, not 7z, RAR or zip/);
});

test('RomCache.trim leaves folders being read alone', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-romtrim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = new RomCache({ dir, sevenZip: null, maxBytes: 150 });
  const made = [];
  for (const [i, name] of ['old', 'busy', 'new'].entries()) {
    const folder = path.join(dir, name);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ files: [{ name: 'x', size: 100 }], zipSize: 0 }));
    const when = new Date(Date.now() - (3 - i) * 60000);
    fs.utimesSync(path.join(folder, 'manifest.json'), when, when);
    made.push(folder);
  }
  const release = holdCacheDir(path.join(dir, 'busy'));
  await cache.trim(path.join(dir, 'new'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['busy', 'new'], 'the oldest went; the busy one stayed though older than the limit allows');
  release();
  await cache.trim(path.join(dir, 'new'));
  assert.deepEqual(fs.readdirSync(dir), ['new']);

  // An unpack waiting to be renamed into place isn't an entry yet, however full the cache; a
  // folder an eviction couldn't finish deleting isn't counted, and goes.
  for (const name of [`next.${process.pid}.tmp`, `gone.evict.${process.pid}.tmp`]) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'manifest.json'), JSON.stringify({ files: [{ name: 'x', size: 500 }], zipSize: 0 }));
  }
  await cache.trim(null);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['new', `next.${process.pid}.tmp`], 'nothing real evicted for them');
  await cache.trim(null, 0);
  assert.deepEqual(fs.readdirSync(dir), [`next.${process.pid}.tmp`], 'even emptying the cache leaves an unpack in progress alone');
});

test('RomCache.peek marks an unpacked archive as used, unless asked not to', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-rompeek-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archive = path.join(dir, 'Game.zip');
  fs.writeFileSync(archive, 'zip');
  const cache = new RomCache({ dir: path.join(dir, 'cache'), sevenZip: null, maxBytes: 1e6 });
  assert.equal(await cache.peek(archive), null, 'not unpacked');
  const folder = path.join(cache.dir, RomCache.key(archive, fs.statSync(archive)));
  fs.mkdirSync(folder, { recursive: true });
  const manifest = path.join(folder, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ files: [{ name: 'GAME.VHD', size: 3 }], zipSize: 0 }));
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(manifest, old, old);
  const got = await cache.peek(archive, { touch: false });
  assert.equal(got.dir, folder);
  assert.ok(Math.abs(fs.statSync(manifest).mtimeMs - old.getTime()) < 1000, 'left alone');
  await cache.peek(archive);
  assert.ok(Date.now() - fs.statSync(manifest).mtimeMs < 60_000, 'marked as used just now');
});

test('RomCache.packedFolder refuses a folder too big before copying anything', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-romfolder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'Game'));
  fs.writeFileSync(path.join(dir, 'Game', 'GAME.EXE'), Buffer.alloc(5000));
  const cache = new RomCache({ dir: path.join(dir, 'cache'), sevenZip: null, maxBytes: 1000 });
  assert.equal(await cache.packedFolder(path.join(dir, 'Game')), null);
  assert.equal(cache.refused.size, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'cache')), 'nothing copied');
});

test('RomCache.packedFolder records the size it copied, not an older listing\'s', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-romfolder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const game = path.join(dir, 'Game');
  fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, 'GAME.INI'), Buffer.alloc(100, 1));
  const cache = new RomCache({ dir: path.join(dir, 'cache'), sevenZip: null, maxBytes: 1e6 });
  assert.equal(await cache.packedFolderReady(game), null, 'not copied, but listed');
  fs.writeFileSync(path.join(game, 'GAME.INI'), Buffer.alloc(180, 2)); // the game wrote its settings meanwhile
  const got = await cache.packedFolder(game);
  const ini = got.files.find((f) => f.name === 'Game/GAME.INI');
  assert.equal(ini.size, 180);
  assert.equal(ini.crc, zlib.crc32(Buffer.alloc(180, 2)) >>> 0);
  assert.equal(got.zipSize, storedZipSize(got.files));
});

test('RomCache.packedFolder keeps empty folders, and makes a zip that reads back', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-romfolder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const game = path.join(dir, 'Game');
  for (const sub of ['WINDOWS/TEMP', 'SAVE', 'A/B']) fs.mkdirSync(path.join(game, sub), { recursive: true });
  fs.writeFileSync(path.join(game, 'GAME.EXE'), Buffer.alloc(3000, 1));
  fs.writeFileSync(path.join(game, 'WINDOWS', 'WIN.INI'), '[windows]');
  const cache = new RomCache({ dir: path.join(dir, 'cache'), sevenZip: null, maxBytes: 1e6 });
  const got = await cache.packedFolder(game);
  const names = got.files.map((f) => f.name);
  for (const name of ['Game/', 'Game/A/', 'Game/A/B/', 'Game/SAVE/', 'Game/WINDOWS/', 'Game/WINDOWS/TEMP/']) assert.ok(names.includes(name), name);
  assert.equal(new Set(names).size, names.length, 'each folder once');
  for (const sub of ['A/B', 'SAVE', 'WINDOWS/TEMP']) assert.ok(fs.statSync(path.join(got.dir, 'Game', ...sub.split('/'))).isDirectory(), sub);
  assert.equal(got.zipSize, storedZipSize(got.files));

  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  await storedZip(got, out);
  out.end();
  const zip = Buffer.concat(chunks);
  assert.equal(zip.length, got.zipSize);
  const read = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(zip, { lazyEntries: true }, (err, z) => {
      if (err) return reject(err);
      const entries = [];
      z.on('entry', (entry) => { entries.push(entry.fileName); z.readEntry(); });
      z.on('end', () => resolve(entries));
      z.readEntry();
    });
  });
  assert.deepEqual(read, names);
});

test('worthUnpacking picks big 7z and rar archives, and big zips of a CD', () => {
  assert.equal(worthUnpacking('Crash (USA).7z', 400e6, 32e6), true);
  assert.equal(worthUnpacking('Tiny (USA).7z', 1e6, 32e6), false);
  assert.equal(worthUnpacking('Contra (USA).zip', 400e6, 32e6), false);
  assert.equal(worthUnpacking('Hexen (USA).zip', 400e6, 32e6, { disc: true }), true);
  assert.equal(worthUnpacking('Tiny (USA).zip', 1e6, 32e6, { disc: true }), false);
});

test('storedZip writes a zip that unzip tools read back byte for byte', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-zip-'));
  const contents = { 'Game (USA).cue': Buffer.from('FILE "Game (USA).bin" BINARY\n'), 'sub/Game (USA).bin': Buffer.alloc(300000, 7) };
  const files = [];
  for (const [name, data] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
    files.push({ name, size: data.length, crc: zlib.crc32(data) >>> 0 });
  }
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  await storedZip({ dir, files }, out);
  out.end();
  const zip = Buffer.concat(chunks);
  assert.equal(zip.length, storedZipSize(files));

  const read = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(zip, { lazyEntries: true }, (err, z) => {
      if (err) return reject(err);
      const got = {};
      z.on('entry', (entry) => z.openReadStream(entry, (e, s) => {
        if (e) return reject(e);
        const parts = [];
        s.on('data', (c) => parts.push(c));
        s.on('end', () => { got[entry.fileName] = Buffer.concat(parts); z.readEntry(); });
      }));
      z.on('end', () => resolve(got));
      z.readEntry();
    });
  });
  assert.deepEqual(Object.keys(read).sort(), Object.keys(contents).sort());
  for (const [name, data] of Object.entries(contents)) assert.ok(read[name].equals(data), name);
  fs.rmSync(dir, { recursive: true, force: true });
});
