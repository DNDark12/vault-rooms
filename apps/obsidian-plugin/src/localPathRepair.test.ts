import { describe, expect, it, vi } from "vitest";
import { CrdtOperationJournal } from "./crdtOperationJournal.js";
import { VaultSyncEngine, isMountedPathBlocked, type MountedRoomState, type VaultAdapter } from "./syncClient.js";

function fixture() {
  const files = new Map([["Room/Note.md", "first edit"], ["Room/note.md", "second edit"]]);
  const vault = {
    list: async () => [...files.keys()], exists: async (path: string) => files.has(path),
    renameExact: async (old: string, next: string) => { if (!files.has(old) || files.has(next)) throw new Error("Invalid exact move"); files.set(next, files.get(old)!); files.delete(old); }
  } as unknown as VaultAdapter;
  const room: MountedRoomState = { roomId: "r", mountPath: "Room", canPushLocalEdits: true, files: {
    "Note.md": { serverVersion: 1, serverSha256: "first", localSha256: "first", dirty: true },
    "note.md": { serverVersion: 2, serverSha256: "second", localSha256: "second", dirty: true }
  } };
  const persist = vi.fn(async () => undefined);
  const preserveCrdt = vi.fn(async (_paths: string[]) => undefined);
  return { room, files, engine: new VaultSyncEngine(vault, {} as never), persist, preserveCrdt };
}

describe("explicit local path repair", () => {
  it("discovers disk-only aliases and pauses them without choosing a winner", async () => {
    const { engine, room } = fixture();
    room.files = {};
    expect(await engine.listLocalPathCollisions(room)).toEqual([{ key: "note.md", paths: ["Note.md", "note.md"] }]);
    expect(isMountedPathBlocked(room, "NOTE.md")).toBe(true);
  });

  it("preserves all cache aliases before moving the selected exact file and retaining recovery history", async () => {
    const { engine, room, files, persist, preserveCrdt } = fixture();
    await engine.repairLocalPathCollision(room, "note.md", "second-note.md", { persist, preserveCrdt });
    expect(preserveCrdt).toHaveBeenCalledWith(expect.arrayContaining(["Note.md", "note.md"]));
    expect(files.get("Room/Note.md")).toBe("first edit");
    expect(files.get("Room/second-note.md")).toBe("second edit");
    expect(room.files["second-note.md"]).toMatchObject({ dirty: true, serverSha256: null, serverVersion: 0 });
    expect(room.pathRepairBackups?.[0]?.files["note.md"]?.serverVersion).toBe(2);
    expect(isMountedPathBlocked(room, "Note.md")).toBe(true);
    expect(isMountedPathBlocked(room, "second-note.md")).toBe(false);
  });

  it("refuses a new spelling of the same identity or occupied destination", async () => {
    const { engine, room, files, persist, preserveCrdt } = fixture();
    await expect(engine.repairLocalPathCollision(room, "note.md", "NOTE.MD", { persist, preserveCrdt })).rejects.toThrow();
    files.set("Room/occupied.md", "unrelated");
    await expect(engine.repairLocalPathCollision(room, "note.md", "occupied.md", { persist, preserveCrdt })).rejects.toThrow();
    expect(files.get("Room/note.md")).toBe("second edit");
    expect(preserveCrdt).not.toHaveBeenCalled();
  });

  it("does not move a file when cache preservation or history persistence fails", async () => {
    const { engine, room, files, persist, preserveCrdt } = fixture();
    preserveCrdt.mockRejectedValueOnce(new Error("cache copy failed"));
    await expect(engine.repairLocalPathCollision(room, "note.md", "next.md", { persist, preserveCrdt })).rejects.toThrow("cache copy failed");
    expect(files.get("Room/note.md")).toBe("second edit");
    persist.mockRejectedValueOnce(new Error("settings failed"));
    await expect(engine.repairLocalPathCollision(room, "note.md", "next.md", { persist, preserveCrdt })).rejects.toThrow("settings failed");
    expect(files.get("Room/note.md")).toBe("second edit");
    expect(isMountedPathBlocked(room, "note.md")).toBe(true);
  });

  it("requires explicit abandonment before changing a path with uncertain structural intent", async () => {
    const { engine, room, files, persist, preserveCrdt } = fixture();
    room.pendingCrdtOperations = [{ kind: "rename", operationId: "op", oldRelativePath: "Note.md", relativePath: "offline.md", queuedAt: "now", attemptedAt: "now" }];
    await expect(engine.repairLocalPathCollision(room, "note.md", "next.md", { persist, preserveCrdt })).rejects.toThrow(/intent/i);
    expect(files.get("Room/note.md")).toBe("second edit");
    expect(room.pendingCrdtOperations).toHaveLength(1);
  });

  it("archives every connected journal intent before removing it, and pauses authoritative reload", async () => {
    const { engine, room, files, preserveCrdt } = fixture();
    room.pendingCrdtOperations = [
      { kind: "rename", operationId: "one", oldRelativePath: "Note.md", relativePath: "offline.md", queuedAt: "now", attemptedAt: "now" },
      { kind: "rename", operationId: "two", oldRelativePath: "offline.md", relativePath: "final.md", queuedAt: "now" }
    ];
    const images: MountedRoomState[] = [];
    await engine.abandonAmbiguousLocalPathIntents(room, "note.md", { preserveCrdt, persist: async () => { images.push(JSON.parse(JSON.stringify(room))); } });
    expect(preserveCrdt).toHaveBeenCalledWith(expect.arrayContaining(["Note.md", "note.md", "offline.md", "final.md"]));
    expect(images.some(image => image.pathRepairBackups?.[0]?.operations.length === 2 && image.pendingCrdtOperations?.length === 2)).toBe(true);
    expect(room.pendingCrdtOperations).toEqual([]);
    expect(room.pathRepairBackups?.[0]?.operations.map(op => op.operationId)).toEqual(["one", "two"]);
    expect(room.pathRecoveryKeys).toEqual(expect.arrayContaining(["note.md", "offline.md", "final.md"]));
    expect([...files.values()]).toEqual(["first edit", "second edit"]);
  });
});

describe("local folder identity repair", () => {
  it("pauses descendants and remaps every selected-folder file without deleting the other alias", async () => {
    const files = new Map([["Room/Secret/a.md", "first"], ["Room/secret/b.md", "second"]]);
    const vault = {
      pathCollisions: () => files.has("Room/Secret/a.md") ? [{ key: "secret", paths: ["Secret", "secret"] }] : [],
      list: async () => [...files.keys()], exists: async (path: string) => files.has(path),
      renameExact: async (old: string, next: string) => { for (const [path, text] of [...files]) if (path.startsWith(old + "/")) { files.delete(path); files.set(next + path.slice(old.length), text); } }
    } as unknown as VaultAdapter;
    const room: MountedRoomState = { roomId: "r", mountPath: "Room", files: {
      "Secret/a.md": { serverVersion: 1, serverSha256: "one", localSha256: "one", dirty: true },
      "secret/b.md": { serverVersion: 1, serverSha256: "two", localSha256: "two", dirty: true }
    } };
    const engine = new VaultSyncEngine(vault, {} as never);
    engine.scanLocalPathCollisions(room);
    expect(isMountedPathBlocked(room, "SECRET/b.md")).toBe(true);
    const preserveCrdt = vi.fn(async (_paths: string[]) => undefined);
    await engine.repairLocalPathCollision(room, "Secret", "Distinct", { preserveCrdt, persist: async () => undefined });
    expect(preserveCrdt).toHaveBeenCalledWith(expect.arrayContaining(["Secret/a.md", "secret/b.md"]));
    expect(files.get("Room/Distinct/a.md")).toBe("first");
    expect(files.get("Room/secret/b.md")).toBe("second");
    expect(room.files["Distinct/a.md"]).toMatchObject({ dirty: true, serverSha256: null });
    expect(room.pathRecoveryKeys).toEqual(expect.arrayContaining(["secret/a.md", "secret/b.md"]));
  });
});


describe("local intent retirement failure", () => {
  it("keeps an unrelated create and text edit queued during the final failed save", async () => {
    const { engine, room, preserveCrdt } = fixture();
    room.pendingCrdtOperations = [{ kind: "rename", operationId: "ambiguous", oldRelativePath: "Note.md", relativePath: "offline.md", queuedAt: "now", attemptedAt: "now" }];
    room.pendingCrdtTextPaths = ["Note.md"];
    const journal = new CrdtOperationJournal({ getRoom: () => room, persist: async () => undefined, canReplay: () => false, createOperationId: () => "unrelated-create" } as never);
    let count = 0;
    await expect(engine.abandonAmbiguousLocalPathIntents(room, "note.md", { preserveCrdt, persist: async () => {
      if (++count === 3) {
        await journal.recordCreate("r", "Unrelated.md");
        (room.pendingCrdtTextPaths ??= []).push("Unrelated.md");
        throw new Error("settings save failed");
      }
    } })).rejects.toThrow("settings save failed");
    expect(room.pendingCrdtOperations?.map(operation => operation.operationId)).toEqual(["ambiguous", "unrelated-create"]);
    expect(room.pendingCrdtTextPaths).toEqual(expect.arrayContaining(["Note.md", "Unrelated.md"]));
  });
});

describe("manual local alias changes", () => {
  it("keeps prior identity quarantined until explicit preservation even after a disk rename removes the collision", async () => {
    const { engine, room, files, persist, preserveCrdt } = fixture();
    room.files = {};
    await engine.listLocalPathCollisions(room);
    files.set("Room/distinct.md", files.get("Room/note.md")!);
    files.delete("Room/note.md");
    await engine.listLocalPathCollisions(room);
    expect(isMountedPathBlocked(room, "Note.md")).toBe(true);
    await engine.abandonAmbiguousLocalPathIntents(room, "note.md", { preserveCrdt, persist });
    expect(room.pathLocalCollisionKeys).toEqual([]);
    expect(room.pathRecoveryKeys).toContain("note.md");
    expect(files.get("Room/distinct.md")).toBe("second edit");
  });
});
