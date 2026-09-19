// Small shared helpers: DOM building, API calls, formatting, notifications.

export const $ = (sel, root = document) => root.querySelector(sel);

/** Creates an element: h('a', { href, class, onclick }, ...children). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Calls the server API; rejects with the server's error message. */
export async function api(path, { method = 'GET', body, keepalive } = {}) {
  // keepalive lets a request outlive the page, for a save sent as the tab closes.
  const init = { method, headers: {}, keepalive };
  if (method !== 'GET') init.headers['X-Requested-With'] = 'RetroGameBrowser';
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, init);
  // An error answer that isn't JSON (a proxy's 502 page) still gives an error. A success whose
  // body doesn't parse (the connection dropped partway) is an error too, not an empty answer.
  const unreadable = {};
  const data = await res.json().catch(() => unreadable);
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  if (data === unreadable) throw new Error('The server\'s answer was cut short');
  return data;
}

/**
 * A line-drawn icon from a path, in the current colour: the sidebar's rows, the filter chips
 * and the shelf heading all draw theirs this way. h() only builds HTML elements, so the SVG
 * is put together by hand.
 */
export function lineIcon(d, cls = 'ui-icon') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

export const imageUrl = (id, type, n = 0, w) =>
  `/api/games/${id}/images/${encodeURIComponent(type)}/${n}${w ? `?w=${w}` : ''}`;

export const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export const sortKey = (g) => fold(g.sortTitle || g.title).replace(/^(the|a|an)\s+/, '');
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const count = (n) => n.toLocaleString('en-US');

// LaunchBox spells its platforms out in full, which is too long to sit under a shelf tile or
// in a filter menu. Platforms not named here keep the name LaunchBox gives them.
const SHORT_PLATFORMS = {
  'Nintendo Entertainment System': 'NES',
  'Super Nintendo Entertainment System': 'SNES',
  'Nintendo 64': 'N64',
  'Sony Playstation': 'PlayStation',
  'Sega Genesis': 'Genesis',
  'NEC TurboGrafx-16': 'TurboGrafx-16',
  'SNK Neo Geo AES': 'Neo Geo',
  'Commodore 64': 'C64',
  'Windows 3x': 'Windows 3.x',
};

/** A platform's name as it fits under a tile: "Super Nintendo Entertainment System" -> "SNES". */
export const shortPlatform = (name) => SHORT_PLATFORMS[name] ?? name;

// LaunchBox files games under 90-odd genres, most of them a broad name and a sub-genre after a
// slash ("Sports / Soccer", "Board Game / Chess"). A menu that long is no use for browsing, so
// the shelf files each game under the broad name: a game's page still shows what LaunchBox says.
//
// The rules, in order: an exact name below, else the part before the first " / ", else the
// alias below. Everything else keeps its name.

// Whole names that don't follow from their first part: a beat 'em up isn't filed under Fighting.
const GENRE_EXACT = {
  'Fighting / Beat \'em Up': 'Beat \'em Up',
};

// Broad names that say the same thing as one already in the list, or that no one would look
// under ("Construction and Management Simulation").
const GENRE_ALIASES = {
  'Racing & Driving': 'Racing',
  Driving: 'Racing',
  'Paddle & Pong': 'Pong',
  Paddle: 'Pong',
  Board: 'Board Game',            // "Board / Party Game"
  'Construction and Management Simulation': 'Simulation',
  'Vehicle Simulation': 'Simulation',
  'Life Simulation': 'Simulation',
  'Text-Based': 'Interactive Fiction',
  Application: 'App',
  Screensaver: 'App',
};

/** One LaunchBox genre as the shelf files it: "Sports / Soccer" -> "Sports". */
export function broadGenre(genre) {
  if (GENRE_EXACT[genre]) return GENRE_EXACT[genre];
  const broad = genre.split(' / ')[0].trim();
  return GENRE_ALIASES[broad] ?? broad;
}

/**
 * A game's genres as the shelf files it, without repeats (a game marked "Sports" and
 * "Sports / Soccer" is filed under Sports once). Worked out once per game record.
 */
export function genresOf(g) {
  return (g._genres ??= [...new Set((g.genres ?? []).map(broadGenre))]);
}

// The kind of every version of a game says whether it ever came out in English and whether
// it's a finished release. Both come from the region tags in console ROM names (see
// server/lib/emulatorjs.js); computer versions are classified by media instead, so neither
// flag is ever set for one.
const PRERELEASE = 'Beta, demo or prototype';
const NON_ENGLISH = new Set(['Japan', 'Other regions']);

/**
 * Whether LaunchBox says more than one person can play a game. Its number of players decides it
 * wherever it has one — a game it seats at 1 isn't multiplayer however its play modes are
 * marked, and the handful marked that way don't hold up. Only a game with no number at all
 * falls back to the modes, and a few hundred are marked Multiplayer without a count.
 */
export const isMultiplayer = (g) => (g.maxPlayers > 0
  ? g.maxPlayers > 1
  : (g.playModes ?? []).some((m) => m === 'Multiplayer' || m === 'Cooperative'));

/** The platforms eXo's collections fill, where network play is marked by eXo setting a game up for it. */
const EXO_PLATFORMS = new Set(['MS-DOS', 'Windows 3x', 'Windows 9x']);

/**
 * A DOS or Windows game LaunchBox counts as multiplayer that can't be played over the network
 * here: one where people take turns or share the keyboard, or any Windows 9x game, which the
 * server never marks (the browser's DOSBox-X has no network). The Multiplayer menu's 2+ and 3+ leave
 * these out unless the owner says otherwise on the admin page (see SEATS in js/shelf.js).
 */
export const withoutNetworkPlay = (g) => EXO_PLATFORMS.has(g.platform) && !g.ipx && isMultiplayer(g);

/** A game's { prerelease, nonEnglish }, worked out once per game record. */
export function gameFlags(g) {
  if (!g._flags) {
    const kinds = g.versions.map((v) => v.kind);
    const main = kinds.filter((k) => k !== PRERELEASE);
    g._flags = {
      prerelease: kinds.length > 0 && main.length === 0,
      nonEnglish: main.length > 0 && main.every((k) => NON_ENGLISH.has(k)),
    };
  }
  return g._flags;
}

/**
 * A game's play count and last-played date with the plays counted in this app added: the
 * library carries LaunchBox's (for its owner), the settings carry this app's for whoever is
 * signed in. The dates carry different time zone offsets, so they're compared as times.
 */
export function mergePlays({ playCount = 0, lastPlayed = null } = {}, ours = null) {
  if (!ours) return { playCount: playCount ?? 0, lastPlayed: lastPlayed ?? null };
  const theirs = Date.parse(lastPlayed ?? '');
  const mine = Date.parse(ours.lastPlayed ?? '');
  return {
    playCount: (playCount ?? 0) + (Number(ours.playCount) || 0),
    lastPlayed: Number.isNaN(mine) || mine < theirs ? lastPlayed : ours.lastPlayed,
  };
}

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  // LaunchBox stores year-only dates as Dec 31 or Jan 1.
  if (!m || (m === 12 && d === 31) || (m === 1 && d === 1)) return String(y);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatDuration(seconds) {
  if (!seconds) return '';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return hrs ? `${hrs} h ${mins} min` : `${mins} min`;
}

let noticeTimer = 0;
/** Shows a short message at the bottom of the screen. tone: '' | 'error'. */
export function notify(text, tone = '', ms = 5000) {
  const el = $('#notice');
  clearTimeout(noticeTimer);
  el.textContent = text;
  el.className = `notice${tone ? ` is-${tone}` : ''}`;
  el.hidden = false;
  noticeTimer = setTimeout(() => { el.hidden = true; }, ms);
}
