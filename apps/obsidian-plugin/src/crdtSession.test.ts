import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import * as Y from "yjs";
import type { SyncClientMessage, SyncServerMessage } from "@vault-rooms/protocol";
import { CRDT_TEXT_KEY } from "vault-rooms-relay/embedded-core";
import { CrdtDocStore } from "./crdtDocStore.js";
import { CrdtRejectedError, CrdtSessionManager, type CrdtSessionManagerDeps } from "./crdtSession.js";

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
  renames: Array<{ roomId: string; oldRelativePath: string; newRelativePath: string }>;
};

function createHarness(overrides: Partial<CrdtSessionManagerDeps> = {}, docStore = makeDocStore()): Harness {
  const sent: SyncClientMessage[] = [];
  const disk = new Map<string, string>();
  const writes: Array<{ roomId: string; relativePath: string; text: string }> = [];
  const renames: Array<{ roomId: string; oldRelativePath: string; newRelativePath: string }> = [];
  let counter = 0;
  const manager = new CrdtSessionManager({
    // Returns true: the harness's socket is always "open". A test that needs the dropped-send path
    // overrides `send` explicitly.
    send: (message) => {
      sent.push(message);
      return true;
    },
    docStore,
    isRoomCrdtEnabled: () => true,
    readDiskText: async (roomId, relativePath) => disk.get(`${roomId}/${relativePath}`) ?? null,
    writeDiskText: async (roomId, relativePath, text) => {
      writes.push({ roomId, relativePath, text });
      disk.set(`${roomId}/${relativePath}`, text);
    },
    renameDiskFile: async (roomId, oldRelativePath, newRelativePath) => {
      renames.push({ roomId, oldRelativePath, newRelativePath });
      const key = `${roomId}/${oldRelativePath}`;
      const content = disk.get(key);
      if (content !== undefined) {
        disk.delete(key);
        disk.set(`${roomId}/${newRelativePath}`, content);
      }
    },
    createRequestId: () => `req_${++counter}`,
    ...overrides
  });
  return { manager, sent, disk, writes, renames };
}

function ack(harness: Harness, message: SyncServerMessage): Promise<void> {
  return harness.manager.handleServerMessage(message);
}

/**
 * Opens a session for a path the server does *not* already have a document for, so its on-disk text
 * seeds the fresh document. Since the seventeenth hardware-testing round the client only seeds when the
 * server answers `crdt_created` with `adopted: false` - a document the server already holds gets its
 * content from the handshake instead, because seeding on top of that is what duplicated notes on every
 * remount. Tests that just need "a session whose doc contains the disk text" go through this helper
 * rather than pre-seeding an epoch via `handleRoomSnapshot` (which now means "the server already has
 * this document" and therefore correctly does not seed).
 */
async function openFreshlyCreatedSession(harness: Harness, roomId: string, relativePath: string, epoch = 0) {
  const opening = harness.manager.ensureSession(roomId, relativePath, { brandNewNote: true });
  await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(true));
  const createMessage = harness.sent.find((message) => message.type === "crdt_create") as Extract<SyncClientMessage, { type: "crdt_create" }>;
  await ack(harness, {
    type: "crdt_created",
    requestId: createMessage.requestId,
    roomId,
    relativePath,
    documentId: "file_test",
    epoch,
    adopted: false
  });
  return opening;
}

describe("CrdtSessionManager - first create", () => {
  it("forces a receipt-backed create with its stable operationId even when reconnect snapshot knows that path", async () => {
    const harness = createHarness({ isPathProtectedByJournal: (_roomId, relativePath) => relativePath === "Offline.md" });
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Offline.md", crdtEpoch: 3 }]);
    await expect(harness.manager.ensureSessionIfKnown("room_1", "Offline.md")).resolves.toBeUndefined();

    const opening = harness.manager.ensureSession("room_1", "Offline.md", {
      brandNewNote: true,
      operationId: "op_offline_create"
    });
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(true));
    const createMessage = harness.sent.find((message) => message.type === "crdt_create") as Extract<SyncClientMessage, { type: "crdt_create" }>;
    expect(createMessage.operationId).toBe("op_offline_create");
    await ack(harness, {
      type: "crdt_created",
      requestId: createMessage.requestId,
      roomId: "room_1",
      relativePath: "Offline.md",
      documentId: "file_1",
      epoch: 3,
      adopted: false
    });
    await opening;
  });

  it("sends crdt_create when no epoch is known yet, and resolves ensureSession once crdt_created arrives", async () => {
    const harness = createHarness();
    const sessionPromise = harness.manager.ensureSession("room_1", "Board.md");

    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(true));
    const createMessage = harness.sent.find((message) => message.type === "crdt_create") as Extract<SyncClientMessage, { type: "crdt_create" }>;
    await ack(harness, { type: "crdt_created", requestId: createMessage.requestId, roomId: "room_1", relativePath: "Board.md", documentId: "file_1", epoch: 0 });

    const session = await sessionPromise;
    expect(session.epoch).toBe(0);
  });

  it("rejects a receipt-backed create with the server code intact", async () => {
    const harness = createHarness();
    const opening = harness.manager.ensureSession("room_1", "Taken.md", {
      brandNewNote: true,
      operationId: "op_taken"
    });
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(true));
    const createMessage = harness.sent.find((message) => message.type === "crdt_create") as Extract<SyncClientMessage, { type: "crdt_create" }>;

    await ack(harness, {
      type: "crdt_rejected",
      requestId: createMessage.requestId,
      roomId: "room_1",
      relativePath: "Taken.md",
      code: "FILE_EXISTS",
      message: "A file already exists at this path."
    });

    await expect(opening).rejects.toEqual(expect.objectContaining<CrdtRejectedError>({
      name: "CrdtRejectedError",
      code: "FILE_EXISTS",
      message: "A file already exists at this path."
    }));
  });

  it("resolves structural receipts without opening a CRDT session after room mode changed", async () => {
    const harness = createHarness({ isRoomCrdtEnabled: () => false });
    const resolver = harness.manager as unknown as {
      resolveCreateOperation: (roomId: string, relativePath: string, operationId: string) => Promise<{ relativePath: string }>;
      resolveRenameOperation: (roomId: string, oldRelativePath: string, relativePath: string, operationId: string) => Promise<{ relativePath: string }>;
    };

    const create = resolver.resolveCreateOperation("room_1", "Created.md", "op_create");
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(true));
    const createMessage = harness.sent.find((message) => message.type === "crdt_create") as Extract<SyncClientMessage, { type: "crdt_create" }>;
    await ack(harness, {
      type: "crdt_created",
      requestId: createMessage.requestId,
      roomId: "room_1",
      relativePath: "Created.md",
      documentId: "file_1",
      epoch: 0,
      adopted: false
    });
    await expect(create).resolves.toEqual({ relativePath: "Created.md" });

    const rename = resolver.resolveRenameOperation("room_1", "Created.md", "Renamed.md", "op_rename");
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_rename")).toBe(true));
    const renameMessage = harness.sent.find((message) => message.type === "crdt_rename") as Extract<SyncClientMessage, { type: "crdt_rename" }>;
    await ack(harness, {
      type: "crdt_renamed",
      requestId: renameMessage.requestId,
      roomId: "room_1",
      oldRelativePath: "Created.md",
      relativePath: "Renamed.md",
      epoch: 0
    });
    await expect(rename).resolves.toEqual({ relativePath: "Renamed.md" });
    expect(harness.manager.isSessionOpen("room_1", "Created.md")).toBe(false);
    expect(harness.manager.isSessionOpen("room_1", "Renamed.md")).toBe(false);
  });

  it("throws for a path/room that is not CRDT-eligible", async () => {
    const harness = createHarness({ isRoomCrdtEnabled: () => false });
    await expect(harness.manager.ensureSession("room_1", "Board.md")).rejects.toThrow();
  });

  // Thirteenth hardware-testing round (2026-07-24): edits took ~3s to appear on the other device (or
  // arrived in a lump when the editor lost focus). A live remote_crdt_update was silently dropped when
  // no session existed for the path, so the receiving device had to wait for the server's *debounced*
  // materialize to arrive as a remote_file_change instead. Live receipt must not depend on the
  // editor-binding pass having run first.
  it("opens a session on a live remote_crdt_update for a path it has none for, instead of dropping it", async () => {
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "note.md", crdtEpoch: 2 }]);
    expect(harness.manager.isSessionOpen("room_1", "note.md")).toBe(false);

    const doc = new Y.Doc();
    doc.getText(CRDT_TEXT_KEY).insert(0, "typed on the other device a moment ago");
    await ack(harness, {
      type: "remote_crdt_update",
      roomId: "room_1",
      relativePath: "note.md",
      epoch: 2,
      update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
      updatedBy: { userId: "user_2", displayName: "Teammate" }
    });

    // The session is opened (and its handshake will pull in what this update carried) rather than the
    // update being discarded and the device left waiting on the materialize debounce.
    await vi.waitFor(() => expect(harness.manager.isSessionOpen("room_1", "note.md")).toBe(true));
    const session = await harness.manager.ensureSession("room_1", "note.md");
    expect(session.epoch).toBe(2);
    expect(session.ytext.toString()).toBe("typed on the other device a moment ago");
    // No crdt_create either - the epoch was already known from the room snapshot.
    expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(false);
  });

  // Ninth hardware-testing round (2026-07-24): breaking the receive->create feedback loop. Applying an
  // announce/materialize writes the file to disk, which fires this device's own watcher "create" and
  // calls ensureSession. Without a known epoch that issued a crdt_create for a path the server already
  // had a document at; once collisions auto-renamed instead of failing, every such collision produced
  // a new suffixed name that was announced back, escalating forever between the two devices.
  it("adopts an announced document instead of creating one, after registerKnownEpoch", async () => {
    const harness = createHarness();
    harness.disk.set("room_1/announced.md", "content the peer sent us");

    // Exactly what syncWsClient does on a remote_file_change carrying crdtEpoch.
    harness.manager.registerKnownEpoch("room_1", "announced.md", 3);

    const session = await harness.manager.ensureSession("room_1", "announced.md");

    // No crdt_create at all - the epoch was already known, so this adopts the existing document.
    expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(false);
    expect(session.epoch).toBe(3);
  });

  // Tenth hardware-testing round (2026-07-24): the WS log showed an endless
  // crdt_update -> crdt_rejected stream while the note refused to sync. A rejection with no
  // currentEpoch (NOT_FOUND: no document at this path at all) had no recovery, so the session kept
  // pushing updates the server kept refusing and the edits were stranded forever.
  it("re-establishes the document when the server reports NOT_FOUND for a path it is pushing to", async () => {
    const harness = createHarness();
    harness.disk.set("room_1/note.md", "text the user typed and must not lose");
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "note.md", crdtEpoch: 4 }]);
    await harness.manager.ensureSession("room_1", "note.md");
    harness.sent.length = 0;

    // The server says there is no document here (and offers no newer epoch to move to).
    await ack(harness, {
      type: "crdt_rejected",
      roomId: "room_1",
      relativePath: "note.md",
      code: "NOT_FOUND",
      message: "No CRDT document exists at this path yet - send crdt_create first."
    });

    // Recovery re-establishes it rather than leaving the session pushing into the void.
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(true));
    const created = harness.sent.find((message) => message.type === "crdt_create") as Extract<SyncClientMessage, { type: "crdt_create" }>;
    expect(created).toMatchObject({ roomId: "room_1", relativePath: "note.md" });
    await ack(harness, { type: "crdt_created", requestId: created.requestId, roomId: "room_1", relativePath: "note.md", documentId: "file_9", epoch: 5 });

    // The user's on-disk text is what seeds the re-established document, so nothing is lost.
    const session = await harness.manager.ensureSession("room_1", "note.md");
    expect(session.epoch).toBe(5);
    expect(session.ytext.toString()).toBe("text the user typed and must not lose");
  });

  it("registerKnownEpoch never downgrades a newer epoch and never disturbs an open session", async () => {
    const harness = createHarness();
    harness.manager.registerKnownEpoch("room_1", "note.md", 5);
    harness.manager.registerKnownEpoch("room_1", "note.md", 2);
    const session = await harness.manager.ensureSession("room_1", "note.md");
    expect(session.epoch).toBe(5);

    // A late announce for a path this device already has open must not disturb it.
    harness.manager.registerKnownEpoch("room_1", "note.md", 9);
    expect(await harness.manager.ensureSession("room_1", "note.md")).toBe(session);
    expect(session.epoch).toBe(5);
  });

  // Seventh hardware-testing round (2026-07-24): every new Obsidian note starts with the same default
  // name, so two devices creating one collide constantly. The first creator keeps the name; this
  // device is told its note was filed under a different path, and must move its local file to match
  // so the file the user sees and the document being synced are the same thing.
  it("adopts a server-assigned path when the requested name was already taken, moving the local file", async () => {
    const reassignments: Array<{ requested: string; assigned: string }> = [];
    const harness = createHarness({
      onPathReassigned: (_roomId, requested, assigned) => reassignments.push({ requested, assigned })
    });
    harness.disk.set("room_1/Untitled.md", "my brand-new note");

    const sessionPromise = harness.manager.ensureSession("room_1", "Untitled.md");
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(true));
    const createMessage = harness.sent.find((message) => message.type === "crdt_create") as Extract<SyncClientMessage, { type: "crdt_create" }>;
    expect(createMessage).toMatchObject({ relativePath: "Untitled.md" });

    await ack(harness, {
      type: "crdt_created",
      requestId: createMessage.requestId,
      roomId: "room_1",
      relativePath: "Untitled (B laptop).md",
      documentId: "file_2",
      epoch: 0
    });
    const session = await sessionPromise;

    // The session lives at the assigned path, the vault file moved there with its content, and the
    // user was told why their note is now called something else.
    expect(session.relativePath).toBe("Untitled (B laptop).md");
    expect(harness.manager.isSessionOpen("room_1", "Untitled (B laptop).md")).toBe(true);
    expect(harness.manager.isSessionOpen("room_1", "Untitled.md")).toBe(false);
    expect(harness.renames).toContainEqual({ roomId: "room_1", oldRelativePath: "Untitled.md", newRelativePath: "Untitled (B laptop).md" });
    expect(harness.disk.get("room_1/Untitled (B laptop).md")).toBe("my brand-new note");
    expect(harness.disk.has("room_1/Untitled.md")).toBe(false);
    expect(reassignments).toEqual([{ requested: "Untitled.md", assigned: "Untitled (B laptop).md" }]);

    // A later edit forwards under the assigned path, not the one originally requested.
    harness.sent.length = 0;
    session.doc.transact(() => session.ytext.insert(0, "!"), null);
    const update = harness.sent.find((message) => message.type === "crdt_update") as Extract<SyncClientMessage, { type: "crdt_update" }>;
    expect(update).toMatchObject({ relativePath: "Untitled (B laptop).md" });
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

  it("does not reconnect-handshake a live session whose old path is protected by the operation journal", async () => {
    let protectedByJournal = false;
    const harness = createHarness({
      isPathProtectedByJournal: (_roomId, relativePath) => protectedByJournal && relativePath === "Old.md"
    });
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Old.md", crdtEpoch: 0 }]);
    await harness.manager.ensureSession("room_1", "Old.md");
    harness.sent.length = 0;
    protectedByJournal = true;

    harness.manager.onConnected();

    expect(harness.sent.some((message) => message.type === "crdt_sync_step1")).toBe(false);
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

  it("does not reconcile a stale disk snapshot over a live bound editor after step2", async () => {
    const harness = createHarness();
    harness.disk.set("room_1/Board.md", "");
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const session = await harness.manager.ensureSession("room_1", "Board.md");
    harness.manager.bindToEditor("room_1", "Board.md");
    const ourStep1 = harness.sent.find((message) => message.type === "crdt_sync_step1") as Extract<
      SyncClientMessage,
      { type: "crdt_sync_step1" }
    >;

    session.doc.transact(() => session.ytext.insert(0, "hello"), null);
    const outboundUpdatesBeforeStep2 = harness.sent.filter((message) => message.type === "crdt_update").length;

    await ack(harness, {
      type: "crdt_sync_step2",
      requestId: ourStep1.requestId,
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 0,
      update: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString("base64")
    });

    expect(session.ytext.toString()).toBe("hello");
    expect(harness.sent.filter((message) => message.type === "crdt_update")).toHaveLength(outboundUpdatesBeforeStep2);
  });
});

describe("CrdtSessionManager - stale epoch resync", () => {
  it("reopens an editor-owned session after the retiring callback unbinds the old document", async () => {
    let manager!: CrdtSessionManager;
    const harness = createHarness({
      onSessionRetiring: (roomId, relativePath) => manager.unbindFromEditor(roomId, relativePath)
    });
    manager = harness.manager;
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    await manager.ensureSession("room_1", "Board.md");
    manager.bindToEditor("room_1", "Board.md");

    await ack(harness, {
      type: "crdt_rejected",
      roomId: "room_1",
      relativePath: "Board.md",
      code: "CRDT_STALE_EPOCH",
      message: "stale",
      currentEpoch: 1
    });

    expect(manager.isSessionOpen("room_1", "Board.md")).toBe(true);
    expect(
      harness.sent.some(
        (message) =>
          message.type === "crdt_sync_step1" &&
          message.roomId === "room_1" &&
          message.relativePath === "Board.md" &&
          message.epoch === 1
      )
    ).toBe(true);
  });

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
    harness.disk.set("room_1/Board.md", "original");
    const session = await openFreshlyCreatedSession(harness, "room_1", "Board.md");
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
    harness.disk.set("room_1/Board.md", "original");
    const session = await openFreshlyCreatedSession(harness, "room_1", "Board.md");
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
    // First open: a document the server did not already have, so it is seeded from disk ("11") -
    // consumes readCount 1. (Opened through the create path rather than a pre-seeded snapshot epoch,
    // because a known epoch now means "the server already holds this document" and correctly does not
    // seed - see openFreshlyCreatedSession.)
    const session = await openFreshlyCreatedSession(harness, "room_1", "Board.md");
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

describe("CrdtSessionManager - atomic rename (fourth hardware-testing round, 2026-07-23)", () => {
  it("includes the journal operationId on a receipt-backed rename", async () => {
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "old.md", crdtEpoch: 0 }]);
    await harness.manager.ensureSession("room_1", "old.md");

    const renamePromise = harness.manager.renameSession("room_1", "old.md", "new.md", { operationId: "op_offline_rename" });
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_rename")).toBe(true));
    const renameMessage = harness.sent.find((message) => message.type === "crdt_rename") as Extract<SyncClientMessage, { type: "crdt_rename" }>;
    expect(renameMessage.operationId).toBe("op_offline_rename");
    await ack(harness, {
      type: "crdt_renamed",
      requestId: renameMessage.requestId,
      roomId: "room_1",
      oldRelativePath: "old.md",
      relativePath: "new.md",
      epoch: 0
    });
    await renamePromise;
  });

  it("renameSession sends crdt_rename, then rekeys the session in place - same Y.Doc, no re-seed, epoch preserved", async () => {
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "old-title.md", crdtEpoch: 0 }]);
    const session = await harness.manager.ensureSession("room_1", "old-title.md");
    session.doc.transact(() => session.ytext.insert(0, "content that must survive the rename"), null);

    const renamePromise = harness.manager.renameSession("room_1", "old-title.md", "new-title.md");
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_rename")).toBe(true));
    const renameMessage = harness.sent.find((message) => message.type === "crdt_rename") as Extract<SyncClientMessage, { type: "crdt_rename" }>;
    expect(renameMessage).toMatchObject({ roomId: "room_1", oldRelativePath: "old-title.md", relativePath: "new-title.md" });

    await ack(harness, {
      type: "crdt_renamed",
      requestId: renameMessage.requestId,
      roomId: "room_1",
      oldRelativePath: "old-title.md",
      relativePath: "new-title.md",
      epoch: 0
    });
    await renamePromise;

    // Old key is gone, new key resolves to the *same* session/doc/ytext object - not a fresh one.
    expect(harness.manager.isSessionOpen("room_1", "old-title.md")).toBe(false);
    expect(harness.manager.isSessionOpen("room_1", "new-title.md")).toBe(true);
    const rekeyed = await harness.manager.ensureSession("room_1", "new-title.md");
    expect(rekeyed).toBe(session);
    expect(rekeyed.ytext.toString()).toBe("content that must survive the rename");
    expect(rekeyed.epoch).toBe(0);

    // A further local edit now forwards crdt_update tagged with the *new* path - not the old one
    // the doc.on("update") listener originally captured (see openSession's doc comment on why this
    // must read from `session` dynamically, not the closure's original params).
    harness.sent.length = 0;
    session.doc.transact(() => session.ytext.insert(session.ytext.length, "!"), null);
    const update = harness.sent.find((message) => message.type === "crdt_update") as Extract<SyncClientMessage, { type: "crdt_update" }>;
    expect(update).toMatchObject({ roomId: "room_1", relativePath: "new-title.md" });
  });

  it("a rejected crdt_rename (e.g. FILE_EXISTS) rejects renameSession's promise without touching the old session", async () => {
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "old-title.md", crdtEpoch: 0 }]);
    const session = await harness.manager.ensureSession("room_1", "old-title.md");

    const renamePromise = harness.manager.renameSession("room_1", "old-title.md", "taken.md");
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_rename")).toBe(true));
    const renameMessage = harness.sent.find((message) => message.type === "crdt_rename") as Extract<SyncClientMessage, { type: "crdt_rename" }>;

    await ack(harness, {
      type: "crdt_rejected",
      requestId: renameMessage.requestId,
      roomId: "room_1",
      relativePath: "taken.md",
      code: "FILE_EXISTS",
      message: "A file already exists at the new path."
    });

    await expect(renamePromise).rejects.toThrow(/A file already exists/);
    expect(harness.manager.isSessionOpen("room_1", "old-title.md")).toBe(true);
    expect(await harness.manager.ensureSession("room_1", "old-title.md")).toBe(session);
  });

  it("applies a remote_crdt_rename by moving the on-disk file, even with no local session ever opened for it", async () => {
    const harness = createHarness();
    harness.disk.set("room_1/old-title.md", "never opened this file locally");

    await ack(harness, {
      type: "remote_crdt_rename",
      roomId: "room_1",
      oldRelativePath: "old-title.md",
      relativePath: "new-title.md",
      epoch: 0,
      renamedBy: { userId: "user_2", displayName: "Teammate" }
    });

    expect(harness.renames).toContainEqual({ roomId: "room_1", oldRelativePath: "old-title.md", newRelativePath: "new-title.md" });
    expect(harness.disk.get("room_1/new-title.md")).toBe("never opened this file locally");
    expect(harness.disk.has("room_1/old-title.md")).toBe(false);
  });

  it("applies a remote_crdt_rename to a locally-open session too (this device also had the file open), preserving its content", async () => {
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "old-title.md", crdtEpoch: 0 }]);
    const session = await harness.manager.ensureSession("room_1", "old-title.md");
    session.doc.transact(() => session.ytext.insert(0, "both devices had this open"), null);

    await ack(harness, {
      type: "remote_crdt_rename",
      roomId: "room_1",
      oldRelativePath: "old-title.md",
      relativePath: "new-title.md",
      epoch: 0,
      renamedBy: { userId: "user_2", displayName: "Teammate" }
    });

    expect(harness.manager.isSessionOpen("room_1", "old-title.md")).toBe(false);
    const rekeyed = await harness.manager.ensureSession("room_1", "new-title.md");
    expect(rekeyed).toBe(session);
    expect(rekeyed.ytext.toString()).toBe("both devices had this open");
    // The vault file still gets moved on disk too - a session being open doesn't own the vault's
    // own notion of this file's identity/filename, only the CRDT content does.
    expect(harness.renames).toContainEqual({ roomId: "room_1", oldRelativePath: "old-title.md", newRelativePath: "new-title.md" });
  });
});

describe("CrdtSessionManager - rename ordering (sixth hardware-testing round, 2026-07-24)", () => {
  it("waits for an in-flight crdt_create of the OLD path before sending crdt_rename (create-then-immediately-retitle)", async () => {
    // The reported duplicate: a brand-new "Untitled" note retitled a keystroke later. Its crdt_create
    // was still in flight, so the rename hit a path the server didn't have yet (NOT_FOUND) and the
    // queued create then materialized the OLD path afterwards - leaving the original next to the
    // renamed note on every other device.
    const harness = createHarness();
    const opening = harness.manager.ensureSession("room_1", "Untitled.md");
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(true));

    const renamePromise = harness.manager.renameSession("room_1", "Untitled.md", "a.md");
    // Nothing may be sent while the create is unacked - sending now is exactly what raced.
    await Promise.resolve();
    expect(harness.sent.some((message) => message.type === "crdt_rename")).toBe(false);

    const createMessage = harness.sent.find((message) => message.type === "crdt_create") as Extract<SyncClientMessage, { type: "crdt_create" }>;
    await ack(harness, { type: "crdt_created", requestId: createMessage.requestId, roomId: "room_1", relativePath: "Untitled.md", documentId: "file_1", epoch: 0 });
    await opening;

    // Only once the old path really exists server-side does the rename go out.
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_rename")).toBe(true));
    const renameMessage = harness.sent.find((message) => message.type === "crdt_rename") as Extract<SyncClientMessage, { type: "crdt_rename" }>;
    expect(renameMessage).toMatchObject({ oldRelativePath: "Untitled.md", relativePath: "a.md" });
    await ack(harness, {
      type: "crdt_renamed",
      requestId: renameMessage.requestId,
      roomId: "room_1",
      oldRelativePath: "Untitled.md",
      relativePath: "a.md",
      epoch: 0
    });
    await renamePromise;
    expect(harness.manager.isSessionOpen("room_1", "a.md")).toBe(true);
    expect(harness.manager.isSessionOpen("room_1", "Untitled.md")).toBe(false);
  });

  it("serializes a chain of renames so each starts from the path the previous one established", async () => {
    // Obsidian fires one rename per inline-title commit, so retitling in steps ("a" -> "ab" -> "abc")
    // arrives as a burst the caller never awaits. Run concurrently these overlapped and 404'd.
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "a.md", crdtEpoch: 0 }]);
    await harness.manager.ensureSession("room_1", "a.md");
    harness.sent.length = 0;

    const first = harness.manager.renameSession("room_1", "a.md", "ab.md");
    const second = harness.manager.renameSession("room_1", "ab.md", "abc.md");

    // Only the first rename is in flight; the second waits its turn.
    await vi.waitFor(() => expect(harness.sent.filter((message) => message.type === "crdt_rename")).toHaveLength(1));
    const firstMessage = harness.sent.find((message) => message.type === "crdt_rename") as Extract<SyncClientMessage, { type: "crdt_rename" }>;
    expect(firstMessage).toMatchObject({ oldRelativePath: "a.md", relativePath: "ab.md" });

    await ack(harness, { type: "crdt_renamed", requestId: firstMessage.requestId, roomId: "room_1", oldRelativePath: "a.md", relativePath: "ab.md", epoch: 0 });
    await first;

    await vi.waitFor(() => expect(harness.sent.filter((message) => message.type === "crdt_rename")).toHaveLength(2));
    const secondMessage = harness.sent.filter((message) => message.type === "crdt_rename")[1] as Extract<SyncClientMessage, { type: "crdt_rename" }>;
    expect(secondMessage).toMatchObject({ oldRelativePath: "ab.md", relativePath: "abc.md" });
    await ack(harness, {
      type: "crdt_renamed",
      requestId: secondMessage.requestId,
      roomId: "room_1",
      oldRelativePath: "ab.md",
      relativePath: "abc.md",
      epoch: 0
    });
    await second;
    expect(harness.manager.isSessionOpen("room_1", "abc.md")).toBe(true);
  });

  // Eleventh hardware-testing round (2026-07-24), diagnosed from a real WS trace: Obsidian's rename
  // moves the open editor's file, which fires active-leaf-change and re-runs the pane bind pass, so
  // ensureSession was called for the rename's DESTINATION while the rename was still in flight. That
  // allocated a competing brand-new document there ~5ms early, and the rename then collided with its
  // own device's creation (`crdt_create "X1.md"` -> `crdt_created` -> `crdt_rename … -> "X1.md"` ->
  // `crdt_rejected FILE_EXISTS`).
  it("does not create a competing document when ensureSession races a rename to the same destination", async () => {
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Untitled.md", crdtEpoch: 0 }]);
    await harness.manager.ensureSession("room_1", "Untitled.md");
    harness.sent.length = 0;

    const renamePromise = harness.manager.renameSession("room_1", "Untitled.md", "Untitled1.md");
    // The editor rebind for the destination path, exactly as it arrives on real hardware.
    const bindPromise = harness.manager.ensureSession("room_1", "Untitled1.md");

    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_rename")).toBe(true));
    // Crucially: no crdt_create for the destination - it waits for the rename instead of racing it.
    expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(false);

    const renameMessage = harness.sent.find((message) => message.type === "crdt_rename") as Extract<SyncClientMessage, { type: "crdt_rename" }>;
    await ack(harness, {
      type: "crdt_renamed",
      requestId: renameMessage.requestId,
      roomId: "room_1",
      oldRelativePath: "Untitled.md",
      relativePath: "Untitled1.md",
      epoch: 0
    });
    await renamePromise;

    // The rebind resolves onto the *renamed* document, still with no create ever sent.
    const bound = await bindPromise;
    expect(bound.relativePath).toBe("Untitled1.md");
    expect(bound.epoch).toBe(0);
    expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(false);
  });

  it("adopts a server-disambiguated rename target, moving the local file and reporting it", async () => {
    const reassignments: Array<{ requested: string; assigned: string }> = [];
    const harness = createHarness({
      onPathReassigned: (_roomId, requested, assigned) => reassignments.push({ requested, assigned })
    });
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "a.md", crdtEpoch: 0 }]);
    await harness.manager.ensureSession("room_1", "a.md");
    harness.disk.set("room_1/b.md", "the note the user just renamed");

    const renamePromise = harness.manager.renameSession("room_1", "a.md", "b.md");
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_rename")).toBe(true));
    const renameMessage = harness.sent.find((message) => message.type === "crdt_rename") as Extract<SyncClientMessage, { type: "crdt_rename" }>;

    // The ack reports a path *different* from the one requested. That difference is the whole subject of
    // this test, so the assigned name must not be edited to match the requested one - doing so (a
    // find-and-replace that scrubbed a real display name out of the fixture) turned this into an
    // assertion that a no-op "b.md -> b.md" rename moves a file and fires a reassignment callback, which
    // it correctly does not. Kept as a neutral placeholder name for that reason.
    await ack(harness, {
      type: "crdt_renamed",
      requestId: renameMessage.requestId,
      roomId: "room_1",
      oldRelativePath: "a.md",
      relativePath: "b (Teammate).md",
      epoch: 0
    });
    await renamePromise;

    expect(harness.manager.isSessionOpen("room_1", "b (Teammate).md")).toBe(true);
    expect(harness.renames).toContainEqual({ roomId: "room_1", oldRelativePath: "b.md", newRelativePath: "b (Teammate).md" });
    expect(harness.disk.get("room_1/b (Teammate).md")).toBe("the note the user just renamed");
    expect(reassignments).toEqual([{ requested: "b.md", assigned: "b (Teammate).md" }]);
  });

  // Eighteenth round follow-up: a crdt_rename in flight when the socket dropped left its promise pending
  // forever, so main.ts's fallback never ran and the session stayed keyed to the old path while the file
  // on disk had already moved. Losing the connection must fail the request, not strand it.
  it("rejects an in-flight rename when the connection drops, so the caller's fallback can run", async () => {
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "a.md", crdtEpoch: 0 }]);
    await harness.manager.ensureSession("room_1", "a.md");

    const renamePromise = harness.manager.renameSession("room_1", "a.md", "b.md");
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_rename")).toBe(true));

    harness.manager.onDisconnected();

    await expect(renamePromise).rejects.toThrow(/connection to the server was lost/i);
    // The old session is left intact - nothing was renamed, so nothing should have been rekeyed.
    expect(harness.manager.isSessionOpen("room_1", "a.md")).toBe(true);
  });

  // A rejection can arrive for a path this device has already renamed away from: an edit typed in the
  // rename-ack window goes out under the old path, and the server answers NOT_FOUND once the rename has
  // committed. Recovering that would crdt_create the old path again - recreating exactly the duplicate the
  // rename protocol exists to prevent.
  it("does not re-create a document for a path it has already renamed away from", async () => {
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "a.md", crdtEpoch: 0 }]);
    await harness.manager.ensureSession("room_1", "a.md");

    const renamePromise = harness.manager.renameSession("room_1", "a.md", "b.md");
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_rename")).toBe(true));
    const renameMessage = harness.sent.find((message) => message.type === "crdt_rename") as Extract<SyncClientMessage, { type: "crdt_rename" }>;
    await ack(harness, {
      type: "crdt_renamed",
      requestId: renameMessage.requestId,
      roomId: "room_1",
      oldRelativePath: "a.md",
      relativePath: "b.md",
      epoch: 0
    });
    await renamePromise;
    harness.sent.length = 0;

    // The late rejection of an update that was sent under the old path, after the rename committed.
    await ack(harness, {
      type: "crdt_rejected",
      roomId: "room_1",
      relativePath: "a.md",
      code: "NOT_FOUND",
      message: "No CRDT document exists at this path yet - send crdt_create first."
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(false);
    expect(harness.manager.isSessionOpen("room_1", "a.md")).toBe(false);
    expect(harness.manager.isSessionOpen("room_1", "b.md")).toBe(true);
  });

  it("rejects an in-flight first-create when the connection drops", async () => {
    const harness = createHarness();
    const opening = harness.manager.ensureSession("room_1", "fresh.md", { brandNewNote: true });
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_create")).toBe(true));

    harness.manager.onDisconnected();

    await expect(opening).rejects.toThrow(/connection to the server was lost/i);
  });

  // Same round: an edit typed while a rename awaited its ack was forwarded under the old path and
  // rejected there, then sat unsent until some later reconnect happened to run a handshake. Rekeying now
  // starts one immediately, which re-offers whatever the document holds under the path it really lives at.
  it("starts a handshake after a rename so an edit made in the ack window is re-offered", async () => {
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "a.md", crdtEpoch: 0 }]);
    const session = await harness.manager.ensureSession("room_1", "a.md");

    const renamePromise = harness.manager.renameSession("room_1", "a.md", "b.md");
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_rename")).toBe(true));
    const renameMessage = harness.sent.find((message) => message.type === "crdt_rename") as Extract<SyncClientMessage, { type: "crdt_rename" }>;

    // Typed in the window between sending crdt_rename and receiving its ack.
    session.doc.transact(() => session.ytext.insert(0, "typed mid-rename"), null);
    harness.sent.length = 0;

    await ack(harness, {
      type: "crdt_renamed",
      requestId: renameMessage.requestId,
      roomId: "room_1",
      oldRelativePath: "a.md",
      relativePath: "b.md",
      epoch: 0
    });
    await renamePromise;

    // A handshake goes out for the *new* path, which is what carries the mid-rename edit to the server.
    const step1 = harness.sent.find((message) => message.type === "crdt_sync_step1") as Extract<SyncClientMessage, { type: "crdt_sync_step1" }>;
    expect(step1).toMatchObject({ roomId: "room_1", relativePath: "b.md", epoch: 0 });
    expect(session.ytext.toString()).toBe("typed mid-rename");
  });

  it("rejects a failed rename with the server's error code so the caller can tell FILE_EXISTS from NOT_FOUND", async () => {
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "a.md", crdtEpoch: 0 }]);
    await harness.manager.ensureSession("room_1", "a.md");

    const renamePromise = harness.manager.renameSession("room_1", "a.md", "taken.md");
    await vi.waitFor(() => expect(harness.sent.some((message) => message.type === "crdt_rename")).toBe(true));
    const renameMessage = harness.sent.find((message) => message.type === "crdt_rename") as Extract<SyncClientMessage, { type: "crdt_rename" }>;
    await ack(harness, {
      type: "crdt_rejected",
      requestId: renameMessage.requestId,
      roomId: "room_1",
      relativePath: "taken.md",
      code: "FILE_EXISTS",
      message: "A file already exists at the new path."
    });

    await expect(renamePromise).rejects.toMatchObject({ code: "FILE_EXISTS" });
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

  it("detaches the update forwarder and destroys every retired Y.Doc", async () => {
    const harness = createHarness();
    harness.manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const session = await harness.manager.ensureSession("room_1", "Board.md");
    const destroyed = vi.fn();
    session.doc.on("destroy", destroyed);
    harness.sent.length = 0;

    await harness.manager.disposeRoom("room_1");
    session.doc.transact(() => session.ytext.insert(0, "stale owner"), null);

    expect(destroyed).toHaveBeenCalledOnce();
    expect(harness.sent.filter((message) => message.type === "crdt_update")).toHaveLength(0);
  });
});
