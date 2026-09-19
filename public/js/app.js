// RetroGameBrowser: entry point. Loads the library, then routes between the shelf and game pages.

import { $, h, api, notify, mergePlays } from './util.js';
import { state } from './state.js';
import { loadSettings, wireSettings, onSettingsChange, isOpen as menuOpen, toggleMenu } from './settings.js';
import { readFiltersFromUrl, shelfHref, resetTiles, applyFilters, sortByTitle, ensureRendered, layoutShelf, resortShelf, wireFilters, wireShelfPictures, selectGame, clearFilters, randomGame, warmUp } from './shelf.js';
import { renderRoom, refreshVersions, refreshFacts, stopRoomMedia, closeLightbox, isLightboxOpen, stepLightbox, wireLightbox } from './room.js';
import { wirePlayer, isPlaying, leaveGame, playDefault, focusGame } from './player.js';
import { wireDock, resetDock, stopVideo } from './dock.js';
import { closeChips } from './filters.js';
import { getDetail, peekDetail, forgetDetail } from './details.js';

/**
 * How much room a scrollbar takes in this browser, measured the once while the page is still
 * empty and so costs nothing: 0 where scrollbars are drawn over the page (Firefox's default
 * here, and phones), and the bar's width where they take a strip of it (Chrome, Edge).
 */
const scrollbarRoom = (() => {
  const probe = h('div', { style: 'position:absolute;top:-200px;width:80px;height:80px;overflow-y:scroll' });
  document.body.append(probe);
  const room = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  // Said once on the page, while it's empty, for the rules that stop the window scrolling
  // under a game being played (see body.is-playing in app.css).
  document.body.classList.toggle('scrollbars-take-room', room > 0);
  return room;
})();

const els = {
  shelfView: $('#shelf-view'),
  gameView: $('#game-view'),
  notice: $('#notice'),
  shelf: $('#shelf'),
  empty: $('#empty'),
  count: $('#result-count'),
  q: $('#q'),
};

async function init() {
  // Right after the PC starts the server may need a minute to read the library.
  els.count.textContent = 'Loading the library…';
  const [library, plays] = await Promise.all([api('/library'), loadSettings()]);
  if (!library.platforms?.length) throw new Error('No platforms are loaded. Check "platforms" in the server config');
  // What the page offers follows what the account may do: stars for favorites, Play and
  // Download for playing (see app.css). Set before anything is drawn, so nothing is drawn twice.
  document.body.classList.toggle('can-favorites', state.can.favorites);
  document.body.classList.toggle('can-play', state.can.play);

  // Every platform's games on one shelf; the Platform filter narrows it from there. Each game
  // carries the platform it came from, which its tile and its page both show.
  state.platforms = library.platforms.map(({ name, category, logo, icon, about }) => ({ name, category, logo, icon, about }));
  state.games = sortByTitle(library.platforms.flatMap((p) => {
    for (const g of p.games) g.platform = p.name;
    return p.games;
  }));
  state.byId = new Map(state.games.map((g) => [g.id, g]));
  // The plays counted in this app for whoever is signed in, on top of what the library says.
  for (const [id, ours] of Object.entries(plays)) {
    const g = state.byId.get(id);
    if (g) Object.assign(g, mergePlays(g, ours));
  }

  wireSettings();
  wireFilters();
  wireShelfPictures();
  wirePlayer();
  wireLightbox();
  wireDock();
  wireEvents();

  readFiltersFromUrl();
  resetTiles();
  resetDock();
  route();
  // The search's index, in the browser's spare moments from here on.
  warmUp();
}

// ---------- Routing ----------

function route() {
  const m = /^\/game\/([\w-]+)/.exec(location.pathname);
  if (m) showGame(m[1]);
  else showShelf();
}

function navigate(path, historyState = null) {
  history.pushState(historyState, '', path);
  route();
}

// A game opened at random says so in its history entry, so its page offers the next one
// (and still does when Back or Forward returns to it).
const openGame = (g, { random = false } = {}) => navigate(`/game/${g.id}`, { fromShelf: state.view === 'shelf', random });

function goToShelf() {
  // Going back restores the shelf's filters; a game opened directly has nothing to go back to.
  if (history.state?.fromShelf) history.back();
  else navigate(shelfHref());
}

/**
 * Swaps what's on screen under a short cross-fade, where the browser can do one; `swap` must
 * change the page there and then. Anything else just swaps.
 */
function crossfade(swap) {
  if (!document.startViewTransition) return swap();
  document.startViewTransition(swap);
}

/**
 * A game page lies over the shelf rather than replacing it (see #game-view in app.css): the
 * shelf stays exactly as it is underneath, laid out and scrolled to where it was, so coming
 * back is a matter of lifting the page off rather than laying thousands of tiles out afresh.
 * Under the page the shelf is hidden from assistive technology, and a focus that lands on it
 * (Tab past the end of the page) is sent back to the page (see wireEvents). Not `inert`, which
 * would do both: Firefox restyles every element under it, which takes seconds with this many
 * tiles. Nothing else about the page changes, since anything that moved the shelf would have
 * it laid out again.
 */
function putShelfAway(away) {
  els.shelfView.setAttribute('aria-hidden', String(away));
  els.notice.classList.toggle('is-low', away);
  // The window stops scrolling while the page is over it, so the page's scrollbar is the only
  // one in sight (see body.is-game in app.css), and only where a scrollbar takes up room:
  // stopping it makes the browser lay the shelf out again, which Firefox spends a second over
  // with a big library, and where scrollbars are drawn over the page there's nothing to fix.
  document.body.classList.toggle('is-game', away && scrollbarRoom > 0);
}

function showShelf() {
  const wasGame = state.view === 'game';
  state.view = 'shelf';
  state.detail = null;
  stopRoomMedia();
  crossfade(() => {
    // Everything that changes the page comes first and everything that measures it after,
    // so the browser works the page out once rather than once per measurement.
    els.gameView.hidden = true;
    els.gameView.replaceChildren();
    putShelfAway(false);
    // The count, the heading and the page title all follow the filters.
    applyFilters();
    // The game you came from is selected, so the dock has it and Play is a click away.
    if (wasGame && state.byId.has(state.lastGameId)) selectGame(state.lastGameId);
    if (wasGame) {
      // The shelf puts its tiles in as they're needed; if its list was rebuilt meanwhile, the
      // ones down to where it was go in first, and the game's own tile when it's just past
      // them. The shelf never moved, so this is where it still is, unless the browser's Back
      // put it elsewhere.
      ensureRendered(state.shelfScroll + window.innerHeight, state.lastGameId);
      if (window.scrollY !== state.shelfScroll) window.scrollTo(0, state.shelfScroll);
    }
    // The window may have been resized while the shelf was away. After the scroll above, so
    // the place it keeps is the one just put back.
    layoutShelf();
    if (wasGame) {
      // The game's tile has the focus back, when it's on the screen: one further down would
      // send the next Tab far away from what's showing.
      const link = state.tiles.get(state.lastGameId)?.querySelector('a');
      const box = link?.isConnected ? link.getBoundingClientRect() : null;
      if (box && box.bottom > 0 && box.top < window.innerHeight) link.focus({ preventScroll: true });
    }
  });
}

async function showGame(id) {
  if (state.view === 'shelf') state.shelfScroll = window.scrollY;
  state.view = 'game';
  state.lastGameId = id;
  stopRoomMedia();
  // The dock is hidden under a game page rather than emptied, and its video would play on.
  stopVideo();
  const summary = state.byId.get(id);
  const stillWanted = () => state.view === 'game' && location.pathname.endsWith(id);
  const show = (...content) => {
    els.gameView.replaceChildren(...content);
    els.gameView.hidden = false;
    els.gameView.scrollTop = 0;
    putShelfAway(true);
    // The page scrolls on its own, so the keys that scroll (Space, Page Down…) need it focused.
    els.gameView.focus({ preventScroll: true });
  };
  const showPage = (game) => {
    // A page fade runs a moment later; the shelf may be back by then (Escape pressed at once).
    if (!stillWanted()) return;
    state.detail = game;
    document.title = game.title;
    show(renderRoom(game, { shelfHref: shelfHref(), random: Boolean(history.state?.random) }));
  };

  // The record is usually here already (fetched when the tile was rested on or selected), and
  // then the page goes straight up. Otherwise a "Loading…" holds its place, with no fade: the
  // page itself is what's worth fading in.
  const ready = peekDetail(id);
  if (ready) return crossfade(() => showPage(ready));

  show(h('p', { class: 'empty' }, summary ? `Loading ${summary.title}…` : 'Loading…'));
  try {
    const game = await getDetail(id);
    if (!stillWanted()) return;
    crossfade(() => showPage(game));
  } catch (err) {
    if (!stillWanted()) return;
    els.gameView.replaceChildren(h('p', { class: 'empty' }, `${err.message}. `,
      h('a', { href: '/', dataset: { back: '' } }, 'Back to the list')));
  }
}

// ---------- Events ----------

function wireEvents() {
  // The hides in the profile menu change which games the shelf can show at all, so it and its filter
  // menus are worked out again. The per-game version default changes game pages; nothing else
  // saved there (a favorite, controller layouts, touch buttons) changes Play or the versions
  // table, and rebuilding them would close an open Download menu.
  onSettingsChange((patch) => {
    if ('showBroken' in patch || 'showNonEnglish' in patch || 'showPrereleases' in patch || 'showNoImage' in patch || 'pcMultiplayerWithoutNetwork' in patch) applyFilters();
    if ('gameDefaults' in patch) refreshVersions();
  });

  // A tile clicked twice, or the dock's Details button, opens the game's page (see shelf.js).
  document.addEventListener('game:open', (e) => {
    const g = state.byId.get(e.detail.id);
    if (g) openGame(g);
  });

  // The dock's close button. Its focus would be lost with the dock, so it goes back to the
  // tile that was selected.
  document.addEventListener('game:deselect', () => {
    const tile = state.tiles.get(state.selectedId);
    const fromDock = document.activeElement?.closest?.('#dock');
    selectGame(null);
    if (fromDock) tile?.querySelector('a')?.focus({ preventScroll: true });
  });

  // The heading's Random Game, the sidebar's Random game row, and "Random Game" on a game
  // page: another of the games the shelf is showing, never the one already open.
  document.addEventListener('game:random', () => {
    const g = randomGame(state.view === 'game' ? state.lastGameId : null);
    if (g) openGame(g, { random: true });
    else notify('There\'s no other game on this shelf to jump to.');
  });

  // "Back to the list" links on game pages, and the logo (modified clicks keep the browser's
  // behaviour).
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-back], [data-back-home]');
    if (!link || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    // The logo goes home: every game, in title order, with nothing filtering it.
    if (link.hasAttribute('data-back-home')) {
      const wasGame = state.view === 'game';
      state.shelfScroll = 0;
      state.lastGameId = null;
      clearFilters();
      if (wasGame) route();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      goToShelf();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (isPlaying()) {
      // The game has the keyboard, unless the focus is on the app: a key that arrives here
      // while a game is playing means the game isn't listening, so hand it back. Tab and the
      // player bar's own buttons keep working for anyone using the keyboard to reach them.
      if (e.key !== 'Tab' && !document.activeElement?.closest?.('.player-bar, .touch-editor')) focusGame();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // A dialog (Controllers) closes itself on Esc, and has the keyboard until then.
    if (document.querySelector('dialog[open]')) return;
    if (menuOpen()) {
      if (e.key === 'Escape') toggleMenu(false, { refocus: true });
      return;
    }
    if (isLightboxOpen()) {
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowRight') stepLightbox(1);
      else if (e.key === 'ArrowLeft') stepLightbox(-1);
      return;
    }
    if (e.key === 'Escape' && closeChips()) return;
    if (e.target.closest('input, select, textarea')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === '/' && state.view === 'shelf') {
      e.preventDefault();
      els.q.focus();
    } else if (e.key === 'Escape' && state.view === 'game') {
      goToShelf();
    } else if (e.key === 'Escape' && state.selectedId) {
      selectGame(null);
    } else if (e.key.toLowerCase() === 'p' && !e.repeat) {
      // P plays: the game on this page, or the selected or focused game on the shelf.
      if (state.view === 'game') $('#play-panel .play-button')?.click();
      else {
        const g = state.byId.get(state.selectedId ?? document.activeElement?.closest?.('.tile a')?.dataset.id);
        if (g) playDefault(g);
      }
    }
  });

  // The shelf under a game page isn't for reaching: a focus that lands there goes to the page.
  els.shelfView.addEventListener('focusin', () => {
    if (state.view === 'game') els.gameView.focus();
  });

  document.addEventListener('player:opening', () => {
    stopRoomMedia();
    stopVideo();
    closeLightbox();
  });

  // A game played here: "Recently played" puts it first, and its page shows the new count.
  document.addEventListener('game:played', (e) => {
    if (state.detail?.id === e.detail.id) refreshFacts();
    forgetDetail(e.detail.id); // its play count is in its record, which is fetched afresh next time
    resortShelf();
  });

  window.addEventListener('popstate', () => {
    // leaveGame() already closed the player; this is just its history entry going away.
    if (state.skipNextPopstate) {
      state.skipNextPopstate = false;
      return;
    }
    closeLightbox();
    if (isPlaying()) {
      // The browser's Back button while playing leaves the game the way Leave game does,
      // storing a DOS game's files first. Its "playing" entry is already gone, so leaveGame()
      // doesn't step back again. A second Back while it saves moves to another page, which is
      // shown once the game has closed.
      if (!history.state?.playing) {
        const url = location.href;
        leaveGame().then(() => { if (location.href !== url && !isPlaying()) route(); });
      }
      return;
    }
    // Back and Forward move between game pages and the shelf, and carry the shelf's filters.
    if (!/^\/game\//.test(location.pathname)) readFiltersFromUrl();
    route();
  });
}

init().catch((err) => {
  els.shelf.replaceChildren();
  els.count.textContent = '';
  els.empty.hidden = false;
  els.empty.textContent = `The library didn't load: ${err.message}. Check that the server is running and can read the LaunchBox folder.`;
});
