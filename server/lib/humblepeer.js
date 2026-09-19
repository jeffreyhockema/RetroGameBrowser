// The humblepeer signaling protocol, as js-dos's networking client speaks it.
//
// js-dos 8.4 runs DOS multiplayer over IPX (see lib/ipx.js): each player's emulator carries
// IPX packets to the others over WebRTC data channels, and the only thing it needs from a
// server is the introduction — who else is here, and the offers, answers and ICE candidates
// two browsers swap to find a path to each other. That introduction is HumbleNet's
// "humblepeer" protocol, which js-dos inherited from its WebRTC-NET fork of HumbleNet:
// FlatBuffers messages over a WebSocket whose subprotocol is literally "humblepeer".
//
// Every message is a `Message` table holding one member of a union, so the wire format is a
// one-byte tag plus the message's own table. The tags and fields below are WebRTC-NET's
// humblepeer.fbs (https://github.com/caiiiycuk/WebRTC-NET), which differs from HumbleNet's
// original in two ways that matter: it drops P2PRelayData and the ICE servers in HelloClient
// (js-dos passes those in from the page instead), and it adds the alias queries js-dos uses
// to find a room by name.
//
// This module is only the codec; lib/ipx.js is the server that acts on the messages.

import { Builder, ByteBuffer } from 'flatbuffers';

/** The `MessageType` union tags. The gaps are the schema's: it numbers the groups by hand. */
export const MSG = {
  HelloServer: 1,
  HelloClient: 2,
  P2PConnected: 10,
  P2PDisconnect: 11,
  P2POffer: 12,
  P2PAnswer: 13,
  P2PReject: 14,
  ICECandidate: 15,
  AliasRegister: 20,
  AliasUnregister: 21,
  AliasLookup: 22,
  AliasResolved: 23,
  AliasQuery: 24,
  AliasQueryResult: 25,
};

/** Tag -> name, for logs and for the `kind` of a decoded message. */
export const MSG_NAME = Object.fromEntries(Object.entries(MSG).map(([name, tag]) => [tag, name]));

/** Why a peer connection was refused (`P2PRejectReason`). */
export const REJECT = { NotFound: 1, PeerRefused: 2 };

/** A client says it can do WebRTC with bit 0 of HelloServer's flags; without it we refuse it. */
export const FLAG_WEBRTC = 0x1;
/** Bit 1 says the client gathers all its ICE candidates before offering, rather than trickling. */
export const FLAG_NO_TRICKLE = 0x2;
/** A P2POffer with bit 0 wants a relayed ("emulated") connection, which this server won't do. */
export const FLAG_EMULATED = 0x1;

// A table's fields are addressed by their slot in its vtable: field `i` lives at this offset.
const vo = (i) => 4 + i * 2;

const readU32 = (bb, at, i, fallback = 0) => {
  const o = bb.__offset(at, vo(i));
  return o ? bb.readUint32(at + o) : fallback;
};
const readU8 = (bb, at, i, fallback = 0) => {
  const o = bb.__offset(at, vo(i));
  return o ? bb.readUint8(at + o) : fallback;
};
const readStr = (bb, at, i) => {
  const o = bb.__offset(at, vo(i));
  return o ? bb.__string(at + o) : null;
};
const readTables = (bb, at, i, read) => {
  const o = bb.__offset(at, vo(i));
  if (!o) return [];
  const start = bb.__vector(at + o);
  const count = bb.__vector_len(at + o);
  // The length comes off the wire, and ByteBuffer reads past the end as zeros instead of throwing,
  // so a made-up length would loop, and allocate, billions of times. A real vector fits in the message.
  if (count < 0 || start < 0 || start + count * 4 > bb.capacity()) throw new RangeError('vector runs past the end');
  const out = [];
  for (let n = 0; n < count; n += 1) out.push(read(bb, bb.__indirect(start + n * 4)));
  return out;
};

const readAttribute = (bb, at) => ({ key: readStr(bb, at, 0), value: readStr(bb, at, 1) });
const readAliasRecord = (bb, at) => ({ alias: readStr(bb, at, 0), peerId: readU32(bb, at, 1) });

/**
 * Reads one message. Returns `{ kind, ...fields }`, where `kind` is a name from MSG, or null
 * when the bytes aren't a message this protocol has (a client on a newer schema, or junk).
 * Throws nothing: anything malformed comes back as null, since this reads from the network.
 */
export function decode(bytes) {
  try {
    const bb = new ByteBuffer(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const root = bb.readInt32(bb.position()) + bb.position();
    const tag = readU8(bb, root, 0);
    const kind = MSG_NAME[tag];
    if (!kind) return null;
    const o = bb.__offset(root, vo(1));
    if (!o) return null;
    const at = bb.__indirect(root + o);
    switch (tag) {
      case MSG.HelloServer:
        return {
          kind,
          version: readU32(bb, at, 0),
          flags: readU8(bb, at, 1),
          gameToken: readStr(bb, at, 2),
          gameSignature: readStr(bb, at, 3),
          authToken: readStr(bb, at, 4),
          reconnectToken: readStr(bb, at, 5),
          attributes: readTables(bb, at, 6, readAttribute),
        };
      case MSG.HelloClient:
        return { kind, peerId: readU32(bb, at, 0), reconnectToken: readStr(bb, at, 1) };
      case MSG.P2POffer:
        return { kind, peerId: readU32(bb, at, 0), flags: readU8(bb, at, 1), offer: readStr(bb, at, 2) };
      case MSG.P2PAnswer:
      case MSG.ICECandidate:
        return { kind, peerId: readU32(bb, at, 0), offer: readStr(bb, at, 1) };
      case MSG.P2PConnected:
      case MSG.P2PDisconnect:
        return { kind, peerId: readU32(bb, at, 0) };
      case MSG.P2PReject:
        return { kind, peerId: readU32(bb, at, 0), reason: readU8(bb, at, 1, REJECT.NotFound) };
      case MSG.AliasRegister:
      case MSG.AliasUnregister:
      case MSG.AliasLookup:
        return { kind, alias: readStr(bb, at, 0) };
      case MSG.AliasResolved:
        return { kind, alias: readStr(bb, at, 0), peerId: readU32(bb, at, 1) };
      case MSG.AliasQuery:
        return { kind, query: readStr(bb, at, 0) };
      case MSG.AliasQueryResult:
        return { kind, query: readStr(bb, at, 0), records: readTables(bb, at, 1, readAliasRecord) };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Wraps a built table as the `Message` union member `tag` and finishes the buffer. */
function wrap(b, tag, table) {
  b.startObject(2);
  b.addFieldInt8(0, tag, 0);
  b.addFieldOffset(1, table, 0);
  b.finish(b.endObject());
  return b.asUint8Array();
}

/** A vector of already-built tables, written as FlatBuffers wants it: backwards. */
function tableVector(b, offsets) {
  b.startVector(4, offsets.length, 4);
  for (let i = offsets.length - 1; i >= 0; i -= 1) b.addOffset(offsets[i]);
  return b.endVector();
}

/** "Here's who you are." The first thing the server says, in answer to HelloServer. */
export function helloClient({ peerId, reconnectToken = null }) {
  const b = new Builder(128);
  const token = reconnectToken === null ? 0 : b.createString(reconnectToken);
  b.startObject(2);
  b.addFieldInt32(0, peerId, 0);
  if (token) b.addFieldOffset(1, token, 0);
  return wrap(b, MSG.HelloClient, b.endObject());
}

/** One peer's offer, passed on with `peerId` rewritten to whoever sent it. */
export function p2pOffer({ peerId, flags = 0, offer }) {
  const b = new Builder(2048);
  const text = offer === null || offer === undefined ? 0 : b.createString(offer);
  b.startObject(3);
  b.addFieldInt32(0, peerId, 0);
  b.addFieldInt8(1, flags, 0);
  if (text) b.addFieldOffset(2, text, 0);
  return wrap(b, MSG.P2POffer, b.endObject());
}

const peerAndText = (tag) => ({ peerId, offer }) => {
  const b = new Builder(2048);
  const text = offer === null || offer === undefined ? 0 : b.createString(offer);
  b.startObject(2);
  b.addFieldInt32(0, peerId, 0);
  if (text) b.addFieldOffset(1, text, 0);
  return wrap(b, tag, b.endObject());
};

/** The answer to an offer, and the addresses each side finds as it goes. */
export const p2pAnswer = peerAndText(MSG.P2PAnswer);
export const iceCandidate = peerAndText(MSG.ICECandidate);

const peerOnly = (tag) => ({ peerId }) => {
  const b = new Builder(64);
  b.startObject(1);
  b.addFieldInt32(0, peerId, 0);
  return wrap(b, tag, b.endObject());
};

export const p2pConnected = peerOnly(MSG.P2PConnected);
export const p2pDisconnect = peerOnly(MSG.P2PDisconnect);

/** "That peer isn't here" (NotFound) or "that peer said no" (PeerRefused). */
export function p2pReject({ peerId, reason = REJECT.NotFound }) {
  const b = new Builder(64);
  b.startObject(2);
  b.addFieldInt32(0, peerId, 0);
  b.addFieldInt8(1, reason, REJECT.NotFound);
  return wrap(b, MSG.P2PReject, b.endObject());
}

/** The answer to AliasLookup: the peer holding that name, or 0 when nobody does. */
export function aliasResolved({ alias, peerId }) {
  const b = new Builder(128);
  const name = b.createString(alias);
  b.startObject(2);
  b.addFieldOffset(0, name, 0);
  b.addFieldInt32(1, peerId, 0);
  return wrap(b, MSG.AliasResolved, b.endObject());
}

/** The answer to AliasQuery: every name that matched, with the peer holding it. */
export function aliasQueryResult({ query, records = [] }) {
  const b = new Builder(512);
  const built = records.map(({ alias, peerId }) => {
    const name = b.createString(alias);
    b.startObject(2);
    b.addFieldOffset(0, name, 0);
    b.addFieldInt32(1, peerId, 0);
    return b.endObject();
  });
  const list = tableVector(b, built);
  const text = b.createString(query);
  b.startObject(2);
  b.addFieldOffset(0, text, 0);
  b.addFieldOffset(1, list, 0);
  return wrap(b, MSG.AliasQueryResult, b.endObject());
}

/**
 * The client's opening message. The server never sends this one; it's here so the tests can
 * make the message a real client would, and so the codec round-trips in both directions.
 */
export function helloServer({
  version = 0, flags = FLAG_WEBRTC, gameToken, gameSignature,
  authToken = null, reconnectToken = null, attributes = [],
}) {
  const b = new Builder(512);
  const token = b.createString(gameToken);
  const signature = b.createString(gameSignature);
  const auth = authToken === null ? 0 : b.createString(authToken);
  const reconnect = reconnectToken === null ? 0 : b.createString(reconnectToken);
  const built = attributes.map(({ key, value }) => {
    const k = b.createString(key);
    const v = b.createString(value);
    b.startObject(2);
    b.addFieldOffset(0, k, 0);
    b.addFieldOffset(1, v, 0);
    return b.endObject();
  });
  const list = tableVector(b, built);
  b.startObject(7);
  b.addFieldInt32(0, version, 0);
  b.addFieldInt8(1, flags, 0);
  b.addFieldOffset(2, token, 0);
  b.addFieldOffset(3, signature, 0);
  if (auth) b.addFieldOffset(4, auth, 0);
  if (reconnect) b.addFieldOffset(5, reconnect, 0);
  if (built.length) b.addFieldOffset(6, list, 0);
  return wrap(b, MSG.HelloServer, b.endObject());
}

const aliasOnly = (tag) => ({ alias }) => {
  const b = new Builder(128);
  const name = b.createString(alias);
  b.startObject(1);
  b.addFieldOffset(0, name, 0);
  return wrap(b, tag, b.endObject());
};

export const aliasRegister = aliasOnly(MSG.AliasRegister);
export const aliasUnregister = aliasOnly(MSG.AliasUnregister);
export const aliasLookup = aliasOnly(MSG.AliasLookup);

/** A search for names: "=x" is the one name x, anything else is every name starting with it. */
export function aliasQuery({ query }) {
  const b = new Builder(128);
  const text = b.createString(query);
  b.startObject(1);
  b.addFieldOffset(0, text, 0);
  return wrap(b, MSG.AliasQuery, b.endObject());
}
