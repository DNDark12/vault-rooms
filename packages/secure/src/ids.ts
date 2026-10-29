import { b64u, fromB64u } from "./bytes.js";
import { hashTagged, randomBytes } from "./crypto.js";

/** Ids are a one-letter kind plus 22 base64url characters (128 bits). */
export type IdKind = "u" | "d" | "r" | "i" | "f";

const ID_PATTERN = /^[udrif][A-Za-z0-9_-]{22}$/;

export function randomId(kind: IdKind): string {
  return kind + b64u(randomBytes(16));
}

/** A device id is derived from its signing key, so whoever claims an id must hold the matching key. */
export function deviceIdFor(signingPublicKey: string): string {
  return "d" + b64u(hashTagged("device-id", fromB64u(signingPublicKey, 32)).subarray(0, 16));
}

export function isId(value: unknown, kind: IdKind): value is string {
  return typeof value === "string" && ID_PATTERN.test(value) && value[0] === kind;
}

/** Workspace ids and version hashes: base64url SHA-256. */
export function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
