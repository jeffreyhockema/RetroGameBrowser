// Fixes to how EmulatorJS behaves, for both places a console game plays: the app's player page
// (public/emu/play.html) and a downloaded game's (public/offline/runtime.js). Kept in one file
// so the two can't drift apart. Each is called from EJS_ready, once EmulatorJS is loaded and
// before the game starts. A plain script, not a module, so a downloaded game can load it from a
// folder on disk as well.

window.EmulatorJSFixes = {
  /**
   * Each core keeps its in-game saves in its own folder (/data/saves/<core>/): RetroArch names
   * a save after the game's file, and Gemfire on the NES, SNES and Genesis would otherwise
   * share one. (Downloaded games need it as much: every game opened from a folder on disk
   * shares the browser's one storage for files.) Runs before the core writes its settings file.
   */
  sortSavesByCore() {
    const proto = window.EJS_GameManager?.prototype;
    if (typeof proto?.getRetroArchCfg !== 'function' || proto.getRetroArchCfg.sortsSaves) return;
    const base = proto.getRetroArchCfg;
    proto.getRetroArchCfg = function getRetroArchCfg() {
      return `${base.call(this)}sort_savefiles_enable = true\n`;
    };
    proto.getRetroArchCfg.sortsSaves = true;
  },

  /**
   * EmulatorJS listens for keys on its own box, not on the page, and a click in the game
   * leaves the focus on the page instead of that box. The game then ignores the keyboard,
   * with the controls still listed in its menu. So the box is put back in focus after every
   * click that doesn't land in something you type into.
   */
  keepKeyboardWithTheGame() {
    const restore = (event) => {
      const box = window.EJS_emulator?.elements?.parent;
      if (!box) return;
      // The emulator's own fields (cheats, netplay) must keep what you type.
      if (event.target?.closest?.('input, textarea, select, [contenteditable]')) return;
      if (document.activeElement?.closest?.('input, textarea, select, [contenteditable]')) return;
      if (box.contains(document.activeElement)) return;
      box.focus({ preventScroll: true });
    };
    // After the click, so it doesn't fight the browser's own idea of what to focus.
    document.addEventListener('click', restore);
    document.addEventListener('pointerup', restore);
    // The player's bar is outside this page, so a button there takes the focus with it. When
    // it hands the keyboard back, the box takes it: the keys are no use to anything else.
    window.addEventListener('focus', restore);
  },

  /**
   * EmulatorJS finds a controller in its own list (which has no gaps) by the browser's number
   * for it, so a controller the browser numbers 1 or higher (another input device holds 0, or
   * it was plugged in again) isn't found: the lookup throws, which also ends EmulatorJS's
   * polling for good, and the controller never appears in Control Settings. The lookups are
   * done by the controller's own number instead, and the polling is started again in case a
   * button pressed while the game loaded has already ended it.
   */
  gamepadsInAnySlot() {
    const ejs = window.EJS_emulator;
    const pads = ejs?.gamepad;
    if (typeof pads?.on !== 'function' || pads.findsAnySlot) return;
    const position = (e) => pads.gamepads.findIndex((pad) => pad?.index === e.gamepadIndex);
    const nameOf = (pad) => `${pad.id}_${pad.index}`;
    // A new controller goes to the first player without one. One the browser already showed
    // before EmulatorJS was listening (its first look happens before it adds its listeners)
    // gets the same.
    const assign = (pad) => {
      const selection = ejs.gamepadSelection;
      if (!pad || !selection || selection.includes(nameOf(pad))) return;
      const free = selection.indexOf('');
      if (free >= 0) selection[free] = nameOf(pad);
    };
    pads.on('connected', (e) => {
      if (!ejs.gamepadLabels) return;
      assign(pads.gamepads[position(e)]);
      ejs.updateGamepadLabels();
    });
    // The rest of EmulatorJS's handler only uses the number for that lookup.
    const input = (e) => {
      const at = position(e);
      if (at >= 0) ejs.gamepadEvent({ ...e, gamepadIndex: at });
    };
    for (const name of ['axischanged', 'buttondown', 'buttonup']) pads.on(name, input);
    pads.gamepads.forEach(assign);
    if (ejs.gamepadLabels) ejs.updateGamepadLabels();
    pads.terminate();
    pads.loop();
    pads.findsAnySlot = true;
  },

  /**
   * Each player's controller layout, from the app's Settings: [1, 1, 1, 1] for players 1-4.
   *
   * Every core is made for RetroArch's pad, whose face buttons sit where a modern gamepad's do:
   * B bottom, A right, Y left, X top, and each console's buttons are laid out on those (a
   * PlayStation's Cross is B; a Genesis's A, B and C are Y, B and A). Browsers number a gamepad's
   * buttons by where they are too, whatever is printed on them. So layout 1 (the default) puts
   * each console button where it was on the console's own controller, as RetroArch does.
   * Layout 2 is EmulatorJS's own, which goes by the letters on an Xbox controller: its A, at the
   * bottom, is the game's A.
   *
   * EmulatorJS gives only player 1 any buttons, so a second controller (which goes to player 2)
   * did nothing. Players 2-4 get player 1's gamepad buttons, in their own layout; not its keys,
   * which would work two players at once.
   *
   * That's the default for the Reset button in Control Settings as well as a first play.
   * EmulatorJS saves a game's whole mapping with its settings the first time it plays, so a game
   * played before has a mapping saved already: a player's layout is switched to the one chosen
   * unless one of the four face buttons was set by hand, and players 2-4 with no gamepad buttons
   * get them. Runs before EmulatorJS reads the saved mapping.
   */
  controllerLayouts(layouts) {
    const ejs = window.EJS_emulator;
    const defaults = ejs?.defaultControllers;
    if (!defaults?.[0]) return;
    // RetroArch button number (0 B, 8 A, 1 Y, 9 X) -> gamepad button, in each layout.
    const LAYOUTS = {
      1: { 0: 'BUTTON_1', 8: 'BUTTON_2', 1: 'BUTTON_3', 9: 'BUTTON_4' },
      2: { 0: 'BUTTON_2', 8: 'BUTTON_1', 1: 'BUTTON_4', 9: 'BUTTON_3' },
    };
    const layoutOf = (player) => LAYOUTS[layouts?.[player]] ?? LAYOUTS[1];
    // Player 1's gamepad buttons, which EmulatorJS has already cut down to the console's own.
    const gamepadOnly = Object.fromEntries(Object.entries(defaults[0])
      .filter(([, control]) => control?.value2)
      .map(([num, control]) => [num, control.value2]));
    const face = Object.keys(LAYOUTS[1]);

    for (let player = 0; player < 4; player++) {
      const buttons = { ...(player === 0 ? {} : gamepadOnly), ...layoutOf(player) };
      for (const [num, label] of Object.entries(buttons)) {
        // A console without one of the face buttons has had it taken out of the mapping.
        if (!(num in gamepadOnly)) continue;
        defaults[player] = { ...defaults[player], [num]: { ...defaults[player]?.[num], value2: label } };
        if (ejs.controls) ejs.controls[player] = { ...ejs.controls[player], [num]: { ...ejs.controls[player]?.[num], value2: label } };
      }
    }

    try {
      const key = ejs.getLocalStorageKey();
      // Left by an earlier version of this, which switched a game over only once.
      localStorage.removeItem(`rgb-gamepad-buttons:${key}`);
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (!saved?.controlSettings) return;
      let changed = false;
      const set = (mine, num, label) => {
        if (mine[num]?.value2 === label) return;
        mine[num] = { ...mine[num], value2: label };
        changed = true;
      };
      for (let player = 0; player < 4; player++) {
        const mine = (saved.controlSettings[player] ??= {});
        if (player > 0 && !Object.values(mine).some((control) => control?.value2)) {
          // Saved when EmulatorJS gave this player nothing.
          for (const [num, control] of Object.entries(defaults[player] ?? {})) set(mine, num, control.value2);
          continue;
        }
        // A face button as either layout has it (or a mix of the two, which an earlier version
        // of this left on some consoles) wasn't set by hand.
        const fromALayout = (num) => [undefined, LAYOUTS[1][num], LAYOUTS[2][num]].includes(mine[num]?.value2);
        if (!face.every(fromALayout)) continue;
        for (const [num, label] of Object.entries(layoutOf(player))) {
          if (mine[num]) set(mine, num, label);
        }
      }
      if (changed) localStorage.setItem(key, JSON.stringify(saved));
    } catch (err) {
      console.warn('Setting the controller layouts failed', err);
    }
  },

  /**
   * The platform's names for its buttons ({ 0: '✕ Cross' }: RetroArch button number to name),
   * for a pad EmulatorJS has no controls of its own for and labels like a SNES pad (the
   * PlayStation's). Renamed in Control Settings, in its "Press Keyboard" prompt, and on a
   * phone's gamepad, all of which EmulatorJS has built by now.
   */
  nameButtons(names) {
    const ejs = window.EJS_emulator;
    if (!ejs?.controlMenu || !names || !Object.keys(names).length) return;
    for (const row of ejs.controlMenu.querySelectorAll('.ejs_control_bar[data-id]')) {
      const name = names[row.getAttribute('data-id')];
      const label = row.querySelector('label');
      if (!name || !label) continue;
      label.innerText = `${name}:`;
      row.setAttribute('data-label', name);
      // EmulatorJS writes the prompt when the row is pressed; this runs after it, in its words.
      row.addEventListener('mousedown', () => {
        if (ejs.controlPopup) ejs.controlPopup.innerText = `[ ${name} ]\n${ejs.localization('Press Keyboard')}`;
      });
    }
    // The phone's gamepad shows only the symbol. Its buttons are named after where they sit
    // on an Xbox pad, so each is found by the button it presses in EmulatorJS's standard layout.
    const touch = { a: 0, b: 8, x: 1, y: 9 };
    for (const [id, num] of Object.entries(touch)) {
      const button = ejs.virtualGamepad?.querySelector(`.ejs_virtualGamepad_button.b_${id}`);
      if (button && names[num]) button.innerText = names[num].split(' ')[0];
    }
  },

  /**
   * EmulatorJS's menu bar keeps out of the way on a phone:
   * - It opened by itself as the game started. Now it stays closed.
   * - Its desktop triggers (the mouse moving down, or near the bottom edge, or a click) also
   *   fired for a phone's taps: a tap that misses the on-screen pad's buttons becomes a mouse
   *   event near the bottom, so the menu came up mid-game. Taps on the game or the pad now
   *   stop before reaching them. The ☰ button still opens the menu.
   * - A popup with no title ("Click to resume Emulator" on an iPhone) showed "undefined" as
   *   its title. Now it shows none.
   */
  quietMenu() {
    const ejs = window.EJS_emulator;
    if (!ejs?.menu || ejs.menu.quiet) return;
    ejs.menu.quiet = true;
    // EmulatorJS opens it just before this event, in the same turn, so it never shows.
    ejs.on('start', () => ejs.menu.close());

    let lastTouch = -Infinity;
    const touched = () => { lastTouch = performance.now(); };
    for (const type of ['touchstart', 'touchend']) document.addEventListener(type, touched, { capture: true, passive: true });
    const fromTouch = (e) => e.pointerType === 'touch' || e.sourceCapabilities?.firesTouchEvents || performance.now() - lastTouch < 1000;
    const stop = (e) => { if (fromTouch(e)) e.stopPropagation(); };
    for (const el of [ejs.game, ejs.virtualGamepad]) {
      for (const type of ['mousemove', 'click']) el?.addEventListener(type, stop);
    }

    const untitled = (h4) => { if (!h4.textContent || h4.textContent === 'undefined') h4.hidden = true; };
    ejs.elements?.parent?.querySelectorAll('.ejs_popup_container > h4').forEach(untitled);
    const createPopup = ejs.createPopup;
    ejs.createPopup = function (...args) {
      const body = createPopup.apply(this, args);
      const h4 = body?.parentElement?.querySelector(':scope > h4');
      if (h4) untitled(h4);
      return body;
    };
  },

  /**
   * EmulatorJS puts its default options in the core's settings file only once the player has
   * settings of their own for the game; on a first play it sets them after the game has
   * started, too late for options read at boot (the Neo Geo's console mode). So the defaults
   * are added to the file whenever they're missing.
   */
  coreOptionsFromTheStart() {
    const ejs = window.EJS_emulator;
    if (typeof ejs?.getCoreSettings !== 'function' || ejs.getCoreSettings.addsDefaults) return;
    const base = ejs.getCoreSettings;
    ejs.getCoreSettings = function getCoreSettings() {
      let text = base.call(this) ?? '';
      const have = new Set(text.split('\n').map((line) => line.split('=')[0].trim()).filter(Boolean));
      for (const [key, value] of Object.entries(this.config.defaultOptions ?? {})) {
        if (!have.has(key)) text += `${key} = ${JSON.stringify(String(value))}\n`;
      }
      return text;
    };
    ejs.getCoreSettings.addsDefaults = true;
  },
};
