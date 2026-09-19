// The phone's own keyboard, for games that need one. A phone has no keys, and its keyboard
// only comes up for something you can type into, which a game (drawn on a canvas in a document
// of its own) isn't. So the player bar's Keyboard button puts the focus in a text box of the
// app's, kept out of sight, and what's typed there is pressed as keys in the game: each
// character as the key that makes it on a US keyboard (with Shift for capitals and symbols),
// Backspace and Return as themselves. A phone's keyboard has no Esc, Tab or arrow keys, which
// DOS games lean on, so a strip of those comes up with it.
//
// The keys are sent to whatever has the focus inside the game's page, from where they reach
// every emulator's own listener: DOSBox and ScummVM listen on the page's window, EmulatorJS on
// its own box, which its page keeps focused (see public/emu/play.html).

import { $ } from './util.js';

const els = {
  player: $('#player'),
  button: $('#player [data-act="type"]'),
  box: $('#player-typing'),
  strip: $('#player-keys'),
};

// What a key is to the emulators: the character or name, the physical key, and the old
// numeric code (DOSBox and ScummVM's SDL read that one).
const NAMED = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, char: 13 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
};
const SHIFT = { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 };

const PUNCTUATION = {
  ';': [186, 'Semicolon'], '=': [187, 'Equal'], ',': [188, 'Comma'], '-': [189, 'Minus'],
  '.': [190, 'Period'], '/': [191, 'Slash'], '`': [192, 'Backquote'], '[': [219, 'BracketLeft'],
  '\\': [220, 'Backslash'], ']': [221, 'BracketRight'], '\'': [222, 'Quote'],
};
// The unshifted key under each shifted symbol.
const SHIFTED = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': '\'', '<': ',', '>': '.', '?': '/', '~': '`',
};
// A phone's keyboard makes these on its own (curly quotes, a dash from two hyphens); the
// games want the plain ones.
const PLAIN = { '‘': '\'', '’': '\'', '“': '"', '”': '"', '–': '-', '—': '-', '…': '...' };

/** The key that types a character, or null for one no US keyboard has. */
function keyFor(ch) {
  const code = ch.charCodeAt(0);
  if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: code - 32, char: code };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, keyCode: code, char: code, shift: true };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: code, char: code };
  if (ch === ' ') return { key: ' ', code: 'Space', keyCode: 32, char: 32 };
  if (PUNCTUATION[ch]) return { key: ch, code: PUNCTUATION[ch][1], keyCode: PUNCTUATION[ch][0], char: code };
  if (SHIFTED[ch]) return { ...keyFor(SHIFTED[ch]), key: ch, char: code, shift: true };
  if (ch === '\n') return NAMED.Enter;
  return null;
}

let frameOf = () => null;
let queue = Promise.resolve();
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** One key event in the game's page, carrying the old numeric codes as well as the new names. */
function send(type, k, shiftKey) {
  const frame = frameOf();
  const win = frame?.contentWindow;
  const doc = frame?.contentDocument;
  if (!win || !doc) return;
  const target = doc.activeElement && doc.activeElement !== doc.documentElement ? doc.activeElement : doc.body;
  if (!target) return;
  const event = new win.KeyboardEvent(type, {
    key: k.key, code: k.code, location: k.location ?? 0, shiftKey, bubbles: true, cancelable: true,
  });
  // Read-only on a made event, so they're defined on this one.
  const legacy = type === 'keypress'
    ? { keyCode: k.char, which: k.char, charCode: k.char }
    : { keyCode: k.keyCode, which: k.keyCode, charCode: 0 };
  for (const [name, value] of Object.entries(legacy)) Object.defineProperty(event, name, { get: () => value });
  target.dispatchEvent(event);
}

/**
 * Presses a key and lets it go, holding Shift around it where it needs one. The keys wait
 * their turn, a moment apart, so fast typing arrives in order and a game that looks at
 * which keys are down, rather than at what was typed, sees each one.
 */
function press(k) {
  if (!k) return;
  queue = queue.then(async () => {
    if (k.shift) {
      send('keydown', SHIFT, true);
      await pause(15);
    }
    send('keydown', k, Boolean(k.shift));
    if (k.char) send('keypress', k, Boolean(k.shift));
    await pause(40);
    send('keyup', k, Boolean(k.shift));
    if (k.shift) send('keyup', SHIFT, false);
    await pause(15);
  });
}

function typeText(text) {
  for (const ch of Array.from(text).map((c) => PLAIN[c] ?? c).join('')) press(keyFor(ch));
}

// The box keeps a little text in it, so Backspace always has something to delete (a phone
// sends nothing for Backspace in an empty box) and the caret sits after it.
const FILLER = '  ';
function refill() {
  els.box.value = FILLER;
  els.box.setSelectionRange(FILLER.length, FILLER.length);
}

export const isTyping = () => els.button.getAttribute('aria-pressed') === 'true';

function show(on) {
  const changed = isTyping() !== on;
  els.button.setAttribute('aria-pressed', String(on));
  els.button.classList.toggle('is-armed', on);
  els.strip.hidden = !on;
  fitAboveKeyboard(on);
  // A DOS game's on-screen buttons make way for the keyboard (see touchbuttons.js).
  if (changed) document.dispatchEvent(new CustomEvent('player:typing', { detail: { on } }));
}

/**
 * The phone's keyboard covers the bottom of the screen without making the page any shorter,
 * so the player is fitted into what's left above it while it's up.
 */
function fitAboveKeyboard(on) {
  const view = window.visualViewport;
  if (!view) return;
  const fit = () => {
    els.player.style.top = `${view.offsetTop}px`;
    els.player.style.height = `${view.height}px`;
    els.player.style.bottom = 'auto';
  };
  if (on) {
    fit();
    view.addEventListener('resize', fit);
    view.addEventListener('scroll', fit);
    fitAboveKeyboard.fit = fit;
  } else {
    if (fitAboveKeyboard.fit) {
      view.removeEventListener('resize', fitAboveKeyboard.fit);
      view.removeEventListener('scroll', fitAboveKeyboard.fit);
      fitAboveKeyboard.fit = null;
    }
    els.player.style.removeProperty('top');
    els.player.style.removeProperty('height');
    els.player.style.removeProperty('bottom');
  }
}

// Whether the keyboard was up when the Keyboard button was touched. The touch itself takes the
// focus from the box, which puts the keyboard away before the button hears the tap, and the
// tap would then bring it straight back up.
let upWhenTouched = null;

/** Brings the phone's keyboard up (the focus has to move in the tap itself) or puts it away. */
export function toggleTyping(focusGame) {
  const up = upWhenTouched ?? isTyping();
  upWhenTouched = null;
  if (up) {
    stopTyping();
    focusGame();
    return;
  }
  refill();
  els.box.focus({ preventScroll: true });
  show(true);
}

/** Puts the keyboard away, as when the game closes. */
export function stopTyping() {
  if (document.activeElement === els.box) els.box.blur();
  show(false);
}

/**
 * Whether the Keyboard button is offered: on a touch screen, for a game that has a keyboard
 * to type on (a DOS or ScummVM game, a computer MAME runs, or one in EmulatorJS; not a console's).
 */
export function offerTyping(on) {
  els.button.hidden = !(on && matchMedia('(pointer: coarse)').matches);
  if (els.button.hidden) stopTyping();
}

export function wireTyping(frame) {
  frameOf = frame;
  let handled = false;

  els.box.addEventListener('beforeinput', (e) => {
    handled = true;
    if (e.inputType === 'deleteContentBackward') press(NAMED.Backspace);
    else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') press(NAMED.Enter);
    else if (e.data && !e.inputType.startsWith('insertComposition')) typeText(e.data);
    else handled = false; // left to the input event below, which reads what changed
    if (handled && e.cancelable) e.preventDefault();
  });

  // Where the typing couldn't be caught before it happened (a keyboard that composes words
  // as you type), what it changed in the box is worked out and pressed afterwards.
  els.box.addEventListener('input', (e) => {
    if (e.isComposing) return;
    if (!handled) {
      const value = els.box.value;
      if (value.startsWith(FILLER)) typeText(value.slice(FILLER.length));
      else for (let i = value.length; i < FILLER.length; i++) press(NAMED.Backspace);
    }
    handled = false;
    refill();
  });
  els.box.addEventListener('compositionend', refill);

  // A keyboard plugged into the phone has the keys the phone's own lacks.
  els.box.addEventListener('keydown', (e) => {
    if (['Escape', 'Tab', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      press(NAMED[e.key]);
    }
  });

  els.button.addEventListener('pointerdown', () => { upWhenTouched = isTyping(); });
  // Where the browser would move the focus to the button, it stays in the box.
  els.button.addEventListener('mousedown', (e) => { if (isTyping()) e.preventDefault(); });

  // Tapping the game, or the phone's own "done", puts the keyboard away: the button says so.
  els.box.addEventListener('blur', () => { if (isTyping()) show(false); });

  // The strip's keys press without taking the focus from the box, which would put the
  // phone's keyboard away.
  const keep = (e) => {
    const key = e.target.closest('[data-key]');
    if (!key) return;
    e.preventDefault();
    press(NAMED[key.dataset.key]);
  };
  els.strip.addEventListener('touchstart', keep, { passive: false });
  els.strip.addEventListener('mousedown', keep);
  els.strip.addEventListener('click', (e) => e.preventDefault());
}
