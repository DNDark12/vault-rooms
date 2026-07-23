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
import { CrdtDocStore } from "./crdtDocStore.js";
import { CrdtEditorController, buildCrdtEditorExtension } from "./crdtEditorBinding.js";
import { CrdtSessionManager } from "./crdtSession.js";

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

function makeManager(): CrdtSessionManager {
  const adapter = new FakeDataAdapter();
  const docStore = new CrdtDocStore(adapter as unknown as DataAdapter, "vault-rooms/crdt");
  return new CrdtSessionManager({
    send: () => undefined,
    docStore,
    isRoomCrdtEnabled: () => true,
    readDiskText: async () => "",
    writeDiskText: async () => undefined
  });
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
      state: EditorState.create({ doc: "", extensions: [buildCrdtEditorExtension(sessionA.ytext, new Y.UndoManager(sessionA.ytext))] })
    });
    const viewB = new EditorView({
      state: EditorState.create({ doc: "", extensions: [buildCrdtEditorExtension(sessionB.ytext, new Y.UndoManager(sessionB.ytext))] })
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
    const viewA = new EditorView({ state: EditorState.create({ doc: "", extensions: [buildCrdtEditorExtension(sessionA.ytext, undoManagerA)] }) });
    const viewB = new EditorView({ state: EditorState.create({ doc: "", extensions: [buildCrdtEditorExtension(sessionB.ytext, new Y.UndoManager(sessionB.ytext))] }) });

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
});
