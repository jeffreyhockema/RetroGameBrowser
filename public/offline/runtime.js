// The engine side of a downloaded game, running from a folder on disk with no server.
//
// A browser opening a page as file:// refuses fetch() and XMLHttpRequest for anything else on
// disk (Chrome and Edge; Firefox is laxer), which is how all three engines normally read their
// wasm builds and a game's files. Classic <script src> tags are still allowed, so a downloaded
// game carries its binary files as base64 inside .js files (see server/lib/standalone.js), and
// this puts them back where the engines look for them: a small file system in memory, with
// fetch() and XMLHttpRequest answered from it.
//
// The engines are then started exactly as the server's own player pages do (public/play.html,
// public/playdos.html, public/emu/play.html, public/mame/play.html), with the same settings
// written into launch.js when the game was downloaded.

/* global Dos */

// Everything here lives inside this block: the engine scripts loaded next are bundles of
// their own, and a name declared at the top level of one page-wide script would clash with
// theirs (js-dos declares a plain `el`, for one).
{
  const launch = window.RGB_LAUNCH;

  // ---------- The files, unpacked from the .js payload ----------

  // key (a path below the player folder) -> Uint8Array, decoded when first asked for.
  const files = new Map();
  // The page's folder, without its query or fragment: ScummVM keeps its command line in the
  // fragment, slashes and all, and a reload keeps it there.
  const BASE = new URL('./', location.href).href;

  /**
   * The bundled file a URL asks for, or null for anything else (which is then left to the
   * browser). The engines ask in three ways, all of which mean the same file here: by a path
   * relative to this page, by one from the root of the server ("/data/…", which on disk looks
   * like the root of the drive, or of the network share), and — where ScummVM loads an engine plugin — by a path glued
   * onto another one after a doubled slash ("engine//data/plugins/libsky.so"). A doubled slash
   * starts again from the root, which is what a browser would do with it against a server.
   */
  function bundled(url) {
    let href;
    try {
      href = new URL(url, location.href).href;
    } catch {
      return null;
    }
    let key;
    if (href.startsWith(BASE)) key = href.slice(BASE.length);
    else if (href.startsWith('file:')) key = href.replace(/^file:\/\/[^/]*\/*/, '').replace(/^[A-Za-z]:/, '');
    else return null;
    key = key.split(/[?#]/)[0];
    // A stray "%" that isn't an escape would throw, which would come out of the engine's own
    // fetch() rather than here; a name like that is taken as it stands instead.
    try { key = decodeURIComponent(key); } catch { /* not encoded after all */ }
    key = key.slice(key.lastIndexOf('//') + 1).replace(/^\/+/, '');
    return files.get(key) ?? unpack(key);
  }

  /**
   * Turns one file's base64 back into bytes and lets go of the text, which is a third as big
   * again as the file itself and is never needed twice.
   */
  function unpack(key) {
    const chunks = window.RGB_DATA?.[key];
    if (!chunks) return null;
    const bytes = decode(chunks);
    delete window.RGB_DATA[key];
    files.set(key, bytes);
    return bytes;
  }

  /**
   * The bytes of one file, from the base64 chunks it was stored in. The size comes from the
   * base64 itself, so only one chunk is ever held as decoded text, and each chunk's base64 is
   * let go of as soon as it has been copied.
   */
  function decode(chunks) {
    const size = chunks.reduce((n, c) => n + ((c.length * 3) >> 2) - (c.endsWith('==') ? 2 : c.endsWith('=') ? 1 : 0), 0);
    const out = new Uint8Array(size);
    let at = 0;
    for (let i = 0; i < chunks.length; i++) {
      const part = atob(chunks[i]);
      chunks[i] = '';
      for (let j = 0; j < part.length; j++) out[at + j] = part.charCodeAt(j);
      at += part.length;
    }
    return out;
  }

  const copyOf = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  // ---------- Answering the engines' requests from those files ----------

  /**
   * Stands in for fetch() and XMLHttpRequest. Anything the payload holds is answered from
   * memory; everything else goes to the browser as usual, so blob: URLs (which the engines make
   * themselves) and a page opened over http:// both still work.
   */
  function installFileSystem() {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url;
      const bytes = url ? bundled(url) : null;
      if (!bytes) return nativeFetch(input, init);
      // A Response copies the bytes it's given, so the stored file can't be changed through it.
      const head = /^head$/i.test(init?.method ?? input?.method ?? 'GET');
      return Promise.resolve(new Response(head ? null : bytes, {
        status: 200,
        headers: { 'Content-Length': String(bytes.length), 'Content-Type': 'application/octet-stream' },
      }));
    };

    const Native = window.XMLHttpRequest;
    window.XMLHttpRequest = class extends Native {
      open(method, url, async = true, ...rest) {
        this._bundled = bundled(url);
        this._sync = async === false;
        this._head = /^head$/i.test(String(method));
        if (!this._bundled) super.open(method, url, async, ...rest);
      }

      setRequestHeader(...args) {
        // A Range header would be honoured by a real server; nothing here is read in ranges.
        if (!this._bundled) super.setRequestHeader(...args);
      }

      send() {
        if (!this._bundled) return super.send(...arguments);
        // A synchronous request must be answered before send() returns (ScummVM reads some
        // files that way); an asynchronous one after the caller has set its handlers.
        if (this._sync) this._answer();
        else setTimeout(() => this._answer(), 0);
      }

      _answer() {
        const bytes = this._bundled;
        const fixed = (name, value) => Object.defineProperty(this, name, { value, configurable: true });
        fixed('readyState', 4);
        fixed('status', 200);
        fixed('statusText', 'OK');
        const type = this.responseType;
        // EmulatorJS sends a HEAD before every GET, only to read content-length: a body there
        // would turn the whole ROM into a string for nothing.
        const body = this._head ? (type === 'arraybuffer' ? new ArrayBuffer(0) : type === 'blob' ? new Blob([]) : '')
          : type === 'arraybuffer' ? copyOf(bytes)
          : type === 'blob' ? new Blob([bytes])
          : new TextDecoder().decode(bytes);
        fixed('response', body);
        if (!type || type === 'text') fixed('responseText', body);
        // dispatchEvent alone: onprogress, onreadystatechange, onload and onloadend are all
        // event handlers, so dispatching reaches them. Calling them as well would run an
        // engine's handler twice, and Emscripten's loader does real work in one of them.
        const progress = { lengthComputable: true, loaded: bytes.length, total: bytes.length };
        this.dispatchEvent(new ProgressEvent('progress', progress));
        this.dispatchEvent(new Event('readystatechange'));
        this.dispatchEvent(new ProgressEvent('load', progress));
        this.dispatchEvent(new ProgressEvent('loadend', progress));
      }

      getAllResponseHeaders() {
        return this._bundled ? `content-length: ${this._bundled.length}\r\n` : super.getAllResponseHeaders();
      }

      getResponseHeader(name) {
        if (!this._bundled) return super.getResponseHeader(name);
        return /^content-length$/i.test(name) ? String(this._bundled.length) : null;
      }
    };
  }

  // ---------- Loading ----------

  const el = (id) => document.getElementById(id);

  // The card, the words on it and the failures are the app's own (see player/shell.js), so a
  // game played from a folder on disk loads exactly as it does in the app. A game that stopped
  // is offered a way on: there's no app bar here to leave by.
  const shell = window.PlayerShell.init({ title: launch.title, engineName: launch.engineName });
  const ways = [
    { label: 'Start it again', act: () => location.reload() },
    { label: 'Back to the game', act: () => { location.href = launch.pageUrl; } },
  ];
  const fail = (text) => shell.fail(text, { ways });
  const crashed = (line) => shell.stopped(line, { ways });

  /** Loads one script, the only way a page opened from disk can read another file. */
  const loadScript = (src) => new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src;
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error(`${src} is missing. Unzip the whole download, keeping its folders together.`));
    document.head.append(tag);
  });

  /**
   * The game's files, a few tens of megabytes of base64 at a time. Each one is a plain script,
   * so the browser reads it from the folder next to this page without asking a server.
   *
   * A file is turned back into bytes as soon as the last of it has arrived, rather than at the
   * end: a big game would otherwise sit in memory twice over, as text and as bytes.
   */
  async function loadPayload() {
    const parts = launch.payload ?? [];
    for (const [i, src] of parts.entries()) {
      shell.loading('game', { got: launch.payloadBytes * (i / parts.length), total: launch.payloadBytes });
      // Lets the loading bar paint between files; each one takes a moment to read and decode.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await loadScript(src);
      // Everything but the file the next script carries on writing to.
      const waiting = Object.keys(window.RGB_DATA ?? {});
      for (const key of waiting.slice(0, i === parts.length - 1 ? waiting.length : -1)) unpack(key);
      shell.loading('game', { got: launch.payloadBytes * ((i + 1) / parts.length), total: launch.payloadBytes });
    }
  }

  // ---------- Saved games ----------

  // Saves live in this browser, under the game's own key, exactly as they do when the game is
  // played from the server. A game downloaded twice into different folders shares them.
  const DB = { name: 'rgb-offline-saves', store: 'changes' };

  const openDb = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB.name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB.store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function loadChanges(key) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const req = db.transaction(DB.store).objectStore(DB.store).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('No saved files could be read', err);
      return undefined; // told apart from "nothing saved yet": nothing is stored this session
    }
  }

  async function storeChanges(key, bytes) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB.store, 'readwrite');
      tx.objectStore(DB.store).put(bytes, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      // A write that fails as it commits (storage full, say) only aborts the transaction.
      tx.onabort = () => reject(tx.error ?? new Error('Saving was cancelled'));
    });
  }

  // ---------- The bar ----------

  let leaving = async () => {};
  let mouseLock = null; // set by DOSBox, which is the only engine that can hold the pointer

  function wireBar() {
    el('bar-back').addEventListener('click', async () => {
      el('bar-back').disabled = true;
      el('bar-back').textContent = 'Saving…';
      await leaving();
      location.href = launch.pageUrl;
    });
    el('bar-full').addEventListener('click', () => {
      document.documentElement.requestFullscreen?.().catch(() => {});
    });
    const mouse = el('bar-mouse');
    mouse.addEventListener('click', () => {
      const on = mouse.getAttribute('aria-pressed') !== 'true';
      mouseLock?.(on);
      setMouseLock(on);
    });
    el('bar-keys').addEventListener('click', () => {
      setKeyboardMode(el('bar-keys').getAttribute('aria-pressed') !== 'true');
      focusGame();
    });
    // The game keeps the keyboard: a click on the bar would otherwise leave it deaf.
    el('bar').addEventListener('click', () => setTimeout(focusGame, 0));
  }

  function setMouseLock(on) {
    const mouse = el('bar-mouse');
    mouse.setAttribute('aria-pressed', String(on));
    mouse.textContent = on ? 'Unlock mouse' : 'Lock mouse';
  }

  /**
   * A computer's keyboard (the C64's): its keys either work the joystick, which is what most
   * of its games want, or type on the keyboard, for the ones that ask you to press a key.
   * Only shown for a system that has one, and the button says what pressing it does.
   * Mirrors the app's bar (see public/js/player.js).
   */
  function setKeyboardMode(on) {
    const keys = el('bar-keys');
    keys.setAttribute('aria-pressed', String(on));
    keys.textContent = on ? 'Steer with the keys' : 'Type on the keyboard';
    keys.title = on
      ? 'Send the keys back to the joystick, for games you steer'
      : 'Send the keys to the computer\'s own keyboard, for games that ask you to type or press a key';
    window.EJS_emulator?.changeSettingOption?.('keyboardInput', on ? 'enabled' : 'disabled');
  }

  function focusGame() {
    (document.querySelector('#canvas') ?? window.EJS_emulator?.elements?.parent ?? document.querySelector('#dos canvas'))?.focus?.({ preventScroll: true });
  }

  // ---------- The engines ----------

  /** DOSBox (js-dos), for MS-DOS and Windows 3.x games. See public/playdos.html. */
  async function startDosbox() {
    const dos = launch.dos;
    const saved = await loadChanges(launch.saveKey);
    let startedAt = 0;

    /**
     * The game quit. That takes us back to its page, the way leaving does — unless it happened
     * within seconds of the start, which means it never really ran and the reason is worth
     * staying to read. (js-dos would otherwise put its own "save progress?" box over a dead
     * screen, which says nothing useful here: saving is handled below.)
     */
    const ended = () => {
      if (exited) return;
      exited = true;
      if (Date.now() - startedAt > 5000) location.href = launch.pageUrl;
      else fail('The game ended as soon as it started. Its start-up commands didn\'t run.');
    };
    // These are the payload's own keys, not URLs an engine asked for: a name with "#" or "%" in
    // it is taken as it stands (bundled() would cut or decode it).
    const stored = (key) => files.get(key) ?? unpack(key);
    const initFs = [];
    // Written before the zip is unpacked, so an empty file makes a folder the zip needs but
    // can't create itself.
    for (const dir of dos.folders ?? []) initFs.push({ path: `${dir}/.keep`, contents: new Uint8Array(0) });
    // MT-32 ROMs or a soundfont, where the music needs them.
    for (const f of dos.files ?? []) initFs.push({ path: f.path, contents: stored(f.url) });
    // A DOS game arrives as the zip eXo packed it. A Windows 3.x game was never zipped, so its
    // installed folder is written out file by file instead.
    if (dos.bundleUrl) initFs.push(stored(dos.bundleUrl));
    for (const f of dos.initFiles ?? []) initFs.push({ path: f.path, contents: f.url ? stored(f.url) : new Uint8Array(0) });
    if (saved) initFs.push(saved);

    shell.setEngineName(dos.backend === 'dosboxX' ? 'DOSBox-X' : 'DOSBox');
    shell.starting();
    let ci = null;
    let exited = false;
    let saving = null;
    const saveChanges = async () => {
      if (!ci || exited || saved === undefined) return;
      if (saving) return saving;
      saving = (async () => {
        try {
          // An emulator that has already gone never answers, so the wait is capped.
          const changes = await Promise.race([ci.persist(true), new Promise((resolve) => setTimeout(resolve, 5000, undefined))]);
          if (changes) await storeChanges(launch.saveKey, changes);
        } catch (err) {
          console.warn('Saving the game files failed', err);
        } finally {
          saving = null;
        }
      })();
      return saving;
    };

    const props = Dos(el('dos'), {
      dosboxConf: dos.conf,
      initFs,
      pathPrefix: 'engine/',
      backend: dos.backend,
      backendLocked: true,
      // The emulator runs in a worker, as it does in the app. A worker can't be started from a
      // file on disk, but js-dos makes its own from the script it fetches (which comes from the
      // payload here) and hands it the compiled engine, so nothing inside it reads from disk.
      // On this page instead of in a worker, DOSBox-X traps every few starts.
      workerThread: true,
      offscreenCanvas: false,
      autoStart: true,
      kiosk: true,
      imageRendering: 'pixelated',
      renderAspect: dos.aspect ? '4/3' : 'AsIs',
      renderBackend: 'webgl',
      mouseCapture: Boolean(dos.mouseLock),
      noCursor: false,
      theme: 'night',
      volume: 1,
      fsChanges: { local: false },
      onEvent(event, arg) {
        if (event === 'ci-ready') {
          ci = arg;
          startedAt = Date.now();
          started();
          setMouseLock(Boolean(dos.mouseLock));
          // The game quit and the emulator is ending. Its worker lives until this returns, so
          // it's the last chance to keep the game's files.
          ci.events().onUnload(async () => { await saveChanges(); ended(); });
          ci.events().onExit(() => ended());
          // The emulator itself failing, rather than the DOS program: the screen is dead
          // from here, so the page says so instead of going black.
          ci.events().onMessage((kind, ...args) => {
            const line = args.join(' ');
            if (kind !== 'error' && kind !== 'panic') return;
            console.error(line);
            if (/panic|abort|unreachable|out of memory|Unable to extract/i.test(line)) crashed(line);
          });
        } else if (event === 'emu-error' || event === 'bnd-error') {
          fail(String(arg ?? 'The emulator could not be loaded.'));
        }
      },
    });

    // js-dos never sends 'emu-error' or 'bnd-error' to onEvent: a failure before the engine is
    // up only shows in its own error window (out of sight in kiosk mode), whose message is the
    // one red line. js-dos 8.4.1's class name; on a later version this just finds nothing.
    const watch = setInterval(() => {
      if (ci || exited) return clearInterval(watch);
      const said = document.querySelector('#dos .text-red-400')?.textContent?.trim().replace(/^"|"$/g, '');
      if (said) {
        clearInterval(watch);
        fail(said);
      }
    }, 1000);

    el('bar-mouse').hidden = false;
    mouseLock = (on) => props.setMouseCapture(on);
    setInterval(() => { if (ci && !exited && !document.hidden) saveChanges(); }, 90000);
    document.addEventListener('visibilitychange', () => { if (document.hidden) saveChanges(); });
    leaving = async () => {
      await saveChanges();
      exited = true;
      // Told to stop, but not waited for: the whole page is about to go, and js-dos can take
      // another quarter of a minute to wind the emulator down.
      try { props.stop(); } catch { /* it's going away either way */ }
    };
  }

  /** EmulatorJS, for the console games. See public/emu/play.html. */
  async function startEmulator() {
    const emu = launch.emu;
    Object.assign(window, {
      EJS_player: '#game',
      EJS_core: emu.core,
      EJS_gameUrl: emu.gameUrl,
      EJS_gameName: emu.gameName,
      EJS_pathtodata: 'engine/emulatorjs/',
      EJS_startOnLoaded: true,
      EJS_language: 'en-US',
      EJS_disableAutoLang: true,
      EJS_color: '#22d3ee',
      EJS_backgroundColor: '#000',
      EJS_volume: 0.8,
      EJS_CacheLimit: 0, // the ROM is already here; nothing is worth keeping a second copy of
      EJS_controlScheme: emu.controlScheme,
      EJS_defaultOptions: {
        'save-state-location': 'browser',
        'save-save-interval': '60',
        ...emu.coreOptions,
      },
      EJS_Buttons: { exitEmulation: false, netplay: false },
      EJS_ready: () => {
        const fixes = window.EmulatorJSFixes; // the same fixes as the app's player (player/emulatorjs-fixes.js)
        fixes.sortSavesByCore();
        fixes.coreOptionsFromTheStart();
        fixes.keepKeyboardWithTheGame();
        fixes.quietMenu();
        fixes.gamepadsInAnySlot();
        fixes.controllerLayouts(emu.controllerLayouts);
        fixes.nameButtons(emu.buttonNames);
      },
      // A computer with a keyboard of its own gets the bar's keyboard switch, starting on the
      // joystick; EmulatorJS keeps the choice with the game, so the button shows what it is.
      EJS_onGameStart: () => {
        started();
        el('bar-keys').hidden = !emu.keyboard;
        if (emu.keyboard) setKeyboardMode(window.EJS_emulator?.allSettings?.keyboardInput === 'enabled');
      },
    });
    if (emu.biosUrl) {
      window.EJS_biosUrl = emu.biosUrl;
      if (emu.keepBiosZipped) window.EJS_dontExtractBIOS = true;
    }

    // What EmulatorJS says while it loads, and when a game won't start, goes on the card
    // instead, in the words the other platforms use.
    shell.watchEmulatorJS();
    await loadScript('engine/emulatorjs/loader.js');

    // Writes the game's own save (battery RAM, memory card) and waits for it to reach the
    // browser's storage.
    leaving = () => new Promise((resolve) => {
      const gm = window.EJS_emulator?.gameManager;
      if (!window.EJS_emulator?.started || !gm) return resolve();
      try {
        gm.saveSaveFiles();
        setTimeout(resolve, 3000);
        gm.FS.syncfs(false, () => resolve());
      } catch (err) {
        console.warn('Saving the game failed', err);
        resolve();
      }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) leaving(); });
  }

  /** MAME, for the arcade games. See public/mame/play.html, which starts the same player. */
  async function startMame() {
    const mame = launch.mame;
    // The payload's own keys, not URLs an engine asked for (see startDosbox).
    const stored = (key) => files.get(key) ?? unpack(key);
    const player = window.MamePlayer.start({
      shell,
      info: mame.info,
      files: mame.files.map((f) => ({ name: f.name, data: stored(f.key) })),
      wasmBinary: stored(mame.wasmKey),
      scriptUrl: mame.scriptUrl,
      locateFile: (file) => `engine/mame/${file}`,
      onStarted: started,
      // Quitting in MAME's menu (or Esc) goes back to the game's page, as leaving does.
      onQuit: () => { location.href = launch.pageUrl; },
      ways,
    });
    leaving = () => player.leave();
  }

  /** ScummVM. See public/play.html, which sets up the same Module. */
  async function startScummvm() {
    const canvas = el('canvas');
    canvas.hidden = false;
    const recent = [];
    const remember = (line) => {
      recent.push(line);
      if (recent.length > 60) recent.shift();
      if (/unrecognized game|could not find any (game|engine)|no game data|game data path does not exist|failed to load plugin|^error\b|out of memory/i.test(line)) {
        fail(line.replace(/^this\.program:\s*/, ''));
      }
    };
    window.Module = {
      canvas,
      // ScummVM reads its own settings from a file it fetches by this name.
      arguments: [],
      print: (...parts) => { const line = parts.join(' '); console.log(line); remember(line); },
      printErr: (...parts) => { const line = parts.join(' '); console.warn(line); remember(line); },
      // Emscripten's own running commentary says nothing the card doesn't: ScummVM's download
      // box, which the shell reads, is where its loading really shows.
      setStatus() {},
      monitorRunDependencies() {},
      onRuntimeInitialized() {
        canvas.focus();
        started();
      },
      onExit() { location.href = launch.pageUrl; },
      onAbort(reason) { crashed(reason); },
    };
    // ScummVM takes its command line from the fragment, and reloads the page when that changes.
    // Setting it before its script loads means no reload, and no listener to fight.
    location.hash = encodeURI(launch.scummvm.args.join(' '));
    shell.watchScummvm();
    await loadScript('engine/scummvm.js');
  }

  function started() {
    shell.playing();
    el('bar').hidden = false;
    document.title = launch.title;
    focusGame();
  }

  // ---------- Start ----------

  (async () => {
    installFileSystem();
    wireBar();
    // A WebAssembly trap kills the engine's main loop for good, whichever engine it is, and
    // the screen stops where it was. (public/play.html watches for the same thing.)
    window.addEventListener('error', (e) => {
      if (e.error instanceof WebAssembly.RuntimeError || /unreachable|RuntimeError/.test(e.message ?? '')) crashed(e.message);
    });
    shell.gettingReady();
    el('bar-title').textContent = launch.title;
    el('bar-version').textContent = launch.version === launch.title ? '' : launch.version;
    try {
      for (const href of launch.styles ?? []) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.append(link);
      }
      await loadPayload();
      for (const src of launch.scripts ?? []) await loadScript(src);
      if (launch.engine === 'dosbox') await startDosbox();
      else if (launch.engine === 'emulatorjs') await startEmulator();
      else if (launch.engine === 'mame') await startMame();
      else await startScummvm();
    } catch (err) {
      fail(err.message);
    }
  })();
}
