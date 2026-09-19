import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeName, downloadName, standaloneBytes } from '../server/lib/standalone.js';

test('safeName keeps a name Windows will have', () => {
  assert.equal(safeName('Sam & Max Hit the Road'), 'Sam & Max Hit the Road');
  // The characters Windows won't have in a name, and a trailing dot it would drop silently.
  assert.equal(safeName('Where in the World? / Deluxe.'), 'Where in the World- - Deluxe');
  assert.equal(safeName('Café — ¡olé!'), 'Café — ¡olé!');
  // The name is also the address the page links to: "#" would start a fragment there and "%"
  // an escape, so neither survives, however happily Windows would have them.
  assert.equal(safeName('Hint Book #3'), 'Hint Book -3');
  assert.equal(safeName('Con'), 'Con_');
  assert.equal(safeName('nul.old'), 'nul_.old');
  assert.equal(safeName('Console Classics'), 'Console Classics');
  assert.equal(safeName('100% Walkthrough'), '100- Walkthrough');
  assert.equal(safeName(`line${String.fromCharCode(10)}break`), 'line break');
  // Long ones are cut at a word: the folder holds a page of the same name and folders below it,
  // and Windows still gives up on a path over 260 characters.
  assert.equal(
    safeName('Leisure Suit Larry 3: Passionate Patti in Pursuit of the Pulsating Pectorals'),
    'Leisure Suit Larry 3- Passionate Patti in',
  );
  assert.ok(safeName('x'.repeat(200)).length <= 48, 'a single long word is cut too');
  assert.equal(safeName('...'), 'Game', 'a name with nothing left falls back');
});

test('downloadName says the version once', () => {
  const loom = { title: 'Loom', sortTitle: 'Loom' };
  // Computer versions carry the game's title in their label; console ones are the region alone.
  assert.equal(downloadName(loom, { label: 'Loom (CD DOS VGA)' }), 'Loom (CD DOS VGA) (offline).zip');
  assert.equal(downloadName(loom, { label: 'Loom' }), 'Loom (offline).zip');
  assert.equal(
    downloadName({ title: 'Captain Novolin', sortTitle: 'Captain Novolin' }, { label: 'USA, 3 languages' }),
    'Captain Novolin (USA, 3 languages) (offline).zip',
  );
  // A long title gives way to its sort title, which is what keeps paths short enough.
  assert.equal(
    downloadName({ title: 'Leisure Suit Larry 3: Passionate Patti in Pursuit of the Pulsating Pectorals', sortTitle: 'Leisure Suit Larry 3' }, { label: '' }),
    'Leisure Suit Larry 3 (offline).zip',
  );
});

test('standaloneBytes counts the game, the engine, the page and base64', () => {
  const dos = { engine: 'dosbox' };
  const game = 100 * 1024 * 1024;
  const media = 7 * 1024 * 1024;
  const bytes = standaloneBytes(dos, { totalBytes: game }, media);
  // The game and the emulator are written as base64, a third bigger; the page's art is not.
  assert.ok(bytes > game * 1.33 + media, 'base64 and the engine are counted');
  assert.ok(bytes < game * 1.4 + media + 12 * 1024 * 1024, 'and not much more than that');
  assert.ok(standaloneBytes(dos, { totalBytes: game }, 0) < bytes, 'the page adds to it');
  // An engine with no browser build of its own adds nothing but is still counted in base64.
  assert.equal(standaloneBytes({ engine: 'nothing' }, { totalBytes: 3 }, 0), 4);
});
