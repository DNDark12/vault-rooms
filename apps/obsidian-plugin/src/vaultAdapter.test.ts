import { describe, expect, it, vi } from "vitest";
import type { Plugin } from "obsidian";
import { ObsidianVaultAdapter } from "./vaultAdapter.js";

function adapterOver(bytes: Uint8Array, decoded: string): ObsidianVaultAdapter {
  const file = { path: "Room/export.csv", extension: "csv" };
  const vault = {
    getRoot: () => ({ path: "", children: [{ path: "Room", children: [file] }] }),
    getAbstractFileByPath: (path: string) => (path === file.path ? file : null),
    readBinary: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    read: async () => decoded
  };
  return new ObsidianVaultAdapter({ app: { vault } } as unknown as Plugin);
}

describe("ObsidianVaultAdapter.readStrictUtf8", () => {
  it("returns UTF-8 text unchanged", async () => {
    const adapter = adapterOver(new TextEncoder().encode("name\ncafé"), "name\ncafé");

    await expect(adapter.readStrictUtf8("Room/export.csv")).resolves.toBe("name\ncafé");
  });

  it("refuses a file in another encoding rather than returning replacement characters", async () => {
    // "café" saved as Windows-1252.
    const adapter = adapterOver(new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x63, 0x61, 0x66, 0xe9]), "name\ncaf�");

    await expect(adapter.readStrictUtf8("Room/export.csv")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});


describe("ObsidianVaultAdapter.rename portable identity", () => {
  it("renames the same file returned for a case-insensitive destination", async () => {
    const file = { path: "Room/Note.md", extension: "md" };
    const renameFile = vi.fn(async (_file, path: string) => { file.path = path; });
    const vault = {
      getRoot: () => ({ path: "", children: [{ path: "Room", children: [file] }] }),
      getAbstractFileByPath: (path: string) => path === "Room" ? { path: "Room" } : path.toLowerCase() === file.path.toLowerCase() ? file : null
    };
    const adapter = new ObsidianVaultAdapter({ app: { vault, fileManager: { renameFile } } } as unknown as Plugin);
    await adapter.rename("Room/Note.md", "Room/note.md");
    expect(renameFile).toHaveBeenCalledWith(file, "Room/note.md");
    expect(file.path).toBe("Room/note.md");
  });
});

describe("ObsidianVaultAdapter exact cache with portable children", () => {
  function fixture(ambiguous = false) {
    const file = { path: "Room/Café/note.md", extension: "md" };
    const folder = { path: "Room/Café", children: [file] };
    const room = { path: "Room", children: [folder] };
    const root = { path: "", children: [room] };
    if (ambiguous) folder.children.push({ path: "Room/Café/NOTE.MD", extension: "md" });
    const vault = {
      getRoot: () => root,
      getAbstractFileByPath: (path: string) => [room, folder, ...folder.children].find((entry) => entry.path === path) ?? null,
      read: vi.fn(async () => "local text"),
      readBinary: vi.fn(async () => new TextEncoder().encode("local text").buffer),
      process: vi.fn(async () => undefined),
      modifyBinary: vi.fn(async () => undefined),
      create: vi.fn(async () => undefined),
      createBinary: vi.fn(async () => undefined),
      createFolder: vi.fn(async () => undefined)
    };
    const renameFile = vi.fn(async (_file, path: string) => { file.path = path; });
    const trashFile = vi.fn(async () => undefined);
    const adapter = new ObsidianVaultAdapter({ app: { vault, fileManager: { renameFile, trashFile } } } as unknown as Plugin);
    return { adapter, vault, file, renameFile, trashFile };
  }

  it("reads and updates a unique alias when the exact cache misses", async () => {
    const { adapter, vault, file } = fixture();
    const alias = "room/cafe\u0301/NOTE.MD";
    await expect(adapter.exists(alias)).resolves.toBe(true);
    await expect(adapter.read(alias)).resolves.toBe("local text");
    await adapter.readBinary(alias);
    await adapter.readStrictUtf8(alias);
    await adapter.write(alias, "remote text");
    await adapter.writeBinary(alias, new ArrayBuffer(0));
    expect(vault.process).toHaveBeenCalledWith(file, expect.any(Function));
    expect(vault.modifyBinary).toHaveBeenCalledWith(file, expect.any(ArrayBuffer));
    expect(vault.create).not.toHaveBeenCalled();
    expect(vault.createBinary).not.toHaveBeenCalled();
    await expect(adapter.list("ROOM/CAFE\u0301")).resolves.toEqual([file.path]);
  });

  it("renames the same child across aliases and uses the existing parent's spelling", async () => {
    const { adapter, file, vault, renameFile } = fixture();
    await adapter.rename("room/cafe\u0301/NOTE.MD", "ROOM/CAFÉ/Note.md");
    expect(renameFile).toHaveBeenCalledWith(file, "Room/Café/Note.md");
    expect(vault.createFolder).not.toHaveBeenCalled();
    await adapter.write("room/cafe\u0301/new.md", "new");
    expect(vault.create).toHaveBeenCalledWith("Room/Café/new.md", "new");
  });

  it("rejects ambiguous siblings even for an exact cache hit without choosing a winner", async () => {
    const { adapter, vault, renameFile, trashFile } = fixture(true);
    const path = "Room/Café/note.md";
    await expect(adapter.read(path)).rejects.toMatchObject({ code: "PATH_COLLISION" });
    await expect(adapter.write(path, "remote")).rejects.toMatchObject({ code: "PATH_COLLISION" });
    await expect(adapter.rename(path, "Room/Café/next.md")).rejects.toMatchObject({ code: "PATH_COLLISION" });
    await expect(adapter.delete(path)).rejects.toMatchObject({ code: "PATH_COLLISION" });
    expect(vault.process).not.toHaveBeenCalled();
    expect(renameFile).not.toHaveBeenCalled();
    expect(trashFile).not.toHaveBeenCalled();
  });
});
