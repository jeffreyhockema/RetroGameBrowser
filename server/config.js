import fs from 'node:fs';
import path from 'node:path';
import { projectRoot, dataDir, configFile, DEFAULT_LAUNCHBOX_ROOT, DEFAULT_PORT } from './lib/datadir.js';
import { parseJson } from './lib/util.js';

export { projectRoot, dataDir, configFile };

export const defaults = {
  // LaunchBox install. Read-only: nothing in here is ever written.
  launchboxRoot: DEFAULT_LAUNCHBOX_ROOT,
  // Tried in order when a file can't be read under launchboxRoot
  // (a folder LaunchBox reaches through a junction that no longer works, say, whose files now
  // live on another drive). None unless the config names some.
  fallbackRoots: [],
  // The LaunchBox platforms to show. Consoles play through EmulatorJS (see
  // server/lib/emulatorjs.js for the ones it supports), games LaunchBox runs with MAME through
  // its browser build (server/lib/mame.js), and eXo's Apple IIGS games through MAME's Apple IIgs
  // (server/lib/iigs.js); others are browsable only.
  platforms: [
    'ScummVM', 'MS-DOS', 'Windows 3x', 'Windows 9x', 'Arcade', 'Apple IIGS', 'Commodore 64',
    'Nintendo Entertainment System', 'Super Nintendo Entertainment System', 'Nintendo 64',
    'Sega Genesis', 'Sega 32X', 'Sega CD', 'Sega Saturn', 'Sony Playstation', 'NEC TurboGrafx-16', 'SNK Neo Geo AES',
    'Atari 2600', 'Atari 5200', 'Atari 7800', 'Atari Jaguar',
  ],
  host: '127.0.0.1',
  // An installed copy answers at 6502 (the Atari's and NES's CPU), out of the way of the 3000 that
  // development servers like; run from the project folder it's 3000.
  port: DEFAULT_PORT,
  // Host names this server answers to besides localhost, this PC's own name and bare IP
  // addresses: the public hostname of a tunnel that brings requests in (see docs/guide.md, Cloudflare
  // Tunnel), or another name the network knows this PC by. Any other name is refused.
  allowedHosts: [],
  // Google sign-in (see server/lib/auth.js and docs/guide.md). Without a client ID, and with local
  // accounts off (the admin page), there are no accounts: everyone on the local network can play
  // (the admin page is then this PC's alone) while requests from the internet (through a
  // tunnel, say) can only browse. owner:
  // the account whose LaunchBox this is; players: accounts that may play and download games.
  auth: { googleClientId: '', owner: '', players: [] },
  // Anyone on the local network (this PC, or a private address like 192.168.x.x) may play and
  // download games without signing in. Requests through a tunnel never count as local.
  localNetworkCanPlay: true,
  // What people do here (visits, plays, downloads, failures, sign-ins, games with friends), for
  // the owner's admin page: a file a month in userdata/activity/, kept this many months.
  activity: { keepMonths: 24 },
  cacheDir: path.join(dataDir, 'cache'),
  // Thumbnails of box art and screenshots, made as the shelf asks for them (cache/thumbs). Past
  // this size the oldest are deleted, and made again if they're asked for again.
  thumbCacheMB: 3000,
  // DOS games are loaded whole into the browser's memory (the zip plus its unpacked files
  // must fit in the emulator's 2 GB). Bigger games are shown as not playable here.
  dosMaxBundleMB: 700,
  // Windows 3.x games aren't zipped: eXo installs each one, with its own copy of Windows, into
  // a folder, which the server sends uncompressed. The browser holds the whole download and the
  // emulator's copy of it, so this counts the game's folder rather than a zip. Games of 1.5 GB
  // started here; the browser refuses a download over about 2 GB.
  win3xMaxBundleMB: 1200,
  // Windows 9x games start eXo's copy of Windows 98 and read it and the game's hard disk from
  // the server a piece at a time, but their CD images (and the zips some mount as a drive) are
  // loaded into memory like a DOS game's zip; this counts those.
  win9xMaxBundleMB: 1200,
  // Which js-dos build runs DOS games: 'dosboxX' (DOSBox-X: MT-32/soundfont music, stable here)
  // or 'dosbox' (plain DOSBox: smaller, but crashed and left stale frames in testing).
  dosBackend: 'dosboxX',
  // Console games bigger than this are shown as not playable in the browser, which keeps the
  // ROM (and, for CD games, its unpacked tracks) in memory.
  emulatorMaxRomMB: 1024,
  // Arcade games bigger than this (their zips and disk images together) are shown as not
  // playable in the browser, which holds all of them in memory while MAME runs.
  mameMaxGameMB: 1024,
  // CD games packed as .7z/.rar are unpacked once on the server (with LaunchBox's own 7-Zip,
  // relative to launchboxRoot) into cache/roms, which is kept under romCacheMB. Archives
  // smaller than romUnpackMinMB are left to the browser, which unpacks those quickly.
  sevenZipPath: 'ThirdParty\\7-Zip\\7z.exe',
  romCacheMB: 20000,
  romUnpackMinMB: 32,
  // Playing a console game with a friend through EmulatorJS's netplay (see
  // server/lib/netplay.js). maxRooms: games hosted at once. iceServers: the STUN servers the
  // players' browsers use to find a direct path to each other for the inputs (Google's public
  // ones do for most home networks); a TURN server, which relays where there's no direct
  // path, goes in the same list as { urls, username, credential }. Without a path the inputs
  // go through this server instead, which works but adds the trip. keepLogs: how many
  // sessions' logs (userdata/netplay-logs/, see server/lib/netplaylog.js) are kept.
  // maxIpxPeers: the most players in one DOS game over IPX (see server/lib/ipx.js).
  netplay: {
    maxRooms: 100,
    keepLogs: 200,
    maxIpxPeers: 8,
    iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
  },
};

/** A config file's settings (see parseJson). */
const readConfig = (file) => parseJson(fs.readFileSync(file, 'utf8'), file);

/** config.local.json, in the data folder (see lib/datadir.js): what the setup page wrote, or the owner. */
export function loadLocal() {
  return fs.existsSync(configFile) ? readConfig(configFile) : {};
}

/** A further config file named by RGB_CONFIG, over config.local.json: a test server's, say. */
function loadExtra() {
  const file = process.env.RGB_CONFIG;
  return file ? readConfig(path.resolve(projectRoot, file)) : {};
}

const config = {};

/**
 * Reads the config files again, into the same object: the setup page (see server/start.js) calls
 * this once it has written config.local.json, before the app that reads `config` is loaded.
 */
export function reloadConfig() {
  const local = loadLocal();
  const extra = loadExtra();
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, defaults, local, extra);
  // These sections are merged a setting at a time, so setting netplay.maxRooms alone keeps the
  // default STUN servers. (auth is replaced whole: a test server's config names its own players.)
  for (const key of ['netplay', 'activity']) config[key] = { ...defaults[key], ...local[key], ...extra[key] };
  if (process.env.LB_ROOT) config.launchboxRoot = process.env.LB_ROOT;
  if (process.env.PORT) config.port = Number(process.env.PORT);
  if (process.env.HOST) config.host = process.env.HOST;
  return config;
}
reloadConfig();

export default config;
