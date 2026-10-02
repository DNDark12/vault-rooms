import { describe, expect, it, vi } from "vitest";
import { RoomPushCoordinator } from "./pushCoordinator.js";
import { VaultSyncEngine, type MountedRoomState, type RelayFileApi, type VaultAdapter } from "./syncClient.js";

// pushCoordinator's default timer fallback calls window.setTimeout/clearTimeout (see syncWsClient.test.ts
// for the same shim) - vitest's "node" test environment has no window global otherwise.
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
  writes: Array<{ roomId: string; relativePath: string; baseVersion: number; content: string }> = [];
  deletes: Array<{ roomId: string; relativePath: string; baseVersion: number }> = [];
  nextWriteError: (Error & { code?: string }) | null = null;

  async readFile(): Promise<{ relativePath: string; version: number; sha256: string; content: string }> {
    return { relativePath: "Board.md", version: 2, sha256: "server-2", content: "server" };
  }

  async writeFile(roomId: string, relativePath: string, baseVersion: number, content: string): Promise<{ ok: true; relativePath: string; version: number; sha256: string }> {
    this.writes.push({ roomId, relativePath, baseVersion, content });
    if (this.nextWriteError) {
      const error = this.nextWriteError;
      this.nextWriteError = null;
      throw error;
    }
    return { ok: true, relativePath, version: baseVersion + 1, sha256: `sha-${baseVersion + 1}` };
  }

  async deleteFile(roomId: string, relativePath: string, baseVersion: number): Promise<{ ok: true; relativePath: string; version: number }> {
    this.deletes.push({ roomId, relativePath, baseVersion });
    return { ok: true, relativePath, version: baseVersion + 1 };
  }
}

function createRoom(): MountedRoomState {
  return {
    roomId: "room_1",
    mountPath: "Vault Rooms/demo/Projects Demo",
    files: {}
  };
}

describe("RoomPushCoordinator", () => {
  it("reports each blocked path and reason once without mutating or pushing ambiguous tracking", () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const room = createRoom();
    room.pathCollisionKeys = ["board.md"];
    room.files["Board.md"] = { serverVersion: 1, serverSha256: "old", localSha256: "old", dirty: false };
    const before = structuredClone(room.files);
    const onError = vi.fn();
    const coordinator = new RoomPushCoordinator({
      room, syncEngine: new VaultSyncEngine(vault, api), deviceName: "Laptop",
      onPersist: vi.fn(), onError, debounceMs: 50, isStillMounted: () => true
    });
    coordinator.handleLocalChange("modify", "Board.md");
    coordinator.handleLocalChange("modify", "Board.md");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toMatchObject({ code: "PATH_COLLISION" });
    room.pathCollisionKeys = [];
    room.pathRecoveryKeys = ["board.md"];
    coordinator.handleLocalChange("modify", "Board.md");
    expect(onError).toHaveBeenCalledTimes(2);
    expect(room.files).toEqual(before);
    expect(api.writes).toEqual([]);
    expect(api.deletes).toEqual([]);
    coordinator.dispose();
  });

  it("reports a local alias collision even when authoritative recovery is also pending", () => {
    const room = createRoom();
    room.pathRecoveryKeys = ["board.md"];
    room.files["Board.md"] = { serverVersion: 1, serverSha256: "a", localSha256: "a", dirty: false };
    room.files["board.md"] = { serverVersion: 1, serverSha256: "b", localSha256: "b", dirty: false };
    const onError = vi.fn();
    const coordinator = new RoomPushCoordinator({ room, syncEngine: new VaultSyncEngine(new FakeVaultAdapter(), new FakeApi()),
      deviceName: "Laptop", onPersist: vi.fn(), onError, debounceMs: 50, isStillMounted: () => true });
    coordinator.handleLocalChange("modify", "Board.md");
    expect(onError.mock.calls[0]?.[1]).toMatchObject({ reason: "local-collision" });
  });

  it("cancels queued pushes when disposed while a preceding push is still in flight", async () => {
    const room = createRoom();
    const engine = new VaultSyncEngine(new FakeVaultAdapter(), new FakeApi());
    let finish!: () => void;
    const firstPush = new Promise<void>((resolve) => { finish = resolve; });
    const push = vi.spyOn(engine, "pushLocalChange").mockImplementationOnce(() => firstPush).mockResolvedValue(undefined);
    const timers: Array<() => void> = [];
    const coordinator = new RoomPushCoordinator({ room, syncEngine: engine, deviceName: "Laptop",
      onPersist: vi.fn(), onError: vi.fn(), debounceMs: 50, isStillMounted: () => true,
      schedule: (fn) => { timers.push(fn); return timers.length; }, cancel: vi.fn() });
    coordinator.handleLocalChange("modify", "Board.md");
    timers.shift()!();
    await vi.waitFor(() => expect(push).toHaveBeenCalledOnce());
    coordinator.handleLocalChange("modify", "Board.md");
    timers.shift()!();
    coordinator.dispose();
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(push).toHaveBeenCalledOnce();
  });

  it("marks a file dirty synchronously on a local edit, before the debounce timer fires", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const engine = new VaultSyncEngine(vault, api);
    const room = createRoom();
    const persist = vi.fn();
    const coordinator = new RoomPushCoordinator({
      room,
      syncEngine: engine,
      deviceName: "B laptop",
      onPersist: persist,
      onError: () => undefined,
      debounceMs: 50,
      isStillMounted: () => true
    });
    await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# edited\n");

    coordinator.handleLocalChange("modify", "Board.md");

    // Dirty must be true immediately (synchronously), before the debounce timer has fired.
    expect(room.files["Board.md"]?.dirty).toBe(true);
    expect(persist).toHaveBeenCalled();
    expect(api.writes).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(api.writes).toHaveLength(1);
    expect(room.files["Board.md"]?.dirty).toBe(false);

    coordinator.dispose();
  });

  it("keeps a file dirty when the debounced push fails, so it can be retried later", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const error = Object.assign(new Error("network down"), {});
    api.nextWriteError = error;
    const engine = new VaultSyncEngine(vault, api);
    const room = createRoom();
    const onError = vi.fn();
    const coordinator = new RoomPushCoordinator({
      room,
      syncEngine: engine,
      deviceName: "B laptop",
      onPersist: () => undefined,
      onError,
      debounceMs: 20,
      isStillMounted: () => true
    });
    await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# edited\n");

    coordinator.handleLocalChange("modify", "Board.md");
    expect(room.files["Board.md"]?.dirty).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onError).toHaveBeenCalled();
    expect(room.files["Board.md"]?.dirty).toBe(true);

    coordinator.dispose();
  });

  it("retries dirty files through the same push machinery on retryPending()", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const engine = new VaultSyncEngine(vault, api);
    const room = createRoom();
    room.files["Board.md"] = { serverVersion: 1, serverSha256: "old", localSha256: "old", dirty: true };
    await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# local edit\n");
    const coordinator = new RoomPushCoordinator({
      room,
      syncEngine: engine,
      deviceName: "B laptop",
      onPersist: () => undefined,
      onError: () => undefined,
      debounceMs: 10_000,
      isStillMounted: () => true
    });

    coordinator.retryPending();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(api.writes).toHaveLength(1);
    expect(room.files["Board.md"]?.dirty).toBe(false);

    coordinator.dispose();
  });

  it("does not retry a file whose last push failed because the relay's storage quota is full", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const error = Object.assign(new Error("store is full"), { code: "STORAGE_QUOTA_EXCEEDED" });
    api.nextWriteError = error;
    const engine = new VaultSyncEngine(vault, api);
    const room = createRoom();
    const coordinator = new RoomPushCoordinator({
      room,
      syncEngine: engine,
      deviceName: "B laptop",
      onPersist: () => undefined,
      onError: () => undefined,
      debounceMs: 10,
      isStillMounted: () => true
    });
    await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# big\n");

    coordinator.handleLocalChange("modify", "Board.md");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(api.writes).toHaveLength(1);
    expect(room.files["Board.md"]?.syncError).toBeTruthy();

    coordinator.retryPending();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.writes).toHaveLength(1);

    coordinator.dispose();
  });

  it("does not retry a file whose last push failed with a terminal (422-family) error", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const error = Object.assign(new Error("file too large"), { code: "FILE_TOO_LARGE" });
    api.nextWriteError = error;
    const engine = new VaultSyncEngine(vault, api);
    const room = createRoom();
    const coordinator = new RoomPushCoordinator({
      room,
      syncEngine: engine,
      deviceName: "B laptop",
      onPersist: () => undefined,
      onError: () => undefined,
      debounceMs: 10,
      isStillMounted: () => true
    });
    await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# big\n");

    coordinator.handleLocalChange("modify", "Board.md");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(api.writes).toHaveLength(1);
    expect(room.files["Board.md"]?.syncError).toBeTruthy();

    coordinator.retryPending();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // No second attempt - terminal errors stop retrying.
    expect(api.writes).toHaveLength(1);

    coordinator.dispose();
  });

  it("stores a readable syncError for a bare code and for a message-less rejection", async () => {
    const cases: Array<{ thrown: unknown; expected: string }> = [
      { thrown: { code: "VALIDATION_ERROR", message: "VALIDATION_ERROR" }, expected: "This server rejected the request." },
      { thrown: { code: "FILE_TOO_LARGE" }, expected: "That file is larger than this server accepts." }
    ];

    for (const { thrown, expected } of cases) {
      const vault = new FakeVaultAdapter();
      const api = new FakeApi();
      api.nextWriteError = thrown as Error;
      const room = createRoom();
      const coordinator = new RoomPushCoordinator({
        room,
        syncEngine: new VaultSyncEngine(vault, api),
        deviceName: "B laptop",
        onPersist: () => undefined,
        onError: () => undefined,
        debounceMs: 10,
        isStillMounted: () => true
      });
      await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# big\n");

      coordinator.handleLocalChange("modify", "Board.md");
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(room.files["Board.md"]?.syncError).toBe(expected);
      expect(room.files["Board.md"]?.syncError).not.toContain("[object Object]");
      coordinator.dispose();
    }
  });

  it("debounces rapid successive edits to the same path into a single push", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const engine = new VaultSyncEngine(vault, api);
    const room = createRoom();
    const coordinator = new RoomPushCoordinator({
      room,
      syncEngine: engine,
      deviceName: "B laptop",
      onPersist: () => undefined,
      onError: () => undefined,
      debounceMs: 40,
      isStillMounted: () => true
    });
    await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# v1\n");
    coordinator.handleLocalChange("modify", "Board.md");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# v2\n");
    coordinator.handleLocalChange("modify", "Board.md");

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0]?.content).toBe("# v2\n");

    coordinator.dispose();
  });

  it("handles a local delete: marks pending, pushes via pushLocalDelete, and clears tracking on success", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const engine = new VaultSyncEngine(vault, api);
    const room = createRoom();
    room.files["Board.md"] = { serverVersion: 2, serverSha256: "server-2", localSha256: "server-2", dirty: false };
    const coordinator = new RoomPushCoordinator({
      room,
      syncEngine: engine,
      deviceName: "B laptop",
      onPersist: () => undefined,
      onError: () => undefined,
      debounceMs: 20,
      isStillMounted: () => true
    });

    coordinator.handleLocalChange("delete", "Board.md");
    expect(room.files["Board.md"]?.localDeleted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(api.deletes).toEqual([{ roomId: "room_1", relativePath: "Board.md", baseVersion: 2 }]);
    expect(room.files["Board.md"]).toBeUndefined();

    coordinator.dispose();
  });

  it("drops local tracking with no server call when deleting a file that was never pushed", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const engine = new VaultSyncEngine(vault, api);
    const room = createRoom();
    const coordinator = new RoomPushCoordinator({
      room,
      syncEngine: engine,
      deviceName: "B laptop",
      onPersist: () => undefined,
      onError: () => undefined,
      debounceMs: 20,
      isStillMounted: () => true
    });

    coordinator.handleLocalChange("delete", "Untracked.md");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(api.deletes).toHaveLength(0);
    expect(room.files["Untracked.md"]).toBeUndefined();

    coordinator.dispose();
  });

  it("ignores conflict-copy paths for both edits and deletes", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const engine = new VaultSyncEngine(vault, api);
    const room = createRoom();
    const coordinator = new RoomPushCoordinator({
      room,
      syncEngine: engine,
      deviceName: "B laptop",
      onPersist: () => undefined,
      onError: () => undefined,
      debounceMs: 10,
      isStillMounted: () => true
    });
    const conflictPath = "Board (conflict B laptop 2026-07-06T120000).md";
    await vault.write(`Vault Rooms/demo/Projects Demo/${conflictPath}`, "# conflict\n");

    coordinator.handleLocalChange("modify", conflictPath);
    expect(room.files[conflictPath]).toBeUndefined();
    coordinator.handleLocalChange("delete", conflictPath);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(api.writes).toHaveLength(0);
    expect(api.deletes).toHaveLength(0);

    coordinator.dispose();
  });

  it("stops scheduled work once unmounted mid-debounce", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const engine = new VaultSyncEngine(vault, api);
    const room = createRoom();
    let mounted = true;
    const coordinator = new RoomPushCoordinator({
      room,
      syncEngine: engine,
      deviceName: "B laptop",
      onPersist: () => undefined,
      onError: () => undefined,
      debounceMs: 10,
      isStillMounted: () => mounted
    });
    await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# edit\n");
    coordinator.handleLocalChange("modify", "Board.md");
    mounted = false;

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(api.writes).toHaveLength(0);

    coordinator.dispose();
  });

  it("clears a stale pending-delete flag when a local edit supersedes it within one debounce window (create->delete->recreate bounce)", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const engine = new VaultSyncEngine(vault, api);
    const room = createRoom();
    room.files["Board.md"] = { serverVersion: 2, serverSha256: "server-2", localSha256: "server-2", dirty: false };
    const coordinator = new RoomPushCoordinator({
      room,
      syncEngine: engine,
      deviceName: "B laptop",
      onPersist: () => undefined,
      onError: () => undefined,
      debounceMs: 50,
      isStillMounted: () => true
    });

    // Delete, then recreate the same path before the debounced delete push fires.
    coordinator.handleLocalChange("delete", "Board.md");
    expect(room.files["Board.md"]?.localDeleted).toBe(true);
    await vault.write("Vault Rooms/demo/Projects Demo/Board.md", "# recreated\n");
    coordinator.handleLocalChange("create", "Board.md");

    // The edit must immediately clear the stale pending-delete flag, not just eventually.
    expect(room.files["Board.md"]?.localDeleted).toBeFalsy();
    expect(room.files["Board.md"]?.dirty).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 120));

    // Final result is a push (edit), not a delete.
    expect(api.deletes).toHaveLength(0);
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0]?.content).toBe("# recreated\n");
    expect(room.files["Board.md"]?.localDeleted).toBeFalsy();
    expect(room.files["Board.md"]?.dirty).toBe(false);

    coordinator.dispose();
  });

  it("cancels an already-armed debounce timer when a never-pushed file is deleted before it fires", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const engine = new VaultSyncEngine(vault, api);
    const room = createRoom();
    const armedTimers = new Map<number, ReturnType<typeof setTimeout>>();
    let nextId = 1;
    const schedule = vi.fn((fn: () => void, ms: number) => {
      const id = nextId++;
      armedTimers.set(id, setTimeout(fn, ms));
      return id;
    });
    const cancel = vi.fn((id: number) => {
      const timer = armedTimers.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        armedTimers.delete(id);
      }
    });
    const coordinator = new RoomPushCoordinator({
      room,
      syncEngine: engine,
      deviceName: "B laptop",
      onPersist: () => undefined,
      onError: () => undefined,
      debounceMs: 50,
      isStillMounted: () => true,
      schedule,
      cancel
    });
    // Never pushed to the server yet (no serverSha256), so an edit followed by a delete before the
    // debounce fires hits handleLocalDelete's "never pushed" branch, which drops tracking directly
    // instead of going through pushLocalDelete.
    await vault.write("Vault Rooms/demo/Projects Demo/New.md", "# new\n");
    coordinator.handleLocalChange("create", "New.md");
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();

    await vault.delete("Vault Rooms/demo/Projects Demo/New.md");
    coordinator.handleLocalChange("delete", "New.md");
    expect(room.files["New.md"]).toBeUndefined();

    // The edit's debounce timer must have been cancelled synchronously by the delete, not left
    // armed to fire later.
    expect(cancel).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(api.writes).toHaveLength(0);
    expect(room.files["New.md"]).toBeUndefined();

    coordinator.dispose();
  });
});


describe("portable push coordination", () => {
  it("reports an invalid new name once without dirty/error tracking, then syncs a corrected name", async () => {
    const vault = new FakeVaultAdapter();
    const api = new FakeApi();
    const room = createRoom();
    const onError = vi.fn();
    const coordinator = new RoomPushCoordinator({ room, syncEngine: new VaultSyncEngine(vault, api), deviceName: "device",
      onPersist: () => undefined, onError, debounceMs: 1, isStillMounted: () => true });
    await vault.write(`${room.mountPath}/CON.md`, "keep me");
    coordinator.handleLocalChange("create", "CON.md");
    coordinator.handleLocalChange("modify", "CON.md");
    coordinator.retryPending();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(room.files["CON.md"]).toBeUndefined();
    expect(api.writes).toEqual([]);
    expect(vault.files.get(`${room.mountPath}/CON.md`)).toBe("keep me");
    await vault.rename(`${room.mountPath}/CON.md`, `${room.mountPath}/Okay.md`);
    coordinator.handleLocalChange("create", "Okay.md");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.writes[0]?.relativePath).toBe("Okay.md");
    coordinator.dispose();
  });

  it("serializes a case-only rename as delete then create on one canonical queue", async () => {
    const vault = new FakeVaultAdapter();
    // Model exists() on a case-insensitive filesystem: old spelling still resolves to the renamed file.
    vault.exists = async (path) => [...vault.files.keys()].some((candidate) => candidate.toLowerCase() === path.toLowerCase());
    const api = new FakeApi();
    const order: string[] = [];
    const write = api.writeFile.bind(api);
    api.writeFile = async (...args) => { order.push(`create:${args[1]}`); return write(...args); };
    const remove = api.deleteFile.bind(api);
    api.deleteFile = async (...args) => { order.push(`delete:${args[1]}`); return remove(...args); };
    const room = createRoom();
    room.files["Note.md"] = { serverVersion: 4, serverSha256: "old", localSha256: "old", dirty: false };
    await vault.write(`${room.mountPath}/note.md`, "local");
    const coordinator = new RoomPushCoordinator({ room, syncEngine: new VaultSyncEngine(vault, api), deviceName: "device",
      onPersist: () => undefined, onError: () => undefined, debounceMs: 1, isStillMounted: () => true });
    coordinator.handleLocalChange("delete", "Note.md", { renamedToRelativePath: "note.md" });
    coordinator.handleLocalChange("create", "note.md", { renamedFromRelativePath: "Note.md" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(order).toEqual(["delete:Note.md", "create:note.md"]);
    expect(api.writes[0]?.baseVersion).toBe(0);
    expect(Object.keys(room.files)).toEqual(["note.md"]);
    coordinator.dispose();
  });

  it("pauses a quarantined alias without changing tracking", () => {
    const room = createRoom();
    room.pathCollisionKeys = ["note.md"];
    const state = { serverVersion: 4, serverSha256: "old", localSha256: "old", dirty: false };
    room.files["Note.md"] = state;
    const coordinator = new RoomPushCoordinator({ room, syncEngine: new VaultSyncEngine(new FakeVaultAdapter(), new FakeApi()), deviceName: "device",
      onPersist: () => undefined, onError: () => undefined, debounceMs: 1, isStillMounted: () => true });
    coordinator.handleLocalChange("modify", "NOTE.MD");
    expect(room.files).toEqual({ "Note.md": state });
    coordinator.dispose();
  });
});
