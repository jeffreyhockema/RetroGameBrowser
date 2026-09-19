// The accounts that have signed in (Google's, and local ones: see lib/localusers.js), and what
// the owner lets each do, in
// userdata/accounts.json: email -> { name, picture, firstSeen, lastSeen, access }. The owner
// changes access on the admin page; an account the owner hasn't set yet gets what the config's
// auth.players says (play when it's listed there, browse otherwise), so a config from before
// the admin page keeps working as it did.
//
// An account that has signed in and that the owner hasn't decided about yet (and the config
// doesn't name) is "new": the admin page lists those for the owner to let play, keep browsing or
// block. Nothing on the site tells the person any of this.
//
// Access is one of:
//   play     play and download games, with plays counted
//   browse   favorites of their own, and nothing more (the default)
//   blocked  can't sign in; their sessions are ended, so they're like anyone not signed in
// The owner's own account is always 'owner' and can't be changed.

import { readJson, writeJson } from './settings.js';
import { lowerEmail as lower, isMap, invalid } from './util.js';

export const ACCESS = ['play', 'browse', 'blocked'];
// lastSeen is kept to within this much, so browsing doesn't write the file on every request.
const SEEN_EVERY_MS = 5 * 60_000;
const SAVE_DELAY_MS = 30_000;
const MAX_ACCOUNTS = 5000;

export class Accounts {
  /**
   * @param {object} options
   * @param {string} options.file
   * @param {string} [options.owner]    the owner's email
   * @param {string[]} [options.players] emails the config lets play, for accounts not yet set
   * @param {() => string|null} [options.localOwner] the owner's local account's email, on a server
   *   whose config names no owner (see lib/localusers.js)
   */
  constructor({ file, owner = '', players = [], localOwner = () => null }) {
    this.file = file;
    this.configOwner = lower(owner);
    this.localOwner = localOwner;
    this.players = new Set(players.map(lower).filter(Boolean));
    this.accounts = new Map(); // email -> record
    this.queue = Promise.resolve();
    this.timer = null;
  }

  /** Reads the file (once, at start-up). A file that can't be read is an error, not "no accounts". */
  async load() {
    const saved = await readJson(this.file, {});
    this.accounts = new Map();
    for (const [email, record] of Object.entries(isMap(saved) ? saved : {})) {
      if (!isMap(record) || !email.includes('@')) continue;
      this.accounts.set(lower(email), {
        name: String(record.name ?? '').slice(0, 200),
        picture: String(record.picture ?? '').slice(0, 1000),
        firstSeen: typeof record.firstSeen === 'string' ? record.firstSeen : null,
        lastSeen: typeof record.lastSeen === 'string' ? record.lastSeen : null,
        ...(ACCESS.includes(record.access) && { access: record.access }),
      });
    }
    return this;
  }

  /** The owner's email: the config's, else the owner's local account's, else ''. */
  get owner() {
    return this.configOwner || lower(this.localOwner());
  }

  /** What an account may do: 'owner', or one of ACCESS. */
  access(email) {
    const key = lower(email);
    if (!key) return 'browse';
    if (key === this.owner) return 'owner';
    return this.accounts.get(key)?.access ?? (this.players.has(key) ? 'play' : 'browse');
  }

  /**
   * Every account that has signed in, and every one the config names, newest seen first. `isNew`:
   * signed in, and neither the owner nor the config has said what it may do.
   */
  list() {
    const emails = new Set([...this.accounts.keys(), ...this.players, ...(this.owner ? [this.owner] : [])]);
    return [...emails].map((email) => {
      const record = this.accounts.get(email);
      const decided = email === this.owner || Boolean(record?.access);
      return {
        email,
        name: record?.name || null,
        picture: record?.picture || null,
        firstSeen: record?.firstSeen ?? null,
        lastSeen: record?.lastSeen ?? null,
        access: this.access(email),
        // Access that comes from the config rather than a choice made on the admin page.
        fromConfig: !decided && this.players.has(email),
        isNew: !decided && !this.players.has(email) && Boolean(record),
      };
    }).sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '') || a.email.localeCompare(b.email));
  }

  /**
   * An account was seen: signing in (which saves at once and refreshes the name and picture) or
   * using the site with a session (which saves a little later, and only now and then).
   */
  seen(user, { signIn = false, now = new Date() } = {}) {
    const email = lower(user?.email);
    if (!email) return;
    let record = this.accounts.get(email);
    if (!record) {
      if (this.accounts.size >= MAX_ACCOUNTS) return;
      record = { name: '', picture: '', firstSeen: now.toISOString(), lastSeen: null };
      this.accounts.set(email, record);
    }
    // An account the owner added before it signed in gets its first-seen date now.
    record.firstSeen ??= now.toISOString();
    // A session started before this file was kept carries the name and picture too.
    const fillIn = !signIn && ((!record.name && user.name) || (!record.picture && user.picture));
    if (signIn || fillIn) {
      record.name = String(user.name || record.name || '').slice(0, 200);
      record.picture = String(user.picture || record.picture || '').slice(0, 1000);
    }
    const last = record.lastSeen ? Date.parse(record.lastSeen) : 0;
    if (!signIn && !fillIn && now.getTime() - last < SEEN_EVERY_MS) return;
    record.lastSeen = now.toISOString();
    // A save that fails has said so (see save), and signing in or browsing carries on.
    if (signIn) return this.save().catch(() => {});
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.save().catch(() => {});
    }, SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  /** The owner sets what an account may do. Returns the account as list() has it. */
  async setAccess(email, access) {
    const key = lower(email);
    if (!key.includes('@') || key.length > 320) throw invalid('That isn\'t an email address.');
    if (key === this.owner) throw invalid('The owner\'s own access can\'t be changed.');
    if (!ACCESS.includes(access)) throw invalid(`Access must be one of ${ACCESS.join(', ')}.`);
    let record = this.accounts.get(key);
    if (!record) {
      if (this.accounts.size >= MAX_ACCOUNTS) throw invalid('There are too many accounts to add another.');
      record = { name: '', picture: '', firstSeen: null, lastSeen: null };
      this.accounts.set(key, record);
    }
    record.access = access;
    await this.save();
    return this.list().find((a) => a.email === key);
  }

  /** Forgets an account (a local one the owner deleted). */
  async remove(email) {
    const key = lower(email);
    if (key === this.owner) throw invalid('The owner\'s account can\'t be removed.');
    if (this.accounts.delete(key)) await this.save();
  }

  /** Saves now what's waiting to be saved (lastSeen, a little later), as the server stops. Never rejects. */
  flush() {
    return (this.timer ? this.save() : this.queue).catch(() => {});
  }

  /** Writes the file, one write after another. */
  save() {
    clearTimeout(this.timer);
    this.timer = null;
    const data = Object.fromEntries(this.accounts);
    const run = this.queue.then(() => writeJson(this.file, data, { mode: 0o600 }));
    this.queue = run.catch((err) => console.warn(`Couldn't save the accounts: ${err.message}`));
    return run;
  }
}
