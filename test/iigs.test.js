import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exoIIgsLauncher, parseGsplusConfig, parseExceptionBat, parseExceptionMenu, parseExceptionNotes, iigsPlan, iigsSpareDisks, iigsArgs, iigsRomSets, iigsBram, isDiskCopy,
} from '../server/lib/iigs.js';

const config = (lines, rom = 'ROM1') => [
  '# GSplus configuration file version 0.14', '',
  ...lines, '',
  `g_cfg_rom_path = ..\\..\\..\\GSPlus\\${rom}`, '',
  'bram1[00] = 00 00 00 01 00 00 0d 06 02 01 01 00 01 00 00 00',
].join('\r\n');

test('exoIIgsLauncher finds the game folder and name in an eXo launcher path', () => {
  assert.deepEqual(exoIIgsLauncher('eXo\\eXoAppleIIGS\\!appleiigs\\Arkanoid (1988)\\Arkanoid (1988).bat'),
    { gameDir: 'Arkanoid (1988)', gameName: 'Arkanoid (1988)' });
  assert.equal(exoIIgsLauncher('eXo\\eXoDOS\\!dos\\Doom (1993)\\Doom (1993).bat'), null);
  assert.equal(exoIIgsLauncher(undefined), null);
});

test('a GSplus config gives the ROM and the disk in each drive, leaving empty drives out', () => {
  const parsed = parseGsplusConfig(config(['s5d1 = ', 's5d2 = ', '', 's6d1 = ', 's6d2 = ', '', 's7d1 = game.po']));
  assert.equal(parsed.rom, 'ROM1');
  assert.deepEqual(parsed.drives, [{ slot: 7, drive: 1, file: 'game.po' }]);
  assert.equal(parseGsplusConfig(config([], 'ROM3')).rom, 'ROM3');
});

test('the battery RAM comes whole from the config, for the ROM the game starts, or not at all', () => {
  const lines = (which, fill) => Array.from({ length: 16 }, (_, row) => `bram${which}[${(row * 16).toString(16).padStart(2, '0')}] = ${Array(16).fill(fill).join(' ')}`);
  const setup = { gsplus: parseGsplusConfig(config([...lines(1, '06'), ...lines(3, '00')])) };
  const plan = iigsPlan(setup);
  const bram = Buffer.from(iigsBram(setup, plan), 'base64');
  assert.equal(bram.length, 256);
  // (The config helper's own "bram1[00]" line comes last, so the first sixteen are its.)
  assert.deepEqual([...bram.subarray(0, 4)], [0, 0, 0, 1]);
  assert.ok(bram.subarray(16).every((b) => b === 6));
  // All zeros is GSplus's blank for the ROM the game doesn't use; a partial one isn't trusted.
  assert.equal(setup.gsplus.bram.ROM3, null);
  assert.equal(parseGsplusConfig(config(['bram1[00] = 01 02'])).bram.ROM1, null);
});

test('a DiskCopy image is known by its header, not its size', () => {
  const header = Buffer.alloc(0x54);
  header[0x52] = 0x01;
  assert.equal(isDiskCopy(header), true);
  // Ancient Land of Ys's "Save.2mg": a raw ProDOS disk (its boot block starts 01 38) with bytes after.
  assert.equal(isDiskCopy(Buffer.from([0x01, 0x38, 0xb0, 0x03, ...Array(0x50).fill(0)])), false);
  assert.equal(isDiskCopy(null), false);
});

test('eXo\'s exception.bat for a MAME game gives its disks, in order', () => {
  assert.deepEqual(parseExceptionBat('echo off\r\nSET DISK1=Game.hdv\r\nSET DISK2=\r\nSET DISKS=1\r\n'), ['Game.hdv']);
  assert.deepEqual(parseExceptionBat('SET DISK1=A.hdv\nSET DISK2=B.hdv\nSET DISK3=C.2mg\n'), ['A.hdv', 'B.hdv', 'C.2mg']);
});

test('a game on one slot 7 disk starts from a CFFA2 card, on the ROM1 machine', () => {
  const plan = iigsPlan({ gsplus: parseGsplusConfig(config(['s7d1 = game.po'])) });
  assert.deepEqual(plan, { machine: 'apple2gsr1', card: true, media: [{ file: 'game.po', as: 'hard1', type: '.hdv' }], dropped: [] });
  assert.deepEqual(iigsArgs(plan, (f, t) => `/media/1${t}`), ['-ramsize', '8M', '-sl7', 'cffa2', '-hard1', '/media/1.hdv']);
  assert.deepEqual(iigsRomSets(plan), ['apple2gs.zip', 'apple2gsr1.zip', 'a2cffa2.zip']);
});

test('3.5-inch disks go in MAME\'s 3.5-inch drives, slot 7\'s in the card', () => {
  // The Adventures of Sinbad: its second disk in a 3.5" drive, the game and its first disk in slot 7.
  const plan = iigsPlan({ gsplus: parseGsplusConfig(config(['s5d1 = Disk2.2mg', 's7d1 = game.po', 's7d2 = Disk1.2mg'])) });
  assert.deepEqual(plan.media, [
    { file: 'Disk2.2mg', as: 'flop3', type: '.2mg' },
    { file: 'game.po', as: 'hard1', type: '.hdv' },
    { file: 'Disk1.2mg', as: 'hard2', type: '.2mg' },
  ]);
});

test('a game on 3.5-inch disks alone needs no card, and starts from the first of them', () => {
  const plan = iigsPlan({ gsplus: parseGsplusConfig(config(['s5d1 = 1.2mg', 's5d2 = 2.2mg'])) });
  assert.equal(plan.card, false);
  assert.deepEqual(plan.media.map((m) => m.as), ['flop3', 'flop4']);
  assert.deepEqual(iigsRomSets(plan), ['apple2gs.zip', 'apple2gsr1.zip']);
});

test('slot 7\'s disks past the card\'s two go in free 3.5-inch drives; a missing disk takes no drive', () => {
  // Animal Tracker: a 3.5" disk that isn't in the zip, and four disks in slot 7.
  const files = new Set(['orange.po', 'red.po', 'blue.po', 'green.po']);
  const plan = iigsPlan({
    gsplus: parseGsplusConfig(config(['s5d1 = #Animal Tracker Dk1 (Orange).2mg', 's7d1 = orange.po', 's7d2 = red.po', 's7d3 = blue.po', 's7d4 = green.po'])),
  }, (f) => files.has(f));
  assert.deepEqual(plan.media.map((m) => `${m.file}:${m.as}`), ['orange.po:hard1', 'red.po:hard2', 'blue.po:flop3', 'green.po:flop4']);
  assert.deepEqual(plan.dropped, ['#Animal Tracker Dk1 (Orange).2mg']);
});

test('a hard disk image never goes in a floppy drive: past the card\'s two, it\'s left out', () => {
  // Mean 18: a boot floppy, and three 5 MB disks in slot 7.
  const sizes = { 'Boot.2mg': 819264, 'game.po': 5242880, 'Famous1_2.po': 5242880, 'Famous3_4.po': 5242880 };
  const plan = iigsPlan({
    gsplus: parseGsplusConfig(config(['s5d1 = Boot.2mg', 's7d1 = game.po', 's7d2 = Famous1_2.po', 's7d3 = Famous3_4.po'])),
  }, (f) => (f in sizes ? { size: sizes[f] } : null));
  assert.deepEqual(plan.media.map((m) => `${m.file}:${m.as}`), ['Boot.2mg:flop3', 'game.po:hard1', 'Famous1_2.po:hard2']);
  assert.deepEqual(plan.dropped, ['Famous3_4.po']);
});

test('each disk is named for MAME by what it is and the drive it\'s in', () => {
  // Ancient Land of Ys: its "Save.2mg" is a DiskCopy 4.2 image with tags, by its size.
  const sizes = { 'Save.2mg': 838484, 'Disk1.po': 819200, 'Disk2.po': 819200 };
  const plan = iigsPlan({
    gsplus: parseGsplusConfig(config(['s5d1 = Save.2mg', 's7d1 = Disk1.po', 's7d2 = Disk2.po'])),
  }, (f) => (f in sizes ? { size: sizes[f] } : null));
  assert.deepEqual(plan.media.map((m) => `${m.as}${m.type}`), ['flop3.dc42', 'hard1.hdv', 'hard2.hdv']);
  // A raw 800K disk in a 3.5" drive is MAME's raw sector image.
  const raw = iigsPlan({ gsplus: parseGsplusConfig(config(['s5d1 = Disk2.po'])) }, () => ({ size: 819200 }));
  assert.equal(raw.media[0].type, '.img');
});

test('a disk in another game\'s folder is left out', () => {
  const plan = iigsPlan({ gsplus: parseGsplusConfig(config(['s5d1 = Characters.2mg', "s5d2 = ../Bard's Tale - Tales of the Unknown, The (1987)/Characters.2mg", 's7d1 = game.2mg'])) });
  assert.deepEqual(plan.media.map((m) => m.as), ['flop3', 'hard1']);
  assert.equal(plan.dropped.length, 1);
});

test('a game eXo runs with MAME starts as eXo starts it', () => {
  const plan = iigsPlan({ mameDisks: ['Game.hdv'] });
  assert.deepEqual(plan, { machine: 'apple2gs', card: true, media: [{ file: 'Game.hdv', as: 'hard1', type: '.hdv' }], dropped: [] });
  assert.deepEqual(iigsRomSets(plan), ['apple2gs.zip', 'a2cffa2.zip']);
});

test('the zip\'s other floppies are there to swap in, under their own names', () => {
  // As in Gate: Disk 2 is asked for later, in the drive Save.2mg starts in.
  const plan = iigsPlan({ gsplus: parseGsplusConfig(config(['s5d1 = Disk1.2mg', 's5d2 = Save.2mg'])) });
  const entries = [
    { name: 'Gate (1992)/Disk1.2mg', size: 819264 }, { name: 'Gate (1992)/Disk2.2mg', size: 819264 },
    { name: 'Gate (1992)/Save.2mg', size: 819264 }, { name: 'Gate (1992)/Game.po', size: 5242880 },
    { name: 'Gate (1992)/readme.txt', size: 900 }, { name: 'Gate (1992)/3.dsk', size: 143360 },
    { name: 'Gate (1992)/Disk2.po', size: 819200 },
  ];
  assert.deepEqual(iigsSpareDisks(plan, entries), [
    { file: 'Disk2.2mg', type: '.2mg', name: 'Disk2.2mg' },
    { file: '3.dsk', type: '.dsk', name: 'Disk 3.dsk' },
    { file: 'Disk2.po', type: '.img', name: 'Disk2.img' },
  ]);
});

test('a menu in exception.bat gives one choice per key, each with the config its section sets', () => {
  // As in Geometry: the sections are in a different order from the keys.
  const bat = [
    'echo off', 'echo Press 1 to play Geometry Part 1', 'echo Press 2 to play Geometry Part 2',
    '..\\..\\..\\util\\choice /C:12 /N Please Choose:', '',
    'if errorlevel = 2 goto part2', 'if errorlevel = 1 goto part1', '',
    ':part2', 'SET CONFIGTXT=config1.txt', 'goto end', '',
    ':part1', 'SET CONFIGTXT=config2.txt', 'goto end', '', ':end',
  ].join('\r\n');
  assert.deepEqual(parseExceptionMenu(bat), [
    { label: 'Geometry Part 1', config: 'config2.txt', notes: null },
    { label: 'Geometry Part 2', config: 'config1.txt', notes: null },
  ]);
  assert.deepEqual(parseExceptionMenu('echo off\r\nSET DISK1=Game.hdv\r\n'), []);
});

test('what exception.bat tells the player comes back as paragraphs, wrapped lines joined', () => {
  // As in The Immortal: one note, wrapped at the console's width, after the disks it sets.
  const bat = [
    'echo off', 'SET DISK1=Game.po', 'SET DISK2=', 'cd %VAR%', '..\\..\\..\\util\\setconsole.exe /reset', 'echo.',
    'echo Whenever you are asked to enter a different ', 'echo disk just press enter. Press numpad "enter" ',
    'echo.', 'echo Press 100%% of the keys ^& enjoy.', 'echo.', 'pause',
  ].join('\r\n');
  const notes = parseExceptionNotes(bat);
  assert.equal(notes.general, 'Whenever you are asked to enter a different disk just press enter. Press numpad "enter"\n\nPress 100% of the keys & enjoy.');
  assert.equal(notes.sections.size, 0);
  assert.deepEqual(parseExceptionNotes('echo off\r\nSET DISK1=Game.hdv\r\n'), { general: null, sections: new Map() });
});

test('a menu\'s choices each get what their own section says, without the menu\'s lines', () => {
  // As in Designasaurus.
  const bat = [
    '@echo off', 'cls', 'echo.', 'echo Press 1 to play Designasaurus: Walk a Dinosaur', 'echo Press 2 to play Designasaurus: Build a Dinosaur',
    'echo.', '..\\..\\..\\util\\choice /C:12 /N Please Choose:', 'if errorlevel = 2 goto build', 'if errorlevel = 1 goto walk',
    ':walk', 'cls', 'echo.', 'echo Double click "Dino.Walk" to start the program', 'echo.', 'pause', 'SET CONFIGTXT=config1.txt', 'goto end',
    ':build', 'cls', 'echo.', 'echo Double click "Dino.sys16" to start the program', 'echo.', 'pause', 'SET CONFIGTXT=config2.txt', 'goto end',
    ':end',
  ].join('\r\n');
  assert.equal(parseExceptionNotes(bat).general, null);
  // A list of keys keeps a line each, as in Dragon Wars.
  assert.equal(parseExceptionNotes('echo Some commands are:\r\necho d = Delete character\r\necho alt+q = Quit\r\n').general,
    'Some commands are:\nd = Delete character\nalt+q = Quit');
  assert.deepEqual(parseExceptionMenu(bat).map((c) => c.notes), [
    'Double click "Dino.Walk" to start the program',
    'Double click "Dino.sys16" to start the program',
  ]);
});
