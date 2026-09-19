// The shelf: box art grid with search, filter chips, a sidebar of quick lists and sorting.
// A library can hold tens of thousands of games, and putting that many tiles in the page is
// slow, so the grid gets its tiles a batch at a time as it's scrolled (and, with a mouse, the
// rest once typing stops).
//
// The sidebar moves between shelves and the chips narrow whichever one is open. A sidebar
// row starts afresh: it clears everything else and leaves only itself, so its count is always
// the number of games you land on. The chips then narrow that however you like. What the
// filters add up to names the page — one platform under its own logo, one genre, the
// favorites, a list — and goes in the address, so every shelf can be bookmarked and reloaded.
//
// Clicking a tile selects it: the dock at the bottom pins to it, with Play and a link to its
// page. Clicking it again opens the page.

import { $, h, imageUrl, fold, collator, sortKey, count, shortPlatform, gameFlags, genresOf, broadGenre, lineIcon, formatDate, isMultiplayer, withoutNetworkPlay } from './util.js';
import { state } from './state.js';
import { isFavorite, setFavorite, keepsPlays, accessKnown, defaultShelfVersion } from './settings.js';
import { chip, toggleChip } from './filters.js';
import { pinDock, unpinDock } from './dock.js';
import { prefetchDetail } from './details.js';

const els = {
  shelf: $('#shelf'),
  empty: $('#empty'),
  count: $('#result-count'),
  scopeHead: $('#scope-head'),
  q: $('#q'),
  chips: $('#chips'),
  chipsEnd: $('#chips-end'),
  scopeId: $('#scope-id'),
  scopeActions: $('#scope-actions'),
  scopeAbout: $('#scope-about'),
  sidebar: $('#sidebar'),
  sideLists: $('#side-lists'),
  sidePlatforms: $('#side-platforms'),
  sideGenres: $('#side-genres'),
};

/** A game's title sort key, worked out once per game. */
const titleKey = (g) => (g._sortKey ??= sortKey(g));
const byTitle = (a, b) => collator.compare(titleKey(a), titleKey(b)) || collator.compare(a.platform, b.platform);

/**
 * Puts the library's games in title order, the shelf's usual order, once when they load, so
 * the shelf only sorts again for the other orders.
 */
export const sortByTitle = (games) => games.sort(byTitle);

/**
 * Which of the shelf's hides are on, as a key for what's worked out from them. It takes in the
 * setting for what the Multiplayer menu counts as multiplayer too, which changes the sidebar's counts.
 */
const hidesKey = () => ['showBroken', 'showNonEnglish', 'showPrereleases', 'showNoImage', 'pcMultiplayerWithoutNetwork'].map((f) => state.settings[f]).join('/');

/** Games the shelf can show at all, before search and filters: the shelf's hides applied. */
export function shelfGames() {
  const { showBroken, showNonEnglish, showPrereleases, showNoImage } = state.settings;
  if (showBroken && showNonEnglish && showPrereleases && showNoImage) return state.games;
  return state.games.filter((g) => (showBroken || !g.webBroken)
    && (showNonEnglish || !gameFlags(g).nonEnglish)
    && (showPrereleases || !gameFlags(g).prerelease)
    && (showNoImage || g.cover));
}

// The other orders: a number per game, smallest first. Ties stay in title order, since the
// games are in title order and sorting keeps the order of equals. Dates are compared as
// times: LaunchBox's carry the time zone offset of when they were written. Every order comes
// both ways round (see SORTS); a game with nothing to go on — no year, no rating, never
// played — goes last either way rather than leading the list with a blank.
const LAST = Number.MAX_SAFE_INTEGER;
const SORT_KEYS = {
  year: (g) => g.year || LAST,
  '-year': (g) => -(g.year || 0),
  rating: (g) => g.communityRating || LAST,
  '-rating': (g) => -(g.communityRating || 0),
  played: (g) => Date.parse(g.lastPlayed ?? '') || LAST,
  '-played': (g) => -(Date.parse(g.lastPlayed ?? '') || 0),
  added: (g) => Date.parse(g.dateAdded ?? '') || LAST,
  '-added': (g) => -(Date.parse(g.dateAdded ?? '') || 0),
};

// The shelf's games in the chosen order, kept until the library, the shelf's hides or the
// order changes. Filtering keeps the order, so typing never sorts.
let sorted = null;

function sortedGames(order) {
  const { games } = state;
  const hides = hidesKey();
  if (sorted?.games !== games || sorted.hides !== hides || sorted.order !== order) {
    let list = shelfGames();
    const key = SORT_KEYS[order];
    if (key) {
      const keys = new Map(list.map((g) => [g, key(g)]));
      list = [...list].sort((a, b) => keys.get(a) - keys.get(b));
    } else if (order === '-title') {
      // Z to A: the games are already in title order, so this is that list backwards.
      list = [...list].reverse();
    }
    sorted = { games, hides, order, list };
  }
  return sorted.list;
}

/** Sorts and counts the shelf again, for when games' play dates changed (a game was played here). */
export function resortShelf() {
  sorted = null;
  totals = null;
  // A play is recorded as its game starts: rebuilding a long shelf then would hold up the start,
  // so it waits for the game to close.
  if (document.body.classList.contains('is-playing')) return afterPlaying('resort', resortShelf);
  applyFilters({ keepPlace: true });
}

const waitingForPlayer = new Set();
/** Runs `fn` once the game in front closes, however many times it's asked for meanwhile. */
function afterPlaying(key, fn) {
  if (waitingForPlayer.has(key)) return;
  waitingForPlayer.add(key);
  document.addEventListener('player:closed', () => {
    waitingForPlayer.delete(key);
    fn();
  }, { once: true });
}

// ---------- Icons ----------

// Line icons, drawn in the current colour: the sidebar's rows and the filter chips.
const ICONS = {
  all: 'M6 8h12a4 4 0 0 1 4 4v3a3 3 0 0 1-5.4 1.8L15.5 15h-7l-1.1 1.8A3 3 0 0 1 2 15v-3a4 4 0 0 1 4-4Zm1 2.5v3M5.5 12h3M16 11.5h.01M18 13.5h.01',
  fav: 'm12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z',
  recent: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm0 4v5l3 2',
  top: 'M7 4h10v3a5 5 0 0 1-10 0V4Zm10 1h3a3 3 0 0 1-3 4M7 5H4a3 3 0 0 0 3 4m5 3v4m-4 4h8',
  // Two people, for the Multiplayer row and the Multiplayer menu.
  players: 'M9 11.3a3.15 3.15 0 1 1 0-6.3 3.15 3.15 0 0 1 0 6.3Zm-5.5 8v-1c0-2.5 2.5-4.4 5.5-4.4s5.5 1.9 5.5 4.4v1M15.6 5.3a3.15 3.15 0 0 1 0 6m1.4 2.8c2 .6 3.5 2.2 3.5 4.2v1h-3',
  random: 'M3 7h3l9 10h6m0-10h-6l-2 2.2M3 17h3l2-2.2M18 4l3 3-3 3m0 4 3 3-3 3',
  computer: 'M3 5h18v11H3zM8 20h8m-4-4v4',
  console: 'M7 8h10a4 4 0 0 1 4 4v3a3 3 0 0 1-5.4 1.8L15 15H9l-.6 1.8A3 3 0 0 1 3 15v-3a4 4 0 0 1 4-4Zm1 2.5v3M6.5 12h3M16 11.5h.01M18 13.5h.01',
  genre: 'M4 5h16v14H4zM4 10h16M9 5v14',
  // The chips: a tag for genres, a calendar for years, bars for the sort order.
  tag: 'M4 4h7l9 9-7 7-9-9V4Zm3.5 3.5h.01',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4m8-4v4',
  sort: 'M4 7h12M4 12h8M4 17h4m8 0V8m0 0-3 3m3-3 3 3',
};

// One per genre, so a row is recognisable before it's read. Several genres share a glyph
// where they're close enough (Casino and Board Game both get dice); anything not named here
// keeps the plain `genre` icon.
const GENRE_ICONS = {
  bolt: 'M13 3 6 13.5h5L10 21l7-10.5h-5L13 3Z',
  compass: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm3.5 5.5-2 5-5 2 2-5 5-2Z',
  ball: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm-8.6 6h17.2M3.4 15h17.2M12 3c-3 5-3 13 0 18M12 3c3 5 3 13 0 18',
  crosshair: 'M12 3v4m0 10v4M3 12h4m10 0h4M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z',
  steps: 'M3 19h4v-4h4v-4h4V7h6',
  flag: 'M6 21V4m0 0h11l-2 4 2 4H6',
  blocks: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4z',
  cap: 'M12 4 2 9l10 5 10-5-10-5Zm-6 8.5V17c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4.5',
  shield: 'M12 3 5 6v6c0 4 3 7.4 7 9 4-1.6 7-5 7-9V6l-7-3Z',
  gauge: 'M3.5 18a8.5 8.5 0 1 1 17 0M12 14l4.5-4.5',
  wheel: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm0 5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Zm0-5v5M4.2 16.5l4.3-2.5m11.3 2.5-4.3-2.5',
  dice: 'M5 5h14v14H5zM9 9h.01M15 15h.01M12 12h.01',
  cards: 'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm5 4.5 2.5 4.5-2.5 4.5L9.5 12 12 7.5Z',
  burst: 'm12 3 2 5 5-2-2 5 5 2-5 2 2 5-5-2-2 5-2-5-5 2 2-5-5-2 5-2-2-5 5 2 2-5Z',
  text: 'M5 4h14v16H5zM8.5 8.5h7M8.5 12h7M8.5 15.5h4',
  plane: 'M12 3c.9 0 1.4.9 1.4 2.3V9l7.1 4v2l-7.1-2v4l2.4 2v1.5L12 19l-3.8 1.5V19l2.4-2v-4l-7.1 2v-2l7.1-4V5.3C10.6 3.9 11.1 3 12 3Z',
  joystick: 'M12 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm0 6v5m-5.5 7 1-5h9l1 5h-11Z',
  question: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm-2.6 6.2a2.7 2.7 0 1 1 3.6 2.6c-.6.2-1 .8-1 1.5v.5m0 3h.01',
  film: 'M4 4h16v16H4zM4 8.5h16M4 15.5h16M8.5 4v4.5m7-4.5v4.5M8.5 15.5V20m7-4.5V20',
  note: 'M9 17.5V6l10-2v11.5M9 17.5a2.8 2.8 0 1 1-5.5 0 2.8 2.8 0 0 1 5.5 0Zm10-2a2.8 2.8 0 1 1-5.5 0 2.8 2.8 0 0 1 5.5 0Z',
  paddle: 'M5 7v10M19 7v10M12 11.2a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z',
  pinball: 'M12 4a8 8 0 0 1 8 8v8H4v-8a8 8 0 0 1 8-8Zm-5 12.5 3 2.5m7-2.5-3 2.5M12 9.5a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Z',
  ghost: 'M12 3a7 7 0 0 1 7 7v11l-2.3-1.8L14.3 21 12 19.2 9.7 21l-2.4-1.8L5 21V10a7 7 0 0 1 7-7Zm-2.4 8h.01m5 0h.01',
  brush: 'M16 3.5 20.5 8l-9 9L7 12.5l9-9ZM7 12.5 4 20l7.5-3',
  magnifier: 'M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Zm10.5 3-4.8-4.8',
  eye: 'M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Zm9.5-2.3a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6ZM4.5 19.5l15-15',
  box: 'm12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9v9m-8-13.5 8 4.5 8-4.5',
  lock: 'M7.5 11V8a4.5 4.5 0 0 1 9 0v3M5 11h14v10H5z',
};

const GENRE_ICON_OF = {
  Action: 'bolt',
  Adventure: 'compass',
  Sports: 'ball',
  Shooter: 'crosshair',
  'First Person Shooter': 'crosshair',
  Platform: 'steps',
  Strategy: 'flag',
  Puzzle: 'blocks',
  Education: 'cap',
  'Role-Playing': 'shield',
  Simulation: 'gauge',
  Racing: 'wheel',
  'Board Game': 'dice',
  Casino: 'dice',
  Party: 'dice',
  Cards: 'cards',
  Fighting: 'burst',
  'Beat \'em Up': 'burst',
  Arcade: 'joystick',
  'Interactive Fiction': 'text',
  'Visual Novel': 'text',
  Reference: 'text',
  'Flight Simulator': 'plane',
  Quiz: 'question',
  'Game Show': 'question',
  'Interactive Movie': 'film',
  Music: 'note',
  Pong: 'paddle',
  Pinball: 'pinball',
  Horror: 'ghost',
  Creativity: 'brush',
  Detective: 'magnifier',
  Stealth: 'eye',
  Sandbox: 'box',
  Compilation: 'box',
  Demo: 'box',
  App: 'box',
  Adult: 'lock',
};

/** An inline icon by name, from either set. */
const icon = (kind) => lineIcon(ICONS[kind] ?? GENRE_ICONS[kind] ?? ICONS.genre, 'side-icon');

/** The icon for a genre: its own where it has one, else the plain genre mark. */
const genreIcon = (genre) => GENRE_ICON_OF[genre] ?? 'genre';

// ---------- Filter chips ----------

/**
 * The orders the shelf can be in, each with the same order backwards behind it (`flip`): the
 * menu shows one row per order, whichever way round it's in, and the row's ⇅ button turns it.
 * The values are what the address says, a leading "-" for the biggest or latest first.
 */
const SORTS = [
  { value: 'title', label: 'Title A–Z', flip: { value: '-title', label: 'Title Z–A' } },
  { value: '-year', label: 'Newest first', flip: { value: 'year', label: 'Oldest first' } },
  { value: '-rating', label: 'Top rated', flip: { value: 'rating', label: 'Lowest rated' } },
  { value: '-played', label: 'Recently played', flip: { value: 'played', label: 'Played longest ago' } },
  { value: '-added', label: 'Recently added', flip: { value: 'added', label: 'Added longest ago' } },
];

/** Every order, both ways round: what the sort in an address is checked against. */
const SORT_VALUES = new Set(SORTS.flatMap((s) => [s.value, s.flip.value]));

const onChange = () => { applyFilters(); rememberFilters(); };

const filters = {
  platform: chip({ label: 'Platform', icon: ICONS.console, onChange }),
  genre: chip({ label: 'Genre', icon: ICONS.tag, onChange }),
  year: chip({ label: 'Year', icon: ICONS.calendar, columns: 3, onChange }),
  // How many can play at once (Single Player, 2+ Players, 3+ Players; see SEATS below), and
  // whether they can play together online here (see ONLINE).
  players: chip({ label: 'Multiplayer', icon: ICONS.players, plainGroups: true, onChange }),
  fav: toggleChip({ label: 'Only Favorites', onChange }),
  sort: chip({ label: 'Sort', icon: ICONS.sort, multi: false, clearable: false, onChange }),
};

/** The chips that hold any number of choices: what the shelf counts, clears and remembers together. */
const MENU_KEYS = ['platform', 'genre', 'year', 'players'];

/**
 * Whether a game LaunchBox seats several at can go under 2+ and 3+: not a DOS or Windows game
 * without eXo's network play, unless the owner counts those too (admin page). Playing over the
 * network here means nothing to someone who can't play (the library doesn't say which games
 * can), so for them every game LaunchBox seats several at counts.
 */
const seatsFriends = (g) => !state.can.play || state.settings.pcMultiplayerWithoutNetwork || !withoutNetworkPlay(g);

/**
 * The Multiplayer menu's Players section, in the order it lists them. They're "at least" ranges, not exact
 * counts, so they overlap: a four-player game is under 2+ and 3+ alike, since someone picking a
 * game for two shouldn't have it kept back for seating more. Single Player is the other side of
 * LaunchBox's count — nothing says more than one can play. A DOS or Windows game with no network
 * play that LaunchBox seats several at is left out of 2+ and 3+ (see seatsFriends) without being
 * put under Single Player, so by default a few of those are under none of the three.
 *
 * 2+ on its own is the shelf the sidebar's Multiplayer row opens, under that name and at
 * /multiplayer (see currentScope): the row is a shortcut for this choice, the way a platform
 * or genre row is a shortcut for its own menu.
 */
const MULTI = '2+';
const MULTI_NOTE = 'Games more than one person can play';
const SEATS = [
  { value: '1', label: 'Single Player', test: (g) => !isMultiplayer(g) },
  { value: '2+', label: '2+ Players', test: (g) => isMultiplayer(g) && seatsFriends(g) },
  { value: '3+', label: '3+ Players', test: (g) => g.maxPlayers >= 3 && seatsFriends(g) },
];

/** How the version Play would start is played with friends here (see netplayModeOf in the server), or null. */
const netplayOf = (g) => defaultShelfVersion(g)?.netplay ?? null;

/**
 * The Multiplayer menu's other section: games more than one can play that can be played with
 * friends online here, each friend in their own browser. Either every player's game is kept in
 * step (the console and arcade games that can be, and DOS games over their own network play), or
 * the host's game is sent to the others as video, which runs a little behind for them. A game
 * that seats one isn't offered, although Play with a friend is on its page too. The menu's rows
 * say Yes under their Online heading; the chip, with no heading beside it, says Online.
 */
const IN_STEP = new Set(['rollback', 'lockstep', 'ipx']);
const ONLINE = [
  { value: 'friends', label: 'Yes', chipLabel: 'Online', test: (g) => isMultiplayer(g) && IN_STEP.has(netplayOf(g)) },
  { value: 'stream', label: 'Yes (Video Stream)', chipLabel: 'Online (Video Stream)', test: (g) => isMultiplayer(g) && netplayOf(g) === 'stream' },
];

/**
 * The Multiplayer menu's sections: how many can play, and playing online, which is only for an
 * account that may play games here. Ticks in one section widen it (2+ or 3+); ticks in both
 * narrow each other (2+ games you can play with friends).
 */
const multiplayerSections = () => [['Players', SEATS], ...(state.can.play ? [['Online', ONLINE]] : [])];

/** Whether a game is under the Multiplayer menu's ticks: under one of the ticked choices in every section that has any. */
function inMultiplayer(g, picks) {
  return multiplayerSections().every(([, choices]) => {
    const ticked = choices.filter((c) => picks.has(c.value));
    return !ticked.length || ticked.some((c) => c.test(g));
  });
}

/**
 * The lists in the sidebar that no filter chip stands for. Picking one sets the Sort chip to
 * the order that suits it, which can then be changed like any other time.
 */
const LISTS = {
  recent: {
    path: '/recent',
    title: 'Recently played',
    icon: 'recent',
    sort: '-played',
    test: (g) => g.playCount > 0,
    note: 'Games you\'ve played, latest first',
  },
  top: {
    path: '/top',
    title: 'Top rated',
    icon: 'top',
    sort: '-rating',
    test: (g) => g.communityRating >= 4 && g.communityVotes >= 3,
    note: 'Rated 4 stars or more by at least 3 people',
  },
};

let quickList = ''; // '' or a key of LISTS

/** Whether the account may have a list: Recently played is only for someone whose plays are counted. */
const listAllowed = (key) => key !== 'recent' || keepsPlays();

// Platforms whose logo file wouldn't load after all; their heading falls back to the name.
const noLogo = new Set();

const platformOf = (name) => state.platforms.find((p) => p.name === name);
const logoFor = (name) => (platformOf(name)?.logo && !noLogo.has(name) ? `/api/platforms/${encodeURIComponent(name)}/logo?w=640` : null);

/** The one value a chip is holding, or null when it's holding none or several. */
function only(which) {
  const chosen = filters[which].get();
  return chosen.size === 1 ? [...chosen][0] : null;
}

/**
 * What the filters add up to, which is what the heading shows and what the address says. A
 * list wins, then one platform (which has a logo of its own), then one genre, then the games
 * more than one person can play, then the favorites; anything else — none of those, or several
 * platforms at once — is the whole shelf with filters on it.
 */
export function currentScope() {
  if (LISTS[quickList]) return { kind: quickList, value: '' };
  const platform = only('platform');
  if (platform) return { kind: 'platform', value: platform };
  const genre = only('genre');
  if (genre) return { kind: 'genre', value: genre };
  if (only('players') === MULTI) return { kind: 'multi', value: '' };
  if (filters.fav.get()) return { kind: 'fav', value: '' };
  return { kind: 'all', value: '' };
}

/**
 * Whether the shelf is narrowed past what its scope names: a search, or any filter on top of
 * the one platform, genre or list, or the favorites, that the heading would be about (or, on
 * the whole shelf, any filter at all). The heading then says "Results" (see renderScopeHead).
 */
function narrowedPast({ kind }) {
  if (kind === 'all') return anyFilter();
  // The Multiplayer shelf is the Multiplayer menu holding 2+, so that menu is the one it's about.
  const own = LISTS[kind] ? 'list' : kind === 'multi' ? 'players' : kind;
  return Boolean(els.q.value.trim())
    || (own !== 'list' && Boolean(quickList))
    || (own !== 'fav' && filters.fav.get())
    || MENU_KEYS.some((key) => filters[key].get().size > (key === own ? 1 : 0));
}

/** The heading for a scope: what to call it, the icon or logo for it, and a line under it. */
function scopeLook({ kind, value }) {
  if (LISTS[kind]) return { title: LISTS[kind].title, icon: LISTS[kind].icon, note: LISTS[kind].note };
  if (kind === 'platform') {
    return {
      title: shortPlatform(value),
      icon: platformOf(value)?.category === 'Consoles' ? 'console' : 'computer',
      logo: logoFor(value),
    };
  }
  if (kind === 'genre') return { title: value, icon: genreIcon(value) };
  if (kind === 'multi') return { title: 'Multiplayer', icon: 'players', note: MULTI_NOTE };
  if (kind === 'fav') return { title: 'Favorites', icon: 'fav', note: 'Games you\'ve starred, here or in LaunchBox' };
  return { title: 'All games', icon: 'all' };
}

/**
 * The hairline down the sidebar's edge that stands in for its scrollbar (.side-scroll in
 * app.css): how far down the lists you are, and how much of them fits. It's a mark to read
 * rather than a bar to drag, so the wheel, the trackpad and the keyboard do the scrolling.
 */
function wireSideScroll() {
  const pane = els.sidebar;
  const line = h('div', { class: 'side-scroll', 'aria-hidden': 'true', hidden: true });
  pane.append(line);

  let queued = false;
  const measure = () => {
    queued = false;
    const view = pane.clientHeight;
    const room = pane.scrollHeight - view;
    // Nothing to point at while the whole list is already on screen.
    if (room < 2) return void (line.hidden = true);
    // As tall a share of the edge as the lists show of themselves, but never so short that
    // it reads as a dot rather than a line.
    const height = Math.max(28, Math.round((view * view) / pane.scrollHeight));
    line.style.setProperty('--side-scroll-top', `${Math.round((view - height) * (pane.scrollTop / room))}px`);
    line.style.setProperty('--side-scroll-height', `${height}px`);
    line.hidden = false;
  };
  // Scrolling fires far faster than the screen draws, so it's measured once a frame.
  const update = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(measure);
  };

  pane.addEventListener('scroll', update, { passive: true });
  // The pane's own height follows the window; the lists grow when a "more..." row opens or a
  // filter rewrites them. Watching all four covers both without renderSidebar having to say so.
  const watch = new ResizeObserver(update);
  watch.observe(pane);
  for (const list of pane.querySelectorAll('.side-list')) watch.observe(list);
  measure();
}

export function wireFilters() {
  wireSideScroll();
  // The menus, then Only Favorites and Sort together: when the toolbar runs out of room the
  // pair wraps as one, Only Favorites under the menus and Sort level with it at the far end.
  const { fav, sort, ...menus } = filters;
  els.chips.replaceChildren(...Object.values(menus).map((c) => c.el));
  els.chipsEnd.replaceChildren(fav.el, sort.el);
  // Without favorites of your own there's nothing to narrow to, and without plays nothing to
  // sort by when they happened.
  filters.fav.el.hidden = !state.can.favorites;
  filters.sort.setOptions(keepsPlays() ? SORTS : SORTS.filter((s) => s.value !== '-played'));
  filters.sort.set('title');

  // The long placeholder has nowhere to go on a phone, where the box is a couple of words wide.
  if (matchMedia('(max-width: 520px)').matches) els.q.placeholder = 'Search';

  let debounce = 0;
  els.q.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(onChange, 120);
  });
  $('#filters').addEventListener('submit', (e) => e.preventDefault());

  wireTiles();
}

/** Keeps the shelf's filters in the page address, so a reload and Back come back to them. */
const rememberFilters = () => history.replaceState(history.state, '', shelfHref());

/** The words in the search box, folded for matching; none when it's empty. */
const searchWords = () => fold(els.q.value.trim()).split(/\s+/).filter(Boolean);

/** The text a search looks through for a game: its title, other names, makers and series. */
const haystack = (g) => (g._haystack ??= fold([g.title, ...g.alternateNames, g.developer, g.publisher, ...g.series].join(' ')));

/** Whether every word of the search is somewhere in the game's haystack. */
const matchesWords = (g, words) => words.every((w) => haystack(g).includes(w));

/**
 * Works out every game's search text and genres in the browser's spare moments after the
 * library loads, so the first keystroke in the search box costs no more than the ones after.
 */
export function warmUp() {
  let i = 0;
  const step = (deadline) => {
    for (; i < state.games.length; i++) {
      if ((i & 255) === 0 && deadline.timeRemaining() < 3) return void whenIdle(step);
      haystack(state.games[i]);
      genresOf(state.games[i]);
    }
  };
  whenIdle(step);
}

/**
 * A test for the filters as they stand. The shelf itself is worked out in one pass by sift()
 * below, which also counts the menus; this is for the odd question asked of a single game.
 */
function matcher() {
  const words = searchWords();
  const platforms = filters.platform.get();
  const genres = filters.genre.get();
  const years = filters.year.get();
  const players = filters.players.get();
  const favOnly = filters.fav.get();
  const list = LISTS[quickList];
  return (g) => (!list || list.test(g))
    && (!favOnly || isFavorite(g))
    && (!platforms.size || platforms.has(g.platform))
    && (!genres.size || genresOf(g).some((genre) => genres.has(genre)))
    && (!years.size || years.has(String(g.year)))
    && (!players.size || inMultiplayer(g, players))
    && (!words.length || matchesWords(g, words));
}

/**
 * The shelf's games under the filters, and the count behind each entry of the Platform, Genre,
 * Year and Multiplayer menus, from one pass over the library: each filter is tried once per game and
 * the answers combined, rather than the whole set of filters run again for each menu.
 *
 * A menu's counts leave its own filter out, which is what makes them read as "how many would
 * this add": with 1991 ticked, the Platform menu counts the 1991 games on each platform rather
 * than only the ones already shown. The search box isn't a menu, so it always counts. Every
 * value the shelf holds is counted, whether or not anything matches: a menu whose entries came
 * and went as you ticked boxes would move under the pointer, and a ticked value that dropped
 * out would take the filter with it. Ones nothing matches show 0 and are dimmed instead.
 */
function sift(games) {
  const words = searchWords();
  const platforms = filters.platform.get();
  const genres = filters.genre.get();
  const years = filters.year.get();
  const players = filters.players.get();
  const favOnly = filters.fav.get();
  const list = LISTS[quickList];
  const sections = multiplayerSections().map(([, choices]) => choices);

  const platformCounts = new Map();
  const genreCounts = new Map();
  const yearCounts = new Map();
  const playerCounts = new Map();
  const bump = (counts, key, hit) => counts.set(key, (counts.get(key) ?? 0) + (hit ? 1 : 0));
  const shown = [];

  for (const g of games) {
    // The filters no menu leaves out: the list, the favorites and the search.
    const base = (!list || list.test(g)) && (!favOnly || isFavorite(g)) && (!words.length || matchesWords(g, words));
    const onPlatform = !platforms.size || platforms.has(g.platform);
    const ofGenres = genresOf(g);
    const inGenre = !genres.size || ofGenres.some((genre) => genres.has(genre));
    const inYear = !years.size || years.has(String(g.year));
    // The Multiplayer choices overlap (the Players ranges, and a game online is one for 2+ too),
    // so each is asked in turn rather than the game having one of them: it counts towards every
    // choice it's under, and a section holds it if any of its ticked choices does. A choice's
    // count leaves out its own section, as a menu's leaves out its own filter, but not the other.
    const hits = sections.map((choices) => choices.map((c) => c.test(g)));
    const held = sections.map((choices, s) => !choices.some((c) => players.has(c.value)) || choices.some((c, i) => hits[s][i] && players.has(c.value)));
    const inPlayers = held.every(Boolean);
    const playerHit = base && onPlatform && inGenre && inYear;
    sections.forEach((choices, s) => {
      const othersHeld = held.every((ok, t) => t === s || ok);
      choices.forEach((c, i) => bump(playerCounts, c.value, playerHit && othersHeld && hits[s][i]));
    });

    bump(platformCounts, g.platform, base && inGenre && inYear && inPlayers);
    const genreHit = base && onPlatform && inYear && inPlayers;
    for (const genre of ofGenres) bump(genreCounts, genre, genreHit);
    if (g.year) bump(yearCounts, String(g.year), base && onPlatform && inGenre && inPlayers);
    if (playerHit && inPlayers) shown.push(g);
  }
  return { shown, platformCounts, genreCounts, yearCounts, playerCounts };
}

/** What each menu offers and how many games are behind each entry, and the same for the sidebar. */
function updateFacets({ platformCounts, genreCounts, yearCounts, playerCounts }) {
  // A ticked value the shelf holds no game of (every one of a genre's games hidden by a hide)
  // stays on offer at 0: dropped, it would take the filter with it, and the shelf would be empty
  // under a heading that says every game.
  const chosenPlatforms = filters.platform.get();
  for (const genre of filters.genre.get()) if (!genreCounts.has(genre)) genreCounts.set(genre, 0);
  for (const year of filters.year.get()) if (!yearCounts.has(year)) yearCounts.set(year, 0);
  // Platforms keep the server's order, under LaunchBox's categories (Computers, Consoles…).
  filters.platform.setOptions(state.platforms
    .filter((p) => platformCounts.has(p.name) || chosenPlatforms.has(p.name))
    .map((p) => ({ value: p.name, label: shortPlatform(p.name), note: platformCounts.get(p.name) ?? 0, group: p.category || 'Other' })));
  filters.genre.setOptions([...genreCounts].sort((a, b) => collator.compare(a[0], b[0]))
    .map(([genre, n]) => ({ value: genre, label: genre, note: n })));
  // Years under their decade, so a whole decade can be ticked at once.
  filters.year.setOptions([...yearCounts].sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([year, n]) => ({ value: year, label: year, note: n, group: `${Math.floor(year / 10) * 10}s` })));
  // Every choice, always, under its section. A library where nothing seats more than one has
  // nothing to choose between, and then the menu isn't there at all.
  filters.players.setOptions(multiplayerSections().flatMap(([group, choices]) => choices
    .map(({ value, label, chipLabel }) => ({ value, label, chipLabel, group, note: playerCounts.get(value) ?? 0 }))));
  filters.players.el.hidden = !shelfTotals().players.get(MULTI);
  renderSidebar();
}

// ---------- What the filters add up to ----------

/** Clears every filter, without drawing the shelf again: the callers below all do that. */
function resetFilters() {
  els.q.value = '';
  quickList = '';
  for (const key of MENU_KEYS) filters[key].set([]);
  filters.fav.set(false);
  filters.sort.set('title');
}

/**
 * What a sidebar row does: clears everything and leaves this one filter on, so the shelf shows
 * exactly the number the row was carrying. Pressing the row that's already on its own clears
 * it too, and you're back at every game. The chips are for narrowing it from there.
 */
function showOnly(which, value) {
  const alone = filters[which].get().size === 1 && filters[which].get().has(value) && !otherFilters(which);
  resetFilters();
  if (!alone) filters[which].set([value]);
  selectGame(null);
  onChange();
  window.scrollTo(0, 0);
}

/**
 * Whether anything but `which` is narrowing the shelf. `which` is a chip's name, 'fav', or the
 * key of one of the LISTS: a list row asking this mustn't count its own list as another filter,
 * or pressing the row it's already on would never clear it.
 */
const otherFilters = (which) => Boolean(els.q.value.trim()) || (Boolean(quickList) && quickList !== which)
  || (which !== 'fav' && filters.fav.get())
  || MENU_KEYS.some((key) => key !== which && filters[key].get().size);

/** The same for the rows no chip stands for: the favorites and the LISTS. */
function showOnlyList(key) {
  const alone = (key === 'fav' ? filters.fav.get() : quickList === key) && !otherFilters(key);
  resetFilters();
  if (!alone) {
    if (key === 'fav') filters.fav.set(true);
    else {
      quickList = key;
      filters.sort.set(LISTS[key].sort);
    }
  }
  selectGame(null);
  onChange();
  window.scrollTo(0, 0);
}

/** The address of the shelf as it stands: what the filters add up to, then the rest of them. */
export function shelfHref() {
  const { kind, value } = currentScope();
  const p = new URLSearchParams();
  const many = (key, chosen) => { if (chosen.size) p.set(key, [...chosen].join(',')); };
  if (els.q.value.trim()) p.set('q', els.q.value.trim());
  // Whichever filter the path already names is left out of the query.
  if (kind !== 'platform') many('platform', filters.platform.get());
  if (kind !== 'genre') many('genre', filters.genre.get());
  many('year', filters.year.get());
  // The Multiplayer shelf is "2+ Players" alone, which its path already says.
  if (kind !== 'multi') many('players', filters.players.get());
  if (kind !== 'fav' && filters.fav.get()) p.set('fav', '1');
  if (filters.sort.get() !== (LISTS[kind]?.sort ?? 'title')) p.set('sort', filters.sort.get());
  const query = p.toString();
  const path = kind === 'platform' ? `/platform/${encodeURIComponent(value)}`
    : kind === 'genre' ? `/genre/${encodeURIComponent(value)}`
    : kind === 'multi' ? '/multiplayer'
    : kind === 'fav' ? '/favorites'
    : LISTS[kind] ? LISTS[kind].path
    : '/';
  return `${path}${query ? `?${query}` : ''}`;
}

// The shelf paths that carry a name, and the ones that don't. "/favourites" is what the
// favorites shelf used to be spelled, and links to it still work.
const NAMED_PATHS = { platform: /^\/platform\/(.+)$/, genre: /^\/genre\/(.+)$/ };
const PLAIN_PATHS = { '/favorites': 'fav', '/favourites': 'fav', '/multiplayer': 'multi', '/recent': 'recent', '/top': 'top' };

const knownPlatform = (name) => Boolean(platformOf(name));

/**
 * The filter an address names in its path. An address from before the genres were gathered
 * under their broad name ("/genre/Sports / Soccer") lands on the one that holds it now;
 * anything else the library no longer has lands on every game.
 */
function scopeFromPath(pathname) {
  for (const [kind, re] of Object.entries(NAMED_PATHS)) {
    const m = re.exec(pathname);
    if (!m) continue;
    const known = kind === 'platform' ? knownPlatform : (name) => allGenres().has(name);
    let named;
    try {
      named = decodeURIComponent(m[1]);
    } catch {
      return { kind: 'all', value: '' }; // a broken escape ("%E0") names nothing
    }
    for (const value of new Set([named, broadGenre(named)])) {
      if (known(value)) return { kind, value };
    }
    return { kind: 'all', value: '' };
  }
  const kind = PLAIN_PATHS[pathname] ?? 'all';
  // A link to a list this account doesn't have lands on every game.
  if ((kind === 'fav' && !state.can.favorites) || (LISTS[kind] && !listAllowed(kind))) return { kind: 'all', value: '' };
  return { kind, value: '' };
}

export function readFiltersFromUrl() {
  const p = new URLSearchParams(location.search);
  const many = (key) => (p.get(key) ?? '').split(',').filter(Boolean);
  const { kind, value } = scopeFromPath(location.pathname);
  quickList = LISTS[kind] ? kind : '';
  els.q.value = p.get('q') ?? '';
  // The path names one of the filters; the query holds the rest.
  // The query's values are checked as the path's are: a platform the library has, a genre by
  // the name it's gathered under now, a year, one of the Multiplayer menu's choices.
  filters.platform.set(kind === 'platform' ? [value] : many('platform').filter(knownPlatform));
  filters.genre.set(kind === 'genre' ? [value] : [...new Set(many('genre').map((genre) => [genre, broadGenre(genre)].find((name) => allGenres().has(name))))].filter(Boolean));
  filters.year.set(many('year').filter((year) => /^\d{4}$/.test(year)));
  const offered = new Set(multiplayerSections().flatMap(([, choices]) => choices.map((c) => c.value)));
  filters.players.set(kind === 'multi' ? [MULTI] : many('players').filter((pick) => offered.has(pick)));
  // Only what the account has: favorites of its own, and plays to sort by.
  filters.fav.set(state.can.favorites && (kind === 'fav' || p.get('fav') === '1'));
  const sort = p.get('sort');
  const sortAllowed = SORT_VALUES.has(sort) && (keepsPlays() || !/^-?played$/.test(sort));
  filters.sort.set(sortAllowed ? sort : (LISTS[kind]?.sort ?? 'title'));
  // An address the filters wouldn't write themselves — one naming a platform or genre the
  // library no longer has, say — is put right so it says where the shelf actually is. A game
  // page keeps its own address, and so does a page that couldn't find out what the account may
  // use, so a reload still has the favorites or sort it asked for.
  if (accessKnown() && !/^\/game\//.test(location.pathname) && location.href !== new URL(shelfHref(), location.href).href) {
    history.replaceState(history.state, '', shelfHref());
  }
}

// The whole library's emblem: a floppy, a cartridge (with a sunset like the app's logo) and a
// disc, for every kind of game in it. Drawn in the page rather than loaded as a picture, and
// made once: the heading is drawn again at every keystroke in the search box.
const EMBLEM_SVG = '<svg class="scope-emblem" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 64" aria-hidden="true"><defs><linearGradient id="eg-disc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e3f6fc"/><stop offset="0.45" stop-color="#5cc4e0"/><stop offset="0.75" stop-color="#8d9ce0"/><stop offset="1" stop-color="#d7c2f0"/></linearGradient><linearGradient id="eg-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16294a"/><stop offset="1" stop-color="#46305e"/></linearGradient><linearGradient id="eg-sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6c343"/><stop offset="0.6" stop-color="#ff7a45"/><stop offset="1" stop-color="#e6457a"/></linearGradient><clipPath id="eg-label"><rect x="27" y="36" width="30" height="18" rx="2"/></clipPath></defs><circle cx="47" cy="22" r="19" fill="url(#eg-disc)" stroke="#0b1522" stroke-width="2"/><circle cx="47" cy="22" r="7" fill="#0d1826" stroke="#e7eef6" stroke-opacity="0.55" stroke-width="1.5"/><circle cx="47" cy="22" r="2.5" fill="#0b1522"/><path d="M35 14a14 14 0 0 1 8-6" fill="none" stroke="#fff" stroke-opacity="0.7" stroke-width="2" stroke-linecap="round"/><rect x="3" y="17" width="32" height="34" rx="3" fill="#1e3a56" stroke="#0b1522" stroke-width="2"/><rect x="11" y="17" width="17" height="11" fill="#b9c8d7" stroke="#0b1522" stroke-width="1.5"/><rect x="21" y="19.5" width="4" height="6.5" fill="#1e3a56"/><rect x="8" y="33" width="22" height="14" rx="1.5" fill="#e7eef6"/><path d="M11 37.5h16M11 42h11" stroke="#93a6bb" stroke-width="1.6" stroke-linecap="round"/><path d="M29 30h26v3h3a3 3 0 0 1 3 3v24a3 3 0 0 1-3 3H26a3 3 0 0 1-3-3V36a3 3 0 0 1 3-3h3z" fill="#2a4058" stroke="#0b1522" stroke-width="2" stroke-linejoin="round"/><path d="M33 30v3M38 30v3M43 30v3M48 30v3M53 30v3" stroke="#0b1522" stroke-opacity="0.6" stroke-width="1.3"/><g clip-path="url(#eg-label)"><rect x="27" y="36" width="30" height="18" fill="url(#eg-sky)"/><circle cx="42" cy="49" r="9" fill="url(#eg-sun)"/><path d="M30 45.5h24M30 48.5h24M30 51.2h24" stroke="#46305e" stroke-width="1.1"/><path d="M27 54v-3l6-5 4 3 6-6 7 5 3-2 4 3v5z" fill="#0b1522" fill-opacity="0.85"/></g><path d="M34 58.5h16" stroke="#0b1522" stroke-opacity="0.55" stroke-width="1.3" stroke-dasharray="2 2"/></svg>';
let emblem = null;
function allGamesEmblem() {
  if (!emblem) {
    const holder = document.createElement('div');
    holder.innerHTML = EMBLEM_SVG;
    emblem = holder.firstElementChild;
  }
  return emblem;
}

/**
 * The heading over the shelf: a platform's own logo where LaunchBox has one, otherwise the
 * name of the genre or list, with how many games are on the shelf under it. Anything but the
 * whole, unfiltered shelf also gets the way back to all of them.
 */
function renderScopeHead(shown) {
  const scope = currentScope();
  // Narrowed past what the heading would name, it names the results instead, under the
  // library's emblem, with no facts: they'd be about a shelf that isn't the one showing.
  const results = narrowedPast(scope);
  const { kind, value } = results ? { kind: 'results', value: '' } : scope;
  const { title: name, icon: mark, logo, note } = results ? { title: 'Results' } : scopeLook(scope);

  els.scopeHead.className = `scope-head is-${kind}${logo ? ' has-logo' : ''}`;
  els.scopeId.replaceChildren(...(logo
    ? [h('h2', { class: 'visually-hidden' }, name),
      h('img', { class: 'scope-logo', src: logo, alt: name, onerror: (e) => {
        noLogo.add(value);
        // A logo from a heading since drawn over (the filters moved on before it failed) leaves the heading be.
        if (els.scopeId.contains(e.target)) renderScopeHead(shelfList.length);
      } })]
    // The whole library gets an emblem of its own, as a platform gets its logo: a floppy, a
    // cartridge and a disc, for every kind of game in it.
    : kind === 'all' || kind === 'results'
      ? [allGamesEmblem(), h('h2', { class: 'scope-title' }, name)]
      : [h('span', { class: 'scope-mark', 'aria-hidden': 'true' }, icon(mark)),
        h('h2', { class: 'scope-title' }, name)]));
  // replaceChildren() would show a null as the text "null"; the empties are dropped first.
  // Each part in a box of its own, so a phone can put them on two lines (see .scope-note).
  els.count.replaceChildren(...[
    h('span', {}, `${count(shown)} ${shown === 1 ? 'game' : 'games'}`),
    note ? h('span', { class: 'scope-sep', 'aria-hidden': 'true' }, '·') : null,
    note ? h('span', {}, note) : null,
  ].filter(Boolean));
  els.scopeActions.replaceChildren(...[
    kind === 'all' && !anyFilter()
      ? null
      // A phone shows only the arrow (see .scope-clear in app.css), so the name goes on the button too.
      : h('button', { type: 'button', class: 'scope-clear', 'aria-label': 'All games', title: 'All games', onclick: clearFilters },
        h('span', { 'aria-hidden': 'true' }, '←'), h('span', { class: 'scope-clear-word', 'aria-hidden': 'true' }, ' All games')),
    // One of the games under this heading, whatever it is (see randomGame). A phone shows only the icon.
    shown
      ? h('button', { type: 'button', class: 'scope-clear scope-random', 'aria-label': 'Random Game', title: 'Open one of these games at random', onclick: openRandom },
        icon('random'), h('span', { class: 'scope-clear-word', 'aria-hidden': 'true' }, 'Random Game'))
      : null,
  ].filter(Boolean));
  renderAbout(kind);
}

// What the facts panel was drawn for. The heading is drawn again at every keystroke in the
// search box; the panel only when what it's about changes (another platform, the library, a
// hide, a favorite), so it doesn't close again while the shelf is narrowed.
let about = { key: null, games: null, marks: null };

/**
 * The facts panel beside the heading, for a platform or for the whole library; other shelves
 * (a genre, a list, the favorites) have none. The first few facts show, and More opens out
 * the rest with any description.
 */
function renderAbout(kind) {
  const panel = els.scopeAbout;
  const { favorites: marks } = state.settings;
  const platform = kind === 'platform' ? only('platform') : null;
  const key = kind === 'platform' ? `platform:${platform}` : kind === 'all' ? `all:${hidesKey()}` : null;
  // The library's facts count favorites; a platform's don't, so a star doesn't redraw those.
  if (about.key === key && about.games === state.games && (kind !== 'all' || about.marks === marks)) return;
  const reopen = about.key === key && panel.classList.contains('is-open');
  about = { key, games: state.games, marks };

  const { facts = [], notes = [], shown = SHOWN_FACTS } = kind === 'platform' ? platformFacts(platform) : kind === 'all' ? libraryFacts() : {};
  if (!facts.length && !notes.length) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }

  const more = h('button', { type: 'button', class: 'scope-more', 'aria-expanded': String(reopen) }, reopen ? 'Less' : 'More…');
  more.addEventListener('click', () => {
    const open = panel.classList.toggle('is-open');
    more.setAttribute('aria-expanded', String(open));
    more.textContent = open ? 'Less' : 'More…';
  });
  panel.className = `scope-about${reopen ? ' is-open' : ''}`;
  panel.replaceChildren(...[
    facts.length ? h('dl', { class: 'scope-facts' },
      facts.map(([k, v], i) => h('div', { class: `scope-fact${i < shown ? '' : ' is-extra'}` }, h('dt', {}, k), h('dd', {}, v)))) : null,
    notes.length ? h('div', { class: 'scope-blurb' }, notes.map((p) => h('p', {}, p))) : null,
    facts.length > shown || notes.length ? more : null,
  ].filter(Boolean));
  panel.hidden = false;
}

// How many facts show before More, where the facts don't say (the library's show three).
const SHOWN_FACTS = 4;

/** "1983–2023", or one year, or nothing when no game says. */
function yearSpan(first, last) {
  if (first > last) return '';
  return first === last ? String(first) : `${first}–${last}`;
}

/**
 * A platform's facts: when it came out and who made it, the hardware LaunchBox describes
 * (consoles have most of it, a platform that's software has less), the years the games here
 * span, which every platform has, and LaunchBox's description of it.
 */
function platformFacts(platform) {
  const info = platformOf(platform)?.about;
  let first = Infinity;
  let last = -Infinity;
  for (const g of state.games) {
    if (g.platform !== platform || !(g.year > 0)) continue;
    if (g.year < first) first = g.year;
    if (g.year > last) last = g.year;
  }
  const specs = info?.specs ?? {};
  const facts = [
    ['Released', formatDate(info?.releaseDate)],
    ['Made by', info?.manufacturer],
    ['Media', specs.media],
    ['Game years', yearSpan(first, last)],
    ['Controllers', specs.controllers],
    ['Developer', info?.developer !== info?.manufacturer ? info?.developer : ''],
    ['CPU', specs.cpu],
    ['Memory', specs.memory],
    ['Graphics', specs.graphics],
    ['Sound', specs.sound],
    ['Display', specs.display],
  ].filter(([, v]) => v);
  const notes = (info?.notes ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return { facts, notes };
}

/**
 * The whole library's facts, worked out from the games the shelf can show (the shelf's hides
 * applied, as the count beside them is): how many platforms and of what kind, the years they
 * span, how many play here, where most of them are, and then the busiest decade, the genres,
 * developers, favorites, what's been played and rated, and the oldest game.
 */
function libraryFacts() {
  const games = shelfGames();
  const platforms = new Map();
  const decades = new Map();
  const developers = new Set();
  let first = Infinity;
  let last = -Infinity;
  let oldest = null;
  let playable = 0;
  let favorites = 0;
  let played = 0;
  let rated = 0;
  let videos = 0;
  for (const g of games) {
    platforms.set(g.platform, (platforms.get(g.platform) ?? 0) + 1);
    if (g.year > 0) {
      // The games are in title order, so of several from the same first year this keeps the first by title.
      if (g.year < first) oldest = g;
      first = Math.min(first, g.year);
      last = Math.max(last, g.year);
      const decade = Math.floor(g.year / 10) * 10;
      decades.set(decade, (decades.get(decade) ?? 0) + 1);
    }
    if (g.developer) developers.add(g.developer);
    if (isFavorite(g)) favorites += 1;
    if (g.playCount > 0) played += 1;
    if (LISTS.top.test(g)) rated += 1;
    if (g.videos > 0) videos += 1;
  }
  if (!games.length) return {};
  // Whether a game plays here is counted over the whole library: the hide the ones
  // that don't by default, and then every game on the shelf would.
  for (const g of state.games) if (g.versions?.length && !g.webBroken) playable += 1;
  const hidden = state.games.length - games.length;

  // How many platforms of each kind LaunchBox files them under (Consoles, Computers…), most first.
  const kinds = new Map();
  for (const name of platforms.keys()) {
    const kind = platformOf(name)?.category || 'Other platforms';
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const [biggest, biggestN] = [...platforms].sort((a, b) => b[1] - a[1])[0];
  const [decade, decadeN] = [...decades].sort((a, b) => b[1] - a[1])[0] ?? [];
  const genres = [...shelfTotals().genres].filter(([, n]) => n > 0);

  // Shown to begin with: how many platforms and genres, and the years. More opens out the rest.
  const leading = [
    ['Platforms', String(platforms.size)],
    ['Genres', genres.length ? String(genres.length) : ''],
    ['Game years', yearSpan(first, last)],
  ].filter(([, v]) => v);
  const facts = [
    ...leading,
    ...[...kinds].sort((a, b) => b[1] - a[1]).map(([kind, n]) => [kind, String(n)]),
    ['Most games', `${shortPlatform(biggest)} (${count(biggestN)})`],
    // Rounded, but never up to 100% while some don't play. Only for an account that can play.
    ['Playable here', state.can.play ? `${count(playable)} of ${count(state.games.length)} (${Math.min(playable < state.games.length ? 99 : 100, Math.round((playable / state.games.length) * 100))}%)` : ''],
    ['Hidden', hidden ? `${count(hidden)} ${hidden === 1 ? 'game' : 'games'}` : ''],
    ['Busiest decade', decade != null ? `${decade}s (${count(decadeN)} games)` : ''],
    ['Developers', developers.size ? count(developers.size) : ''],
    ['Favorites', state.can.favorites ? count(favorites) : ''],
    ['Played', keepsPlays() ? `${count(played)} ${played === 1 ? 'game' : 'games'}` : ''],
    ['Top rated', `${count(rated)} ${rated === 1 ? 'game' : 'games'}`],
    ['With video', videos ? `${count(videos)} ${videos === 1 ? 'game' : 'games'}` : ''],
    ['Oldest game', oldest ? `${oldest.title} (${oldest.year}, ${shortPlatform(oldest.platform)})` : ''],
  ].filter(([, v]) => v);
  return { facts, shown: leading.length };
}

// ---------- Sidebar ----------

const SIDE_SHOWN = { platforms: 6, genres: 8 }; // rows listed before "More…"
const expanded = { platforms: false, genres: false };

/**
 * One row of the sidebar. `on` marks a row the shelf is filtered by; `only` marks it as the
 * single thing filtering it, which is what a click on the row sets. A row that's on as one of
 * several (the Platform menu holds it along with others) is marked more quietly. `picture`: a
 * platform's icon from LaunchBox, in place of the drawn one (which stands in if it won't load).
 */
function sideItem({ kind, name, n, on = false, only = on, hint = '', picture = null, act }) {
  const classes = `side-item${on ? ' is-on' : ''}${on && !only ? ' is-partly' : ''}`;
  const mark = picture
    ? h('img', { class: 'side-picture', src: picture, alt: '', onerror: (e) => e.currentTarget.replaceWith(icon(kind)) })
    : icon(kind);
  // data-at says which row it is when the rows are drawn again (see refill).
  return h('li', {}, h('button', { type: 'button', class: classes, 'aria-pressed': String(on), title: hint || null, dataset: { at: `${kind}:${name}` }, onclick: act },
    mark, h('span', { class: 'side-name' }, name), n != null ? h('span', { class: 'side-count' }, count(n)) : null));
}

/**
 * The rows of a long sidebar list that are listed: the first few, or all of them once opened
 * out. The row for the shelf that's open is always among them, wherever it sits in the list.
 */
function listed(rows, key, isOpen) {
  if (expanded[key]) return rows;
  const head = rows.slice(0, SIDE_SHOWN[key]);
  const open = rows.slice(SIDE_SHOWN[key]).find(isOpen);
  return open ? [...head, open] : head;
}

/** "N more…" / "Fewer" under a list longer than it shows. */
function moreItem(key, hidden, render) {
  return h('li', {}, h('button', { type: 'button', class: 'side-item side-more', dataset: { at: `more:${key}` }, onclick: () => { expanded[key] = !expanded[key]; render(); } },
    h('span', { class: 'side-name' }, expanded[key] ? 'Fewer' : `${count(hidden)} more…`)));
}

/**
 * Fills the sidebar in. A row is a shortcut for the filter it stands for: it sets that filter
 * to itself alone, and clicking it again clears it. The rest of the filters are left where they
 * are, so you can move from one platform to the next, or add a genre, without starting over.
 * The counts come from the menus, and say what each row would add to the shelf as it stands.
 */
function renderSidebar() {
  const { all, favorites, lists, platforms, genres, players } = shelfTotals();
  const platformPicks = filters.platform.get();
  const genrePicks = filters.genre.get();
  const playerPicks = filters.players.get();
  const isOnly = (chosen, value) => chosen.size === 1 && chosen.has(value);

  refill(els.sideLists, [
    sideItem({ kind: 'all', name: 'All games', n: all, on: !anyFilter(), act: clearFilters }),
    // Multiplayer is the Multiplayer menu's "2+ Players" under a name of its own, and sits right
    // under All games: it's a way into the library, rather than something of this account's,
    // which the rows after it are.
    sideItem({
      kind: 'players', name: 'Multiplayer', n: players.get(MULTI) ?? 0, hint: MULTI_NOTE,
      on: playerPicks.has(MULTI), only: isOnly(playerPicks, MULTI),
      act: () => showOnly('players', MULTI),
    }),
    // Favorites are an account's own, and plays are only counted for accounts that can play.
    state.can.favorites ? sideItem({
      kind: 'fav', name: 'Favorites', n: favorites, on: filters.fav.get(),
      hint: 'Games you\'ve starred, here or in LaunchBox',
      act: () => showOnlyList('fav'),
    }) : null,
    ...Object.entries(LISTS).filter(([key]) => listAllowed(key)).map(([key, l]) => sideItem({
      kind: l.icon, name: l.title, hint: l.note, on: quickList === key,
      n: lists[key],
      act: () => showOnlyList(key),
    })),
    sideItem({ kind: 'random', name: 'Random game', hint: 'Open one of the games on the shelf', act: openRandom }),
  ]);

  // Both lists go biggest first, so the ones worth opening are at the top and the "more…" cut
  // falls in the right place.
  const platformRows = state.platforms.filter((p) => platforms.has(p.name))
    .sort((a, b) => platforms.get(b.name) - platforms.get(a.name) || collator.compare(a.name, b.name));
  const renderPlatforms = () => {
    const shown = listed(platformRows, 'platforms', (p) => platformPicks.has(p.name));
    refill(els.sidePlatforms, [
      ...shown.map((p) => sideItem({
        kind: p.category === 'Consoles' ? 'console' : 'computer',
        name: shortPlatform(p.name), n: platforms.get(p.name), hint: p.name,
        picture: p.icon ? `/api/platforms/${encodeURIComponent(p.name)}/icon` : null,
        on: platformPicks.has(p.name), only: isOnly(platformPicks, p.name),
        act: () => showOnly('platform', p.name),
      })),
      shown.length < platformRows.length ? moreItem('platforms', platformRows.length - shown.length, renderPlatforms) : null,
    ]);
  };
  renderPlatforms();

  const genreRows = [...genres.keys()].sort((a, b) => genres.get(b) - genres.get(a) || collator.compare(a, b));
  const renderGenres = () => {
    const shown = listed(genreRows, 'genres', (genre) => genrePicks.has(genre));
    refill(els.sideGenres, [
      ...shown.map((genre) => sideItem({
        kind: genreIcon(genre), name: genre, n: genres.get(genre),
        on: genrePicks.has(genre), only: isOnly(genrePicks, genre),
        act: () => showOnly('genre', genre),
      })),
      shown.length < genreRows.length ? moreItem('genres', genreRows.length - shown.length, renderGenres) : null,
    ]);
  };
  renderGenres();
}

/**
 * Puts a sidebar list's rows in, dropping the empties. Whoever was on a row keeps it: pressing
 * one draws them all again, and the focus would otherwise fall to the top of the page.
 */
function refill(list, rows) {
  const at = list.contains(document.activeElement) ? document.activeElement.dataset.at : null;
  list.replaceChildren(...rows.filter(Boolean));
  if (at) list.querySelector(`[data-at="${CSS.escape(at)}"]`)?.focus({ preventScroll: true });
}

/** Whether anything at all is narrowing the shelf. */
const anyFilter = () => Boolean(els.q.value.trim()) || filters.fav.get() || Boolean(quickList)
  || MENU_KEYS.some((key) => filters[key].get().size);

/**
 * How many games the shelf as a whole holds — the shelf's hides applied, nothing else — and
 * how many of them each sidebar row would show: each platform and genre, the seat ranges (for
 * the Multiplayer row), the favorites and the lists. A row clears the other filters, so what it says is what you get. Worked out once
 * and kept until the library, the hides or the favorites change (or a game is played here,
 * which resortShelf() answers).
 */
let totals = null;
function shelfTotals() {
  const hides = hidesKey();
  const { favorites: marks } = state.settings;
  if (totals?.games !== state.games || totals.hides !== hides || totals.marks !== marks) {
    const platforms = new Map();
    const genres = new Map();
    const players = new Map();
    const lists = Object.fromEntries(Object.keys(LISTS).map((key) => [key, 0]));
    let all = 0;
    let favorites = 0;
    for (const g of shelfGames()) {
      all += 1;
      if (isFavorite(g)) favorites += 1;
      for (const [key, l] of Object.entries(LISTS)) if (l.test(g)) lists[key] += 1;
      for (const seat of SEATS) if (seat.test(g)) players.set(seat.value, (players.get(seat.value) ?? 0) + 1);
      platforms.set(g.platform, (platforms.get(g.platform) ?? 0) + 1);
      for (const x of genresOf(g)) genres.set(x, (genres.get(x) ?? 0) + 1);
    }
    totals = { games: state.games, hides, marks, all, favorites, lists, platforms, genres, players };
  }
  return totals;
}

// Every genre in the library, hidden ones included, which is what a /genre/… address is
// checked against: a bookmark shouldn't break because of a hide.
let genreNames = null;
function allGenres() {
  if (genreNames?.games !== state.games) {
    const counts = new Map();
    for (const g of state.games) for (const x of genresOf(g)) counts.set(x, (counts.get(x) ?? 0) + 1);
    genreNames = { games: state.games, counts };
  }
  return genreNames.counts;
}

/** Back to every game, with nothing filtering it: the logo and "All games" both land here. */
export function clearFilters() {
  resetFilters();
  selectGame(null);
  onChange();
  window.scrollTo(0, 0);
}

// ---------- Tiles ----------

/** Forgets the tiles made so far and empties the grid. Tiles are made as they're shown. */
export function resetTiles() {
  state.tiles.clear();
  renderShelf([]);
}

// The same star the sidebar and the Favorites chip use (see ICONS.fav): outlined until the
// game is one, then filled in gold.
const STAR = '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z"/>';
// Every tile's star is a copy of this one: copying a node is far cheaper than having the
// browser parse the same markup again for each of twenty thousand tiles.
const starIcon = (() => {
  const holder = document.createElement('div');
  holder.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${STAR}</svg>`;
  return holder.firstChild;
})();

/** A game's shelf tile, made the first time it's shown and kept for next time. */
function tileFor(g) {
  let li = state.tiles.get(g.id);
  if (li) return li;
  const art = h('div', { class: 'tile-art' });
  if (g.cover) {
    // The picture's address waits in data-src until the tile's chunk comes near the screen
    // (see the chunk observer below). The browser's own lazy loading would do the same, but
    // it keeps an eye on every lazy picture in the page, and with fifteen thousand of them
    // that eye costs a few milliseconds every time anything moves.
    const img = h('img', { alt: '', decoding: 'async', dataset: { src: imageUrl(g.id, g.cover, 0, 320) } });
    img.addEventListener('error', () => img.replaceWith(h('div', { class: 'no-art' }, g.title)), { once: true });
    // The picture fades in once it's here (see app.css), each time: a picture far off the
    // screen is let go and asked for again as it comes back (see chunkWatch).
    img.addEventListener('load', () => art.classList.add('is-loaded'));
    art.append(img);
  } else {
    art.append(h('div', { class: 'no-art' }, g.title));
  }
  const fav = isFavorite(g);
  const star = h('button', { type: 'button', class: 'tile-star' });
  star.append(starIcon.cloneNode(true));
  li = h('li', { class: `tile${g.webBroken ? ' is-broken' : ''}${state.selectedId === g.id ? ' is-selected' : ''}`, dataset: { id: g.id } },
    h('a', { href: `/game/${g.id}`, dataset: { id: g.id } },
      art,
      h('div', { class: 'tile-body' },
        h('p', { class: 'tile-name' }, g.title),
        // Year on the left, platform on the right: the shelf usually mixes platforms.
        h('p', { class: 'tile-line' },
          h('span', { class: 'tile-year' }, g.year ?? ''),
          h('span', { class: 'tile-platform' }, shortPlatform(g.platform))),
        g.webBroken ? h('span', { class: 'tile-note' }, 'Doesn\'t run in the browser yet') : null)),
    // Outside the link: a button inside one isn't allowed, and this mustn't open the game.
    star);
  markStar(li, g, fav);
  state.tiles.set(g.id, li);
  return li;
}

function markStar(li, g, fav) {
  li.classList.toggle('is-fav', fav);
  const star = li.querySelector('.tile-star');
  star.setAttribute('aria-pressed', String(fav));
  star.setAttribute('aria-label', fav ? `Remove ${g.title} from favorites` : `Add ${g.title} to favorites`);
  star.title = fav ? 'Favorite' : 'Add to favorites';
}

/** Marks a game's tile again (and counts again) after its favorite mark changed. */
function refreshTile(id) {
  const li = state.tiles.get(id);
  const g = state.byId.get(id);
  if (li && g) markStar(li, g, isFavorite(g));
  applyFilters({ keepPlace: true });
}

// ---------- Selecting ----------

/**
 * Selects a game: its tile lights up and the dock pins to it, so the pointer can move to the
 * dock's buttons without the dock following it to other tiles on the way. null clears it.
 */
export function selectGame(id) {
  state.tiles.get(state.selectedId)?.classList.remove('is-selected');
  state.selectedId = id;
  if (!id) return unpinDock();
  state.tiles.get(id)?.classList.add('is-selected');
  pinDock(state.byId.get(id));
  // Its page is likely next (a second click, or the dock's Details), so its record is fetched now.
  prefetchDetail(id);
}

/**
 * A game picked at random from the shelf as it stands, never the one named. The heading's
 * Random Game, the sidebar's Random game row and a game page's "Random Game" all come here, so
 * all stay inside whatever the shelf is showing.
 */
export function randomGame(besides = null) {
  const pool = besides ? shelfList.filter((g) => g.id !== besides) : shelfList;
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}

/** Opens the page of one of the shelf's games at random (see game:random in app.js). */
function openRandom() {
  document.dispatchEvent(new CustomEvent('game:random'));
}

function wireTiles() {
  els.shelf.addEventListener('click', (e) => {
    const star = e.target.closest('.tile-star');
    if (star) {
      const g = state.byId.get(star.closest('.tile').dataset.id);
      if (g) setFavorite(g, !isFavorite(g));
      return;
    }
    const link = e.target.closest('.tile a');
    if (!link || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    const { id } = link.dataset;
    // A first click selects; a second on the same tile opens its page. Enter on a focused tile
    // (a click with no pointer behind it) opens straight away.
    if (state.selectedId === id || e.detail === 0) document.dispatchEvent(new CustomEvent('game:open', { detail: { id } }));
    else selectGame(id);
  });
  // Space on a focused tile selects it, as a click does.
  els.shelf.addEventListener('keydown', (e) => {
    const link = e.target.closest('.tile a');
    if (!link || e.key !== ' ') return;
    e.preventDefault();
    selectGame(state.selectedId === link.dataset.id ? null : link.dataset.id);
  });

  // A tile the pointer rests on for a moment has its page's record fetched ahead of time, so
  // the page opens without a wait. Only a rest counts: a sweep across the grid fetches nothing.
  let restTimer = 0;
  els.shelf.addEventListener('pointerover', (e) => {
    const tile = e.target.closest('.tile');
    clearTimeout(restTimer);
    if (!tile || e.pointerType === 'touch') return;
    restTimer = setTimeout(() => prefetchDetail(tile.dataset.id), PREFETCH_REST_MS);
  });
  els.shelf.addEventListener('pointerleave', () => clearTimeout(restTimer));

  document.addEventListener('favorite:changed', (e) => refreshTile(e.detail.id));
}

const PREFETCH_REST_MS = 150;

const BATCH = 240;          // tiles put in at a time
const FILL_DELAY_MS = 800;  // how long typing must pause before the rest of the list goes in
const FILL_STEP = 120;      // tiles per step of that fill, small enough to fit in a spare moment
// With a mouse, the rest of the list goes in once typing stops, so the scrollbar, the End
// key and the browser's Find see every game. Touch screens, which are slower and have none
// of those, get tiles as they scroll to them.
const fillsInBackground = matchMedia('(hover: hover)').matches;

let shelfList = []; // the games on the shelf, in order
let rendered = 0;   // how many of them have their tile in the grid
let fillTimer = 0;
let fillIdle = 0;

// The fill's steps run in the browser's spare moments, between frames it has to draw, so
// scrolling and typing come first. Browsers without an idle callback take a short timer and
// a fixed allowance instead.
const whenIdle = window.requestIdleCallback
  ? (fn) => requestIdleCallback(fn, { timeout: 1000 })
  : (fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 60);
const cancelIdle = window.cancelIdleCallback ?? clearTimeout;

// The grid is in chunks of a few rows, each a grid of its own with the same columns (see
// .shelf-chunk in app.css). One grid of the whole library would be laid out again from the
// top whenever anything in it changed — a batch of tiles going in, a picture arriving, the
// window resizing — and that takes long enough to be felt with fifteen thousand tiles. A
// chunk off the screen is skipped altogether, so the cost of any change is a few chunks' worth.
// A chunk holds whole rows, so the rows run on from one to the next without a gap.
const ROWS_PER_CHUNK = 8;
let chunkSize = 0; // tiles per chunk, for the columns the shelf has at its present width

// An empty grid with the shelf's columns, for counting them; nothing in it, so no height.
const probe = h('div', { class: 'shelf-probe', 'aria-hidden': 'true' });
// Marks the end of the tiles so far; more go in before the reader gets near it.
const sentinel = h('div', { class: 'shelf-sentinel', 'aria-hidden': 'true' });

/** How many tiles a row holds at the shelf's present width. */
const columns = () => getComputedStyle(probe).gridTemplateColumns.split(' ').length;

// The observer only reports changes, so the sentinel is watched afresh after each batch: if
// it's still near, that reports it again and another batch goes in.
const observer = new IntersectionObserver((entries) => {
  if (!entries.at(-1)?.isIntersecting) return;
  // The window can scroll under a game where scrollbars take no room (body keeps its overflow,
  // see app.css): no batches go in behind it, and the sentinel is looked at again when it closes.
  if (document.body.classList.contains('is-playing')) {
    return afterPlaying('sentinel', () => {
      observer.unobserve(sentinel);
      if (!sentinel.hidden) observer.observe(sentinel);
    });
  }
  appendTiles(BATCH);
  if (sentinel.hidden) return;
  observer.unobserve(sentinel);
  observer.observe(sentinel);
}, { rootMargin: '1500px 0px' });

// A chunk's pictures start loading when it comes within a screen or so of view, and are let go
// again once it's several screens away. Watching the chunks rather than the pictures keeps the
// watch lists a few hundred long rather than fifteen thousand. While a game is played nothing
// is loaded and every picture is let go (see wireShelfPictures), which leaves the memory to it.
//
// A phone closes a page that holds too much, with a game running and without warning, and
// every tile scrolled past would otherwise stay held. On a touch screen a chunk that far away
// also hides its tiles, keeping its height: a hidden tile's layout is freed, which is most of
// what a tile costs (measured in Chromium after scrolling half the library on a phone-sized
// screen: the page's own objects went from 224 MB to 58). With a mouse every tile stays, for
// the browser's Find (see fillsInBackground).
const hidesFarTiles = !fillsInBackground;
let gameOpen = false;
const chunkWatch = new IntersectionObserver((entries) => {
  for (const { isIntersecting, target } of entries) {
    if (!isIntersecting) continue;
    setFar(target, false);
    if (!gameOpen) showPictures(target);
  }
}, { rootMargin: '1200px 0px' });
const chunkRelease = new IntersectionObserver((entries) => {
  for (const { isIntersecting, target } of entries) {
    if (isIntersecting) continue;
    dropPictures(target);
    if (hidesFarTiles) setFar(target, true);
  }
}, { rootMargin: '4000px 0px' });

/** Hides a chunk's tiles (see app.css), or shows them again. */
function setFar(chunk, far) {
  if (far === chunk.classList.contains('is-far')) return;
  // Hidden, it keeps the height it had, so nothing on the page moves.
  chunk.style.height = far ? `${chunk.offsetHeight}px` : '';
  chunk.classList.toggle('is-far', far);
}

function showPictures(within) {
  for (const img of within.querySelectorAll('img[data-src]')) {
    img.src = img.dataset.src;
    delete img.dataset.src;
  }
}

function dropPictures(within) {
  for (const img of within.querySelectorAll('img[src]')) {
    img.dataset.src = img.getAttribute('src');
    img.removeAttribute('src');
    img.parentElement.classList.remove('is-loaded');
  }
}

/** Watches a chunk afresh, so where it is now is reported even if it was being watched. */
function watchChunk(chunk) {
  for (const watch of [chunkWatch, chunkRelease]) {
    watch.unobserve(chunk);
    watch.observe(chunk);
  }
}

export function wireShelfPictures() {
  document.addEventListener('player:opening', () => {
    gameOpen = true;
    dropPictures(els.shelf);
  });
  document.addEventListener('player:closed', () => {
    gameOpen = false;
    for (const chunk of els.shelf.querySelectorAll('.shelf-chunk')) watchChunk(chunk);
  });
}

/**
 * Shows a new list: its first batch of tiles now (or the first `keep`, to reach the reader's
 * place), the rest as they're needed.
 */
function renderShelf(list, keep = 0) {
  observer.disconnect();
  chunkWatch.disconnect();
  chunkRelease.disconnect();
  // Tiles are kept for next time (see tileFor), so the ones leaving let go of their pictures.
  dropPictures(els.shelf);
  restingPlace = null;
  shelfList = list;
  rendered = 0;
  sentinel.hidden = false;
  els.shelf.replaceChildren(probe, sentinel);
  chunkSize = ROWS_PER_CHUNK * columns();
  appendTiles(Math.max(BATCH, keep));
  if (!sentinel.hidden) observer.observe(sentinel);
  fillLater(FILL_DELAY_MS);
}

/** Puts the next `n` tiles of the list in the grid. */
function appendTiles(n) {
  if (rendered >= shelfList.length) return;
  const tiles = shelfList.slice(rendered, rendered + n).map(tileFor);
  rendered += tiles.length;
  place(tiles);
  if (rendered >= shelfList.length) {
    observer.disconnect();
    sentinel.hidden = true;
  }
}

/** Puts tiles in the grid: into the last chunk until it's full, then into new ones. */
function place(tiles) {
  let chunk = sentinel.previousElementSibling;
  for (let i = 0; i < tiles.length;) {
    if (!chunk?.classList.contains('shelf-chunk') || chunk.childElementCount >= chunkSize) {
      chunk = h('ul', { class: 'shelf-chunk' });
      sentinel.before(chunk);
    }
    // More tiles in a hidden chunk would need a height it hasn't measured.
    setFar(chunk, false);
    const room = chunkSize - chunk.childElementCount;
    chunk.append(...tiles.slice(i, i + room));
    // Watched afresh whenever tiles go in, not only when it's new: a chunk already near the
    // screen isn't reported again by itself, and the tiles added to it would never get theirs.
    watchChunk(chunk);
    i += room;
  }
}

/**
 * Chunks the tiles again for the columns the shelf has now: after the window was resized, and
 * on coming back to the shelf, in case it was resized meanwhile. The tiles stay the same
 * elements, so the browser keeps the reader's place among them.
 */
export function layoutShelf(marks = placeMark()) {
  if (state.view !== 'shelf') return;
  const size = ROWS_PER_CHUNK * columns();
  if (size === chunkSize) return;
  // The browser's own anchor goes with the old chunks, and the new ones have no remembered
  // height, so the reader's place is kept by hand.
  chunkSize = size;
  const tiles = [...els.shelf.querySelectorAll('.shelf-chunk > .tile')];
  for (const chunk of els.shelf.querySelectorAll('.shelf-chunk')) {
    chunkWatch.unobserve(chunk);
    chunkRelease.unobserve(chunk);
    chunk.remove();
  }
  place(tiles);
  restorePlace(marks);
}

/**
 * The tiles on the screen and how far down it each one sits, taken before the grid is rebuilt
 * so the reader's place can be put back after (see restorePlace); null at the top of the page,
 * where there's no place to lose. Chunks off the screen are passed over whole.
 */
function placeMark() {
  if (window.scrollY <= 0) return null;
  const marks = [];
  for (const chunk of els.shelf.children) {
    if (!chunk.classList.contains('shelf-chunk')) continue;
    const box = chunk.getBoundingClientRect();
    if (box.bottom <= 0) continue;
    if (box.top >= window.innerHeight) break;
    for (const tile of chunk.children) {
      const { top, bottom } = tile.getBoundingClientRect();
      if (bottom > 0 && top < window.innerHeight) marks.push({ tile, top });
    }
  }
  return marks.length ? marks : null;
}

/**
 * Scrolls so the first of the marked tiles still in the grid is where it was. Under a game page
 * the shelf's remembered place moves with it, since coming back scrolls to that.
 */
function restorePlace(marks) {
  const mark = marks?.find(({ tile }) => tile.isConnected);
  if (!mark) return;
  window.scrollBy(0, mark.tile.getBoundingClientRect().top - mark.top);
  if (state.view !== 'shelf') state.shelfScroll = window.scrollY;
}

// By the time a resize is heard the browser has already laid the old chunks out at the new
// width and the reader's place has moved, so the place is taken whenever scrolling comes to
// rest, and a resize puts back the one from before it began.
let restingPlace = null;
let restTimer = 0;
let resizeTimer = 0;
let resizeMarks = null;
const takeRestingPlace = () => {
  restTimer = 0;
  restingPlace = state.view === 'shelf' ? placeMark() : null;
};
window.addEventListener('scroll', () => {
  if (resizeTimer) return; // a scroll the resize itself caused isn't the reader's
  clearTimeout(restTimer);
  restTimer = setTimeout(takeRestingPlace, 150);
}, { passive: true });
// Tiles also move with no scroll as their pictures arrive and the cards take their full height:
// the place is taken again then too, at most every 150 ms while a screenful loads. One listener
// on the shelf, catching the pictures' load events on their way down.
els.shelf.addEventListener('load', () => {
  if (!resizeTimer && !restTimer) restTimer = setTimeout(takeRestingPlace, 150);
}, true);
window.addEventListener('resize', () => {
  if (!resizeTimer) {
    clearTimeout(restTimer);
    restTimer = 0;
    resizeMarks = restingPlace;
  }
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    layoutShelf(resizeMarks ?? placeMark());
    resizeTimer = 0;
    resizeMarks = null;
  }, 120);
});

/** Fills in the rest of the list in the browser's spare moments (a new list cancels it). */
function fillLater(delay) {
  clearTimeout(fillTimer);
  cancelIdle(fillIdle);
  if (!fillsInBackground || rendered >= shelfList.length) return;
  fillTimer = setTimeout(() => { fillIdle = whenIdle(fillStep); }, delay);
}

function fillStep(deadline) {
  // Not while a game page or a game is in front: try again later.
  if (state.view !== 'shelf' || document.body.classList.contains('is-playing')) return fillLater(FILL_DELAY_MS * 2);
  // As many steps as this spare moment has room for, then wait for the next one.
  do appendTiles(FILL_STEP); while (rendered < shelfList.length && deadline.timeRemaining() > 5);
  if (rendered < shelfList.length) fillIdle = whenIdle(fillStep);
}

/**
 * Adds tiles until the page is `height` pixels tall, or the list runs out, and then game `id`'s
 * tile when it's just past the tiles already in. Going back to the shelf uses it to scroll to
 * where it was and focus the game it came from, even when the list was rebuilt meanwhile.
 */
export function ensureRendered(height, id = null) {
  while (rendered < shelfList.length && document.documentElement.scrollHeight < height) appendTiles(BATCH);
  // A tile further down (a game opened at random or from a link) is off the screen anyway, and
  // waits for the fill or the scroll like any other, rather than thousands going in at once.
  const i = id ? shelfList.findIndex((g) => g.id === id) : -1;
  if (i >= rendered && i < rendered + BATCH) appendTiles(i + 1 - rendered);
}

// ---------- Filtering ----------

/**
 * Works the shelf out again from the filters. `keepPlace` is for changes that aren't the reader
 * asking for another shelf (a star, a game played): the grid, if it changes, keeps the tiles
 * down to where they were, and them where they were on the screen.
 */
export function applyFilters({ keepPlace = false } = {}) {
  // One pass over the shelf, in the chosen order, gives the games to show and the menus'
  // counts alike. Filtering keeps the order, so typing never sorts.
  const { shown: list, ...counts } = sift(sortedGames(filters.sort.get()));
  updateFacets(counts);

  // The grid is left alone when the result hasn't changed (a space typed, a filter that
  // matches the same games, a settings change that doesn't touch the shelf).
  if (list.length !== shelfList.length || list.some((g, i) => g !== shelfList[i])) {
    // Far down a long shelf, keeping the place means thousands of tiles at once: past a few
    // batches the grid starts again from the top as any new list does.
    const marks = keepPlace ? placeMark() : null;
    const reach = marks ? reachOf(marks, list) : 0;
    const keep = reach <= 4 * BATCH;
    renderShelf(list, keep ? reach : 0);
    if (keep) restorePlace(marks);
  }
  els.empty.hidden = list.length > 0;
  if (!list.length) els.empty.replaceChildren(...nothingMatched(matcher(), filters.fav.get()));

  // The heading says what the filters add up to and how many games that leaves.
  const scope = currentScope();
  renderScopeHead(list.length);
  // Not while a game started from the shelf is playing, whose name the tab has (see player.js).
  if (state.view === 'shelf' && !document.body.classList.contains('is-playing')) {
    const results = narrowedPast(scope);
    const name = results ? 'Results' : scopeLook(scope).title;
    document.title = scope.kind === 'all' && !results ? 'Retro Game Browser' : `${name} — Retro Game Browser`;
  }
}

/** How many of a new list's tiles reach past the marked ones, with a batch below them to scroll into. */
function reachOf(marks, list) {
  const ids = new Set(marks.map(({ tile }) => tile.dataset.id));
  let last = -1;
  list.forEach((g, i) => { if (ids.has(g.id)) last = i; });
  return last + 1 + BATCH;
}

/**
 * What to say when nothing matches: often it's a hide rather than the filters. The first two
 * anyone changes in their profile menu; the others only the owner, on the admin page.
 */
function nothingMatched(matches, favOnly) {
  const hidden = [
    ['showBroken', 'don\'t run in the browser yet', (g) => g.webBroken, true],
    ['showNonEnglish', 'never had an English release', (g) => gameFlags(g).nonEnglish, true],
    ['showPrereleases', 'are betas, demos or prototypes', (g) => gameFlags(g).prerelease, false],
    ['showNoImage', 'have no picture', (g) => !g.cover, false],
  ].filter(([setting]) => !state.settings[setting])
    .map(([, why, test, personal]) => [why, state.games.filter((g) => test(g) && matches(g)).length, personal])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (hidden.length) {
    const [why, n, personal] = hidden[0];
    const said = n === 1 ? `The one matching game ${why}, so it's hidden` : `All ${count(n)} matching games ${why}, so they're hidden`;
    return !personal && state.can.admin ? [`${said}. `, h('a', { href: '/admin#server' }, 'Change that on the admin page'), '.'] : [`${said}.`];
  }
  return [favOnly
    ? 'No games match. Try a shorter search, clear the filters or turn off Favorites.'
    : 'No games match. Try a shorter search or clear the filters.'];
}
