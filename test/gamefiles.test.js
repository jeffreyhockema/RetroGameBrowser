import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import yauzl from 'yauzl';
import { gameFiles, writeFolderZip } from '../server/lib/gamefiles.js';

test('gameFiles says what each kind of version downloads as', () => {
  const game = { title: 'Loom', sortTitle: '' };
  assert.deepEqual(gameFiles(game, { engine: 'emulatorjs', romAbs: 'R:\\Games\\NES\\Zanac (USA).nes', romSize: 131088 }),
    { how: 'file', abs: 'R:\\Games\\NES\\Zanac (USA).nes', name: 'Zanac (USA).nes', bytes: 131088 });
  assert.deepEqual(gameFiles(game, { engine: 'dosbox', zipAbs: 'X:\\eXo\\eXoDOS\\Loom (1990).zip', zipSize: 5e6 }),
    { how: 'file', abs: 'X:\\eXo\\eXoDOS\\Loom (1990).zip', name: 'Loom (1990).zip', bytes: 5e6 });
  assert.deepEqual(gameFiles(game, { engine: 'dosbox', win3x: true, dataAbs: 'X:\\eXo\\eXoWin3x\\Loom', dataBytes: 9e6, label: 'Loom (Windows)' }),
    { how: 'bundle', name: 'Loom (Windows).zip', bytes: 9e6 });
  assert.deepEqual(gameFiles(game, { engine: 'scummvm', dir: 'X:\\eXo\\eXoScummVM\\Loom', label: 'Loom (CD DOS)' }, { totalBytes: 42 }),
    { how: 'folder', dir: 'X:\\eXo\\eXoScummVM\\Loom', name: 'Loom (CD DOS).zip', bytes: 42 });
  // Missing files: nothing to offer.
  assert.equal(gameFiles(game, { engine: 'emulatorjs', romAbs: null }), null);
  assert.equal(gameFiles(game, { engine: 'dosbox', zipAbs: null }), null);
  assert.equal(gameFiles(game, { engine: 'scummvm', dir: null }), null);
});

test('writeFolderZip zips a folder under a top folder, byte for byte', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-gamefiles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const contents = { 'LOOM.EXE': Buffer.alloc(70000, 3), 'sub/DISK01.LEC': Buffer.from('data'), 'sub/deeper/x.txt': Buffer.from('') };
  for (const [name, data] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
  }
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  await writeFolderZip(dir, 'Loom (CD DOS)', out);
  out.end();

  const read = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.concat(chunks), { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const files = {};
      zip.on('entry', (entry) => zip.openReadStream(entry, (e, s) => {
        if (e) return reject(e);
        const parts = [];
        s.on('data', (c) => parts.push(c)).on('end', () => { files[entry.fileName] = Buffer.concat(parts); zip.readEntry(); });
      }));
      zip.on('end', () => resolve(files));
      zip.readEntry();
    });
  });
  assert.deepEqual(Object.keys(read).sort(), Object.keys(contents).map((n) => `Loom (CD DOS)/${n}`).sort());
  for (const [name, data] of Object.entries(contents)) assert.ok(read[`Loom (CD DOS)/${name}`].equals(data), name);
});
