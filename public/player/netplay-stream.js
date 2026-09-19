// Playing with a friend by video: the host's side. For the consoles two emulators can't be
// kept in step (the PlayStation, the Nintendo 64, the Jaguar, the Sega CD and Saturn; see CORES in
// server/lib/emulatorjs.js), only the host runs the game. Each friend gets it as a video and
// audio stream over a WebRTC connection straight from the host's browser, and sends their
// presses back over a data channel on the same connection, which the host puts into the
// core as that friend's controller. What the friend sees runs a little behind the game
// (encoding, the trip, decoding) and their presses take the trip back, so it suits games
// that don't hang on split-second timing; the app says so before hosting.
//
// The room, the socket and the introductions (signalling) are the ones the rollback engine
// uses (see netplay-fixes.js and server/lib/netplay.js); a friend's page is the small viewer
// in public/emu/watch.html, which speaks the room's protocol directly. Like the other
// player-page scripts, a plain script that patches the running emulator from outside.

window.NetplayStream = (() => {
  const STATS_EVERY_MS = 1000;
  const FRAME_RATE = 60;
  const MAX_KBPS = 6000;
  // The canvas is the size of the screen it's on; a console's picture needs far less, and the
  // encoder's time and the bitrate go with the size. Sent no taller than this (scaled by whole
  // numbers, so the pixels stay crisp).
  const MAX_HEIGHT = 540;
  const PEER_RETRY_MS = 15000;
  const INPUTS = 24; // RetroArch's buttons and sticks

  /**
   * Catches the audio the core makes, for the stream. RetroArch's OpenAL makes its own
   * AudioContext and connects to its destination; from here on every context made on this
   * page also feeds a stream destination, whose track the connections send. Call before the
   * core starts (the context is made as the game starts).
   */
  function captureAudio() {
    if (window.NetplayStream.audio) return window.NetplayStream.audio;
    const audio = { context: null, destination: null };
    const Base = window.AudioContext || window.webkitAudioContext;
    if (typeof Base !== 'function') return audio;
    const connectBase = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function connect(target, ...rest) {
      const out = connectBase.call(this, target, ...rest);
      // Whatever plays to the speakers plays into the stream too.
      if (audio.destination && target === audio.context?.destination && this !== audio.destination) {
        try { connectBase.call(this, audio.destination); } catch { /* a node of another context */ }
      }
      return out;
    };
    function Captured(...args) {
      const context = new Base(...args);
      if (!audio.context) {
        audio.context = context;
        audio.destination = context.createMediaStreamDestination();
      }
      return context;
    }
    Captured.prototype = Base.prototype;
    window.AudioContext = Captured;
    if (window.webkitAudioContext) window.webkitAudioContext = Captured;
    window.NetplayStream.audio = audio;
    return audio;
  }

  /**
   * Hosts the game as a stream on a running emulator that has joined its room.
   * @param {object} ejs the EmulatorJS instance, its netplay functions defined
   * @param {object} [options]
   * @param {object[]} [options.iceServers] the STUN/TURN servers the connections use
   * @param {function} [options.onStats] given the statistics about once a second (see stats())
   * @param {object} [options.room] { code, title, name, owner }, for the stats page
   */
  function host(ejs, { iceServers = [], onStats = () => {}, room = null } = {}) {
    const np = ejs.netplay;
    const gm = () => ejs.gameManager;
    const s = {
      stream: null,        // the canvas's video track and the audio track, as one stream
      peers: new Map(),    // userid -> peer (see makePeer), whose `held` is what they have down
      tunedHeight: 0,      // the picture's height the senders were last sized for
      signalOn: false,
      statsTimer: 0,
      log: [],
      lastVideo: null,     // the video track's settings, for the stats
    };
    const myIndex = () => Object.keys(np.players ?? {}).indexOf(np.playerID);
    const note = (what) => {
      s.log.push(`${Math.round(performance.now())} ${what}`);
      if (s.log.length > 200) s.log.shift();
    };
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('rgb-netplay') : null;

    // ---------- The stream ----------

    function stream() {
      if (s.stream) return s.stream;
      const canvas = ejs.canvas ?? document.querySelector('#game canvas');
      if (!canvas?.captureStream) return null;
      const video = canvas.captureStream(FRAME_RATE);
      const [track] = video.getVideoTracks();
      if (track) {
        // Smooth motion over sharp still detail, as for a game.
        try { track.contentHint = 'motion'; } catch { /* older browser */ }
      }
      const audio = window.NetplayStream.audio?.destination?.stream;
      const tracks = [...video.getVideoTracks(), ...(audio ? audio.getAudioTracks() : [])];
      s.stream = new MediaStream(tracks);
      note(`stream: ${tracks.map((t) => t.kind).join(' + ') || 'nothing to send'}`);
      return s.stream;
    }

    // ---------- The connections ----------

    function makePeer(userid) {
      // held: input -> { player, v }, pressed on the controller they had then; seq: input ->
      // the number of the newest message about it (see press()).
      // keys and buttons: a computer's keys (by their code) and mouse buttons the friend has down.
      return { userid, pc: null, channel: null, rtt: null, path: null, video: null, failedAt: 0, pendingIce: [], reported: null, held: new Map(), seq: new Map(), keys: new Set(), buttons: new Set() };
    }

    /** The room's friends as they are now: a connection for each. */
    function ensurePeers() {
      const ids = Object.keys(np.players ?? {}).filter((id) => id !== np.playerID);
      for (const [id, peer] of s.peers) {
        if (!ids.includes(id)) {
          peer.pc?.close();
          s.peers.delete(id);
          release(peer);
        }
      }
      reseat();
      for (const id of ids) {
        if (!s.peers.has(id)) s.peers.set(id, makePeer(id));
        const peer = s.peers.get(id);
        if (!peer.pc) connect(peer);
      }
    }

    /** A friend who left: their buttons come up, on the controller they were working, and their keys and mouse buttons. */
    function release(peer) {
      for (const [input, { player }] of peer.held) gm().functions.simulateInput(player, input, 0);
      peer.held.clear();
      for (const code of peer.keys) gm().functions.pressKey?.(code, false);
      peer.keys.clear();
      for (const button of peer.buttons) gm().functions.mouseButton?.(button, false);
      peer.buttons.clear();
    }

    /**
     * Friends who moved to another controller (someone before them left): what they hold
     * comes up on the old one and goes down on the new. All the old ones first, as a friend
     * may be moving onto a controller another is leaving.
     */
    function reseat() {
      const moved = [];
      for (const peer of s.peers.values()) {
        const now = playerOf(peer.userid);
        for (const [input, held] of peer.held) {
          if (held.player === now) continue;
          gm().functions.simulateInput(held.player, input, 0);
          moved.push([peer, input, held, now]);
        }
      }
      for (const [peer, input, held, now] of moved) {
        if (now < 1) {
          peer.held.delete(input);
          continue;
        }
        held.player = now;
        gm().functions.simulateInput(now, input, held.v);
      }
    }

    /** The controller a friend works: their number in the room, counted from 0. */
    const playerOf = (userid) => Object.keys(np.players ?? {}).indexOf(userid);

    /** The host offers: its stream, and a channel for the friend's presses. */
    function connect(peer) {
      if (typeof RTCPeerConnection !== 'function') return;
      const media = stream();
      const pc = new RTCPeerConnection({ iceServers });
      peer.pc = pc;
      peer.pendingIce = [];
      pc.onicecandidate = (e) => { if (e.candidate) signal(peer, { candidate: e.candidate.toJSON() }); };
      pc.onconnectionstatechange = () => {
        if (peer.pc !== pc) return;
        note(`connection to player ${playerOf(peer.userid) + 1}: ${pc.connectionState}`);
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          peer.channel = null;
          peer.pc = null;
          // A failed connection holds on to its transport and its video encoder until closed.
          try { pc.close(); } catch { /* already closed */ }
          peer.failedAt = performance.now();
          setTimeout(() => { if (!peer.pc && s.peers.get(peer.userid) === peer && ejs.isNetplay) connect(peer); }, PEER_RETRY_MS);
        }
      };
      if (media) {
        for (const track of media.getTracks()) {
          const sender = pc.addTrack(track, media);
          if (track.kind === 'video') tune(sender);
        }
      }
      // Ordered, so a release never overtakes its press.
      attach(peer, pc.createDataChannel('inputs', { ordered: true }));
      pc.createOffer().then((offer) => pc.setLocalDescription(offer)).then(() => signal(peer, { sdp: pc.localDescription.toJSON() }))
        .catch((err) => console.warn('Couldn\'t offer the stream', err));
    }

    /** The video for low delay: frame rate before sharpness, a sensible size, and a ceiling on the bitrate. */
    async function tune(sender) {
      try {
        const params = sender.getParameters();
        params.degradationPreference = 'maintain-framerate';
        if (!params.encodings?.length) params.encodings = [{}];
        const height = sender.track?.getSettings?.().height ?? 0;
        params.encodings[0].scaleResolutionDownBy = Math.max(1, Math.ceil(height / MAX_HEIGHT));
        params.encodings[0].maxBitrate = MAX_KBPS * 1000;
        params.encodings[0].maxFramerate = FRAME_RATE;
        await sender.setParameters(params);
      } catch { /* not in this browser */ }
    }

    function attach(peer, channel) {
      peer.channel = channel;
      channel.onmessage = (e) => {
        let message;
        try {
          message = JSON.parse(e.data);
        } catch {
          return;
        }
        onMessage(peer, message);
      };
      channel.onclose = () => { if (peer.channel === channel) peer.channel = null; };
    }

    /** A friend's message, over their channel or through the room's socket. */
    function onMessage(peer, message) {
      if (!message || typeof message !== 'object') return;
      if (message.t === 'i') return press(peer, message.i, message.v, message.n);
      // Everything the friend has down now (sent as their channel opens or their connection
      // fails, when a press or release may have been lost on the way): what isn't in it is up.
      if (message.t === 'held' && Array.isArray(message.held)) {
        const now = new Map(message.held.filter((pair) => Array.isArray(pair)));
        for (let input = 0; input < INPUTS; input++) press(peer, input, now.get(input) ?? 0, message.n);
        return;
      }
      // A computer's keyboard and mouse (an Apple IIgs game): keys by where they are on the keyboard,
      // the mouse's movement and its buttons. What the platform does with them is its page's (see
      // hostByVideo in mame-netplay.js); a page that has none of them takes none.
      if (message.t === 'k') return key(peer, message.c, message.v);
      if (message.t === 'kheld' && Array.isArray(message.held)) {
        const now = new Set(message.held.filter(isKeyCode));
        for (const code of [...peer.keys]) if (!now.has(code)) key(peer, code, 0);
        for (const code of now) key(peer, code, 1);
        return;
      }
      if (message.t === 'm') {
        const dx = clampMove(message.x);
        const dy = clampMove(message.y);
        if (playerOf(peer.userid) >= 1 && (dx || dy)) gm().functions.mouseMove?.(dx, dy);
        return;
      }
      if (message.t === 'b') {
        if (playerOf(peer.userid) < 1 || ![0, 1, 2].includes(message.b)) return;
        const down = Boolean(message.v);
        if (down === peer.buttons.has(message.b)) return;
        if (down) peer.buttons.add(message.b);
        else peer.buttons.delete(message.b);
        gm().functions.mouseButton?.(message.b, down);
        return;
      }
      if (message.t === 'ping') {
        send(peer, { t: 'pong', at: message.at });
        return;
      }
      if (message.t === 'pong') peer.rtt = Date.now() - message.at;
      if (message.t === 'stats') peer.reported = message.stats;
    }

    /**
     * A friend's press into the core, as their controller. A message numbered no newer than one
     * already taken for that input is late (it came the slow way, through the server, while a
     * newer one came over the direct channel) and is dropped.
     */
    function press(peer, input, value, n) {
      const player = playerOf(peer.userid);
      if (player < 1 || !Number.isInteger(input) || !(input >= 0 && input < INPUTS)) return;
      if (typeof n === 'number') {
        if (n <= (peer.seq.get(input) ?? -Infinity)) return;
        peer.seq.set(input, n);
      }
      const v = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      const had = peer.held.get(input);
      // Pressed on another controller before the friend moved: that one comes up.
      if (had && had.player !== player) gm().functions.simulateInput(had.player, input, 0);
      gm().functions.simulateInput(player, input, v);
      if (v) peer.held.set(input, { player, v });
      else peer.held.delete(input);
    }

    // A key as the browser names where it is ("KeyA", "ArrowLeft"), and one mouse message's movement.
    const isKeyCode = (code) => typeof code === 'string' && /^[A-Za-z0-9]{1,24}$/.test(code);
    const clampMove = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-2000, Math.min(2000, Math.round(v))) : 0);

    /** A friend's key going down or coming up, on the host's keyboard. */
    function key(peer, code, value) {
      if (playerOf(peer.userid) < 1 || !isKeyCode(code)) return;
      const down = Boolean(value);
      if (down === peer.keys.has(code)) return;
      if (down) peer.keys.add(code);
      else peer.keys.delete(code);
      gm().functions.pressKey?.(code, down);
    }

    function send(peer, message) {
      if (peer.channel?.readyState === 'open') {
        try {
          peer.channel.send(JSON.stringify(message));
          return;
        } catch { /* closing */ }
      }
      np.sendMessage({ ...message, to: peer.userid });
    }

    function signal(peer, data) {
      np.socket?.emit('signal', { to: peer.userid, data });
    }

    async function onSignal({ from, data }) {
      const peer = s.peers.get(from);
      if (!peer || !data) return;
      try {
        if (data.sdp) {
          const pc = peer.pc;
          if (!pc) return;
          await pc.setRemoteDescription(data.sdp);
          for (const candidate of peer.pendingIce.splice(0)) await pc.addIceCandidate(candidate);
        } else if (data.candidate) {
          if (peer.pc?.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
          else peer.pendingIce.push(data.candidate);
        }
      } catch (err) {
        console.warn('A connection\'s details couldn\'t be used', err);
      }
    }

    // ---------- What's measured ----------

    /** What the browser says about a connection: the path and what the video is doing. */
    async function readStats(peer) {
      const pc = peer.pc;
      if (!pc || pc.connectionState !== 'connected') {
        peer.path = null;
        peer.video = null;
        return;
      }
      try {
        const report = await pc.getStats();
        const byId = new Map();
        report.forEach((r) => byId.set(r.id, r));
        let pair = null;
        report.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId); });
        if (pair) {
          const local = byId.get(pair.localCandidateId);
          const remote = byId.get(pair.remoteCandidateId);
          peer.path = { local: local?.candidateType ?? null, remote: remote?.candidateType ?? null, protocol: local?.protocol ?? null, rtt: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null };
        }
        report.forEach((r) => {
          if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
          const last = peer.video;
          const kbps = last && r.timestamp > last.timestamp ? Math.round(((r.bytesSent - last.bytesSent) * 8) / (r.timestamp - last.timestamp)) : null;
          peer.video = { timestamp: r.timestamp, bytesSent: r.bytesSent, fps: r.framesPerSecond ?? null, kbps, width: r.frameWidth ?? null, height: r.frameHeight ?? null, limited: r.qualityLimitationReason ?? null, encodeMs: r.framesEncoded ? Math.round((r.totalEncodeTime / r.framesEncoded) * 1000 * 10) / 10 : null };
        });
      } catch { /* not in this browser */ }
    }

    /**
     * The statistics: `mode` ("stream"), and for each friend by their number, `guests`: the
     * round trip of their presses (ping, ms), the transport ("direct" or "server"), and the
     * video they get (fps, kbps, width, height, whether the encoder is held back and why),
     * plus what they report about their side (see the viewer's report).
     */
    function stats() {
      const guests = {};
      for (const peer of s.peers.values()) {
        const player = playerOf(peer.userid) + 1;
        if (player < 2) continue;
        guests[player] = {
          ping: peer.rtt,
          transport: peer.channel?.readyState === 'open' ? 'direct' : 'server',
          videoFps: peer.video?.fps ?? null,
          videoKbps: peer.video?.kbps ?? null,
          videoWidth: peer.video?.width ?? null,
          videoHeight: peer.video?.height ?? null,
          limited: peer.video?.limited && peer.video.limited !== 'none' ? peer.video.limited : null,
          encodeMs: peer.video?.encodeMs ?? null,
          viewer: peer.reported ?? null,
        };
      }
      const [track] = s.stream?.getVideoTracks() ?? [];
      s.lastVideo = track?.getSettings?.() ?? null;
      return { mode: 'stream', guests, source: s.lastVideo && { width: s.lastVideo.width, height: s.lastVideo.height, fps: s.lastVideo.frameRate }, audio: Boolean(window.NetplayStream.audio?.destination) };
    }

    function detail() {
      const names = Object.values(np.players ?? {}).map((pl) => pl.player_name);
      const st = stats();
      return {
        at: Date.now(),
        role: 'host',
        room: room && { code: room.code, title: room.title, name: room.name },
        player: myIndex() + 1,
        players: names,
        engine: { mode: 'stream', source: st.source, audio: st.audio, paused: ejs.paused },
        stats: st,
        peers: [...s.peers.values()].map((pr) => ({
          player: playerOf(pr.userid) + 1,
          name: names[playerOf(pr.userid)] ?? null,
          transport: pr.channel?.readyState === 'open' ? 'direct' : pr.pc ? `direct (${pr.pc.connectionState})` : 'server',
          rtt: pr.rtt,
          path: pr.path,
          video: pr.video,
          viewer: pr.reported,
        })),
        log: s.log.slice(-40),
        socket: { connected: Boolean(np.socket?.connected), transport: np.socket?.io?.engine?.transport?.name ?? null },
        browser: { hidden: document.hidden, ua: navigator.userAgent, dpr: devicePixelRatio, cores: navigator.hardwareConcurrency ?? null },
      };
    }

    /**
     * The canvas changes size with the host's window (full screen, say): the senders are sized
     * again so the picture sent stays near MAX_HEIGHT.
     */
    function retune() {
      const height = s.stream?.getVideoTracks()[0]?.getSettings?.().height ?? 0;
      if (!height || height === s.tunedHeight) return;
      s.tunedHeight = height;
      for (const peer of s.peers.values()) {
        for (const sender of peer.pc?.getSenders() ?? []) if (sender.track?.kind === 'video') tune(sender);
      }
    }

    function everySecond() {
      if (!ejs.isNetplay) return;
      retune();
      for (const peer of s.peers.values()) {
        readStats(peer);
        send(peer, { t: 'ping', at: Date.now() });
      }
      const mine = stats();
      onStats(mine);
      report(mine);
      try { channel?.postMessage(detail()); } catch { /* something in it couldn't be copied */ }
    }

    /** The host's numbers to the server, for the session's log (server/lib/netplaylog.js). */
    function report(mine) {
      if (!np.socket?.connected) return;
      const peers = [...s.peers.values()];
      const videos = peers.map((pr) => pr.video).filter(Boolean);
      const avg = (list) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);
      np.socket.emit('report', {
        mode: 'stream',
        ping: peers.length ? Math.max(...peers.map((pr) => pr.rtt ?? 0)) : null,
        transport: !peers.length ? null : peers.every((pr) => pr.channel?.readyState === 'open') ? 'direct' : peers.some((pr) => pr.channel?.readyState === 'open') ? 'mixed' : 'server',
        videoFps: avg(videos.map((v) => v.fps).filter((n) => n != null)),
        videoKbps: avg(videos.map((v) => v.kbps).filter((n) => n != null)),
        videoWidth: videos[0]?.width ?? null,
        videoHeight: videos[0]?.height ?? null,
        encodeMs: avg(videos.map((v) => v.encodeMs).filter((n) => n != null)),
        hidden: document.hidden,
        peers: peers.map((pr) => ({ p: playerOf(pr.userid) + 1, rtt: pr.rtt, transport: pr.channel?.readyState === 'open' ? 'direct' : 'server' })),
        events: [],
      });
    }

    // ---------- The pieces EmulatorJS's netplay calls ----------

    // No frame counting, no save states: the host's game is the only one.
    np.reset = () => {};
    np.sync = () => {};
    const noFrames = () => {};
    ejs.Module.postMainLoop = noFrames;
    const joinedBase = np.roomJoined;
    np.roomJoined = (...args) => {
      joinedBase(...args);
      ejs.Module.postMainLoop = noFrames;
      if (np.socket && !s.signalOn) {
        s.signalOn = true;
        np.socket.on('signal', onSignal);
      }
      ensurePeers();
    };
    const tableBase = np.updatePlayersTable;
    np.updatePlayersTable = () => {
      tableBase();
      if (ejs.isNetplay) ensurePeers();
    };
    /** The host's own presses go straight in; a controller a friend works is theirs. */
    np.simulateInput = (player, input, value) => {
      if (!ejs.isNetplay) return;
      const taken = Object.keys(np.players ?? {}).length - 1;
      if (player > 0 && player <= taken) return;
      gm().functions.simulateInput(player, input, value);
    };
    /** Messages through the room's socket: a friend without a direct channel. */
    np.dataMessage = (data) => {
      if (!data || typeof data !== 'object') return;
      // Who sent it, as the server stamps it (a friend could put anyone's id in `from`);
      // `from` only for a server that doesn't stamp messages.
      const sender = typeof data.sentBy === 'string' ? data.sentBy : data.from;
      if (typeof sender !== 'string') return;
      const peer = s.peers.get(sender);
      if (peer) onMessage(peer, data);
    };

    clearInterval(s.statsTimer);
    s.statsTimer = setInterval(everySecond, STATS_EVERY_MS);
    // The capture starts now, so the host's bar can say what's being streamed before anyone joins.
    stream();

    return { stats, detail, status: () => ({ mode: 'stream', peers: [...s.peers.values()].map((pr) => ({ player: playerOf(pr.userid) + 1, direct: pr.channel?.readyState === 'open', rtt: pr.rtt, video: pr.video, state: pr.pc?.connectionState ?? null })), held: [...s.peers.values()].flatMap((pr) => [...pr.held].map(([input, h]) => [`${h.player}:${input}`, h.v])), log: s.log.slice(-12) }) };
  }

  return { host, captureAudio, audio: null };
})();
