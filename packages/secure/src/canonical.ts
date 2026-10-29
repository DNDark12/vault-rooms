import { fail } from "./errors.js";

/** The only values that may be signed: JSON without floats, so every implementation serializes them identically. */
export type Canonical = null | boolean | number | string | Canonical[] | { readonly [key: string]: Canonical };

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit, no whitespace, safe integers only.
 * Anything else (undefined, floats, NaN, bigint, Dates, Maps, typed arrays, sparse arrays) is rejected
 * rather than silently coerced, so a signature always covers exactly the data that was meant.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, 0);
}

const MAX_DEPTH = 32;

function encode(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) fail("canonical_too_deep");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) fail("canonical_not_integer");
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!(i in value)) fail("canonical_sparse_array");
          items.push(encode(value[i], depth + 1));
        }
        return `[${items.join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) fail("canonical_not_plain_object");
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key], depth + 1)}`).join(",")}}`;
    }
    default:
      return fail("canonical_bad_type");
  }
}

/** Parse untrusted JSON and require that it is already in canonical form (no duplicate keys, floats, padding). */
export function parseCanonical(text: string): Canonical {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("bad_json");
  }
  if (canonicalJson(parsed) !== text) fail("not_canonical");
  return parsed as Canonical;
}
