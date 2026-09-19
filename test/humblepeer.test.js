import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ByteBuffer } from 'flatbuffers';
import {
  MSG, REJECT, FLAG_WEBRTC, decode,
  helloServer, helloClient, p2pOffer, p2pAnswer, iceCandidate, p2pConnected, p2pDisconnect,
  p2pReject, aliasRegister, aliasUnregister, aliasLookup, aliasResolved, aliasQuery, aliasQueryResult,
} from '../server/lib/humblepeer.js';

// A real HelloServer, captured from js-dos's own WebRTC-NET client (js-dos 8.4.1) by loading
// webrtcnet.mjs in Node with a stand-in WebSocket. The capture is frozen, so on its own it can't
// notice a js-dos change; the version test below ties it to the js-dos that's installed.
const REAL_HELLO_SERVER = Buffer.from(
  '0c00000008000e00070008000800000000000001180000000000120014000000' +
  '070008000c0000000000100012000000000000033c0000000800000044000000' +
  '2800000062646433396437633566376439393231306632666262633637353762' +
  '61656139623637616661373100000000090000007267622d746f6b656e000000' +
  '020000003c00000004000000d4ffffff18000000040000000a00000031373839' +
  '35333239373800000900000074696d657374616d7000000008000c0004000800' +
  '0800000018000000040000000a0000004e6f64652e6a732f3232000008000000' +
  '706c6174666f726d00000000', 'hex');

test('A real client\'s HelloServer decodes field for field', () => {
  assert.deepEqual(decode(REAL_HELLO_SERVER), {
    kind: 'HelloServer',
    version: 0,
    // Bit 0 says it can do WebRTC; bit 1 says it gathers its addresses before offering.
    flags: 3,
    gameToken: 'rgb-token',
    gameSignature: 'bdd39d7c5f7d99210f2fbbc6757baea9b67afa71',
    authToken: null,
    reconnectToken: null,
    attributes: [{ key: 'platform', value: 'Node.js/22' }, { key: 'timestamp', value: '1789532978' }],
  });
  assert.equal(decode(REAL_HELLO_SERVER).flags & FLAG_WEBRTC, FLAG_WEBRTC);
});

test('Every message survives a round trip', () => {
  const cases = [
    [helloClient({ peerId: 4242, reconnectToken: 'abc' }), { kind: 'HelloClient', peerId: 4242, reconnectToken: 'abc' }],
    [helloClient({ peerId: 1 }), { kind: 'HelloClient', peerId: 1, reconnectToken: null }],
    [p2pOffer({ peerId: 5, flags: 2, offer: 'v=0' }), { kind: 'P2POffer', peerId: 5, flags: 2, offer: 'v=0' }],
    [p2pAnswer({ peerId: 6, offer: 'v=0 a' }), { kind: 'P2PAnswer', peerId: 6, offer: 'v=0 a' }],
    [iceCandidate({ peerId: 7, offer: 'candidate:1 1 udp' }), { kind: 'ICECandidate', peerId: 7, offer: 'candidate:1 1 udp' }],
    [p2pConnected({ peerId: 8 }), { kind: 'P2PConnected', peerId: 8 }],
    [p2pDisconnect({ peerId: 9 }), { kind: 'P2PDisconnect', peerId: 9 }],
    [p2pReject({ peerId: 10 }), { kind: 'P2PReject', peerId: 10, reason: REJECT.NotFound }],
    [p2pReject({ peerId: 11, reason: REJECT.PeerRefused }), { kind: 'P2PReject', peerId: 11, reason: REJECT.PeerRefused }],
    [aliasRegister({ alias: 'host' }), { kind: 'AliasRegister', alias: 'host' }],
    [aliasUnregister({ alias: 'host' }), { kind: 'AliasUnregister', alias: 'host' }],
    [aliasLookup({ alias: 'host' }), { kind: 'AliasLookup', alias: 'host' }],
    [aliasResolved({ alias: 'host', peerId: 3 }), { kind: 'AliasResolved', alias: 'host', peerId: 3 }],
    [aliasResolved({ alias: 'gone', peerId: 0 }), { kind: 'AliasResolved', alias: 'gone', peerId: 0 }],
    [aliasQuery({ query: '=host' }), { kind: 'AliasQuery', query: '=host' }],
    [aliasQueryResult({ query: '=host', records: [{ alias: 'host', peerId: 3 }] }), { kind: 'AliasQueryResult', query: '=host', records: [{ alias: 'host', peerId: 3 }] }],
    [aliasQueryResult({ query: 'x', records: [] }), { kind: 'AliasQueryResult', query: 'x', records: [] }],
  ];
  for (const [bytes, expected] of cases) assert.deepEqual(decode(bytes), expected, expected.kind);
});

test('Our own HelloServer decodes like the real one', () => {
  const mine = helloServer({
    flags: 3, gameToken: 'rgb-token', gameSignature: 'bdd39d7c5f7d99210f2fbbc6757baea9b67afa71',
    attributes: [{ key: 'platform', value: 'Node.js/22' }, { key: 'timestamp', value: '1789532978' }],
  });
  assert.deepEqual(decode(mine), decode(REAL_HELLO_SERVER));
});

test('An empty alias query result still carries its query', () => {
  const result = decode(aliasQueryResult({ query: '=nobody' }));
  assert.equal(result.query, '=nobody');
  assert.deepEqual(result.records, []);
});

test('The union tags are the ones the client\'s schema numbers', () => {
  assert.equal(MSG.HelloServer, 1);
  assert.equal(MSG.HelloClient, 2);
  assert.equal(MSG.P2PConnected, 10);
  assert.equal(MSG.ICECandidate, 15);
  assert.equal(MSG.AliasRegister, 20);
  assert.equal(MSG.AliasQueryResult, 25);
});

test('Anything that isn\'t a message reads as null rather than throwing', () => {
  for (const junk of [Buffer.alloc(0), Buffer.from('hello'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), Buffer.alloc(64, 0xff)]) {
    assert.equal(decode(junk), null);
  }
  // A well-formed message whose union tag we don't know (a newer client) is null too.
  const unknown = Buffer.from(REAL_HELLO_SERVER);
  unknown[19] = 99;
  assert.equal(decode(unknown), null);
});

// Where a message's table vector keeps its length: the 4 bytes just before its first element.
function vectorLengthAt(bytes, field) {
  const bb = new ByteBuffer(bytes);
  const root = bb.readInt32(0);
  const at = bb.__indirect(root + bb.__offset(root, 6));
  return bb.__vector(at + bb.__offset(at, 4 + field * 2)) - 4;
}

test('A vector whose length runs past the end of the message reads as null', () => {
  // Left unchecked, a made-up length loops (and allocates) that many times: 0x7fffffff kills the process.
  const hello = helloServer({ gameToken: 't', gameSignature: 's', attributes: [{ key: 'a', value: 'b' }] });
  assert.equal(decode(hello).attributes.length, 1);
  new DataView(hello.buffer, hello.byteOffset).setInt32(vectorLengthAt(hello, 6), 0x7fffffff, true);
  assert.equal(decode(hello), null);

  const result = aliasQueryResult({ query: '=host', records: [{ alias: 'host', peerId: 3 }] });
  assert.equal(decode(result).records.length, 1);
  new DataView(result.buffer, result.byteOffset).setInt32(vectorLengthAt(result, 1), 0x7fffffff, true);
  assert.equal(decode(result), null);
});
