// A game packed up to keep: one folder that plays the game with nothing else installed and
// no network, by opening its .html file.
//
// The folder holds a copy of the game's page (its art, videos, screenshots, manual and the
// rest of what's in the box), and a Play button that starts the same browser engine the app
// uses. A page opened as a file rather than from a server may not fetch() anything else on
// disk, which is how the engines normally read their wasm builds and a game's files, so
// everything they read is written into .js files as base64 and put back in front of them by
// public/offline/runtime.js.
//
// Nothing is built on disk: the zip is written straight to the response as it is put together.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ZipStream, fileSource } from './zipstream.js';
import { scummvmEnginesFor } from './webplay.js';
import { holdCacheDir } from './romcache.js';

// Base64 is written in pieces this big so that a huge game doesn't become one enormous string
// the browser has to hold whole. Must divide by 3, or the pieces won't join back up.
const CHUNK = 6 * 1024 * 1024;
// About how much of a game goes into each .js file. Bigger files mean fewer of them but more
// for the browser to read in one go.
const PART_BYTES = 48 * 1024 * 1024;

const OFFLINE_DIR = 'public/offline';

// What DOSBox and EmulatorJS add to a download: their scripts, one emulator build and, for a
// console, one core. Both are the same size whatever the game. ScummVM's share varies with
// the engine its game needs, so it is worked out from the files (see scummvmOverhead).
// `packed` is what goes into the base64 payload; `plain` is what stays a file of its own.
const ENGINE_BYTES = {
  dosbox: { packed: 8.4 * 1024 * 1024, plain: 0.8 * 1024 * 1024 },
  emulatorjs: { packed: 2.5 * 1024 * 1024, plain: 0.7 * 1024 * 1024 },
  // One MAME bundle, 21-36 MB of wasm (about 32 MB for most).
  mame: { packed: 32 * 1024 * 1024, plain: 0.45 * 1024 * 1024 },
};

// Base64 is four characters for every three bytes, which is what a download's game files
// take up once unzipped.
const BASE64 = 4 / 3;

// ScummVM's data folder holds a file for nearly every engine it has. Which one a game needs
// isn't worth guessing at, so a download takes the lot bar these: the CJK fonts (38 MB, for
// games this library doesn't have) and ScummVM's own soundfont, which eXo's mt32 folder
// already provides for the games set up to use one.
const SCUMMVM_SKIP = new Set(['fonts-cjk.dat', 'Roland_SC-55.sf2']);
// Ultima's data file is 16 MB and no other engine reads it.
const SCUMMVM_ENGINE_ONLY = { 'ultima.dat': 'ultima' };

/**
 * About how big a download of this version comes to unzipped, for the button that offers one:
 * the game, the engine that plays it, and the art and papers on its page. Some games carry
 * a couple of hundred megabytes of scanned books in their extras, so the last part matters,
 * and so does base64 (see BASE64), which everything the engine reads is written in.
 */
export function standaloneBytes(version, stats, mediaBytes = 0, scummvmDir = null) {
  const engine = version.engine === 'scummvm'
    ? scummvmOverhead(scummvmDir, scummvmEnginesFor(version))
    : ENGINE_BYTES[version.engine] ?? { packed: 0, plain: 0 };
  return Math.round(((stats?.totalBytes ?? 0) + engine.packed) * BASE64) + engine.plain + mediaBytes;
}

// The sizes of the ScummVM build, read once: they don't change while the server runs.
let scummvmSizes = null;

/**
 * What ScummVM adds to a download: its wasm build, its shell, the engine data files, and the
 * plugin for the game's engine — or every plugin (a third of a gigabyte) for the few games
 * whose engine can only be told from their files.
 */
function scummvmOverhead(scummvmDir, engines) {
  if (!scummvmDir) return { packed: 0, plain: 0 };
  if (!scummvmSizes) {
    const size = (...rest) => { try { return fs.statSync(path.join(scummvmDir, ...rest)).size; } catch { return 0; } };
    const dataDir = path.join(scummvmDir, 'data');
    let data = size('scummvm.wasm');
    for (const dirent of readdirSafe(dataDir)) {
      if (!dirent.isFile() || SCUMMVM_SKIP.has(dirent.name) || dirent.name in SCUMMVM_ENGINE_ONLY) continue;
      data += size('data', dirent.name);
    }
    const plugins = new Map();
    for (const dirent of readdirSafe(path.join(dataDir, 'plugins'))) {
      if (dirent.isFile() && dirent.name.endsWith('.so')) plugins.set(dirent.name, size('data', 'plugins', dirent.name));
    }
    scummvmSizes = {
      data,
      // The shell is a script of its own, not part of the payload.
      shell: size('scummvm.js'),
      plugins,
      extras: new Map(Object.entries(SCUMMVM_ENGINE_ONLY).map(([file, engine]) => [engine, size('data', file)])),
    };
  }
  const wanted = engines.length ? engines.map((e) => `lib${e}.so`) : [...scummvmSizes.plugins.keys()];
  const plugins = wanted.reduce((total, name) => total + (scummvmSizes.plugins.get(name) ?? 0), 0);
  const extras = engines.reduce((total, engine) => total + (scummvmSizes.extras.get(engine) ?? 0), 0);
  return { packed: scummvmSizes.data + plugins + extras, plain: scummvmSizes.shell };
}

function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The size of everything the game's page shows, which is the same for all of its versions. */
export async function mediaBytes(context) {
  const { files } = await mediaPlan(context);
  return files.reduce((total, file) => total + file.size, 0);
}

/**
 * A name Windows will have as a file or folder. Long ones are cut back at a word: a download
 * is a folder holding a page of the same name and a few folders more, and Windows still gives
 * up on a path over 260 characters.
 *
 * "#" and "%" go too, though Windows would have them: the name is also the address the page
 * links to, where a "#" would start a fragment and a "%" an escape, so "Issue #3.pdf" would
 * open nothing and "100%.pdf" wouldn't decode.
 */
export function safeName(name, { fallback = 'Game', max = 48 } = {}) {
  // Whitespace first, so a line break becomes a space rather than closing the gap; then the
  // control characters left, which no file name may hold.
  const clean = String(name).replace(/[\\/:*?"<>|#%]/g, '-').replace(/\s+/g, ' ').replace(/\p{Cc}/gu, '').trim();
  const cut = clean.length > max ? clean.slice(0, clean.lastIndexOf(' ', max) + 1 || max) : clean;
  // Windows silently drops a dot or a space at the end of a name; a dash left by a cut, or by
  // a colon in the title, only looks like a mistake.
  // Names Windows keeps for devices ("Con", "Aux", "Com1"), whatever follows a dot, can't be
  // files at all.
  return (cut.replace(/[. -]+$/, '') || fallback).replace(/^(con|prn|aux|nul|com\d|lpt\d)(?=\.|$)/i, '$1_');
}

/** The name for a game's folder and page: its sort title where that is the shorter way to say it. */
function shortTitle(game) {
  const sort = (game.sortTitle ?? '').trim();
  return sort && sort.length < game.title.length ? sort : game.title;
}

/**
 * What the folder is called after the game's name: "Loom (CD DOS VGA)". Console versions are
 * labelled by region alone ("USA, 3 languages"); computer versions carry the title as well
 * ("Loom (CD DOS VGA)"), which would otherwise be said twice.
 */
function versionSuffix(game, version) {
  const label = (version.label ?? '').trim();
  if (!label || label === game.title) return '';
  const rest = label.toLowerCase().startsWith(game.title.toLowerCase()) ? label.slice(game.title.length).trim() : label;
  const inner = /^\((.*)\)$/.exec(rest)?.[1] ?? rest;
  return inner ? ` (${inner})` : '';
}

/** A game version's name as a file or folder: "Loom (CD DOS VGA)". */
export const versionFileName = (game, version) => safeName(`${shortTitle(game)}${versionSuffix(game, version)}`);

/** What the browser saves the download as. */
export function downloadName(game, version) {
  return `${versionFileName(game, version)} (offline).zip`;
}

/**
 * Writes the whole download to `out` (the response). Everything is streamed: the biggest
 * thing held in memory at once is one piece of base64.
 *
 * @param {object} context
 * @param {object} context.game a library game record
 * @param {object} context.version one of webPlay.versionsFor(game)
 * @param {string} context.sound the music choice, as the player page passes it
 * @param {number[]} context.controllerLayouts players 1-4's controller layouts in a console game (1 or 2 each)
 * @param {Array<{id: string, name: string, rel: string, ext: string}>} context.extras
 * @param {string|null} context.scummvmId shown among the facts, as on the game's own page
 * @param {import('./webplay.js').WebPlay} context.webPlay
 * @param {import('./paths.js').PathResolver} context.resolver
 * @param {{projectRoot: string, scummvmDir: string, jsdosDir: string, emulatorDir: string}} context.dirs
 * @param {import('node:stream').Writable} out
 */
export async function writeStandalone(context, out) {
  const media = await mediaPlan(context);
  const plan = await enginePlan(context);
  // A Windows 3.x game is read from the server's cache, which isn't trimmed from under it.
  const release = plan.cacheDir ? holdCacheDir(plan.cacheDir) : null;
  try {
    await writeZip(context, media, plan, out);
  } finally {
    release?.();
  }
}

async function writeZip(context, media, plan, out) {
  const { game, version } = context;
  const root = safeName(`${shortTitle(game)}${versionSuffix(game, version)}`);
  const pageFile = `${safeName(shortTitle(game))}.html`;
  const parts = planParts(plan.payload);
  // What the folder comes to once unzipped, said on its page.
  const scriptSizes = await Promise.all(plan.scripts.map(async (file) => (await fsp.stat(file.abs)).size));
  const bundleBytes = Math.round(plan.payload.reduce((n, item) => n + item.size, 0) * BASE64)
    + scriptSizes.reduce((n, size) => n + size, 0)
    + media.files.reduce((n, file) => n + file.size, 0);

  const zip = new ZipStream(out);
  const at = (name) => `${root}/${name}`;

  await zip.add(at(pageFile), pageHtml({ ...context, media, plan, pageFile, bundleBytes }), { deflate: true });
  await zip.add(at('README.txt'), readme(context, plan), { deflate: true });
  // MAME's own license notice, which scripts/fetch-mame.mjs brings with the builds.
  const mameCopying = plan.engine === 'mame' && context.dirs.mameDir && path.join(context.dirs.mameDir, 'COPYING');
  if (mameCopying && fs.existsSync(mameCopying)) await zip.add(at('player/MAME-COPYING.txt'), fileSource(mameCopying), { deflate: true });

  const offline = path.join(context.dirs.projectRoot, OFFLINE_DIR);
  const publicDir = path.join(context.dirs.projectRoot, 'public');
  await zip.add(at('app.css'), fileSource(path.join(publicDir, 'app.css')), { deflate: true });
  await zip.add(at('page.css'), fileSource(path.join(offline, 'page.css')), { deflate: true });
  await zip.add(at('page.js'), fileSource(path.join(offline, 'page.js')), { deflate: true });

  // The app's typeface travels with the page: without it the download would fall back to the
  // system's own, which doesn't look like the app at all.
  for (const file of await fsp.readdir(path.join(publicDir, 'fonts')).catch(() => [])) {
    if (file.endsWith('.woff2') || file === 'OFL.txt') await zip.add(at(`fonts/${file}`), fileSource(path.join(publicDir, 'fonts', file)));
    // The app serves the fonts from the root of the site; here they sit next to their stylesheet.
    else if (file === 'inter.css') await zip.add(at('fonts/inter.css'), (await fsp.readFile(path.join(publicDir, 'fonts', file), 'utf8')).replaceAll('url("/fonts/', 'url("'), { deflate: true });
  }

  for (const file of media.files) {
    await zip.add(at(file.name), fileSource(file.abs), { deflate: false, size: file.size });
  }

  await zip.add(at('player/play.html'), fileSource(path.join(offline, 'play.html')), { deflate: true });
  await zip.add(at('player/runtime.js'), fileSource(path.join(offline, 'runtime.js')), { deflate: true });
  // The loading card and its words, the same file the app's own player pages use, so a
  // downloaded game starts up looking and reading exactly as it does in the app.
  await zip.add(at('player/shell.css'), fileSource(path.join(publicDir, 'player', 'shell.css')), { deflate: true });
  await zip.add(at('player/shell.js'), fileSource(path.join(publicDir, 'player', 'shell.js')), { deflate: true });
  // What EmulatorJS needs fixed, shared with the app's own console player.
  await zip.add(at('player/emulatorjs-fixes.js'), fileSource(path.join(publicDir, 'player', 'emulatorjs-fixes.js')), { deflate: true });
  // How an arcade game runs in MAME, shared with the app's own arcade player.
  await zip.add(at('player/mame-player.js'), fileSource(path.join(publicDir, 'player', 'mame-player.js')), { deflate: true });
  await zip.add(at('player/launch.js'), launchJs({ ...context, plan, parts, pageFile }), { deflate: true });

  for (const file of plan.scripts) {
    await zip.add(at(`player/${file.name}`), fileSource(file.abs), { deflate: true });
  }

  // The game's own data, base64'd: most of the download, and mostly packed already (eXo's zips,
  // compressed ROMs). Measured on eXoDOS zips, packing by character frequency alone came out the
  // same size as a full deflate in a third of the time; on raw CD images it's about 8% bigger.
  for (const part of parts) {
    await zip.add(at(`player/${part.name}`), partSource(part), { deflate: true, huffmanOnly: true });
  }

  await zip.finish();
}

// ---------- The files the engines read ----------

/**
 * What one version needs to run with no server: the engine's own scripts (loaded by a
 * <script> tag, which a page on disk may still do) and everything it reads over HTTP, which
 * goes into the base64 payload under the path the engine asks for.
 */
async function enginePlan(context) {
  if (context.version.engine === 'dosbox') return dosPlan(context);
  if (context.version.engine === 'emulatorjs') return emuPlan(context);
  if (context.version.engine === 'mame') return mamePlan(context);
  return scummvmPlan(context);
}

/** The arcade games, through MAME's browser build. Mirrors public/mame/play.html. */
async function mamePlan(context) {
  const { game, version, webPlay, dirs } = context;
  const info = webPlay.mameLaunch(game, version);
  const bundle = (ext) => path.join(dirs.mameDir, `${info.bundle}.${ext}`);
  // The bundle's .js is a plain script (see player/mame-player.js, which adds its tag); its wasm
  // is handed to it from the payload.
  const scripts = [{ name: `engine/mame/${info.bundle}.js`, abs: bundle('js') }];
  const payload = [await entry(`engine/mame/${info.bundle}.wasm`, bundle('wasm'))];
  // The game's files under their paths in MAME's folders: its zips, disk images and samples.
  const files = [];
  for (const file of version.files.filter((f) => f.abs)) {
    const key = `game/${file.name}`;
    payload.push(await entry(key, file.abs));
    files.push({ name: file.name, key });
  }
  return {
    engine: 'mame',
    engineName: info.engineName,
    scripts,
    payload,
    styles: [],
    load: [],
    launch: {
      info: { ...info, files: undefined },
      files,
      wasmKey: `engine/mame/${info.bundle}.wasm`,
      scriptUrl: `engine/mame/${info.bundle}.js`,
    },
  };
}

/** MS-DOS and Windows 3.x games, through js-dos. Mirrors public/playdos.html. */
async function dosPlan(context) {
  const { version, sound, webPlay, dirs } = context;
  const info = await webPlay.dosLaunch(version, sound);
  const scripts = [];
  const payload = [];
  const engine = (name) => path.join(dirs.jsdosDir, name);

  scripts.push({ name: 'engine/js-dos.js', abs: engine('js-dos.js') });
  scripts.push({ name: 'engine/js-dos.css', abs: engine('js-dos.css') });
  // js-dos loads this one itself, by a <script> tag under pathPrefix.
  scripts.push({ name: 'engine/emulators.js', abs: engine('emulators/emulators.js') });

  // The emulator build it will ask for, and the zip library it packs saved files with.
  const dosbox = info.backend === 'dosboxX' ? 'wdosbox-x' : 'wdosbox';
  for (const name of [`${dosbox}.js`, `${dosbox}.wasm`, 'wlibzip.js', 'wlibzip.wasm']) {
    payload.push(await entry(`engine/${name}`, engine(path.join('emulators', name))));
  }

  // The game itself: a DOS game is its eXoDOS zip; a Windows 3.x game is the folder eXo
  // installed it into, which the server keeps a copy of (see win3xBundle).
  const initFiles = [];
  let bundleUrl = null;
  let cacheDir = null;
  if (version.win3x) {
    // Too big for the browser, so an offline copy couldn't play it either.
    if (!webPlay.win3xBundles(version)) throw Object.assign(new Error(version.knownIssue ?? 'Too big to load in the browser.'), { status: 400 });
    const bundle = await webPlay.win3xBundle(version);
    if (!bundle) throw Object.assign(new Error('The game\'s files couldn\'t be read.'), { status: 404 });
    cacheDir = bundle.dir;
    for (const file of bundle.files) {
      // The listing carries an entry for each folder as well. js-dos makes a file's folders
      // for it, so an empty one only needs a placeholder to exist at all.
      if (file.name.endsWith('/')) {
        initFiles.push({ path: `${file.name}.keep` });
        continue;
      }
      const key = `game/files/${file.name}`;
      payload.push(await entry(key, path.join(bundle.dir, ...file.name.split('/'))));
      initFiles.push({ path: file.name, url: key });
    }
  } else {
    bundleUrl = 'game/game.zip';
    payload.push(await entry(bundleUrl, version.zipAbs));
  }

  // MT-32 ROMs or the soundfont, when the chosen music needs them. dosLaunch names them
  // relative to the emulated file system ("mt32/CM32L_PCM.ROM"); on disk they sit together.
  const mt32 = webPlay.mt32Dir(version.exoRoot);
  const files = [];
  for (const f of info.files ?? []) {
    const key = `game/${f.path}`;
    payload.push(await entry(key, path.join(mt32, path.basename(f.path))));
    files.push({ path: f.path, url: key });
  }

  return {
    engine: 'dosbox',
    engineName: 'DOSBox',
    scripts,
    payload,
    cacheDir,
    styles: ['engine/js-dos.css'],
    load: ['engine/js-dos.js'],
    launch: {
      conf: info.conf,
      backend: info.backend,
      aspect: info.aspect,
      mouseLock: info.mouseLock,
      folders: info.folders,
      files,
      bundleUrl,
      initFiles,
    },
  };
}

/** The console games, through EmulatorJS. Mirrors public/emu/play.html. */
async function emuPlan(context) {
  const { game, version, webPlay, dirs } = context;
  const info = await webPlay.emuLaunch(game, version);
  const data = (...rest) => path.join(dirs.emulatorDir, 'data', ...rest);
  const scripts = ['loader.js', 'emulator.min.js', 'emulator.min.css']
    .map((name) => ({ name: `engine/emulatorjs/${name}`, abs: data(name) }));

  const payload = [];
  // The core, and the older build of it EmulatorJS falls back to on an older browser.
  for (const name of [`${info.core}-wasm.data`, `${info.core}-legacy-wasm.data`]) {
    if (fs.existsSync(data('cores', name))) payload.push(await entry(`engine/emulatorjs/cores/${name}`, data('cores', name)));
  }
  // Unpacking the game: offline it is the browser's job, whatever the archive is.
  for (const name of ['extractzip.js', 'extract7z.js', 'libunrar.js', 'libunrar.wasm']) {
    if (fs.existsSync(data('compression', name))) payload.push(await entry(`engine/emulatorjs/compression/${name}`, data('compression', name)));
  }
  // Its language file, its version, and the core's own report of what it can do.
  for (const [key, abs] of [
    ['localization/en-US.json', data('localization', 'en-US.json')],
    ['version.json', data('version.json')],
    [`cores/reports/${info.core}.json`, data('cores', 'reports', `${info.core}.json`)],
  ]) {
    if (fs.existsSync(abs)) payload.push(await entry(`engine/emulatorjs/${key}`, abs));
  }

  // The ROM, as it sits on disk. The server unpacks big CD archives before sending them over
  // the network; a download keeps the archive, and the browser unpacks it each time it starts.
  // runtime.js and EmulatorJS read the name as a URL, where a "#" starts a fragment (EmulatorJS
  // also cuts the name it stores the ROM under there) and a "%" an escape. Only those two are
  // encoded, so every other game keeps the file name its battery saves are named after.
  const romName = path.basename(version.romAbs);
  const gameUrl = `game/${romName.replace(/[#%]/g, encodeURIComponent)}`;
  payload.push(await entry(`game/${romName}`, version.romAbs));

  let biosUrl = null;
  if (info.biosUrl) {
    const abs = webPlay.biosPath(info.biosUrl);
    if (abs) {
      biosUrl = `game/${info.biosUrl}`;
      payload.push(await entry(biosUrl, abs));
    }
  }

  return {
    engine: 'emulatorjs',
    engineName: info.coreName,
    scripts,
    payload,
    styles: [],
    load: [],
    launch: {
      core: info.core,
      gameName: info.gameName,
      controlScheme: info.controlScheme,
      keyboard: info.keyboard,
      coreOptions: info.coreOptions,
      buttonNames: info.buttonNames,
      controllerLayouts: context.controllerLayouts,
      gameUrl,
      biosUrl,
      keepBiosZipped: info.keepBiosZipped,
    },
  };
}

/** The ScummVM games. Mirrors public/play.html. */
async function scummvmPlan(context) {
  const { game, version, sound, webPlay, dirs } = context;
  const info = webPlay.launchFor(game, version, sound);
  const scripts = [{ name: 'engine/scummvm.js', abs: path.join(dirs.scummvmDir, 'scummvm.js') }];
  const payload = [await entry('engine/scummvm.wasm', path.join(dirs.scummvmDir, 'scummvm.wasm'))];

  // The settings the browser build starts with, which it reads by this name (see server/index.js).
  payload.push(text('scummvm.ini', '[scummvm]\ngui_theme=scummremastered\naspect_ratio=true\nfiltering=false\n'));

  // ScummVM reads its file system over HTTP: every folder has an index.json of names to sizes
  // (a folder is an empty object), which this writes for the folders the download holds.
  const dataDir = path.join(dirs.scummvmDir, 'data');
  const index = {};
  const engines = scummvmEnginesFor(version);
  for (const dirent of await fsp.readdir(dataDir, { withFileTypes: true }).catch(() => [])) {
    const { name } = dirent;
    if (dirent.isDirectory()) {
      // The engine plugins are picked out below; the launcher's game icons are 200 MB of
      // pictures for a list a download never shows.
      if (name === 'plugins' || name === 'gui-icons') continue;
      index[name] = {};
      await addTree(payload, path.join(dataDir, name), `data/${name}`);
      continue;
    }
    if (!dirent.isFile() || SCUMMVM_SKIP.has(name)) continue;
    if (name in SCUMMVM_ENGINE_ONLY && !engines.includes(SCUMMVM_ENGINE_ONLY[name])) continue;
    const abs = path.join(dataDir, name);
    index[name] = (await fsp.stat(abs)).size;
    payload.push(await entry(`data/${name}`, abs));
  }
  index.plugins = {};
  index.games = {};
  index.mt32 = {};

  // One engine is a few megabytes; all of them are a third of a gigabyte. A game whose engine
  // can't be named from its ID (ScummVM would work it out from the files) has to carry them all.
  const pluginDir = path.join(dataDir, 'plugins');
  const wantedPlugins = engines.map((e) => `lib${e}.so`);
  const plugins = {};
  for (const name of await fsp.readdir(pluginDir).catch(() => [])) {
    if (!name.endsWith('.so')) continue;
    if (wantedPlugins.length && !wantedPlugins.includes(name)) continue;
    const abs = path.join(pluginDir, name);
    plugins[name] = (await fsp.stat(abs)).size;
    payload.push(await entry(`data/plugins/${name}`, abs));
  }
  payload.push(text('data/plugins/index.json', JSON.stringify(plugins)));

  // The game's own folder, under the same path its arguments name.
  payload.push(text('data/games/index.json', JSON.stringify({ [version.id]: {} })));
  await addTree(payload, version.dir, `data/games/${version.id}`);

  // The MT-32 ROMs or the soundfont, when the music needs them.
  const mt32 = webPlay.mt32Dir(version.exoRoot);
  const wanted = info.args.some((a) => a.startsWith('--extrapath=')) ? /\.rom$/i
    : info.args.some((a) => a.startsWith('--soundfont=')) ? /\.sf2$/i : null;
  const mt32Index = {};
  if (mt32 && wanted) {
    for (const name of await fsp.readdir(mt32).catch(() => [])) {
      if (!wanted.test(name)) continue;
      const abs = path.join(mt32, name);
      mt32Index[name] = (await fsp.stat(abs)).size;
      payload.push(await entry(`data/mt32/${name}`, abs));
    }
  }
  payload.push(text('data/mt32/index.json', JSON.stringify(mt32Index)));
  payload.push(text('data/index.json', JSON.stringify(index)));

  return {
    engine: 'scummvm',
    engineName: 'ScummVM',
    scripts,
    payload,
    styles: [],
    load: [],
    launch: { args: info.args },
  };
}

/**
 * Everything under a folder, as payload entries plus an index.json for each folder. A folder
 * that can't be read (the games share went away) fails the download before it starts, rather
 * than leaving a game that's missing files and says nothing about it.
 */
async function addTree(payload, dir, prefix) {
  const listing = {};
  for (const dirent of await fsp.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      listing[dirent.name] = {};
      await addTree(payload, abs, `${prefix}/${dirent.name}`);
    } else if (dirent.isFile()) {
      const stat = await fsp.stat(abs);
      listing[dirent.name] = stat.size;
      payload.push({ key: `${prefix}/${dirent.name}`, abs, size: stat.size });
    }
  }
  payload.push(text(`${prefix}/index.json`, JSON.stringify(listing)));
}

const entry = async (key, abs) => ({ key, abs, size: (await fsp.stat(abs)).size });
const text = (key, string) => ({ key, buffer: Buffer.from(string), size: Buffer.byteLength(string) });

// ---------- The base64 payload ----------

/**
 * Shares the files out between .js files of about PART_BYTES each, splitting a big one across
 * several. Each piece of base64 stands alone, so a file can pick up in the next .js file where
 * the last one left off.
 */
function planParts(payload) {
  const parts = [];
  let slices = [];
  let bytes = 0;
  const flush = () => {
    if (!slices.length) return;
    parts.push({ name: `payload/p${parts.length + 1}.js`, slices });
    slices = [];
    bytes = 0;
  };
  for (const item of payload) {
    for (let start = 0; start < item.size || start === 0; start += CHUNK) {
      const end = Math.min(start + CHUNK, item.size);
      slices.push({ ...item, start, end, first: start === 0 });
      bytes += end - start;
      if (bytes >= PART_BYTES) flush();
      if (end >= item.size) break;
    }
  }
  flush();
  return parts;
}

/** One .js file of the payload: the base64 of its slices, as plain assignments. */
async function* partSource(part) {
  for (const slice of part.slices) {
    const key = JSON.stringify(slice.key);
    yield Buffer.from(slice.first ? `(window.RGB_DATA ||= {})[${key}] = [` : `window.RGB_DATA[${key}].push(`);
    let first = true;
    for await (const chunk of sliceBytes(slice)) {
      yield Buffer.from(`${first ? '\n' : ',\n'}"${chunk.toString('base64')}"`);
      first = false;
    }
    yield Buffer.from(slice.first ? '\n];\n' : '\n);\n');
  }
}

/**
 * One slice's bytes, in pieces that line up with the base64 chunks. A file is read a piece at
 * a time; nothing bigger than CHUNK is ever held.
 */
async function* sliceBytes(slice) {
  if (slice.end <= slice.start) return;
  if (slice.buffer) {
    yield slice.buffer.subarray(slice.start, slice.end);
    return;
  }
  const stream = fs.createReadStream(slice.abs, { start: slice.start, end: slice.end - 1, highWaterMark: 1 << 20 });
  let held = [];
  let heldBytes = 0;
  for await (const chunk of stream) {
    held.push(chunk);
    heldBytes += chunk.length;
    if (heldBytes >= CHUNK) {
      const all = Buffer.concat(held);
      yield all.subarray(0, CHUNK);
      held = all.length > CHUNK ? [all.subarray(CHUNK)] : [];
      heldBytes = held.length ? held[0].length : 0;
    }
  }
  if (heldBytes) yield Buffer.concat(held);
}

// ---------- The page's own files ----------

const SCREENSHOT_TYPES = ['Screenshot - Gameplay', 'Screenshot - Game Title', 'Screenshot - Game Select',
  'Screenshot - Game Over', 'Screenshot - High Scores'];
const GALLERY_TYPES = ['Box - Back', 'Box - 3D', 'Box - Front', 'Box - Front - Reconstructed', 'Box - Back - Reconstructed',
  'Disc', 'Cart - Front', 'Advertisement Flyer - Front', 'Advertisement Flyer - Back', 'Fanart - Box - Front',
  'Fanart - Box - Back', 'Fanart - Disc', 'Fanart - Background', 'Banner'];

/** The pictures, videos and papers that go in the download, and what the page calls them. */
async function mediaPlan(context) {
  const { game, extras, resolver } = context;
  const files = [];
  const used = new Set();
  // What each file already went in as, so one picture is packed once however many places the
  // page shows it. The backdrop is usually the first screenshot, and the page shows it as
  // both; without this it would travel twice.
  const packed = new Map();

  const add = async (name, rel) => {
    const abs = rel && resolver.resolve(rel);
    if (!abs) return null;
    const already = packed.get(abs);
    if (already) return already;
    let size;
    try {
      size = (await fsp.stat(abs)).size;
    } catch {
      return null;
    }
    // Windows doesn't tell "Map.pdf" from "map.pdf": unzipped, one would overwrite the other.
    let unique = `media/${name}${path.extname(abs).toLowerCase()}`;
    for (let n = 2; used.has(unique.toLowerCase()); n++) unique = `media/${name}-${n}${path.extname(abs).toLowerCase()}`;
    used.add(unique.toLowerCase());
    packed.set(abs, unique);
    files.push({ name: unique, abs, size });
    return unique;
  };

  const image = (type, n) => game.images[type]?.[n]?.rel ?? null;

  const plan = {
    files,
    logo: await add('logo', image(game.slots.clearLogo, 0)),
    box: await add('box-front', image(game.slots.front, 0)),
    background: null,
    shots: [],
    gallery: [],
    videos: [],
    manual: null,
    music: null,
    extras: [],
  };

  const bgType = game.slots.background ?? game.slots.screenshot;
  plan.background = bgType ? await add('background', image(bgType, 0)) : null;

  for (const type of SCREENSHOT_TYPES) {
    for (const [n] of (game.images[type] ?? []).entries()) {
      const url = await add(`shot-${String(plan.shots.length + 1).padStart(2, '0')}`, image(type, n));
      if (url) plan.shots.push({ url, label: type });
    }
  }
  // The same rule the app's page uses: the front cover and the screenshots are already shown.
  const skip = new Set([game.slots.front, 'Clear Logo', ...SCREENSHOT_TYPES]);
  for (const type of GALLERY_TYPES) {
    for (const [n] of (game.images[type] ?? []).entries()) {
      if (skip.has(type) && n === 0) continue;
      const url = await add(`art-${String(plan.gallery.length + 1).padStart(2, '0')}`, image(type, n));
      if (url) plan.gallery.push({ url, label: type });
    }
  }
  for (const [n, video] of game.videos.entries()) {
    const url = await add(`video-${n + 1}`, video.rel);
    if (url) plan.videos.push(url);
  }
  plan.manual = await add('manual', game.manualRel);
  plan.music = await add('music', game.musicRel);
  for (const extra of extras ?? []) {
    const url = await add(`extras/${safeName(extra.name, { fallback: `extra-${plan.extras.length + 1}`, max: 40 })}`, extra.rel);
    if (url) plan.extras.push({ url, name: extra.name, ext: extra.ext });
  }
  return plan;
}

// ---------- The page ----------

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SHORT_PLATFORMS = {
  'Nintendo Entertainment System': 'NES',
  'Super Nintendo Entertainment System': 'SNES',
  'Nintendo 64': 'N64',
  'Sony Playstation': 'PlayStation',
  'Sega Genesis': 'Genesis',
  'NEC TurboGrafx-16': 'TurboGrafx-16',
  'SNK Neo Geo AES': 'Neo Geo',
  'Commodore 64': 'C64',
  'Windows 3x': 'Windows 3.x',
};

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!m || (m === 12 && d === 31) || (m === 1 && d === 1)) return String(y);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function formatDuration(seconds) {
  if (!seconds) return '';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return hrs ? `${hrs} h ${mins} min` : `${mins} min`;
}

/** The day a game was last played. Unlike a release date, never a year on its own. */
function playedDate(iso) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return formatDate(iso);
  return new Date(time).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// The same little pixel drawings the app's page puts on the things in the box.
const ICONS = {
  doc: 'M1 0h7v1H1zM1 1h1v11H1zM2 11h9v1H2zM10 3h1v8h-1zM8 1h1v1H8zM9 2h1v1H9zM7 1h1v3h3v1H7zM3 6h5v1H3zM3 8h6v1H3z',
  picture: 'M0 1h12v1H0zM0 10h12v1H0zM0 2h1v8H0zM11 2h1v8h-1zM8 3h2v2H8zM2 9V8h1V7h1V6h1V5h1v1h1v1h1v1h1V7h1v1h1v1z',
  audio: 'M8 1h1v8H8zM9 1h2v1H9zM10 2h1v2h-1zM5 8h3v3H5zM4 9h1v1H4z',
  web: 'M4 1h4v1H4zM2 2h2v1H2zM8 2h2v1H8zM1 3h1v6H1zM10 3h1v6h-1zM2 9h2v1H2zM8 9h2v1H8zM4 10h4v1H4zM5 2h1v8H5zM2 5h8v1H2z',
};
const PLAYABLE_IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']);
const PLAYABLE_AUDIO = new Set(['mp3', 'ogg', 'oga', 'wav', 'flac', 'm4a', 'opus']);
const itemKind = (ext) => (PLAYABLE_IMAGE.has(ext) ? 'picture' : PLAYABLE_AUDIO.has(ext) ? 'audio' : /^html?$/.test(ext) ? 'web' : 'doc');
const iconSvg = (kind) => `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="${ICONS[kind]}"></path></svg>`;

/** The downloaded copy of the game's page. */
function pageHtml(context) {
  const { game, version, media, plan, scummvmId, plays, bundleBytes } = context;
  const title = esc(game.title);
  const platform = esc(SHORT_PLATFORMS[game.platform] ?? game.platform);

  const heading = media.logo
    ? `<h1 class="room-title visually-hidden">${title}</h1><img class="room-logo" src="${esc(media.logo)}" alt="">`
    : `<h1 class="room-title">${title}</h1>`;

  const box = media.box
    ? `<button type="button" class="room-box" data-full="${esc(media.box)}" data-label="Cover of ${title}" aria-label="Enlarge the cover">
        <img src="${esc(media.box)}" alt="Cover of ${title}"></button>`
    : '<div class="room-box"></div>';

  const facts = [
    ['Developer', game.developer],
    ['Publisher', game.publisher],
    ['Released', formatDate(game.releaseDate)],
    ['Genre', game.genres.join(', ')],
    ['Players', [game.playModes.join(', '), game.maxPlayers > 1 ? `up to ${game.maxPlayers}` : ''].filter(Boolean).join(', ')],
    ['Series', game.series.join(', ')],
    ['Community rating', game.communityRating ? `${game.communityRating.toFixed(1)} of 5 from ${plural(game.communityVotes, 'vote')}` : ''],
    ['ESRB', game.esrb && game.esrb !== 'Not Rated' ? game.esrb : ''],
    ['Also known as', game.alternateNames.join(', ')],
    // How much it had been played when it was packed. A download keeps no count of its own.
    ['Played', plays?.playCount
      ? [plural(plays.playCount, 'time'), formatDuration(plays.playTime), plays.lastPlayed ? `last on ${playedDate(plays.lastPlayed)}` : ''].filter(Boolean).join(', ')
      : ''],
    ['ScummVM ID', scummvmId],
  ].filter(([, value]) => value);

  const inTheBox = [
    ...(media.manual ? [{ name: 'Manual', ext: path.extname(media.manual).slice(1).toLowerCase(), url: media.manual }] : []),
    ...media.extras.map((e) => ({ name: e.name, ext: e.ext, url: e.url })),
  ];

  // Ranked and named as the app's own page does it, so the page reads the same.
  const versions = rankVersions(context.allVersions, context.versionOrder);
  const names = shortNames(versions);
  const bundled = versions.find((v) => v.id === version.id);
  const versionRow = (v, here) => `
      <li class="version${here ? ' is-default' : ' is-elsewhere'}">
        <div class="version-name-cell">
          <span class="version-name">${esc(names.get(v))}</span>
          <span class="version-meta">${esc(versionMeta(v, context, names.get(v)))}</span>
          ${here && v.knownIssue ? `<span class="version-meta is-warning">${esc(v.knownIssue)}</span>` : ''}
          ${here && v.note ? `<span class="version-meta">${esc(v.note)}</span>` : ''}
          ${here && v.howToPlay ? `<span class="version-meta is-how-to-play">${esc(v.howToPlay)}</span>` : ''}
        </div>
        ${here ? '<a class="play-button small" href="player/play.html">Play</a>' : '<span class="version-elsewhere">Not in this download</span>'}
      </li>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect x='3' y='1' width='10' height='14' rx='1' fill='%23f4d35e'/%3E%3Crect x='5' y='3' width='6' height='5' fill='%2316132b'/%3E%3C/svg%3E">
<link rel="stylesheet" href="fonts/inter.css">
<link rel="stylesheet" href="app.css">
<link rel="stylesheet" href="page.css">
</head>
<body class="on-game">
<article class="room">
  ${media.background ? `<div class="room-backdrop" aria-hidden="true" style="background-image: url(&quot;${esc(media.background)}&quot;)"></div>` : ''}
  <div class="room-inner">
    <div class="room-nav">
      <p class="offline-note">Downloaded from <strong>RetroGameBrowser</strong>. This folder plays on its own — no server, no internet.</p>
    </div>
    <div class="room-top">
      ${box}
      <div class="room-main">
        ${heading}
        <p class="room-byline"><span class="room-platform">${platform}</span>${esc([game.year, game.developer].filter(Boolean).join(', '))}</p>
        <div class="play-panel">
          <a class="play-button" href="player/play.html">Play</a>
          <div class="play-summary">
            <p class="play-version">${esc(names.get(bundled) ?? version.label)}</p>
            <p class="play-meta">${esc(versionMeta(version, context, names.get(bundled)))}${bundleBytes ? `. About ${formatBytes(bundleBytes)} unzipped` : ''}.</p>
            ${version.note ? `<p class="play-meta">${esc(version.note)}</p>` : ''}
            ${version.howToPlay ? version.howToPlay.split(/\n\n+/).map((p, i) => `<p class="play-meta">${i ? '' : '<strong>How to play: </strong>'}${esc(p)}</p>`).join('') : ''}
            ${version.knownIssue ? `<p class="play-meta"><span class="play-warning">${esc(version.knownIssue)}</span></p>` : ''}
          </div>
        </div>
        ${media.music ? `<div class="actions"><button type="button" class="action" id="music-button" aria-pressed="false">Play music</button></div>
        <audio id="music" src="${esc(media.music)}" preload="none"></audio>` : ''}
        ${game.notes ? `<div class="room-notes">${game.notes.split(/\n\s*\n/).map((p) => `<p>${esc(p.trim())}</p>`).join('')}</div>` : ''}
        ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
      </div>
    </div>

    <section class="versions" aria-labelledby="versions-title">
      <h2 id="versions-title">${versions.length > 1 ? `Versions (${versions.length})` : 'Version'}</h2>
      <ul class="version-list">${versions.map((v) => versionRow(v, v.id === version.id)).join('')}</ul>
    </section>

    ${inTheBox.length ? `<h2 id="box-title">In the box</h2>
    <ul class="box-items" aria-labelledby="box-title">${inTheBox.map((it) => `
      <li><a class="item" href="${esc(it.url)}" target="_blank" rel="noopener" title="${esc(it.name)} (${esc(it.ext.toUpperCase())})">${iconSvg(itemKind(it.ext))}<span>${esc(it.name)}</span></a></li>`).join('')}
    </ul>` : ''}

    ${media.videos.length ? `<h2>${media.videos.length > 1 ? `Videos (${media.videos.length})` : 'Video'}</h2>
    <div class="room-videos">${media.videos.map((url, i) => `<video class="room-video" src="${esc(url)}" controls playsinline preload="${i ? 'metadata' : 'auto'}"></video>`).join('')}</div>` : ''}

    ${media.shots.length ? `<h2>Screenshots</h2>
    <div class="shots">${media.shots.map((s, i) => `
      <button type="button" data-full="${esc(s.url)}" data-label="${esc(s.label)}" aria-label="Enlarge screenshot ${i + 1}"><img src="${esc(s.url)}" alt="" loading="lazy"></button>`).join('')}
    </div>` : ''}

    ${media.gallery.length ? `<h2>Box, disc and fan art</h2>
    <div class="gallery-strip">${media.gallery.map((g) => `
      <button type="button" data-full="${esc(g.url)}" data-label="${esc(g.label)}" aria-label="Enlarge ${esc(g.label)}"><img src="${esc(g.url)}" alt="${esc(g.label)}" loading="lazy"></button>`).join('')}
    </div>` : ''}
  </div>
</article>

<div id="lightbox" class="lightbox" hidden>
  <div class="lightbox-bar">
    <p class="lightbox-count" aria-live="polite"></p>
    <button class="lightbox-nav lightbox-prev" type="button" aria-label="Previous">‹<span class="lightbox-nav-word">Previous</span></button>
    <button class="lightbox-nav lightbox-next" type="button" aria-label="Next"><span class="lightbox-nav-word">Next</span>›</button>
    <button class="lightbox-close" type="button">Close</button>
  </div>
  <div class="lightbox-stage"></div>
</div>

<script src="page.js"></script>
</body>
</html>
`;
}

/**
 * The versions in the order the app's page shows them: by the kind ranking, then the bigger
 * release of the same game, then as they came. (The same rule as rankVersions in
 * public/js/settings.js, which can't be reached from here.)
 */
function rankVersions(versions, order = []) {
  const rank = (v) => {
    const i = order.indexOf(v.kind?.key);
    return i === -1 ? order.length : i;
  };
  const baseId = (v) => (v.gameId ?? '').split(':').pop().replace(/_enh$/, '');
  const index = new Map(versions.map((v, i) => [v, i]));
  return [...versions].sort((a, b) => rank(a) - rank(b)
    || (baseId(a) && baseId(a) === baseId(b) ? (b.totalBytes ?? 0) - (a.totalBytes ?? 0) : 0)
    || index.get(a) - index.get(b));
}

/**
 * Version names without the part they all share: "CD DOS", "Amiga" rather than
 * "Loom (CD DOS VGA)", "Loom (Amiga)". (The same rule as shortNames in public/js/room.js.)
 */
function shortNames(versions) {
  // eXo isn't consistent about case ("Day Of the Tentacle" / "Day Of The Tentacle").
  const prefixOf = (label) => {
    const i = label.indexOf(' (');
    return i === -1 ? null : label.slice(0, i).toLowerCase();
  };
  const prefix = prefixOf(versions[0]?.label ?? '');
  const shared = versions.length > 1 && prefix && versions.every((v) => prefixOf(v.label) === prefix);
  return new Map(versions.map((v) => {
    if (!shared) return [v, v.label];
    const rest = v.label.slice(prefix.length).trim();
    // "(CD DOS, Windows), DOS": one folder split by platform; the kind says it better.
    if (/^\([^()]*,[^()]*\),\s*\S/.test(rest) && v.kind?.key) return [v, v.kind.key];
    return [v, rest.replace(/\)\s*,\s*/g, ', ').replace(/[()]/g, '').trim()];
  }));
}

/** "CD DOS release, 480 MB of game data, runs in DOSBox", as on the app's own page. */
function versionMeta(version, context, name) {
  // "Other" is the kind of a release nothing is known about, and a kind that only repeats the
  // name says nothing either.
  const key = version.kind?.key;
  const kind = key && key !== name && key !== 'Other' ? key : null;
  const here = version.id === context.version.id;
  return [
    kind && `${kind} release`,
    here && context.stats?.totalBytes > 0 && `${formatBytes(context.stats.totalBytes)} of game data`,
    here && context.plan?.engineName && `runs in ${context.plan.engineName}`,
  ].filter(Boolean).join(', ');
}

/** What the player page is told to start, written next to it. */
function launchJs(context) {
  const { game, version, plan, parts, pageFile } = context;
  const launch = {
    title: game.title,
    version: version.label,
    engine: plan.engine,
    engineName: plan.engineName,
    saveKey: version.id,
    pageUrl: `../${pageFile}`,
    payload: parts.map((p) => p.name),
    payloadBytes: plan.payload.reduce((n, item) => n + item.size, 0),
    styles: plan.styles,
    scripts: plan.load,
    ...(plan.engine === 'dosbox' && { dos: plan.launch }),
    ...(plan.engine === 'emulatorjs' && { emu: plan.launch }),
    ...(plan.engine === 'scummvm' && { scummvm: plan.launch }),
    ...(plan.engine === 'mame' && { mame: plan.launch }),
  };
  return `window.RGB_LAUNCH = ${JSON.stringify(launch, null, 1)};\n`;
}

function readme(context, plan) {
  const { game, version } = context;
  return [
    `${game.title} — ${version.label}`,
    '',
    'To play, open the .html file in this folder with a web browser.',
    '',
    'Everything the game needs is in here: the game page, its pictures and videos, and a',
    `browser build of ${plan.engineName}. Nothing is downloaded and no server is needed, so the`,
    'folder works with no internet at all. Keep the files together — the player reads the',
    'player folder next to the page.',
    '',
    'Unzip it first. Opening the page from inside the zip will not work.',
    '',
    'Chrome, Edge and Firefox all run it. Saved games are kept by the browser you play in,',
    'not in this folder, so playing the same download in another browser starts over.',
    '',
    'The game files themselves are unchanged; only the page around them was made here.',
    `Packed by RetroGameBrowser on ${new Date().toISOString().slice(0, 10)}.`,
    '',
    ENGINE_LICENSES[plan.engine] ?? '',
    'The Inter and Google Sans typefaces in fonts/ are under the SIL Open Font License 1.1',
    '(fonts/OFL.txt).',
  ].join('\n');
}

// What the engine in a download is licensed under, and where its source is, for the README.
const ENGINE_LICENSES = {
  scummvm: 'The player is ScummVM, free software under the GNU GPL v3 (source: https://github.com/scummvm/scummvm).',
  dosbox: 'The player is js-dos (DOSBox and DOSBox-X), free software under the GNU GPL v2\n(source: https://github.com/caiiiycuk/js-dos).',
  emulatorjs: 'The player is EmulatorJS, free software under the GNU GPL v3 (source:\nhttps://github.com/EmulatorJS/EmulatorJS), with a RetroArch core that has its own licence\n(license.txt inside the core file in player/).',
  mame: 'The player is MAME 0.244, free software under the GNU GPL v2 (source:\nhttps://github.com/mamedev/mame, tag mame0244, built with the patches at\nhttps://github.com/jeffreyhockema/mame-wasm-build; its notice is player/MAME-COPYING.txt).',
};
