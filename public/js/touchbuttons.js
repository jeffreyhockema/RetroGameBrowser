// On-screen buttons for DOS and arcade games on a phone. A console game gets EmulatorJS's virtual
// gamepad; a DOS or arcade game gets one drawn the same way (see public/player/touch-buttons.js),
// whose buttons press keyboard keys. In a DOS game: the d-pad the arrow keys, the round buttons
// Ctrl, Alt, Space and Shift, the two middle buttons Tab and Enter, and the shoulder buttons
// nothing until given a key. In an arcade game, MAME's keys: the d-pad the joystick, the round
// buttons buttons 1-4 and the shoulders 5-6 (as many as the game has), the middle buttons Coin
// and Start. They're up while the phone's own keyboard is away (see typing.js).
//
// Every game can have its own: the player bar's Buttons button opens a sheet that picks the key
// each button presses (or none, which takes the button away) and whether the game shows them at
// all. MS-DOS games show them to begin with; Windows 3.x games, which are played with the
// pointer, don't. Changes are kept with the other per-game settings (see settings.js).

import { $, h } from './util.js';
import { touchButtonChanges, setTouchButtons } from './settings.js';
import { isTyping } from './typing.js';

// Every key a DOS game might want, in the groups the sheet lists them in: the key's code (as a
// KeyboardEvent names it), its name in the list, what the button says, and DOSBox's number for
// it (js-dos's KBD_ codes).
const GROUPS = [
  ['Common', [
    ['Enter', 'Enter', 'Enter', 257],
    ['Space', 'Space', 'Space', 32],
    ['Escape', 'Esc', 'Esc', 256],
    ['Tab', 'Tab', 'Tab', 258],
    ['Backspace', 'Backspace', '⌫', 259],
  ]],
  ['Arrows', [
    ['ArrowUp', 'Up arrow', '↑', 265],
    ['ArrowDown', 'Down arrow', '↓', 264],
    ['ArrowLeft', 'Left arrow', '←', 263],
    ['ArrowRight', 'Right arrow', '→', 262],
  ]],
  ['Shift, Ctrl and Alt', [
    ['ShiftLeft', 'Left Shift', 'Shift', 340],
    ['ShiftRight', 'Right Shift', 'RShift', 344],
    ['ControlLeft', 'Left Ctrl', 'Ctrl', 341],
    ['ControlRight', 'Right Ctrl', 'RCtrl', 345],
    ['AltLeft', 'Left Alt', 'Alt', 342],
    ['AltRight', 'Right Alt', 'RAlt', 346],
    ['CapsLock', 'Caps Lock', 'Caps', 280],
  ]],
  ['Letters', [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c, i) => [`Key${c}`, c, c, 65 + i])],
  ['Numbers', [...'0123456789'].map((n, i) => [`Digit${n}`, n, n, 48 + i])],
  ['Function keys', Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `F${i + 1}`, `F${i + 1}`, 290 + i])],
  ['Editing', [
    ['Insert', 'Insert', 'Ins', 260],
    ['Delete', 'Delete', 'Del', 261],
    ['Home', 'Home', 'Home', 268],
    ['End', 'End', 'End', 269],
    ['PageUp', 'Page Up', 'PgUp', 266],
    ['PageDown', 'Page Down', 'PgDn', 267],
  ]],
  ['Keypad', [
    ...[...'0123456789'].map((n, i) => [`Numpad${n}`, `Keypad ${n}`, `KP${n}`, 320 + i]),
    ['NumpadDecimal', 'Keypad .', 'KP.', 330],
    ['NumpadDivide', 'Keypad /', 'KP/', 331],
    ['NumpadMultiply', 'Keypad *', 'KP*', 332],
    ['NumpadSubtract', 'Keypad -', 'KP-', 333],
    ['NumpadAdd', 'Keypad +', 'KP+', 334],
    ['NumpadEnter', 'Keypad Enter', 'KP↵', 335],
    ['NumLock', 'Num Lock', 'Num', 282],
  ]],
  ['Punctuation', [
    ['Backquote', '`', '`', 96],
    ['Minus', '-', '-', 45],
    ['Equal', '=', '=', 61],
    ['BracketLeft', '[', '[', 91],
    ['BracketRight', ']', ']', 93],
    ['Backslash', '\\', '\\', 92],
    ['Semicolon', ';', ';', 59],
    ['Quote', '\'', '\'', 39],
    ['Comma', ',', ',', 44],
    ['Period', '.', '.', 46],
    ['Slash', '/', '/', 47],
    ['ScrollLock', 'Scroll Lock', 'Scroll', 281],
  ]],
];
// What MAME's default keys do, listed first for an arcade game under these names and labels.
const ARCADE_GROUP = ['Arcade', [
  ['Digit5', 'Insert a coin', 'Coin'],
  ['Digit1', 'Start', 'Start'],
  ['ControlLeft', 'Button 1', '1'],
  ['AltLeft', 'Button 2', '2'],
  ['Space', 'Button 3', '3'],
  ['ShiftLeft', 'Button 4', '4'],
  ['KeyZ', 'Button 5', '5'],
  ['KeyX', 'Button 6', '6'],
  ['Digit6', 'Insert a coin (player 2)', 'Coin 2'],
  ['Digit2', 'Start (player 2)', 'Start 2'],
  ['Tab', 'MAME\'s menu', 'Menu'],
  ['KeyP', 'Pause', 'Pause'],
  ['F7', 'Load or save a state (F7)', 'F7'],
]];

/** The keys a game's buttons can press, in the sheet's groups: [group, [[code, name, label, dosbox]]]. */
const groupsFor = (engine) => (engine === 'mame' && !arcade?.computer ? [ARCADE_GROUP, ...GROUPS] : GROUPS);
/** Key code -> { name, label, dosbox }, the first group that lists a key naming it. */
const keysFor = (engine) => {
  const keys = new Map();
  for (const [, list] of groupsFor(engine)) {
    for (const [code, name, label, dosbox] of list) if (!keys.has(code)) keys.set(code, { name, label, dosbox });
  }
  return keys;
};

// The buttons, by EmulatorJS's names for their places (see touch-buttons.js), and what each
// presses to begin with ('' is no button).
const SLOTS = {
  up: 'D-pad up', down: 'D-pad down', left: 'D-pad left', right: 'D-pad right',
  y: 'Top round button', x: 'Left round button', b: 'Right round button', a: 'Bottom round button',
  select: 'Left middle button', start: 'Right middle button',
  l: 'Left shoulder button', r: 'Right shoulder button',
};
const DEFAULT_KEYS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  a: 'ControlLeft', b: 'AltLeft', x: 'Space', y: 'ShiftLeft',
  select: 'Tab', start: 'Enter',
  l: '', r: '',
};
// MAME's buttons 1-6 in the order the round buttons and then the shoulders take them.
const ARCADE_BUTTONS = [['a', 'ControlLeft'], ['b', 'AltLeft'], ['x', 'Space'], ['y', 'ShiftLeft'], ['l', 'KeyZ'], ['r', 'KeyX']];

/**
 * What each button presses to begin with. An arcade game gets as many buttons as MAME says the
 * version has (a light gun game none but Coin and Start: the screen is the trigger).
 */
function defaultKeys() {
  // A DOS game, or a computer MAME runs (an Apple IIgs): keys, as on a keyboard.
  if (engine !== 'mame' || arcade?.computer) return DEFAULT_KEYS;
  const count = arcade?.lightgun ? 0 : arcade?.buttons ?? 6;
  return {
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    ...Object.fromEntries(ARCADE_BUTTONS.map(([slot, code], i) => [slot, i < count ? code : ''])),
    select: 'Digit5', start: 'Digit1',
  };
}
// Windows games are played with the mouse: their buttons wait until asked for.
const shownAtFirst = (g) => !['Windows 3x', 'Windows 9x'].includes(g.platform);

const els = {
  button: $('#player [data-act="touch"]'),
  editor: $('#touch-editor'),
};

let frameOf = () => null;
let game = null; // the game playing, when it's one that has on-screen buttons on this device
let engine = null; // what runs it: 'dosbox' or 'mame'
let arcade = null; // a MAME version's controls: an arcade game's { buttons, lightgun }, a computer's { computer }
let returnFocus = null;

const onPhone = () => matchMedia('(pointer: coarse)').matches;

/** A game's buttons as its player has them: { show, keys: { slot: key code or '' } }. */
function choicesFor(g) {
  const changes = touchButtonChanges(g.id) ?? {};
  const keys = { ...defaultKeys() };
  const known = keysFor(engine);
  for (const [slot, code] of Object.entries(changes.keys ?? {})) {
    if (Object.hasOwn(keys, slot) && (code === '' || known.has(code))) keys[slot] = code;
  }
  return { show: typeof changes.show === 'boolean' ? changes.show : shownAtFirst(g), keys };
}

/** Tells the game's page which buttons to draw, and whether they're up now. */
export function syncTouchButtons() {
  const win = frameOf()?.contentWindow;
  if (!win || !game) return;
  const { show, keys } = choicesFor(game);
  const known = keysFor(engine);
  // DOSBox takes its own number for a key; MAME's page presses the key by its code.
  const buttons = Object.keys(SLOTS).filter((slot) => keys[slot]).map((slot) => {
    const key = known.get(keys[slot]);
    return { slot, label: key.label, key: engine === 'mame' ? keys[slot] : key.dosbox };
  });
  win.postMessage({ source: 'app', type: 'touch-buttons', buttons, show: show && !isTyping() }, location.origin);
}

/**
 * The game that's starting, if it can have on-screen buttons (a DOS or arcade game, on a phone),
 * or null, with what runs it and, for an arcade version, its controls ({ buttons, lightgun }).
 * The bar's Buttons button is offered for it.
 */
export function offerTouchButtons(g, { engine: runs = 'dosbox', controls = null } = {}) {
  game = g && onPhone() ? g : null;
  engine = runs;
  arcade = controls;
  els.button.hidden = !game;
  if (!game) closeTouchEditor();
}

/** Keeps a change to the game's buttons: only what differs from the defaults is stored. */
function keep({ show, keys }) {
  const changes = {};
  if (show !== shownAtFirst(game)) changes.show = show;
  const defaults = defaultKeys();
  const changedKeys = Object.fromEntries(Object.entries(keys).filter(([slot, code]) => code !== defaults[slot]));
  if (Object.keys(changedKeys).length) changes.keys = changedKeys;
  setTouchButtons(game.id, Object.keys(changes).length ? changes : null);
  syncTouchButtons();
  // The sheet is drawn again, and the focus stays on the control that made the change.
  const focused = document.activeElement?.dataset?.control;
  render();
  const again = focused && els.editor.querySelector(`[data-control="${focused}"]:not(:disabled)`);
  (again || $('#touch-title', els.editor))?.focus({ preventScroll: true });
}

const options = () => [
  h('option', { value: '' }, 'No button'),
  ...groupsFor(engine).map(([group, keys]) => h('optgroup', { label: group }, ...keys.map(([code, name]) => h('option', { value: code }, name)))),
];

/** The sheet, filled in with the game's buttons as they are now. */
function render() {
  if (!game) return;
  const choices = choicesFor(game);
  const defaults = defaultKeys();
  const picker = (slot) => {
    const select = h('select', {
      class: `touch-key${choices.keys[slot] !== defaults[slot] ? ' is-changed' : ''}`,
      'aria-label': SLOTS[slot],
      dataset: { control: slot },
      onchange: (e) => keep({ ...choices, keys: { ...choices.keys, [slot]: e.target.value } }),
    }, options());
    select.value = choices.keys[slot];
    return select;
  };
  // A small drawing of the group in the middle of its pickers.
  const figure = (d) => h('span', { class: 'touch-figure', 'aria-hidden': 'true' },
    new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${d}</svg>`, 'image/svg+xml').documentElement);
  const changed = Boolean(touchButtonChanges(game.id));

  els.editor.replaceChildren(h('div', { class: 'touch-sheet' },
    h('div', { class: 'touch-head' },
      h('h2', { id: 'touch-title', tabindex: '-1' }, 'On-screen buttons'),
      h('button', { type: 'button', class: 'player-button', onclick: () => closeTouchEditor() }, 'Done')),
    h('p', { class: 'touch-intro' }, 'The key each button presses in ', h('strong', {}, game.title), '. Kept for this game only.'),
    h('label', { class: 'setting' },
      h('input', { type: 'checkbox', checked: choices.show, dataset: { control: 'show' }, onchange: (e) => keep({ ...choices, show: e.target.checked }) }),
      h('span', {}, 'Show on-screen buttons in this game')),
    h('div', { class: 'touch-groups', inert: !choices.show },
      h('fieldset', { class: 'touch-group' }, h('legend', {}, 'D-pad'),
        h('div', { class: 'touch-cross touch-dpad' }, picker('up'), picker('left'), picker('right'), picker('down'),
          figure('<path fill="currentColor" d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z"/>'))),
      h('fieldset', { class: 'touch-group' }, h('legend', {}, 'Round buttons'),
        h('div', { class: 'touch-cross touch-face' }, picker('y'), picker('x'), picker('b'), picker('a'),
          figure('<g fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="5" r="3"/><circle cx="5" cy="12" r="3"/><circle cx="19" cy="12" r="3"/><circle cx="12" cy="19" r="3"/></g>'))),
      h('fieldset', { class: 'touch-group' }, h('legend', {}, 'Middle buttons'),
        h('div', { class: 'touch-pair' }, picker('select'), picker('start'))),
      h('fieldset', { class: 'touch-group' }, h('legend', {}, 'Shoulder buttons'),
        h('div', { class: 'touch-pair' }, picker('l'), picker('r')))),
    h('div', { class: 'touch-foot' },
      h('button', {
        type: 'button',
        class: 'player-button',
        disabled: !changed,
        dataset: { control: 'reset' },
        onclick: () => keep({ show: shownAtFirst(game), keys: { ...defaults } }),
      }, 'Back to the defaults'))));
}

export function openTouchEditor() {
  if (!game) return;
  returnFocus = document.activeElement;
  render();
  els.editor.hidden = false;
  els.button.setAttribute('aria-expanded', 'true');
  $('#touch-title', els.editor)?.focus({ preventScroll: true });
}

export function closeTouchEditor() {
  if (els.editor.hidden) return;
  els.editor.hidden = true;
  els.editor.replaceChildren();
  els.button.setAttribute('aria-expanded', 'false');
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}

export function wireTouchButtons(frame) {
  frameOf = frame;
  // The buttons go while the phone's keyboard is up, and come back when it goes.
  document.addEventListener('player:typing', syncTouchButtons);
  els.editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTouchEditor();
  });
  // A tap outside the sheet closes it.
  els.editor.addEventListener('click', (e) => { if (e.target === els.editor) closeTouchEditor(); });
}
