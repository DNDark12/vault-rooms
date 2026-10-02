import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { CrdtDocStore, CrdtDocStoreQuotaExceededError, MAX_PERSISTED_CRDT_DOC_BYTES } from "./crdtDocStore.js";

/** Minimal in-memory stand-in for Obsidian's DataAdapter - same pattern as obsidianSqlJsDb.test.ts's
 *  FakeDataAdapter, extended with list()/rmdir() since CrdtDocStore needs directory enumeration for
 *  room-scoped cleanup. */
class FakeDataAdapter {
  readonly store = new Map<string, ArrayBuffer>();
  readonly folders = new Set<string>();
  writeBinaryCalls = 0;

  async exists(path: string): Promise<boolean> {
    return this.store.has(path) || this.folders.has(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const data = this.store.get(path);
    if (!data) throw new Error(`Missing file: ${path}`);
    return data.slice(0);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.writeBinaryCalls += 1;
    this.store.set(path, data.slice(0));
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async remove(path: string): Promise<void> {
    if (!this.store.has(path)) throw new Error(`Missing file: ${path}`);
    this.store.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const data = this.store.get(from);
    if (!data) throw new Error(`Missing file: ${from}`);
    if (this.store.has(to)) throw new Error("Destination file already exists!");
    this.store.set(to, data);
    this.store.delete(from);
  }

  async rmdir(path: string): Promise<void> {
    this.folders.delete(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    return {
      files: [...this.store.keys()].filter((key) => key.startsWith(prefix) && !key.includes("/", prefix.length)),
      folders: []
    };
  }
}

function asDataAdapter(adapter: FakeDataAdapter): DataAdapter {
  return adapter as unknown as DataAdapter;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("CrdtDocStore", () => {
  it("shares room ownership across distinct stores even after the module is reloaded", async () => {
    const adapter = asDataAdapter(new FakeDataAdapter());
    const old = new CrdtDocStore(adapter, "vault-rooms/crdt");
    const started = deferred();
    const gate = deferred();
    const oldWriting = old.withRoomAccess("r", async () => {
      started.resolve();
      await gate.promise;
      await old.save("r", "Note.md", 0, new Uint8Array([7]));
    });
    await started.promise;
    vi.resetModules();
    const reloaded = await import("./crdtDocStore.js");
    const fresh = new reloaded.CrdtDocStore(adapter, "vault-rooms/crdt");
    const reading = vi.fn(() => fresh.load("r", "Note.md", 0));
    const loaded = fresh.withRoomAccess("r", reading);
    await Promise.resolve();
    expect(reading).not.toHaveBeenCalled();
    gate.resolve();
    await oldWriting;
    expect(await loaded).toEqual(new Uint8Array([7]));
    expect(reading).toHaveBeenCalledOnce();
  });

  it("rejects already-queued operations after a write failure and releases room ownership for retry", async () => {
    const adapter = new FakeDataAdapter();
    const old = new CrdtDocStore(asDataAdapter(adapter), "vault-rooms/crdt");
    const fresh = new CrdtDocStore(asDataAdapter(adapter), "vault-rooms/crdt");
    await old.save("r", "Note.md", 0, new Uint8Array([1]));
    const started = deferred();
    const gate = deferred();
    const write = vi.spyOn(adapter, "writeBinary").mockImplementationOnce(async () => {
      started.resolve();
      await gate.promise;
      throw new Error("disk full");
    });
    const writing = old.withRoomAccess("r", () => old.save("r", "Note.md", 0, new Uint8Array([2])));
    const writeResult = writing.then(() => "written", (error: unknown) => error);
    const deletion = vi.fn(() => fresh.deleteEpoch("r", "Note.md", 0));
    const deleting = fresh.withRoomAccess("r", deletion);
    const deleteResult = deleting.then(() => "deleted", (error: unknown) => error);
    await started.promise;
    gate.resolve();
    expect(await writeResult).toMatchObject({ message: "disk full" });
    expect(await deleteResult).toMatchObject({ message: "disk full" });
    expect(deletion).not.toHaveBeenCalled();
    expect(await fresh.load("r", "Note.md", 0)).toEqual(new Uint8Array([1]));
    write.mockRestore();
    await old.withRoomAccess("r", () => old.save("r", "Note.md", 0, new Uint8Array([2])));
    expect(await fresh.withRoomAccess("r", () => fresh.load("r", "Note.md", 0))).toEqual(new Uint8Array([2]));
  });

  it("scopes ownership to adapter, cache directory and room", async () => {
    const adapter = asDataAdapter(new FakeDataAdapter());
    const blocked = new CrdtDocStore(adapter, "vault-rooms/crdt");
    const gate = deferred();
    const waiting = blocked.withRoomAccess("r", async () => { await gate.promise; });
    const otherDirectory = new CrdtDocStore(adapter, "other-server/crdt");
    const otherAdapter = new CrdtDocStore(asDataAdapter(new FakeDataAdapter()), "vault-rooms/crdt");
    const results = await Promise.all([
      otherDirectory.withRoomAccess("r", async () => "other directory"),
      otherAdapter.withRoomAccess("r", async () => "other vault"),
      blocked.withRoomAccess("other-room", async () => "other room")
    ]);
    gate.resolve();
    await waiting;
    expect(results).toEqual(["other directory", "other vault", "other room"]);
  });

  it("retains failed final persistence across module reload until a later access can save it", async () => {
    const adapter = new FakeDataAdapter();
    const old = new CrdtDocStore(asDataAdapter(adapter), "vault-rooms/crdt");
    await old.save("r", "Note.md", 0, new Uint8Array([1]));
    const write = vi.spyOn(adapter, "writeBinary")
      .mockRejectedValueOnce(new Error("disk full"))
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(old.withRoomAccess("r", () => old.save("r", "Note.md", 0, new Uint8Array([2])), { retainFailure: true }))
      .rejects.toThrow("disk full");
    vi.resetModules();
    const reloaded = await import("./crdtDocStore.js");
    const fresh = new reloaded.CrdtDocStore(asDataAdapter(adapter), "vault-rooms/crdt");
    const reading = vi.fn(() => fresh.load("r", "Note.md", 0));
    await expect(fresh.withRoomAccess("r", reading)).rejects.toThrow("disk full");
    expect(reading).not.toHaveBeenCalled();
    expect(await fresh.load("r", "Note.md", 0)).toEqual(new Uint8Array([1]));
    write.mockRestore();
    expect(await fresh.withRoomAccess("r", reading)).toEqual(new Uint8Array([2]));
    expect(reading).toHaveBeenCalledOnce();
  });

  it("retains final persistence skipped because an earlier cache write failed", async () => {
    const adapter = asDataAdapter(new FakeDataAdapter());
    const old = new CrdtDocStore(adapter, "vault-rooms/crdt");
    const fresh = new CrdtDocStore(adapter, "vault-rooms/crdt");
    const earlier = old.withRoomAccess("r", async () => { throw new Error("earlier write failed"); });
    const earlierResult = earlier.catch((error: unknown) => error);
    const finalSave = vi.fn(() => old.save("r", "Note.md", 0, new Uint8Array([9])));
    const retirement = old.withRoomAccess("r", finalSave, { retainFailure: true });
    await expect(retirement).rejects.toThrow("earlier write failed");
    await earlierResult;
    expect(finalSave).not.toHaveBeenCalled();
    expect(await fresh.withRoomAccess("r", () => fresh.load("r", "Note.md", 0))).toEqual(new Uint8Array([9]));
    expect(finalSave).toHaveBeenCalledOnce();
  });

  it("retains prior epochs when saving a quarantined document", async () => {
    const store = new CrdtDocStore(asDataAdapter(new FakeDataAdapter()), "vault-rooms/crdt");
    await store.save("r", "Note.md", 2, new Uint8Array([1]));
    await store.save("r", "Note.md", 0, new Uint8Array([2]), true);
    expect(await store.load("r", "Note.md", 2)).toEqual(new Uint8Array([1]));
    expect(await store.load("r", "Note.md", 0)).toEqual(new Uint8Array([2]));
  });

  it("discovers interrupted replacement backups and retains complete temporary state for preservation", async () => {
    const adapter = new FakeDataAdapter();
    const store = new CrdtDocStore(asDataAdapter(adapter), "vault-rooms/crdt");
    await store.save("r", "Note.md", 2, new Uint8Array([1]));
    const path = [...adapter.store.keys()][0]!;
    await adapter.rename(path, `${path}.replace-backup`);
    await expect(store.loadAllEpochs("r", "Note.md")).resolves.toEqual([{ epoch: 2, state: new Uint8Array([1]) }]);
    await adapter.writeBinary(`${path}.tmp`, new Uint8Array([2]).buffer);
    await expect(store.loadAllEpochs("r", "Note.md")).resolves.toEqual([
      { epoch: 2, state: new Uint8Array([1]) }, { epoch: 2, state: new Uint8Array([2]) }
    ]);
  });

  it("loads all stored epochs for one spelling without touching other room documents", async () => {
    const adapter = new FakeDataAdapter();
    const store = new CrdtDocStore(asDataAdapter(adapter), "vault-rooms/crdt");
    await store.save("r", "Note.md", 3, new Uint8Array([1, 2]));
    await store.save("r", "Other.md", 0, new Uint8Array([9]));
    await expect(store.loadAllEpochs("r", "Note.md")).resolves.toEqual([{ epoch: 3, state: new Uint8Array([1, 2]) }]);
    await expect(store.loadAllEpochs("r", "note.md")).resolves.toEqual([]);
    await expect(store.loadAllEpochs("unknown", "Note.md")).resolves.toEqual([]);
    expect(await store.load("r", "Other.md", 0)).toEqual(new Uint8Array([9]));
  });

  it("returns null for a path/epoch that was never persisted", async () => {
    const store = new CrdtDocStore(asDataAdapter(new FakeDataAdapter()), "vault-rooms/crdt");
    expect(await store.load("room_1", "Notes/Board.md", 0)).toBeNull();
  });

  it("round-trips persisted state for the exact (roomId, relativePath, epoch) key", async () => {
    const adapter = new FakeDataAdapter();
    const store = new CrdtDocStore(asDataAdapter(adapter), "vault-rooms/crdt");
    const state = new Uint8Array([1, 2, 3, 4, 5]);

    await store.save("room_1", "Notes/Board.md", 0, state);
    const loaded = await store.load("room_1", "Notes/Board.md", 0);

    expect(loaded).toEqual(state);
  });

  it("does not leak state across different epochs for the same path (epoch is part of the key)", async () => {
    const adapter = new FakeDataAdapter();
    const store = new CrdtDocStore(asDataAdapter(adapter), "vault-rooms/crdt");

    await store.save("room_1", "Notes/Board.md", 0, new Uint8Array([1]));
    // A fresh epoch (e.g. after delete/recreate) must never see the old epoch's persisted bytes.
    expect(await store.load("room_1", "Notes/Board.md", 1)).toBeNull();
  });

  it("does not leak state across different paths that happen to share a room", async () => {
    const adapter = new FakeDataAdapter();
    const store = new CrdtDocStore(asDataAdapter(adapter), "vault-rooms/crdt");

    await store.save("room_1", "Notes/Board.md", 0, new Uint8Array([9]));
    expect(await store.load("room_1", "Notes/Other.md", 0)).toBeNull();
  });

  it("rejects a save exceeding the per-doc quota", async () => {
    const adapter = new FakeDataAdapter();
    const store = new CrdtDocStore(asDataAdapter(adapter), "vault-rooms/crdt");
    const oversized = new Uint8Array(MAX_PERSISTED_CRDT_DOC_BYTES + 1);

    await expect(store.save("room_1", "Notes/Board.md", 0, oversized)).rejects.toBeInstanceOf(CrdtDocStoreQuotaExceededError);
    expect(await store.load("room_1", "Notes/Board.md", 0)).toBeNull();
  });

  it("prunes a prior epoch's persisted entry once a newer epoch is saved for the same path", async () => {
    const adapter = new FakeDataAdapter();
    const store = new CrdtDocStore(asDataAdapter(adapter), "vault-rooms/crdt");

    await store.save("room_1", "Notes/Board.md", 0, new Uint8Array([1]));
    await store.save("room_1", "Notes/Board.md", 1, new Uint8Array([2]));

    expect(await store.load("room_1", "Notes/Board.md", 0)).toBeNull();
    expect(await store.load("room_1", "Notes/Board.md", 1)).toEqual(new Uint8Array([2]));
  });

  it("deleteEpoch removes only the specified epoch's entry, leaving other paths untouched", async () => {
    const adapter = new FakeDataAdapter();
    const store = new CrdtDocStore(asDataAdapter(adapter), "vault-rooms/crdt");

    await store.save("room_1", "Notes/Board.md", 0, new Uint8Array([1]));
    await store.save("room_1", "Notes/Other.md", 0, new Uint8Array([2]));

    await store.deleteEpoch("room_1", "Notes/Board.md", 0);

    expect(await store.load("room_1", "Notes/Board.md", 0)).toBeNull();
    expect(await store.load("room_1", "Notes/Other.md", 0)).toEqual(new Uint8Array([2]));
  });

  it("deleteEpoch is a no-op when nothing was ever persisted for that epoch", async () => {
    const store = new CrdtDocStore(asDataAdapter(new FakeDataAdapter()), "vault-rooms/crdt");
    await expect(store.deleteEpoch("room_1", "Notes/Board.md", 4)).resolves.toBeUndefined();
  });

  it("deleteRoom removes every persisted document for the room, leaving other rooms untouched", async () => {
    const adapter = new FakeDataAdapter();
    const store = new CrdtDocStore(asDataAdapter(adapter), "vault-rooms/crdt");

    await store.save("room_1", "Notes/Board.md", 0, new Uint8Array([1]));
    await store.save("room_1", "Notes/Other.md", 2, new Uint8Array([2]));
    await store.save("room_2", "Notes/Board.md", 0, new Uint8Array([3]));

    await store.deleteRoom("room_1");

    expect(await store.load("room_1", "Notes/Board.md", 0)).toBeNull();
    expect(await store.load("room_1", "Notes/Other.md", 2)).toBeNull();
    expect(await store.load("room_2", "Notes/Board.md", 0)).toEqual(new Uint8Array([3]));
  });

  it("deleteRoom on a room with nothing persisted is a no-op", async () => {
    const store = new CrdtDocStore(asDataAdapter(new FakeDataAdapter()), "vault-rooms/crdt");
    await expect(store.deleteRoom("room_never_used")).resolves.toBeUndefined();
  });

  it("save() writes atomically (temp path never left as the final readable state)", async () => {
    const adapter = new FakeDataAdapter();
    const store = new CrdtDocStore(asDataAdapter(adapter), "vault-rooms/crdt");

    await store.save("room_1", "Notes/Board.md", 0, new Uint8Array([1, 2, 3]));

    for (const key of adapter.store.keys()) {
      expect(key.endsWith(".tmp")).toBe(false);
    }
  });
});
