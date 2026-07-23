import { describe, expect, it } from "vitest";
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

describe("CrdtDocStore", () => {
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
