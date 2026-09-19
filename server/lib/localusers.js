// Local accounts: a username and password kept by this server, for owners who'd rather not set
// up Google sign-in (see docs/guide.md). The owner turns them on and off on the admin page (see
// ServerSettings.localLogins); while they're off, nobody can sign in with one and any session
// one has counts for nothing (see Auth.userFor).
//
// Kept in userdata/local-users.json:
//   username -> { name, hash, uid, created, changed, owner }
// A password is kept only as a salted scrypt hash (Node's own crypto, no dependencies).
//
// `uid` is the account's own random id, made again whenever its password changes: a session
// keeps the uid it was started with, and counts only while the account's uid is the same (see
// Auth.userFor). So a new password signs out every other device even if the sessions file
// couldn't be saved, and an account deleted and made again under the same username (a new uid)
// never inherits the old one's sessions.
//
// Everywhere else an account is known by an email address: what it may do (accounts.json), its
// sessions, its favorites and plays, the activity log. A local account's is "<username>@local",
// which no Google account can have (Google's addresses all have a dot in their domain), so the
// two kinds never meet.
//
// One local account can be the owner's, on a server without Google sign-in: with no accounts at
// all the owner is whoever is at this PC, so turning local accounts on makes an account
// for the owner at the same time (see POST /api/admin/local-logins).

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { readJson, writeJson } from './settings.js';
import { isMap, invalid, dataText } from './util.js';

const scrypt = promisify(crypto.scrypt);

export const LOCAL_DOMAIN = 'local';
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;
export const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const MAX_USERS = 5000;
// scrypt's cost, one of OWASP's recommended settings (N=2^15, r=8, p=3: 32 MB and about 0.3 s a
// check here), so each guess costs an attacker as much. Kept with each hash: one made with an
// older setting still checks, and is made again with this one at its next sign-in.
const COST = { N: 2 ** 15, r: 8, p: 3 };
const KEY_BYTES = 64;
const SALT_BYTES = 16;
// What a hash read from the file may ask for. Anything outside these is taken as damaged and
// matches no password: a key of no length would match every one, a tiny N would make the hash
// easy to crack, and a huge one would tie the server up.
const LIMITS = { N: [2 ** 14, 2 ** 20], r: [1, 32], p: [1, 16] };
const MAX_MEM = 256 * 1024 * 1024;

const newUid = () => crypto.randomBytes(16).toString('base64url');

/** A username as it's kept: trimmed and lower case. */
export const normalUsername = (name) => String(name ?? '').trim().toLowerCase();

/** The email address a local account goes by everywhere else. */
export const localEmail = (username) => `${normalUsername(username)}@${LOCAL_DOMAIN}`;

/** The username of a local account's email address, or null for any other address. */
export function localUsername(email) {
  const m = /^(.+)@local$/.exec(String(email ?? '').toLowerCase());
  return m && USERNAME.test(m[1]) ? m[1] : null;
}

/** Why a username can't be used, or null. */
export function usernameProblem(username) {
  const name = normalUsername(username);
  if (!USERNAME.test(name)) return 'A username is 2 to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit.';
  return null;
}

// Passwords too common to allow: the 100,000 most used in breaches (the UK NCSC's list, as
// SecLists has it), those long enough to pass the length rule, lower case. Read the first time
// a password is chosen.
let common = null;
const commonPasswords = () => {
  common ??= new Set(dataText('common-passwords.txt').split('\n').filter(Boolean));
  return common;
};

/**
 * Why a password can't be used, or null: too short or long, one of the passwords most often
 * found in breaches, or the username itself (NIST SP 800-63B's rules for chosen passwords).
 */
export function passwordProblem(password, { username = '' } = {}) {
  if (typeof password !== 'string' || [...password].length < MIN_PASSWORD) return `A password needs at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return `A password can be at most ${MAX_PASSWORD} characters.`;
  const lower = password.toLowerCase();
  if (commonPasswords().has(lower)) return 'That password is one of the most commonly used, so it\'s among the first anyone would guess. Choose another.';
  const name = normalUsername(username);
  if (name && (lower === name || lower.includes(name) && name.length >= 4 && lower.length - name.length < 4)) return 'A password can\'t be your username, or nearly.';
  if (/^(retro ?game ?browser|retrogames?)\d*$/.test(lower)) return 'That password is too easy to guess here. Choose another.';
  return null;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_BYTES, { ...COST, maxmem: MAX_MEM });
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const within = (value, [min, max]) => Number.isInteger(value) && value >= min && value <= max;

/** A stored hash taken apart, or null when it isn't one this could have made (see LIMITS). */
function parseHash(hash) {
  const parts = String(hash).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const [salt, key] = parts.slice(4);
  if (!within(N, LIMITS.N) || (N & (N - 1)) !== 0 || !within(r, LIMITS.r) || !within(p, LIMITS.p)) return null;
  if (!B64URL.test(salt) || !B64URL.test(key)) return null;
  const saltBytes = Buffer.from(salt, 'base64url');
  const keyBytes = Buffer.from(key, 'base64url');
  if (saltBytes.length < SALT_BYTES || keyBytes.length !== KEY_BYTES) return null;
  if (128 * N * r * p > MAX_MEM) return null;
  return { N, r, p, salt: saltBytes, key: keyBytes };
}

async function passwordMatches(password, hash) {
  const h = parseHash(hash);
  if (!h) return false;
  const got = await scrypt(String(password), h.salt, KEY_BYTES, { N: h.N, r: h.r, p: h.p, maxmem: MAX_MEM });
  return crypto.timingSafeEqual(got, h.key);
}

/** Whether a hash was made with an older cost than today's, and wants making again. */
const outdated = (hash) => {
  const h = parseHash(hash);
  return Boolean(h) && (h.N !== COST.N || h.r !== COST.r || h.p !== COST.p);
};

// Checked against when the username isn't known, so an unknown name takes as long to turn down
// as a wrong password and the timing doesn't say which usernames exist. Made at start-up (see
// load), so even the first unknown name isn't slower than the rest.
let decoy = null;

export class LocalUsers {
  constructor(file) {
    this.file = file;
    this.users = new Map(); // username -> record
    this.making = new Set(); // usernames being made just now (see create)
    this.queue = Promise.resolve();
  }

  /** Reads the file (once, at start-up). A file that can't be read is an error, not "no accounts". */
  async load() {
    const saved = await readJson(this.file, {});
    this.users = new Map();
    let changed = false;
    for (const [username, r] of Object.entries(isMap(saved?.users) ? saved.users : {})) {
      if (usernameProblem(username) || !isMap(r) || typeof r.hash !== 'string') continue;
      // An account from before uids gets one now; its old sessions, which have none, end.
      if (typeof r.uid !== 'string' || !r.uid) changed = true;
      this.users.set(normalUsername(username), {
        name: String(r.name ?? '').slice(0, 100),
        hash: r.hash,
        uid: typeof r.uid === 'string' && r.uid ? r.uid : newUid(),
        created: typeof r.created === 'string' ? r.created : null,
        changed: typeof r.changed === 'string' ? r.changed : null,
        owner: r.owner === true,
      });
      if (!parseHash(r.hash)) console.warn(`The local account "${normalUsername(username)}" has a damaged password; it can't sign in until the owner sets a new one.`);
    }
    // One owner at most, whatever the file says.
    let owner = false;
    for (const r of this.users.values()) {
      if (r.owner && owner) r.owner = false;
      owner ||= r.owner;
    }
    decoy ??= await hashPassword(crypto.randomBytes(16).toString('hex'));
    if (changed) await this.save();
    return this;
  }

  get size() {
    return this.users.size;
  }

  has(username) {
    return this.users.has(normalUsername(username));
  }

  /** The username of the account marked as the owner's, or null. */
  owner() {
    for (const [username, r] of this.users) if (r.owner) return username;
    return null;
  }

  /** The account's current uid (see above), or null. */
  uid(username) {
    return this.users.get(normalUsername(username))?.uid ?? null;
  }

  /** What the rest of the server knows a local account by: { email, name, picture }, or null. */
  user(username) {
    const key = normalUsername(username);
    const r = this.users.get(key);
    return r ? { email: localEmail(key), name: r.name || key, picture: '' } : null;
  }

  /** Every local account, for the admin page: { username, email, name, created, changed, owner }. */
  list() {
    return [...this.users].map(([username, r]) => ({ username, email: localEmail(username), name: r.name || username, created: r.created, changed: r.changed, owner: r.owner }));
  }

  /**
   * Makes an account. Throws (with a status) for a username taken or not allowed, or a password
   * too short, long or common. `owner`: the owner's own account, of which there's one at most.
   */
  async create({ username, name = '', password, owner = false }) {
    const key = normalUsername(username);
    const problem = usernameProblem(key) ?? passwordProblem(password, { username: key });
    if (problem) throw invalid(problem);
    // Checked and taken in one go, before the hash (which takes a while): two requests for the
    // same username at once can't both pass, and one can't overwrite the other's account.
    if (this.users.has(key) || this.making.has(key)) throw invalid('That username is taken.', 409);
    if (this.users.size + this.making.size >= MAX_USERS) throw invalid('There are too many accounts to add another.');
    if (owner && (this.owner() || [...this.making].some((k) => k.startsWith('owner:')))) throw invalid('There\'s an owner\'s account already.', 409);
    this.making.add(key);
    if (owner) this.making.add(`owner:${key}`);
    try {
      const hash = await hashPassword(password);
      const now = new Date().toISOString();
      this.users.set(key, { name: cleanName(name), hash, uid: newUid(), created: now, changed: now, owner: Boolean(owner) });
      // Taken back if it couldn't be saved: an account that isn't on disk would vanish at the next restart.
      try {
        await this.save();
      } catch (err) {
        this.users.delete(key);
        throw err;
      }
    } finally {
      this.making.delete(key);
      this.making.delete(`owner:${key}`);
    }
    return this.user(key);
  }

  /**
   * The account for a username and password, or null when they don't match. As slow for a
   * username that doesn't exist as for a wrong password. A hash made with an older cost is made
   * again with today's once the password has been shown to match.
   */
  async verify(username, password) {
    const key = normalUsername(username);
    const r = this.users.get(key);
    if (typeof password !== 'string' || password.length > MAX_PASSWORD) return null;
    if (!r) {
      await passwordMatches(password, decoy);
      return null;
    }
    const hash = r.hash;
    if (!(await passwordMatches(password, hash))) return null;
    if (outdated(hash) && this.users.get(key) === r && r.hash === hash) {
      r.hash = await hashPassword(password);
      await this.save().catch((err) => console.warn(`Couldn't save ${key}'s stronger password hash: ${err.message}`));
    }
    return this.user(key);
  }

  /**
   * Sets a new password (the account's own change, the owner's reset, or the recovery script).
   * The account gets a new uid, which ends every session it had (see above).
   */
  async setPassword(username, password) {
    const key = normalUsername(username);
    const r = this.users.get(key);
    if (!r) throw invalid('There\'s no such account.', 404);
    const problem = passwordProblem(password, { username: key });
    if (problem) throw invalid(problem);
    const before = { hash: r.hash, uid: r.uid, changed: r.changed };
    Object.assign(r, { hash: await hashPassword(password), uid: newUid(), changed: new Date().toISOString() });
    try {
      await this.save();
    } catch (err) {
      Object.assign(r, before);
      throw err;
    }
  }

  /**
   * Deletes an account. `isOwner(username)` says whether it's the owner's just now, which can't
   * be: the one marked as the owner's stops being it once the config names an owner of its own.
   */
  async remove(username, { isOwner = (name) => this.users.get(name)?.owner } = {}) {
    const key = normalUsername(username);
    const r = this.users.get(key);
    if (!r) throw invalid('There\'s no such account.', 404);
    if (isOwner(key)) throw invalid('The owner\'s account can\'t be deleted.');
    this.users.delete(key);
    try {
      await this.save();
    } catch (err) {
      this.users.set(key, r);
      throw err;
    }
  }

  /** Writes the file, one write after another (readable by this user only where the system has such modes). */
  save() {
    const data = { users: Object.fromEntries(this.users) };
    const run = this.queue.then(() => writeJson(this.file, data, { mode: 0o600 }));
    this.queue = run.catch(() => {});
    return run;
  }
}

/**
 * A name as it's shown: no control characters, and none of the invisible ones that reorder or
 * hide text (so a new account can't pass itself off as another in the admin page's lists).
 */
export function cleanName(name) {
  return String(name ?? '')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}
