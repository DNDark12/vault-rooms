import { describe, expect, it } from "vitest";
import { createConflictCopyPath, mountPathForRoom, VaultSyncEngine, type RelayFileApi, type VaultAdapter } from "./syncClient.js";

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

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix));
  }

  onChange(): void {
    return undefined;
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

  async deleteFile(): Promise<void> {
    return undefined;
  }
}

describe("plugin sync core", () => {
  it("computes member and owner mount paths", () => {
    expect(mountPathForRoom({ owner: false, mountRoot: "Vault Rooms", teamSlug: "demo", mountName: "Projects Demo", sourcePath: "Projects/Demo" })).toBe(
      "Vault Rooms/demo/Projects Demo"
    );
    expect(mountPathForRoom({ owner: true, mountRoot: "Vault Rooms", teamSlug: "demo", mountName: "Projects Demo", sourcePath: "Projects/Demo" })).toBe(
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
});
