import { AppError } from "./errors.js";

const DRIVE_LETTER = /^[a-zA-Z]:[\\/]/;
// Extensions that safely round-trip as UTF-8; all others use base64.
const ELIGIBLE_EXTENSIONS = new Set([".md", ".txt", ".canvas", ".json", ".csv", ".excalidraw"]);

// Bound paths before they reach filesystem APIs.
const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;

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

/** Routes unknown extensions through the binary lane. */
export function isEligibleBinaryPath(path: string): boolean {
  return !path.toLowerCase().endsWith(".md") && !isEligibleTextPath(path);
}

/** Every normalized vault file is eligible for sync. */
export function isEligiblePath(_path: string): boolean {
  return true;
}

// Frozen compatibility set for clients predating default-to-binary sync.
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

/** Paths safe to expose to clients without extended binary support. */
export function isLegacyEligiblePath(path: string): boolean {
  const lastDot = path.lastIndexOf(".");
  return lastDot >= 0 && LEGACY_ELIGIBLE_EXTENSIONS.has(path.slice(lastDot).toLowerCase());
}

/** Only prose Markdown uses CRDT; structured Excalidraw Markdown stays on CAS. */
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
