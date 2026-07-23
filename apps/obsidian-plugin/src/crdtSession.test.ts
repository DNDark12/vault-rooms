import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import * as Y from "yjs";
import type { SyncClientMessage, SyncServerMessage } from "@vault-rooms/protocol";
import { CRDT_TEXT_KEY } from "vault-rooms-relay/embedded-core";
import { CrdtDocStore } from "./crdtDocStore.js";
import { CrdtSessionManager, type CrdtSessionManagerDeps } from "./crdtSession.js";

(globalThis as unknown as { window: typeof globalThis }).window ??= globalThis;

/** Minimal in-memory DataAdapter stand-in, same pattern as crdtDocStore.test.ts. */
class FakeDataAdapter {
  readonly store = new Map<string, ArrayBuffer>();
  readonly folders = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.store.has(path) || this.folders.has(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const data = this.store.get(path);
    if (!data) throw new Error(`Missing file: ${path}`);
    return data.slice(0);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.store.set(path, data.slice(0));
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async remove(path: string): Promise<void> {
    this.store.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const data = this.store.get(from);
    if (!data) throw new Error(`Missing file: ${from}`);
    this.store.set(to, data);
    this.store.delete(from);
  }

  async rmdir(path: string): Promise<void> {
    this.folders.delete(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    return { files: [...this.store.keys()].filter((key) => key.startsWith(prefix)), folders: [] };
  }
}

function makeDocStore(adapter = new FakeDataAdapter()): CrdtDocStore {
  return new CrdtDocStore(adapter as unknown as DataAdapter, "vault-rooms/crdt");
}

type Harness = {
  manager: CrdtSessionManager;
  sent: SyncClientMessage[];
  disk: Map<string, string>;
  writes: Array<{ roomId: string; relativePath: string; text: string }>;
};

function createHarness(overrides: Partial<CrdtSessionManagerDeps> = {}, docStore = makeDocStore()): Harness {
  const sent: SyncClientMessage[] = [];
  const disk = new Map<string, string>();
  const writes: Array<{ roomId: string; relativePath: string; text: string }> = [];
  let counter = 0;
  const manager = new CrdtSessionManager({
    send: (message) => sent.push(message),
    docStore,
    isRoomCrdtEnabled: () => true,
    readDiskText: async (roomId, relativePath) => disk.get(`${roomId}/${relativePath}`) ?? null,
    writeDiskText: async (roomId, relativePath, text) => {
      writes.push({ roomId, relativePath, text });
      disk.set(`${roomId}/${relativePath}`, text);
    },
    createRequestId: () => `req_${++counter}`,
    ...overrides
  });
  return { manager, sent, disk, writes };
}

function ack(harness: Harness, message: SyncServerMessage): Promise<void> {
  return harness.manager.handleServerMessage(message);
}

describe("CrdtSessionManager - first create", () => {
  it("sends crdt_create when no epoch is known yet, and resolves ensureSession once crdt_created arrives", async () => {
    const harness = createHarness();
    const sessionPromise = harness.manager.ensureSession("room_1", "Board.md");

    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(true));
    const createMessage = harness.sent.find((message) => message.type === "crdt_create") as Extract<SyncClientMessage, { type: "crdt_create" }>;
    await ack(harness, { type: "crdt_created", requestId: createMessage.requestId, roomId: "room_1", relativePath: "Board.md", documentId: "file_1", epoch: 0 });

    const session = await sessionPromise;
    expect(session.epoch).toBe(0);
  });

  it("throws for a path/room that is not CRDT-eligible", async () => {
    const harness = createHarness({ isRoomCrdtEnabled: () => false });
    await expect(harness.manager.ensureSession("room_1", "Board.md")).rejects.toThrow();
  });
});

describe("CrdtSessionManager - persistence across a simulated restart", () => {
  it("does not duplicate content when disk is unchanged after reload", async () => {
    const adapter = new FakeDataAdapter();
    const docStore = makeDocStore(adapter);
    const harness = createHarness({}, docStore);
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    harness.disk.set("room_1/Board.md", "hello world");

    const session = await harness.manager.ensureSession("room_1", "Board.md");
    // Simulate a local edit (the editor binding would normally produce this via yCollab).
    session.doc.transact(() => session.ytext.insert(session.ytext.length, "!"), null);
    // Force the debounced persist to run synchronously for the test.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await docStore.save("room_1", "Board.md", 0, Y.encodeStateAsUpdate(session.doc));

    harness.manager.dispose();

    // "Restart": a fresh manager instance, same docStore/disk content.
    const restarted = createHarness({}, docStore);
    restarted.manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    restarted.disk.set("room_1/Board.md", "hello world!");
    const restartedSession = await restarted.manager.ensureSession("room_1", "Board.md");

    expect(restartedSession.ytext.toString()).toBe("hello world!");
  });
});

describe("CrdtSessionManager - bidirectional handshake and outbound recovery", () => {
  it("answers a server-initiated step1 with a step2 carrying an edit made before the handshake started", async () => {
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const session = await harness.manager.ensureSession("room_1", "Board.md");
    session.doc.transact(() => session.ytext.insert(0, "local edit"), null);

    // Server independently asks what the client has beyond its own (empty) state vector.
    const emptyServerSv = Y.encodeStateVector(new Y.Doc());
    await ack(harness, {
      type: "crdt_sync_step1",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 0,
      stateVector: Buffer.from(emptyServerSv).toString("base64")
    });

    const reply = harness.sent.find((message) => message.type === "crdt_sync_step2") as Extract<SyncClientMessage, { type: "crdt_sync_step2" }>;
    expect(reply).toBeDefined();
    const appliedDoc = new Y.Doc();
    Y.applyUpdate(appliedDoc, Buffer.from(reply.update, "base64"));
    expect(appliedDoc.getText(CRDT_TEXT_KEY).toString()).toBe("local edit");
  });

  it("re-runs the handshake (outbound recovery) when the connection reconnects", async () => {
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    await harness.manager.ensureSession("room_1", "Board.md");
    harness.sent.length = 0;

    harness.manager.onConnected();

    expect(harness.sent.some((message) => message.type === "crdt_sync_step1")).toBe(true);
  });

  it("applies the server's step2 answer to our own step1 and merges it into the doc", async () => {
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const session = await harness.manager.ensureSession("room_1", "Board.md");
    const ourStep1 = harness.sent.find((message) => message.type === "crdt_sync_step1") as Extract<SyncClientMessage, { type: "crdt_sync_step1" }>;

    const remoteDoc = new Y.Doc();
    remoteDoc.getText(CRDT_TEXT_KEY).insert(0, "server content");
    await ack(harness, {
      type: "crdt_sync_step2",
      requestId: ourStep1.requestId,
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 0,
      update: Buffer.from(Y.encodeStateAsUpdate(remoteDoc)).toString("base64")
    });

    expect(session.ytext.toString()).toBe("server content");
  });
});

describe("CrdtSessionManager - stale epoch resync", () => {
  it("drops the local session and deletes its persisted state when the server reports a superseded epoch", async () => {
    const adapter = new FakeDataAdapter();
    const docStore = makeDocStore(adapter);
    const harness = createHarness({}, docStore);
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const session = await harness.manager.ensureSession("room_1", "Board.md");
    await docStore.save("room_1", "Board.md", 0, Y.encodeStateAsUpdate(session.doc));
    expect(await docStore.load("room_1", "Board.md", 0)).not.toBeNull();

    await ack(harness, {
      type: "crdt_rejected",
      roomId: "room_1",
      relativePath: "Board.md",
      code: "CRDT_STALE_EPOCH",
      message: "stale",
      currentEpoch: 1
    });

    expect(harness.manager.isSessionOpen("room_1", "Board.md")).toBe(false);
    expect(await docStore.load("room_1", "Board.md", 0)).toBeNull();

    const resynced = await harness.manager.ensureSession("room_1", "Board.md");
    expect(resynced.epoch).toBe(1);
  });
});

describe("CrdtSessionManager - materialization when not bound to an editor", () => {
  it("writes materialized text to disk for a remote update when unbound, but not while bound to an editor", async () => {
    let flushMaterialize: (() => void) | undefined;
    const harness = createHarness({
      schedule: (fn) => {
        flushMaterialize = fn;
        return 1;
      },
      cancel: () => undefined
    });
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    await harness.manager.ensureSession("room_1", "Board.md");

    const remoteDoc = new Y.Doc();
    remoteDoc.getText(CRDT_TEXT_KEY).insert(0, "from teammate");
    await ack(harness, {
      type: "remote_crdt_update",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 0,
      update: Buffer.from(Y.encodeStateAsUpdate(remoteDoc)).toString("base64"),
      updatedBy: { userId: "user_2", displayName: "Teammate" }
    });

    flushMaterialize?.();
    expect(harness.writes).toContainEqual({ roomId: "room_1", relativePath: "Board.md", text: "from teammate" });
  });

  it("does not materialize to disk while the session is bound to an open editor", async () => {
    let flushMaterialize: (() => void) | undefined;
    const harness = createHarness({
      schedule: (fn) => {
        flushMaterialize = fn;
        return 1;
      },
      cancel: () => undefined
    });
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    await harness.manager.ensureSession("room_1", "Board.md");
    harness.manager.bindToEditor("room_1", "Board.md");

    const remoteDoc = new Y.Doc();
    remoteDoc.getText(CRDT_TEXT_KEY).insert(0, "from teammate");
    await ack(harness, {
      type: "remote_crdt_update",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 0,
      update: Buffer.from(Y.encodeStateAsUpdate(remoteDoc)).toString("base64"),
      updatedBy: { userId: "user_2", displayName: "Teammate" }
    });

    flushMaterialize?.();
    expect(harness.writes).toHaveLength(0);
  });
});

describe("CrdtSessionManager - local delete forgets stale state", () => {
  it("[audit fix] forgetting a local delete drops the session/known-epoch and lets a recreate allocate a fresh epoch", async () => {
    const adapter = new FakeDataAdapter();
    const docStore = makeDocStore(adapter);
    const harness = createHarness({}, docStore);
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const session = await harness.manager.ensureSession("room_1", "Board.md");
    await docStore.save("room_1", "Board.md", 0, Y.encodeStateAsUpdate(session.doc));
    expect(await docStore.load("room_1", "Board.md", 0)).not.toBeNull();

    await harness.manager.forgetLocalDelete("room_1", "Board.md");

    expect(harness.manager.isSessionOpen("room_1", "Board.md")).toBe(false);
    expect(await docStore.load("room_1", "Board.md", 0)).toBeNull();

    // A local recreate at the same path must allocate a fresh epoch via crdt_create, never
    // silently reuse the stale pre-delete epoch/session - the resurrection risk this fix closes.
    const recreatePromise = harness.manager.ensureSession("room_1", "Board.md");
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(true));
    const createMessage = harness.sent.find((message) => message.type === "crdt_create") as Extract<SyncClientMessage, { type: "crdt_create" }>;
    await ack(harness, { type: "crdt_created", requestId: createMessage.requestId, roomId: "room_1", relativePath: "Board.md", documentId: "file_1", epoch: 1 });
    const recreated = await recreatePromise;
    expect(recreated.epoch).toBe(1);
    expect(recreated.ytext.toString()).toBe("");
  });
});

describe("CrdtSessionManager - reconciling an already-open unbound session", () => {
  it("[audit fix] re-reconciles disk text for an already-open, unbound session instead of silently dropping an external edit", async () => {
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    harness.disk.set("room_1/Board.md", "original");
    const session = await harness.manager.ensureSession("room_1", "Board.md");
    expect(session.ytext.toString()).toBe("original");

    // Simulate an external tool editing the file on disk while the session stays open and unbound
    // (no editor currently has it open) - the vault watcher would re-fire ensureSession for the
    // same path on the resulting "modify" event.
    harness.disk.set("room_1/Board.md", "original + external edit");
    const again = await harness.manager.ensureSession("room_1", "Board.md");

    expect(again).toBe(session);
    expect(again.ytext.toString()).toBe("original + external edit");
  });

  it("[audit fix] does not re-reconcile disk while the session is bound to an open editor", async () => {
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    harness.disk.set("room_1/Board.md", "original");
    const session = await harness.manager.ensureSession("room_1", "Board.md");
    harness.manager.bindToEditor("room_1", "Board.md");

    harness.disk.set("room_1/Board.md", "should not be pulled in while bound");
    const again = await harness.manager.ensureSession("room_1", "Board.md");

    expect(again).toBe(session);
    expect(again.ytext.toString()).toBe("original");
  });
});

describe("CrdtSessionManager - reconcile vs. concurrent remote update race", () => {
  it("[bug fix 2026-07-23] does not delete a teammate's concurrently merged edit when a disk reconcile straddles its arrival", async () => {
    // Reproduces a real 2-device bug: A types "11", B types "22" right after it on the same line at
    // nearly the same time. B ends up with the full merge ("1122"); A ends up with only its own
    // "11" - the teammate's insert silently vanishes, alongside Obsidian's own "changed externally,
    // merged automatically" notice firing on A's device. Root cause (two-part): (1) reconcile ran
    // while disk was legitimately stale relative to an already-applied-but-not-yet-materialized
    // remote update - flushMaterialize forces that write first; (2) even after flushing, a *further*
    // remote update landing mid-read would still be diffed against stale disk - the revision-guarded
    // retry in reconcileAgainstDisk closes that by detecting the doc changed mid-read and re-reading
    // (re-flushing) instead of diffing against stale disk content.
    const disk = new Map<string, string>();
    disk.set("room_1/Board.md", "11");
    const writes: Array<{ roomId: string; relativePath: string; text: string }> = [];
    let readCount = 0;
    let releaseSecondRead: (() => void) | undefined;
    const harness = createHarness({
      readDiskText: async (roomId, relativePath) => {
        readCount++;
        if (readCount === 2) {
          await new Promise<void>((resolve) => {
            releaseSecondRead = resolve;
          });
        }
        return disk.get(`${roomId}/${relativePath}`) ?? null;
      },
      writeDiskText: async (roomId, relativePath, text) => {
        writes.push({ roomId, relativePath, text });
        disk.set(`${roomId}/${relativePath}`, text);
      }
    });
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);

    // First ensureSession: brand-new session, seeded from disk ("11") - consumes readCount 1.
    const session = await harness.manager.ensureSession("room_1", "Board.md");
    expect(session.ytext.toString()).toBe("11");

    // Second ensureSession: session already open and unbound, hits the fast-path reconcile, whose
    // first readDiskText call is readCount 2 - it will hang until releaseSecondRead() is called.
    const reconcilePromise = harness.manager.ensureSession("room_1", "Board.md");
    await vi.waitFor(() => expect(readCount).toBe(2));

    // While that disk read is still in flight, B's edit arrives and merges live into the doc, right
    // after A's "11" - built from a clone that shares session.doc's lineage (not an independent
    // fresh Y.Doc) so the merge position is deterministic instead of depending on Yjs's arbitrary
    // concurrent-insert tie-breaking between two unrelated docs.
    const cloneDoc = new Y.Doc();
    Y.applyUpdate(cloneDoc, Y.encodeStateAsUpdate(session.doc));
    const stateVectorBeforeRemoteEdit = Y.encodeStateVector(session.doc);
    cloneDoc.getText(CRDT_TEXT_KEY).insert(2, "22");
    const remoteUpdate = Y.encodeStateAsUpdate(cloneDoc, stateVectorBeforeRemoteEdit);
    await ack(harness, {
      type: "remote_crdt_update",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 0,
      update: Buffer.from(remoteUpdate).toString("base64"),
      updatedBy: { userId: "user_2", displayName: "Teammate" }
    });
    expect(session.ytext.toString()).toBe("1122");

    // Now let the stale ("11") disk read resolve. Without the fix, this diffs "1122" against "11"
    // and deletes "22" for good; with it, reconcileAgainstDisk detects the mid-read change, flushes
    // the materialize the remote update just scheduled (writing "1122" to disk), and retries against
    // a now-fresh, matching read - finding nothing left to reconcile.
    releaseSecondRead?.();
    await reconcilePromise;

    expect(session.ytext.toString()).toBe("1122");
    expect(writes).toContainEqual({ roomId: "room_1", relativePath: "Board.md", text: "1122" });
  });
});

describe("CrdtSessionManager - concurrent ensureSession calls for a brand-new path", () => {
  it("[audit fix] coalesces concurrent callers onto a single crdt_create instead of one per caller", async () => {
    const harness = createHarness();

    const first = harness.manager.ensureSession("room_1", "Board.md");
    const second = harness.manager.ensureSession("room_1", "Board.md");

    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(true));
    const createMessages = harness.sent.filter((message) => message.type === "crdt_create");
    expect(createMessages).toHaveLength(1);

    const createMessage = createMessages[0] as Extract<SyncClientMessage, { type: "crdt_create" }>;
    await ack(harness, { type: "crdt_created", requestId: createMessage.requestId, roomId: "room_1", relativePath: "Board.md", documentId: "file_1", epoch: 0 });

    const [firstSession, secondSession] = await Promise.all([first, second]);
    expect(firstSession).toBe(secondSession);
  });
});

describe("CrdtSessionManager - room disposal", () => {
  it("deletes all persisted state for a room and drops its in-memory sessions", async () => {
    const adapter = new FakeDataAdapter();
    const docStore = makeDocStore(adapter);
    const harness = createHarness({}, docStore);
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const session = await harness.manager.ensureSession("room_1", "Board.md");
    await docStore.save("room_1", "Board.md", 0, Y.encodeStateAsUpdate(session.doc));

    await harness.manager.disposeRoom("room_1");

    expect(harness.manager.isSessionOpen("room_1", "Board.md")).toBe(false);
    expect(await docStore.load("room_1", "Board.md", 0)).toBeNull();
  });
});
