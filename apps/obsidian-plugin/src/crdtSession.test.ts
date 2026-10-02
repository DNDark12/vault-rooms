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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
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

  it.each([
    ["Live.md", "live.md"],
    ["Café.md", "Cafe\u0301.md"]
  ])("keeps an editor alias %s → %s from undoing a pending portable rename", async (oldPath, newPath) => {
    const reassigned = vi.fn();
    const harness = createHarness({ onPathReassigned: reassigned });
    harness.disk.set(`room_1/${oldPath}`, "unique editor text");
    const session = await openFreshlyCreatedSession(harness, "room_1", oldPath, 3);
    harness.manager.bindToEditor("room_1", oldPath);
    // Obsidian moves the active pane before the vault rename event reaches the journal.
    // The portable key already has this session, whose spelling is still the old server name.
    harness.disk.delete(`room_1/${oldPath}`);
    harness.disk.set(`room_1/${newPath}`, "unique editor text");
    expect(await harness.manager.ensureSession("room_1", newPath)).toBe(session);
    expect(harness.renames).toEqual([]);
    expect(reassigned).not.toHaveBeenCalled();

    const renaming = harness.manager.renameSession("room_1", oldPath, newPath);
    await vi.waitFor(() => expect(harness.sent.some(message => message.type === "crdt_rename")).toBe(true));
    const request = harness.sent.find(message => message.type === "crdt_rename") as Extract<SyncClientMessage, { type: "crdt_rename" }>;
    await ack(harness, { type: "crdt_renamed", requestId: request.requestId, roomId: "room_1", oldRelativePath: oldPath, relativePath: newPath, epoch: 3 });
    await expect(renaming).resolves.toEqual({ relativePath: newPath });
    expect(session.relativePath).toBe(newPath);
    expect(session.ytext.toString()).toBe("unique editor text");
    expect(harness.disk.get(`room_1/${newPath}`)).toBe("unique editor text");
    expect(harness.renames).toEqual([]);
    await harness.manager.dispose();
  });

  it("adopts the stored spelling of a portable alias without reporting a different-file collision", async () => {
    const reassigned = vi.fn();
    const harness = createHarness({ onPathReassigned: reassigned });
    harness.manager.registerKnownEpoch("room_1", "Live.md", 3);
    const session = await harness.manager.ensureSession("room_1", "live.md");
    expect(session.relativePath).toBe("Live.md");
    expect(harness.renames).toEqual([]);
    expect(reassigned).not.toHaveBeenCalled();
    await harness.manager.dispose();
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
  it.each(["room", "manager"])("invalidates a pending disk read when the %s is disposed", async (target) => {
    const started = deferred();
    const gate = deferred();
    const h = createHarness({ readDiskText: async () => { started.resolve(); await gate.promise; return "retired local identity"; } });
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0 }]);
    const opening = h.manager.ensureSession("r", "Note.md");
    const result = opening.then(() => "opened", (error: unknown) => error);
    await started.promise;
    await (target === "room" ? h.manager.disposeRoom("r") : h.manager.dispose());
    gate.resolve();
    expect(await result).toMatchObject({ code: "SESSION_INVALIDATED" });
    expect(h.manager.isSessionOpen("r", "Note.md")).toBe(false);
    await h.manager.dispose();
  });

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


describe("portable CRDT identity", () => {
  it("adopts snapshot spelling and shares a session for case/NFD aliases", async () => {
    const h = createHarness();
    h.disk.set("r/cafe\u0301.MD", "disk");
    h.manager.handleRoomSnapshot("r", [{ relativePath: "Café.md", crdtEpoch: 3 }]);
    const opening = h.manager.ensureSession("r", "cafe\u0301.MD");
    await vi.waitFor(() => expect(h.sent.length).toBeGreaterThan(0));
    expect(h.sent.some((m) => m.type === "crdt_create")).toBe(false);
    const session = await opening;
    expect(session.relativePath).toBe("Café.md");
    expect(session.ytext.toString()).toBe("");
    expect(h.manager.isSessionOpen("r", "CAFÉ.MD")).toBe(true);
    expect(await h.manager.ensureSession("r", "Café.md")).toBe(session);
    h.manager.dispose();
  });

  it("blocks quarantined aliases before session creation and reconnect handshake", async () => {
    const h = createHarness();
    const session = await openFreshlyCreatedSession(h, "r", "Note.md");
    h.manager.handleRoomSnapshot("r", [{ relativePath: "note.md", crdtEpoch: 2, pathCollision: true }]);
    const sentBefore = h.sent.length;
    h.manager.onConnected();
    expect(h.sent).toHaveLength(sentBefore);
    await expect(h.manager.ensureSession("r", "NOTE.MD")).rejects.toMatchObject({ code: "PATH_COLLISION" });
    expect(h.sent).toHaveLength(sentBefore);
    expect(session.ytext.toString()).toBe("");
    h.manager.dispose();
  });
});


describe("CRDT collision recovery", () => {
  it("preserves and retires quarantined cached identities absent from the authoritative snapshot", async () => {
    const store = makeDocStore();
    const doc = new Y.Doc();
    doc.getText(CRDT_TEXT_KEY).insert(0, "absent unique cache");
    await store.save("r", "Gone.md", 0, Y.encodeStateAsUpdate(doc));
    await store.save("other", "Elsewhere.md", 0, Y.encodeStateAsUpdate(doc));
    const preserved = vi.fn(async () => undefined);
    const h = createHarness({ preserveRecoveredText: preserved }, store);
    await h.manager.handleRoomSnapshot("other", [{ relativePath: "Elsewhere.md", pathCollision: true }]);
    await h.manager.handleRoomSnapshot("r", [], ["Gone.md"]);
    expect(preserved).toHaveBeenCalledWith("r", "Gone.md", "absent unique cache", null);
    expect(await store.load("r", "Gone.md", 0)).toBeNull();
    expect(await h.manager.ensureSessionIfKnown("r", "Gone.md")).toBeUndefined();
    h.manager.registerKnownEpoch("r", "Gone.md", 7);
    expect((await h.manager.ensureSession("r", "Gone.md")).epoch).toBe(7);
    expect(await store.load("other", "Elsewhere.md", 0)).not.toBeNull();
    await expect(h.manager.ensureSession("other", "Elsewhere.md")).rejects.toMatchObject({ code: "PATH_COLLISION" });
    doc.destroy();
    await h.manager.dispose();
  });

  it("retains an absent quarantined cache and pause when preservation fails", async () => {
    const store = makeDocStore();
    const doc = new Y.Doc();
    doc.getText(CRDT_TEXT_KEY).insert(0, "absent unique cache");
    await store.save("r", "Gone.md", 0, Y.encodeStateAsUpdate(doc));
    const h = createHarness({ preserveRecoveredText: async () => { throw new Error("copy failed"); } }, store);
    await expect(h.manager.handleRoomSnapshot("r", [], ["Gone.md"])).rejects.toThrow("copy failed");
    expect(await store.load("r", "Gone.md", 0)).not.toBeNull();
    await expect(h.manager.ensureSession("r", "GONE.MD")).rejects.toMatchObject({ code: "PATH_COLLISION" });
    doc.destroy();
    await h.manager.dispose();
  });

  it("flushes a quarantined edit still waiting for debounce during global disposal", async () => {
    const store = makeDocStore();
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const h = createHarness({
      schedule: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
      cancel: (id) => { timers.delete(id); }
    }, store);
    h.disk.set("r/Note.md", "disk before quarantine");
    const session = await openFreshlyCreatedSession(h, "r", "Note.md");
    await store.save("r", "Note.md", 0, Y.encodeStateAsUpdate(session.doc));
    session.ytext.insert(session.ytext.length, " UNIQUE EDIT");
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0, pathCollision: true }]);
    expect(timers.size).toBeGreaterThan(0);
    const disposing = h.manager.dispose();
    expect(timers.size).toBe(0);
    await disposing;
    const preserved = vi.fn(async () => undefined);
    const restarted = createHarness({ preserveRecoveredText: preserved }, store);
    await restarted.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0, sha256: "survivor" }], ["Note.md"]);
    expect(preserved).toHaveBeenCalledWith("r", "Note.md", "disk before quarantine UNIQUE EDIT", "survivor");
    await restarted.manager.dispose();
  });

  it("saves a newer revision that arrives while the final disposal save is pending", async () => {
    const store = makeDocStore();
    const h = createHarness({}, store);
    h.disk.set("r/Note.md", "initial text");
    const session = await openFreshlyCreatedSession(h, "r", "Note.md");
    const started = deferred();
    const gate = deferred();
    const originalSave = store.save.bind(store);
    const save = vi.spyOn(store, "save").mockImplementationOnce(async (...args) => {
      started.resolve();
      await gate.promise;
      await originalSave(...args);
    });
    const disposing = h.manager.dispose();
    await started.promise;
    session.ytext.insert(session.ytext.length, " LATE UNIQUE EDIT");
    gate.resolve();
    await disposing;
    expect(save).toHaveBeenCalledTimes(2);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, (await store.load("r", "Note.md", 0))!);
    expect(restored.getText(CRDT_TEXT_KEY).toString()).toBe("initial text LATE UNIQUE EDIT");
    restored.destroy();
  });

  it("rejects global disposal without destroying the last unsaved quarantined document on write failure", async () => {
    const store = makeDocStore();
    const h = createHarness({}, store);
    h.disk.set("r/Note.md", "unique unsaved");
    const session = await openFreshlyCreatedSession(h, "r", "Note.md");
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", pathCollision: true }]);
    const destroyed = vi.fn();
    session.doc.on("destroy", destroyed);
    const save = vi.spyOn(store, "save").mockRejectedValue(new Error("disk full"));
    await expect(Promise.resolve(h.manager.dispose())).rejects.toThrow("disk full");
    expect(destroyed).not.toHaveBeenCalled();
    expect(h.manager.isSessionOpen("r", "Note.md")).toBe(true);
    expect(session.ytext.toString()).toBe("unique unsaved");
    save.mockRestore();
    await h.manager.dispose();
    expect(destroyed).toHaveBeenCalledOnce();
  });

  it("rejects repair snapshots after failed global disposal until retry persists the held document", async () => {
    const store = makeDocStore();
    const h = createHarness({}, store);
    h.disk.set("r/Note.md", "cached text");
    const session = await openFreshlyCreatedSession(h, "r", "Note.md");
    await store.save("r", "Note.md", 0, Y.encodeStateAsUpdate(session.doc));
    const cached = await store.load("r", "Note.md", 0);
    session.ytext.insert(session.ytext.length, " UNIQUE HELD EDIT");
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", pathCollision: true }]);
    const save = vi.spyOn(store, "save").mockRejectedValue(new Error("disk full"));
    await expect(h.manager.dispose()).rejects.toThrow("disk full");
    await expect(h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0, sha256: "survivor" }]))
      .rejects.toMatchObject({ code: "SESSION_INVALIDATED" });
    expect(h.manager.isSessionOpen("r", "Note.md")).toBe(true);
    expect(session.ytext.toString()).toBe("cached text UNIQUE HELD EDIT");
    expect(await store.load("r", "Note.md", 0)).toEqual(cached);
    await expect(h.manager.ensureSession("r", "NOTE.MD")).rejects.toMatchObject({ code: "PATH_COLLISION" });
    save.mockRestore();
    await h.manager.dispose();
    const preserved = vi.fn(async () => undefined);
    const restarted = createHarness({ preserveRecoveredText: preserved }, store);
    await restarted.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0, sha256: "survivor" }], ["Note.md"]);
    expect(preserved).toHaveBeenCalledWith("r", "Note.md", "cached text UNIQUE HELD EDIT", "survivor");
    await restarted.manager.dispose();
  });

  it("serializes a room-disposal save before owner repair removes the ambiguous cache", async () => {
    const store = makeDocStore();
    const h = createHarness({ preserveRecoveredText: async () => undefined }, store);
    h.disk.set("r/Note.md", "ambiguous");
    const session = await openFreshlyCreatedSession(h, "r", "Note.md");
    await store.save("r", "Note.md", 0, Y.encodeStateAsUpdate(session.doc));
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", pathCollision: true }]);
    const save = store.save.bind(store);
    const started = deferred();
    const gate = deferred();
    vi.spyOn(store, "save").mockImplementation(async (...args) => {
      started.resolve();
      await gate.promise;
      await save(...args);
    });
    const disposing = h.manager.disposeRoom("r");
    await started.promise;
    let repaired = false;
    const repairing = h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0, sha256: "survivor" }])
      .then(() => { repaired = true; });
    await vi.waitFor(() => expect(repaired).toBe(true), { timeout: 100, interval: 5 }).catch(() => undefined);
    const repairedBeforeSave = repaired;
    gate.resolve();
    await Promise.all([disposing, repairing]);
    expect(repairedBeforeSave).toBe(false);
    expect(await store.load("r", "Note.md", 0)).toBeNull();
    const restarted = createHarness({}, store);
    await restarted.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0 }]);
    const adopted = await restarted.manager.ensureSession("r", "Note.md");
    const survivor = new Y.Doc();
    survivor.getText(CRDT_TEXT_KEY).insert(0, "surviving identity");
    Y.applyUpdate(survivor, Y.encodeStateAsUpdate(adopted.doc, Y.encodeStateVector(survivor)));
    expect(survivor.getText(CRDT_TEXT_KEY).toString()).toBe("surviving identity");
    survivor.destroy();
    await restarted.manager.dispose();
    await h.manager.dispose();
  });

  it("serializes a non-awaited unload save before recovery in a new manager and distinct store", async () => {
    const adapter = new FakeDataAdapter();
    const oldStore = makeDocStore(adapter);
    const newStore = makeDocStore(adapter);
    const old = createHarness({}, oldStore);
    old.disk.set("r/Note.md", "initial ambiguous disk");
    const session = await openFreshlyCreatedSession(old, "r", "Note.md");
    await oldStore.save("r", "Note.md", 0, Y.encodeStateAsUpdate(session.doc));
    session.ytext.insert(session.ytext.length, " UNIQUE OLD LIVE EDIT");
    await old.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", pathCollision: true }]);
    const started = deferred();
    const gate = deferred();
    const save = oldStore.save.bind(oldStore);
    vi.spyOn(oldStore, "save").mockImplementation(async (...args) => {
      started.resolve();
      await gate.promise;
      await save(...args);
    });
    const preserved = vi.fn(async () => undefined);
    const fresh = createHarness({ preserveRecoveredText: preserved }, newStore);
    const retirement = old.manager.dispose(); // Obsidian unload cannot await this promise.
    let repaired = false;
    const repairing = fresh.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0, sha256: "survivor" }], ["Note.md"])
      .then(() => { repaired = true; });
    await started.promise;
    await vi.waitFor(() => expect(repaired).toBe(true), { timeout: 100, interval: 5 }).catch(() => undefined);
    const repairedBeforeSave = repaired;
    gate.resolve();
    await Promise.all([retirement, repairing]);
    const resurrected = await newStore.load("r", "Note.md", 0);
    fresh.disk.set("r/Note.md", "SURVIVOR");
    const adopted = await fresh.manager.ensureSession("r", "Note.md");
    const survivor = new Y.Doc();
    survivor.getText(CRDT_TEXT_KEY).insert(0, "SURVIVOR");
    Y.applyUpdate(survivor, Y.encodeStateAsUpdate(adopted.doc));
    const finalText = survivor.getText(CRDT_TEXT_KEY).toString();
    survivor.destroy();
    await fresh.manager.dispose();
    expect(repairedBeforeSave).toBe(false);
    expect(resurrected).toBeNull();
    expect(finalText).toBe("SURVIVOR");
    expect(preserved).toHaveBeenCalledWith("r", "Note.md", "initial ambiguous disk UNIQUE OLD LIVE EDIT", "survivor");
  });

  it("fails a queued new-manager repair when the old final save fails and recovers after retirement retry", async () => {
    const adapter = new FakeDataAdapter();
    const oldStore = makeDocStore(adapter);
    const newStore = makeDocStore(adapter);
    const old = createHarness({}, oldStore);
    old.disk.set("r/Note.md", "old cache");
    const session = await openFreshlyCreatedSession(old, "r", "Note.md");
    await oldStore.save("r", "Note.md", 0, Y.encodeStateAsUpdate(session.doc));
    const cached = await oldStore.load("r", "Note.md", 0);
    session.ytext.insert(session.ytext.length, " UNIQUE HELD EDIT");
    await old.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", pathCollision: true }]);
    const started = deferred();
    const gate = deferred();
    const save = vi.spyOn(oldStore, "save").mockImplementationOnce(async () => {
      started.resolve();
      await gate.promise;
      throw new Error("disk full");
    });
    const preserved = vi.fn(async () => undefined);
    const fresh = createHarness({ preserveRecoveredText: preserved }, newStore);
    const retirement = old.manager.dispose();
    const retirementResult = retirement.then(() => "retired", (error: unknown) => error);
    const repairing = fresh.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0, sha256: "survivor" }], ["Note.md"]);
    const repairResult = repairing.then(() => "repaired", (error: unknown) => error);
    await started.promise;
    gate.resolve();
    expect(await retirementResult).toMatchObject({ message: "disk full" });
    const result = await repairResult;
    const cacheAfterFailure = await newStore.load("r", "Note.md", 0);
    const preservedDuringFailure = preserved.mock.calls.length;
    expect(old.manager.isSessionOpen("r", "Note.md")).toBe(true);
    save.mockRestore();
    await old.manager.dispose();
    await fresh.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0, sha256: "survivor" }]);
    await fresh.manager.dispose();
    expect(result).toMatchObject({ message: "disk full" });
    expect(cacheAfterFailure).toEqual(cached);
    expect(preservedDuringFailure).toBe(0);
    expect(preserved).toHaveBeenCalledWith("r", "Note.md", "old cache UNIQUE HELD EDIT", "survivor");
  });

  it.each([false, true])("hands off a settled failed retirement to a later manager (repeated write failure: %s)", async (repeatedFailure) => {
    const adapter = new FakeDataAdapter();
    const oldStore = makeDocStore(adapter);
    const newStore = makeDocStore(adapter);
    const old = createHarness({}, oldStore);
    old.disk.set("r/Note.md", "old cached text");
    const session = await openFreshlyCreatedSession(old, "r", "Note.md");
    await oldStore.save("r", "Note.md", 0, Y.encodeStateAsUpdate(session.doc));
    const cached = await oldStore.load("r", "Note.md", 0);
    session.ytext.insert(session.ytext.length, " UNIQUE RETAINED EDIT");
    await old.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", pathCollision: true }]);
    const destroyed = vi.fn();
    session.doc.on("destroy", destroyed);
    const save = vi.spyOn(oldStore, "save");
    if (repeatedFailure) save.mockRejectedValue(new Error("disk full"));
    else save.mockRejectedValueOnce(new Error("disk full"));
    await expect(old.manager.dispose()).rejects.toThrow("disk full");
    const preserved = vi.fn(async () => undefined);
    const fresh = createHarness({ preserveRecoveredText: preserved }, newStore);
    const repair = () => fresh.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0, sha256: "survivor" }], ["Note.md"]);
    if (repeatedFailure) {
      await expect(repair()).rejects.toThrow("disk full");
      expect(preserved).not.toHaveBeenCalled();
      expect(await newStore.load("r", "Note.md", 0)).toEqual(cached);
      expect(destroyed).not.toHaveBeenCalled();
      await expect(fresh.manager.ensureSession("r", "NOTE.MD")).rejects.toMatchObject({ code: "PATH_COLLISION" });
      save.mockRestore();
    }
    await repair();
    expect(preserved).toHaveBeenCalledWith("r", "Note.md", "old cached text UNIQUE RETAINED EDIT", "survivor");
    expect(destroyed).toHaveBeenCalledOnce();
    expect(old.manager.isSessionOpen("r", "Note.md")).toBe(false);
    expect(await newStore.load("r", "Note.md", 0)).toBeNull();
    save.mockRestore();
    await old.manager.dispose();
    expect(await newStore.load("r", "Note.md", 0)).toBeNull();
    await fresh.manager.dispose();
  });

  it("invalidates a queued rename whose pending source open was retired by repair", async () => {
    const store = makeDocStore();
    const doc = new Y.Doc();
    doc.getText(CRDT_TEXT_KEY).insert(0, "ambiguous");
    await store.save("r", "Note.md", 0, Y.encodeStateAsUpdate(doc));
    const started = deferred();
    const gate = deferred();
    const h = createHarness({
      readDiskText: async () => { started.resolve(); await gate.promise; return "ambiguous"; },
      preserveRecoveredText: async () => undefined
    }, store);
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0 }]);
    const opening = h.manager.ensureSession("r", "Note.md");
    const opened = opening.then(() => "opened", (error: unknown) => error);
    await started.promise;
    const renaming = h.manager.renameSession("r", "Note.md", "Next.md");
    const result = renaming.then(() => "renamed", (error: unknown) => error);
    await Promise.resolve();
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", pathCollision: true }]);
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0, sha256: "survivor" }]);
    gate.resolve();
    expect(await opened).toMatchObject({ code: "SESSION_INVALIDATED" });
    await vi.waitFor(() => expect(h.sent.some((message) => message.type === "crdt_rename")).toBe(true), { timeout: 100, interval: 5 }).catch(() => undefined);
    const outbound = h.sent.filter((message) => message.type === "crdt_rename");
    if (outbound[0]) await ack(h, { type: "crdt_rejected", requestId: outbound[0].requestId, roomId: "r", relativePath: "Next.md", code: "PATH_COLLISION", message: "settle regression request" });
    const renameResult = await result;
    await h.manager.dispose();
    doc.destroy();
    expect(outbound).toEqual([]);
    expect(renameResult).toMatchObject({ code: "SESSION_INVALIDATED" });
  });

  it("invalidates an in-flight open even after quarantine and owner repair have cleared the pause", async () => {
    const store = makeDocStore();
    const oldDoc = new Y.Doc();
    oldDoc.getText(CRDT_TEXT_KEY).insert(0, "ALIEN");
    await store.save("r", "Note.md", 0, Y.encodeStateAsUpdate(oldDoc));
    const started = deferred();
    const gate = deferred();
    const preserved = vi.fn(async () => undefined);
    let firstRead = true;
    const h = createHarness({
      preserveRecoveredText: preserved,
      readDiskText: async () => {
        if (!firstRead) return null;
        firstRead = false;
        started.resolve();
        await gate.promise;
        return "ALIEN";
      }
    }, store);
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0 }]);
    const opening = h.manager.ensureSession("r", "Note.md");
    const result = opening.then(() => "opened", (error: unknown) => error);
    await started.promise;
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", pathCollision: true }]);
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0, sha256: "survivor" }]);
    expect(preserved).toHaveBeenCalledWith("r", "Note.md", "ALIEN", "survivor");
    expect(await store.load("r", "Note.md", 0)).toBeNull();
    gate.resolve();
    expect(await result).toMatchObject({ code: "SESSION_INVALIDATED" });
    const fresh = await h.manager.ensureSession("r", "Note.md");
    expect(h.manager.isSessionOpen("r", "Note.md")).toBe(true);
    h.manager.bindToEditor("r", "Note.md");
    const survivor = new Y.Doc();
    survivor.getText(CRDT_TEXT_KEY).insert(0, "SURVIVOR");
    await h.manager.handleServerMessage({ type: "remote_crdt_update", roomId: "r", relativePath: "Note.md", epoch: 0, update: Buffer.from(Y.encodeStateAsUpdate(survivor)).toString("base64"), updatedBy: { userId: "peer", displayName: "Peer" } });
    expect(fresh.ytext.toString()).toBe("SURVIVOR");
    oldDoc.destroy();
    survivor.destroy();
    await h.manager.dispose();
  });

  it("preserves exact cached aliases and the latest live text before local collision repair", async () => {
    const store = makeDocStore();
    const preserved = vi.fn(async () => undefined);
    const h = createHarness({ preserveRecoveredText: preserved }, store);
    h.disk.set("r/Café.md", "live text");
    const live = await openFreshlyCreatedSession(h, "r", "Café.md");
    live.ytext.insert(live.ytext.length, " pending edit");
    const old = new Y.Doc();
    old.getText(CRDT_TEXT_KEY).insert(0, "old epoch");
    await store.save("r", "Café.md", 2, Y.encodeStateAsUpdate(old), true);
    const alias = new Y.Doc();
    alias.getText(CRDT_TEXT_KEY).insert(0, "exact NFD alias");
    await store.save("r", "cafe\u0301.MD", 0, Y.encodeStateAsUpdate(alias));
    await h.manager.preserveLocalPathAliases("r", ["Café.md", "cafe\u0301.MD"]);
    expect(preserved).toHaveBeenCalledWith("r", "Café.md", "live text pending edit", null);
    expect(preserved).toHaveBeenCalledWith("r", "Café.md", "old epoch", null);
    expect(preserved).toHaveBeenCalledWith("r", "cafe\u0301.MD", "exact NFD alias", null);
    expect(await store.loadAllEpochs("r", "Café.md")).toEqual([]);
    expect(await store.loadAllEpochs("r", "cafe\u0301.MD")).toEqual([]);
    expect(h.manager.isSessionOpen("r", "Café.md")).toBe(false);
    old.destroy();
    alias.destroy();
    await h.manager.dispose();
  });

  it("keeps aliases, the live document and the pause when local preservation fails", async () => {
    const store = makeDocStore();
    const h = createHarness({ preserveRecoveredText: async () => { throw new Error("copy failed"); } }, store);
    h.disk.set("r/Note.md", "live unique text");
    const live = await openFreshlyCreatedSession(h, "r", "Note.md");
    await store.save("r", "Note.md", 0, Y.encodeStateAsUpdate(live.doc));
    await expect(h.manager.preserveLocalPathAliases("r", ["Note.md", "note.md"])).rejects.toThrow("copy failed");
    expect(await store.load("r", "Note.md", 0)).not.toBeNull();
    expect(h.manager.isSessionOpen("r", "Note.md")).toBe(true);
    expect(live.ytext.toString()).toBe("live unique text");
    await expect(h.manager.ensureSession("r", "NOTE.MD")).rejects.toMatchObject({ code: "PATH_COLLISION" });
    await h.manager.dispose();
  });

  it("persists unsaved quarantined text and retains paused caches when the room is unmounted", async () => {
    const store = makeDocStore();
    const h = createHarness({}, store);
    h.disk.set("r/Note.md", "local text");
    const session = await openFreshlyCreatedSession(h, "r", "Note.md");
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "note.md", crdtEpoch: 0, pathCollision: true }]);
    const prior = new Y.Doc();
    prior.getText(CRDT_TEXT_KEY).insert(0, "different prior epoch");
    await store.save("r", "Note.md", 2, Y.encodeStateAsUpdate(prior));
    session.ytext.insert(session.ytext.length, " unsaved edit");
    await h.manager.disposeRoom("r");
    const saved = await store.load("r", "Note.md", 0);
    expect(saved).not.toBeNull();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, saved!);
    expect(doc.getText(CRDT_TEXT_KEY).toString()).toBe("local text unsaved edit");
    expect(await store.load("r", "Note.md", 2)).not.toBeNull();
    expect(h.manager.isSessionOpen("r", "Note.md")).toBe(false);
    const restarted = createHarness({}, store);
    await restarted.manager.disposeRoom("r", ["note.md", "Note.md"]);
    expect(await store.load("r", "Note.md", 0)).not.toBeNull();
    h.manager.dispose();
    restarted.manager.dispose();
    doc.destroy();
    prior.destroy();
  });

  it("waits for an in-flight save and persists the latest blocked text before teardown", async () => {
    const store = makeDocStore();
    const save = store.save.bind(store);
    let finishSave!: () => void;
    const saving = new Promise<void>((resolve) => { finishSave = resolve; });
    vi.spyOn(store, "save").mockImplementation(async (...args) => { await saving; await save(...args); });
    const timers: Array<() => void> = [];
    const h = createHarness({ schedule: (fn) => { timers.push(fn); return timers.length; }, cancel: vi.fn() }, store);
    h.disk.set("r/Note.md", "local");
    const session = await openFreshlyCreatedSession(h, "r", "Note.md");
    session.ytext.insert(session.ytext.length, " queued");
    timers[0]!();
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0, pathCollision: true }]);
    session.ytext.insert(session.ytext.length, " latest");
    let disposed = false;
    const disposing = h.manager.disposeRoom("r").then(() => { disposed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(disposed).toBe(false);
    expect(h.manager.isSessionOpen("r", "Note.md")).toBe(true);
    finishSave();
    await disposing;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, (await store.load("r", "Note.md", 0))!);
    expect(doc.getText(CRDT_TEXT_KEY).toString()).toBe("local queued latest");
    doc.destroy();
    h.manager.dispose();
  });

  it("keeps a blocked session recoverable when saving it during unmount fails", async () => {
    const store = makeDocStore();
    const h = createHarness({}, store);
    h.disk.set("r/Note.md", "unique unsaved");
    const session = await openFreshlyCreatedSession(h, "r", "Note.md");
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "note.md", crdtEpoch: 0, pathCollision: true }]);
    const save = vi.spyOn(store, "save").mockRejectedValue(new Error("disk full"));
    await expect(h.manager.disposeRoom("r")).rejects.toThrow("disk full");
    expect(h.manager.isSessionOpen("r", "Note.md")).toBe(true);
    expect(session.ytext.toString()).toBe("unique unsaved");
    await expect(h.manager.ensureSession("r", "NOTE.MD")).rejects.toMatchObject({ code: "PATH_COLLISION" });
    save.mockRestore();
    await h.manager.dispose();
  });

  it("keeps the cache and path paused if no text-preservation callback is available", async () => {
    const store = makeDocStore();
    const doc = new Y.Doc();
    doc.getText(CRDT_TEXT_KEY).insert(0, "must keep");
    await store.save("r", "Note.md", 0, Y.encodeStateAsUpdate(doc));
    const h = createHarness({}, store);
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0, pathCollision: true }]);
    await expect(h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0, sha256: "survivor" }])).rejects.toThrow("preserv");
    expect(await store.load("r", "Note.md", 0)).not.toBeNull();
    await expect(h.manager.ensureSession("r", "NOTE.md")).rejects.toMatchObject({ code: "PATH_COLLISION" });
    h.manager.dispose();
    doc.destroy();
  });

  it("waits for an already running persisted write before removing the ambiguous cache", async () => {
    const store = makeDocStore();
    const save = store.save.bind(store);
    let finishSave!: () => void;
    const blockedSave = new Promise<void>((resolve) => { finishSave = resolve; });
    vi.spyOn(store, "save").mockImplementation(async (...args) => { await blockedSave; await save(...args); });
    const timers: Array<() => void> = [];
    const h = createHarness({ preserveRecoveredText: vi.fn(async () => undefined), schedule: (fn) => { timers.push(fn); return timers.length; }, cancel: vi.fn() }, store);
    h.disk.set("r/Note.md", "local text");
    const session = await openFreshlyCreatedSession(h, "r", "Note.md");
    session.ytext.insert(session.ytext.length, " saved edit");
    timers[0]!();
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0, pathCollision: true }]);
    let recovered = false;
    const recovery = h.manager.handleRoomSnapshot("r", [{ relativePath: "Note.md", crdtEpoch: 0, sha256: "survivor" }]).then(() => { recovered = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(recovered).toBe(false);
    finishSave();
    await recovery;
    expect(await store.load("r", "Note.md", 0)).toBeNull();
    h.manager.dispose();
  });

  it("preserves persisted aliases across restart before discarding every ambiguous epoch", async () => {
    const store = makeDocStore();
    const oldDoc = new Y.Doc();
    oldDoc.getText(CRDT_TEXT_KEY).insert(0, "unique old cache");
    await store.save("r", "Café.md", 2, Y.encodeStateAsUpdate(oldDoc));
    const sameEpochDoc = new Y.Doc();
    sameEpochDoc.getText(CRDT_TEXT_KEY).insert(0, "same epoch ambiguous");
    await store.save("r", "cafe\u0301.MD", 0, Y.encodeStateAsUpdate(sameEpochDoc));
    const preserved = vi.fn(async () => undefined);
    const h = createHarness({ preserveRecoveredText: preserved }, store);
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "cafe\u0301.MD", crdtEpoch: 0, sha256: "survivor" }], ["Café.md", "cafe\u0301.MD"]);
    expect(preserved).toHaveBeenCalledWith("r", "Café.md", "unique old cache", "survivor");
    expect(preserved).toHaveBeenCalledWith("r", "cafe\u0301.MD", "same epoch ambiguous", "survivor");
    expect(await store.load("r", "Café.md", 2)).toBeNull();
    expect(await store.load("r", "cafe\u0301.MD", 0)).toBeNull();
    const adopted = await h.manager.ensureSession("r", "CAFÉ.MD");
    expect(adopted.ytext.toString()).toBe("");
    h.manager.dispose();
    oldDoc.destroy();
    sameEpochDoc.destroy();
  });

  it("blocks edits and reconnect handshakes while recovery preservation is awaiting", async () => {
    let finish!: () => void;
    const preserving = new Promise<void>((resolve) => { finish = resolve; });
    const preserved = vi.fn(async () => preserving);
    const h = createHarness({ preserveRecoveredText: preserved });
    h.disk.set("r/Note.md", "ambiguous doc");
    const session = await openFreshlyCreatedSession(h, "r", "Note.md");
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "note.md", crdtEpoch: 0, pathCollision: true }]);
    const recovery = h.manager.handleRoomSnapshot("r", [{ relativePath: "note.md", crdtEpoch: 0, sha256: "survivor" }]);
    await vi.waitFor(() => expect(preserved).toHaveBeenCalled());
    const sentBefore = h.sent.length;
    session.ytext.insert(session.ytext.length, " extra edit");
    h.manager.onConnected();
    expect(h.sent).toHaveLength(sentBefore);
    await expect(h.manager.ensureSession("r", "NOTE.md")).rejects.toMatchObject({ code: "PATH_COLLISION" });
    finish();
    await recovery;
    expect(preserved).toHaveBeenCalledWith("r", "Note.md", "ambiguous doc extra edit", "survivor");
    h.manager.dispose();
  });

  it("preserves and retires an ambiguous doc before adopting a survivor with the same epoch", async () => {
    const preserved = vi.fn(async () => undefined);
    const h = createHarness({ preserveRecoveredText: preserved });
    h.disk.set("r/Note.md", "ambiguous doc");
    const old = await openFreshlyCreatedSession(h, "r", "Note.md");
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "note.md", crdtEpoch: 0, pathCollision: true }]);
    await h.manager.handleRoomSnapshot("r", [{ relativePath: "note.md", crdtEpoch: 0, sha256: "survivor" }]);
    const adopted = await h.manager.ensureSession("r", "NOTE.MD");
    expect(preserved).toHaveBeenCalledWith("r", "Note.md", "ambiguous doc", "survivor");
    expect(adopted).not.toBe(old);
    expect(adopted.ytext.toString()).toBe("");
    expect(adopted.relativePath).toBe("note.md");
    h.manager.dispose();
  });
});
