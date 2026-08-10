import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import { blobKeyForBytes, isValidBlobKey, shardedRelativePath } from "vault-rooms-relay/embedded-core";
import { createDataAdapterBlobStore } from "./dataAdapterBlobStore.js";

/** In-memory DataAdapter used by the blob-store contract tests. */
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
    this.store.delete(path);
    this.folders.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const data = this.store.get(from);
    if (!data) throw new Error(`Missing file: ${from}`);
    if (this.store.has(to)) throw new Error("Destination file already exists!");
    this.store.set(to, data);
    this.store.delete(from);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    const files: string[] = [];
    const folderSet = new Set<string>();
    for (const key of this.store.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slashIndex = rest.indexOf("/");
      if (slashIndex === -1) {
        files.push(key);
      } else {
        folderSet.add(`${path}/${rest.slice(0, slashIndex)}`);
      }
    }
    for (const folder of this.folders) {
      if (folder.startsWith(prefix) && !folder.slice(prefix.length).includes("/")) {
        folderSet.add(folder);
      }
    }
    return { files, folders: [...folderSet] };
  }
}

function asDataAdapter(adapter: FakeDataAdapter): DataAdapter {
  return adapter as unknown as DataAdapter;
}

/** Raw-byte cases include both base64 padding boundaries. */
const PAYLOAD_CASES: Array<{ label: string; bytes: Uint8Array }> = [
  { label: "empty", bytes: new Uint8Array(0) },
  { label: "one byte", bytes: new Uint8Array([7]) },
  { label: "three bytes", bytes: new Uint8Array([1, 2, 3]) },
  { label: "four bytes (mod 3 = 1)", bytes: new Uint8Array([1, 2, 3, 4]) },
  { label: "five bytes (mod 3 = 2)", bytes: new Uint8Array([1, 2, 3, 4, 5]) },
  { label: "high-entropy binary", bytes: new Uint8Array(4096).map((_, i) => (i * 2654435761) % 256) }
];

describe("createDataAdapterBlobStore - shared BlobStore contract (Phase B Task 1)", () => {
  for (const { label, bytes } of PAYLOAD_CASES) {
    it(`round-trips ${label} exactly through put/get/has/delete`, async () => {
      const store = createDataAdapterBlobStore(asDataAdapter(new FakeDataAdapter()), "vault-rooms/blobs");
      const key = await store.put(bytes);

      expect(isValidBlobKey(key)).toBe(true);
      expect(key).toBe(blobKeyForBytes(bytes));
      expect(await store.has(key)).toBe(true);
      const roundTripped = await store.get(key);
      expect(roundTripped).toBeDefined();
      expect(Array.from(roundTripped!)).toEqual(Array.from(bytes));

      await store.delete(key);
      expect(await store.has(key)).toBe(false);
      expect(await store.get(key)).toBeUndefined();
    });
  }

  it("is idempotent: putting identical content twice returns the same key and does not rewrite the file", async () => {
    const adapter = new FakeDataAdapter();
    const store = createDataAdapterBlobStore(asDataAdapter(adapter), "vault-rooms/blobs");
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);

    const firstKey = await store.put(bytes);
    const writesAfterFirst = adapter.writeBinaryCalls;
    expect(writesAfterFirst).toBeGreaterThan(0);

    const secondKey = await store.put(bytes);

    expect(secondKey).toBe(firstKey);
    expect(adapter.writeBinaryCalls).toBe(writesAfterFirst); // no second write for identical content
  });

  it("get() of a missing key returns undefined rather than throwing", async () => {
    const store = createDataAdapterBlobStore(asDataAdapter(new FakeDataAdapter()), "vault-rooms/blobs");
    const missingKey = blobKeyForBytes(new Uint8Array([1, 1, 1]));

    await expect(store.get(missingKey)).resolves.toBeUndefined();
    await expect(store.has(missingKey)).resolves.toBe(false);
    await expect(store.delete(missingKey)).resolves.toBeUndefined(); // no-op, not an error
  });

  it("rejects a malformed key rather than deriving a path from untrusted input", async () => {
    const store = createDataAdapterBlobStore(asDataAdapter(new FakeDataAdapter()), "vault-rooms/blobs");

    await expect(store.get("../../etc/passwd")).resolves.toBeUndefined();
    await expect(store.has("not-hex")).resolves.toBe(false);
    await expect(store.delete("../escape")).resolves.toBeUndefined();
  });

  it("never leaves a partially-written temp file observable as a finalized blob", async () => {
    const adapter = new FakeDataAdapter();
    const store = createDataAdapterBlobStore(asDataAdapter(adapter), "vault-rooms/blobs");
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const key = blobKeyForBytes(bytes);
    const finalPath = `vault-rooms/blobs/${shardedRelativePath(key)}`;

    // Simulate a crash mid-write: a stray temp file sits next to the (not yet created) final path.
    adapter.store.set(`${finalPath}.create-tmp`, new Uint8Array([1, 2]).buffer);

    expect(await store.has(key)).toBe(false); // the stray temp file must never count as "has"
    const storedKey = await store.put(bytes);
    expect(storedKey).toBe(key);
    expect(Array.from((await store.get(key))!)).toEqual(Array.from(bytes));
    expect(adapter.store.has(`${finalPath}.create-tmp`)).toBe(false); // cleaned up, not left behind
  });

  it("removes crash-left temp files during maintenance listing", async () => {
    const adapter = new FakeDataAdapter();
    const store = createDataAdapterBlobStore(asDataAdapter(adapter), "vault-rooms/blobs");
    const key = blobKeyForBytes(new Uint8Array([4, 3, 2, 1]));
    const relativePath = shardedRelativePath(key);
    const [level1, level2] = relativePath.split("/");
    const temporaryPath = `vault-rooms/blobs/${relativePath}.create-tmp`;
    adapter.folders.add("vault-rooms/blobs");
    adapter.folders.add(`vault-rooms/blobs/${level1}`);
    adapter.folders.add(`vault-rooms/blobs/${level1}/${level2}`);
    adapter.store.set(temporaryPath, new Uint8Array([4, 3]).buffer);

    await expect(store.list()).resolves.toEqual([]);
    expect(adapter.store.has(temporaryPath)).toBe(false);
  });

  it("shards blobs two hex levels deep so a large store never puts every blob in one directory", async () => {
    const adapter = new FakeDataAdapter();
    const store = createDataAdapterBlobStore(asDataAdapter(adapter), "vault-rooms/blobs");
    const key = await store.put(new Uint8Array([42]));

    expect(shardedRelativePath(key)).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    expect(adapter.store.has(`vault-rooms/blobs/${shardedRelativePath(key)}`)).toBe(true);
  });

  it("list() enumerates every stored key and nothing else", async () => {
    const store = createDataAdapterBlobStore(asDataAdapter(new FakeDataAdapter()), "vault-rooms/blobs");
    const keyA = await store.put(new Uint8Array([1]));
    const keyB = await store.put(new Uint8Array([2]));
    const keyC = await store.put(new Uint8Array([3]));
    await store.delete(keyB);

    const listed = await store.list();
    expect(new Set(listed)).toEqual(new Set([keyA, keyC]));
  });

  it("list() on a store root that does not exist yet returns an empty list rather than throwing", async () => {
    const store = createDataAdapterBlobStore(asDataAdapter(new FakeDataAdapter()), "vault-rooms/blobs");

    await expect(store.list()).resolves.toEqual([]);
  });

  it("does not hide listing failures from storage maintenance", async () => {
    const adapter = new FakeDataAdapter();
    const store = createDataAdapterBlobStore(asDataAdapter(adapter), "vault-rooms/blobs");
    await store.put(new Uint8Array([1]));
    adapter.list = async () => {
      throw new Error("adapter unavailable");
    };

    await expect(store.list()).rejects.toThrow("adapter unavailable");
  });
});
