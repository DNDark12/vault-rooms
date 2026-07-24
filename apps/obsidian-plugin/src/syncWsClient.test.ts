import { afterEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { RoomSyncSocket, toWsUrl, type RoomSyncSocketDeps } from "./syncWsClient.js";
import { VaultSyncEngine, type MountedRoomState, type RelayFileApi, type VaultAdapter } from "./syncClient.js";
import type { ServerConnection } from "./settings.js";
import type { RelayApiClient } from "./apiClient.js";
import type { CrdtWsBridge } from "./crdtSession.js";

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

  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = this.files.get(oldPath);
    if (content === undefined) return;
    this.files.delete(oldPath);
    this.files.set(newPath, content);
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

/** Minimal CrdtWsBridge test double - the remote_file_change gating tests below only need
 *  isSessionOpen() to return a fixed answer; the other three methods are never exercised there. */
class FakeCrdtBridge implements CrdtWsBridge {
  constructor(private readonly sessionOpen: boolean) {}

  async handleServerMessage(): Promise<void> {}

  handleRoomSnapshot(): void {}

  onConnected(): void {}

  isSessionOpen(): boolean {
    return this.sessionOpen;
  }
}

type SocketEvent = "open" | "message" | "close" | "error";

class ControllableWebSocket {
  readyState = 1;
  readonly sent: string[] = [];
  readonly close = vi.fn();
  private readonly listeners = new Map<SocketEvent, Array<(event: unknown) => void>>();

  addEventListener(type: SocketEvent, listener: (event: unknown) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  send(raw: string): void {
    this.sent.push(raw);
  }

  emit(type: SocketEvent, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function stubControllableWebSockets(): ControllableWebSocket[] {
  const sockets: ControllableWebSocket[] = [];
  const WebSocketSpy = vi.fn(function () {
    const socket = new ControllableWebSocket();
    sockets.push(socket);
    return socket;
  });
  (WebSocketSpy as unknown as { OPEN: number }).OPEN = 1;
  vi.stubGlobal("WebSocket", WebSocketSpy);
  return sockets;
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
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

  it.each([
    [4001, "credentials_rotated"],
    [4002, "tls_enforced"]
  ])("does not reconnect a stale credential after close code %i", async (code, reason) => {
    const sockets = stubControllableWebSockets();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    vi.mocked(requestUrl).mockResolvedValue({ status: 200 } as Awaited<ReturnType<typeof requestUrl>>);
    const socket = new RoomSyncSocket(createServer(), createDeps());

    socket.connect();
    await flushAsyncWork();
    sockets[0]?.emit("close", { code, reason });

    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(socket.getState()).toBe("offline");
    socket.disconnect();
  });
});

describe("RoomSyncSocket reconnect ordering", () => {
  it("re-subscribes a desired room when the socket closes before its first snapshot", async () => {
    const sockets = stubControllableWebSockets();
    let reconnect: (() => void) | undefined;
    vi.spyOn(window, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (delay === 1000) reconnect = callback as () => void;
      return 1;
    }) as typeof window.setTimeout);
    vi.mocked(requestUrl).mockResolvedValue({ status: 200 } as Awaited<ReturnType<typeof requestUrl>>);
    const socket = new RoomSyncSocket(createServer(), createDeps());

    socket.subscribe("room_1");
    socket.connect();
    await flushAsyncWork();
    sockets[0]?.emit("open");
    sockets[0]?.emit("message", { data: JSON.stringify({ type: "hello_ok", requestId: "hello_1" }) });
    await flushAsyncWork();
    expect(sockets[0]?.sent.filter((raw) => JSON.parse(raw).type === "subscribe_room")).toHaveLength(1);

    sockets[0]?.emit("close", { code: 1006 });
    reconnect?.();
    await flushAsyncWork();
    sockets[1]?.emit("open");
    sockets[1]?.emit("message", { data: JSON.stringify({ type: "hello_ok", requestId: "hello_2" }) });
    await flushAsyncWork();

    expect(sockets[1]?.sent.filter((raw) => JSON.parse(raw).type === "subscribe_room")).toHaveLength(1);
    socket.disconnect();
  });

  it("ignores a late close from a replaced socket", async () => {
    const sockets = stubControllableWebSockets();
    const reconnects: Array<() => void> = [];
    vi.spyOn(window, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (delay === 1000) reconnects.push(callback as () => void);
      return reconnects.length + 1;
    }) as typeof window.setTimeout);
    vi.mocked(requestUrl).mockResolvedValue({ status: 200 } as Awaited<ReturnType<typeof requestUrl>>);
    const socket = new RoomSyncSocket(createServer(), createDeps());

    socket.connect();
    await flushAsyncWork();
    sockets[0]?.emit("close", { code: 1006 });
    reconnects.shift()?.();
    await flushAsyncWork();
    expect(sockets).toHaveLength(2);

    sockets[0]?.emit("close", { code: 1006 });
    expect(reconnects).toHaveLength(0);
    socket.disconnect();
  });

  it("ignores a late message from a replaced socket", async () => {
    const sockets = stubControllableWebSockets();
    const reconnects: Array<() => void> = [];
    vi.spyOn(window, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (delay === 1000) reconnects.push(callback as () => void);
      return reconnects.length + 1;
    }) as typeof window.setTimeout);
    vi.mocked(requestUrl).mockResolvedValue({ status: 200 } as Awaited<ReturnType<typeof requestUrl>>);
    const vault = new FakeVaultAdapter();
    const room = createRoom();
    const socket = new RoomSyncSocket(createServer(), {
      ...createDeps(),
      getMountedRoom: () => room,
      syncEngine: new VaultSyncEngine(vault, new FakeApi())
    });

    socket.connect();
    await flushAsyncWork();
    sockets[0]?.emit("close", { code: 1006 });
    reconnects.shift()?.();
    await flushAsyncWork();
    sockets[0]?.emit("message", { data: JSON.stringify({
      type: "remote_file_change",
      roomId: "room_1",
      relativePath: "Board.md",
      version: 1,
      sha256: "sha-1",
      content: "stale socket",
      updatedBy: { userId: "user_2", displayName: "Teammate" },
      updatedAt: "2026-01-01"
    }) });
    await flushAsyncWork();

    expect(vault.files.has("Vault Rooms/demo/Projects Demo/Board.md")).toBe(false);
    socket.disconnect();
  });

  it("honors a pinned failure decision after the socket error is followed by close", async () => {
    const sockets = stubControllableWebSockets();
    let resolveDecision!: (decision: "normal") => void;
    const decision = new Promise<"normal">((resolve) => {
      resolveDecision = resolve;
    });
    const onPinnedTransportFailure = vi.fn().mockReturnValue(decision);
    const reconnects: Array<() => void> = [];
    vi.spyOn(window, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (delay === 1000) reconnects.push(callback as () => void);
      return reconnects.length + 1;
    }) as typeof window.setTimeout);
    vi.mocked(requestUrl).mockResolvedValue({ status: 200 } as Awaited<ReturnType<typeof requestUrl>>);
    const server = createServer();
    const socket = new RoomSyncSocket(server, { ...createDeps(), onPinnedTransportFailure });

    socket.connect();
    await flushAsyncWork();
    server.securityMode = "pinned-tls";
    sockets[0]?.emit("error", { error: new Error("certificate changed") });
    sockets[0]?.emit("close", { code: 1006 });
    resolveDecision("normal");
    await flushAsyncWork();

    expect(onPinnedTransportFailure).toHaveBeenCalledOnce();
    expect(reconnects).toHaveLength(1);
    socket.disconnect();
  });

  it("does not block a new socket hello behind a slow apply from the prior generation", async () => {
    const sockets = stubControllableWebSockets();
    const reconnects: Array<() => void> = [];
    vi.spyOn(window, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (delay === 1000) reconnects.push(callback as () => void);
      return reconnects.length + 1;
    }) as typeof window.setTimeout);
    let releaseFirstWrite: (() => void) | undefined;
    let writeCount = 0;
    class SlowFirstWriteVault extends FakeVaultAdapter {
      override async write(path: string, content: string): Promise<void> {
        writeCount += 1;
        if (writeCount === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
        await super.write(path, content);
      }
    }
    const vault = new SlowFirstWriteVault();
    const room = createRoom();
    const onHelloOk = vi.fn();
    vi.mocked(requestUrl).mockResolvedValue({ status: 200 } as Awaited<ReturnType<typeof requestUrl>>);
    const socket = new RoomSyncSocket(createServer(), {
      ...createDeps(),
      getMountedRoom: () => room,
      syncEngine: new VaultSyncEngine(vault, new FakeApi()),
      onHelloOk
    });
    const change = (version: number, content: string) => JSON.stringify({
      type: "remote_file_change",
      roomId: "room_1",
      relativePath: "Board.md",
      version,
      sha256: `sha-${version}`,
      content,
      updatedBy: { userId: "user_2", displayName: "Teammate" },
      updatedAt: "2026-01-01"
    });

    socket.connect();
    await flushAsyncWork();
    sockets[0]?.emit("open");
    sockets[0]?.emit("message", { data: JSON.stringify({ type: "hello_ok", requestId: "hello_a" }) });
    await vi.waitFor(() => expect(onHelloOk).toHaveBeenCalledTimes(1));
    sockets[0]?.emit("message", { data: change(1, "old") });
    await vi.waitFor(() => expect(releaseFirstWrite).toBeTypeOf("function"));

    sockets[0]?.emit("close", { code: 1006 });
    reconnects.shift()?.();
    await flushAsyncWork();
    sockets[1]?.emit("open");
    sockets[1]?.emit("message", { data: JSON.stringify({ type: "hello_ok", requestId: "hello_b" }) });
    await flushAsyncWork();

    expect(onHelloOk).toHaveBeenCalledTimes(2);

    sockets[1]?.emit("message", { data: change(2, "new") });
    releaseFirstWrite?.();
    await vi.waitFor(() => expect(room.files["Board.md"]?.serverVersion).toBe(2));
    expect(vault.files.get("Vault Rooms/demo/Projects Demo/Board.md")).toBe("new");
    socket.disconnect();
  });

  it("closes a socket that never acknowledges hello", async () => {
    const sockets = stubControllableWebSockets();
    let helloTimeout: (() => void) | undefined;
    vi.spyOn(window, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (delay === 10_000) helloTimeout = callback as () => void;
      return 1;
    }) as typeof window.setTimeout);
    vi.mocked(requestUrl).mockResolvedValue({ status: 200 } as Awaited<ReturnType<typeof requestUrl>>);
    const socket = new RoomSyncSocket(createServer(), createDeps());

    socket.connect();
    await flushAsyncWork();
    sockets[0]?.emit("open");
    helloTimeout?.();

    expect(helloTimeout).toBeTypeOf("function");
    expect(sockets[0]?.close).toHaveBeenCalledOnce();
    socket.disconnect();
  });

  it("applies incoming changes in receive order even when the first vault write is slow", async () => {
    const sockets = stubControllableWebSockets();
    let releaseFirstWrite: (() => void) | undefined;
    let writeCount = 0;
    class SlowFirstWriteVault extends FakeVaultAdapter {
      override async write(path: string, content: string): Promise<void> {
        writeCount += 1;
        if (writeCount === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
        await super.write(path, content);
      }
    }
    const vault = new SlowFirstWriteVault();
    const api = new FakeApi();
    const room = createRoom();
    vi.mocked(requestUrl).mockResolvedValue({ status: 200 } as Awaited<ReturnType<typeof requestUrl>>);
    const socket = new RoomSyncSocket(createServer(), {
      ...createDeps(),
      getMountedRoom: () => room,
      syncEngine: new VaultSyncEngine(vault, api)
    });

    socket.connect();
    await flushAsyncWork();
    const change = (version: number, content: string) => JSON.stringify({
      type: "remote_file_change",
      roomId: "room_1",
      relativePath: "Board.md",
      version,
      sha256: `sha-${version}`,
      content,
      updatedBy: { userId: "user_2", displayName: "Teammate" },
      updatedAt: "2026-01-01"
    });
    sockets[0]?.emit("message", { data: change(1, "old") });
    sockets[0]?.emit("message", { data: change(2, "new") });
    await flushAsyncWork();
    releaseFirstWrite?.();
    await vi.waitFor(() => expect(room.files["Board.md"]?.serverVersion).toBe(2));

    expect(vault.files.get("Vault Rooms/demo/Projects Demo/Board.md")).toBe("new");
    socket.disconnect();
  });
});

describe("RoomSyncSocket room_mode_changed", () => {
  it("reports the new crdtEnabled flag via onRoomModeChanged and still re-subscribes a desired room", async () => {
    const sockets = stubControllableWebSockets();
    vi.mocked(requestUrl).mockResolvedValue({ status: 200 } as Awaited<ReturnType<typeof requestUrl>>);
    const onRoomModeChanged = vi.fn();
    const socket = new RoomSyncSocket(createServer(), { ...createDeps(), onRoomModeChanged });

    socket.subscribe("room_1");
    socket.connect();
    await flushAsyncWork();
    sockets[0]?.emit("open");
    sockets[0]?.emit("message", { data: JSON.stringify({ type: "hello_ok", requestId: "hello_1" }) });
    await flushAsyncWork();
    const subscribesBefore = sockets[0]?.sent.filter((raw) => JSON.parse(raw).type === "subscribe_room").length ?? 0;

    sockets[0]?.emit("message", { data: JSON.stringify({ type: "room_mode_changed", roomId: "room_1", crdtEnabled: true }) });
    await flushAsyncWork();

    expect(onRoomModeChanged).toHaveBeenCalledWith("room_1", true);
    const subscribesAfter = sockets[0]?.sent.filter((raw) => JSON.parse(raw).type === "subscribe_room").length ?? 0;
    expect(subscribesAfter).toBe(subscribesBefore + 1);
    socket.disconnect();
  });

  it("does not throw when onRoomModeChanged is not provided (optional dep)", async () => {
    const socket = new RoomSyncSocket(createServer(), createDeps());
    const handleMessage = (socket as unknown as { handleMessage: (raw: string) => Promise<void> }).handleMessage.bind(socket);

    await expect(handleMessage(JSON.stringify({ type: "room_mode_changed", roomId: "room_1", crdtEnabled: false }))).resolves.toBeUndefined();
  });
});

// Second-hardware-testing-round item 1: a device that never opens a CRDT file's editor never
// received live updates for it, because the relay used to exclude every CRDT-capable connection
// from the materialized remote_file_change fallback broadcast on the assumption the CRDT lane
// already delivered it via remote_crdt_update - which silently no-ops when no local session is
// open. Now that the relay sends this broadcast to every subscriber regardless of capability (see
// relayCore.ts), the client must decide whether to apply it: skip it when a live CRDT session
// already owns this path (avoid clobbering in-flight editor state), apply it otherwise (this is
// what keeps a never-opened CRDT file's on-disk copy fresh, and is unchanged behavior for any
// ordinary non-CRDT path/room).
describe("RoomSyncSocket remote_file_change CRDT session gating", () => {
  function remoteFileChangeMessage(): string {
    return JSON.stringify({
      type: "remote_file_change",
      roomId: "room_1",
      relativePath: "Board.md",
      version: 1,
      sha256: "sha-1",
      content: "materialized snapshot",
      updatedBy: { userId: "user_2", displayName: "Teammate" },
      updatedAt: "2026-01-01"
    });
  }

  it("does not apply a remote_file_change when a CRDT session is already open for the path", async () => {
    const sockets = stubControllableWebSockets();
    vi.mocked(requestUrl).mockResolvedValue({ status: 200 } as Awaited<ReturnType<typeof requestUrl>>);
    const vault = new FakeVaultAdapter();
    const room = createRoom();
    const engine = new VaultSyncEngine(vault, new FakeApi());
    const applySpy = vi.spyOn(engine, "applyRemoteChange");
    const socket = new RoomSyncSocket(createServer(), {
      ...createDeps(),
      getMountedRoom: () => room,
      syncEngine: engine,
      crdt: new FakeCrdtBridge(true)
    });

    socket.connect();
    await flushAsyncWork();
    sockets[0]?.emit("message", { data: remoteFileChangeMessage() });
    await flushAsyncWork();

    expect(applySpy).not.toHaveBeenCalled();
    expect(vault.files.has("Vault Rooms/demo/Projects Demo/Board.md")).toBe(false);
    socket.disconnect();
  });

  it("applies a remote_file_change as before when no CRDT session is open for the path", async () => {
    const sockets = stubControllableWebSockets();
    vi.mocked(requestUrl).mockResolvedValue({ status: 200 } as Awaited<ReturnType<typeof requestUrl>>);
    const vault = new FakeVaultAdapter();
    const room = createRoom();
    const engine = new VaultSyncEngine(vault, new FakeApi());
    const applySpy = vi.spyOn(engine, "applyRemoteChange");
    const socket = new RoomSyncSocket(createServer(), {
      ...createDeps(),
      getMountedRoom: () => room,
      syncEngine: engine,
      crdt: new FakeCrdtBridge(false)
    });

    socket.connect();
    await flushAsyncWork();
    sockets[0]?.emit("message", { data: remoteFileChangeMessage() });
    await flushAsyncWork();

    expect(applySpy).toHaveBeenCalledOnce();
    expect(vault.files.get("Vault Rooms/demo/Projects Demo/Board.md")).toBe("materialized snapshot");
    socket.disconnect();
  });

  it("applies a remote_file_change as before when there is no CRDT bridge configured at all (non-CRDT room / legacy setup)", async () => {
    const sockets = stubControllableWebSockets();
    vi.mocked(requestUrl).mockResolvedValue({ status: 200 } as Awaited<ReturnType<typeof requestUrl>>);
    const vault = new FakeVaultAdapter();
    const room = createRoom();
    const engine = new VaultSyncEngine(vault, new FakeApi());
    const applySpy = vi.spyOn(engine, "applyRemoteChange");
    const socket = new RoomSyncSocket(createServer(), {
      ...createDeps(),
      getMountedRoom: () => room,
      syncEngine: engine
    });

    socket.connect();
    await flushAsyncWork();
    sockets[0]?.emit("message", { data: remoteFileChangeMessage() });
    await flushAsyncWork();

    expect(applySpy).toHaveBeenCalledOnce();
    expect(vault.files.get("Vault Rooms/demo/Projects Demo/Board.md")).toBe("materialized snapshot");
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

  it("continues reconciling later files when one snapshot read fails", async () => {
    const vault = new FakeVaultAdapter();
    const room = createRoom();
    const api = new FakeApi();
    vi.spyOn(api, "readFile").mockImplementation(async (_roomId, relativePath) => {
      if (relativePath === "Gone.md") throw new Error("not found");
      return { relativePath, version: 2, sha256: "sha-2", content: "kept" };
    });
    const onApplied = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const socket = new RoomSyncSocket(createServer(), {
      ...createDeps(),
      getMountedRoom: () => room,
      getApi: () => api as unknown as RelayApiClient,
      syncEngine: new VaultSyncEngine(vault, api),
      onApplied
    });

    await expect((socket as unknown as { handleMessage: (raw: string) => Promise<void> }).handleMessage(JSON.stringify({
      type: "room_snapshot",
      roomId: "room_1",
      files: [
        { relativePath: "Gone.md", version: 2, sha256: "gone", deleted: false },
        { relativePath: "Kept.md", version: 2, sha256: "sha-2", deleted: false }
      ]
    }))).resolves.toBeUndefined();

    expect(vault.files.get("Vault Rooms/demo/Projects Demo/Kept.md")).toBe("kept");
    expect(onApplied).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
