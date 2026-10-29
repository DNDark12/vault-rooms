import { b64u, utf8 } from "./bytes.js";
import { canonicalJson } from "./canonical.js";
import { hkdf, hmacTagged, open, seal, sign, verify, type KeyPair } from "./crypto.js";
import { fail } from "./errors.js";
import { deviceIdFor, isId } from "./ids.js";
import * as v from "./validate.js";
import { activeDevice, liveRoom, roleAtLeast, roleIn, type WorkspaceState } from "./workspace.js";

/**
 * Everything a room shares travels as an envelope: AES-256-GCM ciphertext under the room key of epoch `n`, plus a
 * small cleartext header that every peer needs for routing and checking (room, document, author, counter). The
 * header is the associated data of the encryption and is covered by the author's signature, so neither a peer nor
 * anyone else can move ciphertext to another document, author or counter.
 *
 *  u  an update to a document (a Yjs update), numbered per document and author: (author, clock)
 *  s  a snapshot of a document (full Yjs state) covering a version vector of updates
 *  b  a blob (an attachment version); its id is a keyed hash of the plaintext, so it can be checked after decrypting
 *  p  a presence message (cursor position); never stored
 */

export type DocId = string;
export const INDEX_DOC = "index";

export function isDocId(value: unknown): value is DocId {
  return value === INDEX_DOC || isId(value, "f");
}

interface Header {
  ws: string;
  room: string;
  author: string;
  n: number;
}

export interface UpdateEnvelope extends Header {
  k: "u";
  doc: DocId;
  clock: number;
  nonce: string;
  ct: string;
  sig: string;
}

export interface SnapshotEnvelope extends Header {
  k: "s";
  doc: DocId;
  /** Per-author counter of snapshots of this document. */
  seq: number;
  /** For each author, the highest clock whose update this snapshot already contains. */
  covers: Record<string, number>;
  nonce: string;
  ct: string;
  sig: string;
}

export interface BlobEnvelope extends Header {
  k: "b";
  id: string;
  nonce: string;
  ct: string;
  sig: string;
}

export interface PresenceEnvelope extends Header {
  k: "p";
  at: number;
  nonce: string;
  ct: string;
  sig: string;
}

export type Envelope = UpdateEnvelope | SnapshotEnvelope | BlobEnvelope | PresenceEnvelope;
export type StoredEnvelope = UpdateEnvelope | SnapshotEnvelope | BlobEnvelope;

/** Ciphertext limits (bytes of plaintext + 16-byte tag). */
export const MAX_BYTES = { u: 8 << 20, s: 16 << 20, b: 32 << 20, p: 8 << 10 } as const;
/** The largest note (UTF-8 bytes) shared as a live document: its first update and its snapshots stay within the limits. */
export const MAX_NOTE_BYTES = 6 << 20;
const MAX_AUTHORS_IN_COVERS = 2000;

const SIG = "envelope";

/** Associated data: the cleartext header (everything but nonce, ciphertext and signature). */
function aad(env: Record<string, unknown>): Uint8Array {
  const { nonce: _nonce, ct: _ct, sig: _sig, ...head } = env;
  return utf8(canonicalJson({ purpose: "room-envelope", ...head }));
}

function signedBytes(env: Omit<Envelope, "sig">): Uint8Array {
  return utf8(canonicalJson(env));
}

export interface SealContext {
  ws: string;
  room: string;
  /** Key epoch and its key. */
  n: number;
  key: Uint8Array;
  /** The author device's signing key pair. */
  author: KeyPair;
}

function finish<T extends Envelope>(ctx: SealContext, head: Omit<T, "nonce" | "ct" | "sig" | "ws" | "room" | "author" | "n">, plaintext: Uint8Array): T {
  const base = { ...head, ws: ctx.ws, room: ctx.room, author: deviceIdFor(ctx.author.publicKey), n: ctx.n } as unknown as Omit<T, "nonce" | "ct" | "sig">;
  const sealed = seal(ctx.key, plaintext, aad(base as Record<string, unknown>));
  const unsigned = { ...base, nonce: sealed.nonce, ct: sealed.ct } as Omit<T, "sig">;
  return { ...unsigned, sig: sign(ctx.author.secretKey, SIG, signedBytes(unsigned as Omit<Envelope, "sig">)) } as T;
}

export function sealUpdate(ctx: SealContext, doc: DocId, clock: number, update: Uint8Array): UpdateEnvelope {
  if (update.length + 16 > MAX_BYTES.u) fail("too_large");
  return finish<UpdateEnvelope>(ctx, { k: "u", doc, clock }, update);
}

export function sealSnapshot(ctx: SealContext, doc: DocId, seq: number, covers: Record<string, number>, state: Uint8Array): SnapshotEnvelope {
  if (state.length + 16 > MAX_BYTES.s) fail("too_large");
  return finish<SnapshotEnvelope>(ctx, { k: "s", doc, seq, covers }, state);
}

function blobKey(roomKey: Uint8Array, room: string): Uint8Array {
  return hkdf(roomKey, utf8(room), "blob-id");
}

export function blobId(roomKey: Uint8Array, room: string, bytes: Uint8Array): string {
  return b64u(hmacTagged(blobKey(roomKey, room), "blob", bytes));
}

export function sealBlob(ctx: SealContext, bytes: Uint8Array): BlobEnvelope {
  if (bytes.length + 16 > MAX_BYTES.b) fail("too_large");
  return finish<BlobEnvelope>(ctx, { k: "b", id: blobId(ctx.key, ctx.room, bytes) }, bytes);
}

export function sealPresence(ctx: SealContext, at: number, payload: Uint8Array): PresenceEnvelope {
  if (payload.length + 16 > MAX_BYTES.p) fail("too_large");
  return finish<PresenceEnvelope>(ctx, { k: "p", at }, payload);
}

/** Strict schema check of an untrusted envelope. */
export function parseEnvelope(value: unknown): Envelope {
  const raw = v.obj(value, "env", ["k", "ws", "room", "author", "n", "doc", "clock", "seq", "covers", "id", "at", "nonce", "ct", "sig"]);
  const k = v.oneOf(raw.k, "env.k", ["u", "s", "b", "p"] as const);
  const base = {
    ws: v.hash(raw.ws, "env.ws"),
    room: v.id(raw.room, "env.room", "r"),
    author: v.id(raw.author, "env.author", "d"),
    n: v.int(raw.n, "env.n", 1, 1e9)
  };
  const tail = { nonce: v.b64(raw.nonce, "env.nonce", 12), ct: v.b64(raw.ct, "env.ct", MAX_BYTES[k], false), sig: v.b64(raw.sig, "env.sig", 64) };
  const allowed: Record<typeof k, string[]> = { u: ["doc", "clock"], s: ["doc", "seq", "covers"], b: ["id"], p: ["at"] };
  for (const key of ["doc", "clock", "seq", "covers", "id", "at"]) if (raw[key] !== undefined && !allowed[k].includes(key)) v.bad(`env.${key}`);
  const doc = (): DocId => (isDocId(raw.doc) ? raw.doc : v.bad("env.doc"));
  switch (k) {
    case "u":
      return { k, ...base, doc: doc(), clock: v.int(raw.clock, "env.clock", 1, Number.MAX_SAFE_INTEGER), ...tail };
    case "s": {
      const covers: Record<string, number> = {};
      for (const [author, clock] of Object.entries(v.idMap(raw.covers, "env.covers", "d", MAX_AUTHORS_IN_COVERS))) covers[author] = v.int(clock, `env.covers.${author}`, 0, Number.MAX_SAFE_INTEGER);
      return { k, ...base, doc: doc(), seq: v.int(raw.seq, "env.seq", 1, Number.MAX_SAFE_INTEGER), covers, ...tail };
    }
    case "b":
      return { k, ...base, id: v.hash(raw.id, "env.id"), ...tail };
    case "p":
      return { k, ...base, at: v.int(raw.at, "env.at", 0, Number.MAX_SAFE_INTEGER), ...tail };
  }
}

/**
 * May this envelope enter the room at all? Checks what every peer can check without the key: the author is an
 * active device whose user currently has `write` in the room (any role for presence), the key epoch exists, and
 * the signature holds. A removed or downgraded writer's envelopes are refused from then on.
 */
export function verifyEnvelope(state: WorkspaceState, workspaceId: string, env: Envelope): boolean {
  if (env.ws !== workspaceId) return false;
  const room = liveRoom(state, env.room);
  if (!room || env.n > room.epochs.length) return false;
  const device = activeDevice(state, env.author);
  if (!device) return false;
  const role = roleIn(state, env.room, device.user);
  if (!(env.k === "p" ? role !== undefined : roleAtLeast(role, "write"))) return false;
  const { sig, ...unsigned } = env;
  return verify(device.sign, SIG, signedBytes(unsigned as Omit<Envelope, "sig">), sig);
}

/** Decrypts with the key of epoch `env.n`. For blobs it also checks the id against the plaintext. */
export function openEnvelope(env: Envelope, key: Uint8Array): Uint8Array {
  const plaintext = open(key, env, aad(env as unknown as Record<string, unknown>));
  if (env.k === "b" && blobId(key, env.room, plaintext) !== env.id) fail("blob_mismatch");
  return plaintext;
}

/**
 * A stable identity for storage and de-duplication. Two different envelopes with one id are an author equivocating.
 * Blobs are kept per author, so nobody can take the place of another member's blob by sending something first.
 */
export function envelopeKey(env: StoredEnvelope): string {
  switch (env.k) {
    case "u":
      return `${env.room}/${env.doc}/u/${env.author}/${env.clock}`;
    case "s":
      return `${env.room}/${env.doc}/s/${env.author}/${env.seq}`;
    case "b":
      return `${env.room}/b/${blobKeyOf(env.author, env.id)}`;
  }
}

/** How a blob is named within its room: author and id. */
export function blobKeyOf(author: string, id: string): string {
  return `${author}/${id}`;
}

export function isBlobKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const at = value.indexOf("/");
  return at > 0 && isId(value.slice(0, at), "d") && /^[A-Za-z0-9_-]{43}$/.test(value.slice(at + 1));
}
