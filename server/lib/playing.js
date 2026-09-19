// The games being played right now, and for how long, for the owner's admin page. A play starts
// when the player page says its game is up (POST /api/games/:id/played answers with an id), the
// page checks in every half minute while the game is open, and says when it's left. A page that
// stops checking in (a closed laptop, a lost connection, a phone switched to another app) is
// taken to have left after timeoutMs, and its time up to its last check-in is logged. If it
// checks in again later (the laptop opened, the phone back on the game) within resumeMs, the play
// carries on under the same id as a new stretch, logged as its own 'stop' when it ends; the time
// it was away isn't counted.
//
// Only time the page was on screen counts: a game left open in a tab behind others isn't being
// played. Each check-in says whether the page is visible, and the time since the one before
// counts when the page was visible then. A gap longer than maxGapMs (but shorter than timeoutMs,
// which would have ended the play) counts as maxGapMs at most.
//
// Kept in memory: a crash forgets the games being played, whose time then isn't counted.

import crypto from 'node:crypto';

export class LivePlays {
  /**
   * @param {object} options
   * @param {(play: object, how: 'left'|'lost') => void} options.onEnd  given each play once it ends,
   *   with `seconds` played
   */
  constructor({ onEnd = () => {}, timeoutMs = 150_000, maxGapMs = 90_000, resumeMs = 12 * 3_600_000, max = 500 } = {}) {
    this.onEnd = onEnd;
    this.timeoutMs = timeoutMs;
    this.maxGapMs = maxGapMs;
    this.resumeMs = resumeMs; // a night with the laptop shut
    this.max = max;
    this.plays = new Map(); // id -> play
    this.lost = new Map();  // id -> { fields, lastBeat }: plays that stopped checking in and may come back
  }

  /** Starts a play with what's known about it (who, from where, which game). Returns its id. */
  start(fields, now = Date.now()) {
    this.sweep(now);
    return this.#add(crypto.randomBytes(16).toString('base64url'), fields, now).id;
  }

  /**
   * A check-in. Returns false when there's no such play (it ended, or the server restarted). A
   * play that had stopped checking in carries on from now.
   */
  beat(id, { visible = true } = {}, now = Date.now()) {
    const play = this.#get(id, now) ?? this.#resume(id, now);
    if (!play) return false;
    this.#count(play, now);
    play.visible = Boolean(visible);
    return true;
  }

  /** The page left the game. Returns whether there was such a play. */
  end(id, how = 'left', now = Date.now()) {
    const key = String(id ?? '');
    // A page that has said it left doesn't come back through a check-in that arrives late.
    this.lost.delete(key);
    const play = this.plays.get(key);
    if (!play) return false;
    this.plays.delete(play.id);
    // A play that went quiet counts up to its last check-in only.
    if (how === 'left') this.#count(play, now);
    this.onEnd(this.#public(play), how);
    if (how === 'lost') {
      const { id: _, started, lastBeat, visible, seconds, ...fields } = play;
      while (this.lost.size >= this.max) this.lost.delete(this.lost.keys().next().value);
      this.lost.set(play.id, { fields, lastBeat });
    }
    return true;
  }

  /** Ends the plays that stopped checking in, and forgets the ones gone too long to come back. */
  sweep(now = Date.now()) {
    for (const play of [...this.plays.values()]) {
      if (now - play.lastBeat > this.timeoutMs) this.end(play.id, 'lost', now);
    }
    for (const [id, gone] of this.lost) {
      if (now - gone.lastBeat > this.resumeMs) this.lost.delete(id);
    }
  }

  /** The games being played right now, longest first, with the time played so far. */
  list(now = Date.now()) {
    this.sweep(now);
    return [...this.plays.values()].map((play) => {
      const soFar = { ...play };
      this.#count(soFar, now);
      return this.#public(soFar);
    }).sort((a, b) => a.started - b.started);
  }

  #add(id, fields, now) {
    // Past the limit, the play that checked in longest ago goes first, as ended: the internet can't
    // fill the memory, and plays that never check in go before the ones being played.
    while (this.plays.size >= this.max) {
      let oldest = null;
      for (const play of this.plays.values()) if (!oldest || play.lastBeat < oldest.lastBeat) oldest = play;
      this.end(oldest.id, 'lost', now);
    }
    const play = { ...fields, id, started: now, lastBeat: now, visible: true, seconds: 0 };
    this.plays.set(id, play);
    return play;
  }

  /** A play that stopped checking in and now has, as a new stretch starting now; or null. */
  #resume(id, now) {
    const key = String(id ?? '');
    const gone = this.lost.get(key);
    if (!gone) return null;
    this.lost.delete(key);
    if (now - gone.lastBeat > this.resumeMs) return null;
    return this.#add(key, gone.fields, now);
  }

  #get(id, now) {
    const play = this.plays.get(String(id ?? ''));
    if (!play) return null;
    if (now - play.lastBeat > this.timeoutMs) {
      this.end(play.id, 'lost', now);
      return null;
    }
    return play;
  }

  #count(play, now) {
    if (play.visible) play.seconds += Math.max(0, Math.min(now - play.lastBeat, this.maxGapMs)) / 1000;
    play.lastBeat = now;
  }

  #public({ lastBeat, ...play }) {
    return { ...play, seconds: Math.round(play.seconds), startedAt: new Date(play.started).toISOString(), lastSeenAt: new Date(lastBeat).toISOString() };
  }
}
