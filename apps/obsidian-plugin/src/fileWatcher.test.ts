import { describe, expect, it } from "vitest";
import { classifyRenameEvent, isCrdtManagedLocalChange, isWatchableChange, registerMountedRoomWatcher } from "./fileWatcher.js";
import type { MountedRoomState, VaultAdapter, VaultChangeEvent } from "./syncClient.js";

const CONFIG_DIR = ".obsidian";

function createRoom(): MountedRoomState {
  return { roomId: "room_1", mountPath: "Vault Rooms/demo/Projects Demo", files: {} };
}

class FakeVaultAdapter implements VaultAdapter {
  private handlers: Array<(event: VaultChangeEvent) => void> = [];

  async read(): Promise<string> {
    return "";
  }
  async write(): Promise<void> {}
  async readBinary(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
  async writeBinary(): Promise<void> {}
  async delete(): Promise<void> {}
  async rename(): Promise<void> {}
  async exists(): Promise<boolean> {
    return false;
  }
  async list(): Promise<string[]> {
    return [];
  }
  onChange(cb: (event: VaultChangeEvent) => void): () => void {
    this.handlers.push(cb);
    return () => {
      this.handlers = this.handlers.filter((handler) => handler !== cb);
    };
  }
  emit(event: VaultChangeEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

describe("classifyRenameEvent", () => {
  const room = createRoom();

  it("classifies a rename where both old and new paths stay inside the mounted room", () => {
    expect(
      classifyRenameEvent("Vault Rooms/demo/Projects Demo/Old.md", "Vault Rooms/demo/Projects Demo/New.md", room, CONFIG_DIR)
    ).toEqual({ kind: "rename", oldRelativePath: "Old.md", relativePath: "New.md" });
  });

  it("classifies a move OUT of the room as a delete of the old relative path", () => {
    expect(
      classifyRenameEvent("Vault Rooms/demo/Projects Demo/Old.md", "Elsewhere/Old.md", room, CONFIG_DIR)
    ).toEqual({ kind: "delete", relativePath: "Old.md" });
  });

  it("classifies a move INTO the room as a create of the new relative path", () => {
    expect(
      classifyRenameEvent("Elsewhere/New.md", "Vault Rooms/demo/Projects Demo/New.md", room, CONFIG_DIR)
    ).toEqual({ kind: "create", relativePath: "New.md" });
  });

  it("ignores a rename entirely outside the room", () => {
    expect(classifyRenameEvent("Elsewhere/A.md", "Elsewhere/B.md", room, CONFIG_DIR)).toEqual({ kind: "ignore" });
  });

  it("excludes conflict-copy paths on either side", () => {
    const conflictPath = "Vault Rooms/demo/Projects Demo/Board (conflict B laptop 2026-07-06T120000).md";
    expect(classifyRenameEvent(conflictPath, "Vault Rooms/demo/Projects Demo/Board.md", room, CONFIG_DIR)).toEqual({
      kind: "create",
      relativePath: "Board.md"
    });
    expect(classifyRenameEvent("Vault Rooms/demo/Projects Demo/Board.md", conflictPath, room, CONFIG_DIR)).toEqual({
      kind: "delete",
      relativePath: "Board.md"
    });
  });

  it("ignores an ineligible file type renamed within the room", () => {
    expect(
      classifyRenameEvent("Vault Rooms/demo/Projects Demo/Old.exe", "Vault Rooms/demo/Projects Demo/New.exe", room, CONFIG_DIR)
    ).toEqual({ kind: "ignore" });
  });
});

describe("registerMountedRoomWatcher with rename events", () => {
  it("dispatches a rename inside the room as a delete of the old path plus a create of the new path", () => {
    const vault = new FakeVaultAdapter();
    const room = createRoom();
    const received: Array<{ type: string; relativePath: string }> = [];
    registerMountedRoomWatcher(
      vault,
      room,
      (event, relativePath) => {
        received.push({ type: event.type, relativePath });
      },
      CONFIG_DIR
    );

    vault.emit({ type: "rename", path: "Vault Rooms/demo/Projects Demo/New.md", oldPath: "Vault Rooms/demo/Projects Demo/Old.md" });

    expect(received).toEqual([
      { type: "delete", relativePath: "Old.md" },
      { type: "create", relativePath: "New.md" }
    ]);
  });

  it("[fourth hardware-testing round] attaches a RenameHint to both halves of an in-room rename, correlating them", () => {
    const vault = new FakeVaultAdapter();
    const room = createRoom();
    const received: Array<{ type: string; relativePath: string; renameHint?: unknown }> = [];
    registerMountedRoomWatcher(
      vault,
      room,
      (event, relativePath, renameHint) => {
        received.push({ type: event.type, relativePath, renameHint });
      },
      CONFIG_DIR
    );

    vault.emit({ type: "rename", path: "Vault Rooms/demo/Projects Demo/New.md", oldPath: "Vault Rooms/demo/Projects Demo/Old.md" });

    expect(received).toEqual([
      { type: "delete", relativePath: "Old.md", renameHint: { renamedToRelativePath: "New.md" } },
      { type: "create", relativePath: "New.md", renameHint: { renamedFromRelativePath: "Old.md" } }
    ]);
  });

  it("does not attach a RenameHint for a cross-boundary move (only a genuine in-room rename correlates)", () => {
    const vault = new FakeVaultAdapter();
    const room = createRoom();
    const received: Array<{ type: string; relativePath: string; renameHint?: unknown }> = [];
    registerMountedRoomWatcher(
      vault,
      room,
      (event, relativePath, renameHint) => {
        received.push({ type: event.type, relativePath, renameHint });
      },
      CONFIG_DIR
    );

    vault.emit({ type: "rename", path: "Elsewhere/Old.md", oldPath: "Vault Rooms/demo/Projects Demo/Old.md" });

    expect(received).toEqual([{ type: "delete", relativePath: "Old.md", renameHint: undefined }]);
  });

  it("dispatches a move out of the room as a plain delete", () => {
    const vault = new FakeVaultAdapter();
    const room = createRoom();
    const received: Array<{ type: string; relativePath: string }> = [];
    registerMountedRoomWatcher(
      vault,
      room,
      (event, relativePath) => {
        received.push({ type: event.type, relativePath });
      },
      CONFIG_DIR
    );

    vault.emit({ type: "rename", path: "Elsewhere/Old.md", oldPath: "Vault Rooms/demo/Projects Demo/Old.md" });

    expect(received).toEqual([{ type: "delete", relativePath: "Old.md" }]);
  });

  it("dispatches a move into the room as a plain create", () => {
    const vault = new FakeVaultAdapter();
    const room = createRoom();
    const received: Array<{ type: string; relativePath: string }> = [];
    registerMountedRoomWatcher(
      vault,
      room,
      (event, relativePath) => {
        received.push({ type: event.type, relativePath });
      },
      CONFIG_DIR
    );

    vault.emit({ type: "rename", path: "Vault Rooms/demo/Projects Demo/New.md", oldPath: "Elsewhere/New.md" });

    expect(received).toEqual([{ type: "create", relativePath: "New.md" }]);
  });

  it("still dispatches plain create/modify/delete events as before", () => {
    const vault = new FakeVaultAdapter();
    const room = createRoom();
    const received: Array<{ type: string; relativePath: string }> = [];
    registerMountedRoomWatcher(
      vault,
      room,
      (event, relativePath) => {
        received.push({ type: event.type, relativePath });
      },
      CONFIG_DIR
    );

    vault.emit({ type: "modify", path: "Vault Rooms/demo/Projects Demo/Board.md" });
    expect(received).toEqual([{ type: "modify", relativePath: "Board.md" }]);
  });
});

describe("isWatchableChange (unchanged behavior)", () => {
  it("still matches plain create/modify/delete events", () => {
    const room = createRoom();
    expect(isWatchableChange({ type: "modify", path: "Vault Rooms/demo/Projects Demo/Board.md" }, room, CONFIG_DIR)).toBe("Board.md");
  });
});

describe("isCrdtManagedLocalChange", () => {
  it("routes create/modify of a .md path in a CRDT-enabled room to the CRDT lane", () => {
    expect(isCrdtManagedLocalChange({ crdtEnabled: true }, "create", "Board.md")).toBe(true);
    expect(isCrdtManagedLocalChange({ crdtEnabled: true }, "modify", "Board.md")).toBe(true);
  });

  it("keeps delete on the CAS lane even in a CRDT-enabled room - there is no separate CRDT delete message", () => {
    expect(isCrdtManagedLocalChange({ crdtEnabled: true }, "delete", "Board.md")).toBe(false);
  });

  it("keeps non-CRDT-eligible paths (e.g. images, .canvas) on the CAS lane even in a CRDT-enabled room", () => {
    expect(isCrdtManagedLocalChange({ crdtEnabled: true }, "modify", "image.png")).toBe(false);
    expect(isCrdtManagedLocalChange({ crdtEnabled: true }, "modify", "board.canvas")).toBe(false);
  });

  it("keeps .md files on the CAS lane unchanged in a room that has not enabled CRDT (non-CRDT regression)", () => {
    expect(isCrdtManagedLocalChange({ crdtEnabled: false }, "create", "Board.md")).toBe(false);
    expect(isCrdtManagedLocalChange({ crdtEnabled: false }, "modify", "Board.md")).toBe(false);
  });
});
