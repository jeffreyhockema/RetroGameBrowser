import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyVersion, completeOrder, lastTag, DEFAULT_VERSION_ORDER } from '../server/lib/versionkind.js';

const key = (label, gameDir = '', platform = null) => classifyVersion({ label, platform }, gameDir).key;

test('lastTag takes the final parenthesised group', () => {
  assert.equal(lastTag('Day Of The Tentacle (CD DOS)'), 'CD DOS');
  assert.equal(lastTag('Game (1990) (Floppy Amiga)'), 'Floppy Amiga');
  assert.equal(lastTag('No tag'), '');
});

test('classifyVersion reads media and platform from eXo folder names', () => {
  assert.equal(key('Day Of The Tentacle (CD DOS)'), 'CD DOS');
  assert.equal(key('Monkey Island 2 (Floppy DOS VGA)'), 'Floppy DOS');
  assert.equal(key('Monkey Island 2 (DOS Ultimate Talkie)'), 'DOS');
  assert.equal(key('Loom (CD FM-Towns)'), 'CD FM Towns');
  assert.equal(key('Zak (FM Towns)'), 'FM Towns');
  assert.equal(key('Game (Floppy PC98)'), 'Floppy PC-98');
  assert.equal(key('Myst (4CD Windows)'), 'CD Windows');
  assert.equal(key('Zork Nemesis (DVD DOS)'), 'DVD DOS');
  assert.equal(key('Game (Floppy Mac EGA)'), 'Floppy Macintosh');
  assert.equal(key('Game (Amiga CD32)'), 'Amiga');
  assert.equal(key('Game (CD PS1)'), 'PlayStation', 'consoles have no media');
  assert.equal(key('Game (2002 Remake)'), 'Remake');
  assert.equal(key('Open Quest (AGS)'), 'Fan-made');
});

test('classifyVersion uses --platform when a folder covers two platforms', () => {
  assert.equal(key('KQ6 (CD DOS, Windows), DOS', '', 'pc'), 'CD DOS');
  assert.equal(key('KQ6 (CD DOS, Windows), Windows', '', 'windows'), 'CD Windows');
});

test('classifyVersion falls back to the game folder, then to --platform', () => {
  assert.equal(key('Oo-Topos', 'Oo-Topos (DOS)'), 'DOS');
  assert.equal(key('Monkey Island (talkie)', 'Monkey Island (CD DOS)'), 'CD DOS');
  assert.equal(key('Amiga release (Amiga)', 'Some Game (CD DOS)'), 'Amiga', 'media stays with its own tag');
  assert.equal(key('Game', 'Game (Multi-Platform)', 'macintosh'), 'Macintosh');
  assert.equal(key('Game', 'Game (Multi-Platform)'), 'Other');
});

test('completeOrder keeps the saved order and adds the rest', () => {
  const order = completeOrder(['Amiga', 'CD DOS'], ['Weird Kind']);
  assert.deepEqual(order.slice(0, 2), ['Amiga', 'CD DOS']);
  assert.equal(order.length, DEFAULT_VERSION_ORDER.length + 1);
  assert.equal(order.at(-1), 'Weird Kind');
});
