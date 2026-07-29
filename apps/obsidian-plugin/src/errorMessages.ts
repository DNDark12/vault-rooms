import type { ErrorCode } from "@vault-rooms/protocol";

/**
 * User-facing error text for display sinks (docs/superpowers/plans/2026-07-29-user-facing-error-messages.md).
 *
 * The relay stays the primary source of wording: it is the only side that knows which of ~30
 * distinct `VALIDATION_ERROR` situations actually happened. This table is the *fallback* for the
 * cases relay prose cannot cover:
 *
 * - a frame that carries a code and no message at all (`hello_error` was exactly this);
 * - an older relay whose prose still reads as wire vocabulary;
 * - a non-`Error` throw, which used to reach a notice as `String(error)` - "[object Object]".
 *
 * It is deliberately NOT a mirror of the relay's sentences. Duplicating them would guarantee the two
 * drift apart, and the generic wording here is only ever seen when the specific wording is missing.
 *
 * Call this at display sinks only. Error normalization (`apiClient.ts`, `pinnedTransport.ts`,
 * `syncWsClient.ts`), pinned-TLS recovery decisions, `connectionDiagnostics.ts` evidence, and every
 * `console.warn`/`console.error` keep the raw error - that is what makes a failure diagnosable later.
 */
const BY_CODE = {
  UNAUTHORIZED: "This device is no longer signed in to that server.",
  PERMISSION_DENIED: "You don't have permission to do that in this room.",
  VERSION_CONFLICT: "Someone else changed this file first.",
  FILE_EXISTS: "A file with that name already exists in this room.",
  FILE_DELETED: "That file has been deleted in this room.",
  FILE_TOO_LARGE: "That file is larger than this server accepts.",
  INVALID_PATH: "That file name or folder path isn't allowed.",
  NOT_FOUND: "That item no longer exists on this server.",
  VALIDATION_ERROR: "This server rejected the request.",
  ADAPTER_CONFLICT: "Another Vault Rooms window is already using this vault.",
  RATE_LIMITED: "Too many attempts - wait a moment and try again.",
  TLS_REQUIRED: "This server now requires a secure connection.",
  CRDT_DISABLED: "Live editing is turned off for this room.",
  CRDT_CAPABILITY_REQUIRED: "This connection doesn't support live editing - reconnect, or update the plugin.",
  CRDT_STALE_EPOCH: "This note was reset on the server - reopen it.",
  CRDT_INVALID_UPDATE: "A live-editing update couldn't be applied.",
  CRDT_WRITE_UNSUPPORTED: "This note uses live editing - update the plugin to edit it."
} satisfies Record<ErrorCode, string>;

/** `SCREAMING_SNAKE` with no lowercase and no spaces is never prose a human wrote for a user. Used
 *  both to reject a code masquerading as a message and to look one up when that is all we have. */
const LOOKS_LIKE_A_CODE = /^[A-Z][A-Z0-9_]{2,}$/;

type ErrorLike = { code?: unknown; message?: unknown };

/**
 * Resolves the most specific human-readable text available, in order:
 *
 * 1. a non-empty message that is not itself a wire code - relay prose, or an ordinary local `Error`;
 * 2. the catalog entry for a known `ErrorCode`;
 * 3. the caller's own fallback, which stays the right wording for "this particular action failed".
 */
export function userFacingError(error: unknown, fallback: string): string {
  const candidate = typeof error === "object" && error !== null ? (error as ErrorLike) : {};
  const message =
    typeof error === "string"
      ? error.trim()
      : typeof candidate.message === "string"
        ? candidate.message.trim()
        : "";
  if (message && !LOOKS_LIKE_A_CODE.test(message)) return message;

  const explicitCode = typeof candidate.code === "string" ? candidate.code : undefined;
  const lookupCode = explicitCode ?? (LOOKS_LIKE_A_CODE.test(message) ? message : undefined);
  // `Object.hasOwn`, never `in`: the code is untrusted wire input, and `in` walks the prototype chain,
  // so `{ code: "constructor" }` would resolve to `Object` - returning a *function* from a function
  // typed as returning a string, at every Notice and UI sink downstream. Note the regex above cannot
  // catch this: an explicit `code` is used verbatim, and these names are lowercase anyway.
  return lookupCode && Object.hasOwn(BY_CODE, lookupCode) ? BY_CODE[lookupCode as ErrorCode] : fallback;
}
