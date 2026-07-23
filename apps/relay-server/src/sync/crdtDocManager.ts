import * as Y from "yjs";
import { AppError } from "@vault-rooms/protocol";
import type { SyncTimerHost } from "./syncServer.js";

/** Canonical Y.Text shared-type key. Both the relay's materialization (this file) and the Phase 5
 *  client editor binding (`crdtEditorBinding.ts`) must read/write the *same* shared type name
 *  inside a file's `Y.Doc`, or the two sides silently talk past each other - one writing into a
 *  `Y.Text` no one else looks at. Matches the name the Phase 0.3 persistence spike already used. */
export const CRDT_TEXT_KEY = "content";

// Resource limits (contract 1.7).
export const MAX_CRDT_UPDATE_BYTES = 1 * 1024 * 1024;
export const MAX_CRDT_DOC_BYTES = 4 * 1024 * 1024;
export const MAX_CRDT_UPDATES_BEFORE_COMPACT = 200;
export const MAX_CACHED_DOCS = 500;
const IDLE_EVICTION_MS = 10 * 60 * 1000;
const MATERIALIZE_DEBOUNCE_MS = 2_000;

/** Origin tag for server-applied Yjs updates, so a future server-side `Y.Doc.on("update", ...)`
 *  listener (none yet in Phase 4 - fanout is driven explicitly from `applyUpdate`'s return, not an
 *  update-event listener) could distinguish "this update came from decoding a client's message"
 *  from any other origin without ambiguity. Kept even though nothing reads it yet, matching the
 *  origin-tagging convention the Phase 0.2/0.3 spikes already established for client-side code. */
const INBOUND_UPDATE_ORIGIN = Symbol("crdt-inbound-update");

/** The narrow slice of `RelayRepository` this manager actually calls - typed as its own interface
 *  (rather than the concrete `RelayRepository` class) so tests can substitute a fake/wrapped repo
 *  (e.g. one that injects a durable-append failure for contract 1.13's persistence-failure test)
 *  without implementing the entire repository surface. Any real `RelayRepository` instance already
 *  satisfies this structurally - no change needed at real call sites. */
export type CrdtRepositoryPort = {
  writeCrdtSnapshot(fileId: string, epoch: number, stateVectorBase64: string, snapshotBase64: string, upToSeq: number): void;
  getLatestCrdtSnapshot(fileId: string, epoch: number): { stateVector: string; snapshot: string; upToSeq: number } | null;
  listCrdtUpdatesSince(fileId: string, epoch: number, sinceSeq: number): Array<{ seq: number; update: string }>;
  appendCrdtUpdate(fileId: string, epoch: number, updateBase64: string): number;
  materializeCrdtContent(input: { fileId: string; content: string; actorUserId: string }): { version: number; sha256: string } | null;
  getFileById(fileId: string): { room_id: string; relative_path: string } | null;
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

/** Owns the in-process cache of live `Y.Doc`s for the CRDT lane (docs/superpowers/plans/
 *  2026-07-20-crdt-sync.md Phase 4) - one entry per `(fileId, epoch)`, lazily reconstructed from
 *  the latest compaction snapshot plus any updates since, and evicted (LRU by cache size, or by
 *  idle timeout) rather than kept forever. This class owns *document* state; ACL/epoch/capability
 *  checks and message-shape handling live in `syncServer.ts`, matching how the CAS lane keeps
 *  policy checks out of `RelayFileRepository`. */
export class CrdtDocManager {
  private readonly cache = new Map<string, CachedDoc>();
  private readonly idleSweepHandle: unknown;
  private disposed = false;

  constructor(
    private readonly repo: CrdtRepositoryPort,
    private readonly timerHost: SyncTimerHost,
    private readonly onMaterialized: (event: CrdtMaterializedEvent) => void,
    private readonly now: () => number = Date.now
  ) {
    this.idleSweepHandle = timerHost.setInterval(() => this.evictIdle(), IDLE_EVICTION_MS);
  }

  /** Stops the idle-eviction sweep and cancels any pending materialize timers. Call once when the
   *  owning app/server shuts down - otherwise a scheduled timer would keep the process alive past
   *  `close()` (matters most for the standalone Node runtime; the embedded runtime's timers are
   *  tied to the Obsidian window anyway). */
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

  /** First-create flow (contract 1.10): a brand-new empty document for a freshly allocated
   *  `(fileId, epoch)`. Writes the initial (empty) compaction snapshot immediately so a cold
   *  `crdt_sync_step1` for this epoch - even before any update has ever landed - has something to
   *  reconstruct from, rather than a special-cased "no snapshot yet" branch in `load()`. */
  createDocument(fileId: string, epoch: number, createdBy: CrdtUpdatedBy): void {
    this.seedDocument(fileId, epoch, "", createdBy);
  }

  /** Room-toggle conversion (docs/superpowers/plans/2026-07-20-crdt-sync.md Phase 6): seeds a
   *  brand-new `(fileId, epoch)` document from a pre-existing file's *current* whole-file text,
   *  rather than starting empty - used when a room with existing `.md` files turns CRDT on, so
   *  converting never discards content. The caller (`room.routes.ts`'s PATCH handler) is
   *  responsible for having already bumped the file to a fresh epoch (contract 1.5/1.9 - "since
   *  bumpFileCrdtEpoch/purgeCrdtState semantics apply" even though nothing existed at the old
   *  epoch to purge) before calling this. */
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
      throw new AppError("CRDT_INVALID_UPDATE", "The state vector could not be decoded.", 422);
    }
    try {
      return toBase64(Y.encodeStateAsUpdate(cached.doc, remoteStateVector));
    } catch {
      throw new AppError("CRDT_INVALID_UPDATE", "The state vector could not be applied.", 422);
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
    let updateBytes: Uint8Array;
    try {
      updateBytes = fromBase64(updateBase64);
    } catch {
      throw new AppError("CRDT_INVALID_UPDATE", "The update could not be decoded.", 422);
    }
    if (updateBytes.byteLength > MAX_CRDT_UPDATE_BYTES) {
      throw new AppError("FILE_TOO_LARGE", "The CRDT update exceeds the per-update size limit.", 413);
    }

    const key = this.key(fileId, epoch);
    const cached = this.load(fileId, epoch);
    try {
      Y.applyUpdate(cached.doc, updateBytes, INBOUND_UPDATE_ORIGIN);
    } catch {
      // A malformed-but-decodable update (bad varint structure, etc.) - Yjs's decoder throws
      // before mutating the doc's shared state in this case, so there is nothing to roll back or
      // evict; the doc is simply untouched.
      throw new AppError("CRDT_INVALID_UPDATE", "The update could not be applied.", 422);
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

  private load(fileId: string, epoch: number): CachedDoc {
    const key = this.key(fileId, epoch);
    const existing = this.cache.get(key);
    if (existing) {
      existing.lastAccessedAt = this.now();
      return existing;
    }

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
    this.cache.set(key, cached);
    this.evictLruIfOverCapacity();
    return cached;
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
      this.materialize(cached);
    }, MATERIALIZE_DEBOUNCE_MS);
  }

  /** Materialization (contract 1.6) - independent of compaction. Extracts the doc's current text
   *  and writes it into `files`/`file_versions` so REST/legacy readers see fresh content within the
   *  SLA, without waiting for the (much less frequent) compaction threshold. A no-op if the file
   *  was deleted before the debounce fired (`materializeCrdtContent` returns null), and silently
   *  skipped if the doc was evicted from cache in the meantime (nothing to materialize from - the
   *  next load will reconstruct current durable state anyway). */
  private materialize(cached: CachedDoc): void {
    if (this.disposed) return;
    const key = this.key(cached.fileId, cached.epoch);
    if (this.cache.get(key) !== cached) {
      // Evicted (e.g. by a persistence failure or an epoch bump) since this timer was scheduled -
      // nothing current to materialize from.
      return;
    }
    const updatedBy = cached.lastUpdatedBy;
    if (!updatedBy) return;
    const text = cached.doc.getText(CRDT_TEXT_KEY).toString();
    try {
      const result = this.repo.materializeCrdtContent({ fileId: cached.fileId, content: text, actorUserId: updatedBy.userId });
      if (!result) return;
      const file = this.repo.getFileById(cached.fileId);
      if (!file) return;
      this.onMaterialized({
        fileId: cached.fileId,
        roomId: file.room_id,
        relativePath: file.relative_path,
        version: result.version,
        sha256: result.sha256,
        content: text,
        updatedBy
      });
    } catch (error) {
      // This callback runs off a raw setTimeout (no caller to propagate a rejection/rethrow to),
      // so an uncaught error here would crash the whole relay process for every room. Contract 1.6
      // treats a missing materialization as self-healing ("briefly stale... self-heals on the next
      // update") - log and let the next crdt_update's scheduleMaterialize retry instead of crashing.
      console.error("Vault Rooms relay: CRDT materialization failed, will retry on the next update", error);
    }
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
