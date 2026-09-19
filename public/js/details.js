// A game's full record (its page's data), fetched once and kept for a while: a game page opens
// straight from here when the record was fetched ahead of time, which the shelf does for a
// tile the pointer rests on or one that's been selected, so opening a page feels instant.

import { api } from './util.js';

const KEEP = 60; // records kept, most recently used last
const records = new Map(); // game id -> { promise, game } (game once it has arrived)

/** The game's record: from here when it's been fetched, else from the server. */
export function getDetail(id) {
  let entry = records.get(id);
  if (entry) {
    // Most recently used goes to the back, so it's kept the longest.
    records.delete(id);
    records.set(id, entry);
    return entry.promise;
  }
  entry = { game: null };
  entry.promise = api(`/games/${id}`).then((game) => {
    entry.game = game;
    return game;
  }, (err) => {
    // A failure isn't kept: the next try asks the server again.
    if (records.get(id) === entry) records.delete(id);
    throw err;
  });
  records.set(id, entry);
  while (records.size > KEEP) records.delete(records.keys().next().value);
  return entry.promise;
}

/** The game's record if it's here already, without waiting; else null. */
export const peekDetail = (id) => records.get(id)?.game ?? null;

/** Fetches a game's record ahead of time, quietly. */
export function prefetchDetail(id) {
  getDetail(id).catch(() => {});
}

/** Drops what's kept for a game, e.g. after playing it changed its play count. */
export function forgetDetail(id) {
  records.delete(id);
}
