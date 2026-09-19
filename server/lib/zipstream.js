// Writes a zip straight to an HTTP response, without building it on disk first.
//
// romcache.js has a simpler writer for uncompressed zips of files it already knows the size
// and checksum of. A standalone download (see standalone.js) is different: most of it is made
// up as it goes (base64 text, generated pages), so each entry's checksum and packed size are
// only known once it has been written. Zip has a way to say so — the sizes go in a "data
// descriptor" after the entry rather than in the header before it — and that is what this
// uses, with the 64-bit fields for the rare entry over 4 GB.

import fs from 'node:fs';
import { pipeline, Readable } from 'node:stream';
import zlib from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const ZIP64_END_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

const MAX32 = 0xffffffff;
// Names are UTF-8 (bit 11) and the sizes follow the entry rather than lead it (bit 3).
const FLAGS = 0x0808;
// 1 January 1980, the earliest date a zip can hold. All zeros would be the 0th day of the 0th
// month, which some unzip tools refuse or show as a broken date.
const DOS_DATE = 0x0021;
const STORED = 0;
const DEFLATED = 8;

export class ZipStream {
  /** @param {import('node:stream').Writable} out */
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.entries = [];
  }

  /**
   * Adds one file.
   *
   * @param {string} name path inside the zip, with "/" between folders
   * @param {string|Buffer|AsyncIterable<Buffer>} source the file's contents
   * @param {object} [options]
   * @param {boolean} [options.deflate] pack it (worth it for text, not for a jpeg or a zip)
   * @param {number|null} [options.size] the unpacked size when it's known, so an entry over
   *   4 GB can say so in its header, which it has to do before the contents are written
   * @param {boolean} [options.huffmanOnly] pack it only by how often each character comes up,
   *   without looking for repeats: what's worth doing for base64 of data that's packed already
   *   (a game's zip), at a third of the time, the same size
   */
  async add(name, source, { deflate = false, size = null, huffmanOnly = false } = {}) {
    const nameBytes = Buffer.from(name, 'utf8');
    const zip64 = size !== null && size >= MAX32;
    const method = deflate ? DEFLATED : STORED;
    const start = this.offset;
    await this.#write(localHeader(nameBytes, method, zip64));

    let crc = 0;
    let packed = 0;
    let unpacked = 0;
    // The checksum and the unpacked size are of what went in, so they're counted on the way
    // past, before anything is packed. (zlib.crc32 is why package.json asks for Node 22.2 or
    // later.)
    async function* counted() {
      for await (const chunk of chunks(source)) {
        crc = zlib.crc32(chunk, crc);
        unpacked += chunk.length;
        yield chunk;
      }
    }
    // pipeline() rather than pipe(): pipe() leaves an error from the source with nothing
    // listening, which ends the whole process, and leaves the file it was reading open.
    // pipeline() hands it to the deflate stream instead, so the loop below throws, and tears
    // both streams down whichever end failed — the loop leaving early (a closed connection)
    // included.
    const body = deflate
      ? pipeline(Readable.from(counted()), zlib.createDeflateRaw(huffmanOnly ? { strategy: zlib.constants.Z_HUFFMAN_ONLY } : { level: 6 }), () => {})
      : counted();
    for await (const chunk of body) {
      packed += chunk.length;
      await this.#write(chunk);
    }

    crc >>>= 0;
    // The descriptor's fields have to be the width the header said they would be, and the
    // header can only know that from `size`. Nothing here writes an entry that big without
    // passing it (see standalone.js, where the payload is cut into pieces), so this is a
    // guard rather than a case to handle.
    if (!zip64 && (unpacked >= MAX32 || packed >= MAX32)) {
      throw new Error(`"${name}" is over 4 GB, so its size must be passed to add()`);
    }
    await this.#write(descriptor(crc, packed, unpacked, zip64));
    this.entries.push({ nameBytes, method, crc, packed, unpacked, offset: start, zip64: zip64 || start >= MAX32 });
  }

  /** Writes the index at the end of the zip. Nothing may be added afterwards. */
  async finish() {
    const start = this.offset;
    for (const entry of this.entries) await this.#write(centralHeader(entry));
    const size = this.offset - start;
    // A field at its largest value is the sign that says "look in the 64-bit record", so
    // a value that only reaches it needs that record too.
    const needs64 = start >= MAX32 || size >= MAX32 || this.entries.length >= 0xffff;
    if (needs64) {
      await this.#write(zip64End(this.entries.length, size, start));
      await this.#write(zip64Locator(start + size));
    }
    await this.#write(end(this.entries.length, size, start, needs64));
  }

  #write(buffer) {
    this.offset += buffer.length;
    const { out } = this;
    if (out.destroyed) throw new Error('Connection closed');
    if (out.write(buffer)) return Promise.resolve();
    // Waiting for room to write: a connection that closes meanwhile never drains.
    return new Promise((resolve, reject) => {
      const done = (err) => {
        out.off('drain', onDrain);
        out.off('close', onClose);
        err ? reject(err) : resolve();
      };
      const onDrain = () => done();
      const onClose = () => done(new Error('Connection closed'));
      out.once('drain', onDrain);
      out.once('close', onClose);
    });
  }
}

/** A source's bytes, whatever it was given as. */
async function* chunks(source) {
  if (typeof source === 'string') yield Buffer.from(source, 'utf8');
  else if (Buffer.isBuffer(source)) yield source;
  else yield* source;
}

/** The bytes of a file on disk, as a source for add(). */
export const fileSource = (file) => fs.createReadStream(file, { highWaterMark: 1 << 20 });

function localHeader(nameBytes, method, zip64) {
  const extra = zip64 ? zip64Extra(0, 0) : Buffer.alloc(0);
  const b = Buffer.alloc(30);
  b.writeUInt32LE(LOCAL_SIG, 0);
  b.writeUInt16LE(zip64 ? 45 : 20, 4);
  b.writeUInt16LE(FLAGS, 6);
  b.writeUInt16LE(method, 8);
  b.writeUInt16LE(0, 10);              // time: midnight
  b.writeUInt16LE(DOS_DATE, 12);       // date
  b.writeUInt32LE(0, 14);              // checksum: in the descriptor after the entry
  b.writeUInt32LE(zip64 ? MAX32 : 0, 18);
  b.writeUInt32LE(zip64 ? MAX32 : 0, 22);
  b.writeUInt16LE(nameBytes.length, 26);
  b.writeUInt16LE(extra.length, 28);
  return Buffer.concat([b, nameBytes, extra]);
}

function descriptor(crc, packed, unpacked, zip64) {
  const b = Buffer.alloc(zip64 ? 24 : 16);
  b.writeUInt32LE(DESCRIPTOR_SIG, 0);
  b.writeUInt32LE(crc, 4);
  if (zip64) {
    b.writeBigUInt64LE(BigInt(packed), 8);
    b.writeBigUInt64LE(BigInt(unpacked), 16);
  } else {
    b.writeUInt32LE(packed, 8);
    b.writeUInt32LE(unpacked, 12);
  }
  return b;
}

/** The 64-bit sizes an entry carries when it, or where it sits, won't fit in 32 bits. */
function zip64Extra(unpacked, packed, offset = null) {
  const b = Buffer.alloc(4 + 16 + (offset === null ? 0 : 8));
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(b.length - 4, 2);
  b.writeBigUInt64LE(BigInt(unpacked), 4);
  b.writeBigUInt64LE(BigInt(packed), 12);
  if (offset !== null) b.writeBigUInt64LE(BigInt(offset), 20);
  return b;
}

function centralHeader({ nameBytes, method, crc, packed, unpacked, offset, zip64 }) {
  const extra = zip64 ? zip64Extra(unpacked, packed, offset) : Buffer.alloc(0);
  const b = Buffer.alloc(46);
  b.writeUInt32LE(CENTRAL_SIG, 0);
  b.writeUInt16LE(zip64 ? 45 : 20, 4);  // made by
  b.writeUInt16LE(zip64 ? 45 : 20, 6);  // version needed
  b.writeUInt16LE(FLAGS, 8);
  b.writeUInt16LE(method, 10);
  b.writeUInt16LE(0, 12);               // time: midnight
  b.writeUInt16LE(DOS_DATE, 14);        // date
  b.writeUInt32LE(crc, 16);
  b.writeUInt32LE(zip64 ? MAX32 : packed, 20);
  b.writeUInt32LE(zip64 ? MAX32 : unpacked, 24);
  b.writeUInt16LE(nameBytes.length, 28);
  b.writeUInt16LE(extra.length, 30);
  b.writeUInt32LE(zip64 ? MAX32 : offset, 42);
  return Buffer.concat([b, nameBytes, extra]);
}

function zip64End(count, size, offset) {
  const b = Buffer.alloc(56);
  b.writeUInt32LE(ZIP64_END_SIG, 0);
  b.writeBigUInt64LE(BigInt(44), 4);    // size of this record after these 12 bytes
  b.writeUInt16LE(45, 12);
  b.writeUInt16LE(45, 14);
  b.writeUInt32LE(0, 16);
  b.writeUInt32LE(0, 20);
  b.writeBigUInt64LE(BigInt(count), 24);
  b.writeBigUInt64LE(BigInt(count), 32);
  b.writeBigUInt64LE(BigInt(size), 40);
  b.writeBigUInt64LE(BigInt(offset), 48);
  return b;
}

function zip64Locator(offset) {
  const b = Buffer.alloc(20);
  b.writeUInt32LE(ZIP64_LOCATOR_SIG, 0);
  b.writeUInt32LE(0, 4);
  b.writeBigUInt64LE(BigInt(offset), 8);
  b.writeUInt32LE(1, 16);
  return b;
}

function end(count, size, offset, zip64) {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(END_SIG, 0);
  b.writeUInt16LE(0, 4);
  b.writeUInt16LE(0, 6);
  b.writeUInt16LE(zip64 ? 0xffff : count, 8);
  b.writeUInt16LE(zip64 ? 0xffff : count, 10);
  b.writeUInt32LE(zip64 ? MAX32 : size, 12);
  b.writeUInt32LE(zip64 ? MAX32 : offset, 16);
  b.writeUInt16LE(0, 20);
  return b;
}
