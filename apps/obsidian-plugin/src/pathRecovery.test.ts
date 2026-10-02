import { describe, expect, it, vi } from "vitest";
import type { Plugin } from "obsidian";
import { RoomSyncSocket } from "./syncWsClient.js";
import { VaultSyncEngine, type MountedRoomState } from "./syncClient.js";
import { ObsidianVaultAdapter } from "./vaultAdapter.js";

function fixture(extension = "md") {
  const file = { path: `Room/Note.${extension}`, extension };
  const folder = { path: "Room", children: [file] };
  const files = new Map([[file.path, "initial quarantined text"]]);
  const vault = {
    getRoot: () => ({ path: "", children: [folder] }),
    getAbstractFileByPath: (path: string) => path === folder.path ? folder : folder.children.find(f => f.path === path) ?? null,
    read: async (f: typeof file) => files.get(f.path)!,
    readBinary: async (f: typeof file) => Uint8Array.from(Buffer.from(files.get(f.path)!, "base64")).buffer,
    process: async (f: typeof file, fn: (text: string) => string) => { files.set(f.path, fn(files.get(f.path)!)); },
    modifyBinary: async (f: typeof file, data: ArrayBuffer) => { files.set(f.path, Buffer.from(data).toString("base64")); },
    rename: vi.fn(async (f: typeof file, path: string) => { const data = files.get(f.path)!; files.delete(f.path); f.path = path; files.set(path, data); }),
    create: vi.fn(async (path: string, data: string) => { if (files.has(path)) throw new Error("Destination exists"); const f = { path, extension }; folder.children.push(f); files.set(path, data); return f; }),
    createBinary: vi.fn(async (path: string, data: ArrayBuffer) => vault.create(path, Buffer.from(data).toString("base64")))
  };
  const adapter = new ObsidianVaultAdapter({ app: { vault, fileManager: { trashFile: async (f: typeof file) => { files.delete(f.path); folder.children.splice(folder.children.indexOf(f), 1); } } } } as unknown as Plugin);
  const room: MountedRoomState = { roomId: "r", mountPath: "Room", canPushLocalEdits: true, pathCollisionKeys: [`note.${extension}`], files: {
    [`Note.${extension}`]: { serverVersion: 1, serverSha256: "old", localSha256: "old", dirty: true }
  } };
  return { file, files, vault, adapter, room };
}

describe("collision recovery replacement ownership", () => {
  it.each([undefined, 0])("preserves edits during a survivor download (CRDT epoch %s)", async (crdtEpoch) => {
    const { files, adapter, room } = fixture();
    let finishPull!: (result: unknown) => void;
    const api = { readFile: vi.fn(() => new Promise(resolve => { finishPull = resolve; })) };
    const socket = new RoomSyncSocket({ deviceName: "device" } as never, {
      getMountedRoom: () => room, getApi: () => api as never,
      syncEngine: new VaultSyncEngine(adapter, api as never),
      onApplied() {}, onRevoked() {}, onRoomDeleted() {}, onAccessRevoked() {}
    });
    const applying = (socket as unknown as { handleMessage(raw: string): Promise<void> }).handleMessage(JSON.stringify({
      type: "room_snapshot", roomId: "r", files: [{ relativePath: "note.md", version: 6, sha256: "server-6", deleted: false, crdtEpoch }]
    }));
    await vi.waitFor(() => expect(api.readFile).toHaveBeenCalled());
    const lateEdit = "edit made while downloading";
    files.set("Room/Note.md", lateEdit);
    finishPull({ relativePath: "note.md", version: 6, sha256: "server-6", content: "survivor" });
    await applying;
    expect([...files.values()]).toContain(lateEdit);
    expect(files.get("Room/Note.md")).toBe("survivor");
    expect(room.pathRecoveryKeys).toEqual([]);
  });

  it("preserves an edit at the final vault move, after the earlier copy", async () => {
    const { files, vault, adapter, room } = fixture();
    room.pathCollisionKeys = [];
    room.pathRecoveryKeys = ["note.md"];
    const engine = new VaultSyncEngine(adapter, {} as never);
    await engine.preserveRecoveredLocalFile(room, { relativePath: "note.md", sha256: "server" }, "device");
    const move = vault.rename.getMockImplementation()!;
    vault.rename.mockImplementation(async (file, path) => { files.set(file.path, "last instant edit"); await move(file, path); });
    await engine.applyRemoteChange(room, { relativePath: "note.md", version: 6, sha256: "server", content: "survivor" }, "device", true, true);
    expect([...files.values()]).toContain("last instant edit");
  });

  it("refuses to overwrite a file recreated during recovery", async () => {
    const { files, vault, adapter, room } = fixture();
    room.pathCollisionKeys = [];
    room.pathRecoveryKeys = ["note.md"];
    const engine = new VaultSyncEngine(adapter, {} as never);
    const move = vault.rename.getMockImplementation()!;
    vault.rename.mockImplementation(async (file, path) => { await move(file, path); files.set("Room/Note.md", "new file after move"); });
    await expect(engine.applyRemoteChange(room, { relativePath: "note.md", version: 6, sha256: "server", content: "survivor" }, "device", true, true)).rejects.toThrow();
    expect(files.get("Room/Note.md")).toBe("new file after move");
    expect([...files.values()]).toContain("initial quarantined text");
    expect(room.files["Note.md"]?.serverVersion).toBe(1);
  });

  it("preserves raw binary bytes and edits before a recovered deletion", async () => {
    const { files, adapter, room } = fixture("png");
    const bytes = "AP+Aqg==";
    files.set("Room/Note.png", bytes);
    room.pathCollisionKeys = [];
    room.pathRecoveryKeys = ["note.md"];
    const engine = new VaultSyncEngine(adapter, {} as never);
    await engine.preserveRecoveredLocalFile(room, { relativePath: "note.png", sha256: "server" }, "device");
    const laterBytes = "//8Aqg==";
    files.set("Room/Note.png", laterBytes);
    await engine.applyRemoteDelete(room, { relativePath: "note.png", version: 6 }, "device", true, true);
    expect([...files.values()]).toContain(laterBytes);
    expect(files.has("Room/Note.png")).toBe(false);
    expect(room.files["Note.png"]?.serverSha256).toBeNull();
  });
});

describe("preserving cached text under an ambiguous folder", () => {
  it("keeps a CRDT child at the unambiguous room root before exact-folder repair", async () => {
    const first = { path: "Room/Secret", children: [{ path: "Room/Secret/a.md", extension: "md" }] };
    const second = { path: "Room/secret", children: [{ path: "Room/secret/b.md", extension: "md" }] };
    const children: Array<typeof first | { path: string; extension: string }> = [first, second];
    const copies = new Map<string, string>();
    const vault = { getRoot: () => ({ path: "", children: [{ path: "Room", children }] }),
      create: async (path: string, text: string) => { children.push({ path, extension: "md" }); copies.set(path, text); } };
    const adapter = new ObsidianVaultAdapter({ app: { vault } } as unknown as Plugin);
    const engine = new VaultSyncEngine(adapter, {} as never);
    const room: MountedRoomState = { roomId: "r", mountPath: "Room", files: {} };
    await engine.preserveRecoveredText(room, "Secret/a.md", "unique cached first child", null, "device");
    await engine.preserveRecoveredText(room, "secret/b.md", "unique cached second child", null, "device");
    expect([...copies.values()]).toEqual(["unique cached first child", "unique cached second child"]);
    expect([...copies.keys()].every(path => path.split("/").length === 2)).toBe(true);
  });
});
