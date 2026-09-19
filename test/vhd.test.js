import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openVhd, sockdriveInfo, geometry, DiskPool, RANGE_BYTES } from '../server/lib/vhd.js';

const SECTOR = 512;

/** A footer ("conectix") for a disk of `diskBytes`, of VHD `type` (2 fixed, 3 dynamic, 4 differencing). */
function footer(diskBytes, type, dataOffset) {
  const f = Buffer.alloc(SECTOR);
  f.write('conectix', 0, 'latin1');
  f.writeBigUInt64BE(BigInt(dataOffset), 16);
  f.writeBigUInt64BE(BigInt(diskBytes), 40);
  f.writeBigUInt64BE(BigInt(diskBytes), 48);
  f.writeUInt16BE(1000, 56);
  f[58] = 16;
  f[59] = 255; // ATA-style geometry, as eXo's Windows disk has
  f.writeUInt32BE(type, 60);
  return f;
}

/** A dynamic VHD whose blocks listed in `blocks` ({ index: Buffer of block data }) are allocated. */
function dynamicVhd(file, { diskBytes, blockBytes, blocks = {} }) {
  const count = Math.ceil(diskBytes / blockBytes);
  const header = Buffer.alloc(1024);
  header.write('cxsparse', 0, 'latin1');
  header.writeBigUInt64BE(0xffffffffffffffffn, 8);
  const tableAt = SECTOR + 1024;
  header.writeBigUInt64BE(BigInt(tableAt), 16);
  header.writeUInt32BE(count, 28);
  header.writeUInt32BE(blockBytes, 32);
  const tableBytes = Math.ceil((count * 4) / SECTOR) * SECTOR;
  const table = Buffer.alloc(tableBytes, 0xff);
  const bitmap = Buffer.alloc(Math.ceil(blockBytes / SECTOR / 8 / SECTOR) * SECTOR, 0xff);
  const parts = [footer(diskBytes, 3, SECTOR), header, table];
  let at = tableAt + tableBytes;
  for (const [index, data] of Object.entries(blocks)) {
    table.writeUInt32BE(at / SECTOR, Number(index) * 4);
    const block = Buffer.alloc(blockBytes);
    data.copy(block);
    parts.push(bitmap, block);
    at += bitmap.length + blockBytes;
  }
  parts.push(footer(diskBytes, 3, SECTOR));
  fs.writeFileSync(file, Buffer.concat(parts));
}

/** A master boot record whose first partition ends at head `heads - 1`, sector `sectors`. */
function mbr(heads, sectors) {
  const b = Buffer.alloc(SECTOR);
  b[0x1c2] = 0x0c;
  b[0x1c3] = heads - 1;
  b[0x1c4] = sectors;
  b[510] = 0x55;
  b[511] = 0xaa;
  return b;
}

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-vhd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/**
 * The files opened while a test runs and not yet closed. Counts what vhd.js opens through the
 * default fs/promises object (fsp.open), which is how it opens disks.
 */
function openFiles(t) {
  const open = new Set();
  const real = fsp.open;
  t.mock.method(fsp, 'open', async (...args) => {
    const handle = await real.apply(fsp, args);
    open.add(handle);
    const close = handle.close;
    handle.close = function () {
      open.delete(handle);
      return close.call(this);
    };
    return handle;
  });
  return open;
}

test('a dynamic VHD reads its written blocks and zeros elsewhere, and says which pieces are empty', async (t) => {
  const file = path.join(tmp(t), 'disk.vhd');
  const blockBytes = 2 * RANGE_BYTES;
  const first = Buffer.concat([mbr(128, 63), Buffer.from('boot code')]);
  const third = Buffer.alloc(blockBytes, 7);
  dynamicVhd(file, { diskBytes: 5 * blockBytes - 1000, blockBytes, blocks: { 0: first, 2: third } });

  const vhd = await openVhd(file);
  assert.equal(vhd.diskBytes, 5 * blockBytes - 1000);
  assert.deepEqual([vhd.heads, vhd.sectors], [128, 63], 'geometry from the partition table, not the footer');

  assert.deepEqual(await vhd.read(SECTOR, 9), Buffer.from('boot code'));
  // A read across a block boundary: the end of block 1 (never written), then block 2.
  const across = await vhd.read(2 * blockBytes - 4, 8);
  assert.deepEqual([...across], [0, 0, 0, 0, 7, 7, 7, 7]);
  // Past the end of the disk reads as zeros too.
  assert.deepEqual([...(await vhd.read(5 * blockBytes - 2, 4))], [0, 0, 0, 0]);

  const info = sockdriveInfo(vhd, 'disk.vhd');
  assert.equal(info.ahead_read, RANGE_BYTES);
  assert.equal(info.range_count, 10);
  assert.equal(info.size, Math.floor((5 * blockBytes - 1000) / 1024));
  assert.deepEqual(info.dropped_ranges, [2, 3, 6, 7, 8, 9], 'blocks 1, 3 and 4 were never written');
  assert.equal(info.cylinders, Math.floor((5 * blockBytes - 1000) / SECTOR / (128 * 63)));
  await vhd.close(); // before the test's folder is removed
});

test('a fixed VHD is the disk itself', async (t) => {
  const file = path.join(tmp(t), 'fixed.vhd');
  const data = Buffer.alloc(RANGE_BYTES * 2);
  data.write('hello', RANGE_BYTES + 3);
  fs.writeFileSync(file, Buffer.concat([data, footer(data.length, 2, 0xffffffff)]));
  const vhd = await openVhd(file);
  assert.deepEqual(await vhd.read(RANGE_BYTES + 3, 5), Buffer.from('hello'));
  assert.deepEqual(sockdriveInfo(vhd, 'fixed').dropped_ranges, []);
  await vhd.close();
});

test('openVhd refuses what it can\'t read, and closes the file', async (t) => {
  const open = openFiles(t);
  const dir = tmp(t);
  const notVhd = path.join(dir, 'x.vhd');
  fs.writeFileSync(notVhd, Buffer.alloc(4096));
  await assert.rejects(openVhd(notVhd), /isn't a VHD/);
  const child = path.join(dir, 'child.vhd');
  fs.writeFileSync(child, Buffer.concat([Buffer.alloc(2048), footer(1 << 20, 4, 0)]));
  await assert.rejects(openVhd(child), /differencing/);
  const damaged = path.join(dir, 'damaged.vhd');
  dynamicVhd(damaged, { diskBytes: 1 << 22, blockBytes: 1 << 21, blocks: { 0: Buffer.from('x') } });
  const bytes = fs.readFileSync(damaged);
  fs.writeFileSync(damaged, Buffer.concat([bytes.subarray(0, 3000), bytes.subarray(-SECTOR)])); // blocks cut off
  const vhd = await openVhd(damaged).catch((err) => err);
  assert.match(String(vhd.message ?? ''), /past the end/);
  assert.equal(open.size, 0, 'every file was closed');
});

test('geometry falls back to the footer, kept within what a BIOS can have', () => {
  const f = footer(1 << 30, 3, 512);
  assert.deepEqual(geometry(Buffer.alloc(SECTOR), f), { heads: 16, sectors: 63 });
  assert.deepEqual(geometry(mbr(255, 63), f), { heads: 255, sectors: 63 });
});

test('DiskPool keeps a disk open between requests, opens a changed file afresh, and lets go when idle', async (t) => {
  const file = path.join(tmp(t), 'disk.vhd');
  dynamicVhd(file, { diskBytes: 1 << 22, blockBytes: 1 << 21, blocks: { 1: Buffer.from('data') } });
  const open = openFiles(t);
  const pool = new DiskPool({ idleMs: 50 });
  t.after(() => pool.closeAll());
  let held = 0;
  const hold = () => { held++; return () => { held--; }; };
  const a = await pool.open(file, { stamp: 'one', hold });
  const b = await pool.open(file, { stamp: 'one', hold });
  assert.equal(a, b, 'the same open disk');
  assert.equal(held, 1);
  const c = await pool.open(file, { stamp: 'two', hold });
  assert.notEqual(c, a, 'another stamp is another copy of the file');
  assert.equal(held, 2);
  assert.deepEqual(a.info.dropped_ranges, [0, 1, 2, 3, 4, 5, 6, 7], 'block 0 (pieces 0-7) was never written');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(held, 0, 'both let go after a while without requests');
  assert.equal(open.size, 0, 'and closed');
});

test('DiskPool forgets a disk whose reads fail, and opens it again', async (t) => {
  const file = path.join(tmp(t), 'disk.vhd');
  dynamicVhd(file, { diskBytes: 1 << 22, blockBytes: 1 << 21, blocks: { 1: Buffer.from('data') } });
  const pool = new DiskPool({ idleMs: 60_000 });
  t.after(() => pool.closeAll());
  let held = 0;
  const hold = () => { held++; return () => { held--; }; };
  const a = await pool.open(file, { stamp: 'one', hold });
  await a.vhd.close(); // as a dropped network share leaves the handle
  await assert.rejects(a.vhd.read(1 << 21, 4));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(held, 0, 'let go of');
  const b = await pool.open(file, { stamp: 'one', hold });
  assert.notEqual(b, a, 'opened afresh');
  assert.equal(held, 1);
  assert.deepEqual(await b.vhd.read(1 << 21, 4), Buffer.from('data'));
  // A late failure on the old disk doesn't take the new one with it.
  await assert.rejects(a.vhd.read(1 << 21, 4));
  assert.equal(await pool.open(file, { stamp: 'one', hold }), b);
  pool.closeAll();
  await new Promise((resolve) => setImmediate(resolve));
});
