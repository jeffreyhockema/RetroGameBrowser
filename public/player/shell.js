// The part of playing a game that is the same on every platform: what the page says while the
// game loads, what it says when a game can't start, and what it tells the app around it.
//
// Three emulators run the games — ScummVM, DOSBox (js-dos) and EmulatorJS — and each reports
// its own progress in its own words, in its own box, in its own corner. This gives all three
// one card, in one place, saying the same few things in the same order:
//
//     Getting the game ready      the server unpacks or copies it, the first time only
//     Loading <emulator>          the emulator itself (its core and WebAssembly build)
//     Loading the system files    a console BIOS, MT-32 ROMs, a soundfont
//     Loading <game>              the game's own files
//     Starting <emulator>         handing over; the card goes when the game is up
//
// The emulators' own interfaces are left as they are: only their loading and failure text is
// taken over, by reading what they write and saying it again here (see watchScummvm and
// watchEmulatorJS). A plain script, not a module, so a downloaded game can load it from a
// folder on disk as well.

window.PlayerShell = (() => {
  const el = (id) => document.getElementById(id);

  const state = {
    engineName: 'the emulator',
    title: 'the game',
    run: null,        // identifies this launch to the app, so it can ignore an earlier attempt
    heading: null,    // what the card says now; the app is told only when this changes
    said: null,       // the whole of the last step, so the same one isn't written twice
    failed: false,    // the first reason is the one worth showing: an engine repeats itself
    running: false,   // the game is up: nothing loading has anything left to say
  };

  /** A size in the units people read them in: "820 KB", "3.4 MB", "612 MB". */
  function size(bytes) {
    const mb = bytes / 1048576;
    if (mb >= 10) return `${Math.round(mb)} MB`;
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  /** Tells the app around us (when there is one) what's happening. */
  function tell(message) {
    if (window.parent !== window) {
      window.parent.postMessage({ source: 'player', run: state.run, ...message }, location.origin);
    }
  }

  /**
   * Puts one step on the card: a heading, a line under it, and how far along it is. The app's
   * status line gets the heading, once per step rather than at every byte.
   */
  function step(heading, detail = '', fraction = null) {
    if (state.failed || state.running) return;
    const card = el('player-note');
    if (!card) return;
    // Nothing new to say: writing it again would be work for nothing, and where the card is
    // watched along with the emulator (see watchEmulatorJS) a needless write would come
    // straight back as another change to read.
    const same = JSON.stringify([heading, detail, fraction]);
    if (same === state.said) return;
    state.said = same;
    card.hidden = false;
    el('player-note-title').textContent = heading;
    el('player-note-text').textContent = detail;
    el('player-note-text').hidden = !detail;
    el('player-note-bar').hidden = fraction === null;
    el('player-note-fill').style.width = fraction === null ? '0' : `${Math.round(fraction * 100)}%`;
    if (heading !== state.heading) {
      state.heading = heading;
      tell({ type: 'progress', line: heading });
    }
  }

  /**
   * One loading step, in the same shape for every emulator. `what` says whose files these are
   * — the emulator's, the game's, or the system files a platform needs — and the rest is how
   * far along it is, as much of it as the emulator gives away.
   */
  function loading(what, { got = 0, total = 0, note = '', fraction = null } = {}) {
    const heading = what === 'engine' ? `Loading ${state.engineName}`
      : what === 'system' ? 'Loading the system files'
      : `Loading ${state.title}`;
    const detail = note || (total ? `${size(got)} of ${size(total)}` : got ? `${size(got)} so far` : '');
    const done = fraction !== null ? fraction : (total ? Math.min(1, got / total) : null);
    step(heading, detail, done);
  }

  /** Turns the card into the one that says a game stopped, or couldn't start. */
  function showFailure(heading, text, ways) {
    state.failed = true;
    const card = el('player-note');
    if (!card) return;
    card.hidden = false;
    card.classList.add('is-error');
    card.setAttribute('role', 'alert');
    el('player-note-title').textContent = heading;
    el('player-note-text').textContent = text;
    el('player-note-text').hidden = !text;
    el('player-note-bar').hidden = true;
    const buttons = el('player-note-ways');
    buttons.textContent = '';
    buttons.hidden = !ways.length;
    for (const way of ways) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = way.label;
      button.addEventListener('click', way.act);
      buttons.append(button);
    }
    buttons.querySelector('button')?.focus();
  }

  return {
    size,
    tell,
    step,
    loading,

    /**
     * What this launch is: the game, the emulator running it, and which attempt it is (the app
     * ignores anything an earlier one still has to say). A downloaded game passes these in; in
     * the app they come from the player URL. The emulator's name can wait until the server has
     * said which core or build a version needs (see setEngineName).
     */
    init({ title, engineName, run } = {}) {
      const query = new URLSearchParams(location.search);
      state.title = title || query.get('title') || 'the game';
      if (engineName) state.engineName = engineName;
      state.run = run ?? query.get('run');
      document.title = state.title;
      return this;
    },

    /** The emulator's name, once the page knows which build it's getting (DOSBox or DOSBox-X). */
    setEngineName(name) {
      if (name) state.engineName = name;
      return this;
    },

    engineName: () => state.engineName,
    gameTitle: () => state.title,

    /** The server is unpacking or copying the game, which it does once per game. */
    gettingReady(detail = '') {
      step('Getting the game ready', detail, null);
    },

    /** The last step: the emulator has everything it needs and is starting the game. */
    starting() {
      step(`Starting ${state.engineName}`, '', null);
    },

    /** The game is up. The card goes, and the app stops saying the game is loading. */
    playing() {
      state.running = true;
      const card = el('player-note');
      if (card) card.hidden = true;
      state.heading = null;
      tell({ type: 'started' });
    },

    /**
     * The game can't start. Only the first reason is shown: an emulator that has given up
     * usually says so several times over. `ways` are buttons offering a way on, which a
     * downloaded game has and a game in the app doesn't (the app's own bar is the way out).
     */
    fail(text, { heading = 'Couldn\'t start the game', ways = [] } = {}) {
      if (state.failed) return;
      showFailure(heading, text, ways);
      tell({ type: 'problem', line: text });
    },

    /**
     * The emulator stopped part-way through a game. The screen is dead from here, so this says
     * so rather than leaving it black; in the app, its own card says the same over the frame.
     */
    stopped(line, { ways = [] } = {}) {
      if (state.failed) return;
      const said = String(line ?? '').trim().replace(/[.\s]+$/, '');
      showFailure('This game stopped',
        `The browser version of ${state.engineName} stopped while running the game${said ? `: ${said}` : ''}. `
        + 'Starting it again usually works, and anything saved before now is kept.', ways);
      tell({ type: 'crashed', line: said });
    },

    /**
     * ScummVM's own download box, which its build writes into by the names of its elements.
     * The box stays in the page (its build would throw without it) but is never seen: what it
     * says is said on the card instead, in the words the other emulators get.
     */
    watchScummvm() {
      const modal = el('download-modal');
      if (!modal) return;
      const read = () => {
        if (state.failed || modal.style.display === 'none') return;
        const said = (modal.querySelector('#download-modal-title h3')?.textContent ?? '').replace(/[.\s]+$/, '');
        if (!said) return;
        if (/^starting/i.test(said)) return this.starting();
        const width = parseFloat(el('download-modal-progress-fill')?.style.width);
        // "Downloaded 3.4 MB / 32 MB" in ScummVM's words is "3.4 MB of 32 MB" in ours.
        const progress = (el('download-modal-progress-text')?.textContent ?? '')
          .replace(/^Downloaded\s+/i, '').replace(/\s*\/\s*/, ' of ');
        // The box names what it's fetching: its own build, or a file belonging to the game.
        loading(/scummvm/i.test(said) ? 'engine' : 'game', {
          note: progress,
          fraction: Number.isFinite(width) ? width / 100 : null,
        });
      };
      new MutationObserver(read).observe(modal, {
        subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style'],
      });
    },

    /**
     * EmulatorJS's own loading line, which it writes as "Download Game Data 40%" and turns into
     * its failure text when a game won't start. It's hidden (see shell.css) and read from here
     * instead, so a console game loads with the same words as a DOS or ScummVM game.
     */
    watchEmulatorJS() {
      const PHASES = [
        [/^Download Game (Core|Assets)/i, 'engine', ''],
        [/^Decompress Game (Core|Assets)/i, 'engine', 'Unpacking…'],
        [/^Download Game BIOS/i, 'system', ''],
        [/^Decompress Game BIOS/i, 'system', 'Unpacking…'],
        [/^Decompress Game (Data|Parent|Patch|State)/i, 'game', 'Unpacking…'],
        [/^(Download Game (Data|Parent|Patch|State)|Loading)/i, 'game', ''],
      ];
      let spoke = false;
      const read = () => {
        const line = document.querySelector('.ejs_loading_text');
        // EmulatorJS takes its line away once it has everything and is putting the game on
        // screen, which is the last step the card has to show.
        if (!line) {
          if (spoke) this.starting();
          return;
        }
        spoke = true;
        const said = (line.textContent ?? '').trim();
        if (!said) return;
        // EmulatorJS marks that same line as its failure text rather than showing a box.
        if (line.classList.contains('ejs_error_text')) return this.fail(said);
        const phase = PHASES.find(([pattern]) => pattern.test(said));
        if (!phase) return;
        // What it adds to the line: " 40%" where the size is known, " 3.42MB" until then.
        const percent = said.match(/\s(\d+)\s*%$/);
        const megabytes = said.match(/\s([\d.]+)\s*MB$/i);
        loading(phase[1], {
          note: phase[2],
          got: megabytes ? Number(megabytes[1]) * 1048576 : 0,
          fraction: percent ? Number(percent[1]) / 100 : null,
        });
      };
      // The emulator's own element, not the whole page: the card is written to from here, and
      // watching that as well would turn every step into another change to read.
      new MutationObserver(read).observe(document.querySelector('#game') ?? document.body, {
        subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'],
      });
    },
  };
})();
