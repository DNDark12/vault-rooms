import { describe, expect, it } from "vitest";
import { canonicalPathForConflictCopy, createConflictCopyPath, mountPathForRoom, VaultSyncEngine, type RelayFileApi, type VaultAdapter } from "./syncClient.js";

class FakeVaultAdapter implements VaultAdapter {
  files = new Map<string, string>();

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`Missing file: ${path}`);
    }
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  // Binary paths are stored as their base64 form, standing in for "raw bytes on disk" - real
  // callers only ever reach these through VaultSyncEngine's readContent/writeContent, never
  // read()/write(), for binary-eligible extensions.
  async readBinary(path: string): Promise<ArrayBuffer> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`Missing file: ${path}`);
    }
    const buffer = Buffer.from(content, "base64");
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, Buffer.from(data).toString("base64"));
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix));
  }

  onChange(): () => void {
    return () => undefined;
  }
}

class FakeApi implements RelayFileApi {
  writes: Array<{ roomId: string; relativePath: string; baseVersion: number; content: string }> = [];
  nextWrite:
    | { ok: true; relativePath: string; version: number; sha256: string }
    | { ok: false; code: "VERSION_CONFLICT"; serverVersion: number; serverSha256: string; serverContent: string } = {
    ok: true,
    relativePath: "Board.md",
    version: 2,
    sha256: "server-2"
  };

  async readFile(): Promise<{ relativePath: string; version: number; sha256: string; content: string }> {
    return { relativePath: "Board.md", version: 2, sha256: "server-2", content: "server" };
  }

  async writeFile(roomId: string, relativePath: string, baseVersion: number, content: string): Promise<{ ok: true; relativePath: string; version: number; sha256: string }> {
    this.writes.push({ roomId, relativePath, baseVersion, content });
    if (!this.nextWrite.ok) {
      const error = new Error("conflict") as Error & { code: string; serverVersion: number; serverSha256: string; serverContent: string };
      error.code = this.nextWrite.code;
      error.serverVersion = this.nextWrite.serverVersion;
      error.serverSha256 = this.nextWrite.serverSha256;
      error.serverContent = this.nextWrite.serverContent;
      throw error;
    }
    return this.nextWrite;
  }

  async deleteFile(roomId: string, relativePath: string, baseVersion: number): Promise<{ ok: true; relativePath: string; version: number }> {
    return { ok: true, relativePath, version: baseVersion + 1 };
  }
}

describe("plugin sync core", () => {
  it("computes member and owner mount paths", () => {
    expect(mountPathForRoom({ owner: false, mountRoot: "Vault Rooms", mountName: "Projects Demo", sourcePath: "Projects/Demo" })).toBe(
      "Vault Rooms/Projects Demo"
    );
    expect(mountPathForRoom({ owner: true, mountRoot: "Vault Rooms", mountName: "Projects Demo", sourcePath: "Projects/Demo" })).toBe(
      "Projects/Demo"
    );
  });

  it("creates collision-safe conflict copy paths", async () => {
    const vault = new FakeVaultAdapter();
    await vault.write("Vault Rooms/demo/Board (conflict B 2026-07-06T120000).md", "old");

    await expect(createConflictCopyPath(vault, "Vault Rooms/demo/Board.md", "B", new Date("2026-07-06T12:00:00Z"))).resolves.toBe(
      "Vault Rooms/demo/Board (conflict B 2026-07-06T120000) 2.md"
    );
  });

  it("applies remote changes cleanly and creates conflict copies for dirty local files", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const engine = new VaultSyncEngine(vault, api, () => new Date("2026-07-06T12:00:00Z"));
    const room = {
      roomId: "room_1",
      mountPath: "Vault Rooms/demo/Projects Demo",
      files: {
        "Board.md": { serverVersion: 1, serverSha256: "old", localSha256: await VaultSyncEngine.sha256("# Board\n"), dirty: false }
      }
    };
    await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# Board\n");

    await engine.applyRemoteChange(room, { relativePath: "Board.md", version: 2, sha256: "new", content: "# Board\nremote\n" }, "B laptop");
    expect(await vault.read("Vault Rooms/demo/Projects Demo/Board.md")).toBe("# Board\nremote\n");
    expect(room.files["Board.md"]).toMatchObject({ serverVersion: 2, serverSha256: "new", dirty: false });

    room.files["Board.md"] = { serverVersion: 2, serverSha256: "new", localSha256: "local", dirty: true };
    await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# local draft\n");
    await engine.applyRemoteChange(room, { relativePath: "Board.md", version: 3, sha256: "newer", content: "# server wins\n" }, "B laptop");
    expect(await vault.read("Vault Rooms/demo/Projects Demo/Board.md")).toBe("# server wins\n");
    expect(await vault.read("Vault Rooms/demo/Projects Demo/Board (conflict B laptop 2026-07-06T120000).md")).toBe("# local draft\n");
  });

  it("keeps dirty deleted files as conflict copies and deletes canonical file", async () => {
    const vault = new FakeVaultAdapter();
    const engine = new VaultSyncEngine(vault, new FakeApi(), () => new Date("2026-07-06T12:00:00Z"));
    const room = {
      roomId: "room_1",
      mountPath: "Vault Rooms/demo/Projects Demo",
      files: {
        "Board.md": { serverVersion: 2, serverSha256: "old", localSha256: "local", dirty: true }
      }
    };
    await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# dirty\n");

    await engine.applyRemoteDelete(room, { relativePath: "Board.md", version: 3 }, "B laptop");
    expect(await vault.exists("Vault Rooms/demo/Projects Demo/Board.md")).toBe(false);
    expect(await vault.read("Vault Rooms/demo/Projects Demo/Board (conflict B laptop 2026-07-06T120000).md")).toBe("# dirty\n");
    expect(room.files["Board.md"]).toMatchObject({ serverVersion: 3, dirty: false });
  });

  it("turns stale local pushes into conflict copies and restores server content", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    api.nextWrite = { ok: false, code: "VERSION_CONFLICT", serverVersion: 4, serverSha256: "server-4", serverContent: "# server\n" };
    const engine = new VaultSyncEngine(vault, api, () => new Date("2026-07-06T12:00:00Z"));
    const room = {
      roomId: "room_1",
      mountPath: "Vault Rooms/demo/Projects Demo",
      files: {
        "Board.md": { serverVersion: 3, serverSha256: "server-3", localSha256: "local", dirty: true }
      }
    };
    await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# local\n");

    await engine.pushLocalChange(room, "Board.md", "B laptop");

    expect(api.writes[0]).toMatchObject({ roomId: "room_1", relativePath: "Board.md", baseVersion: 3, content: "# local\n" });
    expect(await vault.read("Vault Rooms/demo/Projects Demo/Board.md")).toBe("# server\n");
    expect(await vault.read("Vault Rooms/demo/Projects Demo/Board (conflict B laptop 2026-07-06T120000).md")).toBe("# local\n");
    expect(room.files["Board.md"]).toMatchObject({ serverVersion: 4, serverSha256: "server-4", dirty: false });
  });

  it("round-trips binary files (e.g. images) as base64 instead of corrupting them", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const engine = new VaultSyncEngine(vault, api, () => new Date("2026-07-06T12:00:00Z"));
    const room = { roomId: "room_1", mountPath: "Vault Rooms/demo/Projects Demo", files: {} };
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xff]);
    await vault.writeBinary("Vault Rooms/demo/Projects Demo/cover.png", pngBytes.buffer);

    api.nextWrite = { ok: true, relativePath: "cover.png", version: 1, sha256: "png-1" };
    await engine.pushLocalChange(room, "cover.png", "B laptop");
    const pushedContent = api.writes[0]?.content;
    expect(pushedContent).toBe(Buffer.from(pngBytes).toString("base64"));

    await engine.applyRemoteChange(room, { relativePath: "cover.png", version: 2, sha256: "png-2", content: pushedContent! }, "B laptop");
    const roundTripped = new Uint8Array(await vault.readBinary("Vault Rooms/demo/Projects Demo/cover.png"));
    expect([...roundTripped]).toEqual([...pngBytes]);
  });

  it("derives the canonical path a conflict copy forked from", () => {
    expect(canonicalPathForConflictCopy("Vault Rooms/demo/Board (conflict B laptop 2026-07-06T120000).md")).toBe("Vault Rooms/demo/Board.md");
    expect(canonicalPathForConflictCopy("Vault Rooms/demo/Board (conflict B laptop 2026-07-06T120000) 2.md")).toBe("Vault Rooms/demo/Board.md");
    expect(canonicalPathForConflictCopy("Vault Rooms/demo/Board.md")).toBeNull();
  });

  it("resolves a conflict by keeping the local conflict copy and re-syncing it", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const engine = new VaultSyncEngine(vault, api, () => new Date("2026-07-06T12:00:00Z"));
    const room = {
      roomId: "room_1",
      mountPath: "Vault Rooms/demo/Projects Demo",
      files: { "Board.md": { serverVersion: 4, serverSha256: "server-4", localSha256: "server-4", dirty: false } }
    };
    await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# server wins\n");
    await vault.write("Vault Rooms/demo/Projects Demo/Board (conflict B laptop 2026-07-06T120000).md", "# my draft\n");
    api.nextWrite = { ok: true, relativePath: "Board.md", version: 5, sha256: "sha-mine" };

    await engine.resolveConflict(room, "Board.md", "Board (conflict B laptop 2026-07-06T120000).md", "mine", "B laptop");

    expect(await vault.read("Vault Rooms/demo/Projects Demo/Board.md")).toBe("# my draft\n");
    expect(await vault.exists("Vault Rooms/demo/Projects Demo/Board (conflict B laptop 2026-07-06T120000).md")).toBe(false);
    expect(api.writes[0]).toMatchObject({ relativePath: "Board.md", baseVersion: 4, content: "# my draft\n" });
    expect(room.files["Board.md"]).toMatchObject({ serverVersion: 5, serverSha256: "sha-mine" });
  });

  it("resolves a conflict by discarding the local conflict copy", async () => {
    const vault = new FakeVaultAdapter();
    const engine = new VaultSyncEngine(vault, new FakeApi(), () => new Date("2026-07-06T12:00:00Z"));
    const room = {
      roomId: "room_1",
      mountPath: "Vault Rooms/demo/Projects Demo",
      files: { "Board.md": { serverVersion: 4, serverSha256: "server-4", localSha256: "server-4", dirty: false } }
    };
    await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# server wins\n");
    await vault.write("Vault Rooms/demo/Projects Demo/Board (conflict B laptop 2026-07-06T120000).md", "# my draft\n");

    await engine.resolveConflict(room, "Board.md", "Board (conflict B laptop 2026-07-06T120000).md", "theirs", "B laptop");

    expect(await vault.read("Vault Rooms/demo/Projects Demo/Board.md")).toBe("# server wins\n");
    expect(await vault.exists("Vault Rooms/demo/Projects Demo/Board (conflict B laptop 2026-07-06T120000).md")).toBe(false);
  });

  it("reconcileLocalEdits marks a tracked file dirty when its on-disk content no longer matches what was last synced (e.g. edited while unmounted)", async () => {
    const vault = new FakeVaultAdapter();
    const engine = new VaultSyncEngine(vault, new FakeApi(), () => new Date("2026-07-06T12:00:00Z"));
    const room = {
      roomId: "room_1",
      mountPath: "Vault Rooms/demo/Projects Demo",
      files: {
        "Board.md": { serverVersion: 2, serverSha256: "server-2", localSha256: await VaultSyncEngine.sha256("# synced\n"), dirty: false },
        "Untouched.md": { serverVersion: 1, serverSha256: "server-1", localSha256: await VaultSyncEngine.sha256("# same\n"), dirty: false }
      }
    };
    await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# edited while unmounted\n");
    await vault.write("Vault Rooms/demo/Projects Demo/Untouched.md", "# same\n");

    await engine.reconcileLocalEdits(room);

    expect(room.files["Board.md"]?.dirty).toBe(true);
    expect(room.files["Untouched.md"]?.dirty).toBe(false);
  });

  it("reconcileLocalEdits leaves already-dirty files and missing local files untouched", async () => {
    const vault = new FakeVaultAdapter();
    const engine = new VaultSyncEngine(vault, new FakeApi(), () => new Date("2026-07-06T12:00:00Z"));
    const room = {
      roomId: "room_1",
      mountPath: "Vault Rooms/demo/Projects Demo",
      files: {
        "AlreadyDirty.md": { serverVersion: 1, serverSha256: "server-1", localSha256: "stale", dirty: true },
        "Missing.md": { serverVersion: 1, serverSha256: "server-1", localSha256: "stale", dirty: false }
      }
    };
    // Missing.md deliberately never written to the vault - simulates a file that no longer exists locally.

    await engine.reconcileLocalEdits(room);

    expect(room.files["AlreadyDirty.md"]?.dirty).toBe(true);
    expect(room.files["Missing.md"]?.dirty).toBe(false);
  });
});
