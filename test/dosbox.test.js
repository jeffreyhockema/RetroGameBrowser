import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  parseDosboxConf, confValue, mediaOf, midiDeviceOf, splitArgs, rewriteAutoexec, browserConf,
  wantsAspect, wantsMouseLock, confLabel, pathFixerFor, foldersNeededBefore, launcherIssue, zipNameFor, readZipText,
} from '../server/lib/dosbox.js';

// Trimmed from eXoDOS's MegaRace launcher (DOSBox ECE).
const MEGARACE_CONF = [
  '# Config file for Dosbox-ECE r4230',
  '[sdl]', 'fullscreen=false', 'output=openglnb', 'mapperfile=mapper.map',
  '[dosbox]', 'machine=svga_s3', 'memsize=64',
  '[render]', 'aspect=true', 'scaler=normal2x',
  '[cpu]', 'core=auto', 'cycles=5000',
  '[midi]', 'mididevice=mt32', 'mt32.romdir=.\\mt32', 'fluid.soundfont=.\\mt32\\SoundCanvas.sf2', 'fluid.gain            = .2',
  '[sblaster]', 'oplemu=nuked',
  '[pci]', 'voodoo=false',
  '[autoexec]',
  'cd ..',
  '@cd ..',
  'mount c .\\eXoDOS\\megarace',
  'imgmount d ".\\eXoDOS\\MegaRace\\CD\\megarace.iso" -t cdrom',
  'c:',
  'cd megarace',
  '@call megarace',
  'exit',
].join('\r\n');

test('parseDosboxConf keeps sections, values with spaces around "=", and raw autoexec lines', () => {
  const s = parseDosboxConf(MEGARACE_CONF);
  assert.equal(confValue(s, 'dosbox', 'machine'), 'svga_s3');
  assert.equal(confValue(s, 'midi', 'fluid.gain'), '.2');
  assert.equal(confValue(s, 'nope', 'x'), null);
  assert.deepEqual(s.get('autoexec').slice(0, 3), ['cd ..', '@cd ..', 'mount c .\\eXoDOS\\megarace']);
  assert.equal(wantsAspect(s), true);
});

test('wantsMouseLock follows the conf\'s autolock, spaces and case included', () => {
  assert.equal(wantsMouseLock(parseDosboxConf('[sdl]\r\nautolock            = true\r\n')), true);
  assert.equal(wantsMouseLock(parseDosboxConf('[sdl]\nautolock=TRUE \n')), true);
  assert.equal(wantsMouseLock(parseDosboxConf('[sdl]\nautolock=false\n')), false);
  assert.equal(wantsMouseLock(parseDosboxConf('[sdl]\nfullscreen=false\n')), false);
});

test('mediaOf tells CD games from floppy ones', () => {
  assert.equal(mediaOf(['mount c .\\eXoDOS\\x', 'imgmount d .\\eXoDOS\\x\\cd\\game.cue -t cdrom']), 'CD');
  assert.equal(mediaOf(['imgmount d "./x/cd/GAME.ISO" -t iso']), 'CD');
  assert.equal(mediaOf(['imgmount a .\\eXoDOS\\x\\floppy\\1.ima -t floppy', 'boot -l a']), 'Floppy');
  assert.equal(mediaOf(['mount c .\\eXoDOS\\x', 'c:', 'game']), 'Floppy');
});

test('midiDeviceOf reads the device eXo set up, or infers one from ROM/soundfont keys', () => {
  assert.equal(midiDeviceOf(parseDosboxConf('[midi]\nmididevice=mt32\n')), 'mt32');
  assert.equal(midiDeviceOf(parseDosboxConf('[midi]\nmt32.romdir=.\\mt32\n')), 'default');
  assert.equal(midiDeviceOf(parseDosboxConf('[midi]\nmididevice=none\nmt32.romdir=.\\mt32\n')), null);
  assert.equal(midiDeviceOf(parseDosboxConf('[midi]\n[sblaster]\n')), null);
});

test('splitArgs keeps quoted paths together', () => {
  assert.deepEqual(splitArgs('d ".\\eXoDOS\\A B\\cd\\x.cue" -t cdrom'),
    [{ value: 'd', quoted: false }, { value: '.\\eXoDOS\\A B\\cd\\x.cue', quoted: true }, { value: '-t', quoted: false }, { value: 'cdrom', quoted: false }]);
});

test('rewriteAutoexec maps collection paths to the bundle root and fixes their case', () => {
  const fix = pathFixerFor(['MegaRace/MEGARACE/MEGARACE.BAT', 'MegaRace/cd/megarace.iso']);
  const lines = rewriteAutoexec(parseDosboxConf(MEGARACE_CONF).get('autoexec'), fix);
  assert.deepEqual(lines, [
    'mount c ./MegaRace',
    'imgmount d "./MegaRace/cd/megarace.iso" -t cdrom',
    'c:',
    'cd megarace',
    '@call megarace',
    'exit',
  ]);
  // Collection-root mounts become the bundle root; drive-relative image paths are left alone.
  assert.deepEqual(rewriteAutoexec(['@mount c .\\eXoDOS\\', 'c:', 'imgmount d ".\\discs\\1.cue" -t iso'], fix),
    ['@mount c .', 'c:', 'imgmount d "./discs/1.cue" -t iso']);
  // Floppy booters keep their DOS-side image names.
  assert.deepEqual(rewriteAutoexec(['mount c .\\eXoDOS\\Friendly', 'c:', '@boot PCA.img -l a'], fix),
    ['mount c ./Friendly', 'c:', '@boot PCA.img -l a']);
});

test('browserConf drops the host window section and host file keys, and sets the MIDI device', () => {
  const s = parseDosboxConf(MEGARACE_CONF);
  const plain = browserConf(s);
  assert.doesNotMatch(plain, /\[sdl\]|mapperfile|\[pci\]|voodoo|fluid\.|mt32\.romdir/);
  assert.match(plain, /\[dosbox\]\nmachine=svga_s3\nmemsize=64\n/);
  assert.match(plain, /\[midi\]\nmididevice=none\n/);
  assert.match(plain, /\[autoexec\]\nmount c \.\/megarace\n/);
  assert.match(plain, /oplemu=nuked/);

  const mt32 = browserConf(s, { sound: 'mt32' });
  assert.match(mt32, /mididevice=mt32\nmt32\.romdir=\.\/mt32\n/);
  const sc = browserConf(s, { sound: 'fluidsynth', soundfont: 'SoundCanvas.sf2' });
  assert.match(sc, /mididevice=fluidsynth\nfluid\.soundfont=\.\/mt32\/SoundCanvas\.sf2\n/);
});

test('confLabel names a launcher variant after its conf file', () => {
  assert.equal(confLabel('dosbox.conf', 'Zork'), 'Zork');
  assert.equal(confLabel('tandy.conf', 'Zork'), 'Zork (Tandy)');
  assert.equal(confLabel('dosbox_cga.conf', 'Zork'), 'Zork (CGA)');
  assert.equal(confLabel('dosbox2.conf', 'Zork'), 'Zork (alternative 2)');
  assert.equal(confLabel('dosbox_no_sound.conf', 'Zork'), 'Zork (No Sound)');
});

test('pathFixerFor only touches paths under the bundle root', () => {
  const fix = pathFixerFor(['11thHour/discs/1.cue', '11thHour/RUN.BAT']);
  assert.equal(fix('./11thhour'), './11thHour');
  assert.equal(fix('./11thhour/DISCS/1.CUE'), './11thHour/discs/1.cue');
  assert.equal(fix('./unknown/x'), './unknown/x');
  assert.equal(fix('.'), '.');
  assert.equal(fix('C:\\x'), 'C:\\x');
});

test('foldersNeededBefore lists parents of folder entries that come before their files', () => {
  assert.deepEqual(foldersNeededBefore(['Abuse/Abuse (1995).exo', 'Abuse/ABUSE/ADDON/', 'Abuse/ABUSE/ABUSE.EXE', 'Abuse/ABUSE/ADDON/DEATHMAT/X.LSP']),
    ['Abuse/ABUSE']);
  assert.deepEqual(foldersNeededBefore(['A/B/C/D/', 'A/B/', 'A/x.txt']), ['A/B/C']);
  assert.deepEqual(foldersNeededBefore(['game/x.exe', 'game/save/']), [], 'a file already created the parent');
  assert.deepEqual(foldersNeededBefore(['top/']), [], 'top-level folders need no parent');
});

test('launcherIssue flags games that cannot work in the browser', () => {
  assert.equal(launcherIssue({ zipSize: 100, maxZipBytes: 1000 }), null);
  assert.match(launcherIssue({ zipSize: 3 * 1024 ** 3, maxZipBytes: 1024 ** 3 }), /Too big/);
  assert.match(launcherIssue({ exceptionBat: 'start .\\eXoDOS\\x\\sciAudio\\sciAudio.exe' }), /sciAudio/);
});

test('zipNameFor pairs a launcher with its zip', () => {
  assert.equal(zipNameFor('eXo\\eXoDOS\\!dos\\funball\\Funball (1995).bat'), 'Funball (1995).zip');
});

// A zip of [name, method, data, uncompressedSize] entries, written by hand so an entry's data can be broken.
function writeZip(file, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, method, data, size] of entries) {
    const nameBuf = Buffer.from(name);
    const crc = method === 0 ? zlib.crc32(data) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, end]));
}

test('readZipText finds a file regardless of case, and rejects when the file can\'t be read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-dosbox-'));
  try {
    const good = path.join(dir, 'good.zip');
    const text = Buffer.from('@echo off\r\nipxnet startserver\r\n');
    writeZip(good, [['readme.txt', 0, Buffer.from('hi'), 2], ['GAME/NETWORK.BAT', 0, text, text.length]]);
    const isBat = (name) => /(^|\/)network\.bat$/i.test(name);
    assert.equal(await readZipText(good, isBat), text.toString('latin1'));
    assert.equal(await readZipText(good, (name) => name === 'missing.txt'), null);

    // Not deflate data at all: reading it fails, which isn't the same as the zip having no such file.
    const broken = path.join(dir, 'broken.zip');
    writeZip(broken, [['network.bat', 8, Buffer.from([0xff, 0xff, 0xff, 0xff]), 40]]);
    await assert.rejects(readZipText(broken, isBat));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
