// The setup page: what a new copy shows first (see start.js), until its owner has pointed it at
// their LaunchBox, said who on the network may open it, and chosen how people sign in (Google,
// local accounts, both or neither). Finishing writes config.local.json (and, for local accounts,
// the owner's account and the switch that turns them on), then hands the port over to the app.
//
// It answers only on this PC (127.0.0.1, and only to the host name localhost), whatever the
// config says: until it's done, anyone who could reach it could choose the owner.

import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import config, { configFile, loadLocal, projectRoot } from './config.js';
import { dataDir, logsDir, userdataDir, installed } from './lib/datadir.js';
import { LocalUsers, usernameProblem, passwordProblem } from './lib/localusers.js';
import { ServerSettings, writeJson } from './lib/settings.js';
import { invalid, parseJson } from './lib/util.js';

// How long a folder may take to answer: a network share that's asleep or gone can take a minute.
const CHECK_MS = 15_000;
const FIND_MS = 4000;

const CLIENT_ID = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** The Windows account this server runs as ("LOCAL SERVICE" for the installed service). */
export function accountName() {
  try {
    return os.userInfo().username;
  } catch {
    return 'this service\'s account';
  }
}

/** `promise`, or `fallback` if it hasn't settled within `ms`. */
function within(ms, promise, fallback) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]).finally(() => clearTimeout(timer));
}

const TIMED_OUT = Symbol('timed out');

/** Tries fn(); its error, or TIMED_OUT, is returned rather than thrown. */
async function attempt(ms, fn) {
  try {
    return await within(ms, fn().then((value) => ({ value })), TIMED_OUT);
  } catch (err) {
    return { err };
  }
}

const denied = (err) => ['EPERM', 'EACCES'].includes(err?.code);

/** What to say when this server isn't allowed to read a folder. */
function accessProblem(dir, { service, account }) {
  return service
    ? `The RetroGameBrowser service runs as ${account}, which isn't allowed to read ${dir}. That's usual for a folder inside someone's user folder (C:\\Users\\…) or on a network share. In the Start menu, open RetroGameBrowser → "Run the service as a Windows account", give it your Windows account, then check again.`
    : `This Windows account (${account}) isn't allowed to read ${dir}.`;
}

/**
 * Whether `input` is a LaunchBox folder this server can read: { ok, path, found, missing, others }
 * with the platforms it has that RetroGameBrowser shows (found) and doesn't (missing), and how
 * many others it has; or { ok: false, problem, suggestion? }.
 */
export async function checkLaunchBox(input, { platforms = config.platforms, service = installed, account = accountName() } = {}) {
  const fail = (problem, extra = {}) => ({ ok: false, problem, ...extra });
  const given = String(input ?? '').trim().replace(/^"(.*)"$/, '$1').trim();
  if (!given) return fail('Enter the folder LaunchBox is installed in.');
  if (!path.isAbsolute(given) || (process.platform === 'win32' && !/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(given.replace(/\//g, '\\')))) {
    return fail('Enter the whole path, starting with the drive, such as C:\\Users\\you\\LaunchBox, or a network path such as \\\\server\\share\\LaunchBox.');
  }
  const dir = path.resolve(given).replace(/[\\/]+$/, '') || given;
  const drive = /^([A-Za-z]):/.exec(dir)?.[1]?.toUpperCase();
  if (drive) {
    const root = await attempt(FIND_MS, () => fs.stat(`${drive}:\\`));
    if (root === TIMED_OUT || root.err) {
      return fail(service
        ? `${drive}: isn't a drive the RetroGameBrowser service can see. A mapped network drive belongs to the Windows account that mapped it: enter the network path instead, such as \\\\server\\share\\LaunchBox (File Explorer shows it under This PC).`
        : `There's no ${drive}: drive on this PC.`);
    }
  }
  const listing = await attempt(CHECK_MS, () => fs.readdir(dir));
  if (listing === TIMED_OUT) return fail(`${dir} took too long to answer. If it's on another computer, check that it's switched on and shared.`);
  if (listing.err) {
    if (denied(listing.err)) return fail(accessProblem(dir, { service, account }));
    if (listing.err.code === 'ENOENT') return fail(`There's no folder at ${dir}.`);
    if (listing.err.code === 'ENOTDIR') return fail(`${dir} is a file. Enter the folder LaunchBox is installed in.`);
    return fail(`Couldn't open ${dir}: ${listing.err.message}`);
  }
  const platformsXml = path.join(dir, 'Data', 'Platforms.xml');
  const read = await attempt(CHECK_MS, async () => {
    const handle = await fs.open(platformsXml, 'r');
    try {
      await handle.read(Buffer.alloc(1), 0, 1, 0);
    } finally {
      await handle.close();
    }
  });
  if (read === TIMED_OUT) return fail(`${dir} took too long to answer.`);
  if (read.err) {
    if (denied(read.err)) return fail(accessProblem(dir, { service, account }));
    // The folder above LaunchBox's, say.
    const inside = listing.value.find((name) => name.toLowerCase() === 'launchbox');
    if (inside) {
      const nested = path.join(dir, inside);
      const there = await attempt(FIND_MS, () => fs.access(path.join(nested, 'Data', 'Platforms.xml')));
      if (there !== TIMED_OUT && !there.err) return fail(`LaunchBox is in the folder inside this one: ${nested}.`, { suggestion: nested });
    }
    return fail(`This doesn't look like LaunchBox's folder: there's no Data\\Platforms.xml in ${dir}. It's the folder with LaunchBox.exe in it.`);
  }
  const names = await attempt(CHECK_MS, () => fs.readdir(path.join(dir, 'Data', 'Platforms')));
  const has = new Set(names === TIMED_OUT || names.err ? [] : names.value.filter((n) => /\.xml$/i.test(n)).map((n) => n.slice(0, -4).toLowerCase()));
  const found = platforms.filter((p) => has.has(p.toLowerCase()));
  const shown = new Set(platforms.map((p) => p.toLowerCase()));
  return {
    ok: true,
    path: dir,
    found,
    missing: platforms.filter((p) => !has.has(p.toLowerCase())),
    others: [...has].filter((n) => !shown.has(n)).length,
  };
}

/**
 * LaunchBox folders worth offering: the usual places on every drive, and each user's own
 * (LaunchBox installs into C:\Users\<name>\LaunchBox). Also the user folders this server can't
 * look inside, where one may be that it can't see.
 */
export async function findLaunchBoxes({ current = null } = {}) {
  const places = new Set();
  if (current) places.add(current);
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const drives = (await Promise.all(letters.map(async (l) => {
    const r = await attempt(FIND_MS, () => fs.stat(`${l}:\\`));
    return r !== TIMED_OUT && !r.err ? l : null;
  }))).filter(Boolean);
  for (const l of drives) for (const rel of ['LaunchBox', 'Games\\LaunchBox', 'Emulation\\LaunchBox']) places.add(`${l}:\\${rel}`);
  const unreadableProfiles = [];
  const usersDir = `${process.env.SystemDrive ?? 'C:'}\\Users`;
  const users = await attempt(FIND_MS, () => fs.readdir(usersDir, { withFileTypes: true }));
  if (users !== TIMED_OUT && !users.err) {
    await Promise.all(users.value.filter((e) => e.isDirectory() && !/^(public|default|default user|all users)$/i.test(e.name)).map(async (e) => {
      const profile = path.join(usersDir, e.name);
      const inside = await attempt(FIND_MS, () => fs.readdir(profile));
      if (inside === TIMED_OUT) return;
      if (inside.err) {
        if (denied(inside.err)) unreadableProfiles.push(profile);
        return;
      }
      places.add(path.join(profile, 'LaunchBox'));
      places.add(path.join(profile, 'Documents', 'LaunchBox'));
    }));
  }
  const found = (await Promise.all([...places].map(async (dir) => {
    const r = await attempt(FIND_MS, () => fs.access(path.join(dir, 'Data', 'Platforms.xml')));
    return r !== TIMED_OUT && !r.err ? dir : null;
  }))).filter(Boolean);
  return { found: [...new Set(found)], unreadableProfiles: unreadableProfiles.sort() };
}

/** "games.example.com" from what someone typed: a bare name, or an address with https:// and a path. */
export function cleanHostname(input) {
  let text = String(input ?? '').trim().toLowerCase();
  if (!text) return '';
  if (!/^[a-z]+:\/\//.test(text)) text = `https://${text}`;
  try {
    return new URL(text).hostname;
  } catch {
    return null;
  }
}

/**
 * Checks what the setup page sent, all of it before anything is written: returns what to write.
 * `localOwner`: the username of an owner's local account already made (setup gone through again).
 */
export async function planSetup(body, { localOwner = null, check = checkLaunchBox } = {}) {
  const b = body ?? {};
  const launchbox = await check(b.launchboxRoot);
  if (!launchbox.ok) throw invalid(launchbox.problem, 400, { step: 'launchbox' });
  if (!['network', 'this-pc'].includes(b.network)) throw invalid('Choose who can open RetroGameBrowser.', 400, { step: 'network' });

  let google = null;
  if (b.google) {
    const clientId = String(b.google.clientId ?? '').trim();
    const owner = String(b.google.owner ?? '').trim().toLowerCase();
    const hostname = cleanHostname(b.google.hostname);
    if (!CLIENT_ID.test(clientId)) throw invalid('That isn\'t a Google client ID: it ends in .apps.googleusercontent.com.', 400, { step: 'google', field: 'clientId' });
    if (!EMAIL.test(owner) || owner.endsWith('@local')) throw invalid('Enter the Google address you\'ll sign in with.', 400, { step: 'google', field: 'owner' });
    if (hostname === null || (hostname && !HOSTNAME.test(hostname))) throw invalid('That isn\'t a web address. Enter one like games.example.com, or leave it empty.', 400, { step: 'google', field: 'hostname' });
    google = { clientId, owner, hostname };
  }

  let local = null;
  if (b.local?.enabled) {
    local = { signup: Boolean(b.local.signup), owner: null };
    // Without Google the owner is a local account, made here, or there'd be nobody to sign in as.
    if (!google && !localOwner) {
      const o = b.local.owner ?? {};
      const username = String(o.username ?? '').trim().toLowerCase();
      const problem = usernameProblem(username) ?? passwordProblem(o.password, { username });
      if (problem) throw invalid(problem, 400, { step: 'local', field: usernameProblem(username) ? 'username' : 'password' });
      local.owner = { username, name: String(o.name ?? '').trim().slice(0, 60), password: o.password };
    }
  }
  return { launchboxRoot: launchbox.path, host: b.network === 'network' ? '0.0.0.0' : '127.0.0.1', google, local };
}

/** Writes what planSetup worked out: the owner's local account, the server's switches, then config.local.json. */
export async function applySetup(plan, { configPath = configFile, usersDir = userdataDir } = {}) {
  if (plan.local?.owner) {
    const users = await new LocalUsers(path.join(usersDir, 'local-users.json')).load();
    await users.create({ ...plan.local.owner, owner: true });
  }
  const settings = new ServerSettings(path.join(usersDir, 'server.json'));
  await settings.load();
  await settings.update({
    localLogins: Boolean(plan.local),
    localSignup: Boolean(plan.local?.signup),
    ...(plan.google?.hostname && { publicUrl: `https://${plan.google.hostname}` }),
  });
  // What was there before (setup gone through again, or settings added by hand) is kept.
  const existing = configPath === configFile ? loadLocal() : await fs.readFile(configPath, 'utf8').then((text) => parseJson(text, configPath), () => ({}));
  const next = { ...existing, launchboxRoot: plan.launchboxRoot, host: plan.host };
  if (plan.google) {
    next.auth = { ...existing.auth, googleClientId: plan.google.clientId, owner: plan.google.owner };
    if (plan.google.hostname) next.allowedHosts = [...new Set([...(existing.allowedHosts ?? []), plan.google.hostname])];
  } else if (existing.auth) {
    // No Google: an owner named here would keep the owner's local account from counting.
    next.auth = { ...existing.auth, googleClientId: '', owner: '' };
  }
  await writeJson(configPath, next);
  return next;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const POLICY = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Serves the setup page on this PC until it's finished; resolves once the port is free again for
 * the app. Rejects when the port can't be had (another copy already running, say).
 */
export function runSetup({ port = config.port } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
      res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      // A web page elsewhere could point a name of its own at 127.0.0.1 (DNS rebinding) and send
      // its own choices; the host name and origin give it away.
      const host = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
      if (!LOCAL_HOSTS.has(host)) return res.status(403).type('text/plain').send(`Setup answers only at http://localhost:${port}, on this PC.`);
      if (!['GET', 'HEAD'].includes(req.method)) {
        const origin = req.headers.origin;
        if ((origin && origin !== `http://${req.headers.host}`) || req.headers['x-requested-with'] !== 'RetroGameBrowser') return res.status(403).json({ error: 'Not from the setup page.' });
      }
      return next();
    });

    let finished = false;
    let busy = false;

    app.get('/api/setup', async (req, res, next) => {
      try {
        const current = loadLocal();
        const users = await new LocalUsers(path.join(userdataDir, 'local-users.json')).load();
        res.set('Cache-Control', 'no-store').json({
          setup: true,
          installed,
          account: accountName(),
          pcName: os.hostname(),
          port,
          dataDir,
          configFile,
          logsDir,
          platforms: config.platforms,
          // What's set already, when setup is gone through again.
          current: {
            launchboxRoot: current.launchboxRoot ?? null,
            host: current.host ?? null,
            google: current.auth?.googleClientId ? { clientId: current.auth.googleClientId, owner: current.auth.owner ?? '', hostname: current.allowedHosts?.[0] ?? '' } : null,
          },
          localOwner: users.owner(),
        });
      } catch (err) {
        next(err);
      }
    });
    app.get('/api/setup/find', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store').json(await findLaunchBoxes({ current: loadLocal().launchboxRoot }));
      } catch (err) {
        next(err);
      }
    });
    app.post('/api/setup/launchbox', express.json({ limit: '4kb' }), async (req, res, next) => {
      try {
        res.json(await checkLaunchBox(req.body?.path));
      } catch (err) {
        next(err);
      }
    });
    app.post('/api/setup/finish', express.json({ limit: '8kb' }), async (req, res, next) => {
      if (finished || busy) return res.status(409).json({ error: 'Setup is already finishing.' });
      busy = true;
      try {
        const users = await new LocalUsers(path.join(userdataDir, 'local-users.json')).load();
        const plan = await planSetup(req.body, { localOwner: users.owner() });
        await applySetup(plan);
        finished = true;
        const how = [plan.google && `Google sign-in (owner ${plan.google.owner})`, plan.local && `local accounts${plan.local.owner ? ` (owner ${plan.local.owner.username})` : ''}`].filter(Boolean).join(' and ') || 'no sign-in';
        console.log(`Setup finished: LaunchBox at ${plan.launchboxRoot}, ${plan.host === '0.0.0.0' ? 'open to the local network' : 'this PC only'}, ${how}. Wrote ${configFile}.`);
        res.json({ ok: true, host: plan.host, google: Boolean(plan.google), hostname: plan.google?.hostname || null, local: Boolean(plan.local), localOwner: plan.local?.owner?.username ?? users.owner() });
        // Once the answer is out, the port goes to the app.
        res.on('finish', () => setImmediate(() => {
          server.close(() => resolve());
          server.closeAllConnections();
        }));
      } catch (err) {
        if (err.status) res.status(err.status).json({ error: err.message, step: err.step, field: err.field });
        else next(err);
      } finally {
        busy = false;
      }
    });
    app.use('/api', (req, res) => res.status(503).json({ error: 'RetroGameBrowser is being set up.' }));
    app.use(express.static(path.join(projectRoot, 'public'), { index: false }));
    // Every other page is the setup page, so whatever address the browser opens shows it.
    app.use((req, res) => {
      if (!['GET', 'HEAD'].includes(req.method)) return res.status(404).end();
      return res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': POLICY }).sendFile(path.join(projectRoot, 'public', 'setup.html'));
    });
    app.use((err, req, res, next) => {
      // A request that couldn't be read (bad JSON, too big) is the browser's mistake, not ours.
      const status = err.status >= 400 && err.status < 500 ? err.status : 500;
      if (status === 500) console.error(`Setup: ${err.stack ?? err}`);
      if (res.headersSent) return next(err);
      return res.status(status).json({ error: status === 500 ? err.message : 'That request couldn\'t be read.' });
    });

    const server = http.createServer(app);
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') console.error(`Port ${port} is taken by another program (another copy of RetroGameBrowser, say), so setup can't start.`);
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`RetroGameBrowser isn't set up yet. On this PC, open http://localhost:${port} to set it up.`);
    });
  });
}
