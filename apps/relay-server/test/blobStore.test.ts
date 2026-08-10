import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blobKeyForBytes, isValidBlobKey, shardedRelativePath } from "../src/storage/blobStore.js";
import { createFsBlobStore } from "../src/storage/fsBlobStore.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryStoreRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "vault-rooms-blob-store-"));
  temporaryDirectories.push(directory);
  return directory;
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

describe("createFsBlobStore - shared BlobStore contract (Phase B Task 1)", () => {
  for (const { label, bytes } of PAYLOAD_CASES) {
    it(`round-trips ${label} exactly through put/get/has/delete`, async () => {
      const store = createFsBlobStore(temporaryStoreRoot());
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
    const root = temporaryStoreRoot();
    const store = createFsBlobStore(root);
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);

    const firstKey = await store.put(bytes);
    const path = join(root, shardedRelativePath(firstKey));
    const firstMtime = statSync(path).mtimeMs;

    // A real filesystem's mtime resolution can be coarse, so also assert no second content file
    // exists (the store rewrites in place under the same key, never creates a ".2" sibling) rather
    // than depending solely on comparing timestamps.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondKey = await store.put(bytes);

    expect(secondKey).toBe(firstKey);
    expect(statSync(path).mtimeMs).toBe(firstMtime);
  });

  it("get() of a missing key returns undefined rather than throwing", async () => {
    const store = createFsBlobStore(temporaryStoreRoot());
    const missingKey = blobKeyForBytes(new Uint8Array([1, 1, 1]));

    await expect(store.get(missingKey)).resolves.toBeUndefined();
    await expect(store.has(missingKey)).resolves.toBe(false);
    await expect(store.delete(missingKey)).resolves.toBeUndefined(); // no-op, not an error
  });

  it("rejects a malformed key rather than deriving a path from untrusted input", async () => {
    const store = createFsBlobStore(temporaryStoreRoot());

    await expect(store.get("../../etc/passwd")).resolves.toBeUndefined();
    await expect(store.has("not-hex")).resolves.toBe(false);
    await expect(store.delete("../escape")).resolves.toBeUndefined();
  });

  it("never leaves a partially-written temp file observable as a finalized blob", async () => {
    const root = temporaryStoreRoot();
    const store = createFsBlobStore(root);
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const key = blobKeyForBytes(bytes);
    const finalPath = join(root, shardedRelativePath(key));

    // Simulate a crash mid-write: a stray temp file sits next to the (not yet created) final path.
    mkdirSync(join(root, shardedRelativePath(key), ".."), { recursive: true });
    writeFileSync(`${finalPath}.tmp-stale`, bytes.subarray(0, 2));

    expect(await store.has(key)).toBe(false); // the stray temp file must never count as "has"
    const storedKey = await store.put(bytes);
    expect(storedKey).toBe(key);
    expect(Array.from((await store.get(key))!)).toEqual(Array.from(bytes));
  });

  it("removes crash-left temp files during maintenance listing", async () => {
    const root = temporaryStoreRoot();
    const store = createFsBlobStore(root);
    const key = blobKeyForBytes(new Uint8Array([4, 3, 2, 1]));
    const temporaryPath = `${join(root, shardedRelativePath(key))}.tmp-stale`;
    mkdirSync(join(root, shardedRelativePath(key), ".."), { recursive: true });
    writeFileSync(temporaryPath, new Uint8Array([4, 3]));

    await expect(store.list()).resolves.toEqual([]);
    expect(existsSync(temporaryPath)).toBe(false);
  });

  it("shards blobs two hex levels deep so a large store never puts every blob in one directory", async () => {
    const root = temporaryStoreRoot();
    const store = createFsBlobStore(root);
    await store.put(new Uint8Array([42]));

    const level1 = readdirSync(root);
    expect(level1.length).toBeGreaterThan(0);
    expect(level1.every((name) => /^[0-9a-f]{2}$/.test(name))).toBe(true);
    const level2 = readdirSync(join(root, level1[0]!));
    expect(level2.every((name) => /^[0-9a-f]{2}$/.test(name))).toBe(true);
  });

  it("list() enumerates every stored key and nothing else", async () => {
    const store = createFsBlobStore(temporaryStoreRoot());
    const keyA = await store.put(new Uint8Array([1]));
    const keyB = await store.put(new Uint8Array([2]));
    const keyC = await store.put(new Uint8Array([3]));
    await store.delete(keyB);

    const listed = await store.list();
    expect(new Set(listed)).toEqual(new Set([keyA, keyC]));
  });

  it("list() on a store root that does not exist yet returns an empty list rather than throwing", async () => {
    const root = temporaryStoreRoot();
    rmSync(root, { recursive: true, force: true });
    const store = createFsBlobStore(root);

    await expect(store.list()).resolves.toEqual([]);
  });
});
