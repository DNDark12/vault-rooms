import type { ErrorCode } from "@vault-rooms/protocol";

/** Fallback copy for display sinks when the relay provides no usable message. */
const BY_CODE = {
  UNAUTHORIZED: "This device is no longer signed in to that server.",
  PERMISSION_DENIED: "You don't have permission to do that in this room.",
  VERSION_CONFLICT: "Someone else changed this file first.",
  FILE_EXISTS: "A file with that name already exists in this room.",
  FILE_DELETED: "That file has been deleted in this room.",
  FILE_TOO_LARGE: "That file is larger than this server accepts.",
  INVALID_PATH: "That file name or folder path isn't allowed.",
  PATH_COLLISION: "These file names overlap on another computer. Ask the room owner to rename one before syncing.",
  NOT_FOUND: "That item no longer exists on this server.",
  VALIDATION_ERROR: "This server rejected the request.",
  ADAPTER_CONFLICT: "Another Vault Rooms window is already using this vault.",
  RATE_LIMITED: "Too many attempts - wait a moment and try again.",
  TLS_REQUIRED: "This server now requires a secure connection.",
  CRDT_DISABLED: "Live editing is turned off for this room.",
  CRDT_CAPABILITY_REQUIRED: "This connection doesn't support live editing - reconnect, or update the plugin.",
  CRDT_OPERATION_DEVICE_MISMATCH: "That offline change belongs to another device and was not replayed.",
  CRDT_STALE_EPOCH: "This note was reset on the server - reopen it.",
  CRDT_INVALID_UPDATE: "A live-editing update couldn't be applied.",
  CRDT_WRITE_UNSUPPORTED: "This note uses live editing - update the plugin to edit it.",
  STORAGE_QUOTA_EXCEEDED:
    "The store on the hosting device is full - delete files in this room, then run the reclaim command on that device."
} satisfies Record<ErrorCode, string>;

/** `SCREAMING_SNAKE` with no lowercase and no spaces is never prose a human wrote for a user. Used
 *  both to reject a code masquerading as a message and to look one up when that is all we have. */
const LOOKS_LIKE_A_CODE = /^[A-Z][A-Z0-9_]{2,}$/;

/**
 * Transport failures, which are a different class from relay `ErrorCode`s: they come from Electron's
 * network stack (`net::ERR_*`) or from Node (`ECONNREFUSED` and the TLS verification codes), and they
 * never carry an `ErrorCode` at all - the request died before any relay could answer.
 *
 * They need their own layer because `LOOKS_LIKE_A_CODE` cannot catch them: `net::ERR_CONNECTION_REFUSED`
 * starts lowercase, and Node codes usually arrive embedded in prose ("connect ECONNREFUSED
 * 192.168.1.5:8787"). Both therefore read as "usable prose" and used to reach a Notice verbatim.
 *
 * Matched as substrings, most specific first, against the message *and* a Node-style `error.code`.
 * Each entry answers "what should I try next?", because the raw token never did - the console and
 * `connectionDiagnostics` still keep the original for debugging.
 */
const TRANSPORT_MESSAGES: Array<[RegExp, string]> = [
  // Before the generic connection cases: Obsidian's Electron runtime refuses a set of ports outright,
  // which looks identical to "server down" but is fixed in settings, not by starting anything.
  [/ERR_UNSAFE_PORT/, "Obsidian's runtime blocks that port - pick a different one in the server settings."],
  [
    /ERR_CERT|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID/,
    "This server's security certificate couldn't be verified - ask its owner for a fresh invite link."
  ],
  [
    /ERR_CONNECTION_REFUSED|ECONNREFUSED/,
    "Nothing answered at that address - the server may be stopped, or the address or port may be wrong."
  ],
  [/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/, "That address couldn't be looked up - check it for typos."],
  [
    /ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED|EHOSTUNREACH|ENETUNREACH/,
    "That address can't be reached from this device - check both machines are on the same network."
  ],
  [/ERR_CONNECTION_TIMED_OUT|ETIMEDOUT/, "The server didn't respond in time - it may be busy or unreachable."],
  [
    /ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ECONNRESET|EPIPE/,
    "The connection dropped before the server answered - try again."
  ]
];

/** Anything else from Electron's network stack, and bare Node error tokens. Deliberately narrow so it
 *  cannot swallow a real sentence: `net::` is unmistakable, and the second alternative requires the
 *  *whole* message to be one uppercase token. */
const UNMAPPED_TRANSPORT_TOKEN = /net::[A-Z_]+|^E[A-Z]{3,}$/;

function transportMessage(message: string, code: string | undefined): string | undefined {
  const haystack = `${code ?? ""} ${message}`;
  for (const [pattern, text] of TRANSPORT_MESSAGES) {
    if (pattern.test(haystack)) return text;
  }
  if (UNMAPPED_TRANSPORT_TOKEN.test(message) || (code !== undefined && UNMAPPED_TRANSPORT_TOKEN.test(code))) {
    return "Couldn't reach that server - check it's running and that the address is right.";
  }
  return undefined;
}

/**
 * Why LAN discovery could not open its UDP listener, as something a person can act on. Kept separate
 * from `TRANSPORT_MESSAGES`: those answer "your HTTP request failed", which is the wrong frame here -
 * hosting is still up and working, only the find-me-on-the-LAN convenience is missing. Without this
 * the panel rendered the raw errno, so the most common case read as `addMembership EADDRNOTAVAIL`.
 */
const LAN_DISCOVERY_MESSAGES: Array<[RegExp, string]> = [
  [
    /EADDRNOTAVAIL/,
    "this network won't let Vault Rooms join its discovery group - the advertised address may belong to a VPN or virtual adapter rather than your LAN"
  ],
  [/EADDRINUSE/, "another app is already using the discovery port on this computer"],
  [/EACCES|EPERM/, "this computer's security settings blocked the discovery port"],
  [/ENODEV|ENXIO/, "the network interface for the advertised address is not up"]
];

export function lanDiscoveryUnavailableReason(error: unknown): string {
  const candidate = typeof error === "object" && error !== null ? (error as ErrorLike) : {};
  const message = typeof error === "string" ? error : typeof candidate.message === "string" ? candidate.message : "";
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const haystack = `${code} ${message}`;
  for (const [pattern, text] of LAN_DISCOVERY_MESSAGES) {
    if (pattern.test(haystack)) return text;
  }
  return message || "the discovery listener could not be opened";
}

type ErrorLike = { code?: unknown; message?: unknown };

export function isTransportFailure(error: unknown): boolean {
  const candidate = typeof error === "object" && error !== null ? (error as ErrorLike) : {};
  const message = typeof error === "string" ? error : typeof candidate.message === "string" ? candidate.message : "";
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  return transportMessage(message, code) !== undefined;
}

/**
 * Resolves the most specific human-readable text available, in order:
 *
 * 1. transport guidance, when the failure is a network/TLS code rather than anything a relay said;
 * 2. a non-empty message that is not itself a wire code - relay prose, or an ordinary local `Error`;
 * 3. the catalog entry for a known `ErrorCode`;
 * 4. the caller's own fallback, which stays the right wording for "this particular action failed".
 */
export function userFacingError(error: unknown, fallback: string): string {
  const candidate = typeof error === "object" && error !== null ? (error as ErrorLike) : {};
  const message =
    typeof error === "string"
      ? error.trim()
      : typeof candidate.message === "string"
        ? candidate.message.trim()
        : "";
  const explicitCode = typeof candidate.code === "string" ? candidate.code : undefined;

  // Ahead of the prose check, because a transport failure's message *is* the machine token and would
  // otherwise be returned as-is. Safe to put first: a relay that answered at all cannot produce one of
  // these, so this can never shadow real relay wording.
  const transport = transportMessage(message, explicitCode);
  if (transport) return transport;

  if (message && !LOOKS_LIKE_A_CODE.test(message)) return message;

  const lookupCode = explicitCode ?? (LOOKS_LIKE_A_CODE.test(message) ? message : undefined);
  // `Object.hasOwn`, never `in`: the code is untrusted wire input, and `in` walks the prototype chain,
  // so `{ code: "constructor" }` would resolve to `Object` - returning a *function* from a function
  // typed as returning a string, at every Notice and UI sink downstream. Note the regex above cannot
  // catch this: an explicit `code` is used verbatim, and these names are lowercase anyway.
  return lookupCode && Object.hasOwn(BY_CODE, lookupCode) ? BY_CODE[lookupCode as ErrorCode] : fallback;
}
