// State shared between the app's modules.

export const state = {
  platforms: [],         // every loaded platform: { name, category, logo }
  games: [],             // shelf summaries for the whole library, in title order
  byId: new Map(),
  tiles: new Map(),      // game id -> shelf <li>
  view: 'shelf',         // 'shelf' | 'game'
  selectedId: null,      // the game clicked on the shelf, which the dock is pinned to
  detail: null,          // full record of the game whose page is open
  shelfScroll: 0,
  // Who's signed in and what they may do (see server/lib/auth.js). Nothing until /api/me says
  // otherwise, so a request that fails never shows someone what they can't do.
  auth: { enabled: false, clientId: null },
  user: null,            // { email, name, picture }
  can: { owner: false, admin: false, play: false, favorites: false },
  server: null,          // the owner's switches for the whole server ({ guestsCanPlay }), for the owner only
  settings: {
    showBroken: false,
    showNonEnglish: false,
    showPrereleases: false,
    showNoImage: false,
    pcMultiplayerWithoutNetwork: false,
    filterDefaults: {},  // the owner's defaults for the flags above, which the two in the profile menu change
    favorites: {},       // game id -> true/false, overriding the mark LaunchBox has
    gameDefaults: {},    // game id -> the version its Play button starts
    versionOrder: [],    // the fixed ranking of version kinds, from the server
  },
};
