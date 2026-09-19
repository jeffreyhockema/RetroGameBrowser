import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IpxSignaling, HOST_ALIAS, HOST_GRACE_MS, HELLO_TIMEOUT_MS, HEARTBEAT_MS } from '../server/lib/ipx.js';
import { NetplayRooms } from '../server/lib/netplay.js';
import {
  decode, helloServer, aliasRegister, aliasUnregister, aliasLookup, aliasQuery,
  p2pOffer, p2pAnswer, iceCandidate, p2pReject, p2pConnected,
  FLAG_WEBRTC, FLAG_EMULATED, REJECT,
} from '../server/lib/humblepeer.js';

/** A stand-in for a ws WebSocket: remembers what it was sent and how it was closed. */
function socket() {
  const s = { readyState: 1, sent: [], closed: null, handlers: {}, pings: 0, terminated: false };
  s.on = (event, fn) => { s.handlers[event] = fn; };
  s.send = (bytes) => s.sent.push(decode(bytes));
  s.close = (code, reason) => { s.readyState = 3; s.closed = { code, reason }; };
  s.ping = () => { s.pings += 1; };
  s.terminate = () => { s.readyState = 3; s.terminated = true; };
  s.pong = () => s.handlers.pong?.();
  s.say = (bytes) => s.handlers.message?.(Buffer.from(bytes), true);
  s.hangUp = () => s.handlers.close?.();
  s.last = () => s.sent[s.sent.length - 1];
  return s;
}

/** A stand-in for NetplayRooms holding whatever rooms a test needs. */
function roomStore(...rooms) {
  const byCode = new Map(rooms.map((r) => [r.code, r]));
  return {
    calls: [],
    events: [],
    opened: new Set(),
    roomFor(code) { return byCode.get(code) ?? null; },
    openIpx(code) {
      this.calls.push(['open', code]);
      if (this.opened.has(code)) return null;
      this.opened.add(code);
      return byCode.get(code);
    },
    ipxEvent(code, player, what) { this.events.push([player, what]); },
    setIpxPlayers(code, n) { this.calls.push(['players', code, n]); },
    closeIpx(code) { this.calls.push(['close', code]); },
  };
}

const ROOM = { code: 'r1', key: 'K', mode: 'ipx', title: 'DOOM', max: 4 };
const hello = (flags = FLAG_WEBRTC) => helloServer({ flags, gameToken: 'rgb', gameSignature: 'x' });

/** Connects a peer and says hello, returning its socket and the peer id it was given. */
function join(ipx, rooms, { isHost = false, code = ROOM.code } = {}) {
  const s = socket();
  const allowed = ipx.check({ code, key: isHost ? rooms.roomFor(code).key : null });
  ipx.add(s, allowed);
  s.say(hello());
  return { socket: s, peerId: s.last().peerId };
}

test('Only a real IPX room lets a socket in, and only its key makes a host', () => {
  const rooms = roomStore(ROOM, { code: 'ejs', key: 'K2', mode: 'lockstep', title: 'Contra' });
  const ipx = new IpxSignaling({ rooms });
  assert.equal(ipx.check({ code: 'nope', key: null }), null);
  assert.equal(ipx.check({ code: 'ejs', key: 'K2' }), null, 'a console netplay room is not an IPX one');
  assert.equal(ipx.check({ code: 'r1', key: null }).isHost, false);
  assert.equal(ipx.check({ code: 'r1', key: 'wrong' }).isHost, false);
  assert.equal(ipx.check({ code: 'r1', key: 'K' }).isHost, true);
});

test('Saying hello earns a peer id, and the room is told it started', () => {
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const host = join(ipx, rooms, { isHost: true });
  assert.deepEqual(host.socket.last(), { kind: 'HelloClient', peerId: 1, reconnectToken: null });
  const friend = join(ipx, rooms);
  assert.equal(friend.peerId, 2);
  assert.deepEqual(rooms.calls, [['open', 'r1'], ['players', 'r1', 1], ['players', 'r1', 2]]);
  assert.equal(ipx.size, 2);
});

test('A client that can\'t do WebRTC, or talks before saying hello, is shown the door', () => {
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const noWebrtc = socket();
  ipx.add(noWebrtc, ipx.check({ code: 'r1' }));
  noWebrtc.say(hello(0));
  assert.equal(noWebrtc.closed.code, 1002);

  const early = socket();
  ipx.add(early, ipx.check({ code: 'r1' }));
  early.say(aliasRegister({ alias: 'host' }));
  assert.equal(early.closed.code, 1002);
});

test('The host claims the name friends look for, and nobody else can take it', () => {
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const host = join(ipx, rooms, { isHost: true });
  const friend = join(ipx, rooms);

  friend.socket.say(aliasRegister({ alias: HOST_ALIAS }));
  friend.socket.say(aliasLookup({ alias: HOST_ALIAS }));
  assert.equal(friend.socket.last().peerId, 0, 'a friend can\'t pose as the host');

  host.socket.say(aliasRegister({ alias: HOST_ALIAS }));
  friend.socket.say(aliasQuery({ query: `=${HOST_ALIAS}` }));
  assert.deepEqual(friend.socket.last(), { kind: 'AliasQueryResult', query: '=host', records: [{ alias: 'host', peerId: host.peerId }] });

  friend.socket.say(aliasQuery({ query: '' }));
  assert.deepEqual(friend.socket.last().records, [{ alias: 'host', peerId: host.peerId }], 'an empty query lists everything');
  friend.socket.say(aliasQuery({ query: '=nobody' }));
  assert.deepEqual(friend.socket.last().records, []);
});

test('Aliases are given up when a peer unregisters them or leaves', () => {
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const host = join(ipx, rooms, { isHost: true });
  const friend = join(ipx, rooms);
  friend.socket.say(aliasRegister({ alias: 'player-two' }));
  friend.socket.say(aliasLookup({ alias: 'player-two' }));
  assert.equal(friend.socket.last().peerId, friend.peerId);

  friend.socket.say(aliasUnregister({ alias: 'player-two' }));
  friend.socket.say(aliasLookup({ alias: 'player-two' }));
  assert.equal(friend.socket.last().peerId, 0);

  host.socket.say(aliasRegister({ alias: HOST_ALIAS }));
  friend.socket.say(aliasRegister({ alias: 'later' }));
  friend.socket.hangUp();
  host.socket.say(aliasQuery({ query: '' }));
  assert.deepEqual(host.socket.last().records, [{ alias: 'host', peerId: host.peerId }]);
});

test('Offers, answers and addresses reach the other peer, stamped with who sent them', () => {
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const host = join(ipx, rooms, { isHost: true });
  const friend = join(ipx, rooms);

  friend.socket.say(p2pOffer({ peerId: host.peerId, flags: 0, offer: 'v=0 offer' }));
  assert.deepEqual(host.socket.last(), { kind: 'P2POffer', peerId: friend.peerId, flags: 0, offer: 'v=0 offer' });

  host.socket.say(p2pAnswer({ peerId: friend.peerId, offer: 'v=0 answer' }));
  assert.deepEqual(friend.socket.last(), { kind: 'P2PAnswer', peerId: host.peerId, offer: 'v=0 answer' });

  host.socket.say(iceCandidate({ peerId: friend.peerId, offer: 'candidate:1 1 udp' }));
  assert.deepEqual(friend.socket.last(), { kind: 'ICECandidate', peerId: host.peerId, offer: 'candidate:1 1 udp' });

  // P2PConnected is news, not something to route; it mustn't reach anyone else.
  const before = host.socket.sent.length;
  friend.socket.say(p2pConnected({ peerId: host.peerId }));
  assert.equal(host.socket.sent.length, before);
});

test('A message for a peer who isn\'t there comes back as NotFound', () => {
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const friend = join(ipx, rooms);
  friend.socket.say(p2pOffer({ peerId: 99, flags: 0, offer: 'v=0' }));
  assert.deepEqual(friend.socket.last(), { kind: 'P2PReject', peerId: 99, reason: REJECT.NotFound });

  // An answer to someone who never offered is a confused client, not a connection.
  const host = join(ipx, rooms, { isHost: true });
  friend.socket.say(p2pAnswer({ peerId: host.peerId, offer: 'v=0' }));
  assert.equal(friend.socket.last().kind, 'P2PReject');
  assert.equal(host.socket.sent.length, 1, 'the host heard nothing');
});

test('A relayed connection is refused: this server carries no game traffic', () => {
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const host = join(ipx, rooms, { isHost: true });
  const friend = join(ipx, rooms);
  friend.socket.say(p2pOffer({ peerId: host.peerId, flags: FLAG_EMULATED, offer: 'v=0' }));
  assert.deepEqual(friend.socket.last(), { kind: 'P2PReject', peerId: host.peerId, reason: REJECT.NotFound });
  assert.equal(host.socket.sent.length, 1, 'the host was never asked');
});

test('Refusing a peer tells them so', () => {
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const host = join(ipx, rooms, { isHost: true });
  const friend = join(ipx, rooms);
  host.socket.say(p2pReject({ peerId: friend.peerId, reason: REJECT.PeerRefused }));
  assert.deepEqual(friend.socket.last(), { kind: 'P2PReject', peerId: host.peerId, reason: REJECT.PeerRefused });
});

test('A peer leaving tells whoever was talking to it; the host leaving ends the room', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const host = join(ipx, rooms, { isHost: true });
  const friend = join(ipx, rooms);
  friend.socket.say(p2pOffer({ peerId: host.peerId, flags: 0, offer: 'v=0' }));

  friend.socket.hangUp();
  assert.deepEqual(host.socket.last(), { kind: 'P2PReject', peerId: friend.peerId, reason: REJECT.NotFound });
  assert.deepEqual(rooms.calls.at(-1), ['players', 'r1', 1]);

  const other = join(ipx, rooms);
  host.socket.hangUp();
  // Not straight away: the socket going isn't the host going (see HOST_GRACE_MS).
  assert.equal(other.socket.closed, null, 'the friend is left alone until the host really has gone');
  assert.ok(!rooms.calls.some((c) => c[0] === 'close'), 'the room is still open');

  t.mock.timers.tick(HOST_GRACE_MS + 1);
  assert.equal(other.socket.closed.reason, 'host left');
  assert.deepEqual(rooms.calls.at(-1), ['close', 'r1']);
  assert.equal(ipx.size, 1, 'the friend\'s own socket closes when its close event arrives');
});

test('A host that reloads keeps the room, and the friends on it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const host = join(ipx, rooms, { isHost: true });
  host.socket.say(aliasRegister({ alias: HOST_ALIAS }));
  const friend = join(ipx, rooms);

  // Reloading the page closes the signaling socket; js-dos opens another one straight after.
  host.socket.hangUp();
  t.mock.timers.tick(HOST_GRACE_MS - 1000);
  const again = join(ipx, rooms, { isHost: true });
  t.mock.timers.tick(HOST_GRACE_MS * 2);

  assert.equal(friend.socket.closed, null, 'the friend was never thrown out');
  assert.ok(!rooms.calls.some((c) => c[0] === 'close'), 'and the room never ended');
  // The friend can still find the host under the alias it registers again.
  again.socket.say(aliasRegister({ alias: HOST_ALIAS }));
  friend.socket.say(aliasLookup({ alias: HOST_ALIAS }));
  assert.equal(friend.socket.last().peerId, again.peerId);
});

test('A connection that goes before saying hello leaves the room as it was', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const host = join(ipx, rooms, { isHost: true });
  host.socket.say(aliasRegister({ alias: HOST_ALIAS }));

  // A friend's browser opens the socket and goes away again before it says hello, so it was
  // never in `peers`. The host is still on the catalog and must keep it.
  const early = socket();
  ipx.add(early, ipx.check({ code: ROOM.code, key: null }));
  early.hangUp();

  const friend = join(ipx, rooms);
  friend.socket.say(aliasLookup({ alias: HOST_ALIAS }));
  assert.equal(friend.socket.last().peerId, host.peerId, 'the host is still findable');
});

test('Rooms can\'t see each other\'s peers or names', () => {
  const second = { code: 'r2', key: 'K2', mode: 'ipx', title: 'Descent', max: 4 };
  const rooms = roomStore(ROOM, second);
  const ipx = new IpxSignaling({ rooms });
  const oneHost = join(ipx, rooms, { isHost: true });
  oneHost.socket.say(aliasRegister({ alias: HOST_ALIAS }));
  const twoHost = join(ipx, rooms, { isHost: true, code: 'r2' });

  assert.equal(twoHost.peerId, 1, 'peer ids start again in each room');
  twoHost.socket.say(aliasQuery({ query: `=${HOST_ALIAS}` }));
  assert.deepEqual(twoHost.socket.last().records, [], 'the other room\'s host is invisible');

  twoHost.socket.say(p2pOffer({ peerId: oneHost.peerId, flags: 0, offer: 'v=0' }));
  assert.equal(oneHost.socket.sent.length, 1, 'and unreachable');
});

test('A room only holds so many players', () => {
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms, maxPeersPerRoom: 2 });
  join(ipx, rooms, { isHost: true });
  join(ipx, rooms);
  const third = socket();
  assert.equal(ipx.add(third, ipx.check({ code: 'r1' })), null);
  assert.equal(third.closed.code, 1013);
});

test('An oversized message ends the socket instead of being read', () => {
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const { socket: s } = join(ipx, rooms, { isHost: true });
  s.say(Buffer.alloc(64 * 1024 + 1));
  assert.equal(s.closed.code, 1009);
});

test('Junk on the wire is ignored, not fatal', () => {
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const { socket: s } = join(ipx, rooms, { isHost: true });
  const before = s.sent.length;
  s.say(Buffer.from('not a flatbuffer'));
  s.handlers.message?.(Buffer.from('text frame'), false);
  assert.equal(s.closed, null);
  assert.equal(s.sent.length, before);
});

test('Ending the room closes every signalling socket in it, and leaves nothing waiting', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // The real rooms, wired the way the server wires them: whatever closes a room tells the signalling.
  let ipx = null;
  const rooms = new NetplayRooms({ onClose: (room) => ipx.closeRoom(room.code) });
  ipx = new IpxSignaling({ rooms });
  const { code } = rooms.create({ gameId: 'd1', versionId: 'd1-0', title: 'DOOM', mode: 'ipx' });
  const host = join(ipx, rooms, { isHost: true, code });
  host.socket.say(aliasRegister({ alias: HOST_ALIAS }));
  const friend = join(ipx, rooms, { code });
  assert.equal(rooms.info(code).open, true);

  assert.equal(rooms.end(code), true);
  assert.deepEqual(host.socket.closed, { code: 1000, reason: 'room ended' });
  assert.deepEqual(friend.socket.closed, { code: 1000, reason: 'room ended' });
  assert.equal(ipx.size, 0);
  assert.equal(ipx.catalogs.size, 0);

  // The sockets' close events arrive afterwards and find nothing to do: no grace timer for a host
  // whose room has already gone.
  host.socket.hangUp();
  friend.socket.hangUp();
  assert.equal(ipx.hostAway.size, 0);
  assert.equal(ipx.check({ code, key: null }), null, 'and nobody gets back in');
});

test('A room that times out before its host arrives closes the friends already waiting in it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ipx = null;
  const rooms = new NetplayRooms({ startMs: 1000, onClose: (room) => ipx.closeRoom(room.code) });
  ipx = new IpxSignaling({ rooms });
  const { code } = rooms.create({ gameId: 'd1', versionId: 'd1-0', title: 'DOOM', mode: 'ipx' });
  const early = join(ipx, rooms, { code });
  t.mock.timers.tick(1001);
  assert.equal(rooms.info(code), null);
  assert.equal(early.socket.closed.reason, 'room ended');
  assert.equal(ipx.size, 0);
});

test('A host leaving for good still ends the room the way it did', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ipx = null;
  const rooms = new NetplayRooms({ onClose: (room) => ipx.closeRoom(room.code) });
  ipx = new IpxSignaling({ rooms });
  const { code } = rooms.create({ gameId: 'd1', versionId: 'd1-0', title: 'DOOM', mode: 'ipx' });
  const host = join(ipx, rooms, { isHost: true, code });
  const friend = join(ipx, rooms, { code });
  host.socket.hangUp();
  t.mock.timers.tick(HOST_GRACE_MS + 1);
  assert.equal(rooms.info(code), null);
  assert.equal(friend.socket.closed.reason, 'host left');
});

test('Names are short, and a peer holds only a few', () => {
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const friend = join(ipx, rooms);
  friend.socket.say(aliasRegister({ alias: 'x'.repeat(65) }));
  friend.socket.say(aliasQuery({ query: '' }));
  assert.deepEqual(friend.socket.last().records, [], 'a name that long is ignored');

  for (let i = 0; i < 12; i += 1) friend.socket.say(aliasRegister({ alias: `name${i}` }));
  friend.socket.say(aliasQuery({ query: 'name' }));
  assert.equal(friend.socket.last().records.length, 8);
  // Giving one up makes room for another.
  friend.socket.say(aliasUnregister({ alias: 'name0' }));
  friend.socket.say(aliasRegister({ alias: 'name11' }));
  friend.socket.say(aliasLookup({ alias: 'name11' }));
  assert.equal(friend.socket.last().peerId, friend.peerId);
});

test('A socket that never says hello holds a place for a while, then is closed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms, maxPeersPerRoom: 2 });
  const silent = socket();
  ipx.add(silent, ipx.check({ code: 'r1' }));
  join(ipx, rooms, { isHost: true });
  const third = socket();
  assert.equal(ipx.add(third, ipx.check({ code: 'r1' })), null, 'the silent socket counts toward the room\'s limit');
  assert.equal(third.closed.code, 1013);

  t.mock.timers.tick(HELLO_TIMEOUT_MS + 1);
  assert.deepEqual(silent.closed, { code: 1002, reason: 'hello first' });
  silent.hangUp();
  const later = join(ipx, rooms);
  assert.equal(later.socket.closed, null, 'its place is free again');
});

test('Every socket is pinged, and one that stops answering is dropped', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const host = join(ipx, rooms, { isHost: true });
  const friend = join(ipx, rooms);

  t.mock.timers.tick(HEARTBEAT_MS);
  assert.equal(host.socket.pings, 1);
  assert.equal(friend.socket.pings, 1);
  host.socket.pong();
  t.mock.timers.tick(HEARTBEAT_MS);
  assert.equal(host.socket.terminated, false, 'it answered');
  assert.equal(host.socket.pings, 2);
  assert.equal(friend.socket.terminated, true, 'it didn\'t');

  // Once nothing is connected, nothing is pinged.
  host.socket.hangUp();
  friend.socket.hangUp();
  assert.equal(ipx.heartbeat, null);
});

test('A host back on a new socket takes its name from the old one that hasn\'t gone yet', () => {
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const stale = join(ipx, rooms, { isHost: true });
  stale.socket.say(aliasRegister({ alias: HOST_ALIAS }));
  const friend = join(ipx, rooms);
  friend.socket.say(aliasRegister({ alias: 'mine' }));

  const again = join(ipx, rooms, { isHost: true });
  again.socket.say(aliasRegister({ alias: HOST_ALIAS }));
  friend.socket.say(aliasLookup({ alias: HOST_ALIAS }));
  assert.equal(friend.socket.last().peerId, again.peerId);

  // Only the host's name changes hands like that.
  again.socket.say(aliasRegister({ alias: 'mine' }));
  friend.socket.say(aliasLookup({ alias: 'mine' }));
  assert.equal(friend.socket.last().peerId, friend.peerId);

  // The old socket going at last doesn't take the name with it.
  stale.socket.hangUp();
  friend.socket.say(aliasLookup({ alias: HOST_ALIAS }));
  assert.equal(friend.socket.last().peerId, again.peerId);
});

test('The session log numbers the host 1 and the friends after it, whoever says hello first', () => {
  const rooms = roomStore(ROOM);
  const ipx = new IpxSignaling({ rooms });
  const friend = join(ipx, rooms);
  assert.equal(friend.peerId, 1, 'the friend got here first');
  const host = join(ipx, rooms, { isHost: true });
  // A reload: the host says hello again on a new socket.
  host.socket.hangUp();
  join(ipx, rooms, { isHost: true });
  friend.socket.hangUp();
  assert.deepEqual(rooms.events, [[2, 'joined'], [1, 'started the game'], [1, 'reconnected'], [2, 'left']]);
});
