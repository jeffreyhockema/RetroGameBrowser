// The shelf's filter chips: a small button that opens a panel of choices under it. One
// pattern covers the platforms, genres and years (tick any number) and the sort order (pick
// one). Chips stay small while they're off, and say what they're holding when they're on.

import { h, count, lineIcon } from './util.js';

const chips = new Set();

/**
 * Builds a filter chip.
 * @param {object} o
 * @param {string} o.label      the name on the button ("Year")
 * @param {string} [o.icon]     an SVG path drawn before the name (see util.lineIcon)
 * @param {boolean} [o.multi]   tick any number of choices rather than pick one
 * @param {number} [o.columns]  lay the choices out in this many columns (years do)
 * @param {boolean} [o.clearable]  offer "Clear"; off for a chip that always holds a value
 * @param {boolean} [o.plainGroups] group headings are only headings, with no box that ticks the group
 * @param {(value) => void} o.onChange  called with the new value: a Set for multi, else a string
 * @returns {{ el: HTMLElement, setOptions(list): void, get(): Set<string>|string, set(v): void }}
 */
export function chip({ label, icon, multi = true, columns = 1, clearable = true, plainGroups = false, onChange }) {
  const name = h('span', { class: 'chip-name' }, label);
  const shown = h('span', { class: 'chip-value' });
  const button = h('button', {
    type: 'button', class: 'chip', 'aria-expanded': 'false', 'aria-haspopup': 'true',
    onclick: () => toggle(panel.hidden),
  }, icon ? lineIcon(icon, 'chip-icon') : null, name, shown, h('span', { class: 'chip-caret', 'aria-hidden': 'true' }, '▾'));
  const body = h('div', { class: `chip-body${columns > 1 ? ' is-grid' : ''}` });
  const clear = h('button', { type: 'button', class: 'link-button chip-clear', onclick: () => commit(multi ? new Set() : '') }, 'Clear');
  const panel = h('div', { class: 'chip-panel', hidden: true }, body, h('div', { class: 'chip-foot' }, clear));
  const el = h('div', { class: 'chip-wrap' }, button, panel);

  let options = [];                       // [{ value, label, chipLabel, note, group }]
  let value = multi ? new Set() : '';
  let stale = true; // the panel's rows are out of date (built only while it's open)
  const has = (v) => (multi ? value.has(v) : value === v);

  const me = { el, setOptions, get: () => (multi ? new Set(value) : value), set };
  chips.add(me);

  function setOptions(list) {
    options = list;
    // Drop picks that aren't on offer any more (another filter narrowed the shelf).
    const known = new Set(list.flatMap((o) => [o.value, o.flip?.value]).filter(Boolean));
    if (multi) value = new Set([...value].filter((v) => known.has(v)));
    else if (value && !known.has(value)) value = '';
    render();
  }

  /** Sets the chip's value without calling back — used when the page URL says what it is. */
  function set(v) {
    value = multi ? new Set(v) : (v ?? '');
    render();
  }

  function commit(next) {
    value = next;
    render();
    onChange(me.get());
  }

  function pick(v, on) {
    if (!multi) {
      commit(v);
      toggle(false);
      button.focus();
      return;
    }
    const next = new Set(value);
    if (on) next.add(v); else next.delete(v);
    commit(next);
  }

  /** The options in order, gathered under their group ("1990s"); [['', items]] when ungrouped. */
  function groupsOf(list) {
    const groups = new Map();
    for (const o of list) groups.set(o.group ?? '', [...(groups.get(o.group ?? '') ?? []), o]);
    return [...groups];
  }

  function render() {
    const chosen = multi ? [...value] : (value ? [value] : []);
    // On the button, not the wrap around it: .chip.is-on in app.css is what turns it teal.
    button.classList.toggle('is-on', chosen.length > 0);
    clear.hidden = !clearable || chosen.length === 0;
    shown.textContent = !chosen.length ? ''
      : chosen.length === 1 ? labelOf(chosen[0])
      : `${chosen.length} chosen`;
    // A closed panel's rows aren't built at all: the counts change with every letter typed in
    // the search, and hundreds of rows nobody can see would be made each time. Opening it
    // builds them then (see toggle).
    stale = panel.hidden;
    if (stale) return;
    // The counts follow the other filters, so an open panel is rebuilt as you type elsewhere.
    // Whoever was on a box keeps it.
    const focused = panel.contains(document.activeElement) ? document.activeElement.dataset.at : null;
    body.replaceChildren(...groupsOf(options).flatMap(([group, items]) => [
      group ? groupHead(group, items) : null,
      ...items.map(choice),
    ].filter(Boolean)));
    if (focused) panel.querySelector(`[data-at="${CSS.escape(focused)}"]`)?.focus();
  }

  // What the chip says it holds: a choice's own label, or a longer one for a row that leans on
  // the heading above it in the menu ("Yes" under Online).
  const labelOf = (v) => {
    const o = [...options, ...options.map((x) => x.flip).filter(Boolean)].find((x) => x.value === v);
    return o?.chipLabel ?? o?.label ?? v;
  };

  /** A group heading: for multi chips a box that ticks the whole decade or category at once. */
  function groupHead(group, items) {
    if (!multi || plainGroups) return h('p', { class: 'chip-group' }, group);
    const values = items.map((o) => o.value);
    const on = values.filter(has).length;
    const total = items.reduce((n, o) => n + (o.note ?? 0), 0);
    const box = h('input', {
      type: 'checkbox',
      dataset: { at: `group:${group}` },
      checked: on === values.length,
      onchange: (e) => {
        const next = new Set(value);
        for (const v of values) if (e.target.checked) next.add(v); else next.delete(v);
        commit(next);
      },
    });
    box.indeterminate = on > 0 && on < values.length;
    return h('label', { class: `chip-group${total ? '' : ' is-zero'}` }, box, h('span', {}, group),
      items.some((o) => o.note != null) ? h('span', { class: 'chip-choice-note' }, count(total)) : null);
  }

  function choice(o) {
    // A choice with an opposite (the sort orders) stands for both, and shows whichever way
    // round it's in: "Newest first" turned over is the same row reading "Oldest first".
    const turned = o.flip && has(o.flip.value);
    const now = turned ? o.flip : o;
    const other = turned ? o : o.flip;
    const input = h('input', {
      type: multi ? 'checkbox' : 'radio',
      name: multi ? null : `chip-${label}`,
      dataset: { at: o.value },
      checked: has(now.value),
      onchange: (e) => pick(now.value, e.target.checked),
    });
    // Nothing matches this one with the other filters as they are: still there, still tickable,
    // just faded, so the menu doesn't rearrange itself under the pointer.
    const row = h('label', { class: `chip-choice${o.note === 0 ? ' is-zero' : ''}` }, input,
      h('span', { class: 'chip-choice-name' }, now.label),
      o.note != null ? h('span', { class: 'chip-choice-note' }, count(o.note)) : null);
    if (!other) return row;
    return h('div', { class: 'chip-choice-pair' }, row, h('button', {
      type: 'button',
      class: 'chip-flip',
      title: `The other way round: ${other.label}`,
      'aria-label': `The other way round: ${other.label}`,
      onclick: () => pick(other.value, true),
    }, '⇅'));
  }

  function toggle(open) {
    if (open) for (const other of chips) if (other !== me) other.close();
    // A panel closed from the keyboard (Escape) would take the focus with it: it goes back to the chip.
    if (!open && !panel.hidden && panel.contains(document.activeElement)) button.focus({ preventScroll: true });
    panel.hidden = !open;
    if (open && stale) render();
    button.setAttribute('aria-expanded', String(open));
    if (open) panel.querySelector('input')?.focus();
  }

  me.close = () => toggle(false);
  me.isOpen = () => !panel.hidden;
  render();
  return me;
}

/** A toggle chip with no panel: Favorites only. */
export function toggleChip({ label, onChange }) {
  const shown = h('span', { class: 'chip-name' }, label);
  const el = h('button', { type: 'button', class: 'chip is-toggle', 'aria-pressed': 'false' },
    h('span', { class: 'chip-mark', 'aria-hidden': 'true' }, '★'), shown);
  let on = false;
  const render = () => {
    el.setAttribute('aria-pressed', String(on));
    el.classList.toggle('is-on', on);
  };
  el.addEventListener('click', () => { on = !on; render(); onChange(on); });
  return {
    el,
    get: () => on,
    set: (v) => { on = Boolean(v); render(); },
    setLabel: (text) => { shown.textContent = text; },
    close: () => {},
    isOpen: () => false,
  };
}

/** Closes every open panel. Returns whether one was open. */
export function closeChips() {
  let closed = false;
  for (const c of chips) if (c.isOpen()) { c.close(); closed = true; }
  return closed;
}

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.chip-wrap')) closeChips();
});
