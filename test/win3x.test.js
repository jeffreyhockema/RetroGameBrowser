import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWin3xCollection, skipInBundle, win3xIssue } from '../server/lib/win3x.js';
import { folderEntries, storedZipSize } from '../server/lib/romcache.js';

test('isWin3xCollection tells the Windows collection from the DOS one', () => {
  assert.equal(isWin3xCollection('eXo\\eXoWin3x'), true);
  assert.equal(isWin3xCollection('eXo/eXoWin3X/'), true);
  assert.equal(isWin3xCollection('eXo\\eXoDOS'), false);
  assert.equal(isWin3xCollection('eXo\\eXoWin3x extras'), false);
});

test('skipInBundle leaves out Windows swap files', () => {
  assert.equal(skipInBundle('WINDOWS/WIN386.SWP'), true);
  assert.equal(skipInBundle('win386.swp'), true);
  assert.equal(skipInBundle('WINDOWS/SYSTEM.INI'), false);
  assert.equal(skipInBundle('game/swap.dat'), false);
  assert.equal(skipInBundle('WINDOWS/WIN386.SWP.bak'), false);
});

test('win3xIssue flags installs that cannot work in the browser', () => {
  assert.equal(win3xIssue({ totalBytes: 30 * 1024 ** 2, fileCount: 400, emptyCount: 1, maxBytes: 800 * 1024 ** 2 }), null);
  assert.match(win3xIssue({ totalBytes: 2 * 1024 ** 3, fileCount: 400, maxBytes: 800 * 1024 ** 2 }), /Too big/);
  // eXo's unfinished installs have the files but no content in them.
  assert.match(win3xIssue({ totalBytes: 0, fileCount: 300, emptyCount: 300 }), /didn't finish/);
  assert.match(win3xIssue({ totalBytes: 40 * 1024 ** 2, fileCount: 300, emptyCount: 280 }), /didn't finish/);
  assert.match(win3xIssue({ fileCount: 0 }), /isn't installed/);
});

test('folderEntries adds a folder for every level, so none is missing during unpacking', () => {
  const files = [{ name: 'Game/x.exe' }, { name: 'Game/drivers/s3/a.dl_' }];
  const dirs = folderEntries(files).map((f) => f.name).sort();
  assert.deepEqual(dirs, ['Game/', 'Game/drivers/', 'Game/drivers/s3/']);
  // Sorted with the files, every folder comes before what's inside it.
  const sorted = [...files, ...folderEntries(files)].map((f) => f.name).sort((a, b) => a.localeCompare(b));
  for (const dir of dirs) {
    for (const [i, name] of sorted.entries()) {
      if (name.startsWith(dir) && name !== dir) assert.ok(sorted.indexOf(dir) < i, `${dir} before ${name}`);
    }
  }
  // Folder entries are empty, so they only cost their names in the zip.
  assert.equal(storedZipSize(folderEntries(files)) - storedZipSize([]), dirs.reduce((n, d) => n + 76 + 2 * d.length, 0));
});
