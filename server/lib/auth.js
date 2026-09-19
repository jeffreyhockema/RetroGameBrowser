// Signing in (with Google, or with a local account: see lib/localusers.js), and what each
// account may do.
//
// Anyone can browse. Signing in keeps your own favorites; the accounts the owner lets play (on
// the admin page, or in the config's players list, see lib/accounts.js) can also play and
// download games, and have their plays counted. A blocked account can't sign in. The owner is the account whose
// LaunchBox this is: its favorites and play history are that account's, and so are the
// settings and plays this app kept before there were accounts (userdata/settings.json and
// plays.json).
//
// With no Google client ID in the config and local accounts turned off there are no accounts at
// all: everyone on the local network is treated as the owner, as before, bar the admin page and
// the server's settings, which are this PC's alone (see isThisPc); requests from the internet
// can only browse.
//
// The owner can also let guests in, from Settings (for a demo, say): while that's on, anyone
// not signed in may play and download games too (see ServerSettings in settings.js).
//
// Google's sign-in button hands the page a signed token (a JWT) saying who signed in; the
// server has Google check it (its tokeninfo endpoint) rather than checking the signature
// itself, which keeps this free of dependencies. That's one request to Google per sign-in.
// A session is then a random token in an HttpOnly cookie; userdata/sessions.json keeps its hash.

import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { readJson, writeJson } from './settings.js';
import { localUsername } from './localusers.js';
import { lowerEmail as lower, isLoopback, cookieValue } from './util.js';

const COOKIE = 'rgb_session';          // over plain http (the local network)
const SECURE_COOKIE = '__Host-rgb_session'; // over https (see cookieName)
// Sessions are kept by the hash of their token (see load); earlier ones aren't, and are dropped.
const SESSION_VERSION = 2;
const SESSION_DAYS = 60;
// Sessions one account keeps at once (phone, PC, a few browsers). A sign-in token from Google
// stays valid for an hour and could be sent again and again; past this, the oldest sessions go.
const MAX_SESSIONS_PER_ACCOUNT = 10;
const GOOGLE_TIMEOUT_MS = 10_000;
const DAY = 24 * 60 * 60 * 1000;
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/** What an account may do. `admin`: the admin page and the server's own settings. */
const NOBODY = Object.freeze({ owner: false, admin: false, play: false, favorites: false });
const EVERYTHING = Object.freeze({ owner: true, admin: true, play: true, favorites: true });
// The local network where there are no accounts: the owner's library, favorites and plays are
// everyone's, but the admin page answers only on this PC itself (see isThisPc).
const HOUSEHOLD = Object.freeze({ owner: true, admin: false, play: true, favorites: true });
// Someone not signed in, while the owner lets guests play (a demo): everything but the owner's
// own things. Their favorites stay in their browser, since there's no account to keep them in.
const GUEST = Object.freeze({ owner: false, admin: false, play: true, favorites: true });

export class Auth {
  /**
   * @param {object} options
   * @param {object} options.settings  config.auth: { googleClientId, owner, players: [emails] }
   * @param {string} options.file      where sessions are kept
   * @param {import('./accounts.js').Accounts} [options.accounts]  what each account may do; without
   *   it, the config's players list says who may play
   * @param {import('./localusers.js').LocalUsers} [options.localUsers]  the local accounts
   * @param {() => boolean} [options.localLogins]  whether local accounts are turned on just now
   */
  constructor({ settings = {}, file, accounts = null, localUsers = null, localLogins = () => false }) {
    this.clientId = String(settings.googleClientId ?? '').trim();
    this.owner = lower(settings.owner);
    this.players = new Set((settings.players ?? []).map(lower).filter(Boolean));
    this.accounts = accounts;
    this.localUsers = localUsers;
    this.localLogins = localLogins;
    this.file = file;
    this.sessions = null; // token -> { email, name, picture, expires }
    this.writing = Promise.resolve();
  }

  /** Whether Google sign-in is set up (a client ID in the config). */
  get google() {
    return Boolean(this.clientId);
  }

  /** Whether local accounts can sign in just now (the owner's switch on the admin page). */
  get local() {
    return Boolean(this.localUsers) && this.localLogins();
  }

  /** Whether there are accounts at all: either way of signing in. */
  get enabled() {
    return this.google || this.local;
  }

  /**
   * What someone may do: everything where there are no accounts, bar the admin page, which is
   * then this PC's alone (`thisPc`, see isThisPc); otherwise what their account allows, and
   * playing on top of that for anyone on the local network (see isLocalNetwork).
   */
  permissionsFor(user, { local = false, internet = false, thisPc = false, guestsCanPlay = false } = {}) {
    // Without accounts there's nobody to tell apart, so whoever reaches the server from the
    // internet (a tunnel set up before signing in was) can browse and nothing more, unless the
    // owner has let guests in.
    if (!this.enabled) return internet ? (guestsCanPlay ? GUEST : NOBODY) : thisPc ? EVERYTHING : HOUSEHOLD;
    const email = lower(user?.email);
    if (email && (email === this.owner || this.#access(email) === 'owner')) return EVERYTHING;
    if (!user) return guestsCanPlay ? GUEST : local ? { ...NOBODY, play: true } : NOBODY;
    // A signed-in account never has less than a guest.
    return { owner: false, admin: false, play: local || guestsCanPlay || this.#access(email) === 'play', favorites: true };
  }

  #access(email) {
    if (this.accounts) return this.accounts.access(email);
    return email === this.owner ? 'owner' : this.players.has(email) ? 'play' : 'browse';
  }

  /**
   * The saved sessions: sha-256 of the cookie's token -> { email, name, picture, expires,
   * secure, uid }. Only the hash is kept, so a copy of the file can't be used to sign in. A file
   * that can't be read (locked by another program, say) is an error rather than "no sessions":
   * the next sign-in would otherwise save over everyone's.
   */
  async load() {
    if (this.sessions) return this.sessions;
    this.loading ??= readJson(this.file, {})
      .then((saved) => {
        // Sessions from before tokens were kept hashed (no `v`) are dropped: they're signed in again.
        this.sessions = new Map(Object.entries(saved).filter(([, s]) => s?.v === SESSION_VERSION && s.expires > Date.now()));
        return this.sessions;
      })
      .finally(() => { this.loading = null; });
    return this.loading;
  }

  /** Writes the sessions, one write after another. A save that fails says so, and rejects. */
  save() {
    const data = Object.fromEntries([...this.sessions].filter(([, s]) => s.expires > Date.now()));
    const run = this.writing.then(() => writeJson(this.file, data, { mode: 0o600 }));
    this.writing = run.catch((err) => console.warn(`Couldn't save sessions: ${err.message}`));
    return run;
  }

  /**
   * The signed-in account on a request, or null. `internet`: the request came from outside the
   * local network, where a session started over plain http (on the network, where its cookie
   * could have been read on the way) doesn't count.
   */
  async userFor(req, { internet = false } = {}) {
    if (!this.enabled) return null;
    const token = cookieValue(req.headers?.cookie, cookieName(req));
    if (!token) return null;
    let sessions;
    try {
      sessions = await this.load();
    } catch (err) {
      console.warn(`Couldn't read sessions: ${err.message}`);
      return null;
    }
    const session = sessions.get(tokenHash(token));
    if (!session || session.expires <= Date.now()) return null;
    if (internet && !session.secure) return null;
    // Blocked since signing in (the admin page ends their sessions too; this covers a file edited by hand).
    if (this.#access(session.email) === 'blocked') return null;
    const username = localUsername(session.email);
    if (username) {
      // A local account counts only while local accounts are on, while it still exists, and while
      // its password is the one the session was started with (its uid, see lib/localusers.js);
      // its name is the one it has now, which the owner may have changed since.
      const user = this.local && session.uid && session.uid === this.localUsers.uid(username) ? this.localUsers.user(username) : null;
      return user ? { ...user, local: true, username } : null;
    }
    if (!this.google) return null;
    return { email: session.email, name: session.name, picture: session.picture };
  }

  /**
   * Checks the token Google's button gave the page, and returns who it's for. Throws (with a
   * status) when it isn't a current token for this app from a verified Google account.
   */
  async verifyGoogle(credential) {
    if (typeof credential !== 'string' || credential.length > 4096) throw status(400, 'No sign-in token was sent.');
    let info;
    try {
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, { signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
      info = await res.json();
      if (!res.ok) throw status(401, 'Google didn\'t accept that sign-in. Try again.');
    } catch (err) {
      if (err.status) throw err;
      throw status(502, `Couldn't reach Google to check the sign-in: ${err.message}`);
    }
    if (info.aud !== this.clientId) throw status(401, 'That sign-in was for a different app.');
    if (!GOOGLE_ISSUERS.has(info.iss)) throw status(401, 'That sign-in didn\'t come from Google.');
    if (Number(info.exp) * 1000 <= Date.now()) throw status(401, 'That sign-in has expired. Try again.');
    if (info.email_verified !== true && info.email_verified !== 'true') throw status(401, 'That Google account\'s email address isn\'t verified.');
    return { email: lower(info.email), name: String(info.name ?? '').slice(0, 200), picture: String(info.picture ?? '').slice(0, 1000) };
  }

  /**
   * Starts a session for an account and sets its cookie on the response: always a new token, so
   * one someone else planted in the browser beforehand never becomes a signed-in session. A local
   * account's session keeps its uid (see userFor).
   */
  async signIn(req, res, user) {
    if (this.#access(user.email) === 'blocked') throw status(403, 'This account can\'t sign in here.');
    const token = crypto.randomBytes(32).toString('base64url');
    const key = tokenHash(token);
    const expires = Date.now() + SESSION_DAYS * DAY;
    const username = localUsername(user.email);
    const sessions = await this.load();
    // This browser's earlier session, if it had one, ends: it's replaced, not added to.
    const earlier = cookieValue(req.headers?.cookie, cookieName(req));
    if (earlier) sessions.delete(tokenHash(earlier));
    sessions.set(key, {
      v: SESSION_VERSION,
      email: user.email,
      name: user.name ?? '',
      picture: user.picture ?? '',
      expires,
      secure: isSecureRequest(req),
      ...(username && { uid: this.localUsers?.uid(username) ?? null }),
    });
    // The account's newest sessions only (see MAX_SESSIONS_PER_ACCOUNT).
    const own = [...sessions].filter(([, s]) => s.email === user.email).sort(([, a], [, b]) => b.expires - a.expires);
    for (const [old] of own.slice(MAX_SESSIONS_PER_ACCOUNT)) sessions.delete(old);
    try {
      await this.save();
    } catch (err) {
      // A session that isn't on disk would quietly end at the next restart: the sign-in fails instead.
      sessions.delete(key);
      throw err;
    }
    res.setHeader('Set-Cookie', cookie(cookieName(req), token, { maxAge: SESSION_DAYS * DAY / 1000, secure: isSecureRequest(req) }));
  }

  /**
   * Ends every session of an account (signing it out everywhere), or of every account `email`
   * says yes to when it's a function. Returns how many there were. Rejects when the sessions
   * file can't be saved: they've ended for this run, but would be back after a restart, which
   * whoever asked should hear about. (A local account's are ended for good by its new uid.)
   */
  async endSessions(email) {
    const sessions = await this.load();
    const matches = typeof email === 'function' ? email : (e) => e === lower(email);
    let ended = 0;
    for (const [key, s] of sessions) {
      if (!matches(s.email)) continue;
      sessions.delete(key);
      ended++;
    }
    if (ended) await this.save();
    return ended;
  }

  /** How many sessions each account has open, and when the newest was started. */
  async sessionCounts() {
    const counts = new Map();
    for (const s of (await this.load()).values()) {
      if (s.expires <= Date.now()) continue;
      const entry = counts.get(s.email) ?? { sessions: 0, newest: 0 };
      entry.sessions++;
      entry.newest = Math.max(entry.newest, s.expires);
      counts.set(s.email, entry);
    }
    return counts;
  }

  /** Ends the request's session, if it has one, and clears its cookie. */
  async signOut(req, res) {
    const token = cookieValue(req.headers?.cookie, cookieName(req));
    // The cookie is cleared even if the file can't be saved just now (the save has said so).
    if (token && (await this.load()).delete(tokenHash(token))) await this.save().catch(() => {});
    res.setHeader('Set-Cookie', cookie(cookieName(req), '', { maxAge: 0, secure: isSecureRequest(req) }));
  }
}

const status = (code, message) => Object.assign(new Error(message), { status: code });

/** What a session is kept under: the sha-256 of its token, never the token itself. */
const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url');

/**
 * Whether a request came over https: Express says so (see "trust proxy" in index.js), and for a
 * request Express hasn't seen (socket.io's), a local tunnel's X-Forwarded-Proto does, which only
 * a connection from this PC may send.
 */
export function isSecureRequest(req) {
  if (typeof req.secure === 'boolean') return req.secure;
  return isLoopback(req.socket?.remoteAddress) && String(req.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

/**
 * The session cookie's name. Over https it has the __Host- prefix, which a browser only takes
 * from this host itself, over https, for the whole site: a page on another subdomain of the same
 * domain can't plant one. Plain http (the local network) can't have that prefix, so it keeps
 * the plain name, which is never read over https.
 */
const cookieName = (req) => (isSecureRequest(req) ? SECURE_COOKIE : COOKIE);

/**
 * The names this PC goes by on the local network: localhost, its own name (and name.local), and
 * any address. A request that reaches the server through this PC's own loopback address, but asks
 * for some other name (a public one), came through a tunnel or proxy running here.
 */
function isLocalName(hostHeader = '') {
  let host = String(hostHeader).toLowerCase();
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'));
  else host = host.replace(/:\d+$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || net.isIP(host)) return true;
  const pc = os.hostname().toLowerCase();
  return host === pc || host === `${pc}.local`;
}

/**
 * Whether a request comes from the local network (this PC, or a private address such as
 * 192.168.x.x), where games can be played without signing in, and where, with no accounts, the
 * owner is. The address is the one the connection came from. A tunnel on this PC connects from
 * localhost too, so a request is from the internet whatever address it arrived on when it
 * carries Cloudflare's headers, a forwarded address from outside (Express only takes those from
 * a local connection, see "trust proxy" in index.js, so nobody on the network can claim one), or
 * when it came in on this PC's loopback address asking for a name that isn't a local one: what a
 * tunnel or proxy other than Cloudflare's forwards.
 */
export function isLocalNetwork(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return false;
  if (!isPrivateAddress(req.ip)) return false;
  if (isLoopback(req.ip) && !isLocalName(req.headers.host)) return false;
  return true;
}

/**
 * Whether a request was made on this PC itself (http://localhost), rather than from another
 * device on the network or through a tunnel running here: where the admin page answers while
 * there are no accounts to tell the owner by.
 */
export const isThisPc = (req) => isLocalNetwork(req) && isLoopback(req.ip);

function isPrivateAddress(ip = '') {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(v4);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
}

function cookie(name, value, { maxAge, secure }) {
  return [`${name}=${encodeURIComponent(value)}`, 'Path=/', `Max-Age=${Math.floor(maxAge)}`, 'HttpOnly', 'SameSite=Lax', secure ? 'Secure' : null]
    .filter(Boolean).join('; ');
}
