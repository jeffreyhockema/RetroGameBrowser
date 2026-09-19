// A limit on how often one client may do something costly (signing in, saving settings), so
// someone on the internet can't have the server do it without end. Kept in memory: a restart
// forgets the counts, which is fine for this.

import net from 'node:net';

// More clients than this with a window open at once is a flood: the oldest windows are
// forgotten rather than the map growing. Keys that have used up their limit are kept apart, and
// many more of them, so a flood of new keys can't wipe the count of one being held back.
const MAX_KEYS = 10_000;
const MAX_HELD = 100_000;

/**
 * Counts per key within a window of `windowMs`: `hit(key)` counts one and says whether the key
 * is still within `max`; `over(key)` asks without counting; `clear(key)` forgets it. The
 * middleware below counts every request; a sign-in counts only the ones that fail.
 */
export class Counter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map(); // key -> { count, resets }, in the order their windows started
    this.held = new Map(); // the same, for keys that have reached `max`
  }

  #entry(key, now, create) {
    // Forget windows that are over, which sit at the front, so the maps don't keep every key seen.
    for (const map of [this.hits, this.held]) {
      for (const [k, h] of map) {
        if (h.resets > now) break;
        map.delete(k);
      }
    }
    let entry = this.hits.get(key) ?? this.held.get(key);
    if (entry && entry.resets <= now) entry = null;
    if (!entry && create) {
      this.hits.delete(key); // set again at the back, keeping that order
      this.held.delete(key);
      entry = { count: 0, resets: now + this.windowMs };
      this.hits.set(key, entry);
      while (this.hits.size > MAX_KEYS) this.hits.delete(this.hits.keys().next().value);
    }
    return entry;
  }

  /** Counts one for `key`; true while it's still within the limit. */
  hit(key, now = Date.now()) {
    const entry = this.#entry(key, now, true);
    entry.count++;
    if (entry.count >= this.max && this.hits.get(key) === entry) {
      this.hits.delete(key);
      this.held.set(key, entry);
      while (this.held.size > MAX_HELD) this.held.delete(this.held.keys().next().value);
    }
    return entry.count <= this.max;
  }

  /** Whether `key` has used up its limit, without counting. */
  over(key, now = Date.now()) {
    return (this.#entry(key, now, false)?.count ?? 0) >= this.max;
  }

  /** Seconds until `key` may go again. */
  retryAfter(key, now = Date.now()) {
    const entry = this.#entry(key, now, false);
    return entry ? Math.ceil((entry.resets - now) / 1000) : 0;
  }

  clear(key) {
    this.hits.delete(key);
    this.held.delete(key);
  }
}

/**
 * Express middleware allowing `max` requests per `windowMs` from each key (by default the
 * client's address, which "trust proxy" in index.js takes from a local tunnel's forwarded one).
 * Past that the request gets a 429 with Retry-After.
 */
export function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many requests. Try again in a little while.' }) {
  const counter = new Counter({ windowMs, max });
  return (req, res, next) => {
    const k = clientKey(key(req));
    if (!counter.hit(k)) {
      res.set('Retry-After', String(counter.retryAfter(k)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

/**
 * The key a limit counts under. Someone with IPv6 usually has a whole /64 of addresses to pick
 * from, so a /64 counts as one client; anything else (an IPv4 address, an email) is as given.
 */
export function clientKey(value) {
  const ip = String(value ?? '');
  if (!net.isIPv6(ip) || ip.includes('.')) return ip; // IPv4 mapped into IPv6 is one address
  const [head, tail = ''] = ip.split('%')[0].toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}
