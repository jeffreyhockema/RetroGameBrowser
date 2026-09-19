// Fixes to EmulatorJS's netplay, which its own source marks experimental ("frame syncing -
// working, control syncing - broken"). Its rooms, its socket, its save-state hand-over and its
// pause and play are kept; what's replaced is the part that decides which inputs take effect
// on which frame, and the way the inputs travel, so that every player's emulator does the same
// thing on the same frame and a press costs as little time as the connection allows. Like
// emulatorjs-fixes.js, a plain script that patches the running emulator from outside; called
// from public/emu/play.html once EmulatorJS has defined its netplay functions and before a
// room is opened or joined.
//
// Two ways of keeping the frames together, chosen per console by the server (see CORES in
// server/lib/emulatorjs.js):
//
//   - Lockstep (as Dolphin's and Kaillera's). Every player stamps each of their own inputs
//     with the frame it takes effect on, a few frames ahead (the delay), applies it there
//     themselves, and sends it to every other player, who apply it on that same frame. Every
//     player says, every frame, the frame up to which they've sent all they're going to send
//     (their vouch), and runs a frame only once every other player has vouched for it. Nobody
//     can get ahead of what they know and no input is ever applied late; a late message makes
//     a player wait, never drift. The delay is set from the slowest round trip.
//   - Rollback (as GGPO's, and today's fighting games'). The same stamps, vouches and packets,
//     but nobody waits: a player runs on assuming the others press nothing new, and when an
//     input turns out to have happened on a frame already run, the emulator is put back to the
//     state it saved after that frame, the input applied, and the frames since re-run, all
//     within a fraction of a frame. Own presses take effect after a short fixed delay whatever
//     the ping; the others' appear half a ping late and get corrected. Needs a state saved every
//     frame and a core that can run a few frames on demand, which the small consoles' can.
//
// Frames are counted from the last save state the owner sent: the owner's count starts when
// the state is taken, a friend's when it's loaded (found by hashing the first ticks after the
// load, since the core takes a state in during a later iteration), so frame N is the same
// moment in the game on every screen. The buttons held at that moment come with the state,
// since the core keeps its input latch outside it.
//
// The inputs travel straight between each pair of browsers over a WebRTC data channel, set
// up through the room's socket. The channel is unordered and never resends; every packet
// carries every input the other side hasn't acknowledged, so a lost packet is made good by
// the next. Where no direct path exists, the packets go through the room's socket; so they do
// while a channel that reads open delivers nothing (see watchChannels), until it does again.
//
// A safety net: every frame (every few, for a bigger state) each player hashes their state
// once its inputs are final and sends the hash along; everyone compares. Two in a row that
// differ mean the games have come apart, and the owner sends everyone a fresh state.
//
// Rollback's one demand on the core: RetroArch paces the emulator by its audio buffer, so a
// burst of loop iterations runs only the two or three frames it's "owed". With audio sync off
// (a config setting written before the game starts, see audioSyncOff) each iteration runs a
// frame, so pace() keeps time itself, at the console's own frame rate, by letting an iteration
// run only when a frame is due, and can run extra iterations on demand for a replay.
//
// A state load has a catch, found by comparing thousands of loads with play run straight on: the
// core takes a loaded state in only after running one more frame, which is thrown away, and a
// little of that throwaway frame stays in the core outside the state (about 1 load in 120, the
// next frame then differs from the one played live). So every load here is made to throw away
// the frame that really came before: load the state before that one, put in the buttons that
// frame ran with, then load the state wanted, whose throwaway frame is now that very frame.
// Rollback does this for each rollback, and the owner sends the state before the one it hands
// over for a friend to do it too.
//
// What EmulatorJS's version got wrong, for the record: a friend threw away the owner's
// "nothing happened this frame" messages, so it could only advance on frames that had an
// input in them; once it stopped to ask for a resync it never asked again (the flag was never
// cleared); the frame counter's reset used a relative count as if it were absolute, so a
// second resync sent it wild; and inputs took effect on the owner at once but on friends ten
// frames later, so the games drifted apart from the first button press.

window.NetplayFixes = (() => {
  const FRAME_MS = 1000 / 60;
  // Lockstep's delay, in frames: the least it's ever set to, and the most.
  const MIN_DELAY = 2;
  const MAX_DELAY = 12;
  const FIRST_DELAY = 4; // until the first round trip has been measured
  // Rollback's delay on own presses: fixed, and short.
  const ROLLBACK_DELAY = 2;
  // Rollback: frames a player may run past what's confirmed before waiting, and states kept.
  const MAX_PREDICT = 8;
  const STATES_KEPT = 24;
  // Frames a player keeps in hand beyond the others' vouches, so a message a little late
  // doesn't stop them.
  const LEAD = 1;
  // A player this far behind another asks for a fresh state rather than crawling after them.
  const RESYNC_BEHIND = 90;
  const RESYNC_EVERY_MS = 5000;
  // How long the owner waits for every friend to load a state before playing on without them.
  const SYNC_WAIT_MS = 10000;
  // A hand-over the platform couldn't be caught for is tried again, this often and this many times.
  const SYNC_RETRY_MS = 100;
  const SYNC_TRIES = 20;
  // RetroArch's buttons and sticks are inputs 0-23; EmulatorJS's own quick-save keys follow.
  const INPUTS = 24;
  const STATS_EVERY_MS = 1000;
  const RECENT_MS = 10000; // stalls, lag and rollbacks are counted over this long
  // Inputs kept for resending until the other side acknowledges them.
  const RESEND_CAP = 60;
  // The state hashes: every frame while a state is small (a console's is tens or hundreds of
  // KB), every 15th up to 2 MB, and not at all past that (a PlayStation's would stutter).
  const HASH_SMALL = 512 * 1024;
  const HASH_TOO_BIG = 2 * 1024 * 1024;
  const HASH_EVERY_MEDIUM = 15;
  const HASHES_KEPT = 300; // frames
  const MISMATCHES_BEFORE_RESYNC = 2; // consecutive
  const RESYNC_AFTER_MISMATCH_MS = 5000;
  // A direct connection that failed is tried again after this long.
  const PEER_RETRY_MS = 20000;
  // One that hasn't connected after this long (an offer or answer that went nowhere) has failed.
  const PEER_CONNECT_MS = 60000;
  // A player stopped for the others sends its packet again this often, since nothing else sends
  // one; after waiting this long, a copy goes through the server as well, in case the direct
  // channel still reads open but delivers nothing.
  const RESEND_WAITING_MS = 100;
  const WAITING_VIA_SERVER_MS = 500;
  // A direct channel sends something at least this often (a frame's packet, else a keep-alive),
  // so one that has delivered nothing for DIRECT_SILENT_MS while it reads open is dead: the
  // packets for that player go through the server until something arrives over it again.
  const KEEPALIVE_MS = 250;
  const DIRECT_SILENT_MS = 1000;

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const median = (list) => {
    if (!list.length) return null;
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  /** FNV-1a, 32 bits: a quick hash of a state, the same on every side. */
  function hash(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // ---------- Running the core on our own terms (rollback) ----------

  /**
   * Tells RetroArch not to pace the emulator by its audio buffer, so that a loop iteration
   * always runs a frame (see pace). Call before the game starts (EJS_ready), like the other
   * fixes to the config: EmulatorJS writes retroarch.cfg as the core comes up.
   */
  function audioSyncOff() {
    const proto = window.EJS_GameManager?.prototype;
    if (typeof proto?.getRetroArchCfg !== 'function' || proto.getRetroArchCfg.audioSyncOff) return;
    const base = proto.getRetroArchCfg;
    proto.getRetroArchCfg = function getRetroArchCfg() {
      return `${base.call(this)}audio_sync = false\n`;
    };
    proto.getRetroArchCfg.audioSyncOff = true;
  }

  /**
   * Keeps time for a core whose audio no longer does: lets a loop iteration run only when a
   * frame is due at `fps`, catches up a frame when the display is slower than the game (a 60 Hz
   * screen and a 60.1 fps console), drops the debt rather than racing after a stall or a hidden
   * tab, and can run extra iterations on demand (a replay). The loop schedules itself through
   * the page's requestAnimationFrame with its runner function, which is caught there.
   * Needs the pre-loop hook the player page forwards (Module.rgbPreMainLoop).
   */
  function pace(ejs, fps) {
    const M = ejs.Module;
    if (M.rgbPace) return M.rgbPace;
    const period = 1000 / (fps > 0 ? fps : 60);
    const p = { fps, period, t0: 0, done: 0, runner: null, swallow: false, replaying: false, extra: 0, probing: false, probed: false, loops: 0 };
    const realRAF = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (fn) => {
      if (typeof fn === 'function' && /MainLoop/.test(fn.name || String(fn).slice(0, 80))) {
        p.runner = fn;
        if (p.swallow) return 0;
      }
      return realRAF(fn);
    };
    M.rgbPreMainLoop = () => {
      if (p.probing) {
        // alive() asking whether the loop runs: yes, and this iteration does nothing.
        p.probed = true;
        return false;
      }
      p.loops++;
      if (p.replaying) return; // a replay's iterations always run
      const now = performance.now();
      if (!p.t0) {
        p.t0 = now;
        p.done = 0;
      }
      const due = Math.floor((now - p.t0) / period);
      if (due - p.done > 4) {
        // Far behind (a hidden tab, a stall): the game doesn't owe those frames.
        p.t0 = now - p.done * period;
        return;
      }
      if (due <= p.done) return false; // not yet
    };
    /** Counts a frame that ran on its own, and catches up one more if the clock says so. */
    p.ran = () => {
      p.done++;
      const due = Math.floor((performance.now() - p.t0) / period);
      if (due - p.done >= 1 && p.runner && !p.replaying) {
        p.extra++;
        setTimeout(() => { if (!p.replaying && !ejs.paused) p.run(1); }, 0);
      }
    };
    /** Starts the clock afresh: after a pause, the game owes nothing. */
    p.reset = () => { p.t0 = 0; p.done = 0; };
    /**
     * Runs `n` loop iterations right now. Returns how many were called. Never from inside the
     * loop itself: the loop always has its next iteration booked with requestAnimationFrame, so
     * each iteration's own booking is swallowed here and that one carries the loop on. (Booking
     * another started a second copy of the loop per burst, which pacing hid: thousands of idle
     * iterations a second after a few minutes of rollbacks.)
     */
    p.run = (n) => {
      const r = p.runner;
      if (!r) return 0;
      p.swallow = true;
      let ran = 0;
      try {
        for (let i = 0; i < n; i++) { r(); ran++; }
      } finally {
        p.swallow = false;
      }
      return ran;
    };
    /**
     * Whether the loop is running, so that iterations called now do something: not while the
     * emulator is paused, when the runner caught last belongs to a stopped loop and returns at
     * once. Calls the runner once with the pre-loop hook answering "skip", so no frame runs.
     */
    p.alive = () => {
      if (ejs.paused || !p.runner) return false;
      p.probing = true;
      p.probed = false;
      p.swallow = true;
      try {
        p.runner();
      } finally {
        p.swallow = false;
        p.probing = false;
      }
      return p.probed;
    };
    M.rgbPace = p;
    return p;
  }

  /**
   * Replaces the frame-sync part of EmulatorJS's netplay on a running emulator.
   * @param {object} ejs the EmulatorJS instance, its netplay functions defined
   * @param {object} [options]
   * @param {'lockstep'|'rollback'} [options.mode]
   * @param {number} [options.fps] the console's frame rate, for rollback's own pacing
   * @param {object[]} [options.iceServers] the STUN/TURN servers the direct connections use
   * @param {function} [options.onStats] given the player's statistics about once a second: the
   *   owner's come with each friend's, by the friend's number in the room (see stats())
   * @param {object} [options.room] { code, title, name, owner }, for the detailed snapshot the
   *   multiplayer stats page shows (public/netplay-stats.html)
   */
  function lockstep(ejs, { mode = 'lockstep', fps = 60, iceServers = [], onStats = () => {}, room = null, hashBytes = null, exactLoads = false } = {}) {
    const np = ejs.netplay;
    const gm = () => ejs.gameManager;
    // Whether a state load lands exactly: RetroArch's cores take one in a frame late and leak a
    // little of that frame (see the top of this file), so a load here is made to throw away the
    // frame before it; a platform whose loads are exact (MAME's) says so and skips all that.
    // How a state is hashed when players check they're still playing the same game: the engine's
    // own, or the platform's, which may leave parts of the machine out (MAME's sound chips, whose
    // state doesn't come back from a load exactly).
    const stateHash = typeof hashBytes === 'function' ? hashBytes : hash;
    // And how it's hashed to ask a different question — has the core taken a state in yet, or
    // moved since? That one wants the whole state: leave out the parts that change most and the
    // tick where the core first moves is missed (see findOrigin).
    const wholeHash = hash;
    const rollback = mode === 'rollback';
    // Frames the core has run altogether; the count goes on through a state load, and through
    // a replay, which is why rollback keeps its own frame number.
    const count = () => parseInt(gm().getFrameNum(), 10) || 0;
    const p = rollback ? pace(ejs, fps) : null;
    const s = {
      gen: 0,              // which state hand-over the frames count from; messages from another are stale
      init: 0,             // lockstep: the count at the last state hand-over, frame 0
      frameNo: 0,          // rollback: the frame the game is at
      lastCount: 0,
      delay: rollback ? ROLLBACK_DELAY : FIRST_DELAY,
      lastAt: -1,          // the latest frame one of this player's inputs was stamped with
      lastUpto: -1,        // the latest frame this player has vouched for
      seq: 0,              // this player's inputs, numbered
      mine: new Map(),     // seq -> [at, input, value], kept until every peer has acknowledged it
      history: new Map(),  // frame -> [[player, input, value, seq]]: every input, for replays too
      peers: new Map(),    // player index -> peer (see makePeer)
      waiting: false,      // stopped, until the others' vouches reach past this frame
      stalledAt: 0,
      ready: 0,            // the owner: friends that have loaded the state it sent
      syncing: false,
      syncTimer: 0,
      askedAt: 0,
      // Rollback.
      states: new Map(),   // frame -> { bytes, held }: the state after that frame, before its inputs
      replay: null,        // { landing, target, x } while frames are re-run
      pendingRollback: null, // the earliest frame to go back to once the loop can run (see requestRollback)
      before0: null,       // rollback: { bytes, ranWith } the state before frame 0 and the buttons the frame that made it ran with (see rollbackTo)
      deferred: 0,         // rollbacks that had to wait for the loop (a stall, a replay under way)
      lateApplied: 0,      // inputs a frame late, put in without going back
      replaysCarried: 0,   // replays the loop had to finish in its own time
      statesMissed: 0,     // frames the platform couldn't be caught on (MAME, on the odd frame)
      syncTries: 0,        // hand-overs in a row the state couldn't be taken for
      confirmed: -1,       // the last frame every player's inputs are known for
      rollbacks: [],       // { at, frames, ms }
      // What's measured (see stats()).
      sentInputs: [],      // own presses on their way: { input, value, at }
      lags: [],            // press-to-screen times of recent presses: { at, ms }
      stalls: [],          // { at, ms } for each time this player ran out of frames
      aheads: [],          // how far ahead of this player the others were, at recent packets
      guestStats: new Map(), // the owner: friend's index -> what they last reported
      // The safety net.
      hashEvery: 0,        // frames between hashes, from the state's size at the hand-over
      hashes: new Map(),   // frame -> this player's own hash
      lastHash: null,      // { f, h }: what the frame's packet carries
      hashedUpTo: -1,      // rollback: hashes are taken once a frame is confirmed
      badRun: 0,           // hashes in a row that differed
      lastBadFrame: -1,
      mismatches: 0,       // divergences found
      resyncs: 0,
      resyncAt: 0,
      pinnedDelay: null,   // a test's: the delay held here rather than adapted
      held: new Map(),     // "player:input" -> value, for every input the core has latched
      want: new Map(),     // input -> value: this player's controller as it is now, sent or not (see pressWhatChanged)
      lastSentAt: 0,       // the last packet out, and the last copy through the server while waiting
      lastServerCopyAt: 0,
      waitingSince: 0,     // for resendWhileWaiting
      dropUntil: 0,        // a test's: packets arriving before this are lost
      dropDirectOnly: false,
      resendTimer: 0,
      origin: null,        // a friend, just after a load: { h0, ticks, bytes } until its frame 0 is found
      fakeLatency: 0,      // a test's: ms every packet is held before it's read
      fakeJitter: 0,       // a test's: up to this many ms more, at random, per packet
      statsTimer: 0,
      signalOn: false,
      lastTick: 0,
      log: [],             // recent happenings, for looking in from outside
      logged: 0,           // how many of them the session's log on the server has had
      // Per-second counts, for the stats page: this second's and the last whole one's.
      rates: { ticks: 0, frames: 0, loops: 0, packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0 },
      lastRates: null,
    };
    const frame = () => (rollback ? s.frameNo : count() - s.init);
    const myIndex = () => np.getUserIndex(np.playerID);
    const realNow = performance.now.bind(performance);
    const now = () => realNow();
    const recent = (list, at = now()) => list.filter((e) => at - e.at < RECENT_MS);
    const send = (message) => np.sendMessage(message); // the room's socket, to every other player
    const note = (what) => {
      s.log.push(`${Math.round(realNow())} f${frame()} ${what}`);
      if (s.log.length > 200) {
        s.log.shift();
        s.logged = Math.max(0, s.logged - 1);
      }
    };
    // The detailed snapshot goes to every tab of this site that listens (the stats page).
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('rgb-netplay') : null;

    // ---------- Inputs and frames ----------

    function record(at, entry) {
      let list = s.history.get(at);
      if (!list) s.history.set(at, list = []);
      list.push(entry);
    }

    /** One of this player's own presses has taken effect: how long that took. */
    function noteApplied(input, value) {
      const i = s.sentInputs.findIndex((e) => e.input === input && e.value === value);
      if (i < 0) return;
      const [sent] = s.sentInputs.splice(i, 1);
      s.lags.push({ at: now(), ms: now() - sent.at });
      if (s.lags.length > 60) s.lags.shift();
    }

    function latch(player, input, value) {
      gm().functions.simulateInput(player, input, value);
      if (value) s.held.set(`${player}:${input}`, value);
      else s.held.delete(`${player}:${input}`);
    }

    /**
     * The inputs of frame `f` into the core, in the same order on every side: by player, then
     * in the order the player made them. Lockstep applies everything due by `f` and forgets
     * it; rollback applies exactly `f` and keeps the record, for replays.
     */
    function applyFrame(f, { replaying = false } = {}) {
      const keys = rollback ? [f] : [...s.history.keys()].filter((k) => k <= f).sort((a, b) => a - b);
      const me = myIndex();
      for (const k of keys) {
        const list = s.history.get(k);
        if (!list) continue;
        list.sort((a, b) => a[0] - b[0] || a[3] - b[3]);
        for (const [player, input, value] of list) {
          latch(player, input, value);
          s.onApply?.(player, input, value, k);
          if (player === me && !replaying) noteApplied(input, value);
        }
        if (!rollback) s.history.delete(k);
      }
    }

    /** The others' vouches, as far as what's actually arrived allows (see effectiveVouch). */
    const mayRun = (next) => [...s.peers.values()].every((peer) => effectiveVouch(peer) >= next + LEAD);

    /** The last frame every other player's inputs are known for (see effectiveVouch). */
    const confirmedFrame = () => (s.peers.size ? Math.min(...[...s.peers.values()].map(effectiveVouch)) : Infinity);

    /**
     * How far a peer has vouched for, counting only what's here: a vouch covers inputs that
     * may still be on their way, and a missing one holds the vouch back to the frame before
     * the earliest input after the gap.
     */
    function effectiveVouch(peer) {
      let gapAt = Infinity;
      for (const [seq, ev] of peer.events) if (seq > peer.contig + 1 && ev[0] < gapAt) gapAt = ev[0];
      return Math.min(peer.upto, gapAt - 1);
    }

    function stall() {
      if (!s.waiting) {
        s.waiting = true;
        s.stalledAt = now();
        note(`stall (paused ${ejs.paused})`);
      }
      ejs.pause(true); // nothing to do when already paused
    }

    /** Whether the next frame may run: in lockstep everyone has vouched for it; in rollback it isn't too far past what's confirmed. */
    const nextMayRun = () => (rollback ? frame() + 1 <= confirmedFrame() + MAX_PREDICT : mayRun(frame() + 1));

    function resumeIfReady() {
      if (!s.waiting || s.syncing || !nextMayRun()) return;
      s.waiting = false;
      if (s.stalledAt) {
        s.stalls.push({ at: now(), ms: now() - s.stalledAt });
        if (s.stalls.length > 120) s.stalls.shift();
        s.stalledAt = 0;
      }
      note(`resume (paused ${ejs.paused})`);
      p?.reset();
      ejs.play(true);
      if (s.pendingRollback != null) setTimeout(tryRollback, 0);
    }

    // ---------- Packets: what travels between players every frame ----------

    /**
     * This player's packet for one peer: which frame it's on, what it vouches for, which of
     * the peer's inputs it has (so the peer can stop resending them), every input of its own
     * the peer hasn't acknowledged, and its latest hash of a final frame.
     */
    function packetFor(peer) {
      const ev = [];
      for (const [seq, [at, input, value]] of s.mine) if (seq > peer.ackOfMe) ev.push([seq, at, input, value]);
      // The oldest first: a gap the peer is waiting on always fills before newer inputs go.
      const packet = { t: 'f', g: s.gen, p: myIndex(), f: frame(), upto: s.lastUpto, ack: peer.contig, ev: ev.slice(0, RESEND_CAP), hf: s.lastHash?.f, h: s.lastHash?.h };
      // The players this one hears nothing from directly, so that they send through the server
      // too: a channel can go quiet one way only.
      const deaf = [...s.peers.values()].filter((pr) => pr.silent).map((pr) => pr.index);
      if (deaf.length) packet.srv = deaf;
      return packet;
    }

    /**
     * How the packets for a peer go: 'direct' over its open channel, or 'server' (no channel, one
     * that has gone quiet, or a peer that hears nothing over it).
     */
    const route = (peer) => (peer.channel?.readyState === 'open' && !peer.silent && !peer.askedServer ? 'direct' : 'server');

    /** One message over a peer's direct channel. False if it couldn't go. */
    function sendDirect(peer, text) {
      try {
        peer.channel.send(text);
      } catch {
        return false; // closing
      }
      peer.lastDirectOut = realNow();
      return true;
    }

    /**
     * Sends this player's packet to every peer, direct where it can be, else through the socket;
     * `alsoServer` sends the socket's copy to everyone as well.
     */
    function broadcast({ alsoServer = false } = {}) {
      // Of the peers the socket's copy stands in for, the one that has acknowledged least.
      let low = null;
      for (const peer of s.peers.values()) {
        if (route(peer) === 'direct') {
          const text = JSON.stringify(packetFor(peer));
          if (sendDirect(peer, text)) {
            s.rates.packetsOut++;
            s.rates.bytesOut += text.length;
            if (!alsoServer) continue;
          } // else closing: the socket then
        }
        if (!low || peer.ackOfMe < low.ackOfMe) low = peer;
      }
      if (low) {
        // One packet on the socket reaches everyone: it carries every input the least caught-up
        // of them is missing, and an acknowledgement for each, by player number.
        const viaSocket = { ...packetFor(low), ack: null, acks: Object.fromEntries([...s.peers.values()].map((pr) => [pr.index, pr.contig])) };
        send(viaSocket);
        s.rates.packetsOut++;
        s.rates.bytesOut += JSON.stringify(viaSocket).length;
        if (alsoServer) s.lastServerCopyAt = now();
      }
      s.lastSentAt = now();
      // Inputs every peer has acknowledged needn't be kept.
      const acked = Math.min(...[...s.peers.values()].map((pr) => pr.ackOfMe));
      if (s.peers.size) for (const seq of s.mine.keys()) if (seq <= acked) s.mine.delete(seq);
    }

    /** A packet from a peer, by either way. */
    function onPacket(packet, bytes = 0) {
      if ((s.fakeLatency > 0 || s.fakeJitter > 0) && !packet.delayed) {
        setTimeout(() => onPacket({ ...packet, delayed: true }, bytes), s.fakeLatency + Math.random() * s.fakeJitter);
        return;
      }
      s.rates.packetsIn++;
      s.rates.bytesIn += bytes;
      if (!packet || packet.t !== 'f' || packet.g !== s.gen) return;
      const peer = s.peers.get(packet.p);
      if (!peer) return;
      // Whether this peer hears nothing directly from this player, and wants it through the server.
      const asked = Array.isArray(packet.srv) && packet.srv.includes(myIndex());
      if (asked !== Boolean(peer.askedServer)) {
        peer.askedServer = asked;
        note(asked ? `player ${packet.p + 1} hears nothing direct from here; sending through the server` : `player ${packet.p + 1} hears direct again`);
      }
      peer.theirFrame = Math.max(peer.theirFrame, packet.f);
      if (typeof packet.h === 'number' && typeof packet.hf === 'number') compareHash(peer, packet.hf, packet.h);
      s.aheads.push(packet.f - frame());
      if (s.aheads.length > 120) s.aheads.shift();
      if (packet.upto > peer.upto) peer.upto = packet.upto;
      const ack = typeof packet.ack === 'number' ? packet.ack : packet.acks?.[myIndex()];
      if (typeof ack === 'number' && ack > peer.ackOfMe) peer.ackOfMe = ack;
      let earliestLate = Infinity;
      for (const ev of packet.ev ?? []) {
        const [seq, at, input, value] = ev;
        if (seq <= peer.contig || peer.events.has(seq)) continue;
        if (!(input >= 0 && input < INPUTS)) continue;
        peer.events.set(seq, [at, input, value]);
        record(at, [packet.p, input, value, seq]);
        // Rollback: an input for a frame already run was mispredicted as "nothing".
        if (rollback && at <= frame() && at < earliestLate) earliestLate = at;
        if (rollback && at < s.hashedUpTo) note(`input for frame ${at} from player ${packet.p + 1} arrived after it was hashed (to ${s.hashedUpTo}; vouch ${peer.upto}, contig ${peer.contig}, seq ${seq})`);
      }
      while (peer.events.has(peer.contig + 1)) {
        // Inputs already scheduled and acknowledged are only kept while they may still be resent.
        peer.contig++;
      }
      for (const seq of peer.events.keys()) if (seq <= peer.contig - RESEND_CAP) peer.events.delete(seq);
      if (rollback && earliestLate !== Infinity) requestRollback(earliestLate);
      resumeIfReady();
    }

    /** An input from this player's own controller (EmulatorJS hands every local input here). */
    np.simulateInput = (player, input, value) => {
      if (!ejs.isNetplay || player !== 0 || input >= INPUTS) return;
      s.want.set(input, value);
      // Not during a hand-over: what changed meanwhile goes in once it's over (see pressWhatChanged).
      if (s.syncing || s.origin) return;
      // Past the frame this player has already vouched for, however short the delay has
      // just been made.
      const at = Math.max(frame() + s.delay + 1, s.lastUpto + 1, s.lastAt);
      s.lastAt = at;
      const seq = s.seq++;
      s.mine.set(seq, [at, input, value]);
      // A peer that stops acknowledging (a page gone quiet) doesn't keep them all; the oldest go anyway.
      while (s.mine.size > 5 * RESEND_CAP) s.mine.delete(s.mine.keys().next().value);
      record(at, [myIndex(), input, value, seq]);
      s.sentInputs.push({ input, value, at: now() });
      if (s.sentInputs.length > 100) s.sentInputs.shift();
      broadcast(); // straight away, rather than with the frame's packet
    };

    /**
     * Once a hand-over is over: this player's buttons as the controller has them now, where the
     * game has them otherwise. A release made while the state was on its way was dropped, and a
     * press or release not yet due was cleared with the rest; the state came with the buttons as
     * the owner had them, and the controller won't say again (a held key doesn't repeat, a pad
     * reports only changes). Sent the ordinary way, stamped for a frame still to come.
     */
    function pressWhatChanged() {
      if (!ejs.isNetplay || s.syncing || s.origin) return;
      const me = myIndex();
      for (const [input, value] of s.want) if ((s.held.get(`${me}:${input}`) ?? 0) !== value) np.simulateInput(0, input, value);
    }

    /**
     * Sends the packet again while stopped for the others: a stopped player's loop runs no frames,
     * so nothing else would, and a lost last packet on each side would hold both for good.
     * Resending is harmless: every part of a packet is taken in only once.
     */
    function resendWhileWaiting() {
      if (!ejs.isNetplay || !s.waiting || s.syncing || !s.gen || !s.peers.size) {
        s.waitingSince = 0;
        return;
      }
      const at = now();
      if (!s.waitingSince) s.waitingSince = at;
      if (at - s.lastSentAt < RESEND_WAITING_MS) return;
      broadcast({ alsoServer: at - s.waitingSince >= WAITING_VIA_SERVER_MS && at - s.lastServerCopyAt >= WAITING_VIA_SERVER_MS });
    }

    // ---------- Rollback: states, and putting the game back ----------

    /** The state after the frame just run, before its inputs land, kept for a rollback. */
    function keepState(f) {
      try {
        s.states.set(f, { bytes: gm().getState(), held: new Map(s.held) });
        if (s.trace) {
          s.trace.set(f, { held: [...s.held].filter(([, v]) => v).map(([k]) => k).sort().join(' '), at: Math.round(realNow()), how: s.replay ? 'replay' : 'live' });
          s.trace.delete(f - 900);
        }
      } catch (err) {
        // A frame with no state of its own: a rollback lands on the one before it instead.
        s.statesMissed++;
        if (s.statesMissed === 1) console.warn('Couldn\'t keep a state for rollback', err);
      }
      const floor = Math.min(s.confirmed, f, s.pendingRollback ?? Infinity) - STATES_KEPT - 1;
      for (const k of s.states.keys()) if (k < floor) s.states.delete(k);
      for (const k of s.history.keys()) if (k < floor) s.history.delete(k);
    }

    /**
     * An input arrived for frame `x`, which has already run without it: back to the state after
     * `x`, its inputs applied in full, and the frames since re-run, now.
     */
    /**
     * An input has turned up for frame `x`, which has already run without it. A frame late
     * (x is the frame just run, whose inputs are in the core's latch for the next one) it just
     * goes in. Further back the game has to be put back and re-run, which takes a running
     * loop: not while paused (a stall, which a late input is often what ends), during a
     * hand-over, or while another replay is under way. Then it waits, the earliest frame kept,
     * and runs as soon as the loop does (see tryRollback).
     */
    function requestRollback(x) {
      if (s.pendingRollback == null && !s.replay && !s.syncing && !s.origin && x === frame()) {
        applyFrame(x, { replaying: true });
        s.lateApplied++;
        return;
      }
      s.pendingRollback = Math.min(s.pendingRollback ?? Infinity, x);
      tryRollback();
    }

    /** Goes back for the rollback that's waiting, if the loop can run it now. */
    function tryRollback() {
      const x = s.pendingRollback;
      if (x == null) return;
      if (s.replay || s.syncing || s.origin || !p?.alive()) {
        if (!s.deferredNoted || s.deferredNoted !== x) {
          s.deferredNoted = x;
          s.deferred++;
        }
        return;
      }
      s.pendingRollback = null;
      s.deferredNoted = null;
      if (x === frame()) {
        applyFrame(x, { replaying: true });
        s.lateApplied++;
        return;
      }
      rollbackTo(x);
    }

    function rollbackTo(x) {
      const target = frame();
      // Back to the frame the input belongs to, or the nearest state kept before it: a frame's
      // state can be missing where the platform couldn't take one (MAME refuses on the odd
      // frame), and re-running a frame or two more is far cheaper than a fresh hand-over.
      let at = x;
      while (at > 0 && !s.states.has(at) && x - at < STATES_KEPT) at--;
      const kept = s.states.get(at);
      if (!kept) {
        note(`can't roll back to ${x} (too far); ${np.owner ? 'sending' : 'asking for'} a state`);
        // Only the owner acts on an ask, so the owner doesn't ask itself.
        if (np.owner) sync();
        else askForState();
        return;
      }
      if (at !== x) note(`rolling back to ${at} instead of ${x}: no state was kept for it`);
      x = at;
      const framesBack = target - x;
      const replay = { landing: true, target, x };
      const t0 = realNow();
      p.replaying = true;
      try {
        // First the state before x, so that the frame the load of x throws away is frame x
        // itself, run from there with its own buttons, as it was when it was played.
        const before = exactLoads ? null : x > 0 ? s.states.get(x - 1) : s.before0?.bytes && s.before0;
        if (before) {
          s.replay = { before: true };
          gm().loadState(before.bytes);
          p.run(1);
          setLatch(x > 0 ? kept.held : s.before0.ranWith);
        }
        s.replay = replay;
        gm().loadState(kept.bytes);
        // The first iteration takes the state in; the rest re-run the frames.
        p.run(1 + framesBack);
      } finally {
        p.replaying = false;
      }
      if (s.replay === replay) {
        // The core didn't get through it (it paused in the middle, say). The loaded state is
        // still in the core, so the loop finishes the replay in its own time, a frame an
        // iteration; if the load itself hasn't happened yet, the landing checks it did.
        s.replaysCarried++;
        if (replay.landing) replay.verify = wholeHash(kept.bytes);
        note(`replay to ${target} carried on by the loop from ${replay.landing ? 'the load' : frame()}`);
      }
      s.rollbacks.push({ at: now(), frames: framesBack, ms: realNow() - t0 });
      if (s.rollbacks.length > 200) s.rollbacks.shift();
    }

    /** One loop iteration of a replay has run: the landing, or a re-run frame. */
    /** The core's input latch set to `then` ("player:input" -> value), by the keys that differ. */
    function setLatch(then) {
      for (const key of [...s.held.keys()]) if (!then.has(key)) latch(...key.split(':').map(Number), 0);
      for (const [key, value] of then) if (s.held.get(key) !== value) latch(...key.split(':').map(Number), value);
    }

    function replayTick(ran) {
      const r = s.replay;
      if (r.before) return; // the state before the one wanted going in (see rollbackTo)
      if (r.landing) {
        if (r.verify != null) {
          let h = null;
          try { h = wholeHash(gm().getState()); } catch { /* checked below */ }
          if (h !== r.verify) {
            // A frame ran instead of the load: this game is no longer the one the frames say.
            note(`replay's state load was lost at ${frame()}`);
            s.replay = null;
            if (np.owner) sync();
            else askForState();
            return;
          }
        }
        r.landing = false;
        s.frameNo = r.x;
        np.currentFrame = r.x;
        // The core's input latch is as it was at the end, not at `x`: set it back.
        setLatch(s.states.get(r.x)?.held ?? new Map());
        applyFrame(r.x, { replaying: true });
        if (r.target === r.x) replayDone();
        return;
      }
      s.frameNo++;
      np.currentFrame = s.frameNo;
      keepState(s.frameNo);
      applyFrame(s.frameNo, { replaying: true });
      if (s.frameNo >= r.target) replayDone();
    }

    function replayDone() {
      s.replay = null;
      if (s.pendingRollback != null) setTimeout(tryRollback, 0);
    }

    // ---------- The state hand-over (the owner sends, the friends load) ----------

    function startCounting() {
      s.init = count();
      s.lastCount = count();
      s.frameNo = 0;
      s.origin = null;
      s.history.clear();
      s.states.clear();
      s.replay = null;
      s.pendingRollback = null;
      s.deferredNoted = null;
      s.confirmed = -1;
      s.mine.clear();
      s.seq = 0; // inputs are numbered afresh from each hand-over, as the frames are
      s.lastAt = -1;
      s.lastUpto = -1;
      s.sentInputs.length = 0;
      s.hashes.clear();
      s.lastHash = null;
      s.hashedUpTo = -1;
      s.badRun = 0;
      s.lastBadFrame = -1;
      for (const peer of s.peers.values()) {
        peer.events.clear();
        peer.contig = -1;
        peer.ackOfMe = -1;
        peer.upto = -1;
        peer.theirFrame = 0;
        peer.checks.clear();
      }
      p?.reset();
    }

    /** A fresh start for everyone: the owner's state, which every friend loads. */
    function sync() {
      if (!np.owner) return;
      clearTimeout(s.syncTimer);
      ejs.pause(true);
      let state;
      try {
        state = gm().getState();
      } catch (err) {
        // Some games can't be caught on every frame (MAME won't save one while a driver has a
        // timer in the air), so the hand-over is tried again a few frames later, a few times.
        console.warn('Couldn\'t take the game\'s state for the friends', err);
        ejs.play(true);
        clearTimeout(s.syncTimer);
        if (s.syncTries++ < SYNC_TRIES) s.syncTimer = setTimeout(() => sync(), SYNC_RETRY_MS);
        else note('the game\'s state can\'t be taken: the friends can\'t be started off');
        return;
      }
      s.syncTries = 0;
      s.hashEvery = hashRate(state.length);
      s.gen++;
      note(`sync: state of ${state.length} bytes, gen ${s.gen}`);
      // Rollback: the state before this one and the buttons the frame between ran with, so that
      // a friend's load throws away that frame (see the top of this file). Not while a replay
      // is carried on by the loop, when the states kept are still being put right.
      const last = rollback && !exactLoads && !s.replay ? s.states.get(frame()) : null;
      const beforeState = last ? s.states.get(frame() - 1) : null;
      const before = beforeState && last ? { bytes: beforeState.bytes, ranWith: new Map(last.held) } : null;
      startCounting();
      if (rollback) {
        s.states.set(0, { bytes: state, held: new Map(s.held) });
        s.before0 = before;
      }
      s.ready = 1; // the owner itself
      s.syncing = true;
      np.setLoading(true);
      // The buttons held right now live in the core's input latch, not in the state: a
      // player who joins mid-press has to start with them down too.
      const held = [...s.held].map(([key, value]) => [...key.split(':').map(Number), value]);
      const ranWith = before ? [...before.ranWith].map(([key, value]) => [...key.split(':').map(Number), value]) : null;
      send({ state, g: s.gen, d: s.delay, held, before: before?.bytes ?? null, ranWith });
      if (s.ready >= np.getUserCount()) return finishSync();
      // Friends that never answer (their page is gone, or a state too big for them) don't
      // hold the game up for good.
      s.syncTimer = setTimeout(finishSync, SYNC_WAIT_MS);
    }

    function finishSync() {
      clearTimeout(s.syncTimer);
      if (!s.syncing) return;
      s.syncing = false;
      np.setLoading(false);
      note(`sync done, gen ${s.gen}`);
      send({ readyready: true, g: s.gen });
      // Still paused from taking the state: the first frame runs once the friends have vouched.
      s.waiting = true;
      s.stalledAt = 0;
      s.lastUpto = frame() + s.delay;
      broadcast();
      resumeIfReady();
      pressWhatChanged();
    }

    function loadState(data, gen, delay, held, beforeData, ranWith) {
      ejs.pause(true);
      const bytes = new Uint8Array(data);
      const before = rollback && beforeData && Array.isArray(ranWith) ? new Uint8Array(beforeData) : null;
      try {
        // With the state before it, that one goes in first (see findOrigin).
        gm().loadState(before ?? bytes);
      } catch (err) {
        console.warn('Couldn\'t load the state the host sent', err);
      }
      s.hashEvery = hashRate(bytes.length);
      s.gen = gen;
      note(`loaded state of ${bytes.length} bytes, gen ${gen}`);
      if (typeof delay === 'number' && !rollback) s.delay = clamp(delay, MIN_DELAY, MAX_DELAY);
      startCounting();
      // The core takes the state in during a later iteration, which may or may not count as
      // a frame: rather than assume, frame 0 is the last tick whose state still reads as the
      // one sent, and the count starts from there (see findOrigin).
      const heldThen = new Map((held ?? []).filter((e) => Array.isArray(e) && e.length === 3).map(([player, input, value]) => [`${player}:${input}`, value]));
      const ranWithMap = before ? new Map(ranWith.filter((e) => Array.isArray(e) && e.length === 3).map(([player, input, value]) => [`${player}:${input}`, value])) : null;
      s.origin = { h0: wholeHash(bytes), ticks: 0, bytes, held: heldThen, before: before && { h: wholeHash(before), bytes: before, ranWith: ranWithMap } };
      s.before0 = before ? { bytes: before, ranWith: ranWithMap } : null;
      // What everyone else has held down since before this player joined (with the state before
      // first, once that's in: see findOrigin).
      if (!before) setLatch(heldThen);
      s.syncing = true;
      s.waiting = true;
      s.stalledAt = 0;
      np.setLoading(true);
      send({ ready: true, g: gen });
    }

    function askForState() {
      const at = Date.now();
      if (at - s.askedAt < RESYNC_EVERY_MS) return;
      s.askedAt = at;
      note('asked for a fresh state');
      // With the hand-over this game counts from: the owner ignores an ask it has already
      // answered with a newer one (another player's, or its own), which is on its way here.
      send({ sync: true, g: s.gen });
    }

    // ---------- The delay (lockstep) ----------

    /**
     * The delay the connection calls for: enough frames for half the slowest round trip among
     * the players, plus the lead each keeps, plus one; and more while someone keeps stalling.
     * The owner's to decide; everyone else is told. Rollback's is fixed.
     */
    function adaptDelay() {
      if (rollback) return;
      const trips = [...s.peers.values()].map((pr) => pr.rtt ?? 0);
      for (const g of s.guestStats.values()) if (g.ping != null) trips.push(g.ping);
      const halfTrip = Math.max(0, ...trips) / 2;
      let wanted = LEAD + Math.ceil(halfTrip / FRAME_MS) + 1;
      // Only a stall of a frame or more says the delay is short; a millisecond's is two
      // emulators a hair out of step, which costs nothing.
      const stalls = Math.max(recent(s.stalls).filter((e) => e.ms >= FRAME_MS * 0.75).length, ...[...s.guestStats.values()].map((g) => g.stalls ?? 0));
      wanted += Math.min(3, Math.ceil(stalls / 2));
      const delay = clamp(s.pinnedDelay ?? wanted, MIN_DELAY, MAX_DELAY);
      if (delay === s.delay) return;
      s.delay = delay;
      send({ delay, g: s.gen });
    }

    // ---------- The safety net ----------

    /** How often to hash a state of this size: every frame, every few, or never. */
    const hashRate = (bytes) => (bytes <= HASH_SMALL ? 1 : bytes <= HASH_TOO_BIG ? HASH_EVERY_MEDIUM : 0);

    function keepHash(f, h) {
      s.hashes.set(f, h);
      s.lastHash = { f, h };
      for (const key of s.hashes.keys()) if (key < f - HASHES_KEPT) s.hashes.delete(key);
      // Peers' hashes for this frame that arrived first.
      for (const peer of s.peers.values()) {
        const theirs = peer.checks.get(f);
        if (theirs !== undefined) {
          peer.checks.delete(f);
          compareHash(peer, f, theirs);
        }
      }
    }

    /** Lockstep: the state as it is after frame `f`, before that frame's inputs land. */
    function hashState(f) {
      let h;
      try {
        h = stateHash(gm().getState());
      } catch {
        return;
      }
      keepHash(f, h);
    }

    /** Rollback: the states of frames that have just become final, from the ones kept. */
    function hashConfirmed() {
      if (!s.hashEvery) return;
      // The states after a frame whose late input is still to be put in are wrong until then.
      const c = Math.min(confirmedFrame(), frame(), s.pendingRollback ?? Infinity);
      for (let f = s.hashedUpTo + 1; f <= c; f++) {
        if (f % s.hashEvery !== 0) continue;
        const kept = s.states.get(f);
        if (kept) keepHash(f, stateHash(kept.bytes));
      }
      if (c > s.hashedUpTo) s.hashedUpTo = c;
    }

    /** A peer's hash for a frame against this player's own; kept for later if this player isn't there yet. */
    function compareHash(peer, f, h) {
      const own = s.hashes.get(f);
      if (own === undefined) {
        if (f > (rollback ? s.hashedUpTo : frame())) {
          peer.checks.set(f, h);
          for (const key of peer.checks.keys()) if (key < f - HASHES_KEPT) peer.checks.delete(key);
        }
        return;
      }
      if (own === h) {
        if (f > s.lastBadFrame) s.badRun = 0;
        return;
      }
      if (s.trace && !s.frozen) s.frozen = { f, peer: peer.index + 1, theirs: h, trace: [...s.trace], hashes: [...s.hashes], kept: [...s.states].map(([k, st]) => [k, hash(st.bytes)]), hashedUpTo: s.hashedUpTo, confirmed: confirmedFrame(), frame: frame(), pending: s.pendingRollback, log: s.log.slice(), bytes: s.states.get(f)?.bytes ?? null };
      s.badRun = f === s.lastBadFrame + s.hashEvery ? s.badRun + 1 : 1;
      s.lastBadFrame = f;
      if (s.badRun < MISMATCHES_BEFORE_RESYNC) return;
      s.badRun = 0;
      s.mismatches++;
      note(`diverged from player ${peer.index + 1} at frame ${f}`);
      console.warn(`Player ${peer.index + 1}'s game differs from this one at frame ${f}; a fresh state is ${np.owner ? 'sent' : 'asked for'}.`);
      if (Date.now() - s.resyncAt < RESYNC_AFTER_MISMATCH_MS) return;
      s.resyncAt = Date.now();
      if (np.owner) {
        s.resyncs++;
        sync();
      } else {
        askForState();
      }
    }

    /**
     * A friend, just after loading the host's state: while this tick's state still reads as
     * the one sent, this is frame 0 (the core hasn't run a frame of it yet); the first tick
     * that reads differently is frame 1. A state that read the same for a few ticks running
     * (a game that changes nothing in a frame, which these cores don't) counts from the last.
     */
    function findOrigin() {
      let h;
      try {
        h = wholeHash(gm().getState());
      } catch {
        s.origin = null;
        return;
      }
      s.origin.ticks++;
      const o = s.origin;
      if (o.before) {
        // The state before is in once the state reads as it (or after a few ticks regardless):
        // the buttons its frame ran with, then the state itself, whose throwaway frame is that one.
        if (h !== o.before.h && o.ticks <= 4) return;
        if (h !== o.before.h) note('the state before the hand-over didn\'t read back; loading the state anyway');
        setLatch(o.before.ranWith);
        try { gm().loadState(o.bytes); } catch (err) { console.warn('Couldn\'t load the state the host sent', err); }
        o.before = null;
        o.ticks = 0;
        o.waitingForState = true;
        return;
      }
      if (o.waitingForState) {
        if (h !== o.h0 && o.ticks <= 4) return; // not in yet
        // In: from here on the buttons are everyone's as they were at the hand-over.
        o.waitingForState = false;
        o.ticks = 1;
        setLatch(o.held);
      }
      if (h === s.origin.h0 && s.origin.ticks <= 4) {
        s.init = count();
        s.frameNo = 0;
        if (rollback) s.states.set(0, { bytes: s.origin.bytes, held: new Map(s.held) });
        return;
      }
      s.init = count() - 1;
      s.frameNo = 1;
      note(`frame 0 found after ${s.origin.ticks - 1} tick(s)`);
      s.origin = null;
      pressWhatChanged();
      // Frame 1 has run: the tick goes on as a normal one, keeping its state and applying its inputs.
    }

    // ---------- The direct connections ----------

    function makePeer(index, userid) {
      return {
        index, userid, pc: null, channel: null, rtt: null, socketRtt: null, pingAt: 0, failedAt: 0, pendingIce: [], theirFrame: 0, upto: -1, events: new Map(), contig: -1, ackOfMe: -1, checks: new Map(), path: null,
        // The direct channel: when something last came in over it and went out on it; silent,
        // this player hears nothing over it (see watchChannels); askedServer, the peer hears nothing.
        lastDirectIn: 0, lastDirectOut: 0, silent: false, askedServer: false,
      };
    }

    /**
     * Every few ms: a channel that reads open but has delivered nothing for DIRECT_SILENT_MS is
     * taken as dead, and the packets for that peer go through the server (see route) until
     * anything arrives over it again (see attach). Meanwhile, and whenever nothing else has gone
     * out on it lately, a keep-alive goes over the channel, so the peer can tell it still works.
     * The frames, stamps and hashes are the same whichever way a packet goes.
     */
    function watchChannels() {
      if (!ejs.isNetplay) return;
      const at = realNow();
      let fellBack = false;
      for (const peer of s.peers.values()) {
        if (peer.channel?.readyState !== 'open') continue;
        if (!peer.silent && at - peer.lastDirectIn > DIRECT_SILENT_MS) {
          peer.silent = true;
          fellBack = true;
          note(`nothing direct from player ${peer.index + 1} for ${Math.round(at - peer.lastDirectIn)} ms; through the server`);
        }
        if (at - peer.lastDirectOut >= KEEPALIVE_MS) sendDirect(peer, '{"t":"k"}');
      }
      if (fellBack && s.gen) broadcast();
    }

    /** What the browser says about a direct connection: the kind of path in use and its own round trip. */
    async function readPath(peer) {
      const pc = peer.pc;
      if (!pc || pc.connectionState !== 'connected') {
        peer.path = null;
        return;
      }
      try {
        const report = await pc.getStats();
        const byId = new Map();
        report.forEach((r) => byId.set(r.id, r));
        let pair = null;
        report.forEach((r) => {
          if (r.type === 'transport' && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId);
        });
        if (!pair) report.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || !pair)) pair = r; });
        if (!pair) return;
        const local = byId.get(pair.localCandidateId);
        const remote = byId.get(pair.remoteCandidateId);
        peer.path = {
          local: local?.candidateType ?? null,
          remote: remote?.candidateType ?? null,
          protocol: local?.protocol ?? null,
          rtt: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
          bytesSent: pair.bytesSent ?? null,
          bytesReceived: pair.bytesReceived ?? null,
        };
      } catch { /* not in this browser */ }
    }

    /**
     * The room's players as they are now: a peer for each of the others, connected directly where
     * possible. Peers are kept by who they are: when someone earlier leaves, the players after
     * them move down a number and keep their connections. (Players keep their order, so which of
     * a pair makes the offer never changes.)
     */
    function ensurePeers() {
      const ids = Object.keys(np.players ?? {});
      const me = myIndex();
      const byUser = new Map([...s.peers.values()].map((peer) => [peer.userid, peer]));
      s.peers.clear();
      ids.forEach((userid, index) => {
        if (index === me) return;
        const peer = byUser.get(userid) ?? makePeer(index, userid);
        byUser.delete(userid);
        peer.index = index;
        s.peers.set(index, peer);
      });
      for (const gone of byUser.values()) closeConnection(gone);
      for (const peer of s.peers.values()) if (!peer.pc) connect(peer);
    }

    /** Lets go of a peer's direct connection: closed, since one that isn't is never freed (and a page may only have so many). */
    function closeConnection(peer) {
      const pc = peer.pc;
      peer.channel = null;
      peer.pc = null;
      try { pc?.close(); } catch { /* already */ }
    }

    /** A direct connection that failed: let go of, and tried again in a while. */
    function connectionFailed(peer, pc) {
      if (peer.pc !== pc) return;
      closeConnection(peer);
      peer.failedAt = now();
      setTimeout(() => { if (!peer.pc && s.peers.get(peer.index) === peer && ejs.isNetplay) connect(peer); }, PEER_RETRY_MS);
    }

    /** Sets up a direct connection with a peer. The lower player number makes the offer. */
    function connect(peer) {
      if (typeof RTCPeerConnection !== 'function') return;
      let pc;
      try {
        pc = new RTCPeerConnection({ iceServers });
      } catch (err) {
        // A bad ICE server in the config, say: the packets go through the room's socket instead.
        console.warn('Couldn\'t set up a direct connection; using the server', err);
        return;
      }
      peer.pc = pc;
      peer.pendingIce = [];
      let connected = false;
      pc.onicecandidate = (e) => { if (e.candidate) signal(peer, { candidate: e.candidate.toJSON() }); };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') connected = true;
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') connectionFailed(peer, pc);
      };
      // An offer or answer that went nowhere leaves a connection that never fails on its own.
      setTimeout(() => { if (!connected) connectionFailed(peer, pc); }, PEER_CONNECT_MS);
      pc.ondatachannel = (e) => attach(peer, e.channel);
      if (myIndex() < peer.index) {
        // Unordered and never resent: every packet carries what's needed (see packetFor).
        attach(peer, pc.createDataChannel('inputs', { ordered: false, maxRetransmits: 0 }));
        pc.createOffer().then((offer) => pc.setLocalDescription(offer)).then(() => signal(peer, { sdp: pc.localDescription.toJSON() }))
          .catch((err) => console.warn('Couldn\'t offer a direct connection', err));
      }
    }

    function attach(peer, channel) {
      peer.channel = channel;
      peer.silent = false;
      peer.lastDirectIn = realNow();
      channel.onmessage = (e) => {
        // A test's lost packets (dropPackets): nothing over the channel arrives, keep-alives included.
        if (realNow() < s.dropUntil) return;
        if (peer.channel === channel) {
          peer.lastDirectIn = realNow();
          if (peer.silent) {
            peer.silent = false;
            note(`direct from player ${peer.index + 1} again`);
          }
        }
        let message;
        try {
          message = JSON.parse(e.data);
        } catch {
          return;
        }
        if (message.t === 'f') onPacket(message, e.data.length);
        else if (message.t === 'ping') sendDirect(peer, JSON.stringify({ t: 'pong', at: message.at }));
        else if (message.t === 'pong') peer.rtt = Date.now() - message.at;
      };
      channel.onopen = () => {
        if (peer.channel === channel) peer.lastDirectIn = realNow();
        broadcast();
      };
      channel.onclose = () => { if (peer.channel === channel) peer.channel = null; };
    }

    /** One signalling message to a peer, through the room's socket. */
    function signal(peer, data) {
      np.socket?.emit('signal', { to: peer.userid, data });
    }

    async function onSignal({ from, data }) {
      const peer = [...s.peers.values()].find((pr) => pr.userid === from);
      if (!peer || !data) return;
      try {
        if (data.sdp) {
          // An offer always comes from a connection the peer has just made (nothing here offers
          // twice on one), so one here that has already had the other side's is finished with.
          if (data.sdp.type === 'offer' && peer.pc?.remoteDescription) closeConnection(peer);
          if (!peer.pc) connect(peer);
          const pc = peer.pc;
          if (!pc) return;
          await pc.setRemoteDescription(data.sdp);
          if (data.sdp.type === 'offer') {
            await pc.setLocalDescription(await pc.createAnswer());
            signal(peer, { sdp: pc.localDescription.toJSON() });
          }
          if (peer.pc !== pc) return; // replaced meanwhile: the addresses waiting are the new one's
          for (const candidate of peer.pendingIce.splice(0)) await pc.addIceCandidate(candidate);
        } else if (data.candidate) {
          if (peer.pc?.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
          else peer.pendingIce.push(data.candidate);
        }
      } catch (err) {
        console.warn('A direct connection\'s details couldn\'t be used', err);
      }
    }

    /** Once in the room: the socket's signalling, and the direct connections. */
    function onJoined() {
      if (np.socket && !s.signalOn) {
        s.signalOn = true;
        np.socket.on('signal', onSignal);
      }
      ensurePeers();
      if (!np.owner) s.waiting = true;
    }

    // ---------- What's measured ----------

    /**
     * This player's statistics: lag (press to screen, the median of recent presses, ms), ping
     * (the slowest round trip to another player, ms), ahead (frames the others run ahead of
     * this player, negative when they're behind), stalls (times this player ran out of frames
     * in the last ten seconds) and stalled (ms of those), delay (frames), transport ("direct",
     * "server" or "mixed"), mode, rollbacks (in the last ten seconds) with rollbackFrames (the
     * median length) and rollbackMs (the median cost), resyncs (the owner: fresh states sent
     * because the games had come apart) and mismatches. The owner's carry `guests`: each
     * friend's, by their number.
     */
    function stats() {
      const peers = [...s.peers.values()];
      const rtts = peers.map((pr) => pr.rtt ?? pr.socketRtt).filter((n) => n != null);
      const direct = peers.filter((pr) => route(pr) === 'direct').length;
      const stalls = recent(s.stalls).filter((e) => e.ms >= FRAME_MS * 0.75);
      const rollbacks = recent(s.rollbacks);
      const mine = {
        mode,
        lag: median(recent(s.lags).map((e) => e.ms)),
        ping: rtts.length ? Math.max(...rtts) : null,
        ahead: median(s.aheads),
        stalls: stalls.length,
        stalled: Math.round(stalls.reduce((sum, e) => sum + e.ms, 0)),
        delay: s.delay,
        transport: !peers.length ? null : direct === peers.length ? 'direct' : direct ? 'mixed' : 'server',
        resyncs: s.resyncs,
        mismatches: s.mismatches,
        rollbacks: rollbacks.length,
        rollbackFrames: median(rollbacks.map((r) => r.frames)),
        rollbackMs: median(rollbacks.map((r) => Math.round(r.ms * 10) / 10)),
      };
      if (np.owner) mine.guests = Object.fromEntries([...s.guestStats].map(([index, g]) => [index + 1, g]));
      return mine;
    }

    /** For looking in from outside (tests, the console, the stats page). */
    const status = () => ({
      mode, frame: frame(), gen: s.gen, delay: s.delay, upto: s.lastUpto, waiting: s.waiting, syncing: s.syncing, pending: s.history.size, resyncs: s.resyncs,
      mismatches: s.mismatches, hashEvery: s.hashEvery, confirmed: rollback ? confirmedFrame() : null, states: s.states.size, rollbacks: s.rollbacks.length,
      sinceTick: Math.round(realNow() - s.lastTick), paused: ejs.paused, count: count(), init: s.init, log: s.log.slice(-12),
      pace: p ? { fps: p.fps, done: p.done, extra: p.extra, runner: Boolean(p.runner), loopsPerSecond: s.lastRates?.loops ?? null } : null,
      pendingRollback: s.pendingRollback, deferred: s.deferred, lateApplied: s.lateApplied, replaysCarried: s.replaysCarried, statesMissed: s.statesMissed,
      peers: [...s.peers.values()].map((pr) => ({ index: pr.index, direct: route(pr) === 'direct', upto: pr.upto, contig: pr.contig, theirFrame: pr.theirFrame, rtt: pr.rtt })),
    });

    /**
     * Everything about this player's game for the stats page: the room, the engine's state,
     * the statistics, this second's rates, each peer in full, recent presses and stalls, the
     * event log, and the browser.
     */
    function detail() {
      const names = Object.values(np.players ?? {}).map((pl) => pl.player_name);
      const st = status();
      delete st.log;
      delete st.peers;
      return {
        at: Date.now(),
        role: np.owner ? 'host' : 'guest',
        room: room && { code: room.code, title: room.title, name: room.name },
        player: myIndex() + 1,
        players: names,
        engine: st,
        stats: stats(),
        rates: s.lastRates,
        peers: [...s.peers.values()].map((pr) => ({
          player: pr.index + 1,
          name: names[pr.index] ?? null,
          transport: route(pr) === 'direct' ? 'direct'
            : pr.channel?.readyState === 'open' ? `server (direct channel ${pr.silent ? 'silent' : 'silent their way: they hear nothing'})`
              : pr.pc ? `direct (${pr.pc.connectionState})` : 'server',
          rtt: pr.rtt,
          socketRtt: pr.socketRtt,
          path: pr.path,
          theirFrame: pr.theirFrame,
          upto: pr.upto,
          effectiveVouch: effectiveVouch(pr),
          contig: pr.contig,
          ackOfMe: pr.ackOfMe,
          buffered: pr.events.size,
          checksWaiting: pr.checks.size,
        })),
        lags: recent(s.lags).map((e) => Math.round(e.ms)),
        stalls: recent(s.stalls).map((e) => Math.round(e.ms)),
        rollbacks: recent(s.rollbacks).map((r) => r.frames),
        log: s.log.slice(-40),
        socket: { connected: Boolean(np.socket?.connected), transport: np.socket?.io?.engine?.transport?.name ?? null },
        browser: { hidden: document.hidden, ua: navigator.userAgent, dpr: devicePixelRatio, cores: navigator.hardwareConcurrency ?? null },
      };
    }

    function everySecond() {
      if (p) {
        s.rates.loops = p.loops;
        p.loops = 0;
      }
      s.lastRates = { ...s.rates };
      s.rates = { ticks: 0, frames: 0, loops: 0, packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0 };
      if (!ejs.isNetplay) return;
      const me = myIndex();
      for (const peer of s.peers.values()) readPath(peer);
      for (const peer of s.peers.values()) {
        if (peer.channel?.readyState === 'open') sendDirect(peer, JSON.stringify({ t: 'ping', at: Date.now() }));
      }
      send({ ping: Date.now(), from: me });
      // Presses that never came back (sent while syncing, say) shouldn't count later.
      s.sentInputs = s.sentInputs.filter((e) => now() - e.at < RECENT_MS);
      // Measured over the second just gone, so before the "ahead" readings are cleared.
      const mine = stats();
      s.aheads.length = 0;
      if (np.owner) adaptDelay();
      else send({ stats: { from: me, lag: mine.lag, ahead: mine.ahead, stalls: mine.stalls, stalled: mine.stalled, ping: mine.ping, transport: mine.transport, rollbacks: mine.rollbacks, rollbackFrames: mine.rollbackFrames } });
      onStats(mine);
      report(mine);
      try { channel?.postMessage(detail()); } catch { /* something in it couldn't be copied */ }
    }

    /**
     * This player's numbers to the server, for the session's log (server/lib/netplaylog.js):
     * the statistics, this second's frames and packets, whether the tab is hidden, each peer's
     * round trip, and the engine's log lines since the last report.
     */
    function report(mine) {
      if (!np.socket?.connected) return;
      const events = s.log.slice(s.logged).map((line) => line.replace(/^\d+ /, ''));
      s.logged = s.log.length;
      const r = s.lastRates ?? {};
      np.socket.emit('report', {
        frame: frame(), mode: mine.mode, lag: mine.lag, ping: mine.ping, ahead: mine.ahead, stalls: mine.stalls, stalled: mine.stalled, delay: mine.delay,
        transport: mine.transport, rollbacks: mine.rollbacks, rollbackFrames: mine.rollbackFrames, rollbackMs: mine.rollbackMs, mismatches: mine.mismatches, resyncs: mine.resyncs,
        frames: r.frames, loops: r.loops, deferred: s.deferred, lateApplied: s.lateApplied, statesMissed: s.statesMissed, packetsIn: r.packetsIn, packetsOut: r.packetsOut, bytesIn: r.bytesIn, bytesOut: r.bytesOut,
        hidden: document.hidden,
        peers: [...s.peers.values()].map((pr) => ({ p: pr.index + 1, rtt: pr.rtt ?? pr.socketRtt ?? null, transport: route(pr) })),
        events,
      });
    }

    // ---------- The pieces EmulatorJS's netplay calls ----------

    // EmulatorJS resets its counter on every change to the room; the counter is this file's
    // business now (the state hand-over sets it).
    np.reset = () => {};
    np.sync = sync;
    const joinedBase = np.roomJoined;
    np.roomJoined = (...args) => { joinedBase(...args); onJoined(); };
    const tableBase = np.updatePlayersTable;
    let lastIds = [];
    np.updatePlayersTable = () => {
      tableBase();
      if (!ejs.isNetplay) return;
      const ids = Object.keys(np.players ?? {});
      if (np.owner) carryHeldButtons(lastIds, ids);
      lastIds = ids;
      // A player who left was perhaps the one everyone was waiting for.
      ensurePeers();
      resumeIfReady();
    };

    /**
     * The owner, as the room changes: the buttons latched for each player go with that player to
     * their new number, and a player who left lets go of theirs. Otherwise a button held when
     * someone left stays down on that controller for good, and the players after them find their
     * old number's buttons stuck. EmulatorJS has the owner send a fresh state right after this,
     * and the buttons held go with it (see sync), so every player's latch is put right at once.
     */
    function carryHeldButtons(before, after) {
      if (!before.length) return;
      const then = new Map();
      for (const [key, value] of s.held) {
        const [player, input] = key.split(':').map(Number);
        const to = after.indexOf(before[player]);
        if (to >= 0) then.set(`${to}:${input}`, value);
      }
      setLatch(then);
    }

    /** Messages on the room's socket, from any other player. */
    np.dataMessage = (data) => {
      if (!data || typeof data !== 'object') return;
      if (data.t === 'f') return s.dropDirectOnly || realNow() >= s.dropUntil ? onPacket(data) : undefined;
      if (data.ping) send({ pong: data.ping, to: data.from, from: myIndex() });
      if (data.pong && data.to === myIndex()) {
        const peer = s.peers.get(data.from);
        if (peer) peer.socketRtt = Date.now() - data.pong;
      }
      if (np.owner) {
        if (data.sync === true && (typeof data.g !== 'number' || data.g === s.gen)) sync();
        if (data.ready === true && data.g === s.gen && s.syncing && ++s.ready >= np.getUserCount()) finishSync();
        if (data.stats && typeof data.stats.from === 'number') s.guestStats.set(data.stats.from, data.stats);
        return;
      }
      if (data.state) loadState(data.state, data.g, data.d, data.held, data.before, data.ranWith);
      if (data.readyready && data.g === s.gen) {
        note(`readyready gen ${data.g}`);
        s.syncing = false;
        np.setLoading(false);
        s.waiting = true;
        s.lastUpto = frame() + s.delay;
        broadcast();
        resumeIfReady();
        pressWhatChanged();
      }
      if (typeof data.delay === 'number' && data.g === s.gen && !rollback) s.delay = clamp(data.delay, MIN_DELAY, MAX_DELAY);
      // The owner restarted: its game is at a new place, so the state is asked for rather than
      // restarting here too and hoping to line up.
      if (data.restart) askForState();
    };

    // After every frame the core runs (see forwardPostMainLoop in public/emu/play.html).
    ejs.Module.postMainLoop = () => {
      s.lastTick = realNow();
      s.rates.ticks++;
      const ran = Math.max(0, count() - s.lastCount);
      s.rates.frames += ran;
      s.lastCount = count();
      if (s.replay) return replayTick(ran);
      if (s.origin && ejs.isNetplay && !s.syncing) {
        findOrigin(); // sets the frame number itself when it finds frame 0
        if (rollback && !s.origin) p?.ran();
      } else if (rollback && ran && !s.origin) {
        // One frame an iteration, with the audio no longer pacing the core (see audioSyncOff);
        // more would mean a frame ran without its inputs, which the hashes would then catch.
        if (ran > 1) note(`${ran} frames in one iteration`);
        s.frameNo += ran;
        p?.ran();
      }
      const f = frame();
      np.currentFrame = f;
      if (!ejs.isNetplay || s.syncing || s.origin) return;
      if (rollback) {
        if (!ran) {
          if (!nextMayRun()) stall();
          return;
        }
        keepState(f);
        applyFrame(f);
        s.confirmed = Math.min(confirmedFrame(), f);
        hashConfirmed();
        // A rollback waiting on the loop (the loop's own iteration can't run another): next.
        if (s.pendingRollback != null) setTimeout(tryRollback, 0);
      } else {
        if (s.hashEvery && f % s.hashEvery === 0 && s.lastHash?.f !== f) hashState(f);
        applyFrame(f);
      }
      // Everything up to this frame is said; the others may run that far. Never a frame less
      // than last time, which a shorter delay would otherwise take back.
      s.lastUpto = Math.max(f + s.delay, s.lastUpto);
      broadcast();
      if (!nextMayRun()) stall();
      else if (!np.owner && Math.max(0, ...[...s.peers.values()].map((pr) => pr.theirFrame)) - f > RESYNC_BEHIND) askForState();
    };

    clearInterval(s.statsTimer);
    s.statsTimer = setInterval(everySecond, STATS_EVERY_MS);
    clearInterval(s.resendTimer);
    s.resendTimer = setInterval(() => { watchChannels(); resendWhileWaiting(); }, RESEND_WAITING_MS / 2);

    return {
      stats,
      detail,
      status,
      /** A test's: holds lockstep's delay at `n` frames (the owner announces it), or lets it adapt again with null. */
      pinDelay: (n) => { s.pinnedDelay = n; if (np.owner) adaptDelay(); },
      /** A test's: every packet from the others is held this many ms before it's read. */
      /** A test's: records each frame's held buttons and state hash, frozen at the first divergence. */
      trace: (on) => { s.trace = on ? new Map() : null; s.frozen = null; },
      /** A test's: the state kept after a frame (rollback), for comparing two players' games byte by byte. */
      keptState: (f) => s.states.get(f)?.bytes ?? null,
      frozen: () => s.frozen,
      /** A test's: told of every input put in on its frame (replays included; not the latch restored for one). */
      onApply: (fn) => { s.onApply = typeof fn === 'function' ? fn : null; },
      setFakeLatency: (ms, jitter = 0) => { s.fakeLatency = Math.max(0, ms | 0); s.fakeJitter = Math.max(0, jitter | 0); },
      /** A test's: every packet from the others arriving in the next `ms` is lost (only the direct channels' with `directOnly`, as a channel that reads open but delivers nothing). */
      dropPackets: (ms, directOnly = false) => { s.dropUntil = realNow() + Math.max(0, ms | 0); s.dropDirectOnly = Boolean(directOnly); },
    };
  }

  return { lockstep, audioSyncOff, pace, MIN_DELAY, MAX_DELAY, ROLLBACK_DELAY };
})();
