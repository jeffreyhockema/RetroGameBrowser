// A record of each game played with friends, for working out afterwards how it went: every
// player's numbers once a second (input lag, ping, how far ahead the others ran, stalls,
// rollbacks, the transport) and what happened (who joined and left, hand-overs, divergences),
// from the room's opening to its closing. One file per session in userdata/netplay-logs/,
// JSON Lines: a `session` record first, then `sample` and `event` records as they come, and an
// `end` record with a summary. The multiplayer stats page (public/netplay-stats.html) lists the
// sessions and draws one's history; GET /api/netplay/logs serves them. The oldest are dropped
// past `keep`.
//
// The players' pages send their numbers over the room's socket (a `report` event, see
// everySecond in public/player/netplay-fixes.js); a friend needs no account for that, so
// what's written is only what's expected: known numbers, known words, short strings.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SAMPLE_EVERY_MS = 700; // a player's samples closer together than this are dropped
const MAX_EVENTS_PER_REPORT = 100;
const MAX_EVENT_LENGTH = 200;
const MAX_PEERS = 3;
const HEAD_BYTES = 4096;
const TAIL_BYTES = 8192;
const KEPT_VALUES = 7200; // per player, for the summary's medians (two hours at one a second)
// A session's file stops taking samples and events past this. Hours of four players' real numbers
// are a few tens of MB; a client sending the most a report may carry could fill the disk, and read()
// holds a whole file in memory.
const MAX_SESSION_BYTES = 50 * 1024 * 1024;
const NUMBERS = ['frame', 'lag', 'ping', 'ahead', 'stalls', 'stalled', 'delay', 'rollbacks', 'rollbackFrames', 'rollbackMs', 'mismatches', 'resyncs', 'frames', 'loops', 'deferred', 'lateApplied', 'statesMissed', 'packetsIn', 'packetsOut', 'bytesIn', 'bytesOut',
  // A game played by video (see public/player/netplay-stream.js).
  'videoFps', 'videoKbps', 'videoWidth', 'videoHeight', 'framesDropped', 'jitterMs', 'encodeMs'];
const WORDS = { transport: /^(direct|server|mixed)$/, mode: /^(lockstep|rollback|stream)$/ };
const NAME = /^[\w-]{1,80}\.jsonl$/;

const number = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const median = (list) => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19);

export class NetplayLog {
  /**
   * @param {object} options
   * @param {string} options.dir  where the files go (made when the first game is logged)
   * @param {number} [options.keep] sessions kept; the oldest go past this
   * @param {number} [options.maxBytes] how big one session's file may grow
   */
  constructor({ dir, keep = 200, maxBytes = MAX_SESSION_BYTES }) {
    this.dir = dir;
    this.keep = keep;
    this.maxBytes = maxBytes;
    this.open = new Map(); // room code -> session being written
  }

  /**
   * A room's host has opened it: the session begins. Returns the file's name. The name, and what
   * the file holds, never include the room's code: anyone who may play can list these, and a
   * live room's code is its invitation (see lib/netplay.js).
   */
  start(room) {
    const started = Date.now();
    const name = `${stamp(started)}-${crypto.randomBytes(6).toString('hex')}.jsonl`;
    const session = {
      code: room.code, name, file: path.join(this.dir, name), started,
      title: room.title, platform: room.platform, mode: room.mode, host: room.hostName,
      players: new Map([[1, { name: room.hostName, lags: [], pings: [], samples: 0, transport: null }]]),
      lastSample: new Map(), samples: 0, events: 0, bytes: 0, truncated: false,
      queue: fs.mkdir(this.dir, { recursive: true }).catch(() => {}),
    };
    this.open.set(room.code, session);
    this.#write(session, { type: 'session', at: started, title: room.title, platform: room.platform, mode: room.mode, gameId: room.gameId, versionId: room.versionId, host: room.hostName });
    return name;
  }

  /** Something happened in a room: a player joined or left, or their game says so (a hand-over, a divergence). */
  event(code, player, name, what) {
    const session = this.open.get(code);
    if (!session) return false;
    const text = String(what ?? '').slice(0, MAX_EVENT_LENGTH);
    if (!text || this.#full(session)) return false;
    if (!session.players.has(player)) session.players.set(player, { name: String(name ?? ''), lags: [], pings: [], samples: 0, transport: null });
    session.events++;
    this.#write(session, { type: 'event', at: Date.now(), p: player, name: String(name ?? '').slice(0, 40), what: text });
    return true;
  }

  /**
   * A player's numbers, as their page reports them once a second (see stats() in
   * netplay-fixes.js), with any new lines of their engine's log as events. Anything that isn't
   * a known number or word is left out.
   */
  sample(code, player, name, data) {
    const session = this.open.get(code);
    if (!session || !data || typeof data !== 'object' || this.#full(session)) return false;
    const at = Date.now();
    if (at - (session.lastSample.get(player) ?? 0) < SAMPLE_EVERY_MS) return false;
    session.lastSample.set(player, at);
    const record = { type: 'sample', at, p: player, name: String(name ?? '').slice(0, 40) };
    for (const key of NUMBERS) if (data[key] != null) record[key] = number(data[key]);
    for (const [key, ok] of Object.entries(WORDS)) if (typeof data[key] === 'string' && ok.test(data[key])) record[key] = data[key];
    if (data.hidden === true) record.hidden = true;
    if (Array.isArray(data.peers)) {
      record.peers = data.peers.slice(0, MAX_PEERS)
        .filter((pr) => pr && typeof pr === 'object')
        .map((pr) => ({ p: number(pr.p), rtt: number(pr.rtt), transport: WORDS.transport.test(pr.transport ?? '') ? pr.transport : null }));
    }
    let me = session.players.get(player);
    if (!me) session.players.set(player, me = { name: record.name, lags: [], pings: [], samples: 0, transport: null });
    if (record.name) me.name = record.name;
    me.samples++;
    if (record.lag != null && me.lags.length < KEPT_VALUES) me.lags.push(record.lag);
    if (record.ping != null && me.pings.length < KEPT_VALUES) me.pings.push(record.ping);
    if (record.transport) me.transport = record.transport;
    session.samples++;
    this.#write(session, record);
    if (Array.isArray(data.events)) {
      for (const what of data.events.slice(0, MAX_EVENTS_PER_REPORT)) if (typeof what === 'string') this.event(code, player, name, what);
    }
    return true;
  }

  /** The room closed: the summary goes at the end, and the oldest sessions past `keep` go. */
  async end(code) {
    const session = this.open.get(code);
    if (!session) return null;
    this.open.delete(code);
    const at = Date.now();
    const summary = this.#summary(session, at);
    await this.#write(session, { type: 'end', at, ...summary });
    await this.#prune();
    return summary;
  }

  /** Every session, newest first: what its header and its end say, and whether it's still being played. */
  async list() {
    let files = [];
    try {
      files = (await fs.readdir(this.dir)).filter((n) => NAME.test(n));
    } catch { /* no game logged yet */ }
    // A live session's file may not be on disk yet (its first write is on its way).
    const names = [...new Set([...files, ...[...this.open.values()].map((s) => s.name)])].sort().reverse();
    const out = [];
    for (const name of names) {
      const live = [...this.open.values()].find((s) => s.name === name);
      if (live) {
        out.push({ name, live: true, started: live.started, title: live.title, platform: live.platform, mode: live.mode, host: live.host, ...this.#summary(live, Date.now()) });
        continue;
      }
      // The file can go between the listing and the read: a session ending meanwhile prunes
      // the oldest (see #prune). One log that isn't there any more is a line missing from the
      // page, not a reason to fail the whole of it.
      let lines;
      try {
        lines = await headAndTail(path.join(this.dir, name));
      } catch {
        continue;
      }
      const { head, tail } = lines;
      const header = parse(head.split('\n')[0]);
      if (header?.type !== 'session') continue;
      const last = parse(tail.trimEnd().split('\n').pop());
      const end = last?.type === 'end' ? last : null;
      out.push({
        name, live: false, started: header.at, title: header.title, platform: header.platform, mode: header.mode, host: header.host,
        duration: end?.duration ?? null, players: end?.players ?? null, samples: end?.samples ?? null, events: end?.events ?? null, ended: Boolean(end),
      });
    }
    return out;
  }

  /** One session in full: its header, every sample and event in order, and its end if it has one. */
  async read(name) {
    if (!NAME.test(String(name))) return null;
    let text;
    try {
      text = await fs.readFile(path.join(this.dir, name), 'utf8');
    } catch {
      return null;
    }
    const records = text.split('\n').map(parse).filter(Boolean);
    const header = records.find((r) => r.type === 'session');
    if (!header) return null;
    const end = records.find((r) => r.type === 'end') ?? null;
    return {
      name,
      live: [...this.open.values()].some((s) => s.name === name),
      // Logs from before names left the code out still have it in their first record.
      session: { ...header, code: undefined },
      samples: records.filter((r) => r.type === 'sample'),
      events: records.filter((r) => r.type === 'event'),
      end,
    };
  }

  #summary(session, at) {
    return {
      duration: at - session.started,
      samples: session.samples,
      events: session.events,
      players: [...session.players].sort((a, b) => a[0] - b[0]).map(([p, me]) => ({
        p, name: me.name, samples: me.samples, lag: median(me.lags), ping: median(me.pings), maxPing: me.pings.length ? Math.max(...me.pings) : null, transport: me.transport,
      })),
    };
  }

  /** Whether a session's file has reached its size, saying so in the file the first time. */
  #full(session) {
    if (session.bytes < this.maxBytes) return false;
    if (!session.truncated) {
      session.truncated = true;
      this.#write(session, { type: 'event', at: Date.now(), p: 0, name: '', what: 'The log stops here: this session reached its size limit.' });
    }
    return true;
  }

  #write(session, record) {
    const line = `${JSON.stringify(record)}\n`;
    session.bytes += Buffer.byteLength(line);
    session.queue = session.queue
      .then(() => fs.appendFile(session.file, line))
      .catch((err) => console.warn(`Couldn't write the multiplayer log ${session.name}:`, err.message));
    return session.queue;
  }

  async #prune() {
    let names;
    try {
      names = (await fs.readdir(this.dir)).filter((n) => NAME.test(n)).sort();
    } catch {
      return;
    }
    const live = new Set([...this.open.values()].map((s) => s.name));
    const extra = names.filter((n) => !live.has(n)).slice(0, Math.max(0, names.length - this.keep));
    // `force` only forgives a file that's already gone. One another program holds open (EBUSY,
    // EPERM on Windows) stays until a later session's prune, rather than failing this one.
    await Promise.all(extra.map((n) => fs.rm(path.join(this.dir, n), { force: true })
      .catch((err) => console.warn(`Couldn't delete the multiplayer log ${n}:`, err.message))));
  }
}

function parse(line) {
  if (!line) return null;
  try {
    const record = JSON.parse(line);
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

/** The first few KB of a file and the last few, without reading what's between. */
async function headAndTail(file) {
  const fd = await fs.open(file, 'r');
  try {
    const { size } = await fd.stat();
    const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    await fd.read(head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(TAIL_BYTES, size));
    await fd.read(tail, 0, tail.length, size - tail.length);
    return { head: head.toString('utf8'), tail: tail.toString('utf8') };
  } finally {
    await fd.close();
  }
}
