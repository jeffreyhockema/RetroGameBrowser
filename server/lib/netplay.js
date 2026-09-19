// Playing a console game with a friend, through EmulatorJS's own netplay.
//
// EmulatorJS (4.2.3, vendored) has a netplay mode of its own, marked experimental: every
// player runs the game in their own browser, the one who opened the room (the owner) is the
// game that counts, and the others follow it. When someone joins, the owner sends a save
// state, everyone loads it, and from then on the owner sends the inputs of every frame while
// each friend sends theirs to the owner, ten frames ahead; a friend who falls behind pauses
// and asks for a fresh state. The traffic goes through a socket.io server, which is what this
// is: the rooms, who's in them, and passing the messages between them. Its protocol is the one
// the vendored client speaks (see defineNetplayFunctions in vendor/emulatorjs/data/src/emulator.js):
//
//   open-room    { extra, maxPlayers, password }  -> cb(error)          the owner opens a room
//   join-room    { extra }                         -> cb(error, users)   a friend joins one
//   users-updated  users                                                 sent to a room when it changes
//   data-message   data                                                  relayed to the others
//   GET /list?domain=&game_id=                     -> { sessionid: { room_name, current, max } }
//
// `extra` is the client's own record of a player: { domain, game_id, room_name, player_name,
// userid, sessionid }, and `users` maps userid -> extra in the order they joined, which the
// client turns into player numbers (the owner is player 1).
//
// This app adds a link on top: the app opens a room ahead of time (create) and gets a code
// for the link and a key for the host's page; the host's page then opens the room over the
// socket with that code as its session id and the key to prove itself (see
// public/emu/play.html). A friend who opens the link joins that session. Anyone who has the
// link may fetch the game the room is for while the room lasts (see grants), since their
// browser has to run it too. Everything is in memory: a room lasts while it's played.

import crypto from 'node:crypto';

const MAX_PLAYERS = 4;
const MAX_NAME = 40;
// A client's own id for a player (a UUID, see public/emu/play.html). It's a map key and goes out
// to every player on every change, so a longer one is refused rather than kept and repeated.
const MAX_ID = 64;

const token = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const fail = (status, message) => Object.assign(new Error(message), { status });

export class NetplayRooms {
  /**
   * @param {object} options
   * @param {number} [options.maxRooms]  rooms at once, so the internet can't fill the memory
   * @param {number} [options.startMs]   how long a room waits for its host's game to open it; the
   *   host's page may first copy and download a big game (an eXoDOS bundle can be hundreds of MB
   *   over the tunnel), so this is generous
   * @param {object} [options.log]       a NetplayLog (see netplaylog.js) that records each session
   * @param {(room: object) => void} [options.onClose]  told of every room that closes, however it
   *   closes; an IPX room's signalling sockets live elsewhere (see IpxSignaling.closeRoom)
   */
  constructor({ maxRooms = 100, startMs = 30 * 60_000, iceServers = [], log = null, onClose = null } = {}) {
    this.maxRooms = maxRooms;
    this.startMs = startMs;
    this.log = log;
    this.onClose = onClose;
    // The STUN/TURN servers the players' browsers use to find a direct path to each other.
    this.iceServers = iceServers;
    this.rooms = new Map();    // code -> room
    this.bySocket = new Map(); // socket -> { room, userid }
  }

  get size() {
    return this.rooms.size;
  }

  /**
   * Opens a room for a game the host is about to start: what the host's browser needs, the
   * code (the link, and the room's session id) and the key (which says a page is the host).
   */
  create({ gameId, versionId, title, platform = '', engine = 'emulatorjs', input = 'pad', cover = null, hostName = '', hostEmail = null, via = 'account', mode = 'lockstep' }) {
    if (this.rooms.size >= this.maxRooms) throw fail(503, 'Too many games are being hosted right now. Try again in a little while.');
    const room = {
      code: token(9),
      key: token(24),
      gameId,
      versionId: String(versionId),
      title: String(title ?? 'a game').slice(0, 200),
      platform: String(platform ?? '').slice(0, 100),
      // Which player page runs it for a friend: EmulatorJS's or MAME's (see public/js/join.js).
      engine: engine === 'mame' ? 'mame' : 'emulatorjs',
      // What a friend plays with: a controller ('pad'), or a computer's keyboard and mouse
      // ('keyboard', an Apple IIgs game), which a friend watching by video sends to the host.
      input: input === 'keyboard' ? 'keyboard' : 'pad',
      cover,
      hostName: cleanName(hostName, 'The host'),
      // The account that opened it, so taking that account's access away can end it (endRoomsOf).
      // Never part of info(): that goes to anyone with the link.
      hostEmail: hostEmail ? String(hostEmail).trim().toLowerCase() : null,
      // How the host came to be allowed to play: 'owner', 'account' (one the owner lets play),
      // 'local' (the local network) or 'guest' (while the owner lets guests in). When that ends,
      // so does the room (see endRoomsWhere): its link would otherwise go on handing out the game.
      via: ['owner', 'account', 'local', 'guest'].includes(via) ? via : 'account',
      // How the game is played together: 'rollback' or 'lockstep' (everyone runs it, see
      // netplay-fixes.js), 'stream' (the host runs it and sends video, see netplay-stream.js),
      // or 'ipx' (a DOS game over its own LAN protocol, which this server only introduces —
      // see lib/ipx.js, and note that such a room's players never appear in `users`).
      mode: ['rollback', 'lockstep', 'stream', 'ipx'].includes(mode) ? mode : 'lockstep',
      created: Date.now(),
      max: MAX_PLAYERS,
      owner: null,          // { userid, extra, socket } once the host's game has opened the room
      users: new Map(),     // userid -> { extra, socket }, the owner first
      ipxPlayers: 0,        // for 'ipx' rooms, how many emulators are signalling right now
      timer: null,
    };
    this.rooms.set(room.code, room);
    room.timer = setTimeout(() => { if (!room.owner) this.#close(room); }, this.startMs);
    room.timer.unref?.();
    return { code: room.code, key: room.key };
  }

  /** What anyone with the link may know about a room, or null when there's no such room. */
  info(code) {
    const room = this.rooms.get(String(code ?? ''));
    if (!room) return null;
    return {
      title: room.title,
      platform: room.platform,
      engine: room.engine,
      input: room.input,
      gameId: room.gameId,
      versionId: room.versionId,
      cover: room.cover,
      hostName: room.hostName,
      mode: room.mode,
      open: Boolean(room.owner),
      players: this.#playerCount(room),
      max: room.max,
      full: this.#playerCount(room) >= room.max,
      iceServers: this.iceServers,
    };
  }

  /** The room behind a code, for the parts of the app that need more than `info` gives out. */
  roomFor(code) {
    return this.rooms.get(String(code ?? '')) ?? null;
  }

  #playerCount(room) {
    return room.mode === 'ipx' ? room.ipxPlayers : room.users.size;
  }

  /**
   * An IPX room's host has arrived on the signaling socket (see lib/ipx.js). These rooms aren't
   * played over this server, so opening one only means it has started and should stop waiting.
   */
  openIpx(code) {
    const room = this.rooms.get(String(code ?? ''));
    if (!room || room.mode !== 'ipx' || room.owner) return null;
    clearTimeout(room.timer);
    room.owner = { userid: 'ipx-host', socket: null };
    this.log?.start(room);
    return room;
  }

  /** How many emulators are in an IPX room, so the join page can say when it's full. */
  setIpxPlayers(code, players) {
    const room = this.rooms.get(String(code ?? ''));
    if (!room || room.mode !== 'ipx') return;
    room.ipxPlayers = Math.max(0, players);
  }

  /**
   * Someone arrived at or left an IPX room, for the session's log. They bring no numbers with
   * them: the emulators talk to each other directly, so this server never sees the game, and
   * such a session's log is who was there and for how long rather than frames and pings.
   */
  ipxEvent(code, player, what) {
    const room = this.rooms.get(String(code ?? ''));
    if (!room || room.mode !== 'ipx') return;
    this.log?.event(room.code, player, player === 1 ? room.hostName : `Player ${player}`, what);
  }

  /** The host of an IPX room left, which ends it. */
  closeIpx(code) {
    const room = this.rooms.get(String(code ?? ''));
    if (room && room.mode === 'ipx') this.#close(room);
  }

  /** Whether a socket is the host's game of a room (the one that sends its save state to friends). */
  isHost(socket) {
    for (const room of this.rooms.values()) if (room.owner?.socket === socket) return true;
    return false;
  }

  /** The version a room's code is for, while the room lasts, or null. */
  versionOf(code) {
    return this.rooms.get(String(code ?? ''))?.versionId ?? null;
  }

  /** Whether the holder of a room's code may fetch a version's files: while the room lasts. */
  grants(code, versionId) {
    const room = this.rooms.get(String(code ?? ''));
    return Boolean(room && (versionId == null || room.versionId === String(versionId)));
  }

  /**
   * The host's page opens its room over the socket. `socket` is anything with emit(event,
   * ...args) and disconnect(). Throws with the client's error word when it can't.
   */
  open({ extra, key }, socket) {
    const room = this.rooms.get(String(extra?.sessionid ?? ''));
    // An IPX room is opened by its host's signalling socket (openIpx), never over this one.
    if (!room || room.mode === 'ipx') throw fail(404, 'NO_SUCH_ROOM');
    if (!key || key !== room.key) throw fail(403, 'NOT_THE_HOST');
    if (room.owner) throw fail(409, 'ROOM_ALREADY_OPEN');
    if (this.bySocket.has(socket)) throw fail(409, 'ALREADY_IN_ROOM');
    const userid = playerId(extra);
    clearTimeout(room.timer);
    room.owner = { userid, socket };
    room.users.set(userid, { extra: cleanExtra(extra, room, userid), socket });
    this.bySocket.set(socket, { room, userid });
    this.log?.start(room);
    return room;
  }

  /** A friend's page joins a room. Returns the users map the client expects. */
  join({ extra }, socket) {
    const room = this.rooms.get(String(extra?.sessionid ?? ''));
    // An IPX room's players are on its signalling socket; joining one here would add a player to
    // a game this server doesn't run, and one calling itself 'ipx-host' would end it on leaving.
    if (!room || !room.owner || room.mode === 'ipx') throw fail(404, 'NO_SUCH_ROOM');
    // A socket already in a room keeps its one place: a page that asks twice (a retry that
    // crosses a reconnect) would otherwise leave a second place behind that never leaves.
    const already = this.bySocket.get(socket);
    if (already) {
      if (already.room === room) return this.users(room);
      throw fail(409, 'ALREADY_IN_ROOM');
    }
    if (room.users.size >= room.max) throw fail(409, 'ROOM_FULL');
    let userid = playerId(extra);
    while (room.users.has(userid)) userid = token(8);
    room.users.set(userid, { extra: cleanExtra(extra, room, userid), socket });
    this.bySocket.set(socket, { room, userid });
    const users = this.users(room);
    for (const u of room.users.values()) u.socket.emit('users-updated', users);
    this.log?.event(room.code, room.users.size, room.users.get(userid).extra.player_name, 'joined');
    return users;
  }

  /** The room's users as the client wants them: userid -> extra, the owner first. */
  users(room) {
    return Object.fromEntries([...room.users].map(([userid, u]) => [userid, u.extra]));
  }

  /**
   * Passes a game message on to every other player in the room. Every player stamps their
   * own inputs with the frame they take effect on (see public/player/netplay-fixes.js), so
   * everyone hears everyone, as they do over the direct connections. A message that's a plain
   * object is stamped with who sent it (`sentBy`), so a player can't speak for another: the
   * stream host looks players up by it (public/player/netplay-stream.js). `from` is left as
   * sent, since the rollback and lockstep pages put a player's number there.
   */
  relay(socket, data) {
    const who = this.bySocket.get(socket);
    if (!who) return false;
    const { room, userid } = who;
    const out = data && typeof data === 'object' && Object.getPrototypeOf(data) === Object.prototype ? { ...data, sentBy: userid } : data;
    for (const [id, u] of room.users) if (id !== userid) u.socket.emit('data-message', out);
    return true;
  }

  /**
   * Passes one player's message to one other player: how two browsers introduce themselves
   * to each other for a direct connection (WebRTC's offers, answers and addresses). Returns
   * false when either isn't in the room.
   */
  signal(socket, to, data) {
    const who = this.bySocket.get(socket);
    const target = who?.room.users.get(String(to ?? ''));
    if (!target || !data || typeof data !== 'object') return false;
    target.socket.emit('signal', { from: who.userid, data });
    return true;
  }

  /**
   * A player's page reports its numbers, once a second, for the session's log (see everySecond
   * in public/player/netplay-fixes.js). Returns false when the socket isn't in a room.
   */
  report(socket, data) {
    const who = this.bySocket.get(socket);
    if (!who || !this.log) return false;
    const { room, userid } = who;
    const player = [...room.users.keys()].indexOf(userid) + 1;
    return this.log.sample(room.code, player, room.users.get(userid)?.extra.player_name, data);
  }

  /**
   * A socket went away. A friend's leaves their place free and the room is told; the owner's
   * ends the room, and the friends' sockets are closed, which their client takes as leaving.
   */
  leave(socket) {
    const who = this.bySocket.get(socket);
    if (!who) return;
    this.bySocket.delete(socket);
    const { room, userid } = who;
    if (room.owner?.userid === userid) return this.#close(room);
    this.log?.event(room.code, [...room.users.keys()].indexOf(userid) + 1, room.users.get(userid)?.extra.player_name, 'left');
    room.users.delete(userid);
    const users = this.users(room);
    for (const u of room.users.values()) u.socket.emit('users-updated', users);
  }

  /** The room a socket is in, with its player number (1 is the owner), or null. */
  placeOf(socket) {
    const who = this.bySocket.get(socket);
    if (!who) return null;
    return { room: who.room, player: [...who.room.users.keys()].indexOf(who.userid) + 1 };
  }

  // There is deliberately no method here listing the open rooms for EmulatorJS's own Netplay
  // menu: a room's code is its invite, so anything handing out codes hands out the games behind
  // them (see roomGrant in server/index.js). The owner's admin page is the one exception, below.

  /** Every open room, for the owner's admin page only: it shows them and can end one. */
  adminList() {
    return [...this.rooms.values()].map((room) => ({
      code: room.code,
      title: room.title,
      platform: room.platform,
      mode: room.mode,
      hostName: room.hostName,
      hostEmail: room.hostEmail,
      open: Boolean(room.owner),
      players: this.#playerCount(room),
      names: [...room.users.values()].map((u) => cleanName(u.extra?.player_name, 'A player')),
      max: room.max,
      created: new Date(room.created).toISOString(),
    })).sort((a, b) => (a.created < b.created ? 1 : -1));
  }

  /** Ends a room, disconnecting everyone in it. Returns whether there was one. */
  end(code) {
    const room = this.rooms.get(String(code ?? ''));
    if (!room) return false;
    // The host's page is told its friends have gone as their sockets close; the host's own
    // socket is left open by #close, so it's ended here as well.
    const host = room.owner?.socket;
    this.#close(room);
    host?.disconnect();
    return true;
  }

  /**
   * Ends every room an account opened, when its access is taken away: while a room lasts, its link
   * still hands out the game. Returns how many there were.
   */
  endRoomsOf(email) {
    const key = String(email ?? '').trim().toLowerCase();
    if (!key) return 0;
    return this.endRoomsWhere((r) => r.hostEmail === key);
  }

  /**
   * Ends every room `test({ hostEmail, via })` says yes to: those whose host isn't allowed to play
   * any more (guests turned off, an account's access changed). Returns how many there were.
   */
  endRoomsWhere(test) {
    const codes = [...this.rooms.values()].filter((r) => test({ hostEmail: r.hostEmail, via: r.via })).map((r) => r.code);
    for (const code of codes) this.end(code);
    return codes.length;
  }

  #close(room) {
    clearTimeout(room.timer);
    this.rooms.delete(room.code);
    // Nobody waits on the log, so a failure there must not become an unhandled rejection.
    if (room.owner) this.log?.end(room.code).catch((err) => console.warn(`Couldn't finish the multiplayer log: ${err.message}`));
    for (const u of room.users.values()) {
      this.bySocket.delete(u.socket);
      if (u !== room.users.get(room.owner?.userid)) u.socket.disconnect();
    }
    room.users.clear();
    room.owner = null;
    try {
      this.onClose?.(room);
    } catch (err) {
      console.warn(`Couldn't tidy up after room ${room.code}: ${err.message}`);
    }
  }
}

/** A name as someone typed it, without the whitespace and length that would trouble a page. */
export function cleanName(name, fallback) {
  const clean = String(name ?? '').replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return clean || fallback;
}

/** The id a player's page gave itself, or a new one when it gave none. Throws when it's unusable. */
function playerId(extra) {
  const userid = extra.userid == null ? token(8) : String(extra.userid);
  if (userid.length === 0 || userid.length > MAX_ID) throw fail(400, 'BAD_PLAYER');
  return userid;
}

/** The client's record of a player, kept to the fields the client reads, cut to size. */
function cleanExtra(extra, room, userid) {
  return {
    domain: String(extra.domain ?? '').slice(0, 200),
    // The clients send a number (a hash of the version, or 0); nothing reads it back.
    game_id: Number.isSafeInteger(extra.game_id) ? extra.game_id : 0,
    room_name: room.title,
    player_name: cleanName(extra.player_name, 'Player'),
    // The key the player is kept under, which a clash in join() may have changed.
    userid,
    sessionid: room.code,
  };
}
