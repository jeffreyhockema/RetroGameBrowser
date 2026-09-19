// The checks the server's routes make before answering (see server/index.js): who may have a
// game's files, and which requests come from this app's own pages. Kept apart from the server so
// they can be tested without starting it.

import { cookieValue } from './util.js';

/** The cookie the join page sets, holding a room's code (see roomGuards). */
export const ROOM_COOKIE = 'rgb_room';

/**
 * A game itself (its files, what starts it, a download of it) is for accounts that may play.
 * Anyone else gets what they'd get for something that isn't there: nothing tells them that
 * playing or downloading is something other people can do here.
 */
export function mayPlay(req, res, next) {
  if (req.can.play) return next();
  res.status(404).json({ error: 'Not found' });
}


/**
 * The checks that take a friend's room code into account. `rooms` is the server's NetplayRooms.
 *
 * A friend invited to a game has a room's code in a cookie (set by the join page), which lets
 * them fetch that one game's files while the room lasts: EmulatorJS's netplay runs the game in
 * their browser too (see lib/netplay.js). `versionId` narrows it to the room's version.
 */
export function roomGuards(rooms) {
  const roomGrant = (req, versionId = null) => rooms.grants(cookieValue(req.headers.cookie, ROOM_COOKIE), versionId);
  return {
    roomGrant,
    /** The version a friend's room code is for, or null. */
    roomVersion: (req) => rooms.versionOf(cookieValue(req.headers.cookie, ROOM_COOKIE)),
    /** The files of one version: for accounts that may play, and for a friend invited to that version. */
    mayPlayVersion(req, res, next) {
      if (req.can.play || roomGrant(req, req.params.versionId)) return next();
      mayPlay(req, res, next);
    },
    /**
     * Files every game shares (the MT-32 ROMs, a soundfont), like a console's BIOS: for accounts
     * that may play, and for a friend invited to any game.
     */
    mayPlayShared(req, res, next) {
      if (req.can.play || roomGrant(req)) return next();
      mayPlay(req, res, next);
    },
  };
}

/** Whether a request names no other site as where it came from (a browser sends Origin for most requests that change something). */
export function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * Requests that change something must come from this app's own pages. The custom header
 * forces a CORS preflight, which this server never approves for other origins.
 */
export const fromThisApp = (req) => sameOrigin(req) && req.headers['x-requested-with'] === 'RetroGameBrowser';

/**
 * The admin page's API answers the owner only, and takes changes only from this app's own pages.
 * Where there are no accounts the owner is this PC (see permissionsFor in lib/auth.js): the rest
 * of the local network has the library, but not this.
 */
export function ownerOnly(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!req.can.admin) {
    if (req.can.owner) return res.status(403).json({ error: 'With no sign-in set up, the admin page opens only on the PC Retro Game Browser runs on, at http://localhost.' });
    return res.status(req.user ? 403 : 401).json({ error: req.user ? 'Only the owner can use the admin page.' : 'Sign in as the owner to use the admin page.' });
  }
  if (req.method !== 'GET' && !fromThisApp(req)) return res.status(403).json({ error: 'Changes can only be made from the admin page.' });
  next();
}
