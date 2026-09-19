// Playing a DOS game with a friend, over the network the game itself expects: IPX.
//
// The 255 eXoDOS games eXo set up for network play (their dosbox.conf has `ipx = true`) speak
// Novell IPX, the LAN protocol of the era. js-dos 8.4 carries IPX between browsers over WebRTC
// data channels, so two people can play a 1995 LAN game across the internet with no relay in
// the middle — but the browsers still have to find each other first. That introduction is all
// this server does, and it is the whole of what "self-hosted signaling" means here: the offers,
// answers and addresses go through this app rather than through js-dos's public server.
//
// The wire protocol is humblepeer (see lib/humblepeer.js). The flow, per js-dos:
//
//   host   Dos(el, { startIpxServer: true, net: { peerServer: …?room=CODE&host=KEY } })
//          then, once it's running: ci.net().registerAlias('host')
//   friend Dos(el, { connectIpxAddress: 'host', net: { peerServer: …?room=CODE } })
//          which polls AliasQuery "=host" until the host answers, then opens a peer connection
//          to that peer id and runs `ipxnet connect` against it inside DOSBox.
//
// Every room gets its own catalog, so peers and aliases in one room can't see or address
// another's; that is also why the alias is just "host" rather than the room code. (It must not
// look like a number: js-dos reads a numeric connectIpxAddress as a peer id instead of a name.)
//
// Rooms themselves are NetplayRooms' (see lib/netplay.js) — the same link, the same "anyone
// with it may fetch this game's files while the room lasts" grant as console netplay. What's
// different is that nothing is relayed here once the game starts.

import {
  decode, helloClient, aliasResolved, aliasQueryResult,
  p2pOffer, p2pAnswer, iceCandidate, p2pReject,
  FLAG_WEBRTC, FLAG_EMULATED, REJECT,
} from './humblepeer.js';

/** The alias a host registers so its friends can find it without knowing its peer id. */
export const HOST_ALIAS = 'host';

/** Longest signaling message we'll read. An SDP offer with candidates is a few KB. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * How long the host's signaling socket may be away before the game ends. The socket going is
 * not the same as the host leaving: reloading the page closes it, and so does a moment's bad
 * network, with js-dos opening a new one straight after. Ending the room on the close itself
 * would take the invite link with it — for good, since the code is the room — so the room only
 * ends if the host is still away when this runs out.
 */
export const HOST_GRACE_MS = 30_000;

/** How long a socket may stay without saying hello. Until it does it holds a place in the room. */
export const HELLO_TIMEOUT_MS = 30_000;

/**
 * How often every signaling socket is pinged. Once the browsers have met over WebRTC nothing goes
 * down this socket, and js-dos sends no keepalive of its own, so without this a socket that died
 * quietly (a laptop asleep, Wi-Fi gone) would hold its place and the host's name for good, and
 * Cloudflare's tunnel closes a WebSocket that's been idle for about 100 s. A socket that hasn't
 * answered the last ping by the next one is dropped.
 */
export const HEARTBEAT_MS = 30_000;

/** Names are short words ('host'); a longer one, or more than a few per peer, is a client up to no good. */
const MAX_ALIAS_LENGTH = 64;
const MAX_ALIASES_PER_PEER = 8;

export class IpxSignaling {
  /**
   * @param {object} options
   * @param {import('./netplay.js').NetplayRooms} options.rooms  where the room codes live
   * @param {number} [options.maxPeersPerRoom]  so one room can't fill the memory
   * @param {(message: string) => void} [options.onLog]  a line for the console, or nothing
   */
  constructor({ rooms, maxPeersPerRoom = 8, onLog = null } = {}) {
    this.rooms = rooms;
    this.maxPeersPerRoom = maxPeersPerRoom;
    this.onLog = onLog;
    this.catalogs = new Map(); // room code -> { code, peers, aliases, nextPeerId, sockets }
    this.bySocket = new Map(); // socket -> peer
    this.hostAway = new Map(); // room code -> timer, while a host's socket might still come back
    this.heartbeat = null;     // the ping interval, while any socket is connected
  }

  /** How many peers are connected, across every room. */
  get size() {
    return this.bySocket.size;
  }

  #log(message) {
    this.onLog?.(message);
  }

  #catalog(code) {
    let catalog = this.catalogs.get(code);
    if (!catalog) {
      // `sockets` is every connection in the room, whether or not it has said hello yet;
      // `peers` only fills in at hello. The catalog is kept while either holds anything, so a
      // connection that arrives and goes before saying hello can't take the room's catalog
      // out from under a peer that is still on it.
      // `nextPlayer` numbers the friends for the session's log; the host is always player 1,
      // whenever it says hello and however often it reconnects (peer ids go in order of hello).
      catalog = { code, peers: new Map(), aliases: new Map(), nextPeerId: 1, nextPlayer: 2, sockets: new Set() };
      this.catalogs.set(code, catalog);
    }
    return catalog;
  }

  /**
   * Whether a browser may open a signaling socket, and as what. The room must exist; the key,
   * which only the host's own page is given, says this is the host. Returns null when not.
   */
  check({ code, key }) {
    const room = this.rooms.roomFor?.(code) ?? null;
    if (!room || room.mode !== 'ipx') return null;
    return { room, isHost: Boolean(key) && key === room.key };
  }

  /**
   * Takes over a freshly upgraded WebSocket. `socket` is a ws WebSocket; the caller has already
   * checked the room with `check`. Returns the peer's room code.
   */
  add(socket, { room, isHost }) {
    const catalog = this.#catalog(room.code);
    // Every connection counts, not only those that have said hello, so sockets that never do
    // can't pile up without limit (and they're closed after HELLO_TIMEOUT_MS anyway).
    if (catalog.sockets.size >= this.maxPeersPerRoom) {
      socket.close(1013, 'room full');
      if (catalog.sockets.size === 0 && !this.hostAway.has(catalog.code)) this.catalogs.delete(catalog.code);
      return null;
    }
    const peer = {
      peerId: 0, player: 0, socket, catalog, room, isHost,
      aliases: new Set(),
      connectedPeers: new Set(),
      alive: true,
      helloTimer: setTimeout(() => socket.close(1002, 'hello first'), HELLO_TIMEOUT_MS),
    };
    peer.helloTimer.unref?.();
    catalog.sockets.add(socket);
    // The host is back (a reload, or a socket that dropped and was opened again), so the room
    // isn't ending after all.
    if (isHost) {
      clearTimeout(this.hostAway.get(room.code));
      this.hostAway.delete(room.code);
    }
    this.bySocket.set(socket, peer);
    this.#startHeartbeat();
    socket.on('pong', () => { peer.alive = true; });
    socket.on('message', (data, isBinary) => {
      peer.alive = true;
      if (!isBinary) return;
      if (data.length > MAX_MESSAGE_BYTES) return socket.close(1009, 'message too big');
      this.#handle(peer, decode(data));
    });
    socket.on('close', () => this.remove(socket));
    socket.on('error', () => this.remove(socket));
    return room.code;
  }

  /** A signaling socket went away: its peer, its aliases and, for the host, the room. */
  remove(socket) {
    const peer = this.bySocket.get(socket);
    if (!peer) return;
    this.bySocket.delete(socket);
    clearTimeout(peer.helloTimer);
    this.#stopHeartbeatIfIdle();
    const { catalog } = peer;
    catalog.sockets.delete(socket);
    catalog.peers.delete(peer.peerId);
    for (const alias of peer.aliases) {
      if (catalog.aliases.get(alias) === peer.peerId) catalog.aliases.delete(alias);
    }
    // Tell whoever was talking to this peer that it's gone, so their emulator stops waiting.
    // `connectedPeers` only records who a peer reached out to, so a negotiation shows up on one
    // side or the other depending on who offered; both count as talking.
    for (const other of catalog.peers.values()) {
      const reachedOut = other.connectedPeers.delete(peer.peerId);
      if (reachedOut || peer.connectedPeers.has(other.peerId)) {
        send(other, p2pReject({ peerId: peer.peerId, reason: REJECT.NotFound }));
      }
    }
    if (peer.isHost) {
      this.#hostGone(catalog, peer.room);
    } else if (peer.peerId) {
      this.rooms.setIpxPlayers?.(catalog.code, catalog.peers.size);
      this.rooms.ipxEvent?.(catalog.code, peer.player, 'left');
    }
    // Nothing connected and no host expected back: there's nothing left to keep.
    if (catalog.sockets.size === 0 && !this.hostAway.has(catalog.code)) this.catalogs.delete(catalog.code);
  }

  /**
   * The host's socket went. It may be on its way back (see HOST_GRACE_MS), so the friends are
   * left where they are and the room is given that long to see the host again. Only if it
   * doesn't does the game end, which is what takes the friends and the invite link with it.
   */
  #hostGone(catalog, room) {
    if (this.hostAway.has(catalog.code)) return;
    // Another of the host's sockets is still here (two tabs on the same game): the host hasn't
    // gone anywhere.
    for (const other of catalog.sockets) {
      if (this.bySocket.get(other)?.isHost) return;
    }
    const timer = setTimeout(() => {
      this.hostAway.delete(catalog.code);
      this.#log(`The host left ${room.title} (room ${catalog.code}).`);
      for (const peer of [...catalog.peers.values()]) peer.socket.close(1000, 'host left');
      this.catalogs.delete(catalog.code);
      this.rooms.closeIpx?.(catalog.code);
    }, HOST_GRACE_MS);
    timer.unref?.();
    this.hostAway.set(catalog.code, timer);
  }

  /**
   * The room ended some other way than its host leaving (the owner ended it from the admin page,
   * or it was never opened in time): every signaling socket in it goes too. Games whose browsers
   * have already met keep playing over their own connections; this stops any more introductions.
   */
  closeRoom(code) {
    clearTimeout(this.hostAway.get(code));
    this.hostAway.delete(code);
    const catalog = this.catalogs.get(code);
    if (!catalog) return;
    this.catalogs.delete(code);
    for (const socket of catalog.sockets) {
      const peer = this.bySocket.get(socket);
      clearTimeout(peer?.helloTimer);
      // Off the books before closing, so the close event finds nothing to do: for the host's
      // socket it would otherwise start the grace timer for a room that's already gone.
      this.bySocket.delete(socket);
      socket.close(1000, 'room ended');
    }
    catalog.sockets.clear();
    catalog.peers.clear();
    this.#stopHeartbeatIfIdle();
  }

  #startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const [socket, peer] of this.bySocket) {
        if (!peer.alive) {
          socket.terminate();
          continue;
        }
        peer.alive = false;
        try {
          socket.ping();
        } catch {
          // Closing already; its close event tidies up.
        }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  #stopHeartbeatIfIdle() {
    if (this.bySocket.size || !this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  #handle(peer, message) {
    if (!message) return;
    // Nothing but a hello counts until a peer has said hello, as the reference server has it.
    if (!peer.peerId && message.kind !== 'HelloServer') return peer.socket.close(1002, 'hello first');
    switch (message.kind) {
      case 'HelloServer': return this.#hello(peer, message);
      case 'AliasRegister': return this.#register(peer, message.alias);
      case 'AliasUnregister': return this.#unregister(peer, message.alias);
      case 'AliasLookup': return this.#lookup(peer, message.alias);
      case 'AliasQuery': return this.#query(peer, message.query);
      case 'P2POffer': return this.#offer(peer, message);
      case 'P2PAnswer': return this.#answer(peer, message);
      case 'ICECandidate': return this.#ice(peer, message);
      case 'P2PReject': return this.#rejected(peer, message);
      // The client tells us when a peer connection opened or closed. Nothing to route.
      case 'P2PConnected':
      case 'P2PDisconnect': return undefined;
      default: return undefined;
    }
  }

  #hello(peer, message) {
    if (peer.peerId) return;
    // Bit 0 of the flags is "I can do WebRTC". Without it there's nothing we can offer.
    if (!(message.flags & FLAG_WEBRTC)) return peer.socket.close(1002, 'webrtc required');
    const { catalog } = peer;
    clearTimeout(peer.helloTimer);
    peer.peerId = catalog.nextPeerId;
    catalog.nextPeerId += 1;
    if (peer.isHost) {
      peer.player = 1;
    } else {
      peer.player = catalog.nextPlayer;
      catalog.nextPlayer += 1;
    }
    catalog.peers.set(peer.peerId, peer);
    send(peer, helloClient({ peerId: peer.peerId }));
    this.#log(`${peer.isHost ? 'The host' : 'A friend'} is set up to play ${peer.room.title} together (room ${catalog.code}, peer ${peer.peerId}).`);
    // A host saying hello again (a reload) finds its room already open.
    const opened = peer.isHost ? this.rooms.openIpx?.(catalog.code) : null;
    this.rooms.setIpxPlayers?.(catalog.code, catalog.peers.size);
    this.rooms.ipxEvent?.(catalog.code, peer.player, !peer.isHost ? 'joined' : opened ? 'started the game' : 'reconnected');
  }

  #register(peer, alias) {
    if (!alias || alias.length > MAX_ALIAS_LENGTH) return;
    if (peer.aliases.size >= MAX_ALIASES_PER_PEER && !peer.aliases.has(alias)) return;
    const { catalog } = peer;
    const owner = catalog.aliases.get(alias);
    // Only the host may claim the name its friends look for; anyone may take a free one.
    if (alias === HOST_ALIAS && !peer.isHost) return;
    // A host that's back on a new socket takes its name from its old one, which may not have been
    // noticed as gone yet (see HEARTBEAT_MS); the friends are looking for whoever is host now.
    const hostTakingBack = alias === HOST_ALIAS && catalog.peers.get(owner)?.isHost;
    if (owner !== undefined && owner !== peer.peerId && catalog.peers.has(owner) && !hostTakingBack) return;
    if (hostTakingBack) catalog.peers.get(owner).aliases.delete(alias);
    catalog.aliases.set(alias, peer.peerId);
    peer.aliases.add(alias);
  }

  #unregister(peer, alias) {
    const { catalog } = peer;
    const names = alias ? [alias] : [...peer.aliases];
    for (const name of names) {
      if (catalog.aliases.get(name) === peer.peerId) catalog.aliases.delete(name);
      peer.aliases.delete(name);
    }
  }

  #lookup(peer, alias) {
    if (!alias) return;
    send(peer, aliasResolved({ alias, peerId: peer.catalog.aliases.get(alias) ?? 0 }));
  }

  /** "=name" asks for that one name; anything else asks for every name starting with it. */
  #query(peer, query) {
    if (query === null || query === undefined) return;
    const { aliases } = peer.catalog;
    let records = [];
    if (query.startsWith('=')) {
      const wanted = query.slice(1);
      const peerId = aliases.get(wanted);
      if (peerId !== undefined) records = [{ alias: wanted, peerId }];
    } else {
      records = [...aliases]
        .filter(([alias]) => alias.startsWith(query))
        .map(([alias, peerId]) => ({ alias, peerId }));
    }
    send(peer, aliasQueryResult({ query, records }));
  }

  /** The peer a message is addressed to, or null once the sender has been told it isn't there. */
  #target(peer, peerId) {
    const target = peer.catalog.peers.get(peerId);
    if (!target || !target.peerId) {
      send(peer, p2pReject({ peerId, reason: REJECT.NotFound }));
      return null;
    }
    return target;
  }

  #offer(peer, { peerId, flags, offer }) {
    // A relayed ("emulated") connection would make this server carry the game's traffic. It
    // isn't built for that, and the reference server refuses it too.
    if (flags & FLAG_EMULATED) return send(peer, p2pReject({ peerId, reason: REJECT.NotFound }));
    const target = this.#target(peer, peerId);
    if (!target) return undefined;
    peer.connectedPeers.add(target.peerId);
    return send(target, p2pOffer({ peerId: peer.peerId, flags, offer }));
  }

  #answer(peer, { peerId, offer }) {
    const target = this.#target(peer, peerId);
    if (!target) return undefined;
    // An answer only makes sense to someone who offered; anything else is a confused client.
    if (!target.connectedPeers.has(peer.peerId)) {
      return send(peer, p2pReject({ peerId, reason: REJECT.NotFound }));
    }
    peer.connectedPeers.add(target.peerId);
    return send(target, p2pAnswer({ peerId: peer.peerId, offer }));
  }

  #ice(peer, { peerId, offer }) {
    const target = this.#target(peer, peerId);
    if (target) send(target, iceCandidate({ peerId: peer.peerId, offer }));
  }

  #rejected(peer, { peerId }) {
    const target = peer.catalog.peers.get(peerId);
    if (target) send(target, p2pReject({ peerId: peer.peerId, reason: REJECT.PeerRefused }));
  }
}

/** Sends bytes to a peer, ignoring a socket that has already gone. */
function send(peer, bytes) {
  try {
    if (peer.socket.readyState === 1) peer.socket.send(bytes, { binary: true });
  } catch {
    // The socket is closing; `remove` will tidy up when its close event arrives.
  }
}
