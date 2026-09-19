// Arcade games in MAME 0.244's own browser build (see server/lib/mame.js): everything about
// running one that's the same in the app (public/mame/play.html, which fetches the files from
// the server) and in a downloaded game (public/offline/runtime.js, which has them in its folder).
//
// Given the files for MAME's folders and the compiled build, this starts MAME on the set, sizes
// the screen, keeps the game's settings, high scores (NVRAM) and save states in the browser's
// storage, says when the game is up or has stopped, and presses keys for on-screen buttons.
// A plain script, like shell.js.

window.MamePlayer = (() => {
  // Each player's keys: MAME's name for the key and the browser's (KeyboardEvent.code). Player 1
  // has MAME's usual keys, and so do players 2-4 for coin, start and moving; their buttons get
  // keys of their own (MAME gives most of them none), so a friend playing by video can be
  // pressed into the game as their player (see player/mame-netplay.js).
  const PLAYER_KEYS = [
    {
      coin: ['KEYCODE_5', 'Digit5'], start: ['KEYCODE_1', 'Digit1'],
      up: ['KEYCODE_UP', 'ArrowUp'], down: ['KEYCODE_DOWN', 'ArrowDown'], left: ['KEYCODE_LEFT', 'ArrowLeft'], right: ['KEYCODE_RIGHT', 'ArrowRight'],
      buttons: [['KEYCODE_LCONTROL', 'ControlLeft'], ['KEYCODE_LALT', 'AltLeft'], ['KEYCODE_SPACE', 'Space'], ['KEYCODE_LSHIFT', 'ShiftLeft'], ['KEYCODE_Z', 'KeyZ'], ['KEYCODE_X', 'KeyX']],
    },
    {
      coin: ['KEYCODE_6', 'Digit6'], start: ['KEYCODE_2', 'Digit2'],
      up: ['KEYCODE_R', 'KeyR'], down: ['KEYCODE_F', 'KeyF'], left: ['KEYCODE_D', 'KeyD'], right: ['KEYCODE_G', 'KeyG'],
      buttons: [['KEYCODE_A', 'KeyA'], ['KEYCODE_S', 'KeyS'], ['KEYCODE_Q', 'KeyQ'], ['KEYCODE_W', 'KeyW'], ['KEYCODE_E', 'KeyE'], ['KEYCODE_Y', 'KeyY']],
    },
    {
      coin: ['KEYCODE_7', 'Digit7'], start: ['KEYCODE_3', 'Digit3'],
      up: ['KEYCODE_I', 'KeyI'], down: ['KEYCODE_K', 'KeyK'], left: ['KEYCODE_J', 'KeyJ'], right: ['KEYCODE_L', 'KeyL'],
      buttons: [['KEYCODE_B', 'KeyB'], ['KEYCODE_N', 'KeyN'], ['KEYCODE_M', 'KeyM'], ['KEYCODE_O', 'KeyO'], ['KEYCODE_U', 'KeyU'], ['KEYCODE_H', 'KeyH']],
    },
    {
      coin: ['KEYCODE_8', 'Digit8'], start: ['KEYCODE_4', 'Digit4'],
      up: ['KEYCODE_8PAD', 'Numpad8'], down: ['KEYCODE_2PAD', 'Numpad2'], left: ['KEYCODE_4PAD', 'Numpad4'], right: ['KEYCODE_6PAD', 'Numpad6'],
      buttons: [['KEYCODE_7PAD', 'Numpad7'], ['KEYCODE_9PAD', 'Numpad9'], ['KEYCODE_1PAD', 'Numpad1'], ['KEYCODE_3PAD', 'Numpad3'], ['KEYCODE_0PAD', 'Numpad0'], ['KEYCODE_DEL_PAD', 'NumpadDecimal']],
    },
  ];

  // The player's pads, which MAME sees as joysticks numbered like the browser's gamepads:
  // Select puts in a coin, Start starts, and the D-pad moves as well as the left stick. The
  // face and shoulder buttons are MAME's own defaults (button 1 the bottom face button, then
  // right, left, top, left and right shoulder). Player 1's buttons are left to MAME's defaults,
  // which also take the mouse and the light gun.
  function controllerFile() {
    const port = (type, seq) => `<port type="${type}"><newseq type="standard">${seq}</newseq></port>`;
    const stick = { up: 'YAXIS_UP_SWITCH', down: 'YAXIS_DOWN_SWITCH', left: 'XAXIS_LEFT_SWITCH', right: 'XAXIS_RIGHT_SWITCH' };
    const dpad = { up: 13, down: 14, left: 15, right: 16 };
    const ports = PLAYER_KEYS.flatMap((keys, i) => {
      const n = i + 1;
      return [
        port(`COIN${n}`, `${keys.coin[0]} OR JOYCODE_${n}_BUTTON9`),
        port(`START${n}`, `${keys.start[0]} OR JOYCODE_${n}_BUTTON10`),
        ...['up', 'down', 'left', 'right'].map((dir) => port(`P${n}_JOYSTICK_${dir.toUpperCase()}`, `${keys[dir][0]} OR JOYCODE_${n}_${stick[dir]} OR JOYCODE_${n}_BUTTON${dpad[dir]}`)),
        ...(n === 1 ? [] : keys.buttons.map(([key], b) => port(`P${n}_BUTTON${b + 1}`, `${key} OR JOYCODE_${n}_BUTTON${b + 1} OR GUNCODE_${n}_BUTTON${b + 1}`))),
      ];
    });
    return `<?xml version="1.0"?>\n<mameconfig version="10"><system name="default"><input>\n${ports.join('\n')}\n</input></system></mameconfig>\n`;
  }

  /**
   * A player's control as the browser's name for its key: `player` 1-4, `control` 'coin',
   * 'start', 'up', 'down', 'left', 'right' or 'button1'-'button6'. Null for anything else.
   */
  function keyFor(player, control) {
    const keys = PLAYER_KEYS[player - 1];
    if (!keys) return null;
    const button = /^button([1-6])$/.exec(control);
    return (button ? keys.buttons[button[1] - 1] : keys[control])?.[1] ?? null;
  }

  // SDL's own numbers for the keys this page presses with, so a press can be put straight into
  // the keyboard MAME reads (mame_set_key, patch 0008 in the build). A press made as a keyboard
  // event instead waits in the browser's queue until SDL next pumps it, which is once a frame:
  // fine for a player at the keyboard, wrong for a press the page puts in while re-running
  // frames for a rollback, which would then count a frame later than it did the first time.
  // The whole keyboard (a computer's game, or a friend's keys sent over a video stream), by the USB
  // numbers SDL uses.
  const SCANCODES = (() => {
    const map = {
      Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44,
      Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48, Backslash: 49,
      Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57,
      PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73, Home: 74, PageUp: 75,
      Delete: 76, End: 77, PageDown: 78,
      ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
      NumLock: 83, NumpadDivide: 84, NumpadMultiply: 85, NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88, NumpadDecimal: 99,
      IntlBackslash: 100, ContextMenu: 101, NumpadEqual: 103,
      ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227,
      ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
    };
    for (let i = 0; i < 26; i++) map[`Key${String.fromCharCode(65 + i)}`] = 4 + i;       // A is 4
    for (let d = 1; d <= 9; d++) map[`Digit${d}`] = 29 + d;                              // 1 is 30
    map.Digit0 = 39;
    for (let n = 1; n <= 12; n++) map[`F${n}`] = 57 + n;                                  // F1 is 58
    for (let d = 1; d <= 9; d++) map[`Numpad${d}`] = 88 + d;                             // keypad 1 is 89
    map.Numpad0 = 98;
    return map;
  })();

  // The browser's old key numbers, which MAME's SDL layer reads a key by, for the keys an
  // on-screen button can press (see public/js/touchbuttons.js): by KeyboardEvent.code.
  const KEY_CODES = {
    Enter: 13, Space: 32, Escape: 27, Tab: 9, Backspace: 8,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18, CapsLock: 20,
    Insert: 45, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34,
    NumpadDecimal: 110, NumpadDivide: 111, NumpadMultiply: 106, NumpadSubtract: 109, NumpadAdd: 107, NumpadEnter: 13, NumLock: 144,
    Backquote: 192, Minus: 189, Equal: 187, BracketLeft: 219, BracketRight: 221, Backslash: 220,
    Semicolon: 186, Quote: 222, Comma: 188, Period: 190, Slash: 191, ScrollLock: 145,
  };
  const keyCodeOf = (code) => KEY_CODES[code]
    ?? (/^Key([A-Z])$/.exec(code)?.[1].charCodeAt(0))
    ?? (/^Digit(\d)$/.test(code) ? 48 + Number(code.slice(5)) : null)
    ?? (/^Numpad(\d)$/.test(code) ? 96 + Number(code.slice(6)) : null)
    ?? (/^F(\d+)$/.test(code) ? 111 + Number(code.slice(1)) : null);

  /**
   * The shape of the game's monitor, width over height: 4:3 for a CRT, turned for one that stood
   * on its side, wider for a cabinet with several side by side; an LCD game keeps its own.
   */
  function monitorAspect(info) {
    const screen = info.screen;
    if (!screen) return 4 / 3;
    let [w, h] = screen.type === 'lcd' && screen.width && screen.height ? [screen.width, screen.height] : [4, 3];
    if (screen.rotate === 90 || screen.rotate === 270) [w, h] = [h, w];
    return (w * Math.max(1, info.screens ?? 1)) / h;
  }

  /**
   * Starts MAME. `info` is what the server's /api/mame answers; `files` are [{ name, data }] for
   * MAME's folders ("roms/neogeo.zip"); `wasmBinary` the bundle's build and `scriptUrl` its .js.
   * `onStarted` is called once the game is up, `onQuit` when the player quits in MAME (its menu,
   * or Esc), and `ways` are offered on a failure card where there's no app bar to leave by.
   * Returns { leave, press }: leave() stops MAME and stores the game's files, press(code, down)
   * presses a key for an on-screen button.
   */
  function start({ shell, info, files, wasmBinary, scriptUrl, locateFile, onStarted = () => {}, onQuit = () => {}, ways = [], extraArgs = [], persist: keep = true }) {
    const canvas = document.getElementById('canvas');
    canvas.hidden = false;

    // MAME's sound makes its own AudioContext, which a browser may start suspended until the
    // player presses something: each one is kept so it can be woken up then.
    const audioContexts = [];
    const NativeAudioContext = window.AudioContext ?? window.webkitAudioContext;
    if (NativeAudioContext) {
      window.AudioContext = class extends NativeAudioContext {
        constructor(...args) { super(...args); audioContexts.push(this); }
      };
    }
    const wakeAudio = () => { for (const ctx of audioContexts) if (ctx.state === 'suspended') ctx.resume().catch(() => {}); };
    for (const type of ['keydown', 'pointerdown', 'touchstart']) window.addEventListener(type, wakeAudio, { capture: true });

    // The canvas is sized to the monitor's shape and centred, and MAME's SDL layer makes its
    // picture the canvas's size. So a point on the canvas is that point on the game's screen,
    // which is how a light gun aims (see the build's pointer light gun). On a phone held upright
    // with on-screen buttons up, the screen sits at the top, leaving the buttons the room below.
    const aspect = monitorAspect(info);
    const fit = () => {
      const stage = canvas.parentElement;
      const room = stage.getBoundingClientRect();
      let width = room.width;
      let height = width / aspect;
      if (height > room.height) {
        height = room.height;
        width = height * aspect;
      }
      const atTop = document.body.classList.contains('touch-pad-shown') && room.height > room.width;
      Object.assign(canvas.style, {
        inset: 'auto',
        left: `${Math.round((room.width - width) / 2)}px`,
        top: atTop ? '0px' : `${Math.round((room.height - height) / 2)}px`,
        width: `${Math.round(width)}px`,
        height: `${Math.round(height)}px`,
      });
      // SDL looks at the canvas's size when the window is resized.
      window.dispatchEvent(new Event('resize'));
    };
    let fitting = false;
    const refit = () => {
      if (fitting) return;
      fitting = true;
      requestAnimationFrame(() => { fit(); fitting = false; });
    };
    new ResizeObserver(refit).observe(canvas.parentElement);
    new MutationObserver(refit).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    fit();

    // Where the game's own files live between visits: one store per arcade set, and one per game
    // on a computer (whose settings, battery RAM and save states are the game's, not the machine's).
    const persist = `/mame/${info.store ?? info.setName}`;
    let persistReady = false;
    let syncing = null;
    /** Writes what MAME has written (settings, NVRAM, save states) to the browser's storage. */
    function storeChanges() {
      if (!persistReady) return Promise.resolve();
      syncing ??= new Promise((resolve) => {
        try {
          FS.syncfs(false, (err) => { if (err) console.warn('Saving the game\'s files failed', err); resolve(); });
        } catch (err) {
          console.warn('Saving the game\'s files failed', err);
          resolve();
        }
      }).finally(() => { syncing = null; });
      return syncing;
    }

    const said = [];
    let running = false;
    let ended = false;   // MAME has stopped, one way or another
    let leaving = false; // the game is being closed from outside MAME
    /** MAME gave up: a game that couldn't start (missing ROMs, say), or a crash while playing. */
    const failed = (status) => {
      if (ended) return;
      ended = true;
      // What MAME said about it (missing ROMs, a bad dump), without its usual start-up chatter.
      const worth = said.filter((l) => l.trim() && !/emscripten GL|^Starting |rescheduling|clone of nonexistent|^Driver .* errors|^Errors:|Attempting to parse|Optional memory region/i.test(l));
      const why = worth.filter((l) => /missing|not found|error|fatal|wrong|incorrect|unable/i.test(l)).slice(-4).join(' ')
        || (running || status === 'abort' ? 'it crashed inside MAME' : worth.slice(-2).join(' '));
      if (!running) shell.fail(why || `MAME stopped before the game started (exit code ${status}).`, { ways });
      else if (!leaving) shell.stopped(why, { ways });
    };
    let exited = null;
    const exitDone = new Promise((resolve) => { exited = resolve; });
    /**
     * MAME stopped the game and has written its NVRAM and settings (the build calls this, see
     * github.com/jeffreyhockema/mame-wasm-build). Quitting from MAME's own menu or with Esc ends
     * up here too.
     */
    const mameExited = async () => {
      if (ended) return;
      ended = true;
      exited();
      await storeChanges();
      if (!leaving) onQuit();
    };

    // A light gun is aimed with the pointer: a click or a tap on the screen shoots there.
    const lightgun = (info.controls ?? []).includes('lightgun');
    if (lightgun) canvas.style.cursor = 'crosshair';

    window.Module = {
      canvas,
      screenIsReadOnly: true,
      wasmBinary,
      locateFile,
      arguments: [
        info.setName,
        '-rompath', '/roms', '-samplepath', '/samples',
        '-cfg_directory', `${persist}/cfg`, '-nvram_directory', `${persist}/nvram`,
        '-state_directory', `${persist}/sta`, '-diff_directory', `${persist}/diff`,
        '-snapshot_directory', '/snap', '-ctrlrpath', '/ctrlr',
        // The arcade key layout (see controllerFile); a computer's keyboard is all its own.
        ...(info.computer ? [] : ['-ctrlr', 'browser']),
        '-window', '-keepaspect', '-nofilter',
        '-samplerate', '48000', '-skip_gameinfo', '-confirm_quit',
        ...(lightgun ? ['-lightgun', '-lightgunprovider', 'sdl'] : []),
        // A computer's mouse is the pointer (MAME holds on to it once the game is clicked).
        ...(info.computer ? ['-mouse', '-mouseprovider', 'sdl'] : []),
        // The computer's own options: its cards and the disks in its drives.
        ...(info.args ?? []),
        ...extraArgs,
      ],
      preRun: [() => {
        const mkdirs = (p) => p.split('/').filter(Boolean).reduce((at, part) => {
          const next = `${at}/${part}`;
          try { FS.mkdir(next); } catch { /* there already */ }
          return next;
        }, '');
        // A computer's disks are kept with the game's other files, so what the game writes to them
        // (its saves, its high scores) is there next time: the server's copy is only the first.
        // They're put in place once the kept files have been read (see below). Not for a copy
        // of someone else's game, nor a build that can't keep anything.
        const keepDisks = Boolean(info.computer) && keep && typeof IDBFS !== 'undefined';
        const disks = keepDisks ? files.filter((f) => f.name.startsWith('media/')) : [];
        for (const file of files) {
          if (disks.includes(file)) continue;
          mkdirs(file.name.slice(0, file.name.lastIndexOf('/')));
          FS.writeFile(`/${file.name}`, file.data);
        }
        files.length = 0; // MAME has its own copy now
        mkdirs('/ctrlr');
        FS.writeFile('/ctrlr/browser.cfg', controllerFile());
        mkdirs(persist);
        for (const dir of ['cfg', 'nvram', 'sta', 'diff']) mkdirs(`${persist}/${dir}`);
        /**
         * A computer's battery RAM as the game's setup gives it (an Apple IIgs's Control Panel
         * settings, its startup slot among them: see server/lib/iigs.js), the first time only:
         * after that it's what the player has made it. MAME keeps it as "<machine>/nvram".
         */
        const startingBram = () => {
          if (!info.bram) return;
          const at = `${persist}/nvram/${info.setName}/nvram`;
          if (FS.analyzePath(at).exists) return;
          mkdirs(`${persist}/nvram/${info.setName}`);
          FS.writeFile(at, Uint8Array.from(atob(info.bram), (c) => c.charCodeAt(0)));
        };
        // A build without the browser-storage file system still plays; nothing is kept. Nor for
        // a copy of someone else's game (a friend's, playing by rollback).
        if (!keep || typeof IDBFS === 'undefined') startingBram();
        if (!keep) return;
        if (typeof IDBFS === 'undefined') return console.warn('This MAME build can\'t keep saves in the browser.');
        FS.mount(IDBFS, {}, persist);
        addRunDependency('persist');
        FS.syncfs(true, (err) => {
          if (err) console.warn('Reading the game\'s saved files failed', err);
          for (const dir of ['cfg', 'nvram', 'sta', 'diff']) mkdirs(`${persist}/${dir}`);
          startingBram();
          if (keepDisks) {
            // MAME's options name /media; for a kept game that's the stored folder.
            mkdirs(`${persist}/media`);
            for (const disk of disks) {
              const at = `${persist}/${disk.name}`;
              if (!FS.analyzePath(at).exists) FS.writeFile(at, disk.data);
            }
            disks.length = 0;
            FS.symlink(`${persist}/media`, '/media');
          }
          persistReady = true;
          removeRunDependency('persist');
        });
      }],
      onRuntimeInitialized: () => shell.starting(),
      print: (text) => { said.push(text); console.log(text); },
      printErr: (text) => { said.push(text); console.warn(text); },
      onMameExit: mameExited,
      onExit: failed,
      onAbort: (what) => { said.push(String(what ?? '')); failed('abort'); },
      quit: (status, toThrow) => { failed(status); throw toThrow; },
    };

    // MAME has a machine once the game is up.
    const watch = setInterval(() => {
      if (ended) return clearInterval(watch);
      let machine = 0;
      try { machine = window.JSMAME?.get_machine?.() ?? 0; } catch { /* not ready */ }
      if (!machine) return;
      clearInterval(watch);
      running = true;
      shell.playing();
      fit();
      canvas.focus();
      onStarted();
    }, 250);

    const script = document.createElement('script');
    script.src = scriptUrl;
    script.onerror = () => shell.fail('The browser version of MAME is missing.', { ways });
    document.body.append(script);

    // Save states are written as they're made; they (and settings changed in MAME's menu)
    // reach the browser's storage every minute and whenever the page goes out of sight.
    setInterval(() => { if (running && !ended) storeChanges(); }, 60_000);
    document.addEventListener('visibilitychange', () => { if (document.hidden) storeChanges(); });

    // Keys pressed from outside the page's own keyboard (on-screen buttons, a friend's keyboard
    // over the network) can come down and up within one frame, a friend's in one burst, and MAME,
    // reading its keys once a frame, never sees them. So a key stays as it is for at least
    // KEY_HOLD_MS and KEY_HOLD_FRAMES of the browser's (MAME runs a frame on each, and on a busy
    // page, one streaming to friends, they come further apart) before its next change, and what
    // comes after waits too, so the keys still reach MAME in the order they were pressed (Shift,
    // then the letter).
    const KEY_HOLD_MS = 40;
    const KEY_HOLD_FRAMES = 3;
    const keyQueue = [];
    const keyChanged = new Map(); // code -> { at, frame }: when it last went down or up
    let keyTimer = 0;
    let frames = 0;
    let counting = false;
    const countFrames = () => {
      frames++;
      counting = keyQueue.length > 0 || [...keyChanged.values()].some((c) => frames - c.frame < KEY_HOLD_FRAMES);
      if (counting) requestAnimationFrame(countFrames);
    };
    const setKey = (code, down) => {
      // Straight into MAME's keyboard where the build can (see SCANCODES).
      const scancode = SCANCODES[code];
      if (scancode != null && typeof window.Module?._mame_set_key === 'function') {
        window.Module._mame_set_key(scancode, down ? 1 : 0);
        return;
      }
      const keyCode = keyCodeOf(code);
      if (keyCode == null) return;
      // Where the key is: SDL tells a right Ctrl from a left one, and the keypad's keys, by it.
      const location = /Right$/.test(code) && /^(Control|Shift|Alt)/.test(code) ? 2 : /^Numpad/.test(code) ? 3 : 0;
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code, keyCode, which: keyCode, location, bubbles: true, cancelable: true }));
    };
    const pumpKeys = () => {
      keyTimer = 0;
      while (keyQueue.length) {
        if (!running || ended) {
          keyQueue.length = 0;
          return;
        }
        const [code, down] = keyQueue[0];
        const last = keyChanged.get(code);
        const wait = last ? last.at + KEY_HOLD_MS - performance.now() : 0;
        if (wait > 0 || (last && frames - last.frame < KEY_HOLD_FRAMES)) {
          keyTimer = setTimeout(pumpKeys, Math.max(wait, 16));
          return;
        }
        keyQueue.shift();
        keyChanged.set(code, { at: performance.now(), frame: frames });
        setKey(code, down);
        if (!counting) {
          counting = true;
          requestAnimationFrame(countFrames);
        }
      }
    };

    return {
      /**
       * Closes the game: MAME writes its NVRAM (high scores, settings the game keeps) as it
       * stops, within a frame, and then it all goes to the browser's storage. A build that
       * doesn't say when it's done is given a second.
       */
      async leave() {
        leaving = true;
        if (running && !ended) {
          try {
            window.JSMAME.exit();
            await Promise.race([exitDone, new Promise((resolve) => setTimeout(resolve, 1000))]);
          } catch (err) {
            console.warn('Stopping MAME failed', err);
          }
        }
        await storeChanges();
      },

      /** Presses or lets go of a key (a KeyboardEvent code, "ControlLeft"), as MAME's SDL layer reads keys. */
      press(code, down, { now = false } = {}) {
        if (!running || ended) return;
        // now: straight away, for the rollback engine, which presses keys on the frame they
        // belong to and runs frames again in one go (see mame-netplay.js).
        if (now) return setKey(code, down);
        keyQueue.push([code, Boolean(down)]);
        if (!keyTimer) pumpKeys();
      },

      /** Presses or lets go of one of a player's controls (see keyFor), for a friend's. */
      pressFor(player, control, down, options) {
        const code = keyFor(player, control);
        if (code) this.press(code, down, options);
      },

      running: () => running && !ended,
    };
  }

  return { start, keyFor };
})();
