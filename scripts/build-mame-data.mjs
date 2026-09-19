// Builds server/data/mame0244.json: what the browser build of MAME needs to know about each
// arcade set it can run, from the MAME that LaunchBox uses (`mame.exe -listxml`).
//
//   node scripts/build-mame-data.mjs ["path\to\mame.exe"]
//
// The default is LaunchBox's own, Emulators\MAME 0.244\mame.exe under the configured
// launchboxRoot (server/config.js).
//
// Only the sets whose driver is in one of the browser bundles (server/data/mame-bundles.json)
// are kept. For each: its description and year, the other zips it loads (BIOS sets and the
// devices with ROMs of their own, like qsound_hle), its disk images, its screen, its controls
// and how well MAME runs it. The set list has to match the MAME the ROMs were made for, so the
// script refuses any other version. MAME runs in a temp folder, so nothing is written in LaunchBox.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import config from '../server/config.js';

const VERSION = '0.244';
const exe = process.argv[2] ?? path.join(config.launchboxRoot, 'Emulators', `MAME ${VERSION}`, 'mame.exe');
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'data');
const bundles = JSON.parse(fs.readFileSync(path.join(dataDir, 'mame-bundles.json'), 'utf8'));
const bundleOf = new Map(Object.entries(bundles).flatMap(([bundle, sources]) => sources.map((s) => [s, bundle])));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rgb-mame-'));
const version = execFileSync(exe, ['-version'], { cwd: tmp, encoding: 'utf8', windowsHide: true }).trim();
if (!version.startsWith(`${VERSION} `)) throw new Error(`${exe} is MAME ${version}, not ${VERSION}`);

const attr = (line, name) => new RegExp(`[ \\t]${name}="([^"]*)"`).exec(line)?.[1];
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&');

/** Every machine, with just what's used below. */
const machines = new Map();
const child = spawn(exe, ['-listxml'], { cwd: tmp, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
let m = null;
for await (const raw of readline.createInterface({ input: child.stdout, crlfDelay: Infinity })) {
  const line = raw.trim();
  if (line.startsWith('<machine ')) {
    m = {
      name: attr(line, 'name'), source: attr(line, 'sourcefile'), romof: attr(line, 'romof'), cloneof: attr(line, 'cloneof'),
      sampleof: attr(line, 'sampleof'), bios: attr(line, 'isbios') === 'yes', device: attr(line, 'isdevice') === 'yes',
      runnable: attr(line, 'runnable') !== 'no', roms: 0, disks: [], devices: [], displays: [], controls: new Set(),
      buttons: 0, players: 0, status: null, savestate: null, title: '', year: '',
    };
    machines.set(m.name, m);
  } else if (!m) {
    continue;
  } else if (line.startsWith('<description>')) {
    m.title = unescape(line.replace(/<\/?description>/g, ''));
  } else if (line.startsWith('<year>')) {
    m.year = line.replace(/<\/?year>/g, '');
  } else if (line.startsWith('<rom ') && attr(line, 'status') !== 'nodump') {
    m.roms++;
  } else if (line.startsWith('<disk ') && attr(line, 'status') !== 'nodump') {
    m.disks.push(attr(line, 'name'));
  } else if (line.startsWith('<device_ref ')) {
    m.devices.push(attr(line, 'name'));
  } else if (line.startsWith('<display ')) {
    m.displays.push({ type: attr(line, 'type'), rotate: Number(attr(line, 'rotate') ?? 0), width: Number(attr(line, 'width') ?? 0), height: Number(attr(line, 'height') ?? 0) });
  } else if (line.startsWith('<input ')) {
    m.players = Number(attr(line, 'players') ?? 0);
  } else if (line.startsWith('<control ')) {
    m.controls.add(attr(line, 'type'));
    m.buttons = Math.max(m.buttons, Number(attr(line, 'buttons') ?? 0));
  } else if (line.startsWith('<driver ')) {
    m.status = attr(line, 'status');
    m.savestate = attr(line, 'savestate');
  } else if (line.startsWith('</machine>')) {
    m = null;
  }
}
const code = await new Promise((resolve) => child.on('close', resolve));
fs.rmSync(tmp, { recursive: true, force: true });
if (code !== 0 || !machines.size) throw new Error(`mame -listxml failed (exit code ${code})`);

/**
 * The zips a set loads besides its own, in the order MAME looks: the sets it takes ROMs from (a
 * clone's parent, and the BIOS set under that), then every device with ROMs of its own, however
 * deep. LaunchBox's collection is a split set: a clone's zip has only the ROMs its parent's
 * hasn't, and no game's zip has its BIOS.
 */
function otherZips(name) {
  const found = new Set();
  const visit = (machine, viaRomof) => {
    if (!machine) return;
    if (viaRomof && machine.roms) found.add(machine.name);
    if (machine.romof) visit(machines.get(machine.romof), true);
    for (const device of machine.devices) {
      const d = machines.get(device);
      if (!d || found.has(d.name)) continue;
      if (d.roms) found.add(d.name);
      visit(d, false);
    }
  };
  visit(machines.get(name), false);
  found.delete(name);
  return [...found];
}

const sets = {};
for (const machine of machines.values()) {
  const bundle = bundleOf.get(machine.source);
  if (!bundle || machine.device || machine.bios || !machine.runnable) continue;
  const screen = machine.displays[0];
  const entry = {
    bundle,
    source: machine.source,
    title: machine.title,
    year: machine.year || undefined,
    cloneof: machine.cloneof,
    // Where MAME looks for a disk image a clone shares: its own folder, then its parent's.
    romof: machine.romof,
    zips: otherZips(machine.name),
    disks: machine.disks.length ? machine.disks : undefined,
    samples: machine.sampleof,
    status: machine.status,
    savestate: machine.savestate === 'supported' ? undefined : machine.savestate,
    screen: screen && { type: screen.type, rotate: screen.rotate || undefined, width: screen.width, height: screen.height },
    screens: machine.displays.length > 1 ? machine.displays.length : undefined,
    players: machine.players,
    buttons: machine.buttons,
    controls: [...machine.controls].filter(Boolean),
  };
  if (!entry.zips.length) delete entry.zips;
  sets[machine.name] = JSON.parse(JSON.stringify(entry)); // drops the undefined fields
}

const out = path.join(dataDir, `mame${VERSION.replace('.', '')}.json`);
const names = Object.keys(sets).sort();
fs.writeFileSync(out, `{\n${names.map((n) => `${JSON.stringify(n)}: ${JSON.stringify(sets[n])}`).join(',\n')}\n}\n`);
console.log(`${names.length} sets from ${machines.size} machines -> ${path.relative(process.cwd(), out)}`);
