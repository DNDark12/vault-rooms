import { b64u, fromUtf8, u32, utf8 } from "./bytes.js";
import { canonicalJson } from "./canonical.js";
import { hashTagged, open, openFromDevice, randomBytes, seal, sealToDevice, sign, verify, type KeyPair, type SealedBox } from "./crypto.js";
import { fail } from "./errors.js";
import { deviceIdFor } from "./ids.js";
import * as v from "./validate.js";
import { activeDevice, liveRoom, roleIn, type SealedName, type WorkspaceState } from "./workspace.js";

/**
 * Room keys: one random 256-bit key per key epoch. The workspace record holds only a commitment to each key.
 * A key reaches a device as a key wrap: the key sealed to that device's X25519 key, signed by the device that
 * wrapped it. The recipient checks the key against the commitment, so a member can't hand out a wrong key.
 */

export function newRoomKey(): Uint8Array {
  return randomBytes(32);
}

export function keyCommitment(workspaceId: string, roomId: string, n: number, key: Uint8Array): string {
  if (key.length !== 32) fail("bad_key");
  return b64u(hashTagged("room-key-commit", utf8(workspaceId), utf8(roomId), u32(n), key));
}

function nameAad(workspaceId: string, roomId: string, n: number): Uint8Array {
  return utf8(canonicalJson({ purpose: "room-name", ws: workspaceId, room: roomId, n }));
}

export function sealRoomName(workspaceId: string, roomId: string, n: number, key: Uint8Array, name: string): SealedName {
  v.name(name, "roomName");
  return { n, ...seal(key, utf8(name), nameAad(workspaceId, roomId, n)) };
}

export function openRoomName(workspaceId: string, roomId: string, key: Uint8Array, sealed: SealedName): string {
  return v.name(fromUtf8(open(key, sealed, nameAad(workspaceId, roomId, sealed.n))), "roomName");
}

export interface KeyWrapBody {
  kind: "vr-wrap-v1";
  ws: string;
  room: string;
  n: number;
  /**
   * Commitment of the key inside. A wrap only counts while the record's epoch has this commitment, so after two
   * rotations raced, wraps (and receipts) of the key that lost stop counting everywhere.
   */
  commit: string;
  /** Recipient device. */
  to: string;
  /** Wrapping device. */
  by: string;
  at: number;
  box: SealedBox;
}

export interface KeyWrap {
  body: KeyWrapBody;
  sig: string;
}

const WRAP_SIG = "key-wrap";
const WRAP_BOX = "room-key-wrap";

function wrapAad(body: Pick<KeyWrapBody, "ws" | "room" | "n" | "to">): Uint8Array {
  return utf8(canonicalJson({ purpose: WRAP_BOX, ws: body.ws, room: body.room, n: body.n, to: body.to }));
}

export function wrapRoomKey(
  workspaceId: string,
  roomId: string,
  n: number,
  key: Uint8Array,
  recipient: { id: string; agree: string },
  wrapper: KeyPair,
  now = Date.now()
): KeyWrap {
  const head = { ws: workspaceId, room: roomId, n, to: recipient.id };
  const body: KeyWrapBody = {
    kind: "vr-wrap-v1",
    ...head,
    commit: keyCommitment(workspaceId, roomId, n, key),
    by: deviceIdFor(wrapper.publicKey),
    at: now,
    box: sealToDevice(recipient.agree, WRAP_BOX, key, wrapAad(head))
  };
  return { body, sig: sign(wrapper.secretKey, WRAP_SIG, utf8(canonicalJson(body))) };
}

export function parseKeyWrap(value: unknown): KeyWrap {
  const o = v.obj(value, "wrap", ["body", "sig"]);
  const b = v.obj(o.body, "wrap.body", ["kind", "ws", "room", "n", "commit", "to", "by", "at", "box"]);
  if (b.kind !== "vr-wrap-v1") v.bad("wrap.kind");
  const box = v.obj(b.box, "wrap.box", ["epk", "nonce", "ct"]);
  return {
    body: {
      kind: "vr-wrap-v1",
      ws: v.hash(b.ws, "wrap.ws"),
      room: v.id(b.room, "wrap.room", "r"),
      n: v.int(b.n, "wrap.n", 1, 1e9),
      commit: v.hash(b.commit, "wrap.commit"),
      to: v.id(b.to, "wrap.to", "d"),
      by: v.id(b.by, "wrap.by", "d"),
      at: v.int(b.at, "wrap.at", 0, Number.MAX_SAFE_INTEGER),
      box: { epk: v.b64(box.epk, "wrap.box.epk", 32), nonce: v.b64(box.nonce, "wrap.box.nonce", 12), ct: v.b64(box.ct, "wrap.box.ct", 48) }
    },
    sig: v.b64(o.sig, "wrap.sig", 64)
  };
}

/**
 * Who may wrap and receive: the wrapper is an active device whose user is a member of the room, and the recipient
 * is an active device whose user is a member; the wrap names the epoch's key commitment as the record has it.
 * Anyone (members or not) can check this; only the recipient can open it.
 */
export function verifyKeyWrap(state: WorkspaceState, workspaceId: string, wrap: KeyWrap): boolean {
  const { body } = wrap;
  if (body.ws !== workspaceId) return false;
  const room = liveRoom(state, body.room);
  if (!room || room.epochs[body.n - 1]?.commit !== body.commit) return false;
  const wrapper = activeDevice(state, body.by);
  const recipient = activeDevice(state, body.to);
  if (!wrapper || !recipient) return false;
  if (!roleIn(state, body.room, wrapper.user) || !roleIn(state, body.room, recipient.user)) return false;
  return verify(wrapper.sign, WRAP_SIG, utf8(canonicalJson(body)), wrap.sig);
}

/** Whether a wrap's signature holds, when its wrapper is an active device of `state` (null when the wrapper isn't known there). */
export function wrapSignatureValid(state: WorkspaceState, wrap: KeyWrap): boolean | null {
  const wrapper = activeDevice(state, wrap.body.by);
  return wrapper ? verify(wrapper.sign, WRAP_SIG, utf8(canonicalJson(wrap.body)), wrap.sig) : null;
}

/** Opens a wrap addressed to this device and checks the key against the epoch's commitment. */
export function unwrapRoomKey(state: WorkspaceState, workspaceId: string, wrap: KeyWrap, me: KeyPair): Uint8Array {
  const room = liveRoom(state, wrap.body.room);
  const epoch = room?.epochs[wrap.body.n - 1];
  if (!epoch) fail("unknown_epoch");
  const key = openFromDevice(me, WRAP_BOX, wrap.body.box, wrapAad(wrap.body));
  if (keyCommitment(workspaceId, wrap.body.room, wrap.body.n, key) !== epoch.commit) fail("key_mismatch");
  return key;
}
