import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http, { STATUS_CODES } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import express from 'express';
import config, { projectRoot, configFile, loadLocal } from './config.js';
import { userdataDir, logsDir, installed } from './lib/datadir.js';
import { checkLaunchBox } from './setup.js';
import { serverLog } from './lib/logfile.js';
import { PathResolver } from './lib/paths.js';
import { Library, folderExtras, coverType } from './lib/library.js';
import { snapWidth, thumbnail, trimThumbs } from './lib/thumbs.js';
import { readScummvmId } from './lib/scummvm.js';
import { WebPlay, serveTree, listingFor, knownIssueFor, ENGINE_NAMES } from './lib/webplay.js';
import { RomCache, storedZip, storedZipSize, holdCacheDir } from './lib/romcache.js';
import { DiskPool, RANGE_BYTES } from './lib/vhd.js';
import { readSystemDisk } from './lib/win9x.js';
import { BIOS_FILES, CORES } from './lib/emulatorjs.js';
import { mameControls, mameNetplayMode } from './lib/mame.js';
import { openZipEntry } from './lib/dosbox.js';
import { SettingsStore, PlayStore, ServerSettings, mergePlays, defaultSettings, parseLayouts, shelfFlags, writeJson } from './lib/settings.js';
import { completeOrder } from './lib/versionkind.js';
import { writeStandalone, downloadName, standaloneBytes, mediaBytes } from './lib/standalone.js';
import { Auth, isLocalNetwork, isThisPc } from './lib/auth.js';
import { Accounts } from './lib/accounts.js';
import { LocalUsers, localEmail, localUsername, usernameProblem, passwordProblem } from './lib/localusers.js';
import { ActivityLog, clientOf, whoFor, summarize, filterEvents, TYPES as ACTIVITY_TYPES, WHO } from './lib/activity.js';
import { LivePlays } from './lib/playing.js';
import { gameFiles, writeFolderZip } from './lib/gamefiles.js';
import { skipInBundle } from './lib/win3x.js';
import { hostChecker } from './lib/hosts.js';
import { rateLimit, Counter, clientKey } from './lib/ratelimit.js';
import { NetplayRooms } from './lib/netplay.js';
import { NetplayLog } from './lib/netplaylog.js';
import { IpxSignaling, MAX_MESSAGE_BYTES as MAX_IPX_MESSAGE } from './lib/ipx.js';
import { buildInfo, recentBuild } from './lib/build.js';
import { ROOM_COOKIE, mayPlay, roomGuards, sameOrigin, fromThisApp, ownerOnly } from './lib/access.js';
import { lowerEmail } from './lib/util.js';

const MB = 1024 * 1024;
const resolver = new PathResolver(config.launchboxRoot, config.fallbackRoots);
const library = new Library(config, resolver);
const scummvmIds = new Map();
const vendorDir = path.join(projectRoot, 'vendor', 'scummvm-web');
const jsdosDir = path.join(projectRoot, 'node_modules', 'js-dos', 'dist');
const emulatorDir = path.join(projectRoot, 'vendor', 'emulatorjs');
const mameDir = path.join(projectRoot, 'vendor', 'mame');
// CD archives unpacked once with LaunchBox's 7-Zip, into our own cache (never into LaunchBox).
const romCache = new RomCache({
  dir: path.join(config.cacheDir, 'roms'),
  // A 7-Zip of its own (an absolute path in the config), or LaunchBox's.
  sevenZip: !config.sevenZipPath ? null : path.isAbsolute(config.sevenZipPath) ? config.sevenZipPath : resolver.resolve(config.sevenZipPath),
  maxBytes: config.romCacheMB * MB,
});
const webPlay = new WebPlay(library, resolver, {
  scummvmDir: vendorDir,
  jsdosDir,
  emulatorDir,
  mameDir,
  maxMameBytes: config.mameMaxGameMB * MB,
  maxZipBytes: config.dosMaxBundleMB * MB,
  maxWin3xBytes: config.win3xMaxBundleMB * MB,
  maxWin9xBytes: config.win9xMaxBundleMB * MB,
  maxRomBytes: config.emulatorMaxRomMB * MB,
  indexFile: path.join(config.cacheDir, 'dos-launchers.json'),
  dosBackend: config.dosBackend,
  romCache,
  unpackMinBytes: config.romUnpackMinMB * MB,
});
const settingsStore = new SettingsStore(path.join(userdataDir, 'settings.json'));
// Games played here. LaunchBox's own play history is read-only, so these are kept apart.
const playStore = new PlayStore(path.join(userdataDir, 'plays.json'));
// Accounts with a username and password kept here, for a server without Google sign-in, which
// the owner turns on on the admin page (see lib/localusers.js).
const localUsers = new LocalUsers(path.join(userdataDir, 'local-users.json'));
await localUsers.load();
// The owner's local account counts as the owner only on a server whose config names no owner.
const localOwnerEmail = () => (!config.auth?.owner && localUsers.owner() ? localEmail(localUsers.owner()) : null);
// The accounts that have signed in, and what the owner lets each do (see lib/accounts.js).
const accounts = new Accounts({ file: path.join(userdataDir, 'accounts.json'), owner: config.auth?.owner, players: config.auth?.players ?? [], localOwner: localOwnerEmail });
await accounts.load();
{
  // What was set for a local account that isn't there any more (deleted while the file couldn't
  // be saved, say) is forgotten: otherwise whoever made an account with that username next would
  // get it.
  const orphans = accounts.list().filter((a) => localUsername(a.email) && !localUsers.has(localUsername(a.email)) && a.access !== 'owner');
  for (const a of orphans) await accounts.remove(a.email);
  if (orphans.length) console.log(`Forgot the access of ${orphans.length} local account(s) that no longer exist.`);
  // A local account named in the config (owner or players) that hasn't been made is held back
  // from signing up (see reservedUsername), so a stranger can't take it.
  for (const email of [config.auth?.owner, ...(config.auth?.players ?? [])]) {
    const name = localUsername(email);
    if (name && !localUsers.has(name)) console.warn(`The config names ${email}, a local account that hasn't been made: make it on the admin page (nobody can sign up with that username meanwhile).`);
  }
}
// Accounts and what each may do (see lib/auth.js): Google's, with a client ID in the config, and
// local ones while the owner has them on. With neither there are none, and everyone is the
// owner: the settings and plays above are theirs. (serverSettings is read only once requests come.)
const auth = new Auth({ settings: config.auth, file: path.join(userdataDir, 'sessions.json'), accounts, localUsers, localLogins: () => serverSettings.get().localLogins });
// What people do here, for the owner's admin page (see lib/activity.js).
const activity = new ActivityLog({ dir: path.join(userdataDir, 'activity'), keepMonths: config.activity.keepMonths });
// The games being played right now, whose time goes in the activity log as each ends (see lib/playing.js).
const livePlays = new LivePlays({ onEnd: (play, how) => activity.record({ ...play, type: 'stop', how }) });
setInterval(() => livePlays.sweep(), 30_000).unref();
// The server's own settings, which the owner changes on the admin page: whether guests may play.
// Read before the server answers anything, since every request's permissions depend on it.
const serverSettings = new ServerSettings(path.join(userdataDir, 'server.json'));
await serverSettings.load();
// Console games being played with a friend through EmulatorJS's netplay (see lib/netplay.js).
// Each session's numbers, a file per game in userdata/netplay-logs/ (see lib/netplaylog.js).
const netplayLog = new NetplayLog({ dir: path.join(userdataDir, 'netplay-logs'), keep: config.netplay.keepLogs });
const netplay = new NetplayRooms({
  maxRooms: config.netplay?.maxRooms, iceServers: config.netplay?.iceServers ?? [], log: netplayLog,
  // An IPX room's players are on the signalling socket, which NetplayRooms doesn't hold: however
  // the room ends (the admin page, its account blocked, nobody opening it), those sockets go too.
  onClose: (room) => { if (room.mode === 'ipx') ipx.closeRoom(room.code); },
});
// DOS games played with a friend over IPX (see lib/ipx.js). Nothing but the introduction goes
// through here: once two emulators have found each other the game's traffic is theirs alone.
const ipx = new IpxSignaling({ rooms: netplay, maxPeersPerRoom: config.netplay.maxIpxPeers, onLog: (message) => console.log(message) });
// A friend's room code in a cookie lets them fetch that game's files (see lib/access.js).
const { roomGrant, roomVersion, mayPlayVersion, mayPlayShared } = roomGuards(netplay);
// Which build this is (see lib/build.js): shown on the pages, and checked file by file by
// the multiplayer stats page, so a cache between a browser and this PC can't hide an old copy.
const build = buildInfo(projectRoot);
console.log(`Build ${build.build}`);
// The app's own files are never to be kept by a CDN in front of this server (Cloudflare's
// tunnel, say): the browser revalidates them on every load, and the edge must let it.
const noCdnCache = (res) => res.set({ 'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store' });

// First-run settings for the browser build. It keeps its own copy (with saves) in the
// browser's IndexedDB afterwards, so this only applies to a fresh browser profile.
const WEB_INI = '[scummvm]\ngui_theme=scummremastered\naspect_ratio=true\nfiltering=false\n';

const app = express();
app.disable('x-powered-by');

// For every answer: no other site may show this app's pages in a frame (and so trick a click
// on Sign out or Download through a page laid over them), a file is only ever taken for the
// type the server says it is, and other sites are told where a link came from but not the path.
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': 'frame-ancestors \'self\'',
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  next();
});
// A tunnel on this PC (Cloudflare's, say) passes requests on from localhost and says in
// X-Forwarded-Proto whether they came in over HTTPS, which decides whether cookies are Secure.
app.set('trust proxy', 'loopback');

// Reject requests addressed to a host name this server doesn't go by, however it's bound
// (guards against DNS-rebinding pages talking to the server; see lib/hosts.js). A tunnel's
// public name, or another name the network knows this PC by, goes in config.allowedHosts.
const knownHost = hostChecker(config.allowedHosts ?? []);
app.use((req, res, next) => {
  if (knownHost(req.headers.host)) return next();
  res.status(403).type('text/plain').send('Unknown host name. Add it to allowedHosts in config.local.json.');
});

// The ScummVM web build asks for some files with a doubled slash ("//data/plugins/x.so").
app.use((req, res, next) => {
  if (req.url.startsWith('//')) req.url = req.url.replace(/^\/+/, '/');
  next();
});

// The API and the games' files answer this app's own pages, not another site's. On the local
// network playing needs no sign-in, only the address, so without this any web page someone on
// the network opens could have the server unpack and pack games (an <img> pointed at a prepare
// or download address) without them knowing. Browsers say where a request came from in
// Sec-Fetch-Site; one with none (an older browser, an address typed in, another app) is let
// through. The pages themselves (the shelf, a game's page, a friend's /join link) aren't under
// these paths, so a link to them from another site still works.
const API_PATHS = /^\/(api|data|downloads|emu)\//;
app.use((req, res, next) => {
  if (req.headers['sec-fetch-site'] === 'cross-site' && API_PATHS.test(req.path)) {
    return res.status(403).json({ error: 'Not from another site.' });
  }
  next();
});

// Who's asking, and what they may do (see lib/auth.js).
app.use(async (req, res, next) => {
  try {
    const onNetwork = isLocalNetwork(req);
    req.user = await auth.userFor(req, { internet: !onNetwork });
    req.local = Boolean(config.localNetworkCanPlay) && onNetwork;
    req.internet = !onNetwork;
    req.thisPc = isThisPc(req);
    req.can = auth.permissionsFor(req.user, { local: req.local, internet: req.internet, thisPc: req.thisPc, guestsCanPlay: serverSettings.guestsCanPlay });
    if (req.user) accounts.seen(req.user);
    next();
  } catch (err) {
    next(err);
  }
});

// Who may have a game (mayPlay, and a friend's room code: mayPlayVersion, mayPlayShared) is
// decided in lib/access.js.

/**
 * sendFile's callback. An error before anything went out is answered as usual; one partway
 * through (a network share dropping, say) ends the connection, so the browser sees the file
 * end short instead of waiting for the rest forever.
 */
const fileSent = (res, next) => (err) => {
  if (!err) return;
  if (!res.headersSent) return next(err);
  if (!res.writableEnded) res.destroy();
};

// Files from the collection's own folders, which can hold readme pages and pictures with script
// in them: never let those run on this origin. The emulators fetch them, which this doesn't affect.
const sandboxed = (req, res, next) => {
  res.set('Content-Security-Policy', 'sandbox; frame-ancestors \'self\'');
  next();
};

// The app's own pages, styles and scripts change as it's worked on, and Safari on a phone would
// otherwise keep showing an old copy: "no-cache" has the browser ask every time, and the ETag
// lets the server answer "unchanged" without sending the file again.
//
// Its pages also say what they may load and run (a Content Security Policy): what a script put
// in the page some other way (a game's description, say, that got past the escaping) can't do.
//
// The app itself runs only its own scripts, and Google's for signing in. Styles may be written
// into the page (Google's button does, and so does one measurement here), which can't run code.
const APP_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' data: blob: https://*.googleusercontent.com", // a Google account's picture
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' https://accounts.google.com/gsi/",
  "frame-src 'self' https://accounts.google.com/gsi/",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');
// The player pages start an emulator, which needs rather more: their own inline start-up
// scripts, WebAssembly, the eval the emulators' Emscripten builds use, and workers and files made
// in the page (blob:). They still load nothing from anywhere but this server. The inline scripts
// are allowed by their hashes, worked out from each page (see playerPolicy), not as "any inline
// script": the pages are on the app's own origin, so script slipped into one would be as good
// as the app's.
const PLAYER_POLICY = [
  "default-src 'self'",
  "script-src 'self' INLINE 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');
// The pages that don't start an emulator, which get the app's policy wherever they're opened
// from. The join and multiplayer stats pages show names other people chose.
const APP_PAGES = new Set(['index.html', 'admin.html', 'join.html', 'netplay-stats.html']);
const policyFor = (file) => (!/\.html$/i.test(file) ? null : APP_PAGES.has(path.basename(file)) ? APP_POLICY : playerPolicy(file));

/**
 * A player page's policy: PLAYER_POLICY with that page's own inline scripts and event handlers
 * allowed by their sha-256 (the handlers through 'unsafe-hashes', which allows those exact
 * handlers and no others). Worked out from the file, and again when it changes.
 */
const playerPolicies = new Map(); // file -> { mtimeMs, policy }
function playerPolicy(file) {
  let stat;
  try {
    stat = fsSync.statSync(file);
  } catch {
    return PLAYER_POLICY.replace('INLINE ', '');
  }
  const kept = playerPolicies.get(file);
  if (kept?.mtimeMs === stat.mtimeMs) return kept.policy;
  const html = fsSync.readFileSync(file, 'utf8');
  const hash = (text) => `'sha256-${crypto.createHash('sha256').update(text).digest('base64')}'`;
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => hash(m[1]));
  const handlers = [...html.matchAll(/\son[a-z]+="([^"]*)"/gi)].map((m) => hash(m[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&')));
  const inline = [...new Set([...scripts, ...handlers])];
  const policy = PLAYER_POLICY.replace('INLINE', [...inline, ...(handlers.length ? ["'unsafe-hashes'"] : [])].join(' '));
  playerPolicies.set(file, { mtimeMs: stat.mtimeMs, policy });
  return policy;
}

const APP_FILES = {
  cacheControl: false,
  setHeaders: (res, file) => {
    res.set('Cache-Control', 'no-cache');
    noCdnCache(res);
    const policy = policyFor(file);
    if (policy) res.set('Content-Security-Policy', policy);
  },
};
app.use(express.static(path.join(projectRoot, 'public'), APP_FILES));

// ---------- Browser build of ScummVM ----------

app.get(['/scummvm.js', '/scummvm.wasm'], (req, res, next) => {
  if (!webPlay.engineAvailable('scummvm')) return res.status(404).send('ScummVM web build not installed. Run: npm run fetch-scummvm');
  res.sendFile(path.join(vendorDir, req.path.slice(1)), { headers: { 'Cache-Control': 'no-cache' } }, (err) => err && next(err));
});

app.get('/scummvm.ini', (req, res) => res.type('text/plain').send(WEB_INI));

// The eXo root is worked out from every version, so it's kept until the game lists change (see
// untilListsChange). The folder itself is looked for each time, as WebPlay's MT-32 listing is, so
// a share that was down at that moment doesn't take MT-32 away until the next change.
const mt32Root = untilListsChange(() => webPlay.allVersions()[0]?.exoRoot ?? 'eXo');
const mt32Dir = () => resolveReadable(path.join(mt32Root(), 'mt32'));

/** MT-32/CM-32L ROM files in `dir` (see mt32Dir). The MT-32 emulator only finds them by bare name at the top of /data. */
async function mt32Roms(dir) {
  if (!dir) return {};
  // MT-32 is optional: a folder that can't be listed (a share that went away) means no ROMs, not
  // a ScummVM that can't start.
  const listing = await listingFor(dir).catch(() => ({}));
  return Object.fromEntries(Object.entries(listing).filter(([name, size]) => typeof size === 'number' && /\.rom$/i.test(name)));
}

// The web build's HTTP filesystem root: its own engine data plus our games and MT-32 files.
app.get('/data/index.json', async (req, res, next) => {
  try {
    const base = webPlay.engineAvailable('scummvm') ? await listingFor(path.join(vendorDir, 'data')) : {};
    res.set('Cache-Control', 'no-cache').json({ ...base, ...(await mt32Roms(await mt32Dir())), games: {}, mt32: {} });
  } catch (err) {
    next(err);
  }
});

// The name is the route's capture, which the router decodes (a bad escape is its 400, not a thrown error here).
app.get(/^\/data\/([^/]+\.rom)$/i, mayPlay, sandboxed, async (req, res, next) => {
  try {
    const name = req.params[0];
    // Looked for once, so the folder can't go away between the two checks.
    const dir = await mt32Dir();
    if (!dir || !Object.hasOwn(await mt32Roms(dir), name) || !(await serveTree(res, dir, [name]))) res.status(404).json({ error: 'Not found' });
  } catch (err) {
    next(err);
  }
});

// The router decodes a route's capture first, so a bad escape is its 400 and never gets this far.
const dataSegments = (req, skip) => req.path.split('/').filter(Boolean).slice(skip).map(decodeURIComponent);

app.get(/^\/data\/games(\/.*)?$/, mayPlay, sandboxed, async (req, res, next) => {
  try {
    const [versionId, ...rest] = dataSegments(req, 2);
    if (!versionId || (versionId === 'index.json' && !rest.length)) {
      return res.set('Cache-Control', 'no-cache').json(Object.fromEntries(webPlay.allVersions().filter((v) => v.engine === 'scummvm' && versionFor(req, v.id)).map((v) => [v.id, {}])));
    }
    const version = versionFor(req, versionId);
    if (version?.engine !== 'scummvm' || !(await serveTree(res, version.dir, rest))) res.status(404).json({ error: 'Not found' });
  } catch (err) {
    next(err);
  }
});

// A DOS game with MT-32 or soundfont music asks for these, a friend's game too (see mayPlayShared).
app.get(/^\/data\/mt32(\/.*)?$/, mayPlayShared, sandboxed, async (req, res, next) => {
  try {
    const dir = await mt32Dir();
    if (!dir || !(await serveTree(res, dir, dataSegments(req, 2)))) res.status(404).json({ error: 'Not found' });
  } catch (err) {
    next(err);
  }
});

// ---------- Browser build of DOSBox (js-dos) ----------

// The player library, its engine files and the wasm builds, straight from the npm package.
app.use('/js-dos', express.static(jsdosDir, { index: false, maxAge: '1d' }));

// A DOS game's data is its eXoDOS zip, loaded whole by the player page. A Windows 3.x game
// is an installed folder instead, sent as an uncompressed zip of the server's own copy (made
// by /api/dos/:versionId/prepare, which the page waits for).
app.get('/data/dos/:versionId/game.zip', mayPlayVersion, async (req, res, next) => {
  const version = versionFor(req, req.params.versionId);
  if (version?.engine !== 'dosbox') return res.status(404).json({ error: 'Not found' });
  try {
    if (version.win9x) {
      // A Windows 9x game's CD images and zips, from the server's unpacked copy of its zip; its
      // hard disk is read separately (see the disk routes below).
      const bundle = await webPlay.win9xBundle(version, { onlyIfReady: true });
      if (!bundle) return res.status(404).json({ error: 'Not found' });
      res.set({ 'Content-Type': 'application/zip', 'Content-Length': String(bundle.zipSize), 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      await storedZip(bundle, res);
      return res.end();
    }
    if (version.win3x) {
      const bundle = await webPlay.win3xBundle(version);
      if (!bundle) return res.status(404).json({ error: 'Not found' });
      res.set({ 'Content-Type': 'application/zip', 'Content-Length': String(bundle.zipSize), 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      await storedZip(bundle, res);
      return res.end();
    }
    if (!version.zipAbs) return res.status(404).json({ error: 'Not found' });
    res.sendFile(version.zipAbs, { acceptRanges: true, dotfiles: 'allow', headers: { 'Cache-Control': 'private, max-age=86400', 'Content-Type': 'application/zip' } },
      fileSent(res, next));
  } catch (err) {
    // A client that goes away mid-transfer isn't an error worth logging.
    if (res.destroyed) return;
    next(err);
  }
});

// A Windows 9x game's hard disks, read by the emulator a piece at a time (js-dos "sockdrives",
// see lib/vhd.js and lib/win9x.js): eXo's Windows disk, the same for every game, and the game's
// own disk from the server's unpacked copy of its zip. Each disk is a folder of
// sockdrive.metaj (what the disk is), preload_ranges.metaj and <n>.raw (its pieces). The URLs
// carry a stamp of the file, so they change with it; the browser keeps the pieces it's read
// in its own storage, so the answers themselves aren't cached. Pieces are compressed on the
// way (most of a disk compresses well), which matters through a tunnel.
const disks = new DiskPool();
const diskBrotli = promisify(zlib.brotliCompress);
const diskGzip = promisify(zlib.gzip);
const compressedInfo = new WeakMap(); // sockdrive description -> { br, gzip } of its JSON

async function sendDiskFile(req, res, disk, file) {
  const encodings = String(req.headers['accept-encoding'] ?? '');
  const encoding = /\bbr\b/.test(encodings) ? 'br' : /\bgzip\b/.test(encodings) ? 'gzip' : null;
  const compress = (data) => (encoding === 'br'
    ? diskBrotli(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } })
    : diskGzip(data, { level: 3 }));
  const send = (type, body) => {
    res.set({ 'Content-Type': type, 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' });
    if (encoding) res.set('Content-Encoding', encoding);
    res.end(body);
  };
  const { vhd, info } = await disks.open(disk.abs, { stamp: disk.stamp, hold: disk.dir ? () => holdCacheDir(disk.dir) : null });
  if (file === 'sockdrive.metaj') {
    const json = Buffer.from(JSON.stringify(info));
    if (!encoding) return send('application/json', json);
    let cached = compressedInfo.get(info);
    if (!cached) compressedInfo.set(info, (cached = {}));
    cached[encoding] ??= await compress(json);
    return send('application/json', cached[encoding]);
  }
  // Which pieces to fetch ahead of need: none, so a boot reads only what it uses.
  if (file === 'preload_ranges.metaj') return res.set('Cache-Control', 'no-store').json([]);
  const m = /^(\d{1,7})\.raw$/.exec(file);
  const range = m ? Number(m[1]) : -1;
  if (range < 0 || range >= info.range_count) return res.status(404).json({ error: 'Not found' });
  // eXo's Windows disk has its screen resolution fitted to what the browser can show (see win9x.js).
  const data = disk.system ? await readSystemDisk(vhd, range * RANGE_BYTES, RANGE_BYTES) : await vhd.read(range * RANGE_BYTES, RANGE_BYTES);
  return send('application/octet-stream', encoding ? await compress(data) : data);
}

app.get('/data/disk/system/:stamp/:file', mayPlay, async (req, res, next) => {
  try {
    const disk = /^[0-9a-f]{16}$/.test(req.params.stamp) ? await webPlay.systemDisk(req.params.stamp) : null;
    if (!disk) return res.status(404).json({ error: 'Not found' });
    await sendDiskFile(req, res, disk, req.params.file);
  } catch (err) {
    if (res.destroyed) return;
    next(err);
  }
});

app.get('/data/disk/game/:versionId/:stamp/:file', mayPlay, async (req, res, next) => {
  try {
    const disk = await webPlay.gameDisk(versionFor(req, req.params.versionId), req.params.stamp);
    if (!disk) return res.status(404).json({ error: 'Not found' });
    await sendDiskFile(req, res, disk, req.params.file);
  } catch (err) {
    if (res.destroyed) return;
    next(err);
  }
});

// ---------- Browser build of RetroArch cores (EmulatorJS) ----------

// EmulatorJS itself and the cores, fetched by `npm run fetch-emulators`.
app.use('/emu/data', express.static(path.join(emulatorDir, 'data'), { index: false, maxAge: '1d' }));

// BIOS files, under the bare names the cores look for (see emulatorjs.js). The player page
// is /emu/play.html, so a BIOS URL of "neogeo.zip" comes here.
app.get('/emu/:file', (req, res, next) => {
  const abs = Object.hasOwn(BIOS_FILES, req.params.file) ? webPlay.biosPath(req.params.file) : null;
  if (!abs) return next();
  // A friend invited to a game gets the BIOS files of that game's console, and no others.
  if (!req.can.play) {
    const version = webPlay.version(String(roomVersion(req) ?? ''));
    if (!version || !Object.values(CORES[version.platform]?.bios ?? {}).includes(req.params.file)) return mayPlay(req, res, next);
  }
  res.sendFile(abs, { dotfiles: 'allow', headers: { 'Cache-Control': 'private, max-age=86400', 'Content-Type': 'application/octet-stream' } },
    fileSent(res, next));
});

/**
 * The files of one disc of a multi-disc release, with its cue sheet named after the release
 * ("Final Fantasy VII (USA).cue" on every disc). The emulator names the memory card after the
 * file it starts, so all the discs share one card and a save made on disc 1 is there on disc 2.
 * The cue sheet still names its tracks by their own file names, which don't change.
 */
function withDiscSetName(unpacked, discSet) {
  const cues = unpacked.files.filter((f) => /\.cue$/i.test(f.name));
  if (!discSet || cues.length !== 1) return unpacked;
  const dir = cues[0].name.includes('/') ? cues[0].name.slice(0, cues[0].name.lastIndexOf('/') + 1) : '';
  return { ...unpacked, files: unpacked.files.map((f) => (f === cues[0] ? { ...f, as: `${dir}${discSet}.cue` } : f)) };
}

// A console version's ROM. A CD archive the server unpacks is sent as a plain zip of its
// files, built on the fly from the unpacked cache (the page unpacks it first, see
// /api/emu/:versionId/prepare).
app.get('/data/rom/:versionId/:file', mayPlayVersion, async (req, res, next) => {
  const version = versionFor(req, req.params.versionId);
  if (version?.engine !== 'emulatorjs' || !version.romAbs) return res.status(404).json({ error: 'Not found' });
  try {
    // ?raw=1 asks for the archive itself, when the server couldn't unpack it.
    const unpacked = req.query.raw === '1' ? null : await webPlay.unpackedRom(version);
    if (unpacked) {
      const zip = withDiscSetName(unpacked, version.discSet);
      res.set({ 'Content-Type': 'application/zip', 'Content-Length': String(storedZipSize(zip.files)), 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      await storedZip(zip, res);
      return res.end();
    }
    res.sendFile(version.romAbs, { acceptRanges: true, dotfiles: 'allow', headers: { 'Cache-Control': 'private, max-age=86400', 'Content-Type': 'application/octet-stream' } },
      fileSent(res, next));
  } catch (err) {
    // A client that goes away mid-transfer isn't an error worth logging.
    if (res.destroyed) return;
    next(err);
  }
});

// ---------- Browser build of MAME ----------

// The MAME bundles, fetched by `npm run fetch-mame`. A bundle's .js has to match its .wasm, so
// the browser asks each time and the ETag makes that a quick "unchanged" until a new build.
app.use('/mame/engine', express.static(mameDir, { index: false, maxAge: 0 }));
app.use('/mame/engine', (req, res) => res.status(404).json({ error: 'Not found' }));

// The files a MAME version loads, by their path in MAME's folders: an arcade game's zip, the BIOS
// and device zips it needs, its disk images and samples (see mameFiles in lib/mame.js), or an
// Apple IIgs game's ROM sets and the disks read out of its zip (lib/iigs.js). Only those.
app.get('/data/mame/:versionId/*file', mayPlayVersion, async (req, res, next) => {
  const version = versionFor(req, req.params.versionId);
  const file = webPlay.mameFile(version, [].concat(req.params.file).join('/'));
  if (!file) return res.status(404).json({ error: 'Not found' });
  const headers = { 'Cache-Control': 'private, max-age=86400', 'Content-Type': 'application/octet-stream' };
  if (file.abs) return res.sendFile(file.abs, { acceptRanges: true, dotfiles: 'allow', headers }, fileSent(res, next));
  try {
    const entry = await openZipEntry(file.zip, (name) => name === file.member);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    // Only the disk itself of an image with bytes after it (see isDiskCopy in lib/iigs.js).
    const take = file.take ?? entry.size;
    async function* upTo(stream, count) {
      let left = count;
      for await (const chunk of stream) {
        if (left <= 0) break;
        const part = chunk.length > left ? chunk.subarray(0, left) : chunk;
        left -= part.length;
        yield part;
      }
      stream.destroy();
    }
    res.set({ ...headers, 'Content-Length': String(take) });
    req.on('close', () => entry.stream.destroy());
    await pipeline(upTo(entry.stream, take), res);
  } catch (err) {
    if (!res.headersSent) return next(err);
    res.destroy(err);
  }
});

// ScummVM's plugins and engine data, which have to match /scummvm.wasm (sent "no-cache"): the
// browser asks again each time, and the ETag makes that a quick "unchanged" until a rebuild.
app.use('/data', express.static(path.join(vendorDir, 'data'), { index: false, maxAge: 0 }));
app.use('/data', (req, res) => res.status(404).json({ error: 'Not found' }));

const api = express.Router();

api.use(async (req, res, next) => {
  noCdnCache(res);
  try {
    await ready; // the first load of the library (see the end of this file)
    await library.refreshIfChanged();
    await webPlay.ensureIndexed();
    next();
  } catch (err) {
    next(err);
  }
});

// A platform's own logo, for the top of its view on the shelf.
api.get('/platforms/:name/logo', (req, res, next) => {
  const platform = library.platforms.get(req.params.name);
  if (!platform) return res.status(404).json({ error: `No platform named "${req.params.name}" is loaded.` });
  sendMedia(req, res, next, platform.logoRel, { thumb: true, trim: platform.logoTrim });
});

// A platform's icon from LaunchBox's set, for its row in the sidebar: a few hundred bytes, sent as it is.
api.get('/platforms/:name/icon', (req, res, next) => {
  const platform = library.platforms.get(req.params.name);
  if (!platform) return res.status(404).json({ error: `No platform named "${req.params.name}" is loaded.` });
  sendMedia(req, res, next, platform.iconRel, { thumb: true });
});

// Every platform's games at once: the shelf shows them all and filters from there.
// The owner's copy carries LaunchBox's favorites and play history; everyone else's doesn't.
api.get('/library', async (req, res) => {
  res.set('Cache-Control', 'private, no-cache').vary('Cookie');
  await sendJson(req, res, libraryBody(audienceOf(req)));
});

api.get('/games/:id', async (req, res) => {
  const game = findGame(req, res);
  if (!game) return;
  res.json(await detail(game, req));
});

api.get('/games/:id/images/:type/:n', (req, res, next) => {
  const game = findGame(req, res);
  if (!game) return;
  const entry = game.images[req.params.type]?.[Number(req.params.n)];
  sendMedia(req, res, next, entry?.rel, { thumb: true });
});

api.get('/games/:id/videos/:n', (req, res, next) => {
  const game = findGame(req, res);
  if (!game) return;
  sendMedia(req, res, next, game.videos[Number(req.params.n)]?.rel);
});

api.get('/games/:id/manual', (req, res, next) => {
  const game = findGame(req, res);
  if (!game) return;
  sendMedia(req, res, next, game.manualRel, { document: true });
});

api.get('/games/:id/music', (req, res, next) => {
  const game = findGame(req, res);
  if (!game) return;
  sendMedia(req, res, next, game.musicRel);
});

api.get('/games/:id/extras/:extraId', async (req, res, next) => {
  const game = findGame(req, res);
  if (!game) return;
  const extra = (await gameExtras(game)).find((e) => e.id === req.params.extraId);
  sendMedia(req, res, next, extra?.rel, { document: true });
});

api.get('/games/:id/web/:versionId', mayPlay, (req, res) => {
  const game = findGame(req, res);
  if (!game) return;
  const version = webPlay.versionsFor(game).find((v) => v.id === req.params.versionId);
  if (!version) return res.status(404).json({ error: 'That version of the game wasn\'t found.' });
  res.json(webPlay.launchFor(game, version, String(req.query.sound ?? ''), { autoDetect: req.query.auto === '1' }));
});

// Offline copies packed at once. Each compresses hundreds of megabytes on the few threads the
// server also reads every file with, so more at a time would stall browsing for everyone. Anyone
// after that waits in a queue, with their page asking for a turn every few seconds (POST
// /downloads/turn) and starting the download once it has one: a download request that sent
// nothing while it waited would be given up on by the tunnel after about 100 seconds.
const MAX_DOWNLOADS = 2;
// A page that stops asking has gone (a tab in the background still asks about once a minute).
const TURN_ASKED_MS = 90_000;
// How long a turn given to a page is kept for its download to start.
const TURN_CLAIM_MS = 120_000;
// A download that has sent nothing this long (paused in the browser, say) gives its turn up, but
// only to someone waiting for one.
const TURN_STALL_MS = 10 * 60_000;
const MAX_WAITING = 50;
// turns: the downloads being packed, or about to be ({ ticket, claimBy } until one starts with res);
// waiting: ticket -> when its page last asked, in the order they came.
const downloads = { turns: new Set(), waiting: new Map() };

/** Forgets pages that stopped asking and turns never taken up, ends stalled downloads someone is waiting behind, and hands out free turns. */
function sweepTurns(now = Date.now()) {
  for (const [ticket, askedAt] of downloads.waiting) if (now - askedAt > TURN_ASKED_MS) downloads.waiting.delete(ticket);
  for (const turn of downloads.turns) {
    if (!turn.res) {
      if (now > turn.claimBy) downloads.turns.delete(turn);
      continue;
    }
    const bytes = turn.res.socket?.bytesWritten ?? turn.bytes;
    if (bytes !== turn.bytes) {
      turn.bytes = bytes;
      turn.movedAt = now;
    } else if (downloads.waiting.size && now - turn.movedAt > TURN_STALL_MS) {
      console.log('An offline download sent nothing for 10 minutes and someone was waiting: it was ended.');
      turn.res.destroy(); // its route gives the turn back as the write fails
    }
  }
  for (const [ticket] of downloads.waiting) {
    if (downloads.turns.size >= MAX_DOWNLOADS) break;
    downloads.waiting.delete(ticket);
    downloads.turns.add({ ticket, claimBy: now + TURN_CLAIM_MS, res: null });
  }
}
setInterval(sweepTurns, 5000).unref();

const heldTurn = (ticket) => [...downloads.turns].find((t) => t.ticket === ticket && !t.res);

/**
 * Starts packing a download on the turn its page waited for (`ticket`). One that comes without a
 * turn (opened again from the browser's list of downloads, say) goes ahead only when there's a
 * free one nobody is waiting for. Returns the function to call when it's done, or null.
 */
function claimTurn(ticket, res) {
  sweepTurns();
  let turn = ticket ? heldTurn(ticket) : null;
  if (!turn && downloads.turns.size < MAX_DOWNLOADS && !downloads.waiting.size) {
    turn = { ticket: null };
    downloads.turns.add(turn);
  }
  if (!turn) return null;
  Object.assign(turn, { res, bytes: res.socket?.bytesWritten ?? 0, movedAt: Date.now() });
  return () => {
    if (downloads.turns.delete(turn)) sweepTurns();
  };
}

// A page waiting to download an offline copy asks for its turn: `ticket` (none the first time)
// keeps its place in the queue. Answers the ticket, and whether it's ready or how many are ahead.
api.post('/downloads/turn', mayPlay, express.json({ limit: '1kb' }), (req, res) => {
  if (!fromThisApp(req)) return res.status(403).json({ error: 'Downloads can only be started from this app.' });
  res.set('Cache-Control', 'no-store');
  const now = Date.now();
  let ticket = typeof req.body?.ticket === 'string' ? req.body.ticket.slice(0, 64) : '';
  const held = ticket && heldTurn(ticket);
  if (held) {
    held.claimBy = now + TURN_CLAIM_MS;
    return res.json({ ticket, ready: true });
  }
  if (!downloads.waiting.has(ticket)) {
    sweepTurns(now);
    if (downloads.waiting.size >= MAX_WAITING) return res.status(503).json({ error: 'Too many downloads are waiting. Try again later.' });
    ticket = crypto.randomUUID();
  }
  downloads.waiting.set(ticket, now);
  sweepTurns(now);
  if (heldTurn(ticket)) return res.json({ ticket, ready: true });
  res.json({ ticket, ready: false, ahead: [...downloads.waiting.keys()].indexOf(ticket) });
});

/**
 * The whole game as a folder to keep: its page, its art and a browser engine that plays it
 * with nothing installed and no network (see lib/standalone.js). The zip is written as it is
 * put together, so a game of several hundred megabytes starts downloading right away.
 */
/**
 * A version's own game files, and nothing else: the ROM or zip as the collection has it, or a
 * game folder zipped on the way (see lib/gamefiles.js). A Windows game's copy is made by the
 * prepare route first, which the page waits for.
 */
api.get('/games/:id/files/:versionId', mayPlay, async (req, res, next) => {
  const game = findGame(req, res);
  if (!game) return;
  const version = webPlay.versionsFor(game).find((v) => v.id === req.params.versionId);
  const files = version && gameFiles(game, version, await webPlay.statsFor(version));
  if (!files) return res.status(404).json({ error: 'That version\'s files weren\'t found.' });
  logDownload(req, res, game, version, 'files');
  res.attachment(files.name);
  res.set('Cache-Control', 'no-store');
  if (files.how === 'file') {
    // Sent as a file, so a download that breaks off can pick up where it stopped.
    return res.sendFile(files.abs, { dotfiles: 'allow', acceptRanges: true }, (err) => {
      if (!err) return;
      if (!res.headersSent) {
        res.removeHeader('Content-Disposition');
        return next(err);
      }
      // Partway through (see fileSent): ended, so the browser can pick it up again.
      if (!res.writableEnded) res.destroy();
    });
  }
  try {
    // A Windows 3.x game too big for the browser has no copy in the cache (see win3xBundles), so its
    // installed folder is zipped on the way instead, without the swap files its listed size leaves out.
    const bundle = files.how === 'bundle' ? await webPlay.win3xBundle(version) : null;
    if (bundle) {
      res.set('Content-Length', String(storedZipSize(bundle.files)));
      await storedZip(bundle, res);
    } else if (files.how === 'bundle') {
      await writeFolderZip(version.dataAbs, version.gameDir, res, skipInBundle);
    } else {
      await writeFolderZip(files.dir, path.basename(files.name, '.zip'), res);
    }
    res.end();
  } catch (err) {
    if (res.destroyed) return;
    if (!res.headersSent) {
      res.removeHeader('Content-Disposition');
      return next(err);
    }
    // Once the zip has started there's no way to say so; the download ends short.
    console.error(`Sending the files of "${game.title}" failed: ${err.message}`);
    res.destroy();
  }
});

api.get('/games/:id/standalone/:versionId', mayPlay, async (req, res, next) => {
  const game = findGame(req, res);
  if (!game) return;
  const versions = webPlay.versionsFor(game);
  const version = versions.find((v) => v.id === req.params.versionId);
  if (!version) return res.status(404).json({ error: 'That version of the game wasn\'t found.' });
  if (version.win9x) return res.status(400).json({ error: 'Windows 95 and 98 games can\'t be packed to play offline: they start from eXo\'s Windows disk on the server.' });
  const context = {
    game,
    version,
    sound: String(req.query.sound ?? ''),
    // Players 1-4's controller layouts in a console game, from the downloader's settings.
    controllerLayouts: parseLayouts(req.query.layouts),
    extras: await gameExtras(game),
    scummvmId: await scummvmIdOf(game, versions),
    // A snapshot of how much the game had been played when it was packed, as the page shows it.
    plays: await playsFor(req, game),
    stats: await webPlay.statsFor(version),
    // Everything the page's versions table needs, ranked and named there the way the app
    // ranks and names them (see lib/standalone.js).
    versionOrder: versionOrder(),
    allVersions: await Promise.all(versions.map(async (v) => ({
      id: v.id,
      label: v.label,
      kind: v.kind,
      gameId: v.gameId ?? null,
      totalBytes: (await webPlay.statsFor(v)).totalBytes,
      note: v.note ?? null,
      howToPlay: v.howToPlay ?? null,
      knownIssue: knownIssueFor(v),
    }))),
    webPlay,
    resolver,
    dirs: { projectRoot, scummvmDir: vendorDir, jsdosDir, emulatorDir, mameDir },
  };
  const done = claimTurn(String(req.query.turn ?? ''), res);
  if (!done) return res.status(503).json({ error: 'Other offline copies are being packed. Start this one from the game\'s page, which waits for its turn.' });
  // res.attachment() writes the name the way the standard asks (an escaped filename* with a
  // plain-ASCII filename beside it for older browsers) and sets the zip content type with it.
  // Every download's name has brackets in it ("… (offline).zip"), which an encodeURIComponent
  // of our own would leave as they are, where they aren't allowed.
  res.attachment(downloadName(game, version));
  res.set('Cache-Control', 'no-store');
  logDownload(req, res, game, version, 'offline');
  try {
    await writeStandalone(context, res);
    res.end();
  } catch (err) {
    // Once the zip has started there is no way to say so in the response; the download simply
    // ends short, and the browser reports it as failed.
    if (res.destroyed) return;
    if (!res.headersSent) {
      res.removeHeader('Content-Disposition');
      return err.status ? res.status(err.status).json({ error: err.message }) : next(err);
    }
    console.error(`Packing "${game.title}" failed: ${err.message}`);
    res.destroy();
  } finally {
    done();
  }
});

// What the DOSBox player page needs to start a version: conf, zip location, extra files.
// A friend invited to a DOS game needs this too, so it takes the room grant as well as an
// account that may play: their browser runs the game alongside the host's (see lib/ipx.js).
api.get('/dos/:versionId', mayPlayVersion, async (req, res, next) => {
  const version = versionFor(req, req.params.versionId);
  if (version?.engine !== 'dosbox') return res.status(404).json({ error: 'That version of the game wasn\'t found.' });
  // Starting the game's multiplayer mode rather than its usual one, for whichever side asked.
  const role = ['host', 'join'].includes(req.query.multiplayer) ? req.query.multiplayer : null;
  if (role && !version.ipx) return res.status(400).json({ error: 'This game isn\'t set up for network play.' });
  try {
    res.set('Cache-Control', 'no-cache').json(await webPlay.dosLaunch(version, String(req.query.sound ?? ''), { backend: req.query.backend, multiplayer: role }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Copies a Windows 3.x game's installed folder into the server's cache (the first time only),
// so the game.zip route can send it without reading the games drive again. The page waits for
// this and says what's happening meanwhile.
api.get('/dos/:versionId/prepare', mayPlayVersion, async (req, res, next) => {
  const version = versionFor(req, req.params.versionId);
  if (version?.engine !== 'dosbox') return res.status(404).json({ error: 'That version of the game wasn\'t found.' });
  res.set('Cache-Control', 'no-store');
  // A Windows 9x game's zip is unpacked, so its hard disk can be read a piece at a time.
  if (version.win9x) {
    const done = await prepared(`dos:${version.id}`, () => webPlay.win9xBundle(version).catch((err) => {
      console.warn(`Couldn't unpack ${version.zipAbs}: ${err.message}`);
      throw err;
    }));
    if (!done) return res.status(202).json({ ready: false, pending: true });
    if (!done.value) return res.status(500).json({ error: 'The server couldn\'t unpack the game.' });
    return res.json({ ready: true, bytes: done.value.zipSize });
  }
  // A DOS game is its zip, which needs nothing done first.
  if (!version.win3x) return res.json({ ready: true, bytes: version.zipSize });
  const done = await prepared(`dos:${version.id}`, () => webPlay.win3xBundle(version).catch((err) => {
    console.warn(`Couldn't copy ${version.dataAbs}: ${err.message}`);
    throw err;
  }));
  if (!done) return res.status(202).json({ ready: false, pending: true });
  if (!done.value) return res.status(500).json({ error: 'The server couldn\'t copy the game.' });
  res.json({ ready: true, bytes: done.value.zipSize });
});

// What the EmulatorJS player page needs to start a console version: core, ROM and BIOS URLs.
api.get('/emu/:versionId', mayPlayVersion, async (req, res, next) => {
  const version = versionFor(req, req.params.versionId);
  const game = version && library.gamesById.get(req.params.versionId.replace(/-\d+$/, ''));
  if (version?.engine !== 'emulatorjs' || !game) return res.status(404).json({ error: 'That version of the game wasn\'t found.' });
  try {
    res.set('Cache-Control', 'no-cache').json(await webPlay.emuLaunch(game, version));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// What the MAME player page needs to start an arcade version: the bundle, the set and its files.
api.get('/mame/:versionId', mayPlayVersion, (req, res) => {
  const version = versionFor(req, req.params.versionId);
  const game = version && library.gamesById.get(req.params.versionId.replace(/-\d+$/, ''));
  if (version?.engine !== 'mame' || !game) return res.status(404).json({ error: 'That version of the game wasn\'t found.' });
  try {
    res.set('Cache-Control', 'no-cache').json(webPlay.mameLaunch(game, version));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// Unpacks a CD archive on the server (the first time only), so the ROM route can send it
// as a plain zip. The page waits for this and says what's happening meanwhile.
api.get('/emu/:versionId/prepare', mayPlayVersion, async (req, res, next) => {
  const version = versionFor(req, req.params.versionId);
  if (version?.engine !== 'emulatorjs') return res.status(404).json({ error: 'That version of the game wasn\'t found.' });
  res.set('Cache-Control', 'no-store');
  const done = await prepared(`emu:${version.id}`, () => webPlay.unpackedRom(version).catch((err) => {
    console.warn(`Couldn't unpack ${version.romAbs}: ${err.message}`);
    throw err;
  }));
  if (!done) return res.status(202).json({ unpacked: false, pending: true });
  // The browser can still unpack the archive itself; the page falls back to that.
  if (done.error) return res.status(500).json({ error: 'The server couldn\'t unpack the game.' });
  res.json({ unpacked: Boolean(done.value), bytes: done.value?.zipSize ?? version.romSize });
});

/**
 * Work a page waits for before a game can start (a CD archive unpacked, a Windows game copied),
 * which the first time can take minutes. A tunnel gives up on a request after about 100 seconds
 * (Cloudflare then answers 524), so the answer comes within PREPARE_WAIT_MS whatever happens:
 * { value } or { error } once the work is done, or null while it's still going, and the page
 * asks again. The work carries on meanwhile, once however many ask; its outcome is kept a
 * minute, so a failure isn't retried by every poll.
 */
const PREPARE_WAIT_MS = 20_000;
const preparing = new Map(); // key -> { promise, result }

async function prepared(key, start) {
  let job = preparing.get(key);
  if (!job) {
    job = { result: null };
    job.promise = start()
      .then((value) => { job.result = { value }; }, (error) => { job.result = { error }; })
      // Only this job: the cache's Clear may have dropped it, and a newer one taken its place.
    .finally(() => setTimeout(() => { if (preparing.get(key) === job) preparing.delete(key); }, 60_000).unref());
    preparing.set(key, job);
  }
  if (!job.result) {
    let timer;
    await Promise.race([job.promise, new Promise((resolve) => { timer = setTimeout(resolve, PREPARE_WAIT_MS); })]);
    clearTimeout(timer);
  }
  return job.result;
}

// Requests that change something must come from this app's own pages (fromThisApp, in lib/access.js).

/**
 * The order versions are preferred in: a fixed ranking (see versionkind.js), narrowed to the
 * kinds the loaded games actually have. It isn't a setting; a game page can override it for
 * one game at a time (settings.gameDefaults).
 */
const versionOrder = untilListsChange(() => {
  const present = new Set(webPlay.allVersions().map((v) => v.kind.key));
  return completeOrder([], present).filter((k) => present.has(k));
});

// ---------- Accounts ----------

// The settings and plays of accounts other than the owner's, each in a folder of its own
// named from a hash of the email address, so the folder names don't give the addresses away.
const accountStores = new Map();

const accountKey = (email) => crypto.createHash('sha256').update(email).digest('hex').slice(0, 24);
/** The folder an account's settings and plays are kept in. */
const accountDir = (email) => path.join(userdataDir, 'users', accountKey(email));

/** Forgets an account's settings and plays (a local account the owner deleted). */
async function removeAccountData(email) {
  accountStores.delete(accountKey(email));
  await fs.rm(accountDir(email), { recursive: true, force: true });
}

/** The settings and plays of whoever is asking: the owner's are the app's own files; nobody's without an account. */
async function storesFor(req) {
  if (req.can.owner) return { settings: settingsStore, plays: playStore };
  if (!req.user) return null;
  const key = accountKey(req.user.email);
  let stores = accountStores.get(key);
  if (!stores) {
    const dir = accountDir(req.user.email);
    stores = { settings: new SettingsStore(path.join(dir, 'settings.json')), plays: new PlayStore(path.join(dir, 'plays.json')) };
    accountStores.set(key, stores);
  }
  await stores.plays.load();
  return stores;
}

/**
 * A game's play count, last-played date and time played for whoever is asking: the owner's
 * include LaunchBox's history; an account that can't play has none. The time played is
 * LaunchBox's alone, so only the owner's answer has it.
 */
async function playsFor(req, game) {
  if (!req.can.play) return { playCount: 0, lastPlayed: null, playTime: 0 };
  const stores = await storesFor(req);
  return { ...mergePlays(req.can.owner ? game : {}, stores?.plays.get(game.id) ?? null), playTime: req.can.owner ? game.playTime ?? 0 : 0 };
}

/**
 * The settings, and the plays counted in this app, of whoever is asking: the shelf's flags are
 * the owner's defaults with the account's own changes over them, and `filterDefaults` the
 * defaults alone, which a page keeping its changes in the browser lays them over. Someone who
 * can't play has nothing hidden for not running in the browser (it isn't something they'd find
 * out) and no per-game defaults; someone not signed in has no favorites.
 */
async function settingsFor(req) {
  const stores = await storesFor(req);
  const { filters, ...settings } = stores ? await stores.settings.get() : defaultSettings();
  const { shelfDefaults } = serverSettings.get();
  Object.assign(settings, shelfFlags(shelfDefaults, filters), { filterDefaults: shelfDefaults });
  if (!req.can.play) Object.assign(settings, { showBroken: true, gameDefaults: {}, touchButtons: {} });
  if (!req.can.favorites) settings.favorites = {};
  const plays = req.can.play && stores ? { ...(await stores.plays.load()) } : {};
  // The order versions are ranked in is about which one Play starts: for someone who may play.
  return { settings: { ...settings, ...(req.can.play && { versionOrder: versionOrder() }) }, plays };
}

api.get('/settings', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store').json(await settingsFor(req));
  } catch (err) {
    next(err);
  }
});

// The page sends a save at most every 400 ms, so this only slows down something that isn't it.
const settingsLimit = rateLimit({ windowMs: 60_000, max: 120, key: (req) => req.user?.email ?? req.ip, message: 'Too many saves. Try again in a minute.' });

api.put('/settings', settingsLimit, express.json({ limit: '256kb' }), async (req, res, next) => {
  if (!fromThisApp(req)) return res.status(403).json({ error: 'Settings can only be changed from this app.' });
  const stores = await storesFor(req);
  if (!stores) return res.status(401).json({ error: 'Sign in to keep settings on the server.' });
  try {
    const patch = { ...(req.body ?? {}) };
    // What only playing makes sense of.
    if (!req.can.play) {
      delete patch.showBroken;
      delete patch.gameDefaults;
      delete patch.controllerLayouts;
      delete patch.touchButtons;
    }
    // Only games and versions in the library are kept (see SettingsStore.update).
    await stores.settings.update(patch, {
      shelfDefaults: serverSettings.get().shelfDefaults,
      isGame: (id) => library.gamesById.has(id),
      isVersion: (gameId, versionId) => webPlay.versionsFor(library.gamesById.get(gameId)).some((v) => v.id === versionId),
    });
    res.json(await settingsFor(req));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Which build this server runs, with each public file's hash (see lib/build.js). Working it out runs
// git and hashes every file, so it's redone at most every few seconds: a file edited while the
// server runs still shows soon after. In full for whoever may play or holds a friend's room code
// (the stats page checks the files a browser got); anyone else is told the build it started as,
// which costs nothing to answer, and not the commit, the Node version or the list of files.
const currentBuild = recentBuild(projectRoot, { first: build });
api.get('/build', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.can.play || roomGrant(req)) return res.json({ ...currentBuild(), startedAt: build.startedAt });
  res.json({ version: build.version, build: build.build, startedAt: build.startedAt });
});

/**
 * What a page is told someone may do. Someone who can't play isn't told there's playing to be
 * had: `play` is left out rather than said to be false (see mayPlay in lib/access.js).
 */
const canFor = ({ can }) => (can.play ? { ...can } : { owner: can.owner, admin: can.admin, favorites: can.favorites });

// Who's signed in and what they may do, and what the page needs to offer signing in.
api.get('/me', (req, res) => {
  // Every page of the app asks this as it opens, so it's where a visit is counted.
  record(req, { type: 'visit' });
  res.set('Cache-Control', 'no-store').json({
    // enabled: there are accounts at all. clientId: Google's, when it's set up. local: local
    // accounts can sign in; localSignup: and anyone may make one.
    auth: {
      enabled: auth.enabled,
      clientId: auth.google ? auth.clientId : null,
      local: auth.local,
      localSignup: auth.local && serverSettings.get().localSignup,
    },
    user: req.user,
    can: canFor(req),
    // The owner's switches for the whole server, which the admin page changes.
    ...(req.can.admin && { server: serverSettings.get() }),
  });
});

// The owner lets guests (anyone not signed in) play and download games, or stops them, and sets
// the public address invite links use. It takes effect at the next request anyone makes; a
// guest's open page shows it once reloaded.
api.put('/server-settings', express.json({ limit: '4kb' }), async (req, res, next) => {
  if (!fromThisApp(req)) return res.status(403).json({ error: 'Settings can only be changed from this app.' });
  if (!req.can.admin) return res.status(403).json({ error: 'Only the owner can change this.' });
  // Turning local accounts on or off goes through POST /api/admin/local-logins, which makes sure
  // there's an owner's account to sign in as and signs this browser in with it.
  if (Object.hasOwn(req.body ?? {}, 'localLogins') || Object.hasOwn(req.body ?? {}, 'localSignup')) {
    return res.status(400).json({ error: 'Local accounts are turned on and off on the Accounts tab.' });
  }
  try {
    // A public address this server would turn away (see lib/hosts.js) would make links nobody can open.
    const saved = await serverSettings.update(req.body, { isKnownHost: knownHost });
    const by = `changed by ${req.user?.email ?? 'the owner'}`;
    if (Object.hasOwn(req.body ?? {}, 'guestsCanPlay')) {
      const until = saved.guestsUntil ? ` until ${new Date(saved.guestsUntil).toLocaleString()}` : '';
      console.log(`Guests ${saved.guestsCanPlay ? `can now play and download games${until}` : 'can only browse again'} (${by}).`);
      // The games guests were hosting end with it, and their links stop handing out the game.
      if (!saved.guestsCanPlay) endLapsedRooms();
    }
    if (Object.hasOwn(req.body ?? {}, 'shelfDefaults')) console.log(`What the shelf shows by default changed (${by}).`);
    if (Object.hasOwn(req.body ?? {}, 'publicUrl')) console.log(`Invite links now use ${saved.publicUrl ?? 'the address the host opened the app at'} (${by}).`);
    res.set('Cache-Control', 'no-store').json(saved);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * Sign-in requests must come from this app's own pages (see fromThisApp), checked before any
 * limit counts them: otherwise another site's page could use up a visitor's allowance.
 */
const fromThisAppOnly = (message) => (req, res, next) => (fromThisApp(req) ? next() : res.status(403).json({ error: message }));

// Google's sign-in button gives the page a token, which comes here to become a session.
// Each sign-in asks Google and writes the sessions file; a person signs in now and then.
const signInLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, message: 'Too many sign-ins. Try again in a few minutes.' });

api.post('/auth/google', fromThisAppOnly('Sign in from this app.'), signInLimit, express.json({ limit: '16kb' }), async (req, res, next) => {
  if (!auth.google) return res.status(404).json({ error: 'Signing in with Google isn\'t set up on this server.' });
  try {
    const user = await auth.verifyGoogle(req.body?.credential);
    await auth.signIn(req, res, user);
    accounts.seen(user, { signIn: true });
    console.log(`Signed in: ${user.email}`);
    const can = auth.permissionsFor(user, { local: req.local, internet: req.internet, guestsCanPlay: serverSettings.guestsCanPlay });
    record(req, { type: 'signin' }, { user, can });
    res.json({ user, can: canFor({ can }) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ---------- Local accounts (see lib/localusers.js) ----------
//
// Each check of a password costs the server about 0.3 s on purpose. Guessing is limited three
// ways, and only failures count towards the last two, so nobody can lock an account out by
// signing in wrongly on purpose, and signing in rightly clears the slate:
//   - every sign-in by address (localSignInLimit), which also caps how busy guessing keeps the server;
//   - failures at one account from one address (pairFailures): a stranger guessing gets 10 tries
//     a quarter of an hour, while the account's owner, from anywhere else, isn't held back;
//   - failures at one account from the internet as a whole (accountFailures), for guesses spread
//     over many addresses. Past that, only the local network can still sign in as that account,
//     so a flood from outside can't lock its owner out at home either.
const localSignInLimit = rateLimit({ windowMs: 10 * 60_000, max: 20, message: 'Too many sign-in attempts. Try again in a few minutes.' });
const pairFailures = new Counter({ windowMs: 15 * 60_000, max: 10 });
const accountFailures = new Counter({ windowMs: 60 * 60_000, max: 50 });
const signUpLimit = rateLimit({ windowMs: 60 * 60_000, max: 5, message: 'Too many new accounts from here. Try again later.' });
// Everyone's sign-ups together, and how many new accounts may wait for the owner to look at them:
// a flood of new accounts from many addresses stops there, rather than filling the account limit.
const allSignUps = new Counter({ windowMs: 60 * 60_000, max: 30 });
const MAX_WAITING_SIGNUPS = 50;
const passwordLimit = rateLimit({ windowMs: 15 * 60_000, max: 10, key: (req) => req.user?.email ?? req.ip, message: 'Too many tries. Try again in a few minutes.' });

const WRONG_PASSWORD = 'That username and password don\'t match.';

/** A username fit to write in the server's log and the activity log (anything else isn't one). */
const loggable = (name) => (usernameProblem(name) ? '(not a username)' : String(name).trim().toLowerCase());

/** A failed sign-in: counted (see above), and written down so the owner can see someone guessing. */
function signInFailed(req, username, why) {
  const name = loggable(username);
  pairFailures.hit(`${name}|${clientKey(req.ip)}`);
  if (req.internet) accountFailures.hit(name);
  console.log(`Failed sign-in as ${name} from ${req.ip} (${why}).`);
  record(req, { type: 'badsignin', name, message: why });
}

/** Starts a session for a local account, counts it as a sign-in, and answers with who it is. */
async function signInLocal(req, res, user) {
  await auth.signIn(req, res, user);
  accounts.seen(user, { signIn: true });
  console.log(`Signed in: ${user.email}`);
  const can = auth.permissionsFor(user, { local: req.local, internet: req.internet, guestsCanPlay: serverSettings.guestsCanPlay });
  record(req, { type: 'signin' }, { user, can });
  res.json({ user: { ...user, local: true, username: localUsername(user.email) }, can: canFor({ can }) });
}

api.post('/auth/local/signin', fromThisAppOnly('Sign in from this app.'), localSignInLimit, express.json({ limit: '4kb' }), async (req, res, next) => {
  if (!auth.local) return res.status(404).json({ error: 'Signing in with a username isn\'t turned on here.' });
  const username = String(req.body?.username ?? '').trim().toLowerCase().slice(0, 40);
  const pair = `${loggable(username)}|${clientKey(req.ip)}`;
  if (pairFailures.over(pair) || (req.internet && accountFailures.over(loggable(username)))) {
    console.log(`Sign-in as ${loggable(username)} from ${req.ip} held back after too many failures.`);
    res.set('Retry-After', String(Math.max(pairFailures.retryAfter(pair), 60)));
    return res.status(429).json({ error: 'Too many failed sign-ins. Try again in a few minutes.' });
  }
  try {
    const user = await localUsers.verify(username, req.body?.password);
    if (!user) {
      signInFailed(req, username, localUsers.has(username) ? 'wrong password' : 'no such account');
      return res.status(401).json({ error: WRONG_PASSWORD });
    }
    // A blocked account is told what anyone with a wrong password is, so the answer doesn't say
    // that the password was right.
    if (accounts.access(user.email) === 'blocked') {
      signInFailed(req, username, 'blocked');
      return res.status(401).json({ error: WRONG_PASSWORD });
    }
    pairFailures.clear(pair);
    await signInLocal(req, res, user);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * Whether a username is kept back from signing up: one the config names for an account (as
 * owner or player) that hasn't been made yet, which a stranger would otherwise get with it.
 */
const reservedUsername = (username) => {
  const email = localEmail(username);
  return lowerEmail(config.auth?.owner) === email || (config.auth?.players ?? []).some((p) => lowerEmail(p) === email);
};

// Someone making an account for themselves, when the owner allows it. Like a first Google
// sign-in it can only browse until the owner decides otherwise (the admin page's New sign-ins).
api.post('/auth/local/signup', fromThisAppOnly('Sign up from this app.'), signUpLimit, express.json({ limit: '4kb' }), async (req, res, next) => {
  if (!auth.local || !serverSettings.get().localSignup) return res.status(404).json({ error: 'New accounts can\'t be made here.' });
  const waiting = accounts.list().filter((a) => a.isNew && localUsername(a.email)).length;
  if (waiting >= MAX_WAITING_SIGNUPS || !allSignUps.hit('all')) {
    console.log(`A sign-up from ${req.ip} was turned away: too many new accounts just now (${waiting} waiting).`);
    return res.status(503).json({ error: 'New accounts can\'t be made just now. Try again later.' });
  }
  try {
    if (!usernameProblem(req.body?.username) && reservedUsername(req.body.username)) return res.status(409).json({ error: 'That username is taken.' });
    const user = await localUsers.create({ username: req.body?.username, name: req.body?.name, password: req.body?.password });
    console.log(`New local account: ${user.email} (from ${req.ip})`);
    await signInLocal(req, res, user);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// A local account changes its own password. It gets a new uid, which ends every session it had
// (see lib/localusers.js), and this browser gets a new one.
api.post('/auth/local/password', fromThisAppOnly('Change it from this app.'), express.json({ limit: '4kb' }), passwordLimit, async (req, res, next) => {
  const username = req.user?.local ? req.user.username : null;
  if (!username) return res.status(401).json({ error: 'Sign in with a local account first.' });
  try {
    if (!(await localUsers.verify(username, req.body?.current))) {
      signInFailed(req, username, 'wrong current password');
      return res.status(401).json({ error: 'The current password isn\'t right.' });
    }
    await localUsers.setPassword(username, req.body?.password);
    // The new uid has ended them already; this takes them out of the file too.
    await auth.endSessions(req.user.email).catch((err) => console.warn(`Couldn't save the sessions ended for ${req.user.email}: ${err.message}`));
    await auth.signIn(req, res, localUsers.user(username));
    console.log(`${req.user.email} changed their password.`);
    res.json({ changed: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

api.post('/auth/signout', async (req, res, next) => {
  if (!fromThisApp(req)) return res.status(403).json({ error: 'Sign out from this app.' });
  try {
    await auth.signOut(req, res);
    res.json({ signedOut: true });
  } catch (err) {
    next(err);
  }
});

// The player page says a game has started: counted as a play, in userdata/plays.json, and in
// the activity log for everyone (someone not signed in too). The page says so once per launch,
// so the limit only slows down something that isn't it; it comes after mayPlay, so someone who
// can't play is told "Not found", not that they started too many games, and after the check that
// the app sent it, so another site's page can't use up someone's allowance.
const playedLimit = rateLimit({ windowMs: 60_000, max: 20, key: (req) => req.user?.email ?? req.ip, message: 'Too many games started. Try again in a minute.' });
const playedFromThisApp = (req, res, next) => (fromThisApp(req) ? next() : res.status(403).json({ error: 'Plays can only be recorded from this app.' }));

api.post('/games/:id/played', mayPlay, playedFromThisApp, playedLimit, express.json({ limit: '4kb' }), async (req, res, next) => {
  const game = findGame(req, res);
  if (!game) return;
  try {
    // Someone playing on the local network without signing in has no account to count it for.
    const stores = await storesFor(req);
    if (stores) await stores.plays.record(game.id);
    const event = eventFor(req, { type: 'play', ...gameFields(game, versionOf(game, req.body?.versionId)) });
    activity.record(event);
    // The page checks in with this while the game is open, which is how long it was played.
    const { type, ...about } = event;
    res.json({ ...(await playsFor(req, game)), playId: livePlays.start(about) });
  } catch (err) {
    next(err);
  }
});

// The player page checks in every half minute while a game is open (saying whether it's on
// screen), and says when it's left: the play's time, and who's playing right now, on the admin
// page. The play's id, which only that page was given, is all it takes. A page that comes back
// after a gap (a phone back from another app, a laptop woken up) carries on, as a new stretch
// (see LivePlays.beat); "Not found" means the id isn't known any more.
const beatLimit = rateLimit({ windowMs: 60_000, max: 60, key: (req) => req.ip, message: 'Too many check-ins.' });

api.post('/plays/:id/beat', beatLimit, express.json({ limit: '1kb' }), (req, res) => {
  if (!fromThisApp(req)) return res.status(403).json({ error: 'Only this app checks in.' });
  if (!livePlays.beat(req.params.id, { visible: req.body?.visible !== false })) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'no-store').json({ ok: true });
});

api.post('/plays/:id/end', beatLimit, (req, res) => {
  if (!fromThisApp(req)) return res.status(403).json({ error: 'Only this app checks in.' });
  if (!livePlays.end(req.params.id, 'left')) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// The player page says a game failed: it didn't start, or the emulator stopped. Kept in the
// activity log, where the admin page lists the games that fail most.
const failedLimit = rateLimit({ windowMs: 60_000, max: 10, key: (req) => req.user?.email ?? req.ip, message: 'Too many reports. Try again in a minute.' });

api.post('/games/:id/failed', mayPlay, failedLimit, express.json({ limit: '4kb' }), (req, res) => {
  if (!fromThisApp(req)) return res.status(403).json({ error: 'Failures can only be reported from this app.' });
  const game = findGame(req, res);
  if (!game) return;
  const started = req.body?.started === true;
  const message = String(req.body?.message ?? '').slice(0, 300);
  record(req, { type: 'failed', ...gameFields(game, versionOf(game, req.body?.versionId)), message: `${started ? 'Stopped while playing' : 'Didn\'t start'}${message ? `: ${message}` : ''}` });
  res.json({ recorded: true });
});

// ---------- Playing with a friend ----------
//
// EmulatorJS's own netplay, over a socket.io server on this same port (see lib/netplay.js and
// the end of this file): the app opens a room here, the host's game opens it over the socket,
// and a friend's link joins it. Only opening a room needs an account that may play: a friend
// has the link, and the link lets their browser fetch that one game while the room lasts (see
// roomGrant), since EmulatorJS's netplay runs the game on every player's side.

/**
 * How a version is played with friends, or null. Console games keep each other's emulators in
 * step or stream the host's game ('rollback' or 'stream'; see CORES in lib/emulatorjs.js); an
 * arcade game streams the host's MAME (see public/player/mame-netplay.js); a DOS game eXo set up
 * for a LAN plays over IPX, which the games do themselves (lib/ipx.js).
 */
function netplayModeOf(version) {
  if (!version) return null;
  if (version.engine === 'emulatorjs') return CORES[version.platform]?.netplay || null;
  // A computer MAME runs (an Apple IIgs game) is streamed: its state is megabytes of RAM, and what
  // it writes to its disks can't be taken back by a rollback. The friend's keyboard and mouse go to
  // the host (see public/player/mame-netplay.js).
  if (version.engine === 'mame' && version.computer) return knownIssueFor(version) ? null : 'stream';
  if (version.engine === 'mame') return version.files?.some((f) => f.abs) && version.romSize <= webPlay.maxMameBytes ? mameNetplayMode(version.setName) : null;
  if (version.engine === 'dosbox') return version.ipx && !version.win9x && !knownIssueFor(version) ? 'ipx' : null;
  return null;
}

/**
 * A version by its id, for a route that hands out its files or what starts it: none for a
 * hidden game (hidden in LaunchBox, so off the shelf), unless it's the owner asking.
 */
function versionFor(req, id) {
  const version = webPlay.version(String(id ?? ''));
  if (!version || req.can.owner) return version;
  return library.gamesById.get(String(id).replace(/-\d+$/, ''))?.hidden ? null : version;
}

/** How someone hosting a game came to be allowed to play (see NetplayRooms.create). */
function hostVia(req) {
  if (req.can.owner) return 'owner';
  if (req.user && accounts.access(req.user.email) === 'play') return 'account';
  if (req.local) return 'local';
  return 'guest';
}

/**
 * Ends the rooms whose host may no longer play: guests turned off (or their time up), an account
 * whose access was taken down to browsing, or a local account while local accounts are off.
 * Asked after each such change, and every half minute for guests' time running out.
 */
function endLapsedRooms() {
  const guests = serverSettings.guestsCanPlay;
  const ended = netplay.endRoomsWhere(({ hostEmail, via }) => {
    if (via === 'guest') return !guests;
    if (via !== 'account' || !hostEmail) return false;
    if (localUsername(hostEmail) && (!auth.local || !localUsers.has(localUsername(hostEmail)))) return true;
    return accounts.access(hostEmail) !== 'play' && !guests;
  });
  if (ended) console.log(`Ended ${ended} hosted game(s) whose host may no longer play.`);
  return ended;
}
setInterval(endLapsedRooms, 30_000).unref();

const roomLimit = rateLimit({ windowMs: 60_000, max: 20, key: (req) => req.user?.email ?? req.ip, message: 'Too many games started. Try again in a minute.' });

api.post('/netplay/rooms', mayPlay, roomLimit, express.json({ limit: '4kb' }), (req, res, next) => {
  if (!fromThisApp(req)) return res.status(403).json({ error: 'A game can only be hosted from this app.' });
  const game = library.gamesById.get(String(req.body?.gameId ?? ''));
  if (!game || (game.hidden && !req.can.owner)) return res.status(404).json({ error: 'No game with that ID.' });
  const version = webPlay.versionsFor(game).find((v) => v.id === req.body?.versionId);
  // Console games are kept in step by their emulators; a DOS game eXo set up for a LAN plays
  // over IPX, which the games do themselves once the browsers have met (see lib/ipx.js).
  const mode = netplayModeOf(version);
  if (!mode) return res.status(400).json({ error: 'This game can\'t be played with a friend here: it has no network play of its own, and two copies of its emulator can\'t be kept in step closely enough.' });
  try {
    const room = netplay.create({
      gameId: game.id, versionId: version.id, title: game.title, platform: game.platform, engine: version.engine, cover: game.slots?.front ?? null,
      input: version.computer ? 'keyboard' : 'pad',
      // The account, so blocking it ends its rooms (none when hosting without signing in), and
      // how it may play, so the room ends when that does (see endLapsedRooms).
      hostName: (req.user?.name ?? '').split(' ')[0], hostEmail: req.user?.email ?? null, via: hostVia(req), mode,
    });
    console.log(`${req.user?.email ?? 'The host'} is hosting ${game.title} for a friend (room ${room.code}).`);
    record(req, { type: 'host', ...gameFields(game, version), room: room.code });
    // The link to send, at the public address the owner set on the admin page; without one the
    // page makes it from the address it was opened at.
    const { publicUrl } = serverSettings.get();
    res.set('Cache-Control', 'no-store').json({ ...room, link: publicUrl ? new URL(`/join/${room.code}`, publicUrl).href : null });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// What the join page shows before joining. Open to anyone with the link, like the link itself.
api.get('/netplay/rooms/:code', (req, res) => {
  const info = netplay.info(req.params.code);
  if (!info) return res.status(404).json({ error: 'This game has ended, or there was never one at this link.' });
  res.set('Cache-Control', 'no-store').json(info);
});

// EmulatorJS's own Netplay menu would ask for a room list here, to offer the open games of a
// title to anyone browsing. There is deliberately no such route: a room's code is its invite
// (holding one lets a browser fetch that game's files and open a signalling socket, see
// roomGrant and lib/ipx.js), so a list of codes would hand out every private game going. The
// app doesn't need one either — its friends arrive by link, and EJS_Buttons turns that menu
// off (see public/emu/play.html).

// The sessions' logs (see lib/netplaylog.js), for the multiplayer stats page: the list, and
// one in full. For accounts that may play, since a log names the players.
api.get('/netplay/logs', mayPlay, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store').json(await netplayLog.list());
  } catch (err) {
    next(err);
  }
});
api.get('/netplay/logs/:name', mayPlay, async (req, res, next) => {
  try {
    const session = await netplayLog.read(req.params.name);
    if (!session) return res.status(404).json({ error: 'No such session.' });
    res.set('Cache-Control', 'no-store').json(session);
  } catch (err) {
    next(err);
  }
});

// ---------- Activity ----------
//
// What people do, for the admin page (see lib/activity.js): who it was, from where, and what.

/** An event about a request's person: who they are and where they are, and `fields`. */
function eventFor(req, fields, { user = req.user, can = req.can } = {}) {
  return {
    who: whoFor({ user, can, local: !req.internet, guestsCanPlay: serverSettings.guestsCanPlay, friend: !can.play && roomGrant(req) }),
    email: user?.email,
    name: user?.name,
    ...clientOf({ headers: req.headers, ip: req.ip, socketAddress: req.socket?.remoteAddress, internet: req.internet }),
    ...fields,
  };
}

/** Adds an event for a request's person. Not waited for: a log that can't be written says so and nothing else stops. */
function record(req, fields, options) {
  const event = eventFor(req, fields, options);
  return fields.type === 'visit' ? activity.visit(event) : activity.record(event);
}

/** A friend's game joining a room over the netplay socket, which has no Express request. */
function recordJoin(socket, room, name) {
  const { headers, address } = socket.handshake;
  const game = library.gamesById.get(room.gameId);
  activity.record({
    type: 'join',
    who: 'friend',
    name,
    room: room.code,
    ...clientOf({ headers, socketAddress: address, internet: !isLocalNetwork({ headers, ip: address }) }),
    ...(game ? gameFields(game, versionOf(game, room.versionId)) : { title: room.title, platform: room.platform }),
  });
}

const gameFields = (game, version) => ({ gameId: game.id, title: game.title, platform: game.platform, ...(version && { versionId: version.id, engine: version.engine }) });
const versionOf = (game, id) => (typeof id === 'string' ? webPlay.versionsFor(game).find((v) => v.id === id) ?? null : null);

// Downloads being sent right now, for the admin page: response -> what and how far.
const sending = new Map();

/**
 * Logs a download once it ends, finished or not, with how much was sent. A download picking up
 * where it broke off (a range past the start) is the same download, so it isn't logged again.
 */
function logDownload(req, res, game, version, kind) {
  if (req.method === 'HEAD') return;
  const from = /^bytes=(\d+)-/.exec(String(req.headers.range ?? ''));
  if (from && Number(from[1]) > 0) return;
  // The connection's own count of bytes written: a browser sends one request at a time on it.
  const socket = req.socket;
  const start = socket.bytesWritten;
  sending.set(res, { title: game.title, platform: game.platform, kind, who: req.user?.email ?? null, ip: clientOf({ headers: req.headers, ip: req.ip, socketAddress: socket.remoteAddress }).ip, started: new Date().toISOString(), sent: () => socket.bytesWritten - start });
  res.once('close', () => {
    sending.delete(res);
    // An answer that says what went wrong (the game's files weren't there, say) isn't a download.
    if (res.statusCode >= 400) return;
    record(req,{ type: 'download', kind, ...gameFields(game, version), bytes: socket.bytesWritten - start, complete: res.writableFinished });
  });
}

// ---------- Admin ----------
//
// The owner's admin page (public/admin.html): usage, who may do what, and a few commands.

const admin = express.Router();

// The owner only, and changes only from this app's own pages (see lib/access.js).
admin.use(ownerOnly);

const RANGES = [1, 7, 30, 90, 365, 0];

admin.get('/overview', async (req, res, next) => {
  try {
    const days = RANGES.includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    res.json({ summary: summarize(await activity.all(), { days }), live: liveNow() });
  } catch (err) {
    next(err);
  }
});

admin.get('/live', (req, res) => res.json(liveNow()));

// The counts the admin page's tabs show: games being played, and accounts waiting for a decision.
admin.get('/badges', (req, res) => res.json({ playing: livePlays.list().length, newAccounts: accounts.list().filter((a) => a.isNew).length }));

/** What's going on right now: the guests switch, games hosted for friends, downloads, games being made ready. */
function liveNow() {
  return {
    guests: serverSettings.get(),
    playing: livePlays.list().map(({ id, visible, ...play }) => ({ ...play, onScreen: visible })),
    rooms: netplay.adminList(),
    downloads: [...sending.values()].map(({ sent, ...d }) => ({ ...d, bytes: sent() })),
    downloadsWaiting: downloads.waiting.size,
    preparing: [...preparing].filter(([, job]) => !job.result).map(([key]) => {
      const versionId = key.slice(key.indexOf(':') + 1);
      const game = library.gamesById.get(versionId.replace(/-\d+$/, ''));
      return { title: game?.title ?? versionId, platform: game?.platform ?? null };
    }),
  };
}

admin.get('/activity', async (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const q = (name) => String(req.query[name] ?? '').slice(0, 200);
    res.json({ events: filterEvents(await activity.all(), { type: q('type'), who: q('who'), q: q('q'), before: q('before'), limit }), types: ACTIVITY_TYPES, who: WHO });
  } catch (err) {
    next(err);
  }
});

admin.get('/accounts', async (req, res, next) => {
  try {
    const [sessions, events] = await Promise.all([auth.sessionCounts(), activity.all()]);
    // What each account has done, and where it was last seen from (to tell who someone new is).
    const counts = new Map();
    for (const e of events) {
      if (!e.email) continue;
      const c = counts.get(e.email) ?? { plays: 0, seconds: 0, downloads: 0, visits: 0, lastActive: null, ip: null, country: null, via: null, agent: null };
      if (e.type === 'play') c.plays++;
      if (e.type === 'stop') c.seconds += e.seconds ?? 0;
      if (e.type === 'download') c.downloads++;
      if (e.type === 'visit') c.visits++;
      c.lastActive = e.t;
      if (e.ip) Object.assign(c, { ip: e.ip, country: e.country ?? null, via: e.via ?? null, agent: e.agent ?? null });
      counts.set(e.email, c);
    }
    res.json({
      enabled: auth.enabled,
      google: auth.google,
      // Local accounts: whether they're on, whether anyone may make one, and whether turning
      // them on needs an owner's account made first (no owner in the config, and none made yet).
      local: { enabled: auth.local, signup: serverSettings.get().localSignup, needsOwner: !config.auth?.owner && !localUsers.owner(), owner: localUsers.owner() },
      localNetworkCanPlay: Boolean(config.localNetworkCanPlay),
      guests: serverSettings.get(),
      accounts: accounts.list()
        // A record left from a local account since deleted isn't listed.
        .filter((a) => !localUsername(a.email) || localUsers.has(localUsername(a.email)))
        .map((a) => {
          const username = localUsername(a.email);
          return {
            ...a,
            local: Boolean(username),
            username,
            // A local account's name is the one it has now (the owner may have changed it).
            ...(username && { name: localUsers.user(username).name }),
            sessions: sessions.get(a.email)?.sessions ?? 0, plays: 0, seconds: 0, downloads: 0, visits: 0, lastActive: null, ...counts.get(a.email),
          };
        }),
    });
  } catch (err) {
    next(err);
  }
});

admin.put('/accounts/:email', express.json({ limit: '4kb' }), async (req, res, next) => {
  try {
    // A local account's access is set only once it exists: set ahead, it would go to whoever
    // made an account with that username later.
    const username = localUsername(req.params.email);
    if (username && !localUsers.has(username)) return res.status(404).json({ error: 'There\'s no local account with that username.' });
    const account = await accounts.setAccess(req.params.email, req.body?.access);
    // A blocked account is signed out everywhere, not only kept from signing in again, and the
    // games it's hosting end: their links would otherwise go on handing out the game. One taken
    // down to browsing keeps its sessions, and its games end unless it may still play some other
    // way (guests let in, the local network: see endLapsedRooms).
    const blocked = account.access === 'blocked';
    const ended = blocked ? await auth.endSessions(account.email) : 0;
    const roomsEnded = blocked ? netplay.endRoomsOf(account.email) : endLapsedRooms();
    console.log(`${account.email} can now ${{ play: 'play and download games', browse: 'browse only', blocked: 'not sign in' }[account.access]} (changed by ${req.user?.email ?? 'the owner'}${ended ? `; ${ended} session(s) ended` : ''}${roomsEnded ? `; ${roomsEnded} hosted game(s) ended` : ''}).`);
    res.json({ account, ended, roomsEnded });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ---------- Local accounts (see lib/localusers.js) ----------

/**
 * Turns local accounts on or off, and says whether anyone may make one. Turning them on where the
 * config names no owner makes the owner's account first (`owner`: { username, name, password }):
 * with no accounts the owner is whoever is at this PC, and once there are accounts the
 * owner is whoever signs in as that one. This browser is signed in with it straight away, or the
 * admin page would lock out the person turning it on.
 */
admin.post('/local-logins', express.json({ limit: '4kb' }), async (req, res, next) => {
  try {
    const { enabled, signup, owner } = req.body ?? {};
    if (enabled !== undefined && typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false.' });
    if (signup !== undefined && typeof signup !== 'boolean') return res.status(400).json({ error: 'signup must be true or false.' });
    let made = null;
    if (enabled === true && !auth.local && !config.auth?.owner && !localUsers.owner()) {
      if (!owner || typeof owner !== 'object') return res.status(400).json({ error: 'Make the owner\'s account first: a username and password to sign in with.', needsOwner: true });
      made = await localUsers.create({ username: owner.username, name: owner.name, password: owner.password, owner: true });
    }
    // Off, where the config names no owner, the owner's local account stops counting. Without
    // Google there are then no accounts, and only this PC can use the admin page: someone doing
    // this from anywhere else would lock themselves out. With Google there'd be no
    // owner at all, anywhere.
    if (enabled === false && auth.local && !config.auth?.owner) {
      if (auth.google) return res.status(400).json({ error: 'The config names no owner (auth.owner), so the owner is your local account: with local accounts off there\'d be nobody who can use the admin page. Add your Google address as auth.owner in config.local.json first.' });
      if (!req.thisPc) return res.status(400).json({ error: 'Without Google sign-in, turning local accounts off leaves the admin page open only on the PC Retro Game Browser runs on. Turn them off there, at http://localhost.' });
    }
    await serverSettings.update({ ...(enabled !== undefined && { localLogins: enabled }), ...(signup !== undefined && { localSignup: signup }) });
    // Off: every local account's session ends, so turning them on again doesn't bring old ones back.
    const ended = enabled === false ? await auth.endSessions((email) => Boolean(localUsername(email))) : 0;
    if (enabled === false) endLapsedRooms();
    // The owner's account, new or not, signs this browser in when nobody is signed in here.
    const ownerName = localUsers.owner();
    const signedIn = Boolean(enabled === true && !req.user && ownerName && !config.auth?.owner);
    if (signedIn) {
      await auth.signIn(req, res, localUsers.user(ownerName));
      accounts.seen(localUsers.user(ownerName), { signIn: true });
    }
    const by = req.user?.email ?? (made ? made.email : 'the owner');
    if (enabled !== undefined) console.log(`Local accounts turned ${enabled ? 'on' : `off${ended ? `; ${ended} session(s) ended` : ''}`} (by ${by}).`);
    if (signup !== undefined) console.log(`People ${signup ? 'can now' : 'can no longer'} make their own local accounts (by ${by}).`);
    res.json({ enabled: auth.local, signup: serverSettings.get().localSignup, owner: ownerName, signedIn });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** The owner makes a local account, with a password to hand on, and what it may do. */
admin.post('/local-users', express.json({ limit: '4kb' }), async (req, res, next) => {
  try {
    const access = req.body?.access ?? 'browse';
    if (!['play', 'browse'].includes(access)) return res.status(400).json({ error: 'Access must be play or browse.' });
    const problem = usernameProblem(req.body?.username) ?? passwordProblem(req.body?.password, { username: req.body?.username });
    if (problem) return res.status(400).json({ error: problem });
    const user = await localUsers.create({ username: req.body.username, name: req.body.name, password: req.body.password });
    await accounts.setAccess(user.email, access);
    console.log(`Local account ${user.email} made (${access}) by ${req.user?.email ?? 'the owner'}.`);
    res.json({ user });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** The owner sets a local account's password (one it has forgotten), which signs it out everywhere. */
admin.post('/local-users/:username/password', express.json({ limit: '4kb' }), async (req, res, next) => {
  try {
    const { username } = req.params;
    // Not the owner's own: a change of the owner's password asks for the current one (the
    // profile menu's Change password), so a browser left signed in can't take the account over.
    if (localEmail(username) === accounts.owner) return res.status(400).json({ error: 'Change your own password from your profile menu, which asks for the current one.' });
    await localUsers.setPassword(username, req.body?.password);
    // The new password's uid has ended its sessions already; this takes them out of the file too.
    const ended = await auth.endSessions(localEmail(username)).catch((err) => { console.warn(`Couldn't save the sessions ended for ${localEmail(username)}: ${err.message}`); return 0; });
    console.log(`${localEmail(username)}'s password was reset by ${req.user?.email ?? 'the owner'} (${ended} session(s) ended).`);
    res.json({ ended });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** The owner deletes a local account: it's signed out, the games it's hosting end, and it's forgotten. */
admin.delete('/local-users/:username', async (req, res, next) => {
  try {
    const { username } = req.params;
    const email = localEmail(username);
    if (!localUsers.has(username)) return res.status(404).json({ error: 'There\'s no such account.' });
    if (email === accounts.owner) return res.status(400).json({ error: 'The owner\'s account can\'t be deleted.' });
    // Signed out first, so nothing that fails after this leaves it signed in anywhere. (Once the
    // account is gone its sessions count for nothing anyway: see its uid in lib/localusers.js.)
    const ended = await auth.endSessions(email).catch((err) => { console.warn(`Couldn't save the sessions ended for ${email}: ${err.message}`); return 0; });
    const roomsEnded = netplay.endRoomsOf(email);
    await localUsers.remove(username, { isOwner: (name) => localEmail(name) === accounts.owner });
    // What it was allowed, and its favorites and plays: someone given the same username later
    // starts afresh. A failure here is logged; the account itself is gone either way.
    await accounts.remove(email).catch((err) => console.warn(`Couldn't forget ${email}'s access: ${err.message}`));
    await removeAccountData(email).catch((err) => console.warn(`Couldn't delete ${email}'s favorites and plays: ${err.message}`));
    console.log(`Local account ${email} deleted by ${req.user?.email ?? 'the owner'} (${ended} session(s) ended).`);
    res.json({ ended, roomsEnded });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

admin.post('/accounts/:email/signout', async (req, res, next) => {
  try {
    const ended = await auth.endSessions(String(req.params.email).toLowerCase());
    console.log(`${req.params.email} was signed out everywhere (${ended} session(s), by ${req.user?.email ?? 'the owner'}).`);
    res.json({ ended });
  } catch (err) {
    next(err);
  }
});

admin.post('/rooms/:code/end', (req, res) => {
  if (!netplay.end(req.params.code)) return res.status(404).json({ error: 'That game has already ended.' });
  console.log(`Room ${req.params.code} was ended from the admin page.`);
  res.json({ ended: true });
});


/** Every file under a folder: how many and how big, together. */
async function folderSize(dir) {
  let bytes = 0;
  let files = 0;
  const entries = (await fs.readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])).filter((e) => e.isFile());
  // Many at a time: one after another, the tens of thousands of thumbnails take seconds.
  for (let i = 0; i < entries.length; i += 256) {
    const stats = await Promise.all(entries.slice(i, i + 256).map((e) => fs.stat(path.join(e.parentPath ?? e.path, e.name)).catch(() => null)));
    for (const stat of stats) {
      if (!stat) continue;
      bytes += stat.size;
      files++;
    }
  }
  return { bytes, files };
}

const CACHES = {
  thumbs: {
    label: 'Thumbnails of box art and screenshots',
    dir: () => path.join(config.cacheDir, 'thumbs'),
    limit: () => config.thumbCacheMB * MB,
    clear: () => trimThumbs(config.cacheDir, 0),
  },
  roms: {
    label: 'Unpacked CD games and copied Windows games',
    dir: () => romCache.dir,
    limit: () => config.romCacheMB * MB,
    // Games being played or downloaded right now are left alone: a Windows 9x game reads its hard
    // disk from here all through a play, not only while DiskPool has it open. A game prepared a
    // moment ago isn't said to be ready any more, so its page prepares it again.
    clear: async () => {
      const releases = [];
      for (const play of livePlays.list()) {
        const v = play.versionId ? webPlay.version(play.versionId) : null;
        const unpacked = v?.win9x ? await webPlay.win9xUnpacked(v, { onlyIfReady: true }).catch(() => null) : null;
        if (unpacked) releases.push(holdCacheDir(unpacked.dir));
      }
      try {
        await romCache.trim(null, 0);
      } finally {
        for (const release of releases) release();
      }
      for (const [key, job] of preparing) if (job.result) preparing.delete(key);
    },
  },
};

/** The caches' sizes: a walk of thousands of files, so only when the admin page asks for them. */
function sizesOfCaches() {
  return Promise.all(Object.entries(CACHES).map(async ([name, c]) => ({ name, ...(await folderSize(c.dir())) })));
}

async function diskOf(label, dir) {
  try {
    const s = await fs.statfs(dir);
    return { label, path: dir, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return { label, path: dir, freeBytes: null, totalBytes: null };
  }
}

admin.get('/system', async (req, res, next) => {
  try {
    const versions = webPlay.allVersions();
    const userdata = userdataDir;
    const [disks, activitySize, netplayLogs] = await Promise.all([
      Promise.all([diskOf('App data', userdata), diskOf('Cache', config.cacheDir), diskOf('LaunchBox', config.launchboxRoot)]),
      activity.size(),
      folderSize(path.join(userdata, 'netplay-logs')),
    ]);
    res.json({
      build: { version: build.version, build: build.build, commit: build.commit ?? null, dirty: Boolean(build.dirty), startedAt: build.startedAt },
      launchbox: { path: config.launchboxRoot, fallbackRoots: config.fallbackRoots ?? [], restarts: installed, overridden: Boolean(process.env.LB_ROOT) },
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      memoryBytes: process.memoryUsage().rss,
      library: {
        platforms: library.platforms.size,
        games: [...library.platforms.values()].reduce((n, p) => n + p.games.filter((g) => !g.hidden).length, 0),
        versions: versions.length,
        notWorking: versions.filter((v) => knownIssueFor(v)).length,
      },
      settings: { accounts: auth.google, localAccounts: auth.local, localNetworkCanPlay: Boolean(config.localNetworkCanPlay), allowedHosts: config.allowedHosts ?? [], activityKeepMonths: activity.keepMonths },
      publicUrl: serverSettings.get().publicUrl,
      shelfDefaults: serverSettings.get().shelfDefaults,
      disks,
      // Which caches there are; how big they are is a separate question (GET /admin/caches).
      caches: Object.entries(CACHES).map(([name, c]) => ({ name, label: c.label, limitBytes: c.limit() })),
      logs: {
        activity: activitySize,
        netplay: netplayLogs,
        server: { dir: logsDir, bytes: (serverLog()?.files() ?? []).reduce((n, f) => n + f.bytes, 0), days: new Set((serverLog()?.files() ?? []).map((f) => f.day)).size },
      },
      configFile,
    });
  } catch (err) {
    next(err);
  }
});

// The server's own log (see lib/logfile.js): its latest lines, for a server with no console to
// read. `errors`: only what went to stderr (warnings, errors and crashes).
admin.get('/log', (req, res) => {
  const log = serverLog();
  const lines = Math.min(Math.max(Number.parseInt(req.query.lines, 10) || 300, 1), 2000);
  res.set('Cache-Control', 'no-store').json({
    dir: logsDir,
    started: Boolean(log),
    lines: log ? log.tail(lines, { errorsOnly: req.query.errors === '1' }) : [],
  });
});

// The exit code that asks WinSW to start the server again (its failure actions restart the
// service; see installer/RetroGameBrowser.xml). Any code but 0 would do; this one says why.
const RESTART_EXIT_CODE = 75;

/**
 * Checks a LaunchBox folder the owner gives (as the setup page does), and with `save` writes it to
 * config.local.json. The library, its caches and indexes are all made from that folder at start,
 * so it takes a restart: an installed copy's service restarts itself; run from the project folder,
 * the owner restarts it.
 */
admin.post('/launchbox', express.json({ limit: '4kb' }), async (req, res, next) => {
  try {
    const checked = await checkLaunchBox(req.body?.path);
    if (!checked.ok) return res.status(400).json({ error: checked.problem, suggestion: checked.suggestion ?? null });
    if (req.body?.save !== true) return res.json({ ...checked, saved: false });
    await writeJson(configFile, { ...loadLocal(), launchboxRoot: checked.path });
    const restarting = installed;
    console.log(`LaunchBox folder changed from ${config.launchboxRoot} to ${checked.path} (by ${req.user?.email ?? 'the owner'})${restarting ? '; restarting' : '; restart the server to use it'}.`);
    res.json({ ...checked, saved: true, restarting, overridden: Boolean(process.env.LB_ROOT) });
    if (restarting) res.on('finish', () => setTimeout(() => stopServer(RESTART_EXIT_CODE), 500));
  } catch (err) {
    next(err);
  }
});

admin.get('/caches', async (req, res, next) => {
  try {
    res.json({ caches: await sizesOfCaches() });
  } catch (err) {
    next(err);
  }
});

admin.post('/caches/:name/clear', async (req, res, next) => {
  const cache = Object.hasOwn(CACHES, req.params.name) ? CACHES[req.params.name] : null;
  if (!cache) return res.status(404).json({ error: 'No such cache.' });
  try {
    const before = await folderSize(cache.dir());
    await cache.clear();
    const after = await folderSize(cache.dir());
    console.log(`Cleared ${req.params.name} from the admin page: ${Math.round((before.bytes - after.bytes) / MB)} MB freed.`);
    res.json({ freedBytes: Math.max(0, before.bytes - after.bytes), leftBytes: after.bytes, leftFiles: after.files });
  } catch (err) {
    next(err);
  }
});

api.use('/admin', admin);

api.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use('/api', api);

// The page a friend's link opens (see public/js/join.js). The room's code goes in a cookie as
// well, which is what lets the friend's browser fetch the game the room is for (see roomGrant).
app.get('/join/:code', (req, res) => {
  if (netplay.info(req.params.code)) {
    res.setHeader('Set-Cookie', `${ROOM_COOKIE}=${encodeURIComponent(req.params.code)}; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`);
  }
  res.sendFile(path.join(projectRoot, 'public', 'join.html'), { headers: { 'Cache-Control': 'no-cache', 'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store', 'Content-Security-Policy': APP_POLICY } });
});

// The owner's admin page (see public/js/admin.js). The page itself is no secret: everything it
// shows comes from /api/admin, which answers the owner only.
app.get('/admin', (req, res) => res.sendFile(path.join(projectRoot, 'public', 'admin.html'), { headers: { 'Cache-Control': 'no-cache', 'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store', 'Content-Security-Policy': APP_POLICY } }));

// Client-side routes fall through to the app shell: anything without a file extension, plus
// the platform and genre views, whose name sits in the path and may hold a dot.
app.get([/^\/(?:platform|genre)\/.+$/, /^\/(?!api\/|data\/)(?:[^.]*)$/],
  (req, res) => res.sendFile(path.join(projectRoot, 'public', 'index.html'), { headers: { 'Cache-Control': 'no-cache', 'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store', 'Content-Security-Policy': APP_POLICY } }));

app.use((err, req, res, next) => {
  // A request the server couldn't make sense of (a body that isn't JSON, say) says so; anything
  // else is logged here, and the page is told only that it failed: the message would often
  // name a file on this PC.
  // A browser that went away mid-file (a page left while a game loaded) isn't a failure. That's
  // asked of the response: a request whose JSON body was read counts as "destroyed" by then,
  // with its browser still waiting. (ECONNRESET isn't taken as one: a network share that
  // dropped says that too, and is worth logging.)
  if (res.destroyed || err.code === 'ECONNABORTED') return;
  const status = Number(err.status ?? err.statusCode) || 500;
  if (status >= 500) console.error(err);
  // Partway through an answer there's no way to say so: Express's own handler ends the connection.
  if (res.headersSent) return next(err);
  const message = status >= 500 ? 'Something went wrong on the server.' : err.expose === false ? STATUS_CODES[status] : err.message;
  res.status(status).json({ error: message });
});

/** The game a request names, or null after answering 404. Hidden games are only the owner's to see. */
function findGame(req, res) {
  const game = library.gamesById.get(req.params.id);
  if (!game || (game.hidden && !req.can.owner)) {
    res.status(404).json({ error: 'No game with that ID.' });
    return null;
  }
  return game;
}

/**
 * resolver.resolve, without holding up the server: the same file, but looking for it on a network
 * share that has gone away (the X: fallback, whose host may be asleep) waits on one of Node's
 * worker threads rather than stopping every other request while the shelf asks for its pictures.
 */
async function resolveReadable(rel) {
  if (!rel) return null;
  const readable = (abs) => fs.access(abs, fs.constants.R_OK).then(() => true, () => false);
  if (path.isAbsolute(rel)) return resolver.roots.some((root) => PathResolver.within(root, rel)) && (await readable(rel)) ? rel : null;
  for (const root of resolver.roots) {
    const abs = PathResolver.within(root, rel);
    if (abs && (await readable(abs))) return abs;
  }
  return null;
}

// Kinds of file sendMedia hands over as they are (see there): everything else is sandboxed.
const SAFE_MEDIA = /\.(png|jpe?g|gif|webp|avif|bmp|ico|pdf|txt|mp3|ogg|oga|opus|wav|flac|m4a|aac|mid|midi|mp4|m4v|webm|mkv|avi|mov|wmv|flv|mpe?g)$/i;

// New thumbnails one address may have made a minute (a shelf scrolled through asks for a few
// hundred the first time; the ones made are kept for everyone after).
const thumbMakes = new Counter({ windowMs: 60_000, max: 300 });

async function sendMedia(req, res, next, rel, { thumb = false, document = false, trim = false } = {}) {
  try {
    const abs = await resolveReadable(rel);
    if (!abs) return res.status(404).json({ error: 'File not found.' });
    let file = abs;
    const width = thumb ? snapWidth(req.query.w) : null;
    // A thumbnail that isn't made yet is made for anyone, up to a point: past thumbMakes someone
    // gets the original picture instead, so nobody can keep the server resizing without end.
    const mayMake = () => req.can.owner || thumbMakes.hit(clientKey(req.ip));
    if (width) file = await thumbnail(abs, width, config.cacheDir, { maxCacheBytes: config.thumbCacheMB * MB, trim, mayMake });

    // Pictures are asked for by the thousand as the shelf is scrolled, and a day's cache saves
    // a fresh visit asking after each again; anything else is one file a game, so it isn't.
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': `private, max-age=${thumb ? 86400 : 3600}` };
    // A file LaunchBox names can be any kind (a manual that's an .shtml page, music that's an
    // .svgz): anything but pictures, sound, video, PDF and text is sandboxed, so nothing in it
    // can run script on this origin. (Not those: Chrome won't show a PDF under a sandbox.)
    if (!SAFE_MEDIA.test(file)) headers['Content-Security-Policy'] = 'sandbox; frame-ancestors \'self\'';
    if (document) {
      headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`;
    }
    res.sendFile(file, { headers, dotfiles: 'allow' }, fileSent(res, next));
  } catch (err) {
    next(err);
  }
}

// Bodies built from the game lists, kept until something they're made from changes: the
// library itself or the DOS launcher index. They don't carry anyone's plays in this app: the
// page adds those (see /api/settings).
const bodies = new Map();
const listKey = () => [library.generation, webPlay.dosIndex];

/**
 * A function whose answer is worked out once and kept until the game lists change: for what's
 * gathered from all 25,000 versions, which every settings request or MT-32 file would
 * otherwise go through again. (A function declaration, so it's there for the top of the file.)
 */
function untilListsChange(build) {
  let entry = null;
  return () => {
    const key = listKey();
    if (!entry || entry.key.some((k, i) => k !== key[i])) entry = { key, value: build() };
    return entry.value;
  };
}

/** A body, built once and kept under `name` until the game lists change. */
function body(name, build) {
  const key = listKey();
  let entry = bodies.get(name);
  if (!entry || entry.key.some((k, i) => k !== key[i])) {
    entry = { key, json: build(), gzipped: null };
    bodies.set(name, entry);
  }
  return entry;
}

const buf = (s) => Buffer.from(s);
const gzip = promisify(zlib.gzip);

/**
 * One platform's games as a JSON array, in the owner's version (with LaunchBox's favorites and
 * play history) or everyone else's. Both routes below are made from these.
 */
/**
 * Who a game list is for: the owner (LaunchBox's favorites and plays), someone who may play (how
 * each version plays), or someone who may only browse, who isn't told there's any playing to be
 * had (see mayPlay in lib/access.js). Each is made once and kept.
 */
const audienceOf = (req) => (req.can.owner ? 'owner' : req.can.play ? 'player' : 'browse');

const gamesJson = (platform, audience) => body(`games:${audience}:${platform.name}`,
  () => buf(JSON.stringify(platform.games.filter((g) => !g.hidden).map((g) => summary(g, audience))))).json;

/**
 * Every platform with its games. The shelf loads this once and filters it from there, so it's
 * the whole library in one answer: a dozen megabytes of JSON, about a tenth of that gzipped.
 */
const libraryBody = (audience) => body(`library:${audience}`, () => Buffer.concat([
  buf('{"platforms":['),
  ...[...library.platforms.values()].flatMap((p, i) => [
    buf(`${i ? ',' : ''}{"name":${JSON.stringify(p.name)},"category":${JSON.stringify(p.category ?? '')},"logo":${Boolean(p.logoRel)},"icon":${Boolean(p.iconRel)}`
      // What LaunchBox says about the platform itself, which the shelf shows under its logo.
      + `,"about":${JSON.stringify({ releaseDate: p.releaseDate, manufacturer: p.manufacturer, developer: p.developer, specs: p.specs, notes: p.notes })}`
      + ',"games":'),
    gamesJson(p, audience),
    buf('}'),
  ]),
  buf(']}'),
]));

/**
 * Sends a prepared JSON body, gzipped when the browser takes it. The same bytes each time
 * also let Express's ETag answer repeat requests with 304.
 */
async function sendJson(req, res, entry) {
  res.vary('Accept-Encoding');
  if (req.acceptsEncodings('gzip')) {
    // Off the main thread: the whole library is a dozen megabytes, and gzipping it there would
    // hold up every other request for a moment after each reload. Requests meanwhile share it.
    entry.gzipped ??= gzip(entry.json);
    const body = await entry.gzipped;
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip' }).send(body);
  } else {
    res.type('json').send(entry.json);
  }
}

/**
 * A game's extras, with the files in its Extras folder: from the DOS launcher index when it
 * knows the game, otherwise read from the folder once.
 */
async function gameExtras(g) {
  webPlay.attachFolderExtras(g);
  return folderExtras(resolver, g);
}

/**
 * A game as the shelf lists it. LaunchBox's favorite mark and play history belong to the owner
 * (it's their LaunchBox), so only the owner's copy has them; the plays counted in this app are
 * added by the page for whoever is signed in.
 */
function summary(g, audience) {
  const owner = audience === 'owner';
  const play = audience !== 'browse';
  const versions = webPlay.versionsFor(g);
  return {
    id: g.id,
    title: g.title,
    sortTitle: g.sortTitle,
    year: g.year,
    developer: g.developer,
    publisher: g.publisher,
    genres: g.genres,
    series: g.series,
    playModes: g.playModes,
    maxPlayers: g.maxPlayers,
    communityRating: g.communityRating,
    communityVotes: g.communityVotes,
    favorite: owner ? g.favorite : false,
    playCount: owner ? g.playCount ?? 0 : 0,
    lastPlayed: owner ? g.lastPlayed ?? null : null,
    dateAdded: g.dateAdded,
    // For the details dock while browsing, which says how many versions there are and which
    // one Play would start. Only the fields it needs: the shelf carries the whole library, so
    // `broken` and `packed` are left out when they're false rather than repeated 25,000 times.
    preview: g.slots.screenshot ?? null,
    // How many pictures of that type there are, so the dock can step through them.
    shots: g.slots.screenshot ? g.images[g.slots.screenshot].length : 0,
    // Gameplay videos, which the dock plays for the game you pick. Left out when there are
    // none rather than repeated as a 0 for every game in the library.
    ...(g.videos.length && { videos: g.videos.length }),
    // And how each can be played with friends (see netplayModeOf), for the Multiplayer menu's
    // Online choices: left out when it can't be.
    // Someone who may only browse gets each version's kind alone, which the shelf's hides go by
    // (a Japanese release, a beta): nothing about playing or downloading it.
    versions: versions.map((v) => {
      if (!play) return { kind: v.kind.key };
      const { bytes, packed } = webPlay.sizeOf(v);
      const netplay = netplayModeOf(v);
      return { id: v.id, kind: v.kind.key, bytes, ...(packed && { packed: true }), ...(knownIssueFor(v) && { broken: true }), ...(netplay && { netplay }) };
    }),
    // Every browser version has a known problem (see knownIssueFor): an engine crash, too much
    // data to load, a missing file, or a helper program the browser can't run.
    ...(play && { webBroken: versions.length > 0 && versions.every((v) => knownIssueFor(v)) }),
    // eXo set a version up for network play (IPX), which the browser can play with a friend: the
    // Multiplayer menu counts a DOS or Windows game as multiplayer by it. Windows 9x games never have
    // it (lib/webplay.js doesn't read their IPX setting; DOSBox-X has no network in the browser).
    // Left out when not.
    ...(play && versions.some((v) => v.ipx) && { ipx: true }),
    cover: coverType(g),
    alternateNames: g.alternateNames,
  };
}

/**
 * A game's ScummVM ID, read from its launcher once and kept. Worth showing even when the game
 * can't be played here; a DOS game's launcher has none.
 */
async function scummvmIdOf(g, versions) {
  if (!scummvmIds.has(g.id) && /\.bat$/i.test(g.applicationRel) && !versions.some((v) => v.engine === 'dosbox')) {
    const abs = await resolveReadable(g.applicationRel);
    scummvmIds.set(g.id, abs ? await readScummvmId(abs) : null);
  }
  return scummvmIds.get(g.id) ?? null;
}

const mediaSizes = new WeakMap(); // game record -> promise of its media's size in bytes

async function detail(g, req) {
  const versions = webPlay.versionsFor(g);
  await scummvmIdOf(g, versions);
  const extras = await gameExtras(g);
  // What the art and papers on this page add to a download of any of its versions. That's a
  // look at the size of every picture and video, so it's kept with the game's record (a reload
  // of its platform makes new records, and so a new look).
  if (req.can.play && !mediaSizes.has(g)) mediaSizes.set(g, versions.length ? mediaBytes({ game: g, extras, resolver }).catch(() => 0) : Promise.resolve(0));
  const media = req.can.play ? await mediaSizes.get(g) : 0;
  return {
    ...summary(g, audienceOf(req)),
    ...(await playsFor(req, g)),
    platform: g.platform,
    releaseDate: g.releaseDate,
    notes: g.notes,
    esrb: g.esrb,
    source: g.source,
    releaseType: g.releaseType,
    region: g.region,
    communityVotes: g.communityVotes,
    databaseId: g.databaseId,
    slots: g.slots,
    images: Object.fromEntries(Object.entries(g.images).map(([type, list]) => [type, list.map((i) => i.region)])),
    videoCount: g.videos.length,
    music: g.musicRel ? { ext: path.extname(g.musicRel).slice(1).toLowerCase() } : null,
    // The manual and the files in its Extras folder: shown on the page, not on the shelf.
    manualExt: g.manualRel ? path.extname(g.manualRel).slice(1).toLowerCase() : null,
    extras: extras.map(({ id, name, ext }) => ({ id, name, ext })),
    scummvmId: scummvmIds.get(g.id) ?? null,
    // How each version plays, and what a download of it comes to: only for someone who may play.
    webVersions: !req.can.play ? [] : await Promise.all(versions.map(async (v) => ({
      id: v.id,
      engine: v.engine,
      // Console versions name their core ("Snes9x"); the others their engine.
      engineName: v.engineName ?? ENGINE_NAMES[v.engine],
      // Whether the game can be played with friends, and how (see netplayModeOf).
      netplay: netplayModeOf(v),
      label: v.label,
      gameId: v.gameId,
      // An arcade version's controls, for its on-screen buttons on a phone; a computer's are its
      // keyboard (an Apple IIgs game's buttons are keys, as a DOS game's are).
      ...(v.engine === 'mame' && { controls: v.computer ? { computer: true } : mameControls(v.setName) }),
      sounds: v.sounds.map(({ driver, label }) => ({ driver, label })),
      defaultSound: webPlay.defaultSound(v),
      knownIssue: knownIssueFor(v),
      // Plays, but with something missing (no CD music in the browser, say).
      note: v.note ?? null,
      // What the collection tells the player before the game starts ("double click Start").
      howToPlay: v.howToPlay ?? null,
      kind: v.kind,
      ...(await webPlay.statsFor(v)),
      // Roughly what a download of this version comes to, for the button that offers one. A
      // Windows 9x game can't be one: it starts from eXo's Windows disk, which is read from here.
      // Nor can a Windows 3.x or arcade game too big for the browser (see win3xBundles, mameLaunch).
      standaloneBytes: v.win9x || (v.win3x && !webPlay.win3xBundles(v)) || (v.engine === 'mame' && v.romSize > webPlay.maxMameBytes) ? null : standaloneBytes(v, await webPlay.statsFor(v), media, vendorDir),
      // A Windows game is copied into the server's cache before it can be packed; the page has
      // that done first (see the prepare route), so the download itself starts right away. One
      // too big for that has its folder zipped on the way instead (see the files route).
      ...(v.win3x && webPlay.win3xBundles(v) && req.can.play && { prepareUrl: `/api/dos/${encodeURIComponent(v.id)}/prepare` }),
      // The version's own files, for the download that's only those (see lib/gamefiles.js):
      // what the browser saves them as, and about how big.
      ...(req.can.play && gameFilesSummary(g, v, await webPlay.statsFor(v))),
    }))),
  };
}

function gameFilesSummary(game, version, stats) {
  const files = gameFiles(game, version, stats);
  return files ? { files: { name: files.name, bytes: files.bytes } } : null;
}

// The server answers at once; API requests wait for the first library load. That takes
// seconds, or a minute or more right after the PC starts, when LaunchBox's image folders
// aren't in the disk cache yet; meanwhile the app's page can show that it's loading.
const ready = (async () => {
  // Started while LaunchBox is saving a platform's XML (the end of a play): give it a few
  // seconds to finish rather than stopping on a file caught half-written.
  for (let attempt = 1; ; attempt++) {
    try {
      await library.load();
      break;
    } catch (err) {
      if (attempt >= 5 || !/is incomplete/.test(err.message)) throw err;
      console.warn(`${err.message}; trying again in 2 s`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  await webPlay.ensureIndexed();
  await playStore.load();
})();
// The activity log's old months go, at start-up and once a day.
const DAY_MS = 24 * 60 * 60 * 1000;
const pruneActivity = () => activity.prune()
  .then((removed) => removed && console.log(`Deleted ${removed} old month(s) of the activity log.`))
  .catch((err) => console.warn(`Couldn't tidy the activity log: ${err.message}`));
ready.then(pruneActivity, () => {});
setInterval(pruneActivity, DAY_MS).unref();
ready.catch((err) => {
  console.error(`The library couldn't be loaded: ${err.message}`);
  process.exit(1);
});
// Thumbnails kept from earlier runs, trimmed to their limit once the library is up.
ready.then(() => trimThumbs(config.cacheDir, config.thumbCacheMB * MB))
  .then((removed) => removed && console.log(`Deleted ${removed} old thumbnails to keep under ${config.thumbCacheMB} MB.`))
  .catch((err) => console.warn(`Couldn't trim the thumbnails: ${err.message}`));
const server = http.createServer(app);

// EmulatorJS's netplay client connects to the address in EJS_netplayServer, whose path becomes
// the socket.io namespace: the player pages point it at /api/netplay on this origin (see
// public/emu/play.html). The server handles these requests before Express sees them, so the
// host name is checked here as it is there, and a browser that names another origin is refused
// (sameOrigin, in lib/access.js).
/**
 * The client's address worked out as Express's req.ip is (same 'trust proxy' setting), for
 * requests Express never sees: a proxy on this PC other than cloudflared (which isLocalNetwork
 * knows by its headers) would otherwise make everyone look local.
 */
function forwardedAddress(req) {
  const trust = app.get('trust proxy fn');
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean).reverse();
  const hops = [req.socket.remoteAddress, ...forwarded];
  for (let i = 0; i < hops.length - 1; i++) if (!trust(hops[i], i)) return hops[i];
  return hops.at(-1);
}

const io = new SocketServer(server, {
  serveClient: false,
  // The host's save state goes down the socket when a friend joins a rollback console's game
  // (PlayStation and the other big ones stream the picture instead). Only someone let in below
  // can send one.
  maxHttpBufferSize: 64 * MB,
  // Only someone who could be in a room gets a socket: the host's page (someone who may play) or
  // a friend holding a room's code (see roomGrant). Everyone else is turned away before a message
  // as big as a save state is read. Asked once, as a connection starts.
  allowRequest: (req, cb) => {
    if (!knownHost(req.headers.host) || !sameOrigin(req)) return cb(null, false);
    if (roomGrant(req)) return cb(null, true);
    const onNetwork = isLocalNetwork({ headers: req.headers, ip: forwardedAddress(req) });
    auth.userFor(req, { internet: !onNetwork })
      .then((user) => cb(null, auth.permissionsFor(user, { local: Boolean(config.localNetworkCanPlay) && onNetwork, internet: !onNetwork, guestsCanPlay: serverSettings.guestsCanPlay }).play))
      .catch(() => cb(null, false));
  },
});
// The IPX signaling socket for DOS games (see lib/ipx.js). It's a plain WebSocket rather than
// socket.io because js-dos's client speaks its own protocol, with "humblepeer" as the
// subprotocol; it shares this port, upgrading at its own path. socket.io leaves other paths
// alone as long as something answers them promptly, which handleUpgrade does.
const ipxSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_IPX_MESSAGE, handleProtocols: (offered) => (offered.has('humblepeer') ? 'humblepeer' : false) });
server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return socket.destroy();
  }
  if (url.pathname !== '/api/ipx') return undefined;
  // The same checks socket.io's own connections get: a host we answer to, and our own origin.
  if (!knownHost(req.headers.host) || !sameOrigin(req)) return socket.destroy();
  const allowed = ipx.check({ code: url.searchParams.get('room'), key: url.searchParams.get('host') });
  if (!allowed) return socket.destroy();
  return ipxSockets.handleUpgrade(req, socket, head, (ws) => ipx.add(ws, allowed));
});

// What one socket may send. The host's save state for a friend joining is the one big message
// (see maxHttpBufferSize above); anyone else's past FRIEND_MESSAGE_BYTES ends their connection,
// so a friend holding a room's code can't have the server pass 64 MB messages round the room.
// A socket's messages past EVENTS_PER_SECOND are dropped (a game sends a few dozen a second).
const FRIEND_MESSAGE_BYTES = 4 * MB;
const EVENTS_PER_SECOND = 400;
const packetBytes = (data) => (typeof data === 'string' ? Buffer.byteLength(data) : data?.byteLength ?? 0);

io.of('/api/netplay').on('connection', (socket) => {
  const answer = (cb, ...args) => { if (typeof cb === 'function') cb(...args); };
  // A message's size: its packets as they came in (a message with binary parts comes as several).
  let received = 0;
  socket.conn.on('packet', (packet) => { received += packetBytes(packet.data); });
  let second = 0;
  let events = 0;
  socket.use((packet, next) => {
    const bytes = received;
    received = 0;
    const now = Math.floor(Date.now() / 1000);
    if (now !== second) [second, events] = [now, 0];
    if (++events > EVENTS_PER_SECOND) return undefined;
    if (bytes > FRIEND_MESSAGE_BYTES && !netplay.isHost(socket)) {
      console.log(`A netplay connection from ${socket.handshake.address} sent a ${Math.round(bytes / MB)} MB message without being a host; it was closed.`);
      return socket.disconnect(true);
    }
    return next();
  });
  socket.on('open-room', (data, cb) => {
    try {
      const room = netplay.open({ extra: data?.extra, key: data?.key }, socket);
      console.log(`${room.hostName} opened ${room.title} for friends (room ${room.code}).`);
      answer(cb, null);
    } catch (err) {
      answer(cb, err.message);
    }
  });
  socket.on('join-room', (data, cb) => {
    try {
      // A game already in the room asking again gets the players, and isn't logged twice.
      const already = netplay.placeOf(socket);
      const users = netplay.join({ extra: data?.extra }, socket);
      const place = netplay.placeOf(socket);
      if (!already) {
        console.log(`${users[data.extra.userid]?.player_name ?? 'A friend'} joined ${place.room.title} as player ${place.player} (room ${place.room.code}).`);
        // The host's own game joins its room too, as player 1; only the friends are logged.
        if (place.player > 1) recordJoin(socket, place.room, users[data.extra.userid]?.player_name);
      }
      answer(cb, null, users);
    } catch (err) {
      answer(cb, err.message);
    }
  });
  socket.on('data-message', (data) => netplay.relay(socket, data));
  // Two players introducing themselves for a direct connection (see netplay-fixes.js).
  socket.on('signal', (message) => netplay.signal(socket, message?.to, message?.data));
  // A player's numbers once a second, for the session's log (see lib/netplaylog.js).
  socket.on('report', (data) => netplay.report(socket, data));
  socket.on('disconnect', () => netplay.leave(socket));
});

// Stopping the server (Ctrl+C, or closing its window) ends the games being played first, so the
// time they'd been played until their last check-in is kept, and saves when accounts were last seen.
async function stopServer(code = 0) {
  for (const play of livePlays.list()) livePlays.end(play.id, 'lost');
  // Each 'stop' is already queued on activity.writing (see ActivityLog.record).
  await Promise.race([Promise.all([activity.writing, accounts.flush()]), new Promise((resolve) => { setTimeout(resolve, 2000); })]);
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => stopServer(0));

server.listen(config.port, config.host, () => {
  console.log(`RetroGameBrowser running at http://${config.host === '127.0.0.1' ? 'localhost' : config.host}:${config.port}`);
});
