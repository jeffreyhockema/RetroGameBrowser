// Playing an arcade game with friends by video (see public/player/netplay-stream.js for the whole
// idea): the host's MAME runs the game and each friend gets it as a video stream, their presses
// coming back as their player's controls.
//
// The streaming itself is netplay-stream.js, written against EmulatorJS's netplay. MAME has no
// netplay of its own, so this is the small part of that EmulatorJS supplies: the room over the
// server's socket (see server/lib/netplay.js), the list of who's in it, messages through the
// server, and a controller for each friend, which here presses MAME keys for their player (see
// keyFor in mame-player.js). A plain script, like the others.

/* global io */

window.MameNetplay = (() => {
  // RetroArch's input numbers, which a friend's viewer sends (see stream-viewer.js), as MAME
  // controls: its B, A, Y, X, L and R are buttons 1-6 (the positions MAME's pad defaults give
  // them), Select a coin and Start start; the d-pad and the left stick move.
  const CONTROLS = {
    0: 'button1', 8: 'button2', 1: 'button3', 9: 'button4', 10: 'button5', 11: 'button6',
    2: 'coin', 3: 'start', 4: 'up', 5: 'down', 6: 'left', 7: 'right',
    16: 'right', 17: 'left', 18: 'down', 19: 'up',
  };
  // How far a stick has to be pushed (of 0x7fff) to count as the direction.
  const STICK_PUSH = 0x7fff * 0.5;

  // crypto.randomUUID is only there on a secure page, and the app is also used over plain http://.
  const newId = () => crypto.randomUUID?.() ?? [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

  /**
   * Hosts the room by video. `player` is what MamePlayer.start returned; `room` is { code, key,
   * name } from the page's link; `tell` passes the room's state to the app (the 'netplay' messages
   * public/emu/play.html sends). Call once the game is up, with the audio caught since before
   * MAME started (NetplayStream.captureAudio).
   */
  async function hostByVideo({ player, room, title, tell }) {
    const info = await fetch(`/api/netplay/rooms/${encodeURIComponent(room.code)}`, { cache: 'no-store' }).then((res) => res.json()).catch(() => ({}));
    const socket = io(`${location.origin}/api/netplay`);
    const np = {
      socket,
      playerID: newId(),
      players: {},
      sendMessage: (message) => socket.emit('data-message', message),
      // netplay-stream.js puts its own in place of these.
      roomJoined: () => {},
      updatePlayersTable: () => {},
      reset: () => {},
      sync: () => {},
      simulateInput: () => {},
      dataMessage: () => {},
    };
    np.extra = { domain: location.host, room_name: title, player_name: room.name, userid: np.playerID, sessionid: room.code };

    // What each friend's controller has down, by MAME player and control: a control stays down
    // while any input holding it does (the d-pad and the stick both move).
    const holding = new Map(); // `${player}:${control}` -> Set of inputs
    const functions = {
      simulateInput(index, input, value) {
        const control = CONTROLS[input];
        if (!control || index < 1) return;
        const mamePlayer = index + 1;
        const key = `${mamePlayer}:${control}`;
        const inputs = holding.get(key) ?? new Set();
        const was = inputs.size > 0;
        const on = input >= 16 ? value >= STICK_PUSH : Boolean(value);
        if (on) inputs.add(input);
        else inputs.delete(input);
        holding.set(key, inputs);
        if (was !== inputs.size > 0) player.pressFor(mamePlayer, control, inputs.size > 0);
      },
      // A friend's keyboard and mouse, for a computer (an Apple IIgs game): the keys straight into
      // MAME's keyboard, the mouse as SDL's own movement and buttons (patches 0008 and 0010 in the
      // build). A friend shares the one keyboard and mouse with the host, as around one computer.
      pressKey(code, down) { player.press(code, down); },
      mouseMove(dx, dy) { window.Module?._mame_mouse_move?.(dx, dy); },
      // The browser's buttons count from 0 (left, middle, right), SDL's from 1.
      mouseButton(button, down) { window.Module?._mame_mouse_button?.(button + 1, down ? 1 : 0); },
    };
    const ejs = { netplay: np, isNetplay: false, paused: false, Module: {}, canvas: document.getElementById('canvas'), gameManager: { functions } };

    let stats = null;
    const report = (extra = {}) => {
      const ids = Object.keys(np.players);
      tell({
        type: 'netplay',
        owner: true,
        player: 1,
        guests: ids.slice(1).map((id, i) => ({ player: i + 2, name: np.players[id]?.player_name ?? 'A friend', state: 'playing', stats: stats?.guests?.[i + 2] ?? null })),
        syncing: false,
        stats: stats && { mode: stats.mode, source: stats.source, audio: stats.audio },
        ...extra,
      });
    };
    const host = window.NetplayStream.host(ejs, {
      iceServers: info.iceServers ?? [],
      room: { code: room.code, title, name: room.name, owner: true },
      onStats: (latest) => { stats = latest; report(); },
    });

    const NETPLAY_ERRORS = {
      NOT_THE_HOST: 'This page isn\'t the host of the game.',
      ROOM_ALREADY_OPEN: 'This game is already being hosted from another page.',
      NO_SUCH_ROOM: 'This game has ended, or there was never one at this link.',
    };
    let opened = false;
    socket.on('connect', () => {
      if (opened) return;
      socket.emit('open-room', { extra: np.extra, maxPlayers: 4, password: '', key: room.key }, (error) => {
        if (error) return report({ error: NETPLAY_ERRORS[error] ?? `Couldn't host the game: ${error}` });
        opened = true;
        ejs.isNetplay = true;
        np.players = { [np.playerID]: np.extra };
        np.roomJoined(true, title, '', room.code);
        report();
      });
    });
    socket.on('users-updated', (users) => {
      if (!users || typeof users !== 'object') return;
      // netplay-stream.js lets go of what a friend who left had down, and moves the others' presses.
      np.players = users;
      np.updatePlayersTable();
      report();
    });
    socket.on('data-message', (data) => np.dataMessage(data));
    socket.on('disconnect', () => {
      if (!opened) return;
      opened = false;
      ejs.isNetplay = false;
      report({ ended: true });
    });
    let failures = 0;
    socket.on('connect_error', (err) => {
      if (socket.active && ++failures < 5) return;
      report({ error: `Couldn't reach the server: ${err.message}` });
    });
    return host;
  }

  // ---------- Rollback: every player runs the game ----------

  // Player 1's keys (see PLAYER_KEYS in mame-player.js) as RetroArch input numbers: what a
  // player's own keyboard and on-screen buttons press, taken before MAME sees them and sent
  // through the rollback engine (public/player/netplay-fixes.js) as their controller.
  const OWN_KEYS = {
    ArrowUp: 4, ArrowDown: 5, ArrowLeft: 6, ArrowRight: 7,
    ControlLeft: 0, AltLeft: 8, Space: 1, ShiftLeft: 9, KeyZ: 10, KeyX: 11,
    Digit5: 2, Digit1: 3,
  };
  // A controller by the browser's standard layout, by position: the same numbers as the keys.
  const PAD_BUTTONS = { 0: 0, 1: 8, 2: 1, 3: 9, 4: 10, 5: 11, 8: 2, 9: 3, 12: 4, 13: 5, 14: 6, 15: 7 };
  const DEAD_ZONE = 0.35;

  /**
   * Keeps the keyboard, the mouse and controllers away from MAME for a game played by rollback,
   * where nothing may reach a game except on the frame every player's copy runs it: presses are
   * handed to `onPress(input, value)` instead, and only presses the engine puts in (see
   * `letThrough`) reach MAME. MAME's own shortcuts (its menu, pause, save states) are off too;
   * any of them would part the games. Call before MAME starts, so its controllers never exist.
   */
  function guardInput() {
    const guard = { onPress: null, passing: false };
    const nativePads = navigator.getGamepads?.bind(navigator);
    // MAME finds no controllers: they're read here and pressed through the engine.
    navigator.getGamepads = () => [];
    const block = (e) => {
      if (guard.passing) return;
      e.stopImmediatePropagation();
      if (e.cancelable && e.type.startsWith('key')) e.preventDefault();
      if (e.type === 'keydown' || e.type === 'keyup') {
        const input = OWN_KEYS[e.code];
        if (input != null && !e.repeat) guard.onPress?.(input, e.type === 'keydown' ? 1 : 0);
      }
    };
    for (const type of ['keydown', 'keyup', 'keypress']) window.addEventListener(type, block, true);
    for (const type of ['mousedown', 'mouseup', 'mousemove', 'wheel']) window.addEventListener(type, block, true);
    // MAME reads no input at all while its window hasn't the focus, which would drop the presses
    // the engine puts in on this player's copy only: it's never told the focus went.
    for (const type of ['blur', 'focus']) window.addEventListener(type, (e) => { if (e.target === window) e.stopImmediatePropagation(); }, true);
    // Controllers, polled every frame the page draws: presses and releases, and the left stick.
    const padHeld = new Map();
    const poll = () => {
      requestAnimationFrame(poll);
      if (!guard.onPress || !nativePads) return;
      const pad = [...(nativePads() ?? [])].find((p) => p?.connected);
      const want = new Map();
      if (pad) {
        for (const [button, input] of Object.entries(PAD_BUTTONS)) if (pad.buttons[button]?.pressed) want.set(input, 1);
        const [x = 0, y = 0] = pad.axes;
        if (x > DEAD_ZONE) want.set(16, 0x7fff);
        if (x < -DEAD_ZONE) want.set(17, 0x7fff);
        if (y > DEAD_ZONE) want.set(18, 0x7fff);
        if (y < -DEAD_ZONE) want.set(19, 0x7fff);
      }
      for (const [input, value] of want) if (padHeld.get(input) !== value) { padHeld.set(input, value); guard.onPress(input, value); }
      for (const input of [...padHeld.keys()]) if (!want.has(input)) { padHeld.delete(input); guard.onPress(input, 0); }
    };
    requestAnimationFrame(poll);
    /** Runs `fn` with its keyboard events let through to MAME. */
    guard.letThrough = (fn) => {
      guard.passing = true;
      try { fn(); } finally { guard.passing = false; }
    };
    return guard;
  }

  /**
   * Plays by rollback: MAME made to look, to the rollback engine, like the EmulatorJS it was
   * written against. The engine keeps a state after every frame and goes back to one when a
   * press turns up late, so this gives it MAME's state in memory (the build's mame_state_save
   * and mame_state_load, patch 0003), a loop it runs frames with (mame_run_frame), presses as
   * controllers (keys for that player, see keyFor), and a room over the server's socket.
   *
   * A state load lands the way EmulatorJS's does, which the engine is built around: during the
   * loop's next iteration, after that iteration's frame. Every state kept is a save and a load
   * straight after, so every player's game runs from loaded states alike, the host's included.
   *
   * `room` is { code, key, name } for the host, { code, name } for a friend.
   */
  async function playRollback({ player, guard, room, owner, title, tell }) {
    const info = await fetch(`/api/netplay/rooms/${encodeURIComponent(room.code)}`, { cache: 'no-store' }).then((res) => res.json()).catch(() => ({}));
    const M = window.Module;
    if (typeof M._mame_state_save !== 'function') throw new Error('this build of MAME can\'t be kept in step with friends');
    // Frames run as fast as the page asks, so a frame's presses have to count on that frame: every
    // read of the controls polls them (patch 0004 in the build), rather than one poll per 10 ms.
    M._mame_poll_every_read?.(1);
    const heap = () => M.HEAPU8 ?? window.HEAPU8;
    const size = M._mame_state_size();
    if (!(size > 0)) throw new Error('MAME couldn\'t measure its state');
    const buf = M._malloc(size);

    // ---------- What the players compare ----------

    /** A C string from the build (its state entries, its sound chips), which has no UTF8ToString. */
    const readString = (pointer) => {
      const bytes = heap();
      let out = '';
      for (let at = pointer; bytes[at]; at++) out += String.fromCharCode(bytes[at]);
      return out;
    };

    /**
     * The parts of the state the players check each other against: everything but the sound
     * chips. A chip's saved state doesn't come back from a load exactly as it went in (MAME
     * 0.244's YM2151, for one, drifts within a few frames of a load), which would read as the
     * games coming apart when only the music is a hair out of step on one screen.
     *
     * A board's sound CPU polls those chips and takes their drift on, so leaving it out too is
     * tempting — but the same hash is what a friend finds frame 0 with, by watching for the
     * first tick whose state differs from the one they were sent (see findOrigin in
     * netplay-fixes.js). Leave out the parts that change most and that tick is missed, the
     * friend counts frames from the wrong one, and presses land a frame out. Tried, measured,
     * put back: the sound chips alone.
     */
    const hashed = (() => {
      const all = [{ at: 0, size }];
      if (typeof M._mame_state_entries !== 'function' || typeof M._mame_sound_tags !== 'function') return all;
      const sound = new Set(readString(M._mame_sound_tags()).split('\n').filter(Boolean));
      if (!sound.size) return all;
      // A sound chip's own parts sit under its tag: ":snd_nl" holds ":snd_nl:cout0", whose
      // stream output drifts the same way the chip does.
      const under = [...sound].map((t) => `${t}:`);
      const isSound = (tag) => sound.has(tag) || under.some((t) => tag.startsWith(t));
      const ranges = [];
      let at = 32; // the state's header
      for (const line of readString(M._mame_state_entries()).split('\n').filter(Boolean)) {
        const [name, bytes] = line.split('\t');
        const length = Number(bytes);
        // "<what it is>/<the device's tag>/<index>/<name>", or no tag for the machine's own.
        const parts = name.split('/');
        const tag = parts.length >= 4 ? parts[1] : null;
        if (!tag || !isSound(tag)) {
          const last = ranges[ranges.length - 1];
          if (last && last.at + last.size === at) last.size += length;
          else ranges.push({ at, size: length });
        }
        at += length;
      }
      return at === size && ranges.length ? ranges : all;
    })();
    /** FNV-1a over the parts that count, as netplay-fixes.js hashes a whole state. */
    const hashState = (bytes) => {
      let h = 0x811c9dc5;
      for (const range of hashed) {
        const end = range.at + range.size;
        for (let i = range.at; i < end; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
      }
      return h >>> 0;
    };

    // ---------- The game, as the engine wants it ----------

    let frames = 0;
    let pendingLoad = null;
    let muted = false;
    const setMuted = (on) => {
      if (on === muted) return;
      muted = on;
      try { window.JSMAME.sound_manager_mute(window.JSMAME.get_sound(window.JSMAME.get_machine()), on, 0x40); } catch { /* not up */ }
    };
    const loadNow = (bytes) => {
      heap().set(bytes, buf);
      const err = M._mame_state_load(buf, size);
      if (err) console.warn(`MAME couldn't load a state (${err})`);
    };
    const holding = new Map(); // `${player}:${control}` -> inputs holding it (see hostByVideo)
    const simulateInput = (index, input, value) => {
      const control = CONTROLS[input];
      if (!control || index < 0 || index > 3) return;
      const mamePlayer = index + 1;
      const key = `${mamePlayer}:${control}`;
      const inputs = holding.get(key) ?? new Set();
      const was = inputs.size > 0;
      const on = input >= 16 ? value >= STICK_PUSH : Boolean(value);
      if (on) inputs.add(input);
      else inputs.delete(input);
      holding.set(key, inputs);
      if (was !== inputs.size > 0) guard.letThrough(() => player.pressFor(mamePlayer, control, inputs.size > 0, { now: true }));
    };

    const np = {
      socket: null,
      playerID: newId(),
      players: {},
      owner,
      currentFrame: 0,
      sendMessage: (message) => np.socket.emit('data-message', message),
      getUserIndex: (user) => Object.keys(np.players).indexOf(user),
      getUserCount: () => Object.keys(np.players).length,
      setLoading: (loading) => { syncing = Boolean(loading); report(); },
      roomJoined: (isOwner) => { ejs.isNetplay = true; np.owner = isOwner; },
      updatePlayersTable: () => {},
      reset: () => {},
      sync: () => {},
      simulateInput: () => {},
      dataMessage: () => {},
    };
    np.extra = { domain: location.host, room_name: title, player_name: room.name, userid: np.playerID, sessionid: room.code };
    const ejs = {
      netplay: np,
      isNetplay: false,
      paused: false,
      Module: {},
      canvas: document.getElementById('canvas'),
      pause: () => { ejs.paused = true; },
      play: () => { ejs.paused = false; },
      gameManager: {
        getState() {
          const err = M._mame_state_save(buf, size);
          if (err) throw new Error(`MAME couldn't save its state (${err})`);
          const bytes = heap().slice(buf, buf + size);
          // Played on from the state as loaded, as a friend's game is (see above).
          loadNow(bytes);
          return bytes;
        },
        loadState: (bytes) => { pendingLoad = new Uint8Array(bytes); },
        getFrameNum: () => frames,
        functions: { simulateInput },
      },
    };

    // MAME's own loop runs nothing from here: this one does, when the engine lets it.
    M.preMainLoop = () => false;
    // Named for the engine's pacing, which finds the loop it drives by the name (see pace()).
    function MainLoop_runner() {
      requestAnimationFrame(MainLoop_runner);
      if (ejs.paused) return;
      if (ejs.Module.rgbPreMainLoop?.() === false) return;
      // A replay's frames are run all at once and aren't heard.
      setMuted(Boolean(ejs.Module.rgbPace?.replaying));
      // A state goes in on the iteration after it was given, and that one runs no frame: the
      // engine counts frames by iterations, and takes this one as landing on the loaded frame.
      if (pendingLoad) {
        const bytes = pendingLoad;
        pendingLoad = null;
        loadNow(bytes);
      } else {
        M._mame_run_frame();
        frames++;
      }
      ejs.Module.postMainLoop?.();
    }

    // ---------- The engine and the room ----------

    let stats = null;
    let syncing = false;
    const NETPLAY_ERRORS = {
      ROOM_FULL: 'This game is full: every controller is taken.',
      NO_SUCH_ROOM: 'This game has ended, or there was never one at this link.',
      NOT_THE_HOST: 'This page isn\'t the host of the game.',
      ROOM_ALREADY_OPEN: 'This game is already being hosted from another page.',
    };
    const report = (extra = {}) => {
      const ids = Object.keys(np.players);
      tell({
        type: 'netplay',
        owner: np.owner,
        player: ids.indexOf(np.playerID) + 1,
        guests: ids.slice(1).map((id, i) => ({ player: i + 2, name: np.players[id]?.player_name ?? 'A friend', state: 'playing', stats: stats?.guests?.[i + 2] ?? null })),
        syncing,
        stats: stats && { mode: stats.mode, lag: stats.lag, ping: stats.ping, delay: stats.delay, ahead: stats.ahead, stalls: stats.stalls, stalled: stats.stalled, transport: stats.transport, resyncs: stats.resyncs, rollbacks: stats.rollbacks, rollbackFrames: stats.rollbackFrames },
        ...extra,
      });
    };
    const engine = window.NetplayFixes.lockstep(ejs, {
      mode: 'rollback',
      fps: 60, // each of MAME's browser loop steps is 1/60 s of the game, whatever its screen's rate
      iceServers: info.iceServers ?? [],
      room: { code: room.code, title, name: room.name, owner },
      hashBytes: hashState,
      // MAME loads a state exactly, so no frame has to be thrown away around one.
      exactLoads: true,
      onStats: (latest) => { stats = latest; report(); },
    });
    requestAnimationFrame(MainLoop_runner);
    // The player's own presses go to the engine, which stamps them with a frame.
    guard.onPress = (input, value) => { if (ejs.isNetplay) np.simulateInput(0, input, value); };

    const socket = io(`${location.origin}/api/netplay`);
    np.socket = socket;
    socket.on('users-updated', (users) => {
      if (!users || typeof users !== 'object') return;
      np.reset();
      np.players = users;
      np.updatePlayersTable();
      if (np.owner) np.sync();
      report();
    });
    socket.on('data-message', (data) => np.dataMessage(data));
    // The server lets go of everyone when the host leaves: for a player in the game, it's over.
    socket.on('disconnect', () => {
      if (!ejs.isNetplay) return;
      ejs.isNetplay = false;
      report({ ended: true });
    });
    let joinTries = 0;
    const join = () => socket.emit('join-room', { extra: np.extra }, (error, users) => {
      // The friend's page may be up before the host's game has opened the room.
      if (error === 'NO_SUCH_ROOM' && ++joinTries < 60) return setTimeout(join, 3000);
      if (error) return report({ error: NETPLAY_ERRORS[error] ?? `Couldn't join the game: ${error}` });
      np.players = users;
      np.roomJoined(false, title, '', room.code);
      np.updatePlayersTable();
      report();
    });
    socket.on('connect', () => {
      if (ejs.isNetplay) return;
      if (!owner) return join();
      socket.emit('open-room', { extra: np.extra, maxPlayers: 4, password: '', key: room.key }, (error) => {
        if (error) return report({ error: NETPLAY_ERRORS[error] ?? `Couldn't host the game: ${error}` });
        np.players = { [np.playerID]: np.extra };
        np.roomJoined(true, title, '', room.code);
        report();
      });
    });
    return engine;
  }

  return { hostByVideo, guardInput, playRollback };
})();
