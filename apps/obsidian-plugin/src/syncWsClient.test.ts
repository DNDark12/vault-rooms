import { afterEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { RoomSyncSocket, toWsUrl, type RoomSyncSocketDeps } from "./syncWsClient.js";
import { VaultSyncEngine, type MountedRoomState, type RelayFileApi, type VaultAdapter } from "./syncClient.js";
import type { ServerConnection } from "./settings.js";
import type { RelayApiClient } from "./apiClient.js";

(globalThis as unknown as { window: typeof globalThis }).window ??= globalThis;

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
    status: "active",
    securityMode: "plain"
  };
}

function createRoom(): MountedRoomState {
  return {
    roomId: "room_1",
    mountPath: "Vault Rooms/demo/Projects Demo",
    files: {}
  };
}

function createDeps(): RoomSyncSocketDeps {
  const vault = new FakeVaultAdapter();
  const api = new FakeApi();
  return {
    getMountedRoom: () => undefined,
    getApi: () => api as unknown as RelayApiClient,
    syncEngine: new VaultSyncEngine(vault, api),
    onApplied: () => undefined,
    onRevoked: () => undefined,
    onRoomDeleted: () => undefined,
    onAccessRevoked: () => undefined
  };
}

function stubWebSocket(): ReturnType<typeof vi.fn> {
  const WebSocketSpy = vi.fn(function (this: { readyState: number; addEventListener: () => void; close: () => void; send: () => void }, _url: string) {
    this.readyState = 0;
    this.addEventListener = vi.fn();
    this.close = vi.fn();
    this.send = vi.fn();
  });
  (WebSocketSpy as unknown as { OPEN: number }).OPEN = 1;
  vi.stubGlobal("WebSocket", WebSocketSpy);
  return WebSocketSpy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(requestUrl).mockReset();
});

describe("RoomSyncSocket health probe", () => {
  it("maps HTTPS relay URLs to WSS", () => {
    expect(toWsUrl("https://relay.example/base/")).toBe("wss://relay.example/base/sync");
  });

  it("schedules a reconnect without constructing a WebSocket when the health probe fails", async () => {
    const WebSocketSpy = stubWebSocket();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    vi.mocked(requestUrl).mockRejectedValue(new Error("offline"));
    const socket = new RoomSyncSocket(createServer(), createDeps());

    socket.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requestUrl).toHaveBeenCalledWith({ url: "http://localhost:8787/health", throw: false });
    expect(WebSocketSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    socket.disconnect();
  });

  it("constructs the WebSocket with the sync URL when the health probe succeeds", async () => {
    const WebSocketSpy = stubWebSocket();
    vi.mocked(requestUrl).mockResolvedValue({ status: 200 } as Awaited<ReturnType<typeof requestUrl>>);
    const socket = new RoomSyncSocket(createServer(), createDeps());

    socket.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(WebSocketSpy).toHaveBeenCalledWith("ws://localhost:8787/sync");
    socket.disconnect();
  });

  it("hard-stops the reconnect loop when pinned failure classification says stop", async () => {
    const server = { ...createServer(), baseUrl: "https://relay.example", securityMode: "pinned-tls" as const };
    const onPinnedTransportFailure = vi.fn().mockResolvedValue("stop");
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const socket = new RoomSyncSocket(server, { ...createDeps(), onPinnedTransportFailure });

    socket.connect();
    await new Promise((resolve) => setImmediate(resolve));

    expect(onPinnedTransportFailure).toHaveBeenCalledOnce();
    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(socket.getState()).toBe("offline");
  });
});

describe("RoomSyncSocket security messages", () => {
  it("reports security upgrades and successful pinned hello authentication", async () => {
    const onSecurityUpgradeAvailable = vi.fn();
    const onHelloOk = vi.fn();
    const socket = new RoomSyncSocket(createServer(), {
      ...createDeps(),
      onSecurityUpgradeAvailable,
      onHelloOk
    });

    await (socket as unknown as { handleMessage: (raw: string) => Promise<void> }).handleMessage(
      JSON.stringify({ type: "security_upgrade_available", httpsUrl: "https://relay", wssUrl: "wss://relay/sync" })
    );
    await (socket as unknown as { handleMessage: (raw: string) => Promise<void> }).handleMessage(
      JSON.stringify({ type: "hello_ok", requestId: "hello_1", device: { id: "dev_1" } })
    );

    expect(onSecurityUpgradeAvailable).toHaveBeenCalledOnce();
    expect(onHelloOk).toHaveBeenCalledOnce();
  });

  it("re-probes migration after a plain socket reconnects", async () => {
    let closeHandler: (() => void) | undefined;
    const WebSocketSpy = vi.fn(function (this: {
      readyState: number;
      addEventListener: (type: string, listener: () => void) => void;
      close: () => void;
      send: () => void;
    }) {
      this.readyState = 1;
      this.addEventListener = vi.fn((type: string, listener: () => void) => {
        if (type === "close") closeHandler = listener;
      });
      this.close = vi.fn();
      this.send = vi.fn();
    });
    (WebSocketSpy as unknown as { OPEN: number }).OPEN = 1;
    vi.stubGlobal("WebSocket", WebSocketSpy);
    vi.mocked(requestUrl).mockResolvedValue({ status: 200 } as Awaited<ReturnType<typeof requestUrl>>);
    const onSecurityUpgradeAvailable = vi.fn();
    const socket = new RoomSyncSocket(createServer(), {
      ...createDeps(),
      onSecurityUpgradeAvailable
    });
    const handleMessage = (socket as unknown as { handleMessage: (raw: string) => Promise<void> }).handleMessage.bind(socket);

    socket.connect();
    await new Promise((resolve) => setImmediate(resolve));
    await handleMessage(JSON.stringify({ type: "hello_ok", requestId: "hello_1" }));
    expect(onSecurityUpgradeAvailable).toHaveBeenCalledOnce();

    closeHandler?.();
    await handleMessage(JSON.stringify({ type: "hello_ok", requestId: "hello_2" }));
    expect(onSecurityUpgradeAvailable).toHaveBeenCalledTimes(2);
    socket.disconnect();
  });
});

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
