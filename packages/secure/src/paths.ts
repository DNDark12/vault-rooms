/**
 * Paths inside a room, as stored in the room index. Every path a peer sends is checked here before anything touches
 * the disk: a room member who can write may only ever create or change files inside the room's folder, never in
 * Obsidian's configuration (".obsidian", where plugins live) or anywhere else on the computer.
 */

export const MAX_PATH = 400;
export const MAX_SEGMENT = 120;
// Names Windows refuses (with or without an extension).
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
// Windows "8.3" short names (LONGFI~1.MD) can stand for another file of the same folder.
const SHORT_NAME = /^[^.~]{1,6}~\d+(\.[^.]{0,3})?$/;

/** Controls, plus invisible characters that can disguise a name (zero-width, bidirectional embeddings, overrides, isolates). */
function hasControl(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
    if ((c >= 0x200b && c <= 0x200d) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff) return true;
  }
  return false;
}

/**
 * Returns the path in NFC form if it is safe to use relative to a room folder on Windows, macOS and Linux, or null.
 * Rejected: absolute paths, drive letters, "..", empty or dot-leading segments (".obsidian", ".trash", ".git"),
 * backslashes, characters Windows forbids, reserved device names, short names, trailing dots or spaces, control and
 * invisible characters.
 */
export function safeRoomPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const normalized = path.normalize("NFC");
  if (normalized.length === 0 || normalized.length > MAX_PATH || hasControl(normalized)) return null;
  if (/[\\:*?"<>|]/.test(normalized)) return null;
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment.length > MAX_SEGMENT) return null;
    if (segment.startsWith(".")) return null;
    if (segment.endsWith(".") || segment.endsWith(" ") || segment !== segment.trimStart()) return null;
    if (RESERVED.test(segment) || SHORT_NAME.test(segment)) return null;
  }
  return normalized;
}

/**
 * Case- and form-insensitive key: two paths that are the same file on Windows or macOS have equal keys. (Upper then
 * lower case folds letters like "ſ" and "ς" the way the file systems do; an unneeded match only renames a file.)
 */
export function pathKey(path: string): string {
  return path.normalize("NFC").toUpperCase().toLowerCase();
}

/** True if `path` is `folder` or inside it, compared like `pathKey`. */
export function isWithin(path: string, folder: string): boolean {
  const p = pathKey(path);
  const f = pathKey(folder);
  return p === f || p.startsWith(`${f}/`);
}

export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}
