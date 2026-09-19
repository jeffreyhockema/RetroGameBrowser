import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { win9xLayout, parseWin9xAutoexec, win9xConf, win9xIssue, inBundle, fitDisplaySettings, readSystemDisk, nameTracksAsCues } from '../server/lib/win9x.js';
import { parseDosboxConf, pathFixerFor } from '../server/lib/dosbox.js';
import { dosLayout } from '../server/lib/webplay.js';

// As eXo writes them (Battle Isle's two CDs, with a " - " in the name that isn't an option).
const CD_GAME = [
  'vhdmake -f -l .\\emulators\\dosbox\\x98\\parent/W98-C.vhd .\\emulators\\dosbox\\x98\\W98-C.vhd        ',
  'IMGMOUNT c .\\emulators\\dosbox\\x98\\W98-C.vhd    ',
  'IMGMOUNT d ".\\eXoWin9x\\1995\\Battle Isle 2220 - Shadow of the Emperor (1995)\\Battle Isle 2220 - Shadow of the Emperor (1995).vhd"    ',
  'IMGMOUNT e ".\\eXoWin9x\\1995\\Battle Isle 2220 - Shadow of the Emperor (1995)\\cd1.cue" ".\\eXoWin9x\\1995\\Battle Isle 2220 - Shadow of the Emperor (1995)\\cd2.cue" -t cdrom -ide 2m     ',
  'echo off',
  'cls',
  'BOOT -l c',
].map((l) => l.trim());

const ZIP_GAME = [
  'vhdmake -f -l .\\emulators\\dosbox\\x98\\parent/win98jap.vhd .\\emulators\\dosbox\\x98\\W98-C.vhd',
  'IMGMOUNT c .\\emulators\\dosbox\\x98\\W98-C.vhd',
  'IMGMOUNT d ".\\eXoWin9x\\1994\\Hyperoid (1994)\\Hyperoid (1994).vhd"',
  'MOUNT e ".\\eXoWin9x\\1994\\Hyperoid (1994)\\Hyperoid (1994).zip"',
  'xcopy d:\\windows\\*.ini c:\\windows\\ /y',
  'BOOT -l c',
];

test('win9xLayout reads the year folder of an eXoWin9x launcher, and dosLayout passes it on', () => {
  const rel = 'eXo\\eXoWin9x\\!win9x\\1995\\Apache (1995)\\Apache (1995).bat';
  assert.deepEqual(win9xLayout(rel), {
    collection: 'eXo\\eXoWin9x',
    exoRoot: 'eXo',
    launcherDir: path.join('eXo\\eXoWin9x', '!win9x', '1995', 'Apache (1995)'),
    year: '1995',
    gameDir: 'Apache (1995)',
    zipRel: path.join('eXo\\eXoWin9x', '1995', 'Apache (1995).zip'),
  });
  assert.equal(dosLayout({ applicationRel: rel }).win9x, true);
  assert.equal(win9xLayout('eXo\\eXoDOS\\!dos\\funball\\Funball (1995).bat'), null);
  assert.equal(win9xLayout('eXo\\eXoWin3x\\!win3x\\JezzBall\\JezzBall (1990).bat'), null);
  assert.equal(dosLayout({ applicationRel: 'eXo\\eXoDOS\\!dos\\funball\\Funball (1995).bat' }).win9x, undefined);
});

test('parseWin9xAutoexec finds the Windows disk, the game disk and the other drives', () => {
  const cd = parseWin9xAutoexec(CD_GAME);
  assert.equal(cd.systemDisk, path.normalize('emulators/dosbox/x98/parent/W98-C.vhd'), 'the parent of the differencing disk');
  assert.equal(cd.gameDisk, 'Battle Isle 2220 - Shadow of the Emperor (1995)/Battle Isle 2220 - Shadow of the Emperor (1995).vhd');
  assert.deepEqual(cd.drives, [{
    letter: 'e',
    command: 'imgmount',
    files: ['Battle Isle 2220 - Shadow of the Emperor (1995)/cd1.cue', 'Battle Isle 2220 - Shadow of the Emperor (1995)/cd2.cue'],
    options: '-t cdrom -ide 2m',
  }]);
  assert.equal(cd.media, 'CD');

  const zip = parseWin9xAutoexec(ZIP_GAME);
  assert.equal(zip.systemDisk, path.normalize('emulators/dosbox/x98/parent/win98jap.vhd'));
  assert.deepEqual(zip.drives, [{ letter: 'e', command: 'mount', files: ['Hyperoid (1994)/Hyperoid (1994).zip'], options: '' }]);
  assert.equal(zip.media, 'Hard disk');
});

test('parseWin9xAutoexec returns null for a launcher that doesn\'t boot Windows from its disks', () => {
  assert.equal(parseWin9xAutoexec(CD_GAME.filter((l) => !/^boot/i.test(l))), null, 'no boot');
  assert.equal(parseWin9xAutoexec(CD_GAME.filter((l) => !/^imgmount d/i.test(l))), null, 'no game disk');
  assert.equal(parseWin9xAutoexec([...CD_GAME.slice(0, 3), 'mount e "C:\\Games\\elsewhere"', 'boot -l c']), null, 'a drive outside the game');
});

test('win9xConf keeps the PC eXo set up, boots the disks as sockdrives, and stands in for what the browser build lacks', () => {
  const sections = parseDosboxConf([
    '[sdl]', 'output = opengl', 'autolock = true',
    '[dosbox]', 'machine = svga_s3', 'memsize = 64', 'captures = capture',
    '[cpu]', 'core = auto', 'cputype = pentium_mmx',
    '[midi]', 'mididevice = default', 'midiconfig = ',
    '[serial]', 'serial1 = dummy', 'serial2 = dummy', 'phonebookfile = phonebook-dosbox-x.txt',
    '[parallel]', 'parallel1 = printer',
    '[ne2000]', 'ne2000 = true', 'backend = pcap',
    '[ethernet, pcap]', 'realnic = list',
    '[ide, primary]', 'enable = true', 'pnp = true',
    '[ide, secondary]', 'pnp = true',
    '[autoexec]', ...CD_GAME,
  ].join('\r\n'));
  const fixPath = pathFixerFor(['Battle Isle 2220 - Shadow of the Emperor (1995)/CD1.CUE', 'Battle Isle 2220 - Shadow of the Emperor (1995)/cd2.cue']);
  const conf = win9xConf(sections, {
    mounts: parseWin9xAutoexec(CD_GAME), systemUrl: '{origin}/data/disk/system/abc', gameUrl: '{origin}/data/disk/game/g-0/def', fixPath,
  });
  const lines = conf.split('\n');
  const section = (name) => lines.slice(lines.indexOf(`[${name}]`) + 1, lines.findIndex((l, i) => i > lines.indexOf(`[${name}]`) && l === ''));
  assert.ok(!conf.includes('[sdl]') && !conf.includes('pcap') && !conf.includes('captures') && !conf.includes('phonebook'));
  assert.deepEqual(section('dosbox'), ['machine=svga_s3', 'memsize=64']);
  assert.deepEqual(section('cpu'), ['core=auto', 'cputype=jsdos_pentium_mmx']);
  assert.deepEqual(section('serial'), ['serial1=dummy', 'serial2=dummy'], 'the ports Windows knows stay');
  assert.deepEqual(section('parallel'), ['parallel1=disney'], 'the printer port, as a device the browser build has');
  assert.deepEqual(section('ne2000'), ['ne2000=true', 'backend=nothing'], 'the card Windows expects, connected to nothing');
  assert.deepEqual(section('ide, primary'), ['enable=true', 'pnp=true']);
  assert.deepEqual(section('ide, secondary'), ['pnp=true']);
  assert.deepEqual(section('midi'), ['mididevice=none']);
  assert.deepEqual(lines.slice(lines.indexOf('[autoexec]') + 1).filter(Boolean), [
    'echo off',
    'imgmount 2 sockdrive {origin}/data/disk/system/abc',
    'imgmount 3 sockdrive {origin}/data/disk/game/g-0/def',
    'imgmount e "./Battle Isle 2220 - Shadow of the Emperor (1995)/CD1.CUE" "./Battle Isle 2220 - Shadow of the Emperor (1995)/cd2.cue" -t cdrom -ide 2m',
    'boot c:',
  ]);

  const withMusic = win9xConf(sections, { mounts: parseWin9xAutoexec(CD_GAME), systemUrl: 's', gameUrl: 'g', sound: 'fluidsynth', soundfont: 'SoundCanvas.sf2' });
  assert.match(withMusic, /\[midi\]\nmididevice=fluidsynth\nfluid\.soundfont=\.\/mt32\/SoundCanvas\.sf2\n/);
});

test('win9xConf leaves out the copying a launcher does between drive letters before booting', () => {
  const conf = win9xConf(parseDosboxConf(['[dosbox]', 'memsize = 64', '[autoexec]', ...ZIP_GAME].join('\n')), {
    mounts: parseWin9xAutoexec(ZIP_GAME), systemUrl: 's', gameUrl: 'g',
  });
  assert.ok(!/xcopy/i.test(conf));
  assert.match(conf, /mount e "\.\/Hyperoid \(1994\)\/Hyperoid \(1994\)\.zip"\nboot c:/);
});

test('inBundle and win9xIssue', () => {
  assert.equal(inBundle('Game (1995)/Game (1995).vhd'), false);
  assert.equal(inBundle('Game (1995)/cd1.bin'), true);
  const mounts = parseWin9xAutoexec(CD_GAME);
  assert.equal(win9xIssue({ mounts, bundleBytes: 700e6, maxBytes: 1200e6 }), null);
  assert.match(win9xIssue({ confFound: false }), /86Box/);
  assert.match(win9xIssue({ mounts: null }), /doesn't start Windows/);
  assert.match(win9xIssue({ mounts, zipFound: false }), /zip wasn't found/);
  assert.match(win9xIssue({ mounts, systemFound: false }), /W98-C\.vhd/);
  assert.match(win9xIssue({ mounts, bundleBytes: 1.4e9, maxBytes: 1200e6 }), /Too big.*1\.3 GB/);
});

/** A registry string value as Windows 9x stores it. */
const regString = (name, data) => Buffer.concat([
  Buffer.from([1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, name.length, 0, data.length, 0]),
  Buffer.from(name + data, 'latin1'),
]);

test('fitDisplaySettings sets screen resolutions past what the browser shows to 800x600, in the same room', () => {
  const settings = Buffer.concat([
    regString('BitsPerPixel', '16'), regString('Resolution', '1024,768'),
    regString('Resolution', '800,600'), regString('Resolution', '1280,1024'), regString('Resolution', '640,480'),
    // Not a registry value: a game's text that happens to say it.
    Buffer.from('Resolution1024,768'),
  ]);
  const before = settings.length;
  assert.equal(fitDisplaySettings(settings), 2);
  assert.equal(settings.length, before);
  const text = settings.toString('latin1');
  assert.ok(text.includes('Resolution0800,600') && text.includes('Resolution0800,0600'));
  assert.ok(text.includes('Resolution800,600') && text.includes('Resolution640,480'));
  assert.ok(text.endsWith('Resolution1024,768'), 'only registry values change');
});

test('readSystemDisk finds a resolution that crosses from one piece into the next', async () => {
  const disk = Buffer.alloc(4096);
  const value = regString('Resolution', '1024,768');
  value.copy(disk, 2048 - 10); // the piece boundary falls inside "Resolution"
  const vhd = { read: async (offset, length) => { const out = Buffer.alloc(length); disk.copy(out, 0, offset, offset + length); return out; } };
  const pieces = Buffer.concat([await readSystemDisk(vhd, 0, 2048), await readSystemDisk(vhd, 2048, 2048)]);
  assert.equal(pieces.length, 4096);
  assert.ok(pieces.toString('latin1').includes('Resolution0800,600'));
});

test('nameTracksAsCues names each CD track the way its cue sheet spells it', () => {
  const files = [
    { name: 'Ultimate DOOM, The (1996)/udoom.cue', size: 71 },
    { name: 'Ultimate DOOM, The (1996)/udoom.bin', size: 60930912 },
    { name: 'Game (1995)/cd1.cue', size: 90 },
    { name: 'Game (1995)/Track 01.bin', size: 10 },
    { name: 'Game (1995)/Track 02.wav', size: 10 },
  ];
  const cues = new Map([
    ['Ultimate DOOM, The (1996)/udoom.cue', 'FILE "UDOOM.BIN" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n'],
    ['Game (1995)/cd1.cue', 'FILE "Track 01.bin" BINARY\n  TRACK 01 MODE1/2352\nFILE "TRACK 02.WAV" WAVE\n  TRACK 02 AUDIO\nFILE "missing.bin" BINARY\n'],
  ]);
  assert.deepEqual(nameTracksAsCues(files, cues).map((f) => f.as ?? f.name), [
    'Ultimate DOOM, The (1996)/udoom.cue',
    'Ultimate DOOM, The (1996)/UDOOM.BIN',
    'Game (1995)/cd1.cue',
    'Game (1995)/Track 01.bin',
    'Game (1995)/TRACK 02.WAV',
  ]);
  assert.equal(nameTracksAsCues(files, cues)[1].name, 'Ultimate DOOM, The (1996)/udoom.bin', 'the file read is the same');
});
