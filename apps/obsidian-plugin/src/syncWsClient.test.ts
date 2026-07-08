import { describe, expect, it } from "vitest";
import { RoomSyncSocket, type RoomSyncSocketDeps } from "./syncWsClient.js";
import { VaultSyncEngine, type MountedRoomState, type RelayFileApi, type VaultAdapter } from "./syncClient.js";
import type { ServerConnection } from "./settings.js";
import type { RelayApiClient } from "./apiClient.js";

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

  async readBinary(path: string): Promise<ArrayBuffer> {
    const content = this.files.get(path) ?? "";
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
  async readFile(roomId: string, relativePath: string): Promise<{ relativePath: string; version: number; sha256: string; content: string }> {
    return { relativePath, version: 6, sha256: "server-6", content: "# teammate edit\n" };
  }

  async writeFile(): Promise<{ ok: true; relativePath: string; version: number; sha256: string }> {
    throw new Error("not used in these tests");
  }

  async deleteFile(): Promise<{ ok: true; relativePath: string; version: number }> {
    throw new Error("not used in these tests");
  }
}

function createServer(): ServerConnection {
  return {
    id: "server_1",
    baseUrl: "http://localhost:8787",
    userId: "user_1",
    userDisplayName: "A laptop",
    deviceId: "device_1",
    deviceName: "A laptop",
    deviceToken: "token",
    isServerOwner: false,
    status: "active"
  };
}

function createRoom(): MountedRoomState {
  return {
    roomId: "room_1",
    mountPath: "Vault Rooms/demo/Projects Demo",
    files: {}
  };
}

describe("RoomSyncSocket.reconcileSnapshot", () => {
  it("does not resurrect a remote change over a path with a pending local delete (offline delete, teammate edit, reconnect)", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const engine = new VaultSyncEngine(vault, api);
    const room = createRoom();
    // File was synced at v5, then the device went offline and the user deleted it locally. The
    // delete push failed with a network error, so localDeleted is still true and the on-disk file
    // is already gone.
    room.files["Board.md"] = { serverVersion: 5, serverSha256: "server-5", localSha256: "server-5", dirty: false, localDeleted: true };

    let applied = false;
    const deps: RoomSyncSocketDeps = {
      getMountedRoom: () => room,
      getApi: () => api as unknown as RelayApiClient,
      syncEngine: engine,
      onApplied: () => {
        applied = true;
      },
      onRevoked: () => undefined,
      onRoomDeleted: () => undefined,
      onAccessRevoked: () => undefined
    };
    const socket = new RoomSyncSocket(createServer(), deps);

    // Teammate's edit landed on the server as v6 while this device was offline; reconnecting
    // delivers a room_snapshot reflecting that.
    await (socket as unknown as { handleMessage: (raw: string) => Promise<void> }).handleMessage(
      JSON.stringify({
        type: "room_snapshot",
        requestId: "req_1",
        roomId: "room_1",
        files: [{ relativePath: "Board.md", version: 6, sha256: "server-6", deleted: false }]
      })
    );

    // The pending local delete must not be silently overwritten by the teammate's remote content.
    expect(await vault.exists("Vault Rooms/demo/Projects Demo/Board.md")).toBe(false);
    expect(room.files["Board.md"]?.localDeleted).toBe(true);
    expect(applied).toBe(false);
  });
});
