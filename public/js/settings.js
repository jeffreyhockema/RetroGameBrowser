// The profile menu at the top right: who's signed in (or a way to sign in), the two filters
// anyone can change for themselves, each player's controller layout in console games, the
// admin page for the owner, and signing out. What the shelf shows everyone else by default is
// the owner's, set on the admin page. Also the three things this app remembers per game: which
// games are favorites, which version Play starts, and a DOS game's on-screen buttons on a phone.
// A signed-in account's settings live on the server, so they follow it to every device; someone
// who isn't signed in keeps them in this browser instead.

import { $, h, api, count, notify, gameFlags } from './util.js';
import { state } from './state.js';

const listeners = new Set();
/** Registers a callback for when settings change. It's given the settings that changed. */
export const onSettingsChange = (fn) => listeners.add(fn);

// The shelf's hides anyone can change for themselves (the owner sets the rest for everyone, on
// the admin page). The help line is filled in with how many games each one is holding back.
const PERSONAL = [
  ['showNonEnglish', (g) => gameFlags(g).nonEnglish],
  ['showBroken', (g) => g.webBroken],
];

const els = {
  button: $('#profile-button'),
  menu: $('#profile-menu'),
  status: $('#settings-status'),
  controllers: $('#controllers-dialog'),
};

/**
 * Loads who's signed in, what they may do, and their settings. Returns the plays this app has
 * counted for them (game id -> { playCount, lastPlayed }), which the library doesn't carry.
 */
export async function loadSettings() {
  // Each on its own: one failing (a tunnel hiccup, say) doesn't lose the other's answer. A
  // failure that may pass is tried again a couple of times first.
  const [me, res] = await Promise.all([retried(() => api('/me')).catch(() => null), retried(() => api('/settings')).catch(() => null)]);
  accessUnknown = !me;
  if (me) {
    state.auth = me.auth ?? state.auth;
    state.user = me.user ?? null;
    state.can = me.can ?? state.can;
    state.server = me.server ?? null; // the owner's switches for the whole server
  } else {
    // Without /me the page offers browsing only, as state starts out; a reload asks again.
    notify('Couldn\'t check who\'s signed in. Reload the page to try again.', 'error', 10000);
  }
  // Without /settings the defaults stand, with whatever this browser kept on top of them.
  applyResponse(res ?? { settings: state.settings });
  return res?.plays ?? {};
}

/** A request tried up to three times while it fails in a way that may pass (no answer, busy, a server error). */
function retried(request, tries = 3) {
  return request().catch((err) => {
    if (tries <= 1 || (err.status && err.status !== 429 && err.status < 500)) throw err;
    return new Promise((resolve) => { setTimeout(resolve, 1000); }).then(() => retried(request, tries - 1));
  });
}

/**
 * Whether plays are counted for whoever this is: an account that can play (or the owner,
 * everyone where there are no accounts). Someone playing on the local network without signing
 * in has no account to count them for, so no Recently played and no play counts.
 */
export const keepsPlays = () => state.can.play && (state.can.owner || Boolean(state.user));

// Where someone who isn't signed in keeps the shelf's filters (the one about games that don't
// run in the browser only for someone who can play, on the local network).
const LOCAL_KEY = 'rgb-filters';
// Not the owner and not signed in: someone not signed in on a server with accounts, or someone
// from the internet on one without, including a guest the owner has let play. The server keeps
// nothing for them.
// When /me couldn't be asked the page offers only browsing, but it may well be the owner's or an
// account's: nothing is laid over or kept in this browser then, and saves go to the server,
// which knows who it is (and refuses someone it keeps nothing for).
let accessUnknown = false;
export const accessKnown = () => !accessUnknown;
const keepsLocally = () => !accessUnknown && !state.can.owner && !state.user;
const localFlags = () => (state.can.play ? ['showNonEnglish', 'showBroken'] : ['showNonEnglish']);

function applyResponse(res) {
  state.settings = res.settings;
  if (keepsLocally()) {
    try {
      const saved = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}');
      // Only the changes to the owner's defaults are kept, so a default changed since shows here too.
      for (const flag of localFlags()) if (typeof saved.filters?.[flag] === 'boolean') state.settings[flag] = saved.filters[flag];
      // Someone playing on the local network picks versions too, and how the gamepad's buttons work.
      if (state.can.play && saved.gameDefaults && typeof saved.gameDefaults === 'object') state.settings.gameDefaults = { ...saved.gameDefaults };
      if (state.can.play && validLayouts(saved.controllerLayouts)) state.settings.controllerLayouts = [...saved.controllerLayouts];
      if (state.can.play && saved.touchButtons && typeof saved.touchButtons === 'object') state.settings.touchButtons = { ...saved.touchButtons };
      // A guest the owner has let in marks favorites, kept here since there's no account.
      if (state.can.favorites && saved.favorites && typeof saved.favorites === 'object') state.settings.favorites = { ...saved.favorites };
    } catch {
      // Nothing saved, or storage turned off: the defaults stand.
    }
  }
}

// ---------- Versions ----------

/**
 * A game's versions, best first: preferred kind, then (for releases of the same game) the
 * bigger one, then the launcher's own order. The order of kinds is fixed (see
 * server/lib/versionkind.js); a game page can override it for one game with setGameDefault.
 * Some LaunchBox entries bundle different games (the five Blackwell episodes); those keep
 * their order instead of going by size.
 */
export function rankVersions(versions = []) {
  const order = state.settings.versionOrder ?? [];
  const rank = (v) => {
    const i = order.indexOf(v.kind?.key);
    return i === -1 ? order.length : i;
  };
  const baseId = (v) => (v.gameId ?? '').split(':').pop().replace(/_enh$/, '');
  const index = new Map(versions.map((v, i) => [v, i]));
  return [...versions].sort((a, b) => rank(a) - rank(b)
    || (baseId(a) && baseId(a) === baseId(b) ? (b.totalBytes ?? 0) - (a.totalBytes ?? 0) : 0)
    || index.get(a) - index.get(b));
}

/** The best-ranked version that works in the browser, ignoring any per-game choice. */
export function preferredVersion(versions = []) {
  return rankVersions(versions).find((v) => !v.knownIssue) ?? null;
}

/** The version Play starts for a game: the one set as its default, else the best-ranked one. */
export function defaultVersion(game) {
  const chosen = state.settings.gameDefaults?.[game.id];
  return game.webVersions?.find((v) => v.id === chosen) ?? preferredVersion(game.webVersions);
}

/** Whether the game's default was picked for this game (rather than coming from the ranking). */
export const hasGameDefault = (game) => Boolean(game.webVersions?.some((v) => v.id === state.settings.gameDefaults?.[game.id]));

/** Makes a version this game's default; null goes back to the usual order. */
export function setGameDefault(gameId, versionId) {
  const gameDefaults = { ...state.settings.gameDefaults };
  if (versionId) gameDefaults[gameId] = versionId;
  else delete gameDefaults[gameId];
  state.settings = { ...state.settings, gameDefaults };
  save({ gameDefaults: { [gameId]: versionId ?? null } });
}

/**
 * The version Play would start for a game on the shelf, from the short records the game list
 * carries ({ id, kind, bytes, broken }). Same answer as defaultVersion() above: the one set as
 * this game's default, else the best-ranked one that works. It ranks by kind and then by size,
 * where the game page can also fall back to the launcher's order for the handful of LaunchBox
 * entries that bundle several games.
 */
export function defaultShelfVersion(game) {
  const versions = game.versions ?? [];
  if (!versions.length) return null;
  const chosen = versions.find((v) => v.id === state.settings.gameDefaults?.[game.id]);
  if (chosen) return chosen;
  const order = state.settings.versionOrder ?? [];
  const rank = (v) => { const i = order.indexOf(v.kind); return i === -1 ? order.length : i; };
  const ranked = [...versions].sort((a, b) => rank(a) - rank(b) || (b.bytes ?? 0) - (a.bytes ?? 0));
  return ranked.find((v) => !v.broken) ?? ranked[0];
}

// ---------- Favorites ----------

/**
 * Whether a game is a favorite: what was marked here, else the mark it has in LaunchBox.
 * LaunchBox is only ever read, so a favorite added here is kept in this app's own settings.
 */
export const isFavorite = (game) => state.settings.favorites?.[game.id] ?? Boolean(game.favorite);

/** Marks or unmarks a game. Agreeing with LaunchBox again drops the note kept here. */
/** The changes made to a DOS game's on-screen buttons ({ show, keys }, see js/touchbuttons.js), or null. */
export const touchButtonChanges = (gameId) => state.settings.touchButtons?.[gameId] ?? null;

/** Keeps a game's on-screen buttons; null goes back to the defaults. */
export function setTouchButtons(gameId, changes) {
  const touchButtons = { ...state.settings.touchButtons };
  if (changes) touchButtons[gameId] = changes;
  else delete touchButtons[gameId];
  state.settings = { ...state.settings, touchButtons };
  save({ touchButtons: { [gameId]: changes ?? null } });
}

export function setFavorite(game, on) {
  const favorites = { ...state.settings.favorites };
  const sameAsLaunchBox = Boolean(game.favorite) === on;
  if (sameAsLaunchBox) delete favorites[game.id];
  else favorites[game.id] = on;
  state.settings = { ...state.settings, favorites };
  save({ favorites: { [game.id]: sameAsLaunchBox ? null : on } });
  // The tile, the dock and the game page all show the mark; each listens for this.
  document.dispatchEvent(new CustomEvent('favorite:changed', { detail: { id: game.id, on } }));
}

// ---------- Menu ----------

export function isOpen() {
  return !els.menu.hidden && !els.menu.classList.contains('is-primed');
}

/**
 * Signed out on a server with accounts, the menu is laid out while it's closed, unseen and out
 * of reach (see .is-primed in app.css), so Google's sign-in button in it is drawn ahead of time:
 * Google swaps its stand-in for the real button only once it's on screen, which would otherwise
 * happen just after the menu opens. A closed menu is otherwise simply hidden.
 */
const primes = () => Boolean(state.auth.clientId) && !state.user && accessKnown();

function prime() {
  renderMenu();
  els.menu.classList.add('is-primed');
  els.menu.inert = true;
  els.menu.hidden = false;
}

/** Opens or closes the profile menu. `refocus` puts the focus back on its button as it closes. */
export function toggleMenu(open = !isOpen(), { refocus = false } = {}) {
  els.button.setAttribute('aria-expanded', String(open));
  if (open) {
    els.menu.classList.remove('is-primed');
    els.menu.inert = false;
    els.menu.hidden = false;
    renderMenu();
    [...els.menu.querySelectorAll('input, button, a')].find((el) => el.offsetParent)?.focus();
    return;
  }
  if (primes()) {
    els.menu.classList.add('is-primed');
    els.menu.inert = true;
  } else {
    els.menu.hidden = true;
  }
  if (refocus) els.button.focus();
}

/** What's in the menu follows who's asking: see each part below. */
function renderMenu() {
  // Hiding games that don't run in the browser only means something to someone who can play.
  $('#setting-group-show-broken').hidden = !state.can.play;
  for (const [setting, test] of PERSONAL) {
    $(`#setting-${dashed(setting)}`).checked = Boolean(state.settings[setting]);
    const n = state.games.filter(test).length;
    $(`#setting-${dashed(setting)}-count`).textContent = n ? `${count(n)} in the library` : 'None in the library';
  }
  $('#open-controllers').hidden = !state.can.play;
  $('#open-admin').hidden = !state.can.admin;
  $('#sign-out').hidden = !state.user;
  $('#open-password').hidden = !state.user?.local;
  $('#profile-links').hidden = !state.can.play && !state.can.owner && !state.user;
  renderHead();
}

/** The button: the account's picture, else its initial, else a figure for someone not signed in. */
function renderButton() {
  const { user } = state;
  const label = user ? `Account: ${user.name || user.email}` : 'Account and preferences';
  els.button.setAttribute('aria-label', label);
  els.button.title = label;
  els.button.classList.toggle('is-signed-in', Boolean(user));
  if (!user) return;
  const initial = () => h('span', { class: 'profile-initial', 'aria-hidden': 'true' }, (user.name || user.email).trim()[0]?.toUpperCase() ?? '?');
  if (!user.picture) {
    els.button.replaceChildren(initial());
    return;
  }
  const img = h('img', { class: 'profile-avatar', src: user.picture, alt: '', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(initial()));
  els.button.replaceChildren(img);
}

// ---------- Controllers ----------

const PLAYERS = 4;
const LAYOUTS = [1, 2];
const validLayouts = (layouts) => Array.isArray(layouts) && layouts.length === PLAYERS && layouts.every((n) => LAYOUTS.includes(n));

/** Players 1-4's controller layouts in console games (see public/player/emulatorjs-fixes.js): 1 or 2 each. */
export const controllerLayouts = () => (validLayouts(state.settings.controllerLayouts) ? [...state.settings.controllerLayouts] : Array(PLAYERS).fill(1));

/** A row for each player with its two layouts, made once. Only for someone who can play. */
function buildControllers() {
  const rows = Array.from({ length: PLAYERS }, (_, player) => h('div', { class: 'layout-row', role: 'radiogroup', 'aria-labelledby': `layout-player-${player}` },
    h('span', { class: 'layout-player', id: `layout-player-${player}` }, `Player ${player + 1}`),
    h('div', { class: 'layout-switch' }, ...LAYOUTS.map((layout) => h('label', {},
      h('input', {
        type: 'radio',
        class: 'visually-hidden',
        name: `controller-layout-${player}`,
        value: String(layout),
        onchange: () => setControllerLayout(player, layout),
      }),
      h('span', {}, `Controller Layout ${layout}`))))));
  $('#controller-layouts').replaceChildren(...rows);
}

function renderControllers() {
  controllerLayouts().forEach((layout, player) => {
    for (const radio of document.querySelectorAll(`input[name="controller-layout-${player}"]`)) radio.checked = Number(radio.value) === layout;
  });
}

function setControllerLayout(player, layout) {
  const layouts = controllerLayouts();
  layouts[player] = layout;
  state.settings = { ...state.settings, controllerLayouts: layouts };
  save({ controllerLayouts: layouts });
  renderControllers();
}

// ---------- Signing in ----------

/**
 * The top of the menu: who's signed in, or the ways to sign in: Google's button, a username and
 * password (a local account, see server/lib/localusers.js), or both. On a server with no
 * accounts there's nobody to be, so it just says what the menu holds.
 */
function renderHead() {
  const head = $('#profile-head');
  if (state.user) {
    const { name, email, picture, local, username } = state.user;
    head.replaceChildren(
      picture ? h('img', { class: 'profile-head-avatar', src: picture, alt: '', referrerpolicy: 'no-referrer' }) : '',
      h('div', { class: 'profile-who' },
        h('p', { class: 'profile-name' }, name || username || email),
        local ? h('p', { class: 'profile-email' }, username) : name ? h('p', { class: 'profile-email' }, email) : null));
    return;
  }
  if (!state.auth.enabled) {
    head.replaceChildren(h('p', { class: 'profile-name' }, 'Preferences'));
    return;
  }
  // Drawn once: drawing it again would start Google's button over, and lose what's typed.
  if (head.querySelector('.profile-signin')) return;
  const google = state.auth.clientId ? h('div', { class: 'login-google' }) : null;
  // A key in a white circle, as Google's button has its G. (Markup: h() makes HTML elements, not SVG.)
  const key = h('span', { class: 'local-signin-mark', 'aria-hidden': 'true' });
  key.innerHTML = '<svg viewBox="0 0 24 24"><path fill="none" stroke="#1f1f1f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M14.5 9.5a4 4 0 1 1-2.2 3.6L4 21.4V18h2.5v-2.5H9l2.1-2.1M16.5 7.5h.01"/></svg>';
  head.replaceChildren(h('div', { class: 'profile-who profile-signin' },
    h('p', { class: 'profile-name' }, 'Not signed in'),
    h('p', { class: 'profile-email wraps' }, 'Sign in to keep your own favorites.'),
    google,
    // The same size and shape as Google's button, so the two sit together.
    state.auth.local ? h('button', { type: 'button', class: 'local-signin-button', onclick: openLocalDialog }, key, h('span', {}, 'Sign in with Local Account')) : null));
  if (google) showGoogleButton(google, 'large');
}

/** The popup for signing in with a local account (or making one, where the owner allows it). */
function openLocalDialog() {
  toggleMenu(false);
  renderLocalForm('signin');
  $('#local-dialog').showModal();
  $('#local-signin input')?.focus();
}

/**
 * The username and password form, for signing in (`signin`) or, where the owner allows it,
 * making an account (`signup`). Either one reloads the page once it's done, since what the page
 * offers depends on who's signed in.
 */
function renderLocalForm(mode) {
  const holder = $('#local-signin');
  const signup = mode === 'signup';
  $('#local-title').textContent = signup ? 'Create an account' : 'Sign in';
  const error = h('p', { class: 'form-error', role: 'alert' });
  const field = (label, attrs) => h('label', { class: 'field' }, h('span', {}, label), h('input', attrs));
  const form = h('form', {
    class: 'local-form',
    onsubmit: async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      if (signup && data.password !== data.again) {
        error.textContent = 'The two passwords aren\'t the same.';
        return;
      }
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      error.textContent = '';
      try {
        await api(signup ? '/auth/local/signup' : '/auth/local/signin', { method: 'POST', body: { username: data.username, password: data.password, ...(signup && { name: data.name }) } });
        notify(signup ? 'Account made. Signing in…' : 'Signing in…');
        location.reload();
      } catch (err) {
        error.textContent = err.message;
        submit.disabled = false;
        form.querySelector('input[name="password"]').select();
      }
    },
  },
  field('Username', { name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, maxlength: 32 }),
  signup ? field('Name (optional)', { name: 'name', autocomplete: 'nickname', maxlength: 100 }) : null,
  field('Password', { name: 'password', type: 'password', autocomplete: signup ? 'new-password' : 'current-password', required: true, ...(signup && { minlength: 8 }) }),
  signup ? field('Password again', { name: 'again', type: 'password', autocomplete: 'new-password', required: true, minlength: 8 }) : null,
  error,
  h('div', { class: 'form-row' },
    h('button', { type: 'submit', class: 'form-submit' }, signup ? 'Create account' : 'Sign in'),
    state.auth.localSignup ? h('button', { type: 'button', class: 'link-button', onclick: () => { renderLocalForm(signup ? 'signin' : 'signup'); holder.querySelector('input')?.focus(); } },
      signup ? 'I have an account' : 'Create an account') : null));
  holder.replaceChildren(form);
}

/** A local account's password: the current one, and the new one twice. */
function openPasswordDialog() {
  const dialog = $('#password-dialog');
  const form = $('#password-form');
  form.reset();
  $('#password-username').value = state.user?.username ?? '';
  $('#password-error').textContent = '';
  dialog.showModal();
}

async function changePassword(e) {
  e.preventDefault();
  const error = $('#password-error');
  const [current, password, again] = ['#password-current', '#password-new', '#password-again'].map((id) => $(id).value);
  if (password !== again) {
    error.textContent = 'The two new passwords aren\'t the same.';
    return;
  }
  const submit = e.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  error.textContent = '';
  try {
    await api('/auth/local/password', { method: 'POST', body: { current, password } });
    $('#password-dialog').close();
    notify('Password changed. Any other device you were signed in on will need it.');
  } catch (err) {
    error.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

let google = null;
/** Google's sign-in library, fetched the first time the button is wanted. */
function loadGoogle() {
  google ??= new Promise((resolve, reject) => {
    const script = h('script', { src: 'https://accounts.google.com/gsi/client', async: true });
    script.addEventListener('load', () => {
      window.google.accounts.id.initialize({ client_id: state.auth.clientId, callback: signIn, ux_mode: 'popup' });
      resolve(window.google);
    });
    script.addEventListener('error', () => { google = null; script.remove(); reject(new Error('Google\'s sign-in couldn\'t be loaded. Check the connection and try again.')); });
    document.head.append(script);
  });
  return google;
}

/**
 * Google's sign-in script, and the font its button's stand-in asks for (see fonts/inter.css): the
 * stand-in shows until Google's real button, in a frame of its own, takes its place, and with the
 * font here the two look the same.
 */
const googleReady = () => Promise.all([loadGoogle(), document.fonts.load('500 14px "Google Sans"').catch(() => {})]).then(([lib]) => lib);

async function showGoogleButton(holder, size) {
  try {
    const lib = await googleReady();
    // A width of its own: without one the stand-in fills the menu, then the button comes in narrower.
    lib.accounts.id.renderButton(holder, { theme: 'filled_black', size, shape: 'pill', text: 'signin_with', width: 240 });
  } catch (err) {
    holder.replaceChildren(h('p', { class: 'setting-help flush' }, err.message));
  }
}

/** Google's button hands over a token saying who signed in; the server makes a session of it. */
async function signIn({ credential }) {
  // Said on the page: the menu may have been closed by Google's popup.
  notify('Signing in…');
  try {
    await api('/auth/google', { method: 'POST', body: { credential } });
    // The library, the settings and what the page offers all depend on who's signed in.
    location.reload();
  } catch (err) {
    notify(`Couldn't sign in: ${err.message}`, 'error', 10000);
  }
}

async function signOut() {
  try {
    // Before the session ends, after which the server would turn the save down.
    await flushPending();
    await api('/auth/signout', { method: 'POST', body: {} });
    window.google?.accounts.id.disableAutoSelect();
  } finally {
    location.reload();
  }
}

const dashed = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

let saveTimer = 0;
let pending = {};
// Saves go to the server one at a time, so it applies them in the order they were made.
let saving = Promise.resolve();

// Settings that are a map of per-game notes: a save carries only what changed, so several
// changes in a row are merged rather than replacing one another.
const PARTIAL_MAPS = ['gameDefaults', 'favorites', 'touchButtons'];

/**
 * Stores a change. Every caller has already put it in state, so the page shows it at once;
 * the server gets the changes of the last 400 ms together.
 */
/** Two saves as one: `later`'s changes over `earlier`'s, the per-game maps merged entry by entry. */
function mergePatches(earlier, later) {
  const merged = { ...earlier, ...later };
  for (const key of PARTIAL_MAPS) {
    if (earlier[key] || later[key]) merged[key] = { ...earlier[key], ...later[key] };
  }
  return merged;
}

function save(patch) {
  pending = mergePatches(pending, patch);
  listeners.forEach((fn) => fn(patch));
  clearTimeout(saveTimer);
  // Not signed in on a server with accounts: the filters stay in this browser.
  if (keepsLocally()) {
    pending = {};
    try {
      // Merged into what's kept rather than replacing it: what this visitor can't use right now
      // (a guest's favorites, once the owner's guest access has ended) is left for next time.
      let kept = {};
      try {
        kept = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}') ?? {};
      } catch {
        // Nothing readable kept: start afresh.
      }
      // Only where it differs from the owner's default, as the server keeps it for an account.
      const filters = { ...kept.filters };
      for (const flag of localFlags()) {
        if (Boolean(state.settings[flag]) === Boolean(state.settings.filterDefaults?.[flag])) delete filters[flag];
        else filters[flag] = Boolean(state.settings[flag]);
      }
      const local = { ...kept, filters };
      if (state.can.play) {
        local.gameDefaults = state.settings.gameDefaults ?? {};
        local.controllerLayouts = controllerLayouts();
        local.touchButtons = state.settings.touchButtons ?? {};
      }
      if (state.can.favorites) local.favorites = state.settings.favorites ?? {};
      localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
      els.status.textContent = 'Saved in this browser';
    } catch {
      els.status.textContent = 'Couldn\'t save in this browser';
    }
    return;
  }
  els.status.textContent = 'Saving…';
  saveTimer = setTimeout(() => { saving = saving.then(sendPending); }, 400);
}

/**
 * Sends what's waiting now instead of after the timer: the page is closing, or going to the
 * background, where a phone may close it without another word.
 */
function flushPending() {
  if (keepsLocally() || !Object.keys(pending).length) return saving;
  clearTimeout(saveTimer);
  saving = saving.then(() => sendPending({ keepalive: true }));
  return saving;
}

async function sendPending({ keepalive } = {}) {
  const body = pending;
  if (!Object.keys(body).length) return;
  pending = {};
  try {
    const res = await api('/settings', { method: 'PUT', body, keepalive });
    // A change made while this one was on its way is newer than the server's answer, and is
    // sent next. Taking the answer now would undo it on the page until then.
    if (Object.keys(pending).length) return;
    applyResponse(res);
    els.status.textContent = 'Saved';
  } catch (err) {
    // The page still shows the change, so it's kept to go with the next save, under anything
    // changed since; otherwise the server would never hear of it. Not a change the server
    // turned down, though, which would only be turned down again.
    if (!err.status || err.status === 429 || err.status >= 500) {
      pending = mergePatches(body, pending);
      // Tried again in a while, if nothing else is changed before then.
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { saving = saving.then(sendPending); }, 10000);
    } else if (err.status === 401) {
      // The session ended (signed out in another tab, say) while the page still shows the
      // change. The menu's status line is out of sight for a star pressed on the shelf.
      notify('You\'re signed out, so that change wasn\'t kept. Reload the page and sign in again.', 'error', 10000);
    }
    els.status.textContent = `Couldn't save: ${err.message}`;
  }
}

export function wireSettings() {
  els.button.addEventListener('click', () => toggleMenu());
  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && !e.target.closest('#profile-menu, #profile-button')) toggleMenu(false);
  });
  // Tabbing on past the menu closes it, as leaving any popup does.
  els.menu.addEventListener('focusout', (e) => {
    if (isOpen() && e.relatedTarget && !e.relatedTarget.closest('#profile-menu, #profile-button')) toggleMenu(false);
  });
  $('#sign-out').addEventListener('click', signOut);
  $('#open-password').addEventListener('click', () => {
    toggleMenu(false);
    openPasswordDialog();
  });
  $('#password-form').addEventListener('submit', changePassword);
  $('#password-close').addEventListener('click', () => $('#password-dialog').close());
  $('#password-dialog').addEventListener('close', () => els.button.focus());
  $('#local-close').addEventListener('click', () => $('#local-dialog').close());
  $('#local-dialog').addEventListener('close', () => els.button.focus());
  $('#open-controllers').addEventListener('click', () => {
    toggleMenu(false);
    renderControllers();
    els.controllers.showModal();
  });
  $('#controllers-close').addEventListener('click', () => els.controllers.close());
  // Closed by Done or Esc: the focus goes back to the button it came from.
  els.controllers.addEventListener('close', () => els.button.focus());
  // A click on the backdrop, outside the dialog's own box, closes it too.
  els.controllers.addEventListener('click', (e) => { if (e.target === els.controllers) els.controllers.close(); });

  buildControllers();
  renderButton();
  // Signed out: Google's sign-in button is made ready in the page's spare moments (see prime).
  if (primes()) (window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500)))(() => { if (!isOpen()) prime(); });

  // A change made just before the tab closes or goes to the background is sent then, rather
  // than waiting on a timer the page may not live to see.
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushPending(); });
  window.addEventListener('pagehide', () => { flushPending(); });

  for (const [setting] of PERSONAL) {
    $(`#setting-${dashed(setting)}`).addEventListener('change', (e) => {
      state.settings = { ...state.settings, [setting]: e.target.checked };
      save({ [setting]: e.target.checked });
    });
  }
}
