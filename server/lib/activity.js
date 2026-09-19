// What people do with the app, for the owner's admin page (public/admin.html): each play (and
// how long it lasted, see lib/playing.js), download, game that failed, sign-in, game hosted or
// joined with a friend, and visit, with who
// it was (an account, or someone not signed in), the address it came from and when. One file a
// month in userdata/activity/, JSON Lines, so a month is easy to look through or delete by hand;
// months older than `keepMonths` are deleted.
//
// The whole log is kept in memory once read: a home server's year of it is a few megabytes, and
// every question the admin page asks is then a pass over an array.

import fs from 'node:fs/promises';
import path from 'node:path';
import { isLoopback } from './util.js';

export const TYPES = ['visit', 'play', 'stop', 'download', 'failed', 'signin', 'badsignin', 'host', 'join'];
// Who did something: the owner; another signed-in account; someone not signed in on the local
// network, or from the internet while guests may play (a guest), or anywhere else (a visitor
// who can only browse); a friend who joined a game from its link.
export const WHO = ['owner', 'account', 'local', 'guest', 'visitor', 'friend'];
export const SIGNED_IN = new Set(['owner', 'account']);

const MONTH_FILE = /^(\d{4})-(\d{2})\.jsonl$/;
const DAY = 24 * 60 * 60 * 1000;
const MAX_TEXT = 300;
// A visit is counted once per person and address in this long, not on every page load.
const VISIT_EVERY_MS = 6 * 60 * 60 * 1000;

const text = (v, max = MAX_TEXT) => (v == null || v === '' ? undefined : String(v).replace(/[\p{C}]/gu, ' ').slice(0, max));
const monthOf = (iso) => iso.slice(0, 7);

export class ActivityLog {
  /**
   * @param {object} options
   * @param {string} options.dir         where the month files go
   * @param {number} [options.keepMonths] months kept, this one included
   * @param {number} [options.anonymousVisitsPerHour] visits from people not signed in are counted at
   *   most this many times an hour, so someone sending requests from one address after another
   *   can't fill the log
   * @param {number} [options.maxVisitors] at most this many people and addresses have a visit counted
   *   in VISIT_EVERY_MS; past that (a flood of addresses) visits aren't logged until the oldest
   *   age out, while plays and the rest still are
   */
  constructor({ dir, keepMonths = 24, anonymousVisitsPerHour = 120, maxVisitors = 5000 }) {
    this.dir = dir;
    this.keepMonths = Math.max(1, keepMonths);
    this.anonymousVisitsPerHour = anonymousVisitsPerHour;
    this.maxVisitors = maxVisitors;
    this.events = null;           // every event, oldest first, once read
    this.loading = null;
    this.writing = Promise.resolve(); // every record, in order: read the log, keep it in memory, append
    this.visits = new Map();      // person and address -> when their last visit was counted, oldest first
    this.visitHour = -1;
    this.visitsThisHour = 0;
    this.lastTime = 0;            // the newest event's time, in ms (see record)
    this.checkedEnds = new Set(); // month files known to end in a whole line
  }

  /** Every event, oldest first. Read from the files the first time. */
  async all() {
    if (this.events) return this.events;
    // Events written while an earlier read failed are on disk only: let them land first.
    await this.writing;
    return this.#load();
  }

  #load() {
    if (this.events) return Promise.resolve(this.events);
    this.loading ??= (async () => {
      const events = [];
      for (const name of (await fs.readdir(this.dir).catch(() => [])).filter((n) => MONTH_FILE.test(n)).sort()) {
        // A month prune() deleted since the folder was listed is skipped. Any other failure (a file
        // another program has locked) fails the read, which is tried again later, rather than
        // leaving a month out of what's kept in memory from then on.
        const content = await fs.readFile(path.join(this.dir, name), 'utf8').catch((err) => {
          if (err.code === 'ENOENT') return '';
          throw err;
        });
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event && typeof event.t === 'string' && TYPES.includes(event.type)) events.push(event);
          } catch {
            // A line cut short by a crash mid-write: skipped.
          }
        }
      }
      events.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
      // Events logged before record() kept them apart can share a millisecond: a millisecond apart
      // in memory too, so paging by time skips none (see filterEvents).
      let last = -Infinity;
      for (const e of events) {
        const ms = Date.parse(e.t);
        if (ms <= last) e.t = new Date(++last).toISOString();
        else if (ms > last) last = ms;
      }
      this.events = events;
      return events;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  /**
   * Adds an event: { type, who, email?, name?, ip?, country?, via?, agent?, gameId?, title?,
   * platform?, versionId?, engine?, kind?, bytes?, complete?, message? }. Returns it as kept.
   * Never throws: the event is appended to its month's file even when the log can't be read (a
   * later read picks it up), an event that can't be written is lost with a warning, and whatever
   * was being done carries on.
   *
   * The event is queued on `writing` before this returns, so awaiting `writing` straight after
   * (as stopping the server does) waits until it's on disk.
   */
  async record(fields, when = new Date()) {
    // Two events a moment apart never share a millisecond: the admin page pages through the log
    // by time (see filterEvents), and would skip the rest of a group that a page ended inside.
    let ms = when.getTime();
    if (ms <= this.lastTime && this.lastTime - ms < 1000) ms = this.lastTime + 1;
    const event = clean({ ...fields, t: new Date(ms).toISOString() });
    if (!event) return null;
    this.lastTime = Math.max(this.lastTime, ms);
    const file = path.join(this.dir, `${monthOf(event.t)}.jsonl`);
    const run = this.writing.then(async () => {
      const events = await this.#load().catch((err) => {
        console.warn(`Couldn't read the activity log: ${err.message}`);
        return null;
      });
      events?.push(event); // in memory once the log is; otherwise a later read finds it on disk
      await fs.mkdir(this.dir, { recursive: true });
      // A line cut short by a crash would swallow this one: start it on a line of its own.
      const lead = !this.checkedEnds.has(file) && (await endsMidLine(file)) ? '\n' : '';
      await fs.appendFile(file, `${lead}${JSON.stringify(event)}\n`);
      this.checkedEnds.add(file);
    }).catch((err) => console.warn(`Couldn't write to the activity log: ${err.message}`));
    this.writing = run;
    await run;
    return event;
  }

  /** A visit: recorded once per person and address every few hours. */
  visit(fields, now = Date.now()) {
    const key = `${fields.email ?? ''}|${fields.ip ?? ''}`;
    if (now - (this.visits.get(key) ?? 0) < VISIT_EVERY_MS) return null;
    // Oldest first, since a key moves to the end each time it's set: forget the ones whose time is up.
    for (const [k, at] of this.visits) {
      if (now - at < VISIT_EVERY_MS) break;
      this.visits.delete(k);
    }
    if (this.visits.size >= this.maxVisitors) return null;
    // Only strangers share the hourly budget: without accounts someone local is the owner, with no
    // email, and a crawler through the tunnel mustn't crowd out the household's own visits.
    if (!fields.email && fields.who !== 'owner' && fields.who !== 'local') {
      const hour = Math.floor(now / 3_600_000);
      if (hour !== this.visitHour) {
        this.visitHour = hour;
        this.visitsThisHour = 0;
      }
      // Not remembered either, so their next page load counts once the hour is over.
      if (++this.visitsThisHour > this.anonymousVisitsPerHour) return null;
    }
    this.visits.delete(key);
    this.visits.set(key, now);
    return this.record({ ...fields, type: 'visit' }, new Date(now));
  }

  /** Deletes the month files older than keepMonths, and their events. Returns how many files went. */
  async prune(now = new Date()) {
    const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (this.keepMonths - 1), 1)).toISOString().slice(0, 7);
    let removed = 0;
    await this.writing;
    for (const name of await fs.readdir(this.dir).catch(() => [])) {
      const m = MONTH_FILE.exec(name);
      if (!m || `${m[1]}-${m[2]}` >= oldest) continue;
      await fs.rm(path.join(this.dir, name), { force: true });
      removed++;
    }
    if (this.events) this.events = this.events.filter((e) => monthOf(e.t) >= oldest);
    return removed;
  }

  /** How much the files take up on disk, and what months they cover. */
  async size() {
    let bytes = 0;
    const months = [];
    for (const name of (await fs.readdir(this.dir).catch(() => [])).filter((n) => MONTH_FILE.test(n)).sort()) {
      bytes += (await fs.stat(path.join(this.dir, name)).catch(() => ({ size: 0 }))).size;
      months.push(name.slice(0, 7));
    }
    return { bytes, months };
  }
}

/** Whether a file's last line was cut short (a crash mid-write): it doesn't end in a newline. */
async function endsMidLine(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    if (!size) return false;
    const { buffer } = await handle.read(Buffer.alloc(1), 0, 1, size - 1);
    return buffer[0] !== 0x0a;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  } finally {
    await handle?.close();
  }
}

/** An event with only the fields it's allowed, each cut to size, or null when it isn't one. */
function clean(e) {
  if (!TYPES.includes(e.type) || !WHO.includes(e.who)) return null;
  const out = { t: e.t, type: e.type, who: e.who };
  for (const key of ['email', 'name', 'ip', 'country', 'via', 'gameId', 'title', 'platform', 'versionId', 'engine', 'kind', 'room', 'how']) {
    const v = text(e[key], 200);
    if (v !== undefined) out[key] = v;
  }
  for (const key of ['agent', 'message']) {
    const v = text(e[key]);
    if (v !== undefined) out[key] = v;
  }
  if (Number.isFinite(e.bytes) && e.bytes >= 0) out.bytes = Math.round(e.bytes);
  if (Number.isFinite(e.seconds) && e.seconds >= 0) out.seconds = Math.round(e.seconds);
  if (typeof e.complete === 'boolean') out.complete = e.complete;
  return out;
}

/** Which of WHO a request's person is. `friend`: they came in by a game's link (the caller knows). */
export function whoFor({ user, can, local, guestsCanPlay, friend = false }) {
  if (user) return can.owner ? 'owner' : 'account';
  if (can.owner) return 'owner'; // no accounts on this server: everyone local is the owner
  if (friend) return 'friend';
  if (local) return 'local';
  return guestsCanPlay ? 'guest' : 'visitor';
}

/**
 * Where a request came from: its address (the visitor's own through a tunnel on this PC, which
 * connects from localhost and names it in Cf-Connecting-Ip), country (Cloudflare's guess, when
 * the request came through it) and browser. `socketAddress` is the connection's own address.
 */
export function clientOf({ headers = {}, ip = '', socketAddress = '', internet = false }) {
  const tunnelled = isLoopback(socketAddress) && headers['cf-connecting-ip'];
  const address = String(tunnelled || ip || socketAddress || '').replace(/^::ffff:/, '');
  const country = tunnelled && /^[A-Z]{2}$/.test(headers['cf-ipcountry'] ?? '') ? headers['cf-ipcountry'] : undefined;
  return { ip: address || undefined, country, via: internet ? 'internet' : 'local', agent: headers['user-agent'] };
}

/**
 * What the admin page's overview shows for the events since `days` days ago (all of them when
 * days is 0): counts by who, by day, by game and platform, per person, and the failures.
 */
export function summarize(events, { days = 30, now = Date.now() } = {}) {
  // From midnight at the start of the first day the chart shows, so the totals and tables cover
  // the same calendar days as its bars ("Today" is today, not the last 24 hours).
  const since = days > 0 ? new Date(now - (days - 1) * DAY).setHours(0, 0, 0, 0) : -Infinity;
  const recent = events.filter((e) => Date.parse(e.t) >= since);
  const zero = () => Object.fromEntries(WHO.map((w) => [w, 0]));
  const totals = { plays: zero(), seconds: zero(), downloads: zero(), downloadBytes: zero(), downloadsUnfinished: 0, visits: zero(), failures: 0, signins: 0, hosted: 0, joined: 0 };
  const byDay = new Map();
  const games = new Map();
  const platforms = new Map();
  const people = new Map();     // email -> counts
  const addresses = new Map();  // ip of someone not signed in -> counts
  const failures = new Map();

  // Days in the server's own time zone, which is the owner's.
  const dayOf = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const newGame = (e) => ({ gameId: e.gameId, title: e.title ?? e.gameId, platform: e.platform ?? null, plays: 0, seconds: 0, downloads: 0, people: new Set() });
  const counts = (map, key, init) => {
    let entry = map.get(key);
    if (!entry) map.set(key, (entry = init()));
    return entry;
  };

  for (const e of recent) {
    const signedIn = SIGNED_IN.has(e.who);
    const person = signedIn && e.email ? counts(people, e.email, () => ({ email: e.email, name: e.name ?? null, plays: 0, seconds: 0, downloads: 0, visits: 0, last: e.t })) : null;
    const address = !signedIn && e.ip ? counts(addresses, e.ip, () => ({ ip: e.ip, country: e.country ?? null, who: new Set(), plays: 0, seconds: 0, downloads: 0, visits: 0, last: e.t })) : null;
    if (person) {
      person.last = e.t;
      if (e.name) person.name = e.name;
    }
    if (address) {
      address.last = e.t;
      address.who.add(e.who);
      if (e.country) address.country = e.country;
    }
    if (e.type === 'stop') {
      // How long a play lasted, logged as it ended.
      const seconds = e.seconds ?? 0;
      totals.seconds[e.who] += seconds;
      counts(byDay, dayOf(e.t), () => ({ signedIn: 0, notSignedIn: 0, downloads: 0, seconds: 0 })).seconds += seconds;
      if (person) person.seconds += seconds;
      if (address) address.seconds += seconds;
      if (e.gameId) counts(games, e.gameId, () => newGame(e)).seconds += seconds;
      if (e.platform) counts(platforms, e.platform, () => ({ platform: e.platform, plays: 0, seconds: 0 })).seconds += seconds;
    } else if (e.type === 'visit') {
      totals.visits[e.who]++;
      if (person) person.visits++;
      if (address) address.visits++;
    } else if (e.type === 'play' || e.type === 'download') {
      const plays = e.type === 'play';
      const day = counts(byDay, dayOf(e.t), () => ({ signedIn: 0, notSignedIn: 0, downloads: 0, seconds: 0 }));
      if (plays) {
        totals.plays[e.who]++;
        day[signedIn ? 'signedIn' : 'notSignedIn']++;
      } else {
        totals.downloads[e.who]++;
        totals.downloadBytes[e.who] += e.bytes ?? 0;
        if (e.complete === false) totals.downloadsUnfinished++;
        day.downloads++;
      }
      if (person) person[plays ? 'plays' : 'downloads']++;
      if (address) address[plays ? 'plays' : 'downloads']++;
      if (e.gameId) {
        const game = counts(games, e.gameId, () => newGame(e));
        game[plays ? 'plays' : 'downloads']++;
        game.people.add(e.email ?? e.ip ?? '?');
        if (plays && e.platform) counts(platforms, e.platform, () => ({ platform: e.platform, plays: 0, seconds: 0 })).plays++;
      }
    } else if (e.type === 'failed') {
      totals.failures++;
      const key = `${e.versionId ?? e.gameId}`;
      const f = counts(failures, key, () => ({ gameId: e.gameId, versionId: e.versionId ?? null, title: e.title ?? e.gameId, platform: e.platform ?? null, engine: e.engine ?? null, count: 0, last: e.t, message: null }));
      f.count++;
      f.last = e.t;
      f.message = e.message ?? f.message;
    } else if (e.type === 'signin') totals.signins++;
    else if (e.type === 'host') totals.hosted++;
    else if (e.type === 'join') totals.joined++;
  }

  // Every day of the range, with nothing on it where nothing happened; "all" starts at the first.
  const days_ = [];
  const first = days > 0 ? now - (days - 1) * DAY : (recent[0] ? Date.parse(recent[0].t) : now);
  for (let t = new Date(new Date(first).setHours(12, 0, 0, 0)).getTime(); t <= now + DAY / 2 && days_.length < 3700; t += DAY) {
    const key = dayOf(t);
    if (days_.at(-1)?.day === key) continue; // a daylight-saving change
    days_.push({ day: key, signedIn: 0, notSignedIn: 0, downloads: 0, seconds: 0, ...byDay.get(key) });
  }

  const top = (map, by, n) => [...map.values()].sort((a, b) => b[by] - a[by]).slice(0, n);
  return {
    days,
    from: days > 0 ? new Date(since).toISOString() : recent[0]?.t ?? null,
    totals,
    anonymousAddresses: addresses.size,
    accountsActive: people.size,
    byDay: days_,
    topGames: top(games, 'plays', 15).filter((g) => g.plays).map((g) => ({ ...g, people: g.people.size })),
    topDownloads: top(games, 'downloads', 10).filter((g) => g.downloads).map((g) => ({ ...g, people: g.people.size })),
    platforms: top(platforms, 'plays', 20).filter((p) => p.plays || p.seconds),
    people: [...people.values()].sort((a, b) => (a.last < b.last ? 1 : -1)),
    addresses: [...addresses.values()].sort((a, b) => (a.last < b.last ? 1 : -1)).slice(0, 50).map((a) => ({ ...a, who: [...a.who] })),
    failures: [...failures.values()].sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1)).slice(0, 30),
  };
}

/**
 * The events the admin page's activity list shows: newest first, narrowed by type, who and a
 * search of the names, addresses and games, `limit` at a time before the time `before`. That
 * cursor is exact because no two events share a millisecond (see ActivityLog.record).
 */
export function filterEvents(events, { type = '', who = '', q = '', before = '', limit = 100 } = {}) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i];
    if (before && e.t >= before) continue;
    if (type && e.type !== type) continue;
    if (who === 'signed-in' ? !SIGNED_IN.has(e.who) : who === 'not-signed-in' ? SIGNED_IN.has(e.who) : who && e.who !== who) continue;
    if (words.length) {
      const hay = [e.email, e.name, e.ip, e.country, e.title, e.platform, e.message, e.room].filter(Boolean).join(' ').toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
    }
    out.push(e);
  }
  return out;
}
