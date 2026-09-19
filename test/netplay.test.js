import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetplayRooms, cleanName } from '../server/lib/netplay.js';

/** A stand-in for a page's socket: remembers what it was sent and whether it was closed. */
function socket() {
  const s = { sent: [], closed: false };
  s.emit = (event, data) => s.sent.push([event, data]);
  s.disconnect = () => { s.closed = true; };
  s.last = () => s.sent[s.sent.length - 1];
  return s;
}

const extra = (sessionid, userid, name) => ({ domain: 'games.example', game_id: 7, room_name: 'x', player_name: name, userid, sessionid });

test('A room is opened by its host with the key, joined by friends in order, and full at 4', () => {
  const rooms = new NetplayRooms();
  const { code, key } = rooms.create({ gameId: 'g1', versionId: 'g1-0', title: 'Contra', platform: 'NES', hostName: '  Jeff  ' });
  assert.match(code, /^[\w-]{12}$/);
  assert.deepEqual(rooms.info(code), { title: 'Contra', platform: 'NES', engine: 'emulatorjs', input: 'pad', gameId: 'g1', versionId: 'g1-0', cover: null, hostName: 'Jeff', mode: 'lockstep', open: false, players: 0, max: 4, full: false, iceServers: [] });
  // An arcade game's friends open MAME's player instead of EmulatorJS's (see public/js/join.js).
  assert.equal(rooms.info(rooms.create({ gameId: 'g5', versionId: 'g5-0', title: 'Final Fight', engine: 'mame', mode: 'rollback' }).code).engine, 'mame');
  // An Apple IIgs game's friends send their keyboard and mouse; anything else is a controller.
  assert.equal(rooms.info(rooms.create({ gameId: 'g6', versionId: 'g6-0', title: 'Arkanoid', engine: 'mame', input: 'keyboard', mode: 'stream' }).code).input, 'keyboard');
  assert.equal(rooms.info(rooms.create({ gameId: 'g7', versionId: 'g7-0', title: 'Contra', input: 'joystick' }).code).input, 'pad');
  assert.equal(rooms.info(rooms.create({ gameId: 'g2', versionId: 'g2-0', title: 'Contra', mode: 'rollback' }).code).mode, 'rollback');
  assert.equal(rooms.info(rooms.create({ gameId: 'g3', versionId: 'g3-0', title: 'Contra', mode: 'nonsense' }).code).mode, 'lockstep');
  assert.equal(rooms.info(rooms.create({ gameId: 'g4', versionId: 'g4-0', title: 'Contra', mode: 'stream' }).code).mode, 'stream');
  assert.equal(rooms.info('nope'), null);

  const host = socket();
  assert.throws(() => rooms.open({ extra: extra(code, 'h', 'Jeff'), key: 'wrong' }, host), /NOT_THE_HOST/);
  assert.throws(() => rooms.open({ extra: extra('other', 'h', 'Jeff'), key }, host), /NO_SUCH_ROOM/);
  rooms.open({ extra: extra(code, 'h', 'Jeff'), key }, host);
  assert.equal(rooms.info(code).open, true);
  assert.throws(() => rooms.open({ extra: extra(code, 'h2', 'Jeff'), key }, socket()), /ROOM_ALREADY_OPEN/);

  const friends = [socket(), socket(), socket()];
  const users = friends.map((s, i) => rooms.join({ extra: extra(code, `f${i}`, i === 1 ? '' : `Friend ${i}`) }, s));
  assert.deepEqual(Object.keys(users[2]), ['h', 'f0', 'f1', 'f2'], 'the owner first, then the friends in order');
  assert.equal(users[2].f1.player_name, 'Player');
  assert.equal(users[2].f0.sessionid, code);
  assert.deepEqual(host.last(), ['users-updated', users[2]], 'everyone hears the room change');
  assert.deepEqual(friends[0].last(), ['users-updated', users[2]]);
  assert.equal(rooms.info(code).full, true);
  assert.throws(() => rooms.join({ extra: extra(code, 'f3', 'One more') }, socket()), /ROOM_FULL/);
  assert.deepEqual(rooms.placeOf(friends[1]), { room: rooms.rooms.get(code), player: 3 });
  assert.equal(rooms.placeOf(socket()), null);

  // A friend leaves; the rest are told, and the next friend takes the free place.
  rooms.leave(friends[1]);
  assert.deepEqual(Object.keys(host.last()[1]), ['h', 'f0', 'f2']);
  assert.equal(rooms.info(code).players, 3);
  rooms.join({ extra: extra(code, 'f4', 'Late') }, socket());
  assert.equal(rooms.info(code).players, 4);
});

test('Messages go to every other player in the room; a signal goes to the one player it names', () => {
  const rooms = new NetplayRooms({ iceServers: [{ urls: 'stun:example' }] });
  const { code, key } = rooms.create({ gameId: 'g', versionId: 'v', title: 'T' });
  assert.deepEqual(rooms.info(code).iceServers, [{ urls: 'stun:example' }]);
  const host = socket();
  const a = socket();
  const b = socket();
  assert.throws(() => rooms.join({ extra: extra(code, 'a', 'A') }, a), /NO_SUCH_ROOM/, 'not before the host has opened it');
  rooms.open({ extra: extra(code, 'h', 'H'), key }, host);
  rooms.join({ extra: extra(code, 'a', 'A') }, a);
  rooms.join({ extra: extra(code, 'b', 'B') }, b);
  const before = { host: host.sent.length, a: a.sent.length, b: b.sent.length };

  assert.equal(rooms.relay(host, { t: 'f', f: 10 }), true);
  assert.deepEqual(a.last(), ['data-message', { t: 'f', f: 10, sentBy: 'h' }]);
  assert.deepEqual(b.last(), ['data-message', { t: 'f', f: 10, sentBy: 'h' }]);
  assert.equal(host.sent.length, before.host, 'not back to the sender');

  assert.equal(rooms.relay(a, { t: 'f', f: 11 }), true);
  assert.deepEqual(host.last(), ['data-message', { t: 'f', f: 11, sentBy: 'a' }]);
  assert.deepEqual(b.last(), ['data-message', { t: 'f', f: 11, sentBy: 'a' }], 'a friend\'s message reaches the other friend too');

  // The server says who sent it, whatever the message claims; `from` (a player's number in
  // rollback's messages) is passed on as it was.
  rooms.relay(a, { t: 'i', from: 'b', sentBy: 'b' });
  assert.deepEqual(host.last(), ['data-message', { t: 'i', from: 'b', sentBy: 'a' }]);
  rooms.relay(a, { t: 'i', from: 2 });
  assert.deepEqual(b.last(), ['data-message', { t: 'i', from: 2, sentBy: 'a' }]);
  const bytes = new Uint8Array([1, 2]);
  rooms.relay(a, bytes);
  assert.equal(host.last()[1], bytes, 'anything but a plain object passes as it is');
  rooms.relay(a, [1, 2]);
  assert.deepEqual(host.last()[1], [1, 2]);
  assert.equal(rooms.relay(socket(), { ready: true }), false, 'a socket in no room');

  assert.equal(rooms.signal(a, 'b', { sdp: 'offer' }), true);
  assert.deepEqual(b.last(), ['signal', { from: 'a', data: { sdp: 'offer' } }]);
  assert.equal(host.last()[0], 'data-message', 'nobody else hears it');
  assert.equal(rooms.signal(a, 'nobody', { sdp: 'x' }), false);
  assert.equal(rooms.signal(a, 'b', 'not an object'), false);
  assert.equal(rooms.signal(socket(), 'b', { sdp: 'x' }), false);
});

test('The owner leaving ends the room and closes the friends; a friend leaving frees a place', () => {
  const rooms = new NetplayRooms();
  const { code, key } = rooms.create({ gameId: 'g', versionId: 'v', title: 'T' });
  const host = socket();
  const a = socket();
  rooms.open({ extra: extra(code, 'h', 'H'), key }, host);
  rooms.join({ extra: extra(code, 'a', 'A') }, a);
  rooms.leave(host);
  assert.equal(a.closed, true);
  assert.equal(host.closed, false, 'the owner\'s own socket is already gone');
  assert.equal(rooms.info(code), null);
  assert.equal(rooms.relay(a, {}), false);
  rooms.leave(a); // noticed late: nothing to do
  assert.equal(rooms.size, 0);
});

test('A room nobody opens goes after its wait; an opened one stays', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rooms = new NetplayRooms({ startMs: 20 });
  const never = rooms.create({ gameId: 'g', versionId: 'v', title: 'T' });
  const { code, key } = rooms.create({ gameId: 'g', versionId: 'v', title: 'T' });
  rooms.open({ extra: extra(code, 'h', 'H'), key }, socket());
  t.mock.timers.tick(40);
  assert.equal(rooms.info(never.code), null);
  assert.ok(rooms.info(code));
});

test('The grant covers the room\'s version while the room lasts', () => {
  const rooms = new NetplayRooms();
  const { code, key } = rooms.create({ gameId: 'g', versionId: 'v-1', title: 'Tetris', hostName: 'Ann' });
  assert.equal(rooms.grants(code, 'v-1'), true, 'before the host opens it too: the friend\'s page loads the game first');
  assert.equal(rooms.grants(code, 'v-2'), false);
  assert.equal(rooms.grants(code), true, 'any file of the room\'s game');
  assert.equal(rooms.grants('nope', 'v-1'), false);
  const host = socket();
  rooms.open({ extra: extra(code, 'h', 'Ann'), key }, host);
  rooms.leave(host);
  assert.equal(rooms.grants(code, 'v-1'), false, 'gone with the room');
});

test('Nothing hands out the open rooms, since a code is the invite', () => {
  // A room browser would let anyone join a private game, and fetch its files (see roomGrant).
  const rooms = new NetplayRooms();
  rooms.create({ gameId: 'g', versionId: 'v-1', title: 'Tetris', hostName: 'Ann' });
  assert.equal(typeof rooms.list, 'undefined', 'no room listing on the rooms');
});

test('Room creation stops at the limit', () => {
  const rooms = new NetplayRooms({ maxRooms: 2 });
  rooms.create({ gameId: 'a', versionId: 'a', title: 'A' });
  rooms.create({ gameId: 'b', versionId: 'b', title: 'B' });
  assert.throws(() => rooms.create({ gameId: 'c', versionId: 'c', title: 'C' }), /Too many/);
  assert.equal(rooms.size, 2);
});

test('cleanName trims, collapses and caps a name, and falls back when nothing is left', () => {
  assert.equal(cleanName('  Ann   Lee\n', 'x'), 'Ann Lee');
  assert.equal(cleanName('\u0000​', 'Player 2'), 'Player 2');
  assert.equal(cleanName('a'.repeat(60), 'x').length, 40);
  assert.equal(cleanName(undefined, 'The host'), 'The host');
});

test('An IPX room is opened by its signalling socket, not by a player socket', () => {
  const rooms = new NetplayRooms();
  const { code, key } = rooms.create({ gameId: 'd1', versionId: 'd1-0', title: 'DOOM', platform: 'MS-DOS', mode: 'ipx' });
  assert.equal(rooms.info(code).mode, 'ipx');
  assert.equal(rooms.info(code).open, false);
  assert.equal(rooms.roomFor(code).key, key);
  assert.equal(rooms.roomFor('nope'), null);

  // The players of an IPX room never join over this server, so the count is told to it.
  assert.equal(rooms.openIpx(code).code, code);
  assert.equal(rooms.info(code).open, true);
  assert.equal(rooms.openIpx(code), null, 'a room only opens once');
  rooms.setIpxPlayers(code, 3);
  assert.equal(rooms.info(code).players, 3);
  assert.equal(rooms.info(code).full, false);
  rooms.setIpxPlayers(code, 4);
  assert.equal(rooms.info(code).full, true);

  // The game's files stay fetchable with the link, as they are for a console room.
  assert.equal(rooms.grants(code, 'd1-0'), true);
  rooms.closeIpx(code);
  assert.equal(rooms.info(code), null);
  assert.equal(rooms.grants(code, 'd1-0'), false);
});

test('The IPX hooks leave rooms of other kinds alone', () => {
  const rooms = new NetplayRooms();
  const { code } = rooms.create({ gameId: 'c1', versionId: 'c1-0', title: 'Contra', mode: 'rollback' });
  assert.equal(rooms.openIpx(code), null);
  rooms.setIpxPlayers(code, 3);
  assert.equal(rooms.info(code).players, 0);
  rooms.closeIpx(code);
  assert.ok(rooms.info(code), 'still there');
});

test('An IPX room can\'t be opened or joined over the player socket', () => {
  const rooms = new NetplayRooms();
  const { code, key } = rooms.create({ gameId: 'd1', versionId: 'd1-0', title: 'DOOM', mode: 'ipx' });
  assert.throws(() => rooms.open({ extra: extra(code, 'h', 'H'), key }, socket()), /NO_SUCH_ROOM/, 'not even with the host\'s key');
  rooms.openIpx(code);
  // Someone calling itself the IPX host would end the room on leaving.
  const mallory = socket();
  assert.throws(() => rooms.join({ extra: extra(code, 'ipx-host', 'Mallory') }, mallory), /NO_SUCH_ROOM/);
  rooms.leave(mallory);
  assert.equal(rooms.info(code).open, true);
  assert.deepEqual(rooms.adminList()[0].names, []);
});

test('A player\'s id is kept short, and game_id is only ever a number', () => {
  const rooms = new NetplayRooms();
  const { code, key } = rooms.create({ gameId: 'g', versionId: 'v', title: 'T' });
  assert.throws(() => rooms.open({ extra: extra(code, 'h'.repeat(65), 'H'), key }, socket()), /BAD_PLAYER/);
  assert.equal(rooms.info(code).open, false, 'a refused host opens nothing');
  const host = socket();
  rooms.open({ extra: { ...extra(code, 'h', 'H'), game_id: 'x'.repeat(1000) }, key }, host);
  assert.equal(rooms.users(rooms.roomFor(code)).h.game_id, 0);

  assert.throws(() => rooms.join({ extra: extra(code, 'f'.repeat(65), 'F') }, socket()), /BAD_PLAYER/);
  assert.throws(() => rooms.join({ extra: extra(code, '', 'F') }, socket()), /BAD_PLAYER/);
  assert.equal(rooms.info(code).players, 1, 'and changed nothing');
  assert.equal(host.sent.length, 0, 'nobody was told of a change');

  // A clash gives the newcomer a new id, and its record says the one it's kept under.
  const users = rooms.join({ extra: extra(code, 'h', 'Twin') }, socket());
  const [, twin] = Object.keys(users);
  assert.notEqual(twin, 'h');
  assert.equal(users[twin].userid, twin);
  assert.equal(users[twin].game_id, 7);
});

test('A socket that asks to join twice keeps its one place', () => {
  const rooms = new NetplayRooms();
  const { code, key } = rooms.create({ gameId: 'g', versionId: 'v', title: 'T' });
  const host = socket();
  rooms.open({ extra: extra(code, 'h', 'H'), key }, host);
  const friend = socket();
  rooms.join({ extra: extra(code, 'f', 'F') }, friend);
  const again = rooms.join({ extra: extra(code, 'f', 'F') }, friend);
  assert.deepEqual(Object.keys(again), ['h', 'f']);
  rooms.leave(friend);
  assert.equal(rooms.info(code).players, 1, 'nobody left behind');

  // The host's own socket joining its room doesn't make it a friend that leaves the room behind.
  assert.deepEqual(Object.keys(rooms.join({ extra: extra(code, 'h2', 'H') }, host)), ['h']);
  assert.throws(() => rooms.open({ extra: extra(code, 'h', 'H'), key }, host), /ROOM_ALREADY_OPEN|ALREADY_IN_ROOM/);
  rooms.leave(host);
  assert.equal(rooms.info(code), null);

  // Nor can one socket be in two rooms.
  const other = rooms.create({ gameId: 'g', versionId: 'v', title: 'T' });
  const third = rooms.create({ gameId: 'g', versionId: 'v', title: 'T' });
  rooms.open({ extra: extra(other.code, 'h', 'H'), key: other.key }, socket());
  rooms.open({ extra: extra(third.code, 'h', 'H'), key: third.key }, socket());
  const roamer = socket();
  rooms.join({ extra: extra(other.code, 'r', 'R') }, roamer);
  assert.throws(() => rooms.join({ extra: extra(third.code, 'r', 'R') }, roamer), /ALREADY_IN_ROOM/);
  assert.throws(() => rooms.open({ extra: extra(third.code, 'r', 'R'), key: third.key }, roamer), /ROOM_ALREADY_OPEN|ALREADY_IN_ROOM/);
});

test('Ending a room from the admin page disconnects everyone and takes the grant with it', () => {
  const closed = [];
  const rooms = new NetplayRooms({ onClose: (room) => closed.push(room.code) });
  const { code, key } = rooms.create({ gameId: 'g', versionId: 'v', title: 'Contra', hostName: 'Ann' });
  const host = socket();
  const friend = socket();
  rooms.open({ extra: extra(code, 'h', 'Ann'), key }, host);
  rooms.join({ extra: extra(code, 'f', 'Bo') }, friend);

  assert.equal(rooms.end('nope'), false);
  assert.equal(rooms.end(code), true);
  assert.equal(host.closed, true);
  assert.equal(friend.closed, true);
  assert.equal(rooms.grants(code, 'v'), false);
  assert.equal(rooms.info(code), null);
  assert.deepEqual(closed, [code], 'whoever tidies up after rooms hears of it');
  assert.equal(rooms.end(code), false, 'only once');
});

test('The admin list shows every room, newest first, with its players', (t) => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const rooms = new NetplayRooms();
  const older = rooms.create({ gameId: 'g', versionId: 'v', title: 'Contra', hostName: 'Ann', hostEmail: 'Ann@Example.com', mode: 'rollback' });
  rooms.open({ extra: extra(older.code, 'h', 'Ann'), key: older.key }, socket());
  rooms.join({ extra: extra(older.code, 'f', '  Bo  ') }, socket());
  now += 1000;
  const newer = rooms.create({ gameId: 'd', versionId: 'd-0', title: 'DOOM', mode: 'ipx' });
  rooms.openIpx(newer.code);
  rooms.setIpxPlayers(newer.code, 3);

  const list = rooms.adminList();
  assert.deepEqual(list.map((r) => r.code), [newer.code, older.code]);
  assert.deepEqual(list[1], {
    code: older.code, title: 'Contra', platform: '', mode: 'rollback', hostName: 'Ann', hostEmail: 'ann@example.com',
    open: true, players: 2, names: ['Ann', 'Bo'], max: 4, created: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(list[0].players, 3, 'an IPX room counts its signalling peers');
  assert.equal(list[0].hostEmail, null);
  assert.equal('hostEmail' in rooms.info(older.code), false, 'the link never gives out the host\'s address');
});

test('Taking an account\'s access away ends the rooms it is hosting, and only those', () => {
  const rooms = new NetplayRooms();
  const ann = rooms.create({ gameId: 'g', versionId: 'v', title: 'Contra', hostEmail: 'ann@x' });
  const annWaiting = rooms.create({ gameId: 'g', versionId: 'v', title: 'Contra', hostEmail: 'ann@x' });
  const bo = rooms.create({ gameId: 'g', versionId: 'v', title: 'Contra', hostEmail: 'bo@x' });
  const guest = rooms.create({ gameId: 'g', versionId: 'v', title: 'Contra' });
  const annHost = socket();
  const annFriend = socket();
  rooms.open({ extra: extra(ann.code, 'h', 'Ann'), key: ann.key }, annHost);
  rooms.join({ extra: extra(ann.code, 'f', 'F') }, annFriend);

  assert.equal(rooms.endRoomsOf('  ANN@x '), 2, 'the open one and the one still waiting for its host');
  assert.equal(annHost.closed, true);
  assert.equal(annFriend.closed, true);
  assert.equal(rooms.grants(ann.code, 'v'), false);
  assert.equal(rooms.info(annWaiting.code), null);
  assert.ok(rooms.info(bo.code));
  assert.ok(rooms.info(guest.code));
  assert.equal(rooms.endRoomsOf(''), 0, 'rooms hosted without an account aren\'t anybody\'s');
  assert.equal(rooms.endRoomsOf(null), 0);
  assert.ok(rooms.info(guest.code));
});
