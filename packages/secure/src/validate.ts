import { fail } from "./errors.js";
import { isHash, isId, type IdKind } from "./ids.js";

/** Small strict validators for untrusted records. They throw SecureError("bad_record", <field>) on the first problem. */

export type Json = Record<string, unknown>;

export function bad(field: string): never {
  return fail("bad_record", field);
}

export function obj(value: unknown, field: string, allowedKeys: readonly string[]): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad(field);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) bad(field);
  for (const key of Object.keys(value as Json)) if (!allowedKeys.includes(key)) bad(`${field}.${key}`);
  return value as Json;
}

/** A map keyed by ids of one kind; at most `max` entries. */
export function idMap(value: unknown, field: string, kind: IdKind, max: number): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad(field);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) bad(field);
  const keys = Object.keys(value as Json);
  if (keys.length > max) bad(field);
  for (const key of keys) if (!isId(key, kind)) bad(`${field}.${key}`);
  return value as Json;
}

export function str(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) bad(field);
  return value;
}

/**
 * C0/C1 controls, the Unicode line/paragraph separators, and invisible characters that can make one name look like
 * another (zero-width characters, bidirectional marks, embeddings, overrides and isolates), compared by code point.
 */
function hasControl(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
    if (c === 0x061c || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff) return true;
  }
  return false;
}

/** Removes the invisible characters `name` refuses, for cleaning up what someone typed. */
export function cleanName(text: string): string {
  return Array.from(text)
    .filter((ch) => !hasControl(ch))
    .join("")
    .trim();
}

/** A display name: 1–80 characters, no control or invisible characters, no leading or trailing whitespace. */
export function name(value: unknown, field: string): string {
  const text = str(value, field, 80);
  if (text.length === 0 || text !== text.trim() || hasControl(text)) bad(field);
  return text;
}

export function id(value: unknown, field: string, kind: IdKind): string {
  if (!isId(value, kind)) bad(field);
  return value;
}

export function hash(value: unknown, field: string): string {
  if (!isHash(value)) bad(field);
  return value;
}

/** base64url of exactly `bytes` bytes (or of any length up to `bytes` when `exact` is false). */
export function b64(value: unknown, field: string, bytes: number, exact = true): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) bad(field);
  const length = Math.ceil((bytes * 4) / 3);
  if (exact ? value.length !== length : value.length > length) bad(field);
  return value;
}

export function int(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) bad(field);
  return value;
}

export function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") bad(field);
  return value;
}

/** Optional `true` flag: either absent or exactly `true` (flags are never written as false). */
export function flag(value: unknown, field: string): true | undefined {
  if (value === undefined) return undefined;
  if (value !== true) bad(field);
  return true;
}

export function oneOf<T extends string>(value: unknown, field: string, options: readonly T[]): T {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) bad(field);
  return value as T;
}
