import { createHash } from "node:crypto";
import * as Y from "yjs";
import { AppError, isCrdtEligiblePath } from "@vault-rooms/protocol";
import type { SyncTimerHost } from "./syncServer.js";

/** Shared Y.Text key used by client and relay. */
export const CRDT_TEXT_KEY = "content";

// Resource limits (contract 1.7).
export const MAX_CRDT_UPDATE_BYTES = 1 * 1024 * 1024;
export const MAX_CRDT_DOC_BYTES = 4 * 1024 * 1024;
export const MAX_CRDT_UPDATES_BEFORE_COMPACT = 200;
export const MAX_CACHED_DOCS = 500;
const IDLE_EVICTION_MS = 10 * 60 * 1000;
const MATERIALIZE_DEBOUNCE_MS = 2_000;

const INBOUND_UPDATE_ORIGIN = Symbol("crdt-inbound-update");

/** Repository surface required by the CRDT manager. */
export type CrdtRepositoryPort = {
  writeCrdtSnapshot(fileId: string, epoch: number, stateVectorBase64: string, snapshotBase64: string, upToSeq: number): void;
  getLatestCrdtSnapshot(fileId: string, epoch: number): { stateVector: string; snapshot: string; upToSeq: number } | null;
  listCrdtUpdatesSince(fileId: string, epoch: number, sinceSeq: number): Array<{ seq: number; update: string }>;
  appendCrdtUpdate(fileId: string, epoch: number, updateBase64: string): number;
  /** Production materialization is asynchronous; test doubles may remain synchronous. Writes nothing
   *  (null) for a superseded epoch or a room that has left the CRDT lane. */
  materializeCrdtContent(input: {
    fileId: string;
    epoch: number;
    content: string;
    actorUserId: string;
  }): { version: number; sha256: string } | null | Promise<{ version: number; sha256: string } | null>;
  getFileById(fileId: string): { room_id: string; relative_path: string } | null;
  /** A room's file rows, tombstones included; `sha256` is that of the materialized content. */
  listFiles(roomId: string): Array<{
    id: string;
    relative_path: string;
    crdt_epoch: number;
    sha256: string | null;
    deleted_at: string | null;
    updated_by_user_id: string | null;
  }>;
};

export type CrdtUpdatedBy = { userId: string; displayName: string };

export type CrdtMaterializedEvent = {
  fileId: string;
  roomId: string;
  relativePath: string;
  version: number;
  sha256: string;
  content: string;
  updatedBy: CrdtUpdatedBy;
};

type CachedDoc = {
  doc: Y.Doc;
  fileId: string;
  epoch: number;
  /** Number of updates applied since the last compaction (fresh load from a snapshot starts this
   *  at however many updates-since-snapshot had to be replayed, not 0 - a doc that was already
   *  most of the way to the compaction threshold before a cache eviction must not get a free reset
   *  on reload). */
  updatesSinceCompaction: number;
  lastSeq: number;
  lastAccessedAt: number;
  materializeTimer: unknown;
  lastUpdatedBy: CrdtUpdatedBy | null;
};

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

/** Caches live Y.Docs by file and epoch with size and idle eviction. */
export class CrdtDocManager {
  private readonly cache = new Map<string, CachedDoc>();
  private readonly idleSweepHandle: unknown;
  private disposed = false;
  /** Materializations that have started but not settled. */
  private readonly materializing = new Set<Promise<void>>();
  /** Rooms in the middle of `retireRoom`; their documents take no updates. */
  private readonly retiringRooms = new Set<string>();

  constructor(
    private readonly repo: CrdtRepositoryPort,
    private readonly timerHost: SyncTimerHost,
    private readonly onMaterialized: (event: CrdtMaterializedEvent) => void,
    private readonly now: () => number = Date.now,
    private readonly withDbAccess?: <T>(operation: () => T | Promise<T>) => Promise<T>
  ) {
    this.idleSweepHandle = timerHost.setInterval(() => this.evictIdle(), IDLE_EVICTION_MS);
  }

  /** Stops eviction and pending materialization timers. */
  dispose(): void {
    this.disposed = true;
    this.timerHost.clearInterval(this.idleSweepHandle);
    for (const cached of this.cache.values()) {
      if (cached.materializeTimer !== undefined) {
        this.timerHost.clearTimeout(cached.materializeTimer);
      }
    }
    this.cache.clear();
  }

  /** Creates an empty document with an initial snapshot. */
  createDocument(fileId: string, epoch: number, createdBy: CrdtUpdatedBy): void {
    this.seedDocument(fileId, epoch, "", createdBy);
  }

  /** Seeds a fresh CRDT epoch from existing whole-file text. */
  createDocumentFromText(fileId: string, epoch: number, text: string, createdBy: CrdtUpdatedBy): void {
    this.seedDocument(fileId, epoch, text, createdBy);
  }

  private seedDocument(fileId: string, epoch: number, seedText: string, createdBy: CrdtUpdatedBy): void {
    const doc = new Y.Doc();
    if (seedText.length > 0) {
      doc.getText(CRDT_TEXT_KEY).insert(0, seedText);
    }
    const stateVector = Y.encodeStateVector(doc);
    const snapshot = Y.encodeStateAsUpdate(doc);
    this.repo.writeCrdtSnapshot(fileId, epoch, toBase64(stateVector), toBase64(snapshot), 0);
    this.cache.set(this.key(fileId, epoch), {
      doc,
      fileId,
      epoch,
      updatesSinceCompaction: 0,
      lastSeq: 0,
      lastAccessedAt: this.now(),
      materializeTimer: undefined,
      lastUpdatedBy: createdBy
    });
    this.evictLruIfOverCapacity();
  }

  /** The server's current state vector for `(fileId, epoch)`, base64-encoded - half of the
   *  bidirectional handshake (contract 1.3): sent to a client as a server-initiated
   *  `crdt_sync_step1` so the client can answer with whatever the server is missing. */
  getStateVectorBase64(fileId: string, epoch: number): string {
    const cached = this.load(fileId, epoch);
    return toBase64(Y.encodeStateVector(cached.doc));
  }

  /** The update the server holds beyond what `remoteStateVectorBase64` reports having - answers a
   *  client's `crdt_sync_step1` with a `crdt_sync_step2` diff (contract 1.3). */
  getDiffUpdateBase64(fileId: string, epoch: number, remoteStateVectorBase64: string): string {
    const cached = this.load(fileId, epoch);
    let remoteStateVector: Uint8Array;
    try {
      remoteStateVector = fromBase64(remoteStateVectorBase64);
    } catch {
      throw new AppError("CRDT_INVALID_UPDATE", "Live-editing data from this device couldn't be read - reload the note.", 422);
    }
    try {
      return toBase64(Y.encodeStateAsUpdate(cached.doc, remoteStateVector));
    } catch {
      throw new AppError("CRDT_INVALID_UPDATE", "Live-editing data from this device couldn't be read - reload the note.", 422);
    }
  }

  /** Applies an inbound update from `crdt_update` or `crdt_sync_step2` (both are write messages by
   *  contract 1.8, so they share this one code path). Implements the persistence-failure invariant
   *  (contract 1.13): the update is applied to the in-memory doc *speculatively*, then durably
   *  appended - if the durable append throws, the doc is evicted from cache entirely (never left
   *  ahead of durable state) rather than attempting a surgical in-memory rollback, so the next
   *  access reloads from the last known-durable snapshot + updates-since. No fan-out decision is
   *  made here - the caller (`syncServer.ts`) only fans out after this method returns successfully,
   *  which by construction means the update already landed durably. */
  applyUpdate(fileId: string, epoch: number, updateBase64: string, updatedBy: CrdtUpdatedBy): void {
    if (this.isRetiring(fileId)) {
      // The room's final text is being materialized, so this update could never reach `files`. Same
      // rejection the room gives once it has left the CRDT lane.
      throw new AppError("CRDT_DISABLED", "Live editing is turned off for this room.", 409);
    }
    let updateBytes: Uint8Array;
    try {
      updateBytes = fromBase64(updateBase64);
    } catch {
      throw new AppError("CRDT_INVALID_UPDATE", "A live-editing update couldn't be read - reload the note.", 422);
    }
    if (updateBytes.byteLength > MAX_CRDT_UPDATE_BYTES) {
      throw new AppError("FILE_TOO_LARGE", "This live-editing change is larger than the server accepts.", 413);
    }

    const key = this.key(fileId, epoch);
    const cached = this.load(fileId, epoch);
    try {
      Y.applyUpdate(cached.doc, updateBytes, INBOUND_UPDATE_ORIGIN);
    } catch {
      // A malformed-but-decodable update (bad varint structure, etc.) - Yjs's decoder throws
      // before mutating the doc's shared state in this case, so there is nothing to roll back or
      // evict; the doc is simply untouched.
      throw new AppError("CRDT_INVALID_UPDATE", "A live-editing update couldn't be read - reload the note.", 422);
    }

    let seq: number;
    try {
      seq = this.repo.appendCrdtUpdate(fileId, epoch, updateBase64);
    } catch (error) {
      // Contract 1.13: never let the cache outrun durable state - evict entirely rather than try
      // to undo the speculative Y.applyUpdate above (Yjs has no clean partial-transaction
      // rollback once applyUpdate has run). The next load() reconstructs from the last
      // successfully durable snapshot + updates, which by definition does not include this one.
      this.cache.delete(key);
      throw error;
    }

    cached.lastSeq = seq;
    cached.updatesSinceCompaction += 1;
    cached.lastUpdatedBy = updatedBy;
    cached.lastAccessedAt = this.now();

    const docSizeBytes = Y.encodeStateAsUpdate(cached.doc).byteLength;
    if (cached.updatesSinceCompaction >= MAX_CRDT_UPDATES_BEFORE_COMPACT || docSizeBytes >= MAX_CRDT_DOC_BYTES) {
      try {
        this.compact(cached);
      } catch (error) {
        // Compaction is pure storage maintenance (contract 1.6) - the update above already landed
        // durably via appendCrdtUpdate, so a compaction failure must never surface as a rejection
        // for an update that in fact succeeded (that would also skip the fanout below, letting
        // other peers silently miss an update the server itself accepted). Log and continue; the
        // update log is simply longer than ideal until the next successful compaction attempt.
        console.error("Vault Rooms relay: CRDT compaction failed, will retry on a later update", error);
      }
    }

    this.scheduleMaterialize(cached);
  }

  /** Destructive cleanup hook (contract 1.5): drops a purged epoch's cached doc (if any) and
   *  cancels its pending materialize timer, so a stale in-memory doc for an epoch whose durable
   *  state was just purged (file/room delete, or the room converting off CRDT) can never be read
   *  or re-materialized from. Idempotent - evicting an epoch with nothing cached is a no-op. */
  evictDocument(fileId: string, epoch: number): void {
    const key = this.key(fileId, epoch);
    const cached = this.cache.get(key);
    if (!cached) return;
    if (cached.materializeTimer !== undefined) {
      this.timerHost.clearTimeout(cached.materializeTimer);
    }
    this.cache.delete(key);
  }

  /**
   * Takes a room off the CRDT lane without losing an edit or letting a stale document write over
   * whole-file content later. While this runs the room's documents reject updates. Before `switchMode`
   * flips the room, every live Markdown document's durable text must match its materialized content -
   * whatever its timers or earlier attempts did, and whether or not it was loaded since a restart -
   * and the room's documents and timers are dropped once it has flipped. A document that cannot be
   * written aborts the switch, keeping the room live and its edits scheduled. `fallbackActor` is
   * credited for a write when nothing records who last edited the document.
   */
  async retireRoom<T>(roomId: string, switchMode: () => Promise<T>, fallbackActor: CrdtUpdatedBy): Promise<T> {
    this.retiringRooms.add(roomId);
    // Cancelled in the same tick that starts rejecting updates, so none of the room's timers can
    // fire later and start a write this would not wait for.
    const cancelled = this.roomDocuments(roomId).filter((cached) => cached.materializeTimer !== undefined);
    for (const cached of cancelled) {
      this.timerHost.clearTimeout(cached.materializeTimer);
      cached.materializeTimer = undefined;
    }
    try {
      await Promise.allSettled([...this.materializing]);
      try {
        await this.landRoomDocuments(roomId, fallbackActor);
      } catch (error) {
        for (const cached of cancelled) {
          if (this.cache.get(this.key(cached.fileId, cached.epoch)) === cached) {
            this.scheduleMaterialize(cached);
          }
        }
        throw error;
      }
      const result = await switchMode();
      for (const cached of this.roomDocuments(roomId)) {
        this.evictDocument(cached.fileId, cached.epoch);
      }
      return result;
    } finally {
      this.retiringRooms.delete(roomId);
    }
  }

  /** Writes each live Markdown document of the room whose durable text differs from its materialized
   *  content. Throws on the first one that cannot be written. */
  private async landRoomDocuments(roomId: string, fallbackActor: CrdtUpdatedBy): Promise<void> {
    for (const file of this.repo.listFiles(roomId)) {
      if (file.deleted_at || !isCrdtEligiblePath(file.relative_path)) continue;
      const cached = this.cache.get(this.key(file.id, file.crdt_epoch));
      // A cached document never runs ahead of its durable state (see applyUpdate). An uncached one is
      // rebuilt outside the cache, so LRU pressure cannot drop it mid-write; one with no durable state
      // at all has nothing to land, and must not empty the file.
      const rebuilt = cached ? undefined : this.reconstruct(file.id, file.crdt_epoch);
      if (rebuilt && !rebuilt.hasDurableState) continue;
      const text = (cached ?? rebuilt!.cached).doc.getText(CRDT_TEXT_KEY).toString();
      if (sha256Text(text) === file.sha256) continue;
      const updatedBy =
        cached?.lastUpdatedBy ?? (file.updated_by_user_id ? { userId: file.updated_by_user_id, displayName: "" } : fallbackActor);
      await this.landText(file.id, file.crdt_epoch, text, updatedBy);
    }
  }

  /** Test/diagnostic seam: whether `(fileId, epoch)` currently has a live cache entry, without the
   *  side effect of loading one if absent. */
  isCached(fileId: string, epoch: number): boolean {
    return this.cache.has(this.key(fileId, epoch));
  }

  size(): number {
    return this.cache.size;
  }

  private key(fileId: string, epoch: number): string {
    return `${fileId}:${epoch}`;
  }

  private isRetiring(fileId: string): boolean {
    if (this.retiringRooms.size === 0) return false;
    const roomId = this.repo.getFileById(fileId)?.room_id;
    return roomId !== undefined && this.retiringRooms.has(roomId);
  }

  private roomDocuments(roomId: string): CachedDoc[] {
    return [...this.cache.values()].filter((cached) => this.repo.getFileById(cached.fileId)?.room_id === roomId);
  }

  /** Remembers a materialization until it settles, so `retireRoom` can wait for it. */
  private track(run: Promise<void>): Promise<void> {
    this.materializing.add(run);
    const forget = (): void => {
      this.materializing.delete(run);
    };
    void run.then(forget, forget);
    return run;
  }

  private load(fileId: string, epoch: number): CachedDoc {
    const key = this.key(fileId, epoch);
    const existing = this.cache.get(key);
    if (existing) {
      existing.lastAccessedAt = this.now();
      return existing;
    }

    const { cached } = this.reconstruct(fileId, epoch);
    this.cache.set(key, cached);
    this.evictLruIfOverCapacity();
    return cached;
  }

  /** Rebuilds a document from its durable snapshot and updates, without caching it. */
  private reconstruct(fileId: string, epoch: number): { cached: CachedDoc; hasDurableState: boolean } {
    const doc = new Y.Doc();
    const snapshot = this.repo.getLatestCrdtSnapshot(fileId, epoch);
    let lastSeq = 0;
    if (snapshot) {
      Y.applyUpdate(doc, fromBase64(snapshot.snapshot));
      lastSeq = snapshot.upToSeq;
    }
    const pending = this.repo.listCrdtUpdatesSince(fileId, epoch, lastSeq);
    for (const update of pending) {
      Y.applyUpdate(doc, fromBase64(update.update));
      lastSeq = update.seq;
    }

    const cached: CachedDoc = {
      doc,
      fileId,
      epoch,
      updatesSinceCompaction: pending.length,
      lastSeq,
      lastAccessedAt: this.now(),
      materializeTimer: undefined,
      lastUpdatedBy: null
    };
    return { cached, hasDurableState: snapshot !== null || pending.length > 0 };
  }

  /**
   * Brings a document's whole-file content up to date *now*, rather than on the materialize debounce.
   * Called when a device subscribes to a room, because a CRDT document's authoritative text lives in
   * `crdt_updates` and only reaches `files`/`file_versions` when a materialize fires - so a device that
   * (re)subscribes reconciles against whatever was last materialized. If the relay restarted, or the
   * doc was evicted, or nobody has typed since the last flush, that content is stale or empty and the
   * subscribing device downloads nothing, leaving the two vaults with different file counts until
   * somebody *opens* the note and the resulting handshake/update triggers a materialize - exactly the
   * behaviour reported from real hardware (twelfth hardware-testing round, 2026-07-24). Loads the doc
   * if needed (lazy reconstruction from snapshot + updates), and no-ops when the durable text already
   * matches, so a room of already-current files costs one hash comparison each.
   */
  async materializeNow(input: { fileId: string; epoch: number; materializedContent: string | null; fallbackActor: CrdtUpdatedBy }): Promise<void> {
    if (this.disposed) return;
    const cached = this.load(input.fileId, input.epoch);
    const text = cached.doc.getText(CRDT_TEXT_KEY).toString();
    // Nothing to do when the durable whole-file content already equals the document's text - the common
    // case for a room whose files are all current, so a subscribe costs one string comparison per file.
    // The caller supplies that content because this class's repository port is deliberately narrow.
    if (input.materializedContent === text) {
      return;
    }
    // A doc reconstructed from durable state has no `lastUpdatedBy` (nobody has pushed an update to it
    // in this process), and `materialize` refuses to run without one. This only labels the resulting
    // broadcast; it has no effect on content.
    cached.lastUpdatedBy ??= input.fallbackActor;
    if (cached.materializeTimer !== undefined) {
      this.timerHost.clearTimeout(cached.materializeTimer);
      cached.materializeTimer = undefined;
    }
    await this.track(this.materialize(cached));
  }

  private compact(cached: CachedDoc): void {
    const stateVector = Y.encodeStateVector(cached.doc);
    const snapshot = Y.encodeStateAsUpdate(cached.doc);
    this.repo.writeCrdtSnapshot(cached.fileId, cached.epoch, toBase64(stateVector), toBase64(snapshot), cached.lastSeq);
    cached.updatesSinceCompaction = 0;
  }

  private scheduleMaterialize(cached: CachedDoc): void {
    if (cached.materializeTimer !== undefined) {
      this.timerHost.clearTimeout(cached.materializeTimer);
    }
    cached.materializeTimer = this.timerHost.setTimeout(() => {
      cached.materializeTimer = undefined;
      if (this.withDbAccess) {
        void this.track(
          this.withDbAccess(() => undefined).then(() => this.materialize(cached)).catch((error) => {
            console.error("Vault Rooms relay: CRDT materialization could not enter the database queue", error);
          })
        );
      } else {
        // materialize() catches and logs its own failures.
        void this.track(this.materialize(cached));
      }
    }, MATERIALIZE_DEBOUNCE_MS);
  }

  private async materialize(cached: CachedDoc): Promise<void> {
    try {
      await this.writeMaterialized(cached);
    } catch (error) {
      // This callback runs off a raw setTimeout (no caller to propagate a rejection/rethrow to),
      // so an uncaught error here would crash the whole relay process for every room. Contract 1.6
      // treats a missing materialization as self-healing ("briefly stale... self-heals on the next
      // update") - log and let the next crdt_update's scheduleMaterialize retry instead of crashing.
      console.error("Vault Rooms relay: CRDT materialization failed, will retry on the next update", error);
    }
  }

  /** Materialization (contract 1.6) - independent of compaction. Extracts the doc's current text
   *  and writes it into `files`/`file_versions` so REST/legacy readers see fresh content within the
   *  SLA, without waiting for the (much less frequent) compaction threshold. A no-op if the file
   *  was deleted before the debounce fired, its epoch was superseded, or its room left the CRDT lane
   *  (`materializeCrdtContent` returns null), and silently skipped if the doc was evicted from cache
   *  in the meantime (nothing to materialize from - the next load will reconstruct current durable
   *  state anyway). Throws on failure; `materialize` is the logging wrapper. */
  private async writeMaterialized(cached: CachedDoc): Promise<void> {
    if (this.disposed) return;
    const key = this.key(cached.fileId, cached.epoch);
    if (this.cache.get(key) !== cached) {
      // Evicted (e.g. by a persistence failure or an epoch bump) since this timer was scheduled -
      // nothing current to materialize from.
      return;
    }
    const updatedBy = cached.lastUpdatedBy;
    if (!updatedBy) return;
    await this.landText(cached.fileId, cached.epoch, cached.doc.getText(CRDT_TEXT_KEY).toString(), updatedBy);
  }

  /** Writes `text` as the file's whole-file content and announces it, unless the repository declines
   *  (deleted file, superseded epoch, or a room that has left the CRDT lane). */
  private async landText(fileId: string, epoch: number, text: string, updatedBy: CrdtUpdatedBy): Promise<void> {
    const result = await this.repo.materializeCrdtContent({ fileId, epoch, content: text, actorUserId: updatedBy.userId });
    if (!result) return;
    const file = this.repo.getFileById(fileId);
    if (!file) return;
    this.onMaterialized({
      fileId,
      roomId: file.room_id,
      relativePath: file.relative_path,
      version: result.version,
      sha256: result.sha256,
      content: text,
      updatedBy
    });
  }

  private evictIdle(): void {
    const cutoff = this.now() - IDLE_EVICTION_MS;
    for (const [key, cached] of this.cache) {
      // A doc with a pending materialize timer is, by definition, not idle - it has unmaterialized
      // work outstanding, even if no read/write has touched it recently. Never evict out from under
      // that timer (it holds the only in-memory copy of the update the timer is about to persist).
      if (cached.materializeTimer !== undefined) continue;
      if (cached.lastAccessedAt <= cutoff) {
        this.cache.delete(key);
      }
    }
  }

  private evictLruIfOverCapacity(): void {
    if (this.cache.size <= MAX_CACHED_DOCS) return;
    let oldestKey: string | undefined;
    let oldestAccess = Infinity;
    for (const [key, cached] of this.cache) {
      // Never evict a doc with unmaterialized work outstanding, same reasoning as evictIdle - LRU
      // pressure should never silently drop an update that hasn't made it into `files` yet.
      if (cached.materializeTimer !== undefined) continue;
      if (cached.lastAccessedAt < oldestAccess) {
        oldestAccess = cached.lastAccessedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey);
    }
  }
}

/** Same digest `files.sha256` records for materialized Markdown. */
function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
