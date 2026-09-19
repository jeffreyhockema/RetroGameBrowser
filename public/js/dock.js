// The details dock along the bottom: the game clicked on the shelf to select it. Nothing is
// selected to begin with and the dock isn't there at all, so the shelf has the screen to
// itself until a game is picked. Three parts: the picture box (the game's video where it has
// one, then its screenshots, with arrows under it to step between them), what the game is with
// Play, Details and Favorite, and a table of facts, which gives way on a narrow screen where
// the first two matter more.
//
// A game's description and its extras (manual, hint books, maps…) are on its own page: prose
// has no fixed shape, and a strip this size needs content that does.

import { $, h, imageUrl, plural, count, formatBytes, shortPlatform, genresOf } from './util.js';
import { isFavorite, setFavorite, defaultShelfVersion, keepsPlays } from './settings.js';
import { playDefault, isPlaying } from './player.js';
import { state } from './state.js';

const els = {
  dock: $('#dock'),
  shot: $('#dock-shot'),
  main: $('#dock-main'),
  facts: $('#dock-facts'),
};

let shown = null;   // the game in the dock
let pinned = false; // a game is selected, which is the only time the dock is there at all
let shotIndex = 0;  // which of the picture box's items is up
let video = null;   // the <video> in the picture box, while one is playing
let stage = null;   // the box around it, kept so a redraw of the same game doesn't restart it
// Sound stays off until it's asked for, and then stays on for the games picked after this one:
// a shelf that talked back at every game picked would be unusable.
let videoSound = false;

/** Brings the dock up for the game just selected, which is when its video plays. */
export function pinDock(g) {
  pinned = Boolean(g);
  els.dock.classList.toggle('is-pinned', pinned);
  if (g) {
    shotIndex = 0; // back to the front of the box, where the video is
    draw(g);
  }
}

/** Takes the dock away again: nothing is selected, so there's nothing for it to show. */
export function unpinDock() {
  pinned = false;
  els.dock.classList.remove('is-pinned');
  stopVideo();
}

/**
 * Stops the video the dock is playing. A <video> taken out of the page carries on playing, and
 * so does one under a game page or a game, where the dock is hidden rather than emptied.
 */
export function stopVideo() {
  if (video) {
    video.pause();
    // A paused video still downloads the rest of itself (preload is "auto"), which on a phone
    // through the tunnel is data spent on a video nobody is watching. The dock makes a new one
    // when it's drawn again.
    video.removeAttribute('src');
    video.load();
  }
  video = null;
  stage = null;
}

/**
 * Draws the docked game again after something about it changed (its favorite mark). Only while
 * the dock is up on the shelf: a draw starts the game's video, which would play unseen under a
 * game page or in a dock that's been put away. Bringing the dock back draws it afresh anyway.
 */
export function redrawDock(id) {
  if (shown?.id === id && pinned && state.view === 'shelf' && !isPlaying()) draw(shown);
}

const SVG = {
  play: '<path d="M8 5v14l11-7z"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z"/>',
  more: '<path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  prev: '<path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  next: '<path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  muted: '<path d="M11 5 6.5 9H3v6h3.5L11 19zM16 9.5l5 5m0-5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  sound: '<path d="M11 5 6.5 9H3v6h3.5L11 19zM15.5 9a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
};

/** A button with an icon before its text (h() only builds HTML, so the icon goes in as markup). */
function iconButton(kind, text, attrs) {
  const btn = h('button', { type: 'button', ...attrs });
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${SVG[kind]}</svg>`;
  if (text) btn.append(h('span', {}, text));
  return btn;
}

/**
 * What the picture box can show, in order: the game's gameplay video, then its screenshots.
 */
function stageItems(g) {
  const shots = g.shots ?? (g.preview ? 1 : 0);
  const items = Array.from({ length: shots }, (_, n) => ({ shot: n }));
  if (g.videos > 0) items.unshift({ video: 0 });
  return items;
}

function draw(g) {
  if (shown !== g) shotIndex = 0;
  shown = g;
  // Whoever was on one of the dock's buttons keeps it: they're all built afresh below.
  const refocus = els.dock.contains(document.activeElement) ? document.activeElement.dataset.focus : null;

  // The video or a screenshot, with arrows to step through the rest. The arrows and the count
  // are there for a single picture too (1 / 1, the arrows off) and hold their room with no
  // picture at all: the picture stays the same size from game to game, and the browser's
  // link-address tip in the window's corner comes up over them rather than over the picture.
  const items = stageItems(g);
  const single = items.length < 2;
  shotIndex = items.length ? Math.min(shotIndex, items.length - 1) : 0;
  const item = items[shotIndex];
  // A video already playing for this game is kept, so a redraw (its favorite mark changed,
  // say) doesn't start it over.
  const playing = item?.video != null && video?.dataset.game === g.id && video.dataset.n === String(item.video);
  if (!playing) stopVideo();
  els.shot.replaceChildren(...[
    !item ? h('span', { class: 'dock-shot is-empty' })
      : item.video != null ? (playing ? stage : videoStage(g, item.video))
      : h('img', { class: 'dock-shot', src: imageUrl(g.id, g.preview, item.shot, 480), alt: '' }),
    h('div', { class: 'dock-shot-nav', hidden: !items.length },
      iconButton('prev', '', { class: 'dock-shot-step', 'aria-label': 'Previous picture', dataset: { focus: 'prev' }, disabled: single, onclick: () => stepShot(-1) }),
      h('span', { class: 'dock-shot-count' }, `${shotIndex + 1} / ${items.length}`),
      iconButton('next', '', { class: 'dock-shot-step', 'aria-label': 'Next picture', dataset: { focus: 'next' }, disabled: single, onclick: () => stepShot(1) })),
  ].filter(Boolean));

  const fav = isFavorite(g);
  const version = defaultShelfVersion(g);
  const versions = g.versions?.length ?? 0;
  els.main.replaceChildren(
    // In a box of their own so a phone can put the words beside the picture and the buttons
    // across the whole dock under both.
    h('div', { class: 'dock-info' }, ...[
      h('p', { class: 'dock-title' }, g.title),
      h('p', { class: 'dock-meta' }, ...separated([g.year, shortPlatform(g.platform), g.developer])),
      g.communityRating > 0 ? ratingLine(g) : null,
      genresOf(g).length ? h('p', { class: 'dock-chips' }, genresOf(g).map((x) => h('span', { class: 'dock-chip' }, x))) : null,
      g.webBroken ? h('p', { class: 'dock-warning' }, 'Doesn\'t run in the browser yet') : null,
    ].filter(Boolean)),
    h('div', { class: 'dock-actions' },
      versions && state.can.play ? iconButton('play', 'Play', { class: 'dock-play', dataset: { focus: 'play' }, onclick: () => playDefault(g) }) : null,
      iconButton('more', 'Details', { class: 'dock-button', dataset: { focus: 'details' }, onclick: () => document.dispatchEvent(new CustomEvent('game:open', { detail: { id: g.id } })) }),
      // Just the star: the game's own page has the button with words on it.
      iconButton('star', '', {
        class: 'dock-button dock-fav is-icon', 'aria-pressed': String(fav),
        'aria-label': fav ? `Remove ${g.title} from favorites` : `Add ${g.title} to favorites`,
        title: fav ? 'Favorite' : 'Add to favorites',
        dataset: { focus: 'fav' },
        onclick: () => setFavorite(g, !isFavorite(g)),
      })));

  // The year, platform and developer are in the line under the title already.
  const rows = [
    ['Publisher', g.publisher],
    ['Players', playersText(g)],
    [versions === 1 ? 'Version' : 'Versions', versionsText(versions, version)],
    ['Size', sizeText(version)],
    // Always there, so the row doesn't come and go as the pointer moves along a shelf.
    ['Played', keepsPlays() ? playedText(g) : ''],
  ].filter(([, v]) => v);
  els.facts.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]));
  if (refocus) els.dock.querySelector(`[data-focus="${refocus}"]`)?.focus({ preventScroll: true });
}

/**
 * The game's gameplay video, playing without sound. Clicking it (or the badge in its corner)
 * turns the sound on, and it stays on for the games picked after this one.
 */
function videoStage(g, n) {
  const badge = iconButton(videoSound ? 'sound' : 'muted', '', { class: 'dock-sound', dataset: { focus: 'sound' } });
  const el = h('video', {
    class: 'dock-shot',
    src: `/api/games/${g.id}/videos/${n}`,
    dataset: { game: g.id, n: String(n) },
    autoplay: true,
    loop: true,
    playsinline: true,
    preload: 'auto',
  });
  // The attribute alone doesn't mute an element built here, and an unmuted video won't autoplay.
  el.muted = !videoSound;
  el.volume = 0.6;
  const mark = () => {
    badge.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${SVG[el.muted ? 'muted' : 'sound']}</svg>`;
    badge.setAttribute('aria-pressed', String(!el.muted));
    badge.title = el.muted ? 'Sound off — click for sound' : 'Sound on';
  };
  const toggle = () => {
    videoSound = el.muted;
    el.muted = !videoSound;
    mark();
    if (el.paused) el.play().catch(() => {});
  };
  el.addEventListener('click', toggle);
  badge.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  // A browser that won't autoplay even muted leaves the first frame up, which is no worse than
  // the screenshot it stands in front of; the arrows still reach the screenshots.
  el.play().catch(() => {});
  mark();
  video = el;
  stage = h('div', { class: 'dock-stage' }, el, badge);
  return stage;
}

/**
 * Parts with a thin divider between them: "1990 | MS-DOS | The Kremlin". Each part is kept in
 * one piece, so a line too long for a narrow dock breaks at a divider, not inside "Windows 3.x".
 */
const separated = (parts) => parts.filter(Boolean)
  .flatMap((p, i) => [
    i ? h('span', { class: 'dock-sep', 'aria-hidden': 'true' }, '|') : null,
    h('span', { class: 'dock-part' }, String(p)),
  ].filter(Boolean));

function stepShot(delta) {
  if (!shown) return;
  const n = stageItems(shown).length;
  if (n < 2) return;
  shotIndex = (shotIndex + delta + n) % n;
  draw(shown);
}

/** Five stars filled to the score, the score, and how many people gave it. */
function ratingLine(g) {
  const rating = g.communityRating;
  const stars = h('span', { class: 'stars', role: 'img', 'aria-label': `${rating.toFixed(1)} out of 5` },
    h('span', { class: 'stars-fill', 'aria-hidden': 'true' }, '★★★★★'));
  stars.style.setProperty('--fill', `${Math.min(100, (rating / 5) * 100)}%`);
  return h('p', { class: 'dock-rating' }, stars, h('span', { class: 'dock-score' }, rating.toFixed(1)),
    g.communityVotes > 0 ? h('span', { class: 'dock-votes' }, `(${plural(g.communityVotes, 'rating')})`) : null);
}

/** "3 available, plays CD DOS", or the kind alone when there's only one. */
function versionsText(n, version) {
  if (!n) return '';
  const kind = version && version.kind !== 'Other' ? version.kind : '';
  if (n === 1) return kind || 'One';
  return kind ? `${count(n)} available, plays ${kind}` : `${count(n)} available`;
}

/**
 * What the browser has to load before the game starts. A CD game the server hasn't unpacked
 * yet is only known packed, and it's sent unpacked and bigger by an amount that depends on
 * the game; those get a "+" rather than a guess at the multiplier.
 */
function sizeText(version) {
  if (!(version?.bytes > 0)) return '';
  return `${formatBytes(version.bytes)}${version.packed ? '+' : ''}`;
}

/** "Up to 4, co-op", or "1" for a game one person plays. */
function playersText(g) {
  const seats = g.maxPlayers > 1 ? `Up to ${g.maxPlayers}` : '';
  const modes = (g.playModes ?? [])
    .filter((m) => m !== 'Single Player' && !(seats && m === 'Multiplayer'))
    .map((m) => (m === 'Cooperative' ? 'co-op' : m.toLowerCase()));
  return [seats, ...modes].filter(Boolean).join(', ') || (g.playModes?.length ? '1' : '');
}

const TIMES = ['', 'Once', 'Twice'];

/** "Twice, Mar 2024" — LaunchBox's play history and this app's together, or "Never". */
function playedText(g) {
  if (!g.playCount) return 'Never';
  return [TIMES[g.playCount] ?? plural(g.playCount, 'time'), monthYear(g.lastPlayed)].filter(Boolean).join(', ');
}

function monthYear(iso) {
  const time = Date.parse(iso ?? '');
  return Number.isNaN(time) ? '' : new Date(time).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/** Empties the dock and takes it away, e.g. when the library is loaded again. */
export function resetDock() {
  stopVideo();
  shown = null;
  unpinDock();
  els.shot.replaceChildren();
  els.main.replaceChildren();
  els.facts.replaceChildren();
}

export function wireDock() {
  // Keep the page clear of the dock whatever its height; a dock that isn't there takes none,
  // so the shelf can run to the bottom of the screen. The height goes to the elements that
  // use it rather than the root: as a property nothing inherits (see app.css), a change to it
  // costs those few a restyle rather than every element in the page. The sidebar uses it
  // where the dock runs under it too, just wider than the sidebar first appears.
  const users = [document.body, $('#notice'), $('#sidebar')];
  new ResizeObserver(([entry]) => {
    const height = `${Math.ceil(entry.borderBoxSize[0].blockSize)}px`;
    for (const el of users) el.style.setProperty('--dock-height', height);
  }).observe(els.dock);

  document.addEventListener('favorite:changed', (e) => redrawDock(e.detail.id));
  // The x in the corner does what Escape does: nothing selected, so no dock.
  $('#dock-close').addEventListener('click', () => document.dispatchEvent(new CustomEvent('game:deselect')));
  resetDock();
}
