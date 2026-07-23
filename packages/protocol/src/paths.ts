import { AppError } from "./errors.js";

const DRIVE_LETTER = /^[a-zA-Z]:[\\/]/;
// `.excalidraw` is the legacy Excalidraw-for-Obsidian format: plain JSON text, same as `.canvas`
// (newer Excalidraw versions save as `.excalidraw.md`, which is already covered by `.md` below).
const ELIGIBLE_EXTENSIONS = new Set([".md", ".txt", ".canvas", ".json", ".csv", ".excalidraw"]);
// Images and other binary assets a note might embed (drawings, exported previews, PDFs). These
// are synced as base64 text over the same content field - see VaultSyncEngine's readBinary/
// writeBinary handling on the client, which is the only place that cares about this distinction.
const ELIGIBLE_BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".pdf"]);

// Generous but finite: prevents a malformed/hostile path from reaching fs/Obsidian's own path
// APIs and throwing an uncaught ENAMETOOLONG (or platform equivalent) deep inside a write/mount
// codepath. Most real filesystems cap a single segment around 255 bytes; 1024 total keeps room
// for a deeply nested folder structure without letting a path grow unbounded.
const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;

export function normalizeRelativePath(input: string): string {
  if (!input || input.includes("\0") || input.startsWith("/") || input.startsWith("\\") || DRIVE_LETTER.test(input)) {
    throw new AppError("INVALID_PATH", "Path must be a safe relative path.", 422);
  }
  if (input.length > MAX_PATH_LENGTH) {
    throw new AppError("INVALID_PATH", `Path must be ${MAX_PATH_LENGTH} characters or fewer.`, 422);
  }
  const normalized = input.replaceAll("\\", "/").replace(/\/+/g, "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new AppError("INVALID_PATH", "Path must not contain empty, hidden, current, or parent segments.", 422);
  }
  if (segments.some((segment) => segment.length > MAX_SEGMENT_LENGTH)) {
    throw new AppError("INVALID_PATH", `Each path segment must be ${MAX_SEGMENT_LENGTH} characters or fewer.`, 422);
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

export function isEligibleBinaryPath(path: string): boolean {
  const lastDot = path.lastIndexOf(".");
  return lastDot >= 0 && ELIGIBLE_BINARY_EXTENSIONS.has(path.slice(lastDot).toLowerCase());
}

/** Whether a path can be synced at all - text (diffed as UTF-8) or binary (base64, e.g. images/PDFs). */
export function isEligiblePath(path: string): boolean {
  return isEligibleTextPath(path) || isEligibleBinaryPath(path);
}

/** CRDT eligibility (docs/superpowers/plans/2026-07-20-crdt-sync.md contract 1.1) - deliberately
 *  narrower than isEligiblePath()/isEligibleTextPath(): only `.md` gets the CRDT lane in v1, even
 *  though .txt/.canvas/.json/.csv/.excalidraw are also synced as text via the whole-file
 *  compare-and-swap lane. Structured formats (.canvas/.json/.excalidraw) need semantic merging, not
 *  text merging - that's ROADMAP P2 #5 territory, not this effort. */
export function isCrdtEligiblePath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}
