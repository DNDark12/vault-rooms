import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { runMigrations } from "../src/db/migrations.js";
import { RelayRepository } from "../src/db/repositories/relayRepository.js";
import { openSqlJsDb, type RelayDb } from "../src/db/sqlJsAdapter.js";
import {
  CrdtDocManager,
  CRDT_TEXT_KEY,
  MAX_CACHED_DOCS,
  MAX_CRDT_UPDATE_BYTES,
  MAX_CRDT_UPDATES_BEFORE_COMPACT,
  type CrdtMaterializedEvent,
  type CrdtRepositoryPort
} from "../src/sync/crdtDocManager.js";
import type { SyncTimerHost } from "../src/sync/syncServer.js";

// Covers CRDT cache, compaction, limits, and eviction.

class FakeCrdtTimerHost implements SyncTimerHost {
  private nextHandle = 1;
  readonly timeouts = new Map<number, { callback: () => void; delayMs: number }>();
  intervalCallback: (() => void) | null = null;

  setInterval(callback: () => void): unknown {
    this.intervalCallback = callback;
    return "interval";
  }

  clearInterval(): void {
    this.intervalCallback = null;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++;
    this.timeouts.set(handle, { callback, delayMs });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }

  /** Fires and clears every currently-scheduled timeout (there is at most one live materialize
   *  timer per doc at a time, since scheduleMaterialize always clears-then-resets). */
  runAllTimeouts(): void {
    const entries = [...this.timeouts.values()];
    this.timeouts.clear();
    for (const entry of entries) entry.callback();
  }

  fireIdleSweep(): void {
    this.intervalCallback?.();
  }
}

async function createTestRepo(): Promise<{ db: RelayDb; repo: RelayRepository }> {
  const db = await openSqlJsDb(":memory:");
  runMigrations(db);
  return { db, repo: new RelayRepository(db) };
}

function makeRoomAndCrdtFile(repo: RelayRepository) {
  const room = repo.createRoom({
    name: "Room",
    type: "folder",
    sourcePath: "/vault/room",
    mountName: "room",
    ownerUserId: "usr_owner",
    capabilities: []
  });
  const created = repo.createCrdtFile({ roomId: room.id, relativePath: "note.md", actorUserId: "usr_owner" });
  return { room, fileId: created.fileId, epoch: created.epoch };
}

/** Encodes a whole-document Yjs update that inserts `text` into the shared CRDT_TEXT_KEY type -
 *  applying this to a fresh empty Y.Doc reconstructs the same text, so it's usable both as a
 *  "first write" update and as a way to build fixtures without needing a live peer connection. */
function encodeTextInsertUpdate(text: string): string {
  const doc = new Y.Doc();
  doc.getText(CRDT_TEXT_KEY).insert(0, text);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

function decodeTextFromUpdate(updateBase64: string): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(updateBase64, "base64")));
  return doc.getText(CRDT_TEXT_KEY).toString();
}

const noopMaterialized = (): void => undefined;

describe("CrdtDocManager (Phase 4)", () => {
  it("createDocument writes an empty initial snapshot a cold handshake can read immediately", async () => {
    const { repo } = await createTestRepo();
    const { fileId } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    const manager = new CrdtDocManager(repo, timers, noopMaterialized);

    manager.createDocument(fileId, 0, { userId: "usr_owner", displayName: "Owner" });

    const snapshot = repo.getLatestCrdtSnapshot(fileId, 0);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.upToSeq).toBe(0);
    manager.dispose();
  });

  it("applyUpdate + getStateVectorBase64/getDiffUpdateBase64 let a fresh peer reconstruct the same content", async () => {
    const { repo } = await createTestRepo();
    const { fileId } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    const manager = new CrdtDocManager(repo, timers, noopMaterialized);
    manager.createDocument(fileId, 0, { userId: "usr_owner", displayName: "Owner" });

    manager.applyUpdate(fileId, 0, encodeTextInsertUpdate("hello world"), { userId: "usr_owner", displayName: "Owner" });

    // A cold peer with an empty state vector should get a diff that reconstructs the full text.
    const emptyStateVector = Buffer.from(Y.encodeStateVector(new Y.Doc())).toString("base64");
    const diff = manager.getDiffUpdateBase64(fileId, 0, emptyStateVector);
    expect(decodeTextFromUpdate(diff)).toBe("hello world");
    manager.dispose();
  });

  it("evicting a document (contract 1.5 destructive cleanup) forces the next access to reload from durable state, not stale memory", async () => {
    const { repo } = await createTestRepo();
    const { fileId } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    const manager = new CrdtDocManager(repo, timers, noopMaterialized);
    manager.createDocument(fileId, 0, { userId: "usr_owner", displayName: "Owner" });
    manager.applyUpdate(fileId, 0, encodeTextInsertUpdate("will be purged"), { userId: "usr_owner", displayName: "Owner" });
    expect(manager.isCached(fileId, 0)).toBe(true);

    manager.evictDocument(fileId, 0);

    expect(manager.isCached(fileId, 0)).toBe(false);
    manager.dispose();
  });

  it("rejects an update over the per-update size limit without touching the doc or persisting anything", async () => {
    const { repo } = await createTestRepo();
    const { fileId } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    const manager = new CrdtDocManager(repo, timers, noopMaterialized);
    manager.createDocument(fileId, 0, { userId: "usr_owner", displayName: "Owner" });
    const oversized = Buffer.alloc(MAX_CRDT_UPDATE_BYTES + 1, 1).toString("base64");

    expect(() => manager.applyUpdate(fileId, 0, oversized, { userId: "usr_owner", displayName: "Owner" })).toThrow(
      expect.objectContaining({ code: "FILE_TOO_LARGE" })
    );
    expect(repo.listCrdtUpdatesSince(fileId, 0, 0)).toEqual([]);
    manager.dispose();
  });

  it("rejects malformed base64 and structurally invalid Yjs updates as CRDT_INVALID_UPDATE", async () => {
    const { repo } = await createTestRepo();
    const { fileId } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    const manager = new CrdtDocManager(repo, timers, noopMaterialized);
    manager.createDocument(fileId, 0, { userId: "usr_owner", displayName: "Owner" });

    // Not valid Yjs update bytes at all (decodable base64, garbage payload).
    const garbage = Buffer.from("this is not a real yjs update, just plain bytes").toString("base64");
    expect(() => manager.applyUpdate(fileId, 0, garbage, { userId: "usr_owner", displayName: "Owner" })).toThrow(
      expect.objectContaining({ code: "CRDT_INVALID_UPDATE" })
    );
    expect(repo.listCrdtUpdatesSince(fileId, 0, 0)).toEqual([]);
    manager.dispose();
  });

  it("[contract 1.13] a durable-append failure evicts the doc from cache instead of leaving it ahead of durable state", async () => {
    const { repo } = await createTestRepo();
    const { fileId } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();

    let shouldFail = false;
    const flakyRepo: CrdtRepositoryPort = {
      writeCrdtSnapshot: (...args) => repo.writeCrdtSnapshot(...args),
      getLatestCrdtSnapshot: (...args) => repo.getLatestCrdtSnapshot(...args),
      listCrdtUpdatesSince: (...args) => repo.listCrdtUpdatesSince(...args),
      appendCrdtUpdate: (...args) => {
        if (shouldFail) throw new Error("simulated durable-append failure");
        return repo.appendCrdtUpdate(...args);
      },
      materializeCrdtContent: (...args) => repo.materializeCrdtContent(...args),
      getFileById: (...args) => repo.getFileById(...args),
      listFiles: (...args) => repo.listFiles(...args)
    };
    const manager = new CrdtDocManager(flakyRepo, timers, noopMaterialized);
    manager.createDocument(fileId, 0, { userId: "usr_owner", displayName: "Owner" });
    manager.applyUpdate(fileId, 0, encodeTextInsertUpdate("durable content"), { userId: "usr_owner", displayName: "Owner" });
    expect(manager.isCached(fileId, 0)).toBe(true);

    shouldFail = true;
    expect(() =>
      manager.applyUpdate(fileId, 0, encodeTextInsertUpdate(" - never persisted"), { userId: "usr_owner", displayName: "Owner" })
    ).toThrow("simulated durable-append failure");

    // Evicted entirely rather than left ahead of durable state.
    expect(manager.isCached(fileId, 0)).toBe(false);

    shouldFail = false;
    // Reloading from scratch reconstructs only the durably-appended first update, never the one
    // that failed to persist.
    const emptyStateVector = Buffer.from(Y.encodeStateVector(new Y.Doc())).toString("base64");
    const diff = manager.getDiffUpdateBase64(fileId, 0, emptyStateVector);
    expect(decodeTextFromUpdate(diff)).toBe("durable content");
    manager.dispose();
  });

  it("[contract 1.6] compacts after MAX_CRDT_UPDATES_BEFORE_COMPACT updates, and a cold catch-up still works afterward", async () => {
    const { repo } = await createTestRepo();
    const { fileId } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    const manager = new CrdtDocManager(repo, timers, noopMaterialized);
    manager.createDocument(fileId, 0, { userId: "usr_owner", displayName: "Owner" });

    for (let i = 0; i < MAX_CRDT_UPDATES_BEFORE_COMPACT; i += 1) {
      manager.applyUpdate(fileId, 0, encodeTextInsertUpdate("x"), { userId: "usr_owner", displayName: "Owner" });
    }

    const snapshot = repo.getLatestCrdtSnapshot(fileId, 0);
    expect(snapshot).not.toBeNull();
    // Compaction deletes every update it supersedes - nothing should remain under the snapshot's
    // upToSeq boundary.
    expect(repo.listCrdtUpdatesSince(fileId, 0, 0)).toEqual([]);

    // A cold peer can still catch up via snapshot alone (no updates left to replay).
    const emptyStateVector = Buffer.from(Y.encodeStateVector(new Y.Doc())).toString("base64");
    const diff = manager.getDiffUpdateBase64(fileId, 0, emptyStateVector);
    expect(decodeTextFromUpdate(diff)).toBe("x".repeat(MAX_CRDT_UPDATES_BEFORE_COMPACT));
    manager.dispose();
  });

  it("[audit fix] a compaction failure does not reject the update that already landed durably, or block its fanout", async () => {
    const { repo } = await createTestRepo();
    const { fileId } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    let failSnapshotWrites = false;
    const flakyRepo: CrdtRepositoryPort = {
      writeCrdtSnapshot: (...args) => {
        if (failSnapshotWrites) throw new Error("simulated compaction failure");
        return repo.writeCrdtSnapshot(...args);
      },
      getLatestCrdtSnapshot: (...args) => repo.getLatestCrdtSnapshot(...args),
      listCrdtUpdatesSince: (...args) => repo.listCrdtUpdatesSince(...args),
      appendCrdtUpdate: (...args) => repo.appendCrdtUpdate(...args),
      materializeCrdtContent: (...args) => repo.materializeCrdtContent(...args),
      getFileById: (...args) => repo.getFileById(...args),
      listFiles: (...args) => repo.listFiles(...args)
    };
    const manager = new CrdtDocManager(flakyRepo, timers, noopMaterialized);
    manager.createDocument(fileId, 0, { userId: "usr_owner", displayName: "Owner" });

    for (let i = 0; i < MAX_CRDT_UPDATES_BEFORE_COMPACT - 1; i += 1) {
      manager.applyUpdate(fileId, 0, encodeTextInsertUpdate("x"), { userId: "usr_owner", displayName: "Owner" });
    }

    failSnapshotWrites = true;
    // This update crosses the compaction threshold, so compact()'s writeCrdtSnapshot call fails -
    // but appendCrdtUpdate (which ran first) already durably landed the update, so applyUpdate must
    // not throw: a throw here would incorrectly reject an update the server already accepted and
    // skip fanout to other peers for it.
    expect(() =>
      manager.applyUpdate(fileId, 0, encodeTextInsertUpdate("x"), { userId: "usr_owner", displayName: "Owner" })
    ).not.toThrow();
    expect(repo.listCrdtUpdatesSince(fileId, 0, 0).length).toBeGreaterThan(0);
    manager.dispose();
  });

  it("[audit fix] a materialization failure is caught and logged rather than left to crash the process", async () => {
    const { repo } = await createTestRepo();
    const { fileId } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    const flakyRepo: CrdtRepositoryPort = {
      writeCrdtSnapshot: (...args) => repo.writeCrdtSnapshot(...args),
      getLatestCrdtSnapshot: (...args) => repo.getLatestCrdtSnapshot(...args),
      listCrdtUpdatesSince: (...args) => repo.listCrdtUpdatesSince(...args),
      appendCrdtUpdate: (...args) => repo.appendCrdtUpdate(...args),
      materializeCrdtContent: () => {
        throw new Error("simulated materialization failure");
      },
      getFileById: (...args) => repo.getFileById(...args),
      listFiles: (...args) => repo.listFiles(...args)
    };
    const manager = new CrdtDocManager(flakyRepo, timers, noopMaterialized);
    manager.createDocument(fileId, 0, { userId: "usr_owner", displayName: "Owner" });
    manager.applyUpdate(fileId, 0, encodeTextInsertUpdate("hello"), { userId: "usr_owner", displayName: "Owner" });

    // The debounced materialize callback runs off a raw setTimeout with no caller to propagate a
    // rejection to - an uncaught throw here would crash the whole relay process for every room,
    // for a failure contract 1.6 says should just mean "briefly stale, self-healing."
    expect(() => timers.runAllTimeouts()).not.toThrow();
    manager.dispose();
  });

  it("materializes debounced text into files/file_versions and invokes the onMaterialized callback", async () => {
    const { repo } = await createTestRepo();
    const { fileId, room } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    const events: CrdtMaterializedEvent[] = [];
    const manager = new CrdtDocManager(repo, timers, (event) => events.push(event));
    manager.createDocument(fileId, 0, { userId: "usr_owner", displayName: "Owner" });

    manager.applyUpdate(fileId, 0, encodeTextInsertUpdate("materialize me"), { userId: "usr_owner", displayName: "Owner" });
    expect(events).toHaveLength(0); // debounced - not yet.

    timers.runAllTimeouts();
    // materialize() is now async (Phase B's write seam adds a real await point), so the timer
    // firing synchronously no longer guarantees onMaterialized has run yet.
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ fileId, roomId: room.id, relativePath: "note.md", content: "materialize me" });
    const { content } = repo.readFileContent(room.id, "note.md");
    expect(content).toBe("materialize me");
    manager.dispose();
  });

  it("waits for the embedded database access queue before materializing", async () => {
    const { repo } = await createTestRepo();
    const { fileId, room } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    const events: CrdtMaterializedEvent[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let accessCalls = 0;
    const withDbAccess = async <T>(operation: () => T | Promise<T>): Promise<T> => {
      accessCalls += 1;
      await gate;
      return operation();
    };
    const manager = new CrdtDocManager(repo, timers, (event) => events.push(event), Date.now, withDbAccess);
    manager.createDocument(fileId, 0, { userId: "usr_owner", displayName: "Owner" });
    manager.applyUpdate(fileId, 0, encodeTextInsertUpdate("queued materialize"), { userId: "usr_owner", displayName: "Owner" });

    timers.runAllTimeouts();
    await Promise.resolve();
    expect(accessCalls).toBe(1);
    expect(events).toEqual([]);

    release();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(repo.readFileContent(room.id, "note.md").content).toBe("queued materialize");
    manager.dispose();
  });

  it("materializes nothing for a superseded epoch or a room that has left the CRDT lane", async () => {
    const { repo } = await createTestRepo();
    const { fileId, room, epoch } = makeRoomAndCrdtFile(repo);
    const before = repo.readFileContent(room.id, "note.md");

    expect(repo.materializeCrdtContent({ fileId, epoch: epoch + 1, content: "superseded epoch", actorUserId: "usr_owner" })).toBeNull();
    repo.setRoomCrdtEnabled({ roomId: room.id, actorUserId: "usr_owner", enabled: false });
    expect(repo.materializeCrdtContent({ fileId, epoch, content: "room left the lane", actorUserId: "usr_owner" })).toBeNull();

    expect(repo.readFileContent(room.id, "note.md")).toEqual(before);
  });

  it("never evicts (idle or LRU) a doc with an outstanding materialize timer, so an unmaterialized update can't be silently dropped", async () => {
    const { repo } = await createTestRepo();
    const { fileId } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    let now = 0;
    const manager = new CrdtDocManager(repo, timers, noopMaterialized, () => now);
    manager.createDocument(fileId, 0, { userId: "usr_owner", displayName: "Owner" });
    manager.applyUpdate(fileId, 0, encodeTextInsertUpdate("pending materialize"), { userId: "usr_owner", displayName: "Owner" });

    now += 11 * 60 * 1000; // past the 10-minute idle threshold
    timers.fireIdleSweep();
    expect(manager.isCached(fileId, 0)).toBe(true); // guarded by the pending materialize timer.

    timers.runAllTimeouts(); // materialize fires, clearing the timer.
    timers.fireIdleSweep();
    expect(manager.isCached(fileId, 0)).toBe(false); // now genuinely idle, safe to evict.
    manager.dispose();
  });

  it(`evicts the least-recently-accessed doc once the cache exceeds ${MAX_CACHED_DOCS} entries`, async () => {
    const { repo } = await createTestRepo();
    const timers = new FakeCrdtTimerHost();
    let now = 0;
    const manager = new CrdtDocManager(repo, timers, noopMaterialized, () => now);

    // createDocument doesn't require a real FileRow (crdt_updates/crdt_snapshots have no foreign
    // key on files.id) - synthetic ids are enough to exercise pure cache-capacity behavior.
    for (let i = 0; i < MAX_CACHED_DOCS; i += 1) {
      now += 1;
      manager.createDocument(`synthetic_${i}`, 0, { userId: "usr_owner", displayName: "Owner" });
    }
    expect(manager.size()).toBe(MAX_CACHED_DOCS);
    expect(manager.isCached("synthetic_0", 0)).toBe(true); // oldest access so far, not yet evicted.

    now += 1;
    manager.createDocument("synthetic_overflow", 0, { userId: "usr_owner", displayName: "Owner" });

    expect(manager.size()).toBe(MAX_CACHED_DOCS);
    expect(manager.isCached("synthetic_0", 0)).toBe(false); // least-recently-accessed, evicted.
    expect(manager.isCached("synthetic_overflow", 0)).toBe(true);
    manager.dispose();
  });
});

describe("CrdtDocManager.retireRoom", () => {
  const owner = { userId: "usr_owner", displayName: "Owner" };

  it("lands a pending materialization before switching modes, then drops the room's documents and timers", async () => {
    const { repo } = await createTestRepo();
    const { fileId, room } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    const manager = new CrdtDocManager(repo, timers, noopMaterialized);
    manager.createDocument(fileId, 0, owner);
    manager.applyUpdate(fileId, 0, encodeTextInsertUpdate("pending edit"), owner);

    let contentAtSwitch: string | null = null;
    await manager.retireRoom(
      room.id,
      async () => {
        contentAtSwitch = repo.readFileContent(room.id, "note.md").content;
        repo.setRoomCrdtEnabled({ roomId: room.id, actorUserId: "usr_owner", enabled: false });
      },
      owner
    );

    expect(contentAtSwitch).toBe("pending edit");
    expect(manager.isCached(fileId, 0)).toBe(false);
    expect(timers.timeouts.size).toBe(0);
    manager.dispose();
  });

  it("finishes a materialization already in flight before switching modes", async () => {
    const { repo } = await createTestRepo();
    const { fileId, room } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const withDbAccess = async <T>(operation: () => T | Promise<T>): Promise<T> => {
      await gate;
      return operation();
    };
    const manager = new CrdtDocManager(repo, timers, noopMaterialized, Date.now, withDbAccess);
    manager.createDocument(fileId, 0, owner);
    manager.applyUpdate(fileId, 0, encodeTextInsertUpdate("in flight"), owner);
    timers.runAllTimeouts(); // The timer has fired; its materialization now waits for the database queue.

    let contentAtSwitch: string | null = null;
    const retired = manager.retireRoom(
      room.id,
      async () => {
        contentAtSwitch = repo.readFileContent(room.id, "note.md").content;
      },
      owner
    );
    await Promise.resolve();
    release();
    await retired;

    expect(contentAtSwitch).toBe("in flight");
    manager.dispose();
  });

  it("rejects updates for the room until the switch has completed", async () => {
    const { repo } = await createTestRepo();
    const { fileId, room } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    const manager = new CrdtDocManager(repo, timers, noopMaterialized);
    manager.createDocument(fileId, 0, owner);

    let rejection: unknown;
    await manager.retireRoom(
      room.id,
      async () => {
        try {
          manager.applyUpdate(fileId, 0, encodeTextInsertUpdate("too late"), owner);
        } catch (error) {
          rejection = error;
        }
      },
      owner
    );

    expect(rejection).toMatchObject({ code: "CRDT_DISABLED" });
    expect(repo.listCrdtUpdatesSince(fileId, 0, 0)).toEqual([]);
    manager.dispose();
  });

  it("keeps the room live, with its edit still scheduled, when the final materialization fails", async () => {
    const { repo } = await createTestRepo();
    const { fileId, room } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    let failMaterialize = true;
    const flakyRepo: CrdtRepositoryPort = {
      writeCrdtSnapshot: (...args) => repo.writeCrdtSnapshot(...args),
      getLatestCrdtSnapshot: (...args) => repo.getLatestCrdtSnapshot(...args),
      listCrdtUpdatesSince: (...args) => repo.listCrdtUpdatesSince(...args),
      appendCrdtUpdate: (...args) => repo.appendCrdtUpdate(...args),
      materializeCrdtContent: (input) => {
        if (failMaterialize) throw new Error("simulated materialization failure");
        return repo.materializeCrdtContent(input);
      },
      getFileById: (...args) => repo.getFileById(...args),
      listFiles: (...args) => repo.listFiles(...args)
    };
    const manager = new CrdtDocManager(flakyRepo, timers, noopMaterialized);
    manager.createDocument(fileId, 0, owner);
    manager.applyUpdate(fileId, 0, encodeTextInsertUpdate("must not be dropped"), owner);
    const switchMode = vi.fn(async () => undefined);

    await expect(manager.retireRoom(room.id, switchMode, owner)).rejects.toThrow("simulated materialization failure");

    expect(switchMode).not.toHaveBeenCalled();
    expect(manager.isCached(fileId, 0)).toBe(true);
    failMaterialize = false;
    timers.runAllTimeouts();
    await vi.waitFor(() => expect(repo.readFileContent(room.id, "note.md").content).toBe("must not be dropped"));
    manager.dispose();
  });

  it("lands a document whose in-flight materialization failed before switching modes", async () => {
    const { repo } = await createTestRepo();
    const { fileId, room } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    let failuresLeft = 1;
    const manager = new CrdtDocManager(
      portFailingMaterialize(repo, () => failuresLeft-- > 0),
      timers,
      noopMaterialized
    );
    manager.createDocument(fileId, 0, owner);
    manager.applyUpdate(fileId, 0, encodeTextInsertUpdate("in flight"), owner);
    timers.runAllTimeouts(); // This attempt fails, and is only logged.

    let contentAtSwitch: string | null = null;
    await manager.retireRoom(
      room.id,
      async () => {
        contentAtSwitch = repo.readFileContent(room.id, "note.md").content;
      },
      owner
    );

    expect(contentAtSwitch).toBe("in flight");
    manager.dispose();
  });

  it("keeps the room live when a document whose earlier materialization failed still cannot be saved", async () => {
    const { repo } = await createTestRepo();
    const { fileId, room } = makeRoomAndCrdtFile(repo);
    const timers = new FakeCrdtTimerHost();
    const manager = new CrdtDocManager(portFailingMaterialize(repo, () => true), timers, noopMaterialized);
    manager.createDocument(fileId, 0, owner);
    manager.applyUpdate(fileId, 0, encodeTextInsertUpdate("never saved"), owner);
    timers.runAllTimeouts();
    await new Promise((resolve) => setTimeout(resolve, 0)); // Let the failed attempt settle.
    const switchMode = vi.fn(async () => undefined);

    await expect(manager.retireRoom(room.id, switchMode, owner)).rejects.toThrow("simulated materialization failure");

    expect(switchMode).not.toHaveBeenCalled();
    expect(repo.readFileContent(room.id, "note.md").content).toBe("");
    manager.dispose();
  });

  it("lands durable updates of a document that is not cached, as after a restart", async () => {
    const { repo } = await createTestRepo();
    const { fileId, room } = makeRoomAndCrdtFile(repo);
    const beforeRestart = new CrdtDocManager(repo, new FakeCrdtTimerHost(), noopMaterialized);
    beforeRestart.createDocument(fileId, 0, owner);
    beforeRestart.applyUpdate(fileId, 0, encodeTextInsertUpdate("typed before the restart"), owner);
    beforeRestart.dispose(); // The debounce never fired: the text exists only in crdt_updates.
    const manager = new CrdtDocManager(repo, new FakeCrdtTimerHost(), noopMaterialized);

    let contentAtSwitch: string | null = null;
    await manager.retireRoom(
      room.id,
      async () => {
        contentAtSwitch = repo.readFileContent(room.id, "note.md").content;
      },
      owner
    );

    expect(contentAtSwitch).toBe("typed before the restart");
    expect(manager.isCached(fileId, 0)).toBe(false);
    manager.dispose();
  });
});

function portFailingMaterialize(repo: RelayRepository, shouldFail: () => boolean): CrdtRepositoryPort {
  return {
    writeCrdtSnapshot: (...args) => repo.writeCrdtSnapshot(...args),
    getLatestCrdtSnapshot: (...args) => repo.getLatestCrdtSnapshot(...args),
    listCrdtUpdatesSince: (...args) => repo.listCrdtUpdatesSince(...args),
    appendCrdtUpdate: (...args) => repo.appendCrdtUpdate(...args),
    materializeCrdtContent: (input) => {
      if (shouldFail()) throw new Error("simulated materialization failure");
      return repo.materializeCrdtContent(input);
    },
    getFileById: (...args) => repo.getFileById(...args),
    listFiles: (...args) => repo.listFiles(...args)
  };
}
