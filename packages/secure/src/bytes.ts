import { timingSafeEqual } from "node:crypto";
import { fail } from "./errors.js";

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Throws on malformed UTF-8 instead of substituting U+FFFD. */
export function fromUtf8(bytes: Uint8Array): string {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return fail("bad_utf8");
  }
}

export function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

/** Strict base64url: only the canonical, unpadded spelling of some byte string is accepted. */
export function fromB64u(text: string, expectedLength?: number): Uint8Array {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) fail("bad_base64url");
  const bytes = Buffer.from(text, "base64url");
  if (bytes.toString("base64url") !== text) fail("bad_base64url");
  if (expectedLength !== undefined && bytes.length !== expectedLength) fail("bad_length");
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Constant time for equal lengths; different lengths are simply unequal. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Unsigned 32-bit big-endian, for length prefixes in hashed or authenticated data. */
export function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) fail("bad_integer");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}
