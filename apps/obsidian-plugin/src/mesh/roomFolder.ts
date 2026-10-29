import { createHash } from "node:crypto";
import { INDEX_DOC, isMarkdownPath, isWithin, MAX_BYTES, MAX_NOTE_BYTES, MAX_PATH, MAX_SEGMENT, pathKey, randomId, safeRoomPath, SecureError, type FileEntry, type RoomReplica } from "@vault-rooms/secure";
import { reconcileYTextByLines } from "../crdtReconcile.js";

/**
 * Keeps one room's folder in the vault and the room's shared state in step.
 *
 * Shared -> disk: notes are written from their documents, attachments from their blobs, renames and deletions
 * follow the room index. Disk -> shared: new, changed, renamed and deleted files become index and document edits.
 * Rules that protect data, in order of importance:
 *  - Every path comes through safeRoomPath, so nothing is ever written outside the folder or into dot-folders, and only
 *    file types that can't run anything are written at all (SHARED_EXTENSIONS).
 *  - A file is only ever removed because the index says it was deleted, never because something is missing (a key
 *    that hasn't arrived, a half-loaded index), and nothing is written from a document that is only partly readable.
 *  - A file changed both here and remotely since the last sync is never overwritten silently: the local version is
 *    kept as a conflict copy next to it. For attachments that includes two versions made from the same one.
 *  - A remote deletion trashes a file only if it is unchanged here and not being worked on; otherwise it is shared again.
 *  - Only what was actually shared is remembered as synced, so a change that couldn't be shared is never overwritten.
 *  - In a room this user may only read, local changes are put back, with a copy kept, and the user is told.
 * Notes open in an editor are owned by the editor binding (live co-editing); this class doesn't write them.
 */

export interface FileStat {
  size: number;
  mtime: number;
}

export interface VaultLike {
  stat(path: string): FileStat | null;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  /** With `expected`, writes only if the current text passes it; returns whether it wrote. */
  writeText(path: string, text: string, expected?: (current: string) => boolean): Promise<boolean>;
  /** With `expected`, writes only if the current content passes it (and didn't change while it was read). */
  writeBytes(path: string, bytes: Uint8Array, expected?: (current: Uint8Array) => boolean): Promise<boolean>;
  rename(from: string, to: string): Promise<void>;
  /** To a trash (never deleted outright). */
  trash(path: string): Promise<void>;
  /** Vault paths of every file under `folder`, recursively. */
  listFiles(folder: string): string[];
  folderExists(path: string): boolean;
}

/**
 * What this computer made for a file that may not be stored yet: edits of these notes (`docs`), these envelopes
 * (`keys`), or its own index changes so far (`index`), for an entry made here (`created`).
 */
interface Pending {
  docs: Set<string>;
  keys: Set<string>;
  index: boolean;
  created: boolean;
}

interface Known extends FileStat {
  path: string;
  hash: string;
  /** For attachments: the blob the local file is a copy of. */
  blob?: string;
  /** That blob was made on this computer (so another version made from an older one means a real clash). */
  mine?: true;
  /**
   * Remembered while what this computer made for it wasn't safely stored yet ("entry": its new index entry, which no one
   * else has then), or only what it received ("received": a note's edits; for an attachment, the room's index, which names
   * its version). If Obsidian stopped before it was, the shared state here may lack it: such a file isn't taken as
   * "unchanged here" until the shared version matches it, and a new entry that never got stored is made again.
   */
  unstored?: true | "entry" | "received";
}

export interface RoomFolderState {
  known: Record<string, Known>;
  /** Saves of notes made here outside the editor, as stored here before 0.3.2 (now apart, see RoomFolderOptions.saveSaves). */
  saves?: unknown;
}

/** See RoomFolder.health. */
export interface RoomHealth {
  /** Why the folder doesn't sync at all, if it doesn't. */
  stopped: string | null;
  /** Files whose writing, reading or trashing here failed and is being tried again (in use, a full disk). */
  failing: string[];
  /** Files whose version here couldn't be shared (too large, the room's storage full): kept as they are here. */
  heldBack: string[];
}

export interface RoomFolderOptions {
  folder: string;
  replica: RoomReplica;
  vault: VaultLike;
  deviceName: string;
  /** True while an editor is bound to this note. */
  isBound(fileId: string): boolean;
  /** Paths that belong to another room's folder (never this room's). */
  inOtherRoom?(vaultPath: string): boolean;
  /** The folder itself was deleted here: stop syncing it (nothing is deleted for anyone else). */
  folderGone?(): void;
  /** A note stopped (or started) being held back: editors may be bound to it again (or not). */
  heldBackChanged?(): void;
  /** A pass over the shared state is done: notes may have become ready for an editor (keys arrived, doubts settled). */
  passed?(): void;
  /** What health() says changed: files started or stopped failing, or the folder stopped syncing. */
  healthChanged?(): void;
  loadState(): Promise<RoomFolderState | null>;
  saveState(state: RoomFolderState): Promise<void>;
  /**
   * Recent saves of notes made here outside the editor (see RoomReplica.recentSaves), so a clash is noticed after a
   * restart too. Stored apart from the state: they change seldom.
   */
  loadSaves(): Promise<unknown>;
  saveSaves(saves: unknown): Promise<void>;
  notify(message: string): void;
  log(message: string): void;
  now?: () => Date;
}

/**
 * The file types a room shares. Anything else (programs, scripts, shortcuts, web pages, documents that can carry
 * macros) is neither shared from this computer nor written to it when someone else adds one, so a member can't plant
 * something that runs when opened.
 */
export const SHARED_EXTENSIONS = new Set([
  "md", "canvas", "base", "txt", "csv", "tsv", "json",
  "pdf", "epub", "docx", "xlsx", "pptx", "odt", "ods", "odp",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff", "heic",
  "mp3", "wav", "m4a", "ogg", "oga", "opus", "flac", "mp4", "m4v", "webm", "mov", "mkv", "ogv",
  "zip"
]);

/**
 * Why a vault folder can't be (or become) a room's folder: a name some computers can't use (a dot folder anywhere in it
 * included), or inside, around or the same as one of `others` (the folders of the rooms shown here), compared as the
 * disk compares names. Used both to offer folders and to share one.
 */
export function folderProblem(path: string, others: string[]): string | null {
  if (safeRoomPath(path) === null) return `"${path}" can't be shared (dot folders and some characters can't be used).`;
  const clash = others.find((folder) => isWithin(path, folder) || isWithin(folder, path));
  return clash === undefined ? null : `"${path}" overlaps the folder of another room ("${clash}").`;
}

export function isShareable(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") + 1 && SHARED_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

const DELETED = "\u0000deleted";
/** Work on files that failed (a file in use, a full disk) is tried again after this, doubling up to the maximum. */
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 300_000;
/** A note changed here this recently counts as being worked on: a deletion by someone else doesn't take it away. */
const RECENT_EDIT_MS = 10 * 60_000;

/** Notes are compared and shared with "\n" line endings, as Obsidian's editor holds them (and saves them, once edited). */
export function normalizeNote(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

function sha(bytes: Uint8Array | string): string {
  return createHash("sha256").update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes).digest("base64url");
}

function splitName(path: string): { stem: string; ext: string } {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? { stem: path.slice(0, dot), ext: path.slice(dot) } : { stem: path, ext: "" };
}

function code(error: unknown): string {
  return error instanceof SecureError ? error.code : "error";
}

/** A move of the folder's own, from one vault path to another (both, so another move from the same file can't take its place). */
function movingMark(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/** `path` with ` (tag)` before its extension, its name shortened to fit a path segment and a whole path; null if it can't. */
function suffixed(path: string, tag: string): string | null {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const { stem, ext } = splitName(path.slice(slash + 1));
  const suffix = ` (${tag})`;
  const room = Math.min(MAX_SEGMENT, MAX_PATH - dir.length) - suffix.length - ext.length;
  if (room < 1) return null;
  // Never half of a character made of two (a surrogate pair).
  const cut = stem.slice(0, room).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
  return cut ? safeRoomPath(`${dir}${cut}${suffix}${ext}`) : null;
}

export class RoomFolder {
  private known = new Map<string, Known>();
  private expected = new Map<string, string>();
  /** Moves this folder makes (see move and movingMark), each until its rename event comes. */
  private moving = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private materializeTimer: ReturnType<typeof setTimeout> | null = null;
  /** A pass is queued and hasn't started: it will see every change made until it does. */
  private passQueued = false;
  /**
   * What the next pass looks at: the notes changed since the last one (`dirty`), or every file (`everything`: at the
   * start, and when the index, a key or an attachment came in). Each change to a note reaches remoteChanged with it.
   */
  private dirty = new Set<string>();
  private everything = true;
  /** A pass that will try again what failed (see retrySoon), how long the next one waits, and what it tries again. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryIn = RETRY_FIRST_MS;
  private retryIds = new Set<string>();
  /** A removal or rename failed: the retry is a full pass. Taking in local files failed: the retry tries again. */
  private retryAll = false;
  /** The next pass is a retry's (see retrySoon). */
  private retrying = false;
  private retryAdopt = false;
  /** Versions of files kept as conflict copies since they were last synced, by path key: kept once (see keepAside). */
  private keptAside = new Map<string, { hash: string; name: string }>();
  /** Work that failed and isn't done yet (by file path, or "renames"): what went wrong. See health. */
  private failing = new Map<string, string>();
  /** Why the folder doesn't sync at all (what it last synced couldn't be read), if so. */
  private loadProblem: string | null = null;
  /**
   * The folder's files by path key (room-relative names), for untrackedCaseVariant: listed once per pass when first
   * needed, and kept up to date from the vault's events meanwhile.
   */
  private localNames: Map<string, Set<string>> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private deleteTimer: ReturnType<typeof setTimeout> | null = null;
  private deletions = new Set<string>();
  /** Local versions that couldn't be shared (too large, refused), by file id: their hash. */
  private heldBack = new Map<string, string>();
  /** Attachments changed here, by file id: when. */
  private binEdits = new Map<string, number>();
  /** Copies this device made of a reader's own changes: local only, not to be reported again. */
  private localOnly = new Set<string>();
  private told = new Set<string>();
  /** Files remembered in this session while something made here for them was still being stored: what to check. */
  private unstoredNow = new Map<string, Pending>();
  /** Notes whose new entry had to wait for the room key, by file id: their path. Remembered (when shared) as entries made here. */
  private queuedEntries = new Map<string, string>();
  private needsAdopt = false;
  /** What was last synced is loaded: decisions can be made. */
  private started = false;
  /** The first pass after starting is done: editors may be bound. */
  private ready = false;
  private readOnlyNoticeAt = 0;
  private stopped = false;
  /** Clash copies to keep, by file id (see noteClashed): written by the next pass, before the note itself. */
  private toKeep = new Map<string, string[]>();
  /** What RoomReplica.savesChanged was when the saves were last stored. */
  private savesStored = -1;
  /** The stored saves couldn't be read when the folder started: read again before they are stored, never written over. */
  private savesUnread = false;

  constructor(private readonly o: RoomFolderOptions) {
    if (safeRoomPath(o.folder) === null) throw new Error(`"${o.folder}" can't hold a room.`);
  }

  // ---- paths ----

  private get prefix(): string {
    return `${this.o.folder}/`;
  }

  /** Room-relative path for a vault path inside the folder (null if outside, in another room's folder, or unsafe). */
  relative(vaultPath: string): string | null {
    if (!vaultPath.startsWith(this.prefix) || this.o.inOtherRoom?.(vaultPath)) return null;
    return safeRoomPath(vaultPath.slice(this.prefix.length));
  }

  /** Inside the folder, but under a name that can't be shared. */
  private unsafeInside(vaultPath: string): boolean {
    return vaultPath.startsWith(this.prefix) && !this.o.inOtherRoom?.(vaultPath) && safeRoomPath(vaultPath.slice(this.prefix.length)) === null;
  }

  private vaultPath(relative: string): string {
    return `${this.o.folder}/${relative}`;
  }

  private idAt(relative: string): string | undefined {
    const key = pathKey(relative);
    for (const [id, known] of this.known) if (pathKey(known.path) === key) return id;
    return undefined;
  }

  /** The file id of a note at a vault path, for the editor binding (none before the first pass, or while its local version is held back or in doubt). */
  noteIdAt(vaultPath: string): string | null {
    const relative = this.relative(vaultPath);
    if (relative === null || !this.ready) return null;
    const id = this.idAt(relative) ?? [...this.o.replica.files()].find(([, entry]) => pathKey(entry.path) === pathKey(relative))?.[0];
    return id && this.o.replica.files().get(id)?.kind === "md" && !this.heldBack.has(id) && !this.doubtful(id) ? id : null;
  }

  /** Stop tracking a file (gone, or no longer the room's), and whatever was held back of it. */
  private forget(id: string): void {
    this.known.delete(id);
    if (this.heldBack.delete(id)) this.o.heldBackChanged?.();
  }

  /** Remembered in an earlier session before what was made here got stored: settled by the next pass, not by an editor. */
  private doubtful(id: string): boolean {
    return this.known.get(id)?.unstored !== undefined && !this.unstoredNow.has(id);
  }

  /** Whether a file's content (by hash) came from the shared state: what was last synced, or what is being written now. */
  fromShared(fileId: string, hash: string): boolean {
    const known = this.known.get(fileId);
    return known !== undefined && (known.hash === hash || this.expected.get(this.vaultPath(known.path)) === hash);
  }

  // ---- running ----

  /** Tasks run one at a time. Once the room's replica is gone, nothing more is done here but the final save (`last`). */
  private run(task: () => Promise<void>, last = false): Promise<void> {
    const step = () => (this.o.replica.isDestroyed && !last ? Promise.resolve() : task());
    const next = this.queue.then(step, step).catch((error: Error) => this.o.log(`room folder: ${error.stack ?? error.message}`));
    this.queue = next;
    return next;
  }

  private async readNote(path: string): Promise<string> {
    return normalizeNote(await this.o.vault.readText(path));
  }

  /** One file's trouble (locked, a folder in the way, ...) mustn't stop the others. */
  private async safely(what: string, task: () => Promise<void>): Promise<boolean> {
    try {
      await task();
      if (this.failing.delete(what)) this.o.healthChanged?.();
      return true;
    } catch (error) {
      this.o.log(`room folder, ${what}: ${(error as Error).message}`);
      if (!this.failing.has(what)) this.o.healthChanged?.();
      this.failing.set(what, (error as Error).message);
      return false;
    }
  }

  /** How the folder's syncing goes, from its own work: for the panel, so trouble stays visible after a notice is gone. */
  health(): RoomHealth {
    const pathOf = (id: string) => this.known.get(id)?.path ?? this.queuedEntries.get(id) ?? id;
    return { stopped: this.loadProblem, failing: [...this.failing.keys()], heldBack: [...this.heldBack.keys()].map(pathOf) };
  }

  /** Try again now what failed (rather than when its next retry is due). */
  retryNow(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryIn = RETRY_FIRST_MS;
    this.retryIds.clear();
    if (this.retryAdopt) this.needsAdopt = true;
    this.retryAll = this.retryAdopt = false;
    this.everything = true;
    // Held-back files too: looked at afresh (shared now if they can be, held back again if not).
    if (this.heldBack.size > 0) {
      this.heldBack.clear();
      this.o.heldBackChanged?.();
    }
    if (this.started && !this.stopped) this.queuePass();
  }

  /**
   * Load what was last synced, then take in local files and the shared state. Nothing is decided before that: without
   * it every file would look new (and be kept as a conflict copy, or shared twice).
   */
  start(): Promise<void> {
    return this.run(async () => {
      let saved: RoomFolderState | null;
      try {
        saved = await this.o.loadState();
      } catch (error) {
        // Without it every file would look new: better not to sync this folder at all than to guess.
        this.loadProblem = `what was last synced here couldn't be read (${(error as Error).message})`;
        this.o.healthChanged?.();
        this.o.notify(`"${this.o.folder}" isn't syncing: ${this.loadProblem}. Try again from the Vault Rooms panel, or restart Obsidian.`);
        throw error;
      }
      for (const [id, known] of Object.entries(saved?.known ?? {})) this.known.set(id, known);
      // Stored with the state before 0.3.2, apart since. Saves that can't be read only miss a clash, never lose anything.
      this.o.replica.restoreSaves(saved?.saves);
      try {
        this.o.replica.restoreSaves(await this.o.loadSaves());
      } catch {
        this.savesUnread = true;
      }
      this.started = true;
      if (!(await this.adoptLocalFiles())) this.needsAdopt = true;
      await this.materializeNow();
      this.ready = true;
      this.o.passed?.();
    });
  }

  stop(): Promise<void> {
    this.stopped = true;
    for (const timer of [this.materializeTimer, this.saveTimer, this.deleteTimer, this.retryTimer]) if (timer) clearTimeout(timer);
    this.materializeTimer = this.saveTimer = this.deleteTimer = this.retryTimer = null;
    return this.run(async () => {
      // Never loaded: the saved state stays as it was.
      if (!this.started) return;
      // Deletions made just before stopping still count, unless the folder itself went (moved or deleted), or the room.
      if (this.deletions.size > 0 && !this.o.replica.isDestroyed && this.o.vault.folderExists(this.o.folder)) await this.flushDeletions();
      // What this computer made is stored before the state that counts on it is saved (a stuck disk isn't waited for long).
      await Promise.race([this.o.replica.stored(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      await this.saveNow();
    }, true);
  }

  /** Call when the room index or a note (`docId`: only that one) changed remotely, or a key arrived. */
  remoteChanged(docId?: string): void {
    if (docId !== undefined && docId !== INDEX_DOC) this.dirty.add(docId);
    else this.everything = true;
    if (this.stopped || this.materializeTimer) return;
    this.materializeTimer = setTimeout(() => {
      this.materializeTimer = null;
      this.queuePass();
    }, 150);
  }

  /** At most one pass waits at a time (while one runs), so a burst of changes doesn't queue a pass for each. */
  private queuePass(): void {
    if (this.passQueued) return;
    this.passQueued = true;
    void this.run(async () => {
      this.passQueued = false;
      await this.materializeNow();
    });
  }

  /** Wait until everything queued so far has run (tests, shutdown). */
  async settled(): Promise<void> {
    if (this.materializeTimer) {
      clearTimeout(this.materializeTimer);
      this.materializeTimer = null;
      this.queuePass();
    }
    if (this.deleteTimer) {
      clearTimeout(this.deleteTimer);
      this.deleteTimer = null;
      void this.run(() => this.flushDeletions());
    }
    await this.queue;
  }

  /**
   * A save of a note made here outside the editor and someone else's, made at the same moment, changed the same line,
   * and the other's was kept, or text typed here went into a line such a save replaced (see RoomReplica): `version`, the
   * note as it was here, is kept as a copy by the next pass, whether or not the note is open in an editor, and the
   * replica told then (RoomReplica.copyKept). What gave way is taken out of the note only once the copy is written, so
   * the version made here is never lost; a copy that can't be written yet is tried again by every pass.
   */
  noteClashed(fileId: string, version: string): boolean {
    if (this.stopped) return false;
    const versions = this.toKeep.get(fileId) ?? [];
    if (!versions.includes(version)) this.toKeep.set(fileId, [...versions, version]);
    this.remoteChanged(fileId);
    return false;
  }

  /** Clash copies asked for (see noteClashed) are written, and the replica told, so what gave way can go. */
  /** Returns whether every copy that could be written was (one that failed is tried again, see retrySoon). */
  private async keepClashCopies(): Promise<boolean> {
    let done = true;
    for (const [id, versions] of [...this.toKeep]) {
      const entry = this.o.replica.entries().get(id);
      // A note deleted meanwhile needs no copy, and nothing is taken out of it (asked again if it comes back).
      if (entry?.deleted) {
        this.toKeep.delete(id);
        continue;
      }
      // One this folder doesn't write (not in the index here yet, or under a name it doesn't share, which a copy would
      // keep) waits, both lines staying in the note.
      if (entry?.kind !== "md" || !this.writesHere(entry.path)) continue;
      for (const version of versions) {
        done =
          (await this.safely(entry.path, async () => {
            await this.keepAside(entry.path, version);
            const left = (this.toKeep.get(id) ?? []).filter((one) => one !== version);
            if (left.length > 0) this.toKeep.set(id, left);
            else this.toKeep.delete(id);
            this.o.replica.copyKept(id, version);
          })) && done;
      }
    }
    return done;
  }

  /** Whether a note's local version is held back (couldn't be shared): the editor shouldn't be bound to it. */
  isHeldBack(fileId: string): boolean {
    return this.heldBack.has(fileId);
  }

  /** An editor's change to a note couldn't be shared: leave the note as it is here until its file can be shared again. */
  holdBackNote(fileId: string): void {
    this.heldBack.set(fileId, "");
  }

  private saveSoon(): void {
    if (this.saveTimer || this.stopped) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.run(() => this.saveNow());
    }, 500);
  }

  private async saveNow(): Promise<void> {
    // Stored meanwhile: no longer in doubt, or less (only what it received).
    for (const [id, pending] of this.unstoredNow) {
      const unstored = this.unstored(pending);
      if (!unstored) this.unstoredNow.delete(id);
      const known = this.known.get(id);
      if (known && unstored) known.unstored = unstored;
      else if (known) delete known.unstored;
    }
    await this.o.saveState({ known: Object.fromEntries(this.known) });
    await this.storeSaves();
  }

  /**
   * The saves (see RoomReplica.recentSaves), stored apart and only when they changed; never over stored ones that
   * couldn't be read (they are read first). Saves not stored only miss a clash after a restart: a failure here never
   * stops the state being stored.
   */
  private async storeSaves(): Promise<void> {
    try {
      if (this.savesUnread) {
        this.o.replica.restoreSaves(await this.o.loadSaves());
        this.savesUnread = false;
      }
      const saves = this.o.replica.savesChanged;
      if (saves === this.savesStored) return;
      await this.o.saveSaves(this.o.replica.recentSaves());
      this.savesStored = saves;
    } catch (error) {
      this.o.log(`room folder, saves: ${(error as Error).message}`);
    }
  }

  /**
   * Remember a file as synced. What this computer made for it counts only once stored: edits of its note, and `made`,
   * the envelopes (by key) it just made for the file's entry (`created`: a new entry); and so does what it received for
   * its note. Until then the file is marked (see Known.unstored), and the mark is checked again whenever state is saved.
   */
  private remember(id: string, path: string, hash: string, blob?: { id: string; by: string }, made: Array<string | null> = [], created = false): void {
    const replica = this.o.replica;
    this.keptAside.delete(pathKey(path));
    const stat = this.o.vault.stat(this.vaultPath(path));
    const pending = this.unstoredNow.get(id) ?? { docs: new Set<string>(), keys: new Set<string>(), index: false, created: false };
    if (isMarkdownPath(path)) pending.docs.add(id);
    for (const key of made) if (key) pending.keys.add(key);
    pending.created ||= created;
    if (this.queuedEntries.delete(id)) pending.index = pending.created = true;
    const unstored = this.unstored(pending);
    if (unstored) this.unstoredNow.set(id, pending);
    else this.unstoredNow.delete(id);
    this.known.set(id, {
      path,
      hash,
      size: stat?.size ?? -1,
      mtime: stat?.mtime ?? -1,
      ...(blob ? { blob: blob.id, ...(blob.by === replica.deviceId ? { mine: true as const } : {}) } : {}),
      ...(unstored ? { unstored } : {})
    });
    if (this.heldBack.delete(id)) this.o.heldBackChanged?.();
    this.saveSoon();
  }

  /** The file's mark while something for it isn't safely stored yet (see Known.unstored), else undefined. */
  private unstored(pending: Pending): Known["unstored"] {
    const replica = this.o.replica;
    const docs = [...pending.docs];
    const keys = [...pending.keys];
    if (pending.index) keys.push(replica.ownUpdateKey(INDEX_DOC) ?? "");
    if (replica.hasUnstored(docs, keys) || (pending.index && replica.hasUnsent(INDEX_DOC))) return pending.created ? "entry" : true;
    // A note's content is its own document; an attachment's version is named in the room's index.
    return replica.hasUnstoredReceived(docs.length > 0 ? docs : [INDEX_DOC]) ? "received" : undefined;
  }

  /** Tell the user once about something (per subject). */
  private tellOnce(subject: string, message: string): void {
    if (this.told.has(subject)) return;
    this.told.add(subject);
    this.o.notify(message);
  }

  private readOnlyNotice(message: string): void {
    if (Date.now() - this.readOnlyNoticeAt < 10_000) return;
    this.readOnlyNoticeAt = Date.now();
    this.o.notify(message);
  }

  private notShared(relative: string, why: "type" | "size" | "name"): void {
    const reason = {
      type: "files of this type aren't shared in rooms",
      size: `it is too large to share (notes over ${MAX_NOTE_BYTES >> 20} MB, other files over ${(MAX_BYTES.b >> 20) - 1} MB)`,
      name: "its name can't be used on every computer (too long, or with characters some systems refuse)"
    }[why];
    this.tellOnce(`${why}:${relative}`, `"${relative}" stays on this computer only: ${reason}.`);
  }

  // ---- writing to disk (ours, so the resulting vault events are ignored) ----

  /** Do something to a file that its vault event will report: `mark` says what to expect, dropped if it doesn't happen. */
  private async expecting<T>(path: string, mark: string, act: () => Promise<T>, happened: (result: T) => boolean = () => true): Promise<T> {
    this.expected.set(path, mark);
    try {
      const result = await act();
      if (!happened(result)) this.expected.delete(path);
      return result;
    } catch (error) {
      // Failed (in use, a full disk): a later change by someone else isn't taken for ours.
      this.expected.delete(path);
      throw error;
    }
  }

  private writeText(relative: string, text: string, expected?: (current: string) => boolean): Promise<boolean> {
    const path = this.vaultPath(relative);
    return this.expecting(path, sha(text), () => this.o.vault.writeText(path, text, expected), (wrote) => wrote);
  }

  private writeBytes(relative: string, bytes: Uint8Array, expected?: (current: Uint8Array) => boolean): Promise<boolean> {
    const path = this.vaultPath(relative);
    return this.expecting(path, sha(bytes), () => this.o.vault.writeBytes(path, bytes, expected), (wrote) => wrote);
  }

  private trash(relative: string): Promise<void> {
    const path = this.vaultPath(relative);
    return this.expecting(path, DELETED, () => this.o.vault.trash(path));
  }

  /**
   * Move a file, its rename event marked as ours apart from the marks of writes: a new file written at the old name in
   * the same pass must not make this move look like the user's (and the new file be renamed for everyone).
   */
  private async move(from: string, to: string): Promise<void> {
    const [oldPath, newPath] = [this.vaultPath(from), this.vaultPath(to)];
    const mark = movingMark(oldPath, newPath);
    this.moving.add(mark);
    try {
      await this.o.vault.rename(oldPath, newPath);
    } catch (error) {
      this.moving.delete(mark);
      throw error;
    }
  }

  /** A free name next to `relative` for a copy of a file that would otherwise be lost (one safe path segment). */
  private copyName(relative: string, label: string): string {
    const slash = relative.lastIndexOf("/");
    const dir = relative.slice(0, slash + 1);
    const { stem, ext } = splitName(relative.slice(slash + 1));
    const stamp = (this.o.now?.() ?? new Date()).toISOString().slice(0, 16).replace("T", " ").replace(":", "");
    const device = this.o.deviceName.replace(/[\\/:*?"<>|.]/g, "").trim().slice(0, 40) || "this computer";
    for (let i = 1; ; i++) {
      const suffix = ` (${label} ${device} ${stamp}${i > 1 ? ` ${i}` : ""})`;
      const name = `${stem.slice(0, Math.max(1, MAX_SEGMENT - suffix.length - ext.length)).trimEnd()}${suffix}${ext}`;
      const candidate = safeRoomPath(`${dir}${name}`) ?? `${dir}copy ${stamp.replace(/[ ]/g, "-")} ${i}${ext}`;
      if (!this.o.vault.stat(this.vaultPath(candidate))) return candidate;
    }
  }

  private async keepAside(relative: string, content: string | Uint8Array): Promise<string> {
    // This very version is kept already (by a try that failed after it, say), and the copy is still there: not again.
    const hash = sha(content);
    const kept = this.keptAside.get(pathKey(relative));
    if (kept?.hash === hash && this.o.vault.stat(this.vaultPath(kept.name))) return kept.name;
    const name = this.copyName(relative, "conflict");
    // Not marked as ours: the copy is a local addition and gets shared like any other.
    if (typeof content === "string") await this.o.vault.writeText(this.vaultPath(name), content);
    else await this.o.vault.writeBytes(this.vaultPath(name), content);
    this.keptAside.set(pathKey(relative), { hash, name });
    this.o.notify(`"${relative}" was changed here and by someone else at the same time. Your version is kept as "${name}".`);
    return name;
  }

  // ---- shared -> disk ----

  /** The paths files should have here: index paths, with deterministic suffixes when two entries collide. */
  private desired(): Map<string, FileEntry> {
    const groups = new Map<string, Array<[string, FileEntry]>>();
    for (const [id, entry] of this.o.replica.files()) {
      if (!this.writesHere(entry.path)) continue;
      const key = pathKey(entry.path);
      groups.set(key, [...(groups.get(key) ?? []), [id, entry]]);
    }
    const out = new Map<string, FileEntry>();
    const renames: Array<[string, FileEntry, string]> = [];
    // A new name fits every limit and is no other file's (nor one given just before): with the id's start, longer if
    // that is taken. Groups go in a fixed order, so every device names them alike.
    const taken = new Set(groups.keys());
    const clashing: string[] = [];
    for (const [key, group] of groups) {
      if (group.length === 1) out.set(group[0]![0], group[0]![1]);
      else clashing.push(key);
    }
    for (const key of clashing.sort()) {
      const group = groups.get(key)!.sort(([a], [b]) => (a < b ? -1 : 1));
      group.forEach(([id, entry], index) => {
        if (index === 0) return out.set(id, entry);
        const path = [id.slice(1, 5), id.slice(1, 9), id.slice(1)].map((tag) => suffixed(entry.path, tag)).find((name) => name !== null && !taken.has(pathKey(name)));
        // No name fits (its folders already fill the path): not written here, rather than over the other file.
        if (!path) return;
        taken.add(pathKey(path));
        out.set(id, { ...entry, path });
        renames.push([id, entry, path]);
      });
    }
    // Writers settle the clash for everyone, the same way on every device.
    if (renames.length > 0 && this.o.replica.canWrite()) {
      this.o.replica.editIndex((files) => {
        for (const [id, entry, path] of renames) files.set(id, { ...entry, path });
      });
    }
    return out;
  }

  /** Whether this folder writes a file at a room path: one of a type rooms share, not in another room's folder. */
  private writesHere(relative: string): boolean {
    return isShareable(relative) && !this.o.inOtherRoom?.(this.vaultPath(relative));
  }

  private async materializeNow(): Promise<void> {
    if (this.stopped || !this.started) return;
    const { everything, dirty, retrying } = this;
    this.everything = this.retrying = false;
    this.dirty = new Set();
    this.localNames = null;
    // Clash copies first: a note waiting for its copy is written once it is kept (and what gave way is gone).
    let done = await this.keepClashCopies();
    const replica = this.o.replica;
    const desired = this.desired();
    // Removals and renames only from a fully readable index: a gap there is never taken for a deletion.
    if (everything && replica.isComplete(INDEX_DOC)) {
      const entries = replica.entries();
      let whole = true;
      for (const [id, known] of [...this.known]) {
        if (entries.get(id)?.deleted) whole = (await this.safely(known.path, () => this.applyRemoval(id, known))) && whole;
        else if (!entries.has(id) && this.doubtful(id) && known.unstored === "entry") {
          // Shared in a session that ended before its new entry was stored, so no one has it: shared again.
          this.forget(id);
          this.needsAdopt = true;
        }
      }
      whole = (await this.safely("renames", () => this.applyRenames(desired))) && whole;
      // What failed (a file in use, say) is looked at again by the full pass of the next retry (see retrySoon).
      if (!whole) {
        this.retryAll = true;
        done = false;
      }
    }
    // Whose each local name is, once the renames are done: a file still tracked as another's (whose rename or removal
    // is still to come, a file in the way being in use) is never taken for this one, nor written over.
    const owners = new Map([...this.known].map(([id, known]) => [pathKey(known.path), id] as const));
    for (const [id, entry] of desired) {
      if (!everything && !dirty.has(id) && !this.toKeep.has(id)) continue;
      const owner = owners.get(pathKey(entry.path));
      // One that failed (a file in use, say), or must wait for another, is tried again by the next retry.
      if ((owner !== undefined && owner !== id) || !(await this.safely(entry.path, () => this.applyContent(id, entry)))) {
        this.retryIds.add(id);
        done = false;
      }
    }
    if (this.needsAdopt && replica.canWrite()) {
      this.needsAdopt = false;
      if (!(await this.adoptLocalFiles())) {
        this.retryAdopt = true;
        done = false;
      }
    }
    // Work that failed is tried again by itself, soon at first and less often while it keeps failing: back to the first
    // delay only when a retry's own pass goes fine (other passes may well go fine meanwhile).
    if (!done) this.retrySoon();
    else if (retrying) this.retryIn = RETRY_FIRST_MS;
    // A whole pass without trouble: whatever failed before (for a file gone since, say) isn't failing any more, unless
    // taking in local files waits to be tried again (a whole pass doesn't).
    if (done && everything && !this.retryAdopt && this.failing.size > 0) {
      this.failing.clear();
      this.o.healthChanged?.();
    }
    this.saveSoon();
    if (this.ready) this.o.passed?.();
  }

  /** What failed is tried again by a pass of its own, on this schedule only (passes for other changes stay small). */
  private retrySoon(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retrying = true;
      for (const id of this.retryIds) this.dirty.add(id);
      this.retryIds.clear();
      if (this.retryAll) this.everything = true;
      if (this.retryAdopt) this.needsAdopt = true;
      this.retryAll = this.retryAdopt = false;
      this.queuePass();
    }, this.retryIn);
    this.retryIn = Math.min(this.retryIn * 2, RETRY_MAX_MS);
  }

  private async applyRenames(desired: Map<string, FileEntry>): Promise<void> {
    const moves = new Map<string, { from: string; to: string }>();
    for (const [id, entry] of desired) {
      const known = this.known.get(id);
      if (known && known.path !== entry.path && this.o.vault.stat(this.vaultPath(known.path))) moves.set(id, { from: known.path, to: entry.path });
    }
    while (moves.size > 0) {
      let progressed = false;
      for (const [id, { from, to }] of moves) {
        if (this.o.vault.stat(this.vaultPath(to)) && pathKey(from) !== pathKey(to)) continue;
        await this.move(from, to);
        this.known.set(id, { ...this.known.get(id)!, path: to });
        moves.delete(id);
        progressed = true;
      }
      if (progressed) continue;
      // Every target is taken: a swap or a file in the way. Move one aside under a visible temporary name.
      const [, move] = moves.entries().next().value as [string, { from: string; to: string }];
      const occupant = this.idAt(move.to);
      if (occupant && moves.has(occupant)) {
        const from = moves.get(occupant)!.from;
        const temporary = suffixed(from, `moving ${occupant.slice(1, 5)}`) ?? `${from.slice(0, from.lastIndexOf("/") + 1)}moving ${occupant.slice(1, 9)}${splitName(from).ext}`;
        await this.move(from, temporary);
        this.known.set(occupant, { ...this.known.get(occupant)!, path: temporary });
        moves.set(occupant, { from: temporary, to: moves.get(occupant)!.to });
      } else if (occupant) {
        // Another file is still tracked there (its removal to come: in use, say): the renames wait for it (retried).
        throw new Error(`"${move.to}" is still another file's here`);
      } else {
        // An untracked local file is in the way: keep it under a conflict name.
        await this.keepAside(move.to, await this.o.vault.readBytes(this.vaultPath(move.to)));
        await this.trash(move.to);
      }
    }
  }

  /** A file here whose name differs from `relative` only in case (the same file on Windows and macOS), if untracked. */
  private untrackedCaseVariant(relative: string): string | null {
    if (!this.localNames) {
      this.localNames = new Map();
      for (const path of this.o.vault.listFiles(this.o.folder)) this.noteLocal(path, true);
    }
    for (const other of this.localNames.get(pathKey(relative)) ?? []) if (other !== relative && !this.idAt(other) && this.o.vault.stat(this.vaultPath(other))) return other;
    return null;
  }

  /** Keep localNames (when listed) in step with a file of the folder appearing or going away. */
  private noteLocal(vaultPath: string, present: boolean): void {
    const relative = this.localNames ? this.relative(vaultPath) : null;
    if (relative === null) return;
    const key = pathKey(relative);
    const names = this.localNames!.get(key) ?? new Set<string>();
    if (present) this.localNames!.set(key, names.add(relative));
    else names.delete(relative);
  }

  private async applyContent(id: string, entry: FileEntry): Promise<void> {
    const replica = this.o.replica;
    const path = this.vaultPath(entry.path);
    const known = this.known.get(id);
    if (entry.kind === "md" && this.o.isBound(id)) return;
    // A local version that couldn't be shared stays as it is, never written over (see holdBack).
    if (this.heldBack.has(id)) return;
    // Not under its new name here yet (another file in the way couldn't be moved or trashed): what is at the new name
    // isn't this file, and is never taken for it. The renames are tried again.
    if (known && known.path !== entry.path && this.o.vault.stat(this.vaultPath(known.path))) return;
    // Left from a session that may have ended before what it made was stored: proven only by a matching shared copy.
    const doubtful = this.doubtful(id);
    /** The file is as it was when last synced (by its size and time). */
    const unchanged = (stat: FileStat | null) => stat !== null && !doubtful && known?.path === entry.path && known.size === stat.size && known.mtime === stat.mtime;
    let remote: string | Uint8Array | null;
    if (entry.kind === "md") {
      // Part of the note can't be read yet, or our own edit is waiting for the room key: nothing to decide on yet.
      if (!replica.isComplete(id) || replica.hasUnsent(id)) return;
      remote = normalizeNote(replica.noteText(id));
      // A clash copy to keep first (asked for as the note loaded, maybe): never written with both lines meanwhile.
      if (this.toKeep.has(id)) return;
    } else {
      // The same version as last synced, and the file untouched since: nothing to read (attachments can be large).
      if (known?.blob === entry.blob?.id && unchanged(this.o.vault.stat(path))) return;
      remote = entry.blob ? await replica.readBlob(entry.blob) : null;
    }
    if (remote === null) return; // the attachment hasn't arrived yet
    const remoteHash = sha(remote);
    const stat = this.o.vault.stat(path);
    if (!stat) {
      const variant = this.untrackedCaseVariant(entry.path);
      if (variant) {
        await this.keepAside(variant, await this.o.vault.readBytes(this.vaultPath(variant)));
        await this.trash(variant);
      }
      return this.write(id, entry, remote, remoteHash);
    }
    const unchangedHere = known !== undefined && unchanged(stat);
    if (unchangedHere) {
      if (remoteHash === known.hash) {
        // The same bytes in another blob (a writer passing on someone else's file, say): remembered, so it isn't read again.
        if (entry.blob && entry.blob.id !== known.blob) this.remember(id, entry.path, remoteHash, { id: entry.blob.id, by: known.mine ? replica.deviceId : "" });
        return;
      }
      // Another version of an attachment made from an older one than the version this computer made (two people
      // changed it at once): keep ours. A version of someone else's that we merely had is just older.
      if (entry.kind === "bin" && known.mine && entry.blob && entry.blob.id !== known.blob && entry.base !== known.blob) await this.keepAside(entry.path, await this.o.vault.readBytes(path));
      return this.write(id, entry, remote, remoteHash, known.hash);
    }
    const local = entry.kind === "md" ? await this.readNote(path) : await this.o.vault.readBytes(path);
    const localHash = sha(local);
    if (localHash === remoteHash) return this.remember(id, entry.path, remoteHash, entry.blob);
    if (!known || (localHash === known.hash && !doubtful)) {
      // Nothing changed here since the last sync (or a file we never tracked sits at this path): the shared copy wins,
      // but an untracked file with content is kept aside first.
      if (!known && local.length > 0) await this.keepAside(entry.path, local);
      return this.write(id, entry, remote, remoteHash, localHash);
    }
    if (remoteHash === known.hash && !doubtful) {
      // Only changed here (e.g. while Obsidian was closed): share the local version, unless it is already held back.
      if (this.heldBack.get(id) === localHash) return;
      return this.localChanged(id, entry, local, localHash);
    }
    // Changed on both sides since the last sync.
    await this.keepAside(entry.path, local);
    await this.write(id, entry, remote, remoteHash, localHash);
  }

  /** Write the shared version, only if the file is still what the decision was based on (checked as it is written). */
  private async write(id: string, entry: FileEntry, remote: string | Uint8Array, remoteHash: string, basedOn?: string): Promise<void> {
    // Changed meanwhile (saved again while its copy was being kept, say), or an editor bound meanwhile (which owns the
    // note now): left as it is and looked at again next time.
    const wrote =
      typeof remote === "string"
        ? await this.writeText(entry.path, remote, (current) => !this.o.isBound(id) && (basedOn === undefined || sha(normalizeNote(current)) === basedOn))
        : await this.writeBytes(entry.path, remote, basedOn === undefined ? undefined : (current) => sha(current) === basedOn);
    if (wrote) this.remember(id, entry.path, remoteHash, entry.blob);
  }

  private lastEdit(id: string, entry: FileEntry): number {
    return entry.kind === "md" ? this.o.replica.lastLocalEdit(id) : (this.binEdits.get(id) ?? 0);
  }

  private async applyRemoval(id: string, known: Known): Promise<void> {
    const path = this.vaultPath(known.path);
    const stat = this.o.vault.stat(path);
    const entry = this.o.replica.entries().get(id);
    // Whether the others ever had this version is in doubt (see Known.unstored): it counts as a change made here. One
    // only received was theirs.
    const busy = (this.doubtful(id) && known.unstored !== "received") || (entry !== undefined && Date.now() - this.lastEdit(id, entry) < RECENT_EDIT_MS);
    // Forgotten only once the file is dealt with: one that can't be read or trashed now (in use, say) stays tracked, and
    // is tried again, rather than being left behind untracked and shared again as a new file.
    if (!stat) return this.forget(id);
    const current = (entry ? entry.kind === "md" : isMarkdownPath(known.path)) ? await this.readNote(path) : await this.o.vault.readBytes(path);
    const unchanged = !busy && ((stat.size === known.size && stat.mtime === known.mtime) || sha(current) === known.hash);
    if (unchanged) {
      await this.trash(known.path);
      this.forget(id);
      return;
    }
    // Changed here after someone else removed it, or being worked on here: keep it, and share it again as a new file.
    this.forget(id);
    if (!this.o.replica.canWrite()) return;
    await this.createEntry(known.path);
    this.o.notify(`"${known.path}" was deleted by someone else while you were working on it here. Your copy stays, and is shared again.`);
  }

  // ---- disk -> shared ----

  /**
   * Files in the folder that aren't tracked yet become shared files (when this user may write). Returns whether every
   * file was taken in that could be (one that failed, unreadable say, is tried again).
   */
  private async adoptLocalFiles(): Promise<boolean> {
    if (!this.o.replica.canWrite()) return true;
    // Paths shared or tracked here, by key: looked up per file, so built once (not a scan per file).
    const tracked = new Set([...this.o.replica.files().values(), ...this.known.values()].map((file) => pathKey(file.path)));
    let done = true;
    for (const path of this.o.vault.listFiles(this.o.folder)) {
      if (this.o.inOtherRoom?.(path)) continue;
      const relative = this.relative(path);
      if (relative === null) {
        if (this.unsafeInside(path)) this.notShared(path.slice(this.prefix.length), "name");
        continue;
      }
      if (tracked.has(pathKey(relative))) continue;
      const before = this.known.size;
      done = (await this.safely(relative, () => this.createEntry(relative))) && done;
      // Remembered now: a name differing only in case (another file where case counts) is the same path to the others.
      if (this.known.size > before) tracked.add(pathKey(relative));
    }
    return done;
  }

  private async createEntry(relative: string): Promise<void> {
    if (!isShareable(relative)) return this.notShared(relative, "type");
    const replica = this.o.replica;
    const path = this.vaultPath(relative);
    // Too large to share whatever it holds: not even read (it may be huge). A note's line endings can halve it at most.
    const size = this.o.vault.stat(path)?.size ?? 0;
    if (isMarkdownPath(relative) ? size > 2 * MAX_NOTE_BYTES : size + 16 > MAX_BYTES.b) return this.notShared(relative, "size");
    const id = randomId("f");
    if (isMarkdownPath(relative)) {
      const text = await this.readNote(path);
      if (Buffer.byteLength(text, "utf8") > MAX_NOTE_BYTES) return this.notShared(relative, "size");
      const added = replica.editIndex((files) => files.set(id, { path: relative, kind: "md" }));
      if (added === "refused") return;
      const entryKey = replica.ownUpdateKey(INDEX_DOC);
      const filled = text ? replica.edit(id, (doc) => doc.getText("content").insert(0, text)) : "published";
      if (filled === "refused") {
        replica.editIndex((files) => files.set(id, { path: relative, kind: "md", deleted: true }));
        return this.notShared(relative, "size");
      }
      // Remembered only once actually shared (a missing key leaves it to the next pass).
      if (added === "published" && filled === "published") this.remember(id, relative, sha(text), undefined, [entryKey], true);
      else this.queuedEntries.set(id, relative);
      return;
    }
    const bytes = await this.o.vault.readBytes(path);
    if (bytes.length + 16 > MAX_BYTES.b) return this.notShared(relative, "size");
    let blob;
    try {
      blob = replica.putBlob(bytes);
    } catch (error) {
      // Without the room's newest key yet: shared on a later pass.
      if (code(error) === "no_room_key") this.needsAdopt = true;
      else this.o.log(`share ${relative}: ${code(error)}`);
      return;
    }
    if (replica.editIndex((files) => files.set(id, { path: relative, kind: "bin", blob })) === "published") {
      this.remember(id, relative, sha(bytes), blob, [replica.ownUpdateKey(INDEX_DOC), replica.ownBlobKey(blob.id)], true);
    }
  }

  /** Content changed here: put it into the shared state, or put the shared version back in a read-only room. */
  private async localChanged(id: string, entry: FileEntry, local: string | Uint8Array, localHash: string): Promise<void> {
    const replica = this.o.replica;
    // Part of the shared note can't be read yet: nothing to merge with or put back (a pass does once it can).
    if (entry.kind === "md" && !replica.isComplete(id)) return;
    if (!replica.canWrite()) {
      const remote = entry.kind === "md" ? normalizeNote(replica.noteText(id)) : entry.blob ? await replica.readBlob(entry.blob) : null;
      if (remote === null) return;
      const remoteHash = sha(remote);
      if (remoteHash !== localHash) {
        // Nothing of the reader's is lost: their version stays next to the shared one, on this computer only.
        const copy = this.copyName(entry.path, "your copy");
        this.localOnly.add(this.vaultPath(copy));
        if (typeof local === "string") await this.o.vault.writeText(this.vaultPath(copy), local);
        else await this.o.vault.writeBytes(this.vaultPath(copy), local);
        const wrote =
          typeof remote === "string"
            ? await this.writeText(entry.path, remote, (current) => sha(normalizeNote(current)) === localHash)
            : await this.writeBytes(entry.path, remote, (current) => sha(current) === localHash);
        if (!wrote) return; // changed again meanwhile: looked at again next time
        this.readOnlyNotice(`You can only read this room, so "${entry.path}" was put back. Your version is kept as "${copy}" on this computer only.`);
      }
      this.remember(id, entry.path, remoteHash, entry.blob);
      return;
    }
    if (entry.kind === "md" && typeof local === "string") {
      if (Buffer.byteLength(local, "utf8") > MAX_NOTE_BYTES) return this.holdBack(id, entry.path, localHash);
      const result = replica.edit(id, (doc) => reconcileYTextByLines(doc.getText("content"), local, "disk"), true);
      if (result === "refused") return this.holdBack(id, entry.path, localHash);
      if (result === "queued") return;
      this.remember(id, entry.path, localHash);
      return;
    }
    if (!(local instanceof Uint8Array)) return;
    if (local.length + 16 > MAX_BYTES.b) return this.holdBack(id, entry.path, localHash);
    this.binEdits.set(id, Date.now());
    let blob;
    try {
      blob = replica.putBlob(local);
    } catch (error) {
      if (code(error) !== "no_room_key") this.holdBack(id, entry.path, localHash);
      return;
    }
    const result = replica.editIndex((files) => files.set(id, { ...entry, blob, ...(entry.blob ? { base: entry.blob.id } : {}) }));
    if (result === "published") this.remember(id, entry.path, localHash, blob, [replica.ownUpdateKey(INDEX_DOC), replica.ownBlobKey(blob.id)]);
  }

  /** Whether the shared version of a file differs from what was last synced here (our own unsent edits aside). */
  private async sharedMovedOn(id: string, entry: FileEntry, known: Known): Promise<boolean> {
    const replica = this.o.replica;
    if (entry.kind === "md") return !replica.hasUnsent(id) && (!replica.isComplete(id) || sha(normalizeNote(replica.noteText(id))) !== known.hash);
    if (!entry.blob || entry.blob.id === known.blob) return false;
    const remote = await replica.readBlob(entry.blob);
    return remote === null || sha(remote) !== known.hash;
  }

  /** A local version that can't be shared: kept as it is, never overwritten, and the user told once. */
  private holdBack(id: string, path: string, localHash: string): void {
    if (!this.heldBack.has(id)) this.o.heldBackChanged?.();
    this.heldBack.set(id, localHash);
    this.tellOnce(`held:${id}:${localHash}`, `Your change to "${path}" couldn't be shared (it may be too large, or the room's storage is full). It stays on this computer, and isn't overwritten.`);
  }

  /** Was this vault event caused by our own write? Consumes the expectation. */
  private isEcho(path: string, hash: string): boolean {
    const expected = this.expected.get(path);
    if (expected === undefined) return false;
    this.expected.delete(path);
    return expected === hash;
  }

  onLocalWrite(vaultPath: string): Promise<void> {
    this.noteLocal(vaultPath, true);
    return this.run(async () => {
      if (!this.started) return; // taken in by start
      if (this.localOnly.has(vaultPath)) return;
      const relative = this.relative(vaultPath);
      if (relative === null) {
        if (this.unsafeInside(vaultPath)) this.notShared(vaultPath.slice(this.prefix.length), "name");
        return;
      }
      if (!this.o.vault.stat(vaultPath)) return;
      const id = this.idAt(relative) ?? [...this.queuedEntries].find(([, path]) => pathKey(path) === pathKey(relative))?.[0];
      const entry = id ? this.o.replica.files().get(id) : undefined;
      // A new file here, nothing of ours: taken in, which checks its size before reading it (it may be huge). One that
      // can't be read yet (in use) is told of, and taken in by a retry.
      if (!id && !this.expected.has(vaultPath)) {
        if (!this.o.replica.canWrite()) return this.readOnlyNotice(`You can only read this room: "${relative}" stays on this computer and isn't shared.`);
        if (!(await this.safely(relative, () => this.createEntry(relative)))) {
          this.retryAdopt = true;
          this.retrySoon();
        }
        return;
      }
      // Still under its old name here (its rename is blocked by a file in the way): the change waits for the rename,
      // and is taken in from the new name by the pass after it, which decides by size, time and content (so a mark of
      // our own write here is dropped). An editor's save is remembered as ever (under the name it has here).
      if (id && entry && this.known.has(id) && this.known.get(id)!.path !== entry.path && !(entry.kind === "md" && this.o.isBound(id))) {
        this.expected.delete(vaultPath);
        return this.remoteChanged(id);
      }
      // Read as what the shared file is (a note or another file), even under a name that says otherwise (renamed so by
      // an earlier version): a note's text never goes out as an attachment, nor the reverse.
      const asNote = entry ? entry.kind === "md" : isMarkdownPath(relative);
      const content = asNote ? await this.readNote(vaultPath) : await this.o.vault.readBytes(vaultPath);
      const hash = sha(content);
      if (this.isEcho(vaultPath, hash)) return;
      // Someone else deleted it, and it couldn't be trashed here yet: the removal, tried again, settles it (sharing it
      // again once, if it was changed here).
      if (id && !entry && this.o.replica.entries().get(id)?.deleted) return this.remoteChanged();
      if (!id || !entry) {
        if (this.o.replica.canWrite()) return this.createEntry(relative);
        return this.readOnlyNotice(`You can only read this room: "${relative}" stays on this computer and isn't shared.`);
      }
      // In doubt whether the others ever had what was made here last time: a pass settles it with the shared copy.
      if (this.doubtful(id)) return;
      const known = this.known.get(id);
      // A new note whose entry still waits for the room key: the edit waits with it.
      if (!known) return this.localChanged(id, entry, content, hash);
      // Changed again after it was held back: looked at afresh.
      const held = this.heldBack.get(id);
      if (held !== undefined && held !== hash && this.heldBack.delete(id)) this.o.heldBackChanged?.();
      if (hash === known.hash) return this.remember(id, relative, hash, known.blob ? { id: known.blob, by: known.mine ? this.o.replica.deviceId : "" } : undefined);
      // An editor owns the note while bound (its edits already went into the shared text): remember what is on disk. Not
      // while its edits wait for the room's newest key (held in memory only, and maybe refused then): they still count as
      // changed here, should Obsidian stop before they are shared.
      if (entry.kind === "md" && this.o.isBound(id) && this.o.replica.canWrite()) {
        if (!this.o.replica.hasUnsent(id)) this.remember(id, relative, hash);
        return;
      }
      // The shared version moved on since the last sync and isn't here yet: taking this change in now would undo it, so
      // the next pass settles it like any change made on both sides (keeping a copy).
      if (this.o.replica.canWrite() && (await this.sharedMovedOn(id, entry, known))) return this.remoteChanged(id);
      await this.localChanged(id, entry, content, hash);
    });
  }

  /** Deletions wait a moment: if the room's whole folder went, that is an unmount here, not deletions for everyone. */
  onLocalDelete(vaultPath: string): Promise<void> {
    this.noteLocal(vaultPath, false);
    if (this.stopped) return Promise.resolve();
    this.deletions.add(vaultPath);
    if (!this.deleteTimer) {
      this.deleteTimer = setTimeout(() => {
        this.deleteTimer = null;
        void this.run(() => this.flushDeletions());
      }, 1000);
    }
    return Promise.resolve();
  }

  private async flushDeletions(): Promise<void> {
    if (!this.started) return;
    const paths = [...this.deletions];
    this.deletions.clear();
    if (!this.o.vault.folderExists(this.o.folder)) {
      this.o.folderGone?.();
      return;
    }
    for (const vaultPath of paths) await this.safely(vaultPath, () => this.applyLocalDelete(vaultPath));
  }

  private async applyLocalDelete(vaultPath: string): Promise<void> {
    this.localOnly.delete(vaultPath);
    const relative = this.relative(vaultPath);
    if (relative === null) return;
    if (this.expected.get(vaultPath) === DELETED) {
      this.expected.delete(vaultPath);
      return;
    }
    if (this.o.vault.stat(vaultPath)) return; // back already
    const id = this.idAt(relative);
    if (!id) return;
    this.forget(id);
    if (!this.o.replica.canWrite()) {
      this.readOnlyNotice(`You can only read this room, so "${relative}" was put back.`);
      this.dirty.add(id);
      return this.materializeNow();
    }
    const entry = this.o.replica.files().get(id);
    if (entry) this.o.replica.editIndex((files) => files.set(id, { ...entry, deleted: true }));
    this.saveSoon();
  }

  onLocalRename(oldVaultPath: string, newVaultPath: string): Promise<void> {
    this.noteLocal(oldVaultPath, false);
    this.noteLocal(newVaultPath, true);
    return this.run(async () => {
      if (!this.started) return; // taken in by start
      if (this.moving.delete(movingMark(oldVaultPath, newVaultPath))) return;
      const from = this.relative(oldVaultPath);
      const to = this.relative(newVaultPath);
      const id = from === null ? undefined : this.idAt(from);
      const unusable = (to === null && this.unsafeInside(newVaultPath)) || (to !== null && !isShareable(to));
      if (id && (to !== null || unusable)) {
        // Renamed within the room: to a name others can't have, or by a reader, it goes back to its old name.
        const back = () => {
          this.moving.add(movingMark(newVaultPath, oldVaultPath));
          return this.o.vault.rename(newVaultPath, oldVaultPath);
        };
        if (unusable) {
          this.tellOnce(`rename:${newVaultPath}`, `"${newVaultPath.slice(this.prefix.length)}" can't be used in a shared room (too long, an unusual character, or a file type that isn't shared). The file keeps its old name.`);
          return back();
        }
        // A note and other files are shared differently: one can't become the other by a new name. (Judged by what it is
        // shared as, so a note an earlier version renamed to Plan.txt may go back to Plan.md.)
        const isNote = (this.o.replica.files().get(id)?.kind ?? (isMarkdownPath(from!) ? "md" : "bin")) === "md";
        if (isNote !== isMarkdownPath(to!)) {
          this.tellOnce(`kind:${newVaultPath}`, `"${from}" keeps its name: in a shared room a note can't be renamed into another type of file, nor another file into a note. Make a copy under the new name instead.`);
          return back();
        }
        if (!this.o.replica.canWrite()) {
          this.readOnlyNotice("You can only read this room, so the file keeps its old name.");
          return back();
        }
        const entry = this.o.replica.files().get(id);
        if (entry) this.o.replica.editIndex((files) => files.set(id, { ...entry, path: to! }));
        this.known.set(id, { ...this.known.get(id)!, path: to! });
        this.saveSoon();
        return;
      }
      // Moved out of the room: it leaves the room. Moved in: it joins it.
      if (id) {
        this.forget(id);
        if (!this.o.replica.canWrite()) {
          this.dirty.add(id);
          return this.materializeNow();
        }
        const entry = this.o.replica.files().get(id);
        if (entry) this.o.replica.editIndex((files) => files.set(id, { ...entry, deleted: true }));
        this.saveSoon();
      }
      if (to !== null && !this.idAt(to)) {
        if (!this.o.replica.canWrite()) return this.readOnlyNotice(`You can only read this room: "${to}" stays on this computer and isn't shared.`);
        await this.createEntry(to);
      }
    });
  }
}
