import { AppError } from "./errors.js";

const DRIVE_LETTER = /^[a-zA-Z]:[\\/]/;
// `.excalidraw` is the legacy Excalidraw-for-Obsidian format: plain JSON text, same as `.canvas`
// (newer Excalidraw versions save as `.excalidraw.md`, which is already covered by `.md` below).
// This is the set of extensions known to be safe UTF-8 text: everything else - images, audio,
// video, Office documents, or any extension we've simply never listed - is synced through the
// binary/base64 lane by default (see isEligibleBinaryPath below). That default, rather than a
// binary allowlist, is what lets sync cover the same file surface Obsidian itself can hold in a
// vault (2026-08-03: previously unlisted binaries were silently skipped by isEligiblePath, which
// used to be a whitelist - it's now unconditionally true, since any bytes round-trip safely
// through one lane or the other).
const ELIGIBLE_EXTENSIONS = new Set([".md", ".txt", ".canvas", ".json", ".csv", ".excalidraw"]);

// Generous but finite: prevents a malformed/hostile path from reaching fs/Obsidian's own path
// APIs and throwing an uncaught ENAMETOOLONG (or platform equivalent) deep inside a write/mount
// codepath. Most real filesystems cap a single segment around 255 bytes; 1024 total keeps room
// for a deeply nested folder structure without letting a path grow unbounded.
const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;

// These messages reach a user through the REST/WS error envelope and an Obsidian Notice, so they say
// what to pick instead rather than restating the normalization rule that rejected the input. The
// INVALID_PATH code carries the machine-readable meaning and is unchanged.
export function normalizeRelativePath(input: string): string {
  if (!input || input.includes("\0") || input.startsWith("/") || input.startsWith("\\") || DRIVE_LETTER.test(input)) {
    throw new AppError("INVALID_PATH", "Choose a file or folder inside the shared room.", 422);
  }
  if (input.length > MAX_PATH_LENGTH) {
    throw new AppError("INVALID_PATH", "That path is too long to sync.", 422);
  }
  const normalized = input.replaceAll("\\", "/").replace(/\/+/g, "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new AppError("INVALID_PATH", "That path contains a hidden or unsupported folder.", 422);
  }
  if (segments.some((segment) => segment.length > MAX_SEGMENT_LENGTH)) {
    throw new AppError("INVALID_PATH", "One folder or file name in this path is too long.", 422);
  }
  return segments.join("/");
}

export function contentTypeForPath(path: string): "markdown" | "text" | "binary" {
  if (path.toLowerCase().endsWith(".md")) {
    return "markdown";
  }
  return isEligibleBinaryPath(path) ? "binary" : "text";
}

export function isEligibleTextPath(path: string): boolean {
  const lastDot = path.lastIndexOf(".");
  return lastDot >= 0 && ELIGIBLE_EXTENSIONS.has(path.slice(lastDot).toLowerCase());
}

/** Anything that isn't Markdown and isn't a known-safe-text extension goes through the binary
 *  (base64) lane by default - images, PDFs, audio, video, Office documents, and any extension
 *  (or lack of one) we've never enumerated. This is a default, not a whitelist, on purpose:
 *  base64 round-trips any byte sequence correctly, while decoding unknown bytes as UTF-8 text
 *  (the old whitelist's failure mode for anything outside it) silently corrupts binary content. */
export function isEligibleBinaryPath(path: string): boolean {
  return !path.toLowerCase().endsWith(".md") && !isEligibleTextPath(path);
}

/** Whether a path can be synced at all. Broadened 2026-08-03 to match Obsidian's own vault file
 *  surface: every file syncs now, either through the text (UTF-8) lane or the binary (base64)
 *  lane - see contentTypeForPath/isEligibleBinaryPath for which lane a given path takes. Kept as
 *  a named function (rather than deleting call sites) so a future reason to exclude a path again
 *  - e.g. a room-level ignore list - has one place to land. */
export function isEligiblePath(_path: string): boolean {
  return true;
}

// Frozen snapshot of the whitelist isEligiblePath enforced before 2026-08-03's sync-widening -
// exactly what a pre-widening client's own local isEligiblePath/isEligibleBinaryPath already
// understood. Exists *only* for isLegacyEligiblePath below (a mixed-version compatibility gate):
// never grow it to track ELIGIBLE_EXTENSIONS, and never redefine contentTypeForPath/isEligiblePath/
// isEligibleBinaryPath in terms of it. See docs/superpowers - a widened-sync client base64-encodes
// e.g. `.docx`/`.mp4` using the *new* default-to-binary rule, but a client still running the old
// whitelist has no idea `.docx` can be binary at all: its own isEligibleBinaryPath said no, so it
// falls through to treating the base64 payload as UTF-8 text and writes the literal base64 string
// to disk as the file's "content" - silent corruption, not a visible error. The fix is not "teach
// the old code" (it's already shipped); it's keeping content old clients don't understand from
// reaching them at all - see extendedBinarySync in protocol.ts and its use in syncServer.ts/
// file.routes.ts.
const LEGACY_ELIGIBLE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".canvas",
  ".json",
  ".csv",
  ".excalidraw",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".pdf"
]);

/** True for any path a pre-2026-08-03 client already knew how to sync safely. Used to gate what a
 *  connection/request that hasn't advertised the `extendedBinarySync` capability may see - not a
 *  statement about what syncs today (see isEligiblePath, which is unconditionally true). */
export function isLegacyEligiblePath(path: string): boolean {
  const lastDot = path.lastIndexOf(".");
  return lastDot >= 0 && LEGACY_ELIGIBLE_EXTENSIONS.has(path.slice(lastDot).toLowerCase());
}

/** CRDT eligibility (docs/superpowers/plans/2026-07-20-crdt-sync.md contract 1.1) - deliberately
 *  narrower than isEligiblePath()/isEligibleTextPath(): only genuine Markdown notes get the CRDT
 *  lane in v1, even though .txt/.canvas/.json/.csv/.excalidraw are also synced as text via the
 *  whole-file compare-and-swap lane. Structured formats (.canvas/.json/.excalidraw, and
 *  `*.excalidraw.md` - the newer Excalidraw-for-Obsidian format, which stores a JSON payload inside
 *  an .md file rather than prose) need semantic merging, not text merging: character-level CRDT
 *  merge on concurrent edits can leave the JSON payload structurally invalid, not just textually
 *  different. That's ROADMAP P2 #5 territory, not this effort - `.excalidraw.md` stays on the CAS
 *  lane like every other structured format. */
export function isCrdtEligiblePath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") && !lower.endsWith(".excalidraw.md");
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** True for well-formed standard base64 (correct alphabet and padding). Used to validate a
 *  binary-lane file_change/PUT payload before it's hashed and stored: a malformed or
 *  non-canonically-padded string can decode to different bytes on the sender than the receiver -
 *  or fail to decode at all - silently diverging the sha256 the relay records from the bytes a
 *  receiving client's own base64 decoder actually writes to disk. Empty string is valid (an empty
 *  file); does not attempt to validate anything about text-lane content, which is never base64. */
export function isValidBase64(content: string): boolean {
  return BASE64_PATTERN.test(content);
}
