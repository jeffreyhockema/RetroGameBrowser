// A friend's side of a game played by video (see public/player/netplay-stream.js for the
// whole idea): this page joins the room over its socket, takes the host's offer of a video
// and audio stream over a WebRTC connection, shows it, and sends every press of its keyboard,
// controller or on-screen buttons back over the connection's data channel, where the host
// puts them into the game as this player's controller. It says how it's going to the page
// around it the way the console player does (see public/js/join.js).

(() => {
  const $ = (sel) => document.querySelector(sel);
  const hash = new URLSearchParams(location.hash.slice(1));
  const code = hash.get('join') ?? '';
  const name = hash.get('name') || 'A friend';
  const INPUTS = 24;
  const STATS_EVERY_MS = 1000;
  const JOIN_RETRY_MS = 3000;
  const JOIN_TRIES = 60;

  // EmulatorJS's default keys for a player, by RetroArch input number: B, Y, Select, Start,
  // Up, Down, Left, Right, A, X, L, R, L2, R2, then the sticks on H F G T and L J K I.
  const KEYS = { x: 0, s: 1, v: 2, Enter: 3, ArrowUp: 4, ArrowDown: 5, ArrowLeft: 6, ArrowRight: 7, z: 8, a: 9, q: 10, e: 11, Tab: 12, r: 13, h: 16, f: 17, g: 18, t: 19, l: 20, j: 21, k: 22, i: 23 };
  const STICK_KEYS = new Set([16, 17, 18, 19, 20, 21, 22, 23]);
  // The browser's standard gamepad layout, by position, to RetroArch's numbers: the bottom
  // face button is B, the right one A, the left one Y, the top one X.
  const PAD_BUTTONS = { 0: 0, 1: 8, 2: 1, 3: 9, 4: 10, 5: 11, 6: 12, 7: 13, 8: 2, 9: 3, 10: 14, 11: 15, 12: 4, 13: 5, 14: 6, 15: 7 };
  const PAD_AXES = [[16, 17], [18, 19], [20, 21], [22, 23]]; // each axis: [+1 input, -1 input]
  const DEAD_ZONE = 0.25;

  // crypto.randomUUID is only there on a secure page, and the app is also used over plain
  // http:// on the local network.
  const newId = () => crypto.randomUUID?.() ?? [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

  const els = { video: $('#video'), note: $('#note'), noteText: $('#note-text'), pad: $('#pad'), tap: $('#tap') };
  const s = {
    socket: null, userid: newId(), players: {}, player: 0, hostId: null,
    pc: null, channel: null, pendingIce: [], iceServers: [],
    // What the host is told is down, and what each of the keyboard, the on-screen buttons and
    // a controller has down: a press counts while any of them holds it.
    held: new Map(), from: { keys: new Map(), touch: new Map(), pad: new Map() },
    seq: 0, rtt: null, video: null, sentAt: new Map(), lags: [],
    started: false, ended: false, tries: 0, statsTimer: 0, failures: 0,
    // A computer's game (an Apple IIgs's): the whole keyboard and the mouse go to the host, rather
    // than a controller. keys: the keys down, by where they are ("KeyA"); moved: mouse movement not
    // sent yet; mouseButtons: the mouse buttons down.
    computer: false, keys: new Set(), moved: { x: 0, y: 0 }, mouseButtons: new Set(),
  };

  const tell = (message) => window.parent?.postMessage({ source: 'player', ...message }, location.origin);
  const say = (text) => { els.noteText.textContent = text; els.note.hidden = !text; };

  // ---------- The room ----------

  async function start() {
    tell({ type: 'progress', line: 'Connecting to the host' });
    let platform = '';
    try {
      const info = await fetch(`/api/netplay/rooms/${encodeURIComponent(code)}`, { cache: 'no-store' }).then((r) => r.json());
      s.iceServers = info.iceServers ?? [];
      platform = info.platform ?? '';
      s.computer = info.input === 'keyboard';
    } catch { /* the defaults, then */ }
    if (matchMedia('(pointer: coarse)').matches && !s.computer) buildPad(platform);
    // The room's socket, on this same server (see server/lib/netplay.js).
    s.socket = io(`${location.origin}/api/netplay`);
    s.socket.on('connect', () => { s.failures = 0; join(); });
    // socket.io keeps trying after a failed attempt (a tunnel's hiccup, say): the page around
    // this one is told once it has stopped, or after a few failures in a row.
    s.socket.on('connect_error', (err) => {
      if (s.socket.active && ++s.failures < 5) return;
      tell({ type: 'netplay', error: `Couldn't reach the server: ${err.message}` });
    });
    s.socket.on('users-updated', (users) => { s.players = users; placed(); });
    s.socket.on('signal', onSignal);
    s.socket.on('data-message', (data) => { if (data && typeof data === 'object' && data.to === s.userid) onMessage(data); });
    s.socket.on('disconnect', () => ended());
  }

  function join() {
    if (s.player) return;
    const extra = { domain: location.host, game_id: 0, room_name: '', player_name: name, userid: s.userid, sessionid: code };
    s.socket.emit('join-room', { extra }, (error, users) => {
      // The link may be opened before the host's game has opened the room.
      if (error === 'NO_SUCH_ROOM' && ++s.tries < JOIN_TRIES) return setTimeout(join, JOIN_RETRY_MS);
      if (error) return tell({ type: 'netplay', error: ERRORS[error] ?? `Couldn't join the game: ${error}` });
      s.players = users;
      placed();
      s.started = true;
      tell({ type: 'started' });
      report();
    });
  }

  const ERRORS = {
    ROOM_FULL: 'This game is full: every controller is taken.',
    NO_SUCH_ROOM: 'This game has ended, or there was never one at this link.',
  };

  /** Where this player stands in the room now, and who the host is. */
  function placed() {
    const ids = Object.keys(s.players);
    s.hostId = ids[0] ?? null;
    s.player = ids.indexOf(s.userid) + 1;
    report();
  }

  function ended() {
    if (s.ended) return;
    s.ended = true;
    s.pc?.close();
    tell({ type: 'netplay', ended: true });
  }

  // ---------- The connection ----------

  async function onSignal({ from, data }) {
    if (from !== s.hostId && s.hostId) return;
    if (!data) return;
    try {
      if (data.sdp) {
        if (!s.pc || data.sdp.type === 'offer') connect();
        await s.pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await s.pc.setLocalDescription(await s.pc.createAnswer());
          s.socket.emit('signal', { to: from, data: { sdp: s.pc.localDescription.toJSON() } });
        }
        for (const candidate of s.pendingIce.splice(0)) await s.pc.addIceCandidate(candidate);
      } else if (data.candidate) {
        if (s.pc?.remoteDescription) await s.pc.addIceCandidate(data.candidate);
        else s.pendingIce.push(data.candidate);
      }
    } catch (err) {
      console.warn('The host\'s connection details couldn\'t be used', err);
    }
  }

  function connect() {
    s.pc?.close();
    const pc = new RTCPeerConnection({ iceServers: s.iceServers });
    s.pc = pc;
    s.pendingIce = [];
    pc.onicecandidate = (e) => { if (e.candidate && s.hostId) s.socket.emit('signal', { to: s.hostId, data: { candidate: e.candidate.toJSON() } }); };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      if (els.video.srcObject !== stream) els.video.srcObject = stream;
      // As little buffering as the browser allows: a game, not a film.
      try { e.receiver.jitterBufferTarget = 0; } catch { /* not in this browser */ }
      try { e.receiver.playoutDelayHint = 0; } catch { /* older name */ }
      play();
    };
    pc.ondatachannel = (e) => {
      s.channel = e.channel;
      e.channel.onmessage = (m) => { try { onMessage(JSON.parse(m.data)); } catch { /* not ours */ } };
      // A press or release sent just before the channel changed may never have arrived, or may
      // arrive after a later one: the host is told everything that's down now.
      e.channel.onopen = () => { say(''); sendHeld(); report(); };
      e.channel.onclose = () => { if (s.channel === e.channel) s.channel = null; };
    };
    pc.onconnectionstatechange = () => {
      if (s.pc !== pc) return;
      if (pc.connectionState === 'failed') {
        say('The connection to the host was lost. Waiting for it to come back…');
        // Presses go through the server until the host offers a new connection: a channel
        // still called open on a dead connection would swallow them.
        s.channel = null;
        pc.close();
        sendHeld();
      }
      report();
    };
  }

  function play() {
    els.video.play().then(() => { els.tap.hidden = true; }).catch(() => {
      // The browser wants a tap before sound plays: the overlay asks for one.
      els.tap.hidden = false;
    });
  }
  els.tap.addEventListener('click', () => { els.video.muted = false; play(); });

  function onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.t === 'ping') return send({ t: 'pong', at: message.at });
    if (message.t === 'pong') s.rtt = Date.now() - message.at;
  }

  function send(message) {
    if (s.channel?.readyState === 'open') {
      try {
        s.channel.send(JSON.stringify(message));
        return;
      } catch { /* closing */ }
    }
    s.socket?.emit('data-message', { ...message, from: s.userid });
  }

  // ---------- The presses ----------

  /**
   * A press or release (or a stick's position) of this player's controller from one source
   * ('keys', 'touch' or 'pad'), to the host. Each message is numbered, so the host can tell a
   * late one through the server from a newer one over the direct channel.
   */
  function input(source, i, v) {
    if (!(i >= 0 && i < INPUTS) || s.ended) return;
    const value = typeof v === 'number' ? v : v ? 1 : 0;
    const from = s.from[source];
    if (value) from.set(i, value);
    else from.delete(i);
    const now = Math.max(s.from.keys.get(i) ?? 0, s.from.touch.get(i) ?? 0, s.from.pad.get(i) ?? 0);
    if ((s.held.get(i) ?? 0) === now) return;
    if (now) s.held.set(i, now);
    else s.held.delete(i);
    send({ t: 'i', i, v: now, n: ++s.seq });
  }

  /** Everything that's down now, which the host takes in place of what it had. */
  const sendHeld = () => (s.computer
    ? send({ t: 'kheld', held: [...s.keys], n: ++s.seq })
    : send({ t: 'held', held: [...s.held], n: ++s.seq }));

  // ---------- A computer's keyboard and mouse ----------

  // The browser's own: reloading, full screen, its tools. Everything else is the computer's.
  const BROWSER_KEYS = new Set(['F5', 'F11', 'F12']);

  /** A key down or up, by where it is on the keyboard, to the host's computer. */
  function forwardKey(e, down) {
    if (BROWSER_KEYS.has(e.code) || e.metaKey || !e.code || s.ended) return;
    e.preventDefault();
    if (down === s.keys.has(e.code)) return; // a held key repeating: the computer repeats keys itself
    if (down) s.keys.add(e.code);
    else s.keys.delete(e.code);
    send({ t: 'k', c: e.code, v: down ? 1 : 0, n: ++s.seq });
  }

  /** Everything let go of (the page lost the focus, or the mouse was let go of). */
  function letGo() {
    for (const code of [...s.keys]) {
      s.keys.delete(code);
      send({ t: 'k', c: code, v: 0, n: ++s.seq });
    }
    for (const b of [...s.mouseButtons]) {
      s.mouseButtons.delete(b);
      send({ t: 'b', b, v: 0, n: ++s.seq });
    }
  }

  // The mouse: a click on the game holds the pointer to it (Esc lets go, the browser's own way),
  // and from then on its movement, gathered up a frame at a time, and its buttons go to the host.
  const mouseHeld = () => document.pointerLockElement === els.video;
  let flushing = false;
  function flushMovement() {
    flushing = false;
    const { x, y } = s.moved;
    if (!x && !y) return;
    s.moved = { x: 0, y: 0 };
    send({ t: 'm', x, y, n: ++s.seq });
  }
  els.video.addEventListener('click', () => {
    if (s.computer && !mouseHeld()) els.video.requestPointerLock?.();
  });
  document.addEventListener('pointerlockchange', () => {
    if (!s.computer) return;
    if (mouseHeld()) say('');
    else {
      for (const b of [...s.mouseButtons]) {
        s.mouseButtons.delete(b);
        send({ t: 'b', b, v: 0, n: ++s.seq });
      }
      say('Click the game to use your mouse in it.');
    }
  });
  document.addEventListener('mousemove', (e) => {
    if (!s.computer || !mouseHeld()) return;
    s.moved.x += e.movementX;
    s.moved.y += e.movementY;
    if (!flushing) {
      flushing = true;
      requestAnimationFrame(flushMovement);
    }
  });
  for (const [type, down] of [['mousedown', true], ['mouseup', false]]) {
    document.addEventListener(type, (e) => {
      if (!s.computer || !mouseHeld() || e.button > 2) return;
      if (down === s.mouseButtons.has(e.button)) return;
      flushMovement(); // the pointer is where the friend clicked before the click counts
      if (down) s.mouseButtons.add(e.button);
      else s.mouseButtons.delete(e.button);
      send({ t: 'b', b: e.button, v: down ? 1 : 0, n: ++s.seq });
    });
  }

  // The keyboard: EmulatorJS's defaults, with a stick key pressed all the way.
  const keyOf = (e) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);
  document.addEventListener('keydown', (e) => {
    if (s.computer) return forwardKey(e, true);
    const i = KEYS[keyOf(e)];
    if (i == null) return;
    e.preventDefault();
    input('keys', i, STICK_KEYS.has(i) ? 0x7fff : 1);
  });
  document.addEventListener('keyup', (e) => {
    if (s.computer) return forwardKey(e, false);
    const i = KEYS[keyOf(e)];
    if (i == null) return;
    e.preventDefault();
    input('keys', i, 0);
  });
  window.addEventListener('blur', () => {
    if (s.computer) return letGo();
    for (const i of [...s.from.keys.keys()]) input('keys', i, 0);
  });

  // A controller, by the browser's standard layout, polled every frame.
  function pollPads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = [...pads].find((p) => p && p.connected);
    if (pad) {
      for (const [index, i] of Object.entries(PAD_BUTTONS)) {
        const button = pad.buttons[index];
        if (button) input('pad', i, button.pressed || button.value > 0.5);
      }
      pad.axes.slice(0, 4).forEach((value, axis) => {
        const [plus, minus] = PAD_AXES[axis];
        const v = Math.abs(value) < DEAD_ZONE ? 0 : Math.round(Math.abs(value) * 0x7fff);
        input('pad', plus, value > 0 ? v : 0);
        input('pad', minus, value < 0 ? v : 0);
      });
    }
    requestAnimationFrame(pollPads);
  }
  requestAnimationFrame(pollPads);

  // On-screen buttons, for a phone: shown where there's a touch screen and no keyboard, laid
  // out as the console's own controller, by the room's platform (the input numbers are
  // EmulatorJS's for that system; see its phone gamepads). Each button is
  // [input, label, place, spoken name]; the places are classes in watch.html.
  const DPAD = [[4, '▲', 'up', 'Up'], [5, '▼', 'down', 'Down'], [6, '◀', 'left', 'Left'], [7, '▶', 'right', 'Right']];
  const PADS = {
    'Nintendo 64': {
      stick: [16, 17, 18, 19], // right, left, down, up
      buttons: [[0, 'A', 'n64-a'], [1, 'B', 'n64-b'], [23, 'C▲', 'c-up', 'C up'], [22, 'C▼', 'c-down', 'C down'], [21, 'C◀', 'c-left', 'C left'], [20, 'C▶', 'c-right', 'C right'],
        [3, 'Start', 'start-only'], [10, 'L', 'l1'], [12, 'Z', 'l2'], [11, 'R', 'r1']],
    },
    'Sony Playstation': {
      buttons: [...DPAD, [0, '✕', 'face-bottom', 'Cross'], [8, '○', 'face-right', 'Circle'], [1, '□', 'face-left', 'Square'], [9, '△', 'face-top', 'Triangle'],
        [2, 'Select', 'select'], [3, 'Start', 'start'], [10, 'L1', 'l1'], [12, 'L2', 'l2'], [11, 'R1', 'r1'], [13, 'R2', 'r2']],
    },
    'Sega CD': {
      buttons: [...DPAD, [1, 'A', 'row-1'], [0, 'B', 'row-2'], [8, 'C', 'row-3'], [10, 'X', 'row-4'], [9, 'Y', 'row-5'], [11, 'Z', 'row-6'],
        [2, 'Mode', 'select'], [3, 'Start', 'start']],
    },
    'Sega Saturn': {
      buttons: [...DPAD, [1, 'A', 'row-1'], [0, 'B', 'row-2'], [8, 'C', 'row-3'], [9, 'X', 'row-4'], [10, 'Y', 'row-5'], [11, 'Z', 'row-6'],
        [12, 'L', 'l1'], [13, 'R', 'r1'], [3, 'Start', 'start-only']],
    },
    'Atari Jaguar': {
      buttons: [...DPAD, [8, 'A', 'row-1'], [0, 'B', 'row-2'], [1, 'C', 'row-3'], [2, 'Pause', 'select'], [3, 'Option', 'start']],
    },
    // An arcade game (MAME, see player/mame-netplay.js): buttons 1-6 in two rows, Coin and Start.
    Arcade: {
      buttons: [...DPAD, [0, '1', 'row-1'], [8, '2', 'row-2'], [1, '3', 'row-3'], [9, '4', 'row-4'], [10, '5', 'row-5'], [11, '6', 'row-6'],
        [2, 'Coin', 'select'], [3, 'Start', 'start']],
    },
  };
  // Any other system: RetroPad, the SNES-shaped pad EmulatorJS numbers every system by.
  const DEFAULT_PAD = {
    buttons: [...DPAD, [0, 'B', 'face-bottom'], [8, 'A', 'face-right'], [1, 'Y', 'face-left'], [9, 'X', 'face-top'],
      [2, 'Select', 'select'], [3, 'Start', 'start'], [10, 'L', 'l1'], [11, 'R', 'r1']],
  };

  function buildPad(platform) {
    const layout = PADS[platform] ?? DEFAULT_PAD;
    els.pad.replaceChildren();
    for (const [i, label, place, name] of layout.buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `watch-${place}`;
      button.textContent = label;
      if (name) button.setAttribute('aria-label', name);
      // The N64's C buttons are a stick of their own, pushed all the way.
      const value = STICK_KEYS.has(i) ? 0x7fff : 1;
      const down = (e) => { e.preventDefault(); button.classList.add('is-down'); input('touch', i, value); };
      const up = (e) => { e.preventDefault(); button.classList.remove('is-down'); input('touch', i, 0); };
      button.addEventListener('pointerdown', down);
      button.addEventListener('pointerup', up);
      button.addEventListener('pointercancel', up);
      button.addEventListener('pointerleave', up);
      button.addEventListener('contextmenu', (e) => e.preventDefault());
      els.pad.append(button);
    }
    if (layout.stick) stickZone(layout.stick);
    els.pad.hidden = false;
  }

  /** An analog stick: a round zone the thumb drags in, how far from its middle being the push. */
  function stickZone([right, left, down, up]) {
    const zone = document.createElement('div');
    zone.className = 'watch-stick';
    zone.setAttribute('aria-label', 'Stick');
    const knob = document.createElement('div');
    knob.className = 'watch-stick-knob';
    zone.append(knob);
    els.pad.append(zone);
    let pointer = null;
    const push = (x, y) => {
      input('touch', right, x > 0 ? Math.round(x * 0x7fff) : 0);
      input('touch', left, x < 0 ? Math.round(-x * 0x7fff) : 0);
      input('touch', down, y > 0 ? Math.round(y * 0x7fff) : 0);
      input('touch', up, y < 0 ? Math.round(-y * 0x7fff) : 0);
    };
    const move = (e) => {
      if (e.pointerId !== pointer) return;
      e.preventDefault();
      const box = zone.getBoundingClientRect();
      const radius = box.width / 2;
      let x = (e.clientX - (box.left + radius)) / radius;
      let y = (e.clientY - (box.top + radius)) / radius;
      const length = Math.hypot(x, y);
      if (length > 1) { x /= length; y /= length; }
      knob.style.transform = `translate(${Math.round(x * radius * 0.6)}px, ${Math.round(y * radius * 0.6)}px)`;
      if (length < DEAD_ZONE / 2) x = y = 0;
      push(x, y);
    };
    const end = (e) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      knob.style.transform = '';
      push(0, 0);
    };
    zone.addEventListener('pointerdown', (e) => {
      if (pointer != null) return;
      pointer = e.pointerId;
      // The stick keeps the finger that took it, even as it slides off the zone.
      try { zone.setPointerCapture(pointer); } catch { /* already lifted */ }
      move(e);
    });
    zone.addEventListener('pointermove', move);
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    zone.addEventListener('lostpointercapture', end);
    zone.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---------- What's measured ----------

  /** What the browser says about the video coming in. */
  async function readVideo() {
    if (!s.pc || s.pc.connectionState !== 'connected') {
      s.video = null;
      return;
    }
    try {
      const stats = await s.pc.getStats();
      stats.forEach((r) => {
        if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
        const last = s.video;
        const kbps = last && r.timestamp > last.timestamp ? Math.round(((r.bytesReceived - last.bytesReceived) * 8) / (r.timestamp - last.timestamp)) : null;
        s.video = {
          timestamp: r.timestamp, bytesReceived: r.bytesReceived, fps: r.framesPerSecond ?? null, kbps,
          width: r.frameWidth ?? null, height: r.frameHeight ?? null,
          dropped: r.framesDropped ?? null, lost: r.packetsLost ?? null,
          jitterMs: r.jitterBufferDelay && r.jitterBufferEmittedCount ? Math.round((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000) : null,
        };
      });
    } catch { /* not in this browser */ }
  }

  function stats() {
    return {
      mode: 'stream',
      ping: s.rtt,
      transport: s.channel?.readyState === 'open' ? 'direct' : 'server',
      videoFps: s.video?.fps ?? null,
      videoKbps: s.video?.kbps ?? null,
      videoWidth: s.video?.width ?? null,
      videoHeight: s.video?.height ?? null,
      framesDropped: s.video?.dropped ?? null,
      jitterMs: s.video?.jitterMs ?? null,
    };
  }

  /** How it's going, to the page around this one and to the host, and once a second to the server's log. */
  function report() {
    if (!s.player) return;
    const mine = stats();
    tell({ type: 'netplay', player: s.player, stats: mine, connected: s.pc?.connectionState === 'connected' });
    send({ t: 'stats', stats: mine });
    if (s.socket?.connected) s.socket.emit('report', { ...mine, hidden: document.hidden, peers: s.hostId ? [{ p: 1, rtt: s.rtt, transport: mine.transport }] : [], events: [] });
  }

  s.statsTimer = setInterval(async () => {
    if (s.ended) return;
    send({ t: 'ping', at: Date.now() });
    await readVideo();
    report();
  }, STATS_EVERY_MS);

  // The bar around this page says when to leave.
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.data?.type !== 'leave') return;
    s.socket?.disconnect();
    tell({ type: 'left' });
  });

  window.NetplayViewer = { stats, status: () => ({ player: s.player, host: s.hostId, connected: s.pc?.connectionState ?? null, channel: s.channel?.readyState ?? null, held: [...s.held], rtt: s.rtt, video: s.video, computer: s.computer, keys: [...s.keys] }) };
  start();
})();
