// Virtual hard disks (Microsoft VHD), read a piece at a time for the browser's DOSBox-X.
//
// eXoWin9x starts every game from the same Windows 98 disk (a VHD of a few hundred MB) with
// the game's own VHD beside it. The browser can't hold those in memory, so js-dos reads them
// over HTTP as "sockdrives": a description of the disk (sockdrive.metaj), then pieces of
// RANGE_BYTES each (<n>.raw) as the emulator reaches them. Pieces that are all zeros are
// listed up front and never asked for. See sockdriveInfo and server/lib/win9x.js.

import fsp from 'node:fs/promises';
import path from 'node:path';

/** Size of one piece of a disk sent to the browser (js-dos's "ahead_read"), as dos.zone uses. */
export const RANGE_BYTES = 256 * 1024;

const SECTOR = 512;
const UNALLOCATED = 0xffffffff;
const TYPE_FIXED = 2;
const TYPE_DYNAMIC = 3;
const TYPE_DIFFERENCING = 4;

/**
 * Opens a VHD for reading. Fixed and dynamic disks are supported; eXo's are dynamic. A
 * differencing disk needs its parent, which eXo's launchers make on the fly and never ship.
 * @returns {Promise<{ file: string, diskBytes: number, heads: number, sectors: number,
 *   read: (offset: number, length: number) => Promise<Buffer>, isEmpty: (offset: number, length: number) => boolean,
 *   close: () => Promise<void> }>}
 */
export async function openVhd(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size: fileBytes } = await handle.stat();
    if (fileBytes < SECTOR) throw new Error(`${path.basename(file)} is too small to be a VHD.`);
    const footer = await readAt(handle, fileBytes - SECTOR, SECTOR);
    if (footer.toString('latin1', 0, 8) !== 'conectix') throw new Error(`${path.basename(file)} isn't a VHD.`);
    const type = footer.readUInt32BE(60);
    const diskBytes = Number(footer.readBigUInt64BE(48));
    let map;
    if (type === TYPE_FIXED) {
      if (diskBytes > fileBytes - SECTOR) throw new Error(`${path.basename(file)} is shorter than the disk it describes.`);
      map = fixedMap(diskBytes);
    } else if (type === TYPE_DYNAMIC) {
      map = await dynamicMap(handle, footer, fileBytes, diskBytes, file);
    } else if (type === TYPE_DIFFERENCING) {
      throw new Error(`${path.basename(file)} is a differencing VHD, which needs its parent disk.`);
    } else {
      throw new Error(`${path.basename(file)} is a VHD of an unknown type (${type}).`);
    }

    const read = async (offset, length) => {
      const out = Buffer.alloc(length);
      const end = Math.min(offset + length, diskBytes);
      for (let pos = offset; pos < end;) {
        const piece = map.locate(pos, end - pos);
        if (piece.at !== null) await readInto(handle, out, pos - offset, piece.length, piece.at);
        pos += piece.length;
      }
      return out; // past the end of the disk, and where nothing was ever written, it's zeros
    };
    const isEmpty = (offset, length) => {
      const end = Math.min(offset + length, diskBytes);
      for (let pos = offset; pos < end;) {
        const piece = map.locate(pos, end - pos);
        if (piece.at !== null) return false;
        pos += piece.length;
      }
      return true;
    };
    const { heads, sectors } = geometry(await read(0, SECTOR), footer);
    return { file, diskBytes, heads, sectors, read, isEmpty, close: () => handle.close() };
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

/** A fixed VHD is the disk itself, with the footer after it. */
function fixedMap(diskBytes) {
  return { locate: (pos, length) => ({ at: pos, length: Math.min(length, diskBytes - pos) }) };
}

/**
 * A dynamic VHD keeps the disk in blocks (2 MB in eXo's), listed in a block table: each block
 * that was ever written has a sector bitmap and then its data; the others read as zeros.
 */
async function dynamicMap(handle, footer, fileBytes, diskBytes, file) {
  const name = path.basename(file);
  const headerAt = Number(footer.readBigUInt64BE(16));
  if (headerAt + 1024 > fileBytes) throw new Error(`${name} has no dynamic disk header.`);
  const header = await readAt(handle, headerAt, 1024);
  if (header.toString('latin1', 0, 8) !== 'cxsparse') throw new Error(`${name} has a damaged dynamic disk header.`);
  const tableAt = Number(header.readBigUInt64BE(16));
  const blocks = header.readUInt32BE(28);
  const blockBytes = header.readUInt32BE(32);
  if (!blockBytes || blockBytes % SECTOR || blocks * blockBytes < diskBytes || tableAt + blocks * 4 > fileBytes) {
    throw new Error(`${name} has a damaged block table.`);
  }
  const table = await readAt(handle, tableAt, blocks * 4);
  const bitmapBytes = Math.ceil(blockBytes / SECTOR / 8 / SECTOR) * SECTOR;
  // The footer is copied at the very end: a block's data must end before it.
  const dataEnd = fileBytes - SECTOR;
  return {
    locate(pos, length) {
      const block = Math.floor(pos / blockBytes);
      const inBlock = pos - block * blockBytes;
      const n = Math.min(length, blockBytes - inBlock);
      const sector = table.readUInt32BE(block * 4);
      if (sector === UNALLOCATED) return { at: null, length: n };
      const at = sector * SECTOR + bitmapBytes + inBlock;
      if (at + n > dataEnd) throw new Error(`${name} has a block past the end of the file.`);
      return { at, length: n };
    },
  };
}

/**
 * Heads and sectors per track the disk was partitioned with, from its first partition's end
 * (the BIOS geometry Windows expects). The VHD footer's own geometry is ATA-style (255 sectors
 * per track on eXo's Windows disk), which a BIOS can't have; it's used only without a partition.
 */
export function geometry(mbr, footer = null) {
  if (mbr.length >= SECTOR && mbr[510] === 0x55 && mbr[511] === 0xaa && mbr[0x1c2] !== 0) {
    const heads = mbr[0x1c3] + 1;
    const sectors = mbr[0x1c4] & 0x3f;
    if (sectors > 0) return { heads, sectors };
  }
  const heads = footer ? footer[58] : 16;
  const sectors = footer ? footer[59] : 63;
  return { heads: Math.min(Math.max(heads, 1), 255), sectors: Math.min(Math.max(sectors, 1), 63) };
}

/**
 * The description js-dos reads first (sockdrive.metaj). `size` is in KiB. Pieces that are all
 * zeros go in dropped_ranges, which the emulator fills in itself; eXo's 64 GB Windows disk has
 * about 1,500 pieces with anything in them out of 262,144.
 */
export function sockdriveInfo(vhd, name) {
  const rangeCount = Math.ceil(vhd.diskBytes / RANGE_BYTES);
  const dropped = [];
  for (let r = 0; r < rangeCount; r++) if (vhd.isEmpty(r * RANGE_BYTES, RANGE_BYTES)) dropped.push(r);
  const totalSectors = Math.floor(vhd.diskBytes / SECTOR);
  return {
    name,
    ahead_read: RANGE_BYTES,
    sector_size: SECTOR,
    size: Math.floor(vhd.diskBytes / 1024),
    heads: vhd.heads,
    sectors: vhd.sectors,
    cylinders: Math.floor(totalSectors / (vhd.heads * vhd.sectors)),
    range_count: rangeCount,
    dropped_ranges: dropped,
    preload_ranges: [],
    small_ranges: [],
  };
}

/**
 * Disks being played from, kept open between the browser's requests (a Windows boot asks for a
 * few hundred pieces) and closed after a while without any. Each comes with its description,
 * which takes a pass over the block table to make.
 */
export class DiskPool {
  constructor({ idleMs = 10 * 60 * 1000 } = {}) {
    this.idleMs = idleMs;
    this.disks = new Map(); // "file|stamp" -> { promise, timer, release }
  }

  /**
   * The open disk and its sockdrive description: { vhd, info }. `stamp` tells versions of a file
   * apart (its size and date): a changed file is opened afresh. `hold` is called when the disk
   * is first opened and the function it returns when it's closed (see holdCacheDir).
   */
  open(file, { stamp = '', name = path.basename(file), hold = null } = {}) {
    const key = `${file}|${stamp}`;
    let entry = this.disks.get(key);
    if (!entry) {
      entry = { timer: null, release: null };
      entry.promise = (async () => {
        entry.release = hold?.() ?? null;
        const vhd = await openVhd(file);
        // A read that fails (a network share that dropped) leaves the file handle useless: the
        // disk is forgotten, so the next request opens the file again.
        const read = vhd.read;
        vhd.read = (offset, length) => read(offset, length).catch((err) => {
          this.#close(key, entry);
          throw err;
        });
        return { vhd, info: sockdriveInfo(vhd, name) };
      })();
      entry.promise.catch(() => this.#close(key, entry));
      this.disks.set(key, entry);
    }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.#close(key, entry), this.idleMs);
    entry.timer.unref?.();
    return entry.promise;
  }

  #close(key, entry) {
    if (this.disks.get(key) !== entry) return;
    this.disks.delete(key);
    clearTimeout(entry.timer);
    // A handle that's already broken may fail to close too; that's no reason to stop the server.
    entry.promise.then(({ vhd }) => vhd.close()).catch(() => {}).finally(() => entry.release?.());
  }

  /** Closes every disk (for tests). */
  closeAll() {
    for (const [key, entry] of this.disks) this.#close(key, entry);
  }
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  await readInto(handle, buffer, 0, length, position);
  return buffer;
}

async function readInto(handle, buffer, offset, length, position) {
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, offset + done, length - done, position + done);
    if (!bytesRead) throw new Error('The disk image ended early.');
    done += bytesRead;
  }
}
