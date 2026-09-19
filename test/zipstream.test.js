import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import yauzl from 'yauzl';
import { ZipStream, fileSource } from '../server/lib/zipstream.js';

/** Everything the stream writes, as one buffer. */
async function build(add) {
  const out = new PassThrough();
  const parts = [];
  out.on('data', (chunk) => parts.push(chunk));
  const zip = new ZipStream(out);
  await add(zip);
  await zip.finish();
  out.end();
  return Buffer.concat(parts);
}

/** The zip read back the way an unzip program does: through its index, not its headers. */
function read(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const files = new Map();
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            files.set(entry.fileName, {
              data: Buffer.concat(chunks),
              uncompressedSize: entry.uncompressedSize,
              compressedSize: entry.compressedSize,
              method: entry.compressionMethod,
              crc32: entry.crc32,
              date: entry.lastModFileDate,
            });
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(files));
      zip.readEntry();
    });
  });
}

test('writes entries an unzip program can read back, packed and stored', async () => {
  // Text that packs down well, so a compressed size that was never counted would show up.
  const text = 'the quick brown fox jumps over the lazy dog\n'.repeat(5000);
  const binary = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256));

  const buffer = await build(async (zip) => {
    await zip.add('folder/notes.txt', text, { deflate: true });
    await zip.add('raw.bin', binary);
    await zip.add('empty.txt', '');
    await zip.add('huffman.txt', text, { deflate: true, huffmanOnly: true });
  });

  const files = await read(buffer);
  assert.deepEqual([...files.keys()], ['folder/notes.txt', 'raw.bin', 'empty.txt', 'huffman.txt']);
  assert.equal(files.get('huffman.txt').data.toString(), text);
  assert.equal(files.get('huffman.txt').method, 8);

  const notes = files.get('folder/notes.txt');
  assert.equal(notes.data.toString(), text);
  assert.equal(notes.uncompressedSize, Buffer.byteLength(text));
  assert.equal(notes.crc32, zlib.crc32(Buffer.from(text)) >>> 0);
  assert.equal(notes.method, 8);
  // The sizes go in after the entry rather than before it, so a bug there leaves a zero
  // behind that most unzip programs quietly work around. This is the check that catches it.
  assert.ok(notes.compressedSize > 0 && notes.compressedSize < notes.uncompressedSize, 'packed size recorded');

  assert.deepEqual(files.get('raw.bin').data, binary);
  assert.equal(files.get('raw.bin').method, 0);
  assert.equal(files.get('raw.bin').compressedSize, binary.length);

  assert.equal(files.get('empty.txt').data.length, 0);
  assert.equal(files.get('empty.txt').uncompressedSize, 0);
  // 1 January 1980, a real date, rather than zeros that some unzip programs refuse.
  assert.equal(notes.date, 0x0021);
});

test('writes a file from disk and an async source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-zip-'));
  const file = path.join(dir, 'source.bin');
  const contents = Buffer.from('a file on disk, read a chunk at a time');
  fs.writeFileSync(file, contents);

  async function* generated() {
    yield Buffer.from('one ');
    yield Buffer.from('two ');
    yield Buffer.from('three');
  }

  const buffer = await build(async (zip) => {
    await zip.add('source.bin', fileSource(file), { size: contents.length });
    await zip.add('made-up.txt', generated(), { deflate: true });
  });
  fs.rmSync(dir, { recursive: true, force: true });

  const files = await read(buffer);
  assert.deepEqual(files.get('source.bin').data, contents);
  assert.equal(files.get('made-up.txt').data.toString(), 'one two three');
});

test('a name with characters outside ASCII survives the round trip', async () => {
  const name = 'Café/Grüße — ¡olé!.txt';
  const files = await read(await build((zip) => zip.add(name, 'ok')));
  assert.deepEqual([...files.keys()], [name]);
  assert.equal(files.get(name).data.toString(), 'ok');
});

test('stops when the stream it writes to goes away', async () => {
  const out = new PassThrough();
  const zip = new ZipStream(out);
  out.destroy();
  await assert.rejects(() => zip.add('gone.txt', 'x'), /Connection closed/);
});

test('a source that fails part way through rejects rather than ending the process', async () => {
  // A game file that can't be read mid-entry. Piping the source into the packer would raise
  // this with nothing listening, which takes the whole server down instead of one download.
  async function* fails() {
    yield Buffer.from('the first chunk arrived');
    throw new Error('disk read failed');
  }
  const out = new PassThrough();
  out.resume();
  const zip = new ZipStream(out);
  await assert.rejects(() => zip.add('half.txt', fails(), { deflate: true }), /disk read failed/);
  // And the same for an entry that isn't packed, which takes a different path through add().
  await assert.rejects(() => zip.add('half.bin', fails()), /disk read failed/);
});
