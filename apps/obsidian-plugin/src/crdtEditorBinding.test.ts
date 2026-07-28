// @vitest-environment jsdom
//
// Productionized continuation of the Phase 0.2 spike (crdtEditorBindingSpike.test.ts): proves the
// same yCollab-merge/undo-scoping mechanism works when the Y.Text comes from a real
// CrdtSessionManager session (not a bare hand-constructed Y.Doc), and separately unit-tests
// CrdtEditorController's per-view Compartment rebinding logic with fake EditorViews/resolvers,
// since Obsidian's real "which file is open" workspace-event wiring isn't testable without a real
// Obsidian runtime (see main.ts's wiring and the gap already recorded for Task 0.2 Step 3).

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import * as Y from "yjs";
import type { SyncClientMessage } from "@vault-rooms/protocol";
import { CrdtDocStore } from "./crdtDocStore.js";
import { CrdtEditorController, buildCrdtEditorExtension } from "./crdtEditorBinding.js";
import type { CrdtPresenceAdapter } from "./crdtPresence.js";
import { CrdtSessionManager } from "./crdtSession.js";

/**
 * These tests exercise content sync and undo scoping, not presence, but `buildCrdtEditorExtension` now
 * requires an Awareness-shaped adapter (passing null would disable remote cursor rendering entirely).
 * The facade only ever uses its view as a map key, so a throwaway token is sufficient here - the tests
 * that actually cover presence bind real views through CrdtEditorController.
 */
function presenceFor(session: { presence: { attachView: (view: EditorView) => CrdtPresenceAdapter } }): CrdtPresenceAdapter {
  return session.presence.attachView({} as unknown as EditorView);
}

(globalThis as unknown as { window: typeof globalThis }).window ??= globalThis;

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
  async rmdir(): Promise<void> {}
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    return { files: [...this.store.keys()].filter((key) => key.startsWith(prefix)), folders: [] };
  }
}

function makeManager(diskText = "", sent: SyncClientMessage[] = [], autoAckHandshake = true): CrdtSessionManager {
  const adapter = new FakeDataAdapter();
  const docStore = new CrdtDocStore(adapter as unknown as DataAdapter, "vault-rooms/crdt");
  let manager!: CrdtSessionManager;
  manager = new CrdtSessionManager({
    send: (message) => {
      sent.push(message);
      if (autoAckHandshake && message.type === "crdt_sync_step1") {
        window.setTimeout(() => {
          void manager.handleServerMessage({
            type: "crdt_sync_step2",
            requestId: message.requestId,
            roomId: message.roomId,
            relativePath: message.relativePath,
            epoch: message.epoch,
            update: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString("base64")
          });
        }, 0);
      }
    },
    docStore,
    isRoomCrdtEnabled: () => true,
    readDiskText: async () => diskText,
    writeDiskText: async () => undefined,
    renameDiskFile: async () => undefined
  });
  return manager;
}

/** Mirrors the real production wiring: `registerEditorExtension(compartment.of([]))` is registered
 *  once, globally, so *every* real CM6 instance Obsidian creates already has the controller's
 *  compartment present in its config from the start - later `compartment.reconfigure(...)` effects
 *  only work against a state that already includes the compartment. */
function editorViewWithCompartment(controller: CrdtEditorController): EditorView {
  return new EditorView({ state: EditorState.create({ doc: "", extensions: [controller.extension()] }) });
}

describe("buildCrdtEditorExtension (via a real CrdtSessionManager session)", () => {
  it("propagates a local edit through the session's Y.Doc into another peer's editor", async () => {
    const managerA = makeManager();
    const managerB = makeManager();
    managerA.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    managerB.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const sessionA = await managerA.ensureSession("room_1", "Board.md");
    const sessionB = await managerB.ensureSession("room_1", "Board.md");

    const RELAY_ORIGIN = Symbol("relay");
    sessionA.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== RELAY_ORIGIN) Y.applyUpdate(sessionB.doc, update, RELAY_ORIGIN);
    });
    sessionB.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== RELAY_ORIGIN) Y.applyUpdate(sessionA.doc, update, RELAY_ORIGIN);
    });

    const viewA = new EditorView({
      state: EditorState.create({ doc: "", extensions: [buildCrdtEditorExtension(sessionA.ytext, new Y.UndoManager(sessionA.ytext), presenceFor(sessionA))] })
    });
    const viewB = new EditorView({
      state: EditorState.create({ doc: "", extensions: [buildCrdtEditorExtension(sessionB.ytext, new Y.UndoManager(sessionB.ytext), presenceFor(sessionB))] })
    });

    const pos = viewA.state.doc.length;
    viewA.dispatch({ changes: { from: pos, to: pos, insert: "hello" } });

    expect(sessionA.ytext.toString()).toBe("hello");
    expect(sessionB.ytext.toString()).toBe("hello");
    expect(viewB.state.doc.toString()).toBe("hello");

    viewA.destroy();
    viewB.destroy();
  });

  it("scopes undo to the local peer's own edits without eating a remote edit", async () => {
    const managerA = makeManager();
    const managerB = makeManager();
    managerA.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    managerB.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const sessionA = await managerA.ensureSession("room_1", "Board.md");
    const sessionB = await managerB.ensureSession("room_1", "Board.md");
    const RELAY_ORIGIN = Symbol("relay");
    sessionA.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== RELAY_ORIGIN) Y.applyUpdate(sessionB.doc, update, RELAY_ORIGIN);
    });
    sessionB.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== RELAY_ORIGIN) Y.applyUpdate(sessionA.doc, update, RELAY_ORIGIN);
    });
    const undoManagerA = new Y.UndoManager(sessionA.ytext);
    const viewA = new EditorView({ state: EditorState.create({ doc: "", extensions: [buildCrdtEditorExtension(sessionA.ytext, undoManagerA, presenceFor(sessionA))] }) });
    const viewB = new EditorView({ state: EditorState.create({ doc: "", extensions: [buildCrdtEditorExtension(sessionB.ytext, new Y.UndoManager(sessionB.ytext), presenceFor(sessionB))] }) });

    viewA.dispatch({ changes: { from: 0, to: 0, insert: "X" } });
    viewB.dispatch({ changes: { from: viewB.state.doc.length, to: viewB.state.doc.length, insert: "Y" } });

    expect(sessionA.ytext.toString()).toBe("XY");
    const undone = undoManagerA.undo();
    expect(undone).not.toBeNull();
    expect(sessionA.ytext.toString()).toBe("Y");

    viewA.destroy();
    viewB.destroy();
  });
});

describe("CrdtEditorController.syncOpenViews", () => {
  it("binds a CRDT-eligible file's session to an open view via the shared compartment", async () => {
    const manager = makeManager();
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: (path) => (path === "Rooms/Demo/Board.md" ? { roomId: "room_1", relativePath: "Board.md" } : undefined)
    });
    const view = editorViewWithCompartment(controller);

    await controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Board.md", view }]);

    expect(manager.isSessionOpen("room_1", "Board.md")).toBe(true);
    // Proves the compartment now actually holds yCollab's binding (not the initial `[]`): typing
    // into the view lands in the session's Y.Text, not just the view's own local CM6 state.
    view.dispatch({ changes: { from: 0, to: 0, insert: "bound" } });
    expect(manager.isSessionOpen("room_1", "Board.md")).toBe(true);
    const session = await manager.ensureSession("room_1", "Board.md");
    expect(session.ytext.toString()).toBe("bound");
    view.destroy();
  });

  // Sixteenth hardware-testing round (2026-07-24): binding must ATTACH, never ALLOCATE. Obsidian moves
  // the open editor's file during a rename and can deliver that workspace event before the vault rename
  // event, so a creating bind pass allocated a fresh document at the rename's destination and the rename
  // arriving ~5ms later collided with it (crdt_create .450, crdt_rename .455, crdt_rejected FILE_EXISTS
  // .469 in a real WS trace). A document's existence is owned by the vault "create" event and the
  // server's snapshot - not by opening an editor.
  it("does not create a document for a path it knows no epoch for - it leaves the view unbound", async () => {
    const manager = makeManager();
    // Deliberately NO handleRoomSnapshot: this path is unknown to the client.
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: (path) => (path === "Rooms/Demo/Fresh.md" ? { roomId: "room_1", relativePath: "Fresh.md" } : undefined)
    });
    const view = editorViewWithCompartment(controller);

    await controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Fresh.md", view }]);

    expect(manager.isSessionOpen("room_1", "Fresh.md")).toBe(false);
    expect(controller.isBound(view)).toBe(false);

    // Once the document is established (as the vault "create" event does), the next pass binds it.
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Fresh.md", crdtEpoch: 0 }]);
    await controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Fresh.md", view }]);
    expect(manager.isSessionOpen("room_1", "Fresh.md")).toBe(true);
    expect(controller.isBound(view)).toBe(true);
    view.destroy();
  });

  it("unbinds when the same view's open file switches to a non-CRDT file, and rebinds when it switches to a different CRDT file", async () => {
    const manager = makeManager();
    manager.handleRoomSnapshot("room_1", [
      { relativePath: "Board.md", crdtEpoch: 0 },
      { relativePath: "Other.md", crdtEpoch: 0 }
    ]);
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: (path) => {
        if (path === "Rooms/Demo/Board.md") return { roomId: "room_1", relativePath: "Board.md" };
        if (path === "Rooms/Demo/Other.md") return { roomId: "room_1", relativePath: "Other.md" };
        return undefined;
      }
    });
    const view = editorViewWithCompartment(controller);

    await controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Board.md", view }]);
    expect(manager.isSessionOpen("room_1", "Board.md")).toBe(true);

    // Switch to a non-CRDT-eligible file in the same view (e.g. a plain vault note).
    await controller.syncOpenViews([{ vaultPath: "Rooms/Demo/plain.md", view }]);

    // Switch to a different CRDT file.
    await controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Other.md", view }]);
    expect(manager.isSessionOpen("room_1", "Other.md")).toBe(true);

    view.destroy();
  });

  it("does nothing when no views are open", async () => {
    const manager = makeManager();
    const controller = new CrdtEditorController({ getSessionManager: () => manager, resolveCrdtTarget: () => undefined });
    await expect(controller.syncOpenViews([])).resolves.toBeUndefined();
  });

  it("binds retroactively once the session manager becomes available for a view that was already open (startup race, bugs #1/#2)", async () => {
    // Reproduces the real 2-machine LAN test's startup race: Obsidian can auto-restore a
    // previously-open note (active-leaf-change/file-open firing) before main.ts's
    // connectSyncSocket() has constructed a CrdtSessionManager - getSessionManager() returns
    // undefined at that point. Without a retry, the file stays bound to plain CM6 forever (see
    // CLAUDE.md's post-hardware-testing audit notes); main.ts's fix re-runs the same reconcile once
    // the session manager is constructed.
    let manager: ReturnType<typeof makeManager> | undefined;
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: (path) => (path === "Rooms/Demo/Board.md" ? { roomId: "room_1", relativePath: "Board.md" } : undefined)
    });
    const view = editorViewWithCompartment(controller);

    // First pass: file is already open, but no session manager exists yet.
    await controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Board.md", view }]);
    expect(view.state.doc.toString()).toBe("");

    // Session manager gets constructed - main.ts re-runs the reconcile for the still-open view.
    manager = makeManager();
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    await controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Board.md", view }]);

    expect(manager.isSessionOpen("room_1", "Board.md")).toBe(true);
    view.dispatch({ changes: { from: 0, to: 0, insert: "bound" } });
    const session = await manager.ensureSession("room_1", "Board.md");
    expect(session.ytext.toString()).toBe("bound");

    view.destroy();
  });

  // Second-hardware-testing-round item 3: the multi-view reconcile is the new behavior this round
  // adds - every currently-open CRDT-eligible pane gets bound simultaneously, not just the focused
  // one. These four cases exercise syncOpenViews directly with more than one view, per the plan's
  // instruction to test the reconcile path itself rather than only the single-view convenience.
  it("(a) binds two different open views for two different CRDT targets simultaneously", async () => {
    const manager = makeManager();
    manager.handleRoomSnapshot("room_1", [
      { relativePath: "Board.md", crdtEpoch: 0 },
      { relativePath: "Other.md", crdtEpoch: 0 }
    ]);
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: (path) => {
        if (path === "Rooms/Demo/Board.md") return { roomId: "room_1", relativePath: "Board.md" };
        if (path === "Rooms/Demo/Other.md") return { roomId: "room_1", relativePath: "Other.md" };
        return undefined;
      }
    });
    const viewBoard = editorViewWithCompartment(controller);
    const viewOther = editorViewWithCompartment(controller);

    await controller.syncOpenViews([
      { vaultPath: "Rooms/Demo/Board.md", view: viewBoard },
      { vaultPath: "Rooms/Demo/Other.md", view: viewOther }
    ]);

    expect(manager.isSessionOpen("room_1", "Board.md")).toBe(true);
    expect(manager.isSessionOpen("room_1", "Other.md")).toBe(true);
    viewBoard.dispatch({ changes: { from: 0, to: 0, insert: "board-text" } });
    viewOther.dispatch({ changes: { from: 0, to: 0, insert: "other-text" } });
    const boardSession = await manager.ensureSession("room_1", "Board.md");
    const otherSession = await manager.ensureSession("room_1", "Other.md");
    expect(boardSession.ytext.toString()).toBe("board-text");
    expect(otherSession.ytext.toString()).toBe("other-text");

    viewBoard.destroy();
    viewOther.destroy();
  });

  it("(b) unbinds a previously-bound view that's no longer in the supplied open-set (pane closed)", async () => {
    const manager = makeManager();
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: (path) => (path === "Rooms/Demo/Board.md" ? { roomId: "room_1", relativePath: "Board.md" } : undefined)
    });
    const view = editorViewWithCompartment(controller);

    await controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Board.md", view }]);
    expect(manager.isSessionOpen("room_1", "Board.md")).toBe(true);
    const session = await manager.ensureSession("room_1", "Board.md");
    expect(session.boundToEditor).toBe(true);

    // The pane closed - the caller's next reconcile no longer includes this view at all.
    await controller.syncOpenViews([]);

    expect(session.boundToEditor).toBe(false);
    view.destroy();
  });

  it("(c) reconciling with the same open-set again does not rebuild an already-correctly-bound view", async () => {
    const manager = makeManager();
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: (path) => (path === "Rooms/Demo/Board.md" ? { roomId: "room_1", relativePath: "Board.md" } : undefined)
    });
    const view = editorViewWithCompartment(controller);
    const openViews = [{ vaultPath: "Rooms/Demo/Board.md", view }];

    await controller.syncOpenViews(openViews);
    const dispatchSpy = vi.spyOn(view, "dispatch");

    // Same open-set, called again (e.g. a layout-change firing for an unrelated pane split
    // elsewhere in the workspace) - must not tear down and recreate the working yCollab binding
    // (which would reset the view's Y.UndoManager/undo history for no reason).
    await controller.syncOpenViews(openViews);

    expect(dispatchSpy).not.toHaveBeenCalled();
    view.destroy();
  });

  it("(d) a view whose file changes from CRDT-target A to CRDT-target B unbinds A first, then binds B", async () => {
    const manager = makeManager();
    manager.handleRoomSnapshot("room_1", [
      { relativePath: "Board.md", crdtEpoch: 0 },
      { relativePath: "Other.md", crdtEpoch: 0 }
    ]);
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: (path) => {
        if (path === "Rooms/Demo/Board.md") return { roomId: "room_1", relativePath: "Board.md" };
        if (path === "Rooms/Demo/Other.md") return { roomId: "room_1", relativePath: "Other.md" };
        return undefined;
      }
    });
    const view = editorViewWithCompartment(controller);

    await controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Board.md", view }]);
    const boardSession = await manager.ensureSession("room_1", "Board.md");
    expect(boardSession.boundToEditor).toBe(true);

    await controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Other.md", view }]);

    expect(boardSession.boundToEditor).toBe(false);
    const otherSession = await manager.ensureSession("room_1", "Other.md");
    expect(otherSession.boundToEditor).toBe(true);

    view.destroy();
  });

  it("two panes bound to the same CRDT target (same underlying session/Y.Doc) both reflect a mutation made through either pane", async () => {
    // This is really just confirming yjs/y-codemirror.next's own convergence guarantee, but it's
    // worth a direct regression test given it's the crux of what the user actually asked for: two
    // people (or, as reproduced here, two open panes on the same device) looking at the same CRDT
    // note should both stay live, regardless of which one currently has focus.
    const manager = makeManager();
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: (path) => (path === "Rooms/Demo/Board.md" ? { roomId: "room_1", relativePath: "Board.md" } : undefined)
    });
    const viewOne = editorViewWithCompartment(controller);
    const viewTwo = editorViewWithCompartment(controller);

    // Both "panes" show the same file/session simultaneously.
    await controller.syncOpenViews([
      { vaultPath: "Rooms/Demo/Board.md", view: viewOne },
      { vaultPath: "Rooms/Demo/Board.md", view: viewTwo }
    ]);

    viewOne.dispatch({ changes: { from: 0, to: 0, insert: "from pane one" } });
    expect(viewTwo.state.doc.toString()).toBe("from pane one");

    const pos = viewTwo.state.doc.length;
    viewTwo.dispatch({ changes: { from: pos, to: pos, insert: " + from pane two" } });
    expect(viewOne.state.doc.toString()).toBe("from pane one + from pane two");

    const session = await manager.ensureSession("room_1", "Board.md");
    expect(session.ytext.toString()).toBe("from pane one + from pane two");

    viewOne.destroy();
    viewTwo.destroy();
  });

  it("unbindRoom retires only views belonging to that room", async () => {
    const manager = makeManager();
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    manager.handleRoomSnapshot("room_2", [{ relativePath: "Other.md", crdtEpoch: 0 }]);
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: (path) => {
        if (path === "Rooms/One/Board.md") return { roomId: "room_1", relativePath: "Board.md" };
        if (path === "Rooms/Two/Other.md") return { roomId: "room_2", relativePath: "Other.md" };
        return undefined;
      }
    });
    const roomOneView = editorViewWithCompartment(controller);
    const roomTwoView = editorViewWithCompartment(controller);
    await controller.syncOpenViews([
      { vaultPath: "Rooms/One/Board.md", view: roomOneView },
      { vaultPath: "Rooms/Two/Other.md", view: roomTwoView }
    ]);

    controller.unbindRoom("room_1");

    expect(controller.isBound(roomOneView)).toBe(false);
    expect(controller.isBound(roomTwoView)).toBe(true);
    expect((await manager.ensureSession("room_1", "Board.md")).boundToEditor).toBe(false);
    expect((await manager.ensureSession("room_2", "Other.md")).boundToEditor).toBe(true);

    roomOneView.destroy();
    roomTwoView.destroy();
  });

  it("rebinds the same view to a replacement Y.Doc without duplicating its existing text", async () => {
    let manager = makeManager();
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    await manager.ensureSession("room_1", "Board.md");
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: (path) => (path === "Rooms/Demo/Board.md" ? { roomId: "room_1", relativePath: "Board.md" } : undefined)
    });
    const view = editorViewWithCompartment(controller);
    await controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Board.md", view }]);
    view.dispatch({ changes: { from: 0, insert: "hello" } });
    expect(view.state.doc.toString()).toBe("hello");

    controller.unbindRoom("room_1");
    await manager.disposeRoom("room_1");
    const sent: SyncClientMessage[] = [];
    manager = makeManager("hello", sent, false);
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const binding = controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Board.md", view }]);
    await vi.waitFor(() => expect(sent.some((message) => message.type === "crdt_sync_step1")).toBe(true));
    const step1 = sent.find((message) => message.type === "crdt_sync_step1") as Extract<
      SyncClientMessage,
      { type: "crdt_sync_step1" }
    >;
    const serverDoc = new Y.Doc();
    serverDoc.getText("content").insert(0, "hello");
    await manager.handleServerMessage({
      type: "crdt_sync_step2",
      requestId: step1.requestId,
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 0,
      update: Buffer.from(Y.encodeStateAsUpdate(serverDoc)).toString("base64")
    });
    await binding;
    const replacement = await manager.ensureSession("room_1", "Board.md");

    expect(view.state.doc.toString()).toBe("hello");
    expect(replacement.ytext.toString()).toBe("hello");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } });

    expect(view.state.doc.toString()).toBe("hello!");
    expect(replacement.ytext.toString()).toBe("hello!");
    view.destroy();
  });

  it("awaits an existing in-flight bind when syncOpenViews is called again for the same target", async () => {
    const sent: SyncClientMessage[] = [];
    const manager = makeManager("", sent, false);
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: () => ({ roomId: "room_1", relativePath: "Board.md" })
    });
    const view = editorViewWithCompartment(controller);

    const first = controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Board.md", view }]);
    await vi.waitFor(() => expect(sent.some((message) => message.type === "crdt_sync_step1")).toBe(true));
    let secondResolved = false;
    const second = controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Board.md", view }]).then(() => {
      secondResolved = true;
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(secondResolved).toBe(false);

    const step1 = sent.find((message) => message.type === "crdt_sync_step1") as Extract<
      SyncClientMessage,
      { type: "crdt_sync_step1" }
    >;
    await manager.handleServerMessage({
      type: "crdt_sync_step2",
      requestId: step1.requestId,
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 0,
      update: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString("base64")
    });
    await Promise.all([first, second]);

    expect(secondResolved).toBe(true);
    expect(controller.isBound(view)).toBe(true);
    view.destroy();
  });

  it("retries the same target after an earlier binding attempt rejects", async () => {
    const manager = makeManager();
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const ensureSessionIfKnown = manager.ensureSessionIfKnown.bind(manager);
    vi.spyOn(manager, "ensureSessionIfKnown")
      .mockRejectedValueOnce(new Error("transient session-open failure"))
      .mockImplementation(ensureSessionIfKnown);
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: () => ({ roomId: "room_1", relativePath: "Board.md" })
    });
    const view = editorViewWithCompartment(controller);

    await expect(controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Board.md", view }])).rejects.toThrow(
      "transient session-open failure"
    );
    expect(controller.isBound(view)).toBe(false);

    await controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Board.md", view }]);

    expect(manager.ensureSessionIfKnown).toHaveBeenCalledTimes(2);
    expect(controller.isBound(view)).toBe(true);
    view.destroy();
  });

  it("does not leave a session marked editor-owned when applying the extension throws", async () => {
    const manager = makeManager();
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const session = await manager.ensureSession("room_1", "Board.md");
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: () => ({ roomId: "room_1", relativePath: "Board.md" })
    });
    const view = editorViewWithCompartment(controller);
    // Obsidian can destroy the view while the session is still opening; dispatching onto it then
    // throws *after* bindToEditor has already claimed the session.
    vi.spyOn(view, "dispatch").mockImplementationOnce(() => {
      throw new Error("Calling update on a destroyed view");
    });

    await expect(controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Board.md", view }])).rejects.toThrow(
      "Calling update on a destroyed view"
    );

    expect(controller.isBound(view)).toBe(false);
    // Left true, disk reconciliation for this path stays suppressed forever with no editor to justify it.
    expect(session.boundToEditor).toBe(false);
    view.destroy();
  });

  it("keeps a document editor-owned while a second pane showing it is still bound", async () => {
    const manager = makeManager();
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const session = await manager.ensureSession("room_1", "Board.md");
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: () => ({ roomId: "room_1", relativePath: "Board.md" })
    });
    const paneA = editorViewWithCompartment(controller);
    const paneB = editorViewWithCompartment(controller);

    await controller.syncOpenViews([
      { vaultPath: "Rooms/Demo/Board.md", view: paneA },
      { vaultPath: "Rooms/Demo/Board.md", view: paneB }
    ]);
    expect(session.boundToEditor).toBe(true);

    // Close one split. The other pane still has the note open, so its editor must remain the source
    // of truth - clearing the flag here would let a stale disk copy reconcile over its unsaved text.
    await controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Board.md", view: paneA }]);

    expect(controller.isBound(paneA)).toBe(true);
    expect(controller.isBound(paneB)).toBe(false);
    expect(session.boundToEditor).toBe(true);

    await controller.syncOpenViews([]);
    expect(session.boundToEditor).toBe(false);

    paneA.destroy();
    paneB.destroy();
  });
});

// Live cursors / note presence v1 (docs/superpowers/specs/2026-07-28-live-cursors-design.md).
// Covers the wiring between the presence adapter and the two lifecycles that own it: the editor
// binding (which pane holds which facade) and the session (which Y.Doc the facade belongs to).
describe("CrdtEditorController presence wiring", () => {
  it("passes a per-view adapter to yCollab so remote cursors render at all", async () => {
    const sent: SyncClientMessage[] = [];
    const manager = makeManager("", sent);
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const session = await manager.ensureSession("room_1", "Board.md");
    await session.initialSync;

    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: () => ({ roomId: "room_1", relativePath: "Board.md" })
    });
    const pane = editorViewWithCompartment(controller);
    await controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Board.md", view: pane }]);

    // yCollab only installs the remote-selection theme and ViewPlugin when awareness is truthy, so a
    // rendered caret element is the observable proof the adapter reached it.
    session.presence.applyRemote({
      type: "remote_presence",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 0,
      state: {
        clientId: 4242,
        user: { userId: "usr_peer", displayName: "Alice" },
        cursor: {
          yanchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(session.ytext, 0)),
          yhead: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(session.ytext, 0))
        }
      }
    });
    // Nudge the view so the ViewPlugin recomputes decorations.
    pane.dispatch({ changes: { from: 0, to: 0, insert: "hi" } });

    expect(pane.dom.querySelector(".cm-ySelectionCaret")).not.toBeNull();
    expect(pane.dom.querySelector(".cm-ySelectionInfo")?.textContent).toBe("Alice");

    pane.destroy();
  });

  it("gives two panes separate facades over one session presence store", async () => {
    const manager = makeManager();
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const session = await manager.ensureSession("room_1", "Board.md");
    await session.initialSync;
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: () => ({ roomId: "room_1", relativePath: "Board.md" })
    });
    const paneA = editorViewWithCompartment(controller);
    const paneB = editorViewWithCompartment(controller);

    await controller.syncOpenViews([
      { vaultPath: "Rooms/Demo/Board.md", view: paneA },
      { vaultPath: "Rooms/Demo/Board.md", view: paneB }
    ]);

    // Distinct facades, one shared store - the same shape as the per-pane Y.UndoManager.
    const facadeA = session.presence.attachView(paneA);
    const facadeB = session.presence.attachView(paneB);
    expect(facadeA).not.toBe(facadeB);
    expect(facadeA.doc).toBe(facadeB.doc);
    expect(facadeA.doc).toBe(session.doc);

    paneA.destroy();
    paneB.destroy();
  });

  it("keeps presence while one of two panes closes and retracts once after the last", async () => {
    const sent: SyncClientMessage[] = [];
    const manager = makeManager("", sent);
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const session = await manager.ensureSession("room_1", "Board.md");
    await session.initialSync;
    const controller = new CrdtEditorController({
      getSessionManager: () => manager,
      resolveCrdtTarget: () => ({ roomId: "room_1", relativePath: "Board.md" })
    });
    const paneA = editorViewWithCompartment(controller);
    const paneB = editorViewWithCompartment(controller);
    await controller.syncOpenViews([
      { vaultPath: "Rooms/Demo/Board.md", view: paneA },
      { vaultPath: "Rooms/Demo/Board.md", view: paneB }
    ]);

    // Both panes advertise a selection, as two focused panes on one note would.
    session.presence.attachView(paneA).setLocalStateField("cursor", {
      anchor: Y.createRelativePositionFromTypeIndex(session.ytext, 0),
      head: Y.createRelativePositionFromTypeIndex(session.ytext, 0)
    });
    session.presence.attachView(paneB).setLocalStateField("cursor", {
      anchor: Y.createRelativePositionFromTypeIndex(session.ytext, 0),
      head: Y.createRelativePositionFromTypeIndex(session.ytext, 0)
    });
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    const removalsBefore = sent.filter((message) => message.type === "presence_set" && message.cursor === null).length;

    await controller.syncOpenViews([{ vaultPath: "Rooms/Demo/Board.md", view: paneA }]);
    expect(sent.filter((message) => message.type === "presence_set" && message.cursor === null)).toHaveLength(
      removalsBefore
    );

    await controller.syncOpenViews([]);
    expect(sent.filter((message) => message.type === "presence_set" && message.cursor === null)).toHaveLength(
      removalsBefore + 1
    );

    paneA.destroy();
    paneB.destroy();
  });

  it("retracts presence when the session is torn down, before its Y.Doc is destroyed", async () => {
    const sent: SyncClientMessage[] = [];
    const manager = makeManager("", sent);
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const session = await manager.ensureSession("room_1", "Board.md");
    await session.initialSync;
    const clientId = session.doc.clientID;
    session.presence.attachView({} as unknown as EditorView).setLocalStateField("cursor", {
      anchor: Y.createRelativePositionFromTypeIndex(session.ytext, 0),
      head: Y.createRelativePositionFromTypeIndex(session.ytext, 0)
    });
    await new Promise((resolve) => window.setTimeout(resolve, 80));

    // disposeRoom runs the same teardownSession path as an epoch resync and a NOT_FOUND recovery -
    // the two places that replace the Y.Doc without an unmount, and so the likeliest ghost-cursor
    // source if the retraction is skipped or ordered after doc.destroy().
    await manager.disposeRoom("room_1");

    const removals = sent.filter((message) => message.type === "presence_set" && message.cursor === null);
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({ clientId, relativePath: "Board.md" });
  });

  it("does not let a presence message create or resurrect a session", async () => {
    const manager = makeManager();

    // Presence must never call ensureSession - a cursor for a document this device does not have open
    // would otherwise allocate one, which is how the CRDT lane historically created duplicates.
    await manager.handleServerMessage({
      type: "remote_presence",
      roomId: "room_1",
      relativePath: "Ghost.md",
      epoch: 0,
      state: { clientId: 1, user: { userId: "usr_a", displayName: "A" }, cursor: null }
    });

    expect(manager.isSessionOpen("room_1", "Ghost.md")).toBe(false);
  });

  it("keeps CRDT editing alive when a presence update is rejected", async () => {
    const sent: SyncClientMessage[] = [];
    const manager = makeManager("", sent);
    manager.handleRoomSnapshot("room_1", [{ relativePath: "Board.md", crdtEpoch: 0 }]);
    const session = await manager.ensureSession("room_1", "Board.md");
    await session.initialSync;

    await manager.handleServerMessage({
      type: "presence_rejected",
      roomId: "room_1",
      relativePath: "Board.md",
      code: "PERMISSION_DENIED",
      message: "no read access"
    });

    // The document session survives untouched and still accepts edits.
    expect(manager.isSessionOpen("room_1", "Board.md")).toBe(true);
    session.ytext.insert(0, "still editable");
    expect(session.ytext.toString()).toBe("still editable");
    expect(sent.some((message) => message.type === "crdt_update")).toBe(true);
  });
});
