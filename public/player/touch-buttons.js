// On-screen buttons for a DOS game on a phone, made to look and work like the virtual gamepad
// EmulatorJS gives a console game: its cross-shaped d-pad at the bottom left, round buttons in
// a diamond at the bottom right, two small block buttons between them where its Select and
// Start sit, and a shoulder button above each side as on its Game Boy Advance pad. Sizes,
// colours and places are EmulatorJS's own (see touch-buttons.css), so a game on a phone gets
// the same pad whichever emulator runs it.
//
// The app decides which buttons there are and which key each presses (see
// public/js/touchbuttons.js); this draws them and says when one goes down or up. A plain
// script, like shell.js.

window.TouchButtons = (() => {
  // Where each button sits: the group it's in and EmulatorJS's place for it in that group.
  const PLACES = {
    y: { group: 'right', style: { left: '40px' } },
    x: { group: 'right', style: { top: '40px' } },
    b: { group: 'right', style: { left: '81px', top: '40px' } },
    a: { group: 'right', style: { left: '40px', top: '80px' } },
    select: { group: 'center', block: true, style: { left: '-5px' } },
    start: { group: 'center', block: true, style: { left: '60px' } },
    l: { group: 'left', block: true, style: { left: '3px', top: '-90px' } },
    r: { group: 'right', block: true, style: { right: '3px', top: '-90px' } },
  };
  const DIRECTIONS = ['up', 'down', 'left', 'right'];

  // A key let go at once could be missed by a game that looks at which keys are down only now
  // and then, so each press lasts at least this long.
  const SHORTEST_PRESS = 60;

  /** A label's size, so a word fits a button a letter fills (EmulatorJS's letters are 30px). */
  const fontSize = (label, block) => {
    const n = [...label].length;
    if (block) return n <= 5 ? 15 : 11;
    return n <= 1 ? 30 : n <= 3 ? 20 : n <= 5 ? 15 : 11;
  };

  function create(host, { press }) {
    const root = document.createElement('div');
    root.className = 'touch-pad';
    root.hidden = true;
    host.append(root);

    // Keys held, each with how many buttons hold it (two buttons can press the same key) and
    // when it went down.
    const held = new Map();
    function hold(key) {
      const k = held.get(key);
      if (k) return void k.count++;
      held.set(key, { count: 1, since: performance.now() });
      press(key, true);
    }
    function letGo(key) {
      const k = held.get(key);
      if (!k || --k.count > 0) return;
      held.delete(key);
      const wait = SHORTEST_PRESS - (performance.now() - k.since);
      if (wait <= 0) return press(key, false);
      setTimeout(() => { if (!held.has(key)) press(key, false); }, wait);
    }
    // What a button or the d-pad lets go of when it's rebuilt or put away mid-press.
    let releases = [];
    function letGoOfEverything() {
      for (const release of releases) release();
      for (const key of held.keys()) press(key, false);
      held.clear();
    }

    /** One pointer on an element at a time; the rest of a press follows it wherever it goes. */
    function track(el, { down, move = () => {}, up }) {
      let pointer = null;
      const end = (e) => {
        if (e.pointerId !== pointer) return;
        pointer = null;
        up();
      };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (pointer !== null) return;
        pointer = e.pointerId;
        el.setPointerCapture?.(e.pointerId);
        down(e);
      });
      el.addEventListener('pointermove', (e) => { if (e.pointerId === pointer) move(e); });
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('lostpointercapture', end);
      // No zooming on a double tap, no text selection or callout on a long press.
      el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      releases.push(() => { if (pointer !== null) { pointer = null; up(); } });
    }

    function button({ slot, label, key }, container) {
      const place = PLACES[slot];
      const el = document.createElement('div');
      el.className = `touch-pad-button${place.block ? ' is-block' : ''}`;
      el.textContent = label;
      Object.assign(el.style, place.style, { fontSize: `${fontSize(label, place.block)}px` });
      track(el, {
        down: () => { el.classList.add('is-down'); hold(key); },
        up: () => { el.classList.remove('is-down'); letGo(key); },
      });
      container.append(el);
    }

    /** EmulatorJS's d-pad: where the finger is from its middle picks one or two directions. */
    function dpad(keys, container) {
      const main = document.createElement('div');
      main.className = 'touch-pad-dpad';
      main.innerHTML = '<div class="touch-pad-dpad-vertical"><div class="touch-pad-dpad-bar"></div></div>'
        + '<div class="touch-pad-dpad-horizontal"><div class="touch-pad-dpad-bar"></div></div>';
      const pressed = { up: false, down: false, left: false, right: false };
      const set = (next) => {
        for (const dir of DIRECTIONS) {
          if (next[dir] === pressed[dir]) continue;
          pressed[dir] = next[dir];
          main.classList.toggle(`is-${dir}`, next[dir]);
          if (keys[dir] == null) continue;
          if (next[dir]) hold(keys[dir]);
          else letGo(keys[dir]);
        }
      };
      const aim = (e) => {
        const rect = main.getBoundingClientRect();
        const x = e.clientX - rect.left - rect.width / 2;
        const y = e.clientY - rect.top - rect.height / 2;
        // EmulatorJS's own sums: 10px from the middle counts, and within 35° of an axis the
        // press is straight along it, past 55° a diagonal.
        const angle = Math.atan(x / y) / (Math.PI / 180);
        const next = { up: y <= -10, down: y >= 10, left: false, right: false };
        if (x >= 10) {
          next.right = !(Math.abs(angle) <= 35);
          next.up = angle < 0 && angle >= -55;
          next.down = angle > 0 && angle <= 55;
        } else if (x <= -10) {
          next.left = !(Math.abs(angle) <= 35);
          next.up = angle > 0 && angle <= 55;
          next.down = angle < 0 && angle >= -55;
        }
        set(next);
      };
      track(main, { down: aim, move: aim, up: () => set({ up: false, down: false, left: false, right: false }) });
      container.append(main);
    }

    return {
      /** The buttons to show: [{ slot, label, key }], `key` being what `press` is given. */
      set(buttons) {
        letGoOfEverything();
        releases = [];
        const parent = document.createElement('div');
        parent.className = 'touch-pad-parent';
        const groups = Object.fromEntries(['left', 'right', 'center'].map((name) => {
          const el = document.createElement('div');
          el.className = `touch-pad-${name}`;
          parent.append(el);
          return [name, el];
        }));
        const keys = {};
        for (const b of buttons) {
          if (DIRECTIONS.includes(b.slot)) keys[b.slot] = b.key;
          else if (PLACES[b.slot]) button(b, groups[PLACES[b.slot].group]);
        }
        if (Object.keys(keys).length) dpad(keys, groups.left);
        root.replaceChildren(parent);
      },

      /** Shows or hides the pad. While it's up, the page's host is marked `touch-pad-shown`. */
      setVisible(on) {
        if (!on) letGoOfEverything();
        root.hidden = !on;
        host.classList.toggle('touch-pad-shown', on);
      },

      letGoOfEverything,
    };
  }

  return { create };
})();
