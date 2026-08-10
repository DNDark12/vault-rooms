import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { RelayRepository } from "../src/db/repositories/relayRepository.js";
import { openSqlJsDb } from "../src/db/sqlJsAdapter.js";
import {
  createContentWriteService,
  decodeTransportContent,
  encodeRawBytesAsTransportContent,
  type ContentWriteService
} from "../src/storage/contentWriteService.js";
import { createInMemoryBlobStore } from "../src/storage/blobStore.js";
import type { BlobStore } from "../src/storage/blobStore.js";

async function createTestRepo() {
  const db = await openSqlJsDb(":memory:");
  runMigrations(db);
  const repo = new RelayRepository(db);
  const room = repo.createRoom({
    name: "Room",
    type: "folder",
    sourcePath: "/vault/room",
    mountName: "room",
    ownerUserId: "usr_owner",
    capabilities: []
  });
  return { db, repo, room };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("createContentWriteService - writeFile", () => {
  it("stores exactly one blob whose bytes equal the decoded payload, for text content", async () => {
    const { db, repo, room } = await createTestRepo();
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore);

    await service.writeFile({ roomId: room.id, relativePath: "note.md", baseVersion: 0, content: "hello world", actorUserId: "usr_owner" });

    const expectedBytes = Buffer.from("hello world", "utf8");
    const expectedKey = sha256Hex(expectedBytes);
    expect(await blobStore.has(expectedKey)).toBe(true);
    expect(await blobStore.get(expectedKey)).toEqual(new Uint8Array(expectedBytes));
    expect((await blobStore.list())).toEqual([expectedKey]);
  });

  it("stores exactly one blob whose bytes equal the decoded payload, for binary (base64) content", async () => {
    const { db, repo, room } = await createTestRepo();
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore);
    const rawBytes = Buffer.from([0, 1, 2, 3, 255, 254]);
    const base64Content = rawBytes.toString("base64");

    await service.writeFile({ roomId: room.id, relativePath: "image.png", baseVersion: 0, content: base64Content, actorUserId: "usr_owner" });

    const expectedKey = sha256Hex(rawBytes);
    expect(await blobStore.get(expectedKey)).toEqual(new Uint8Array(rawBytes));
  });

  it("references the stored blob by its raw-hash key on the metadata row", async () => {
    const { repo, room } = await createTestRepo();
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore);

    await service.writeFile({ roomId: room.id, relativePath: "note.md", baseVersion: 0, content: "hello world", actorUserId: "usr_owner" });

    const file = repo.getFile(room.id, "note.md");
    expect(file).not.toBeNull();
    const version = repo.latestFileVersion(file!.id);
    const expectedKey = sha256Hex(Buffer.from("hello world", "utf8"));
    expect(version?.blob_key).toBe(expectedKey);
  });

  it("stores new content only in the external blob store", async () => {
    const { db, repo, room } = await createTestRepo();
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore);

    await service.writeFile({ roomId: room.id, relativePath: "note.md", baseVersion: 0, content: "outside sqlite", actorUserId: "usr_owner" });

    expect(db.prepare("select 1 from content_blobs limit 1").get()).toBeUndefined();
    expect(repo.getStorageUsageBytes()).toBe(Buffer.byteLength("outside sqlite"));
  });

  it("reports external binary usage in raw stored bytes", async () => {
    const { repo, room } = await createTestRepo();
    const service = createContentWriteService(repo, createInMemoryBlobStore());

    await service.writeFile({ roomId: room.id, relativePath: "image.bin", baseVersion: 0, content: "AQID", actorUserId: "usr_owner" });

    expect(repo.getStorageUsageBytes()).toBe(3);
    expect(repo.getRoomStorageBytes(room.id)).toBe(3);
  });

  it("leaves files.sha256/size_bytes exactly as before - unchanged in the transport domain", async () => {
    const { repo, room } = await createTestRepo();
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore);
    const rawBytes = Buffer.from([10, 20, 30]);
    const base64Content = rawBytes.toString("base64");

    const result = await service.writeFile({ roomId: room.id, relativePath: "blob.bin", baseVersion: 0, content: base64Content, actorUserId: "usr_owner" });

    const file = repo.getFile(room.id, "blob.bin");
    // Transport-domain sha256/size: over the base64 string itself, exactly as writeFile computed
    // it before Phase B - never over the raw decoded bytes the blob store addresses by.
    expect(file?.sha256).toBe(createHash("sha256").update(base64Content).digest("hex"));
    expect(file?.size_bytes).toBe(Buffer.byteLength(base64Content, "utf8"));
    expect(result.sha256).toBe(file?.sha256);
  });

  it("never leaves a dangling metadata reference when the blob store write fails - the write never reaches the repository at all", async () => {
    const { repo, room } = await createTestRepo();
    const failingStore: BlobStore = {
      async put(): Promise<string> {
        throw new Error("simulated disk-full failure");
      },
      async get() {
        return undefined;
      },
      async has() {
        return false;
      },
      async delete() {
        // no-op
      },
      async list() {
        return [];
      }
    };
    const service = createContentWriteService(repo, failingStore);

    await expect(
      service.writeFile({ roomId: room.id, relativePath: "note.md", baseVersion: 0, content: "hello", actorUserId: "usr_owner" })
    ).rejects.toThrow("simulated disk-full failure");

    expect(repo.getFile(room.id, "note.md")).toBeNull();
  });

  it("collects a finalized blob when the metadata transaction rejects", async () => {
    const { repo, room } = await createTestRepo();
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore);
    const first = await service.writeFile({
      roomId: room.id,
      relativePath: "note.md",
      baseVersion: 0,
      content: "v1",
      actorUserId: "usr_owner"
    });

    await expect(
      service.writeFile({
        roomId: room.id,
        relativePath: "note.md",
        baseVersion: first.version - 1,
        content: "rejected",
        actorUserId: "usr_owner"
      })
    ).rejects.toMatchObject({ code: "FILE_EXISTS" });

    expect(await blobStore.has(sha256Hex(Buffer.from("rejected")))).toBe(false);
    expect((await service.readFileContent({ roomId: room.id, relativePath: "note.md" })).content).toBe("v1");
  });

  it("does not reject a committed write when post-commit orphan deletion fails", async () => {
    const { repo, room } = await createTestRepo();
    const backing = createInMemoryBlobStore();
    let failDelete = false;
    const store: BlobStore = {
      put: (bytes) => backing.put(bytes),
      get: (key) => backing.get(key),
      has: (key) => backing.has(key),
      list: () => backing.list(),
      async delete(key) {
        if (failDelete) throw new Error("temporary delete failure");
        await backing.delete(key);
      }
    };
    const service = createContentWriteService(repo, store);
    const first = await service.writeFile({ roomId: room.id, relativePath: "note.md", baseVersion: 0, content: "v1", actorUserId: "usr_owner" });
    failDelete = true;

    await expect(
      service.writeFile({ roomId: room.id, relativePath: "note.md", baseVersion: first.version, content: "v2", actorUserId: "usr_owner" })
    ).resolves.toMatchObject({ version: 2 });
    expect(repo.getFile(room.id, "note.md")?.version).toBe(2);
  });

  it("writes the blob before acquiring the exclusive-access lock - an unrelated operation queued behind withExclusiveAccess is not blocked by a slow blob write", async () => {
    const { repo, room } = await createTestRepo();
    const order: string[] = [];
    let releasePut!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const slowStore: BlobStore = {
      async put(bytes) {
        order.push("put-start");
        await gate;
        order.push("put-end");
        return sha256Hex(bytes);
      },
      async get() {
        return undefined;
      },
      async has() {
        return false;
      },
      async delete() {
        // no-op
      },
      async list() {
        return [];
      }
    };
    const service = createContentWriteService(repo, slowStore);

    const write = service.writeFile({ roomId: room.id, relativePath: "note.md", baseVersion: 0, content: "hello", actorUserId: "usr_owner" });
    // Give the write's blobStore.put() a chance to start (and block on the gate) before the
    // unrelated exclusive-access operation below runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["put-start"]);

    await repo.withExclusiveAccess(() => {
      order.push("unrelated-operation");
    });
    // The unrelated operation completed while the slow put() was still gated - proving the
    // metadata-phase lock was never held (and never even requested) across the blob write.
    expect(order).toEqual(["put-start", "unrelated-operation"]);

    releasePut();
    await write;
    expect(order).toEqual(["put-start", "unrelated-operation", "put-end"]);
    expect(repo.getFile(room.id, "note.md")).not.toBeNull();
  });
});

describe("createContentWriteService - materializeCrdtContent", () => {
  it("stores the materialized text as raw UTF-8 bytes and references them by raw-hash key", async () => {
    const { repo, room } = await createTestRepo();
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore);
    const created = repo.createCrdtFile({ roomId: room.id, relativePath: "live.md", actorUserId: "usr_owner" });

    await service.materializeCrdtContent({ fileId: created.fileId, content: "typed content", actorUserId: "usr_owner" });

    const expectedKey = sha256Hex(Buffer.from("typed content", "utf8"));
    expect(await blobStore.get(expectedKey)).toEqual(new Uint8Array(Buffer.from("typed content", "utf8")));
    const version = repo.latestFileVersion(created.fileId);
    expect(version?.blob_key).toBe(expectedKey);
    expect((await service.readFileContent({ roomId: room.id, relativePath: "live.md" })).content).toBe("typed content");
  });
});

describe("createContentWriteService - readFileContent", () => {
  const BOUNDARY_PAYLOADS: Array<{ label: string; bytes: Buffer }> = [
    { label: "empty", bytes: Buffer.alloc(0) },
    { label: "1 byte", bytes: Buffer.from([0x41]) },
    // Base64 padding varies with length mod 3 - these are exactly where padding mistakes hide.
    { label: "length mod 3 === 0", bytes: Buffer.from("abcdef", "utf8") },
    { label: "length mod 3 === 1", bytes: Buffer.from("abcdefg", "utf8") },
    { label: "length mod 3 === 2", bytes: Buffer.from("abcdefgh", "utf8") },
    { label: "high-entropy binary", bytes: Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 137 + 7) % 256)) },
    { label: "valid UTF-8 text with multi-byte characters", bytes: Buffer.from("héllo wörld 🎉 - vault rooms", "utf8") }
  ];

  it.each(BOUNDARY_PAYLOADS)(
    "round-trips $label through the blob store byte-identically, and the stored sha256 still matches",
    async ({ bytes }) => {
      const { repo, room } = await createTestRepo();
      const blobStore = createInMemoryBlobStore();
      const service = createContentWriteService(repo, blobStore);
      const base64Content = bytes.toString("base64");

      const written = await service.writeFile({ roomId: room.id, relativePath: "blob.bin", baseVersion: 0, content: base64Content, actorUserId: "usr_owner" });
      const { content } = await service.readFileContent({ roomId: room.id, relativePath: "blob.bin" });

      // Byte-identical to what was sent - never re-derived, never re-padded differently.
      expect(content).toBe(base64Content);
      const file = repo.getFile(room.id, "blob.bin");
      expect(file?.sha256).toBe(createHash("sha256").update(content).digest("hex"));
      expect(written.sha256).toBe(file?.sha256);
    }
  );

  it("falls back to the legacy content_blobs-sourced content when blobKey is absent (pre-Phase-B row)", async () => {
    const { repo, room } = await createTestRepo();
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore);
    // Simulates a row written before Phase B: no blobKey, exactly like a direct repo.writeFile()
    // call (still exercised throughout storage-retention.test.ts and friends).
    repo.writeFile({ roomId: room.id, relativePath: "legacy.md", baseVersion: 0, content: "legacy content", actorUserId: "usr_owner" });

    const { content } = await service.readFileContent({ roomId: room.id, relativePath: "legacy.md" });

    expect(content).toBe("legacy content");
  });

  it("fails instead of masking a dangling external reference", async () => {
    const { repo, room } = await createTestRepo();
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore);
    await service.writeFile({ roomId: room.id, relativePath: "note.md", baseVersion: 0, content: "hello", actorUserId: "usr_owner" });
    const version = repo.latestFileVersion(repo.getFile(room.id, "note.md")!.id);
    await blobStore.delete(version!.blob_key!);

    await expect(service.readFileContent({ roomId: room.id, relativePath: "note.md" })).rejects.toThrow("Missing referenced blob");
  });

  it("keeps the referenced blob alive until an in-flight read completes", async () => {
    const { repo, room } = await createTestRepo();
    const backing = createInMemoryBlobStore();
    let blockNextGet = false;
    let releaseGet!: () => void;
    let markGetStarted!: () => void;
    const getGate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    const getStarted = new Promise<void>((resolve) => {
      markGetStarted = resolve;
    });
    const store: BlobStore = {
      put: (bytes) => backing.put(bytes),
      async get(key) {
        if (blockNextGet) {
          blockNextGet = false;
          markGetStarted();
          await getGate;
        }
        return backing.get(key);
      },
      has: (key) => backing.has(key),
      delete: (key) => backing.delete(key),
      list: () => backing.list()
    };
    const service = createContentWriteService(repo, store);
    const first = await service.writeFile({
      roomId: room.id,
      relativePath: "note.md",
      baseVersion: 0,
      content: "v1",
      actorUserId: "usr_owner"
    });
    blockNextGet = true;

    const read = service.readFileContent({ roomId: room.id, relativePath: "note.md" });
    await getStarted;
    const write = service.writeFile({
      roomId: room.id,
      relativePath: "note.md",
      baseVersion: first.version,
      content: "v2",
      actorUserId: "usr_owner"
    });
    const writeState = await Promise.race([
      write.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setImmediate(() => resolve("pending")))
    ]);
    releaseGet();

    const [readResult, writeResult] = await Promise.allSettled([read, write]);
    expect(writeState).toBe("pending");
    expect(readResult).toMatchObject({ status: "fulfilled", value: { content: "v1" } });
    expect(writeResult).toMatchObject({ status: "fulfilled", value: { version: 2 } });
  });
});

describe("createContentWriteService - sweepOrphanedBlobStoreBatch", () => {
  it("leaves a blob alone while any file_versions.blob_key row still references it", async () => {
    const { repo, room } = await createTestRepo();
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore);
    await service.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "still referenced", actorUserId: "usr_owner" });

    const result = await service.sweepOrphanedBlobStoreBatch(10);

    expect(result).toEqual({ processedCount: 0, done: true });
    expect(await blobStore.list()).toHaveLength(1);
  });

  it("deletes a store key with zero referencing file_versions row", async () => {
    const { repo } = await createTestRepo();
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore);
    await blobStore.put(Buffer.from("nobody references this"));

    const result = await service.sweepOrphanedBlobStoreBatch(10);

    expect(result).toEqual({ processedCount: 1, done: true });
    expect(await blobStore.list()).toHaveLength(0);
  });

  it("resumes across multiple bounded batches, and stops reporting done once every current orphan is cleared", async () => {
    const { repo } = await createTestRepo();
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore);
    for (let i = 0; i < 5; i++) {
      await blobStore.put(Buffer.from(`distinct orphan content #${i}`));
    }
    expect(await blobStore.list()).toHaveLength(5);

    let processed = 0;
    let done = false;
    let iterations = 0;
    while (!done) {
      const result = await service.sweepOrphanedBlobStoreBatch(2);
      expect(result.processedCount).toBeLessThanOrEqual(2);
      processed += result.processedCount;
      done = result.done;
      iterations += 1;
      expect(iterations).toBeLessThan(10); // guards against an infinite-loop regression
    }

    expect(processed).toBe(5);
    expect(await blobStore.list()).toHaveLength(0);
  });

  it("reclaims a prior version's blob but never the current version's", async () => {
    const { repo, room } = await createTestRepo();
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore);
    const write1 = await service.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "v1", actorUserId: "usr_owner" });
    await service.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: write1.version, content: "v2", actorUserId: "usr_owner" });
    const v1BlobKey = sha256Hex(Buffer.from("v1", "utf8"));
    expect(await blobStore.has(v1BlobKey)).toBe(false);

    const result = await service.sweepOrphanedBlobStoreBatch(10);

    expect(result).toEqual({ processedCount: 0, done: true });
    expect(await blobStore.has(v1BlobKey)).toBe(false);
    const version = repo.latestFileVersion(repo.getFile(room.id, "a.md")!.id);
    expect(await blobStore.has(version!.blob_key!)).toBe(true);
  });

  it("does not collect a blob between finalize and its metadata commit", async () => {
    const { repo, room } = await createTestRepo();
    const blobStore = createInMemoryBlobStore();
    const originalExclusive = repo.withExclusiveAccess.bind(repo);
    let releaseMetadata!: () => void;
    let metadataQueued!: () => void;
    const metadataReady = new Promise<void>((resolve) => {
      metadataQueued = resolve;
    });
    const metadataGate = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    let delayNextExclusive = true;
    repo.withExclusiveAccess = async <T>(operation: () => T | Promise<T>): Promise<T> => {
      if (delayNextExclusive) {
        delayNextExclusive = false;
        metadataQueued();
        await metadataGate;
      }
      return originalExclusive(operation);
    };
    const service = createContentWriteService(repo, blobStore);

    const write = service.writeFile({ roomId: room.id, relativePath: "note.md", baseVersion: 0, content: "race", actorUserId: "usr_owner" });
    await metadataReady;
    const sweep = service.sweepOrphanedBlobStoreBatch(10);
    await Promise.resolve();
    releaseMetadata();
    await Promise.all([write, sweep]);

    const version = repo.latestFileVersion(repo.getFile(room.id, "note.md")!.id);
    expect(version?.blob_key).toBeTruthy();
    expect(await blobStore.has(version!.blob_key!)).toBe(true);
  });
});

describe("createContentWriteService - deletion", () => {
  it("removes an unshared external blob after deleting its metadata reference", async () => {
    const { repo, room } = await createTestRepo();
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore);
    const written = await service.writeFile({
      roomId: room.id,
      relativePath: "file.bin",
      baseVersion: 0,
      content: Buffer.from([1, 2, 3]).toString("base64"),
      actorUserId: "usr_owner"
    });

    await service.deleteFile({
      roomId: room.id,
      relativePath: "file.bin",
      baseVersion: written.version,
      actorUserId: "usr_owner"
    });

    expect(await blobStore.list()).toEqual([]);
    expect(repo.getStorageUsageBytes()).toBe(0);
  });
});

describe("createContentWriteService - legacy migration", () => {
  it("migrates per reference when text and binary share one legacy row", async () => {
    const { db, repo, room } = await createTestRepo();
    repo.writeFile({ roomId: room.id, relativePath: "note.txt", baseVersion: 0, content: "AQID", actorUserId: "usr_owner" });
    repo.writeFile({ roomId: room.id, relativePath: "image.bin", baseVersion: 0, content: "AQID", actorUserId: "usr_owner" });
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore) as ContentWriteService & {
      migrateLegacyContentBatch(batchSize: number): Promise<{ processedCount: number; done: boolean }>;
    };

    expect(db.prepare("select count(*) as count from content_blobs").get()).toEqual({ count: 1 });
    expect((await service.migrateLegacyContentBatch(1)).processedCount).toBe(1);
    expect(db.prepare("select count(*) as count from content_blobs").get()).toEqual({ count: 1 });
    expect([7, 8]).toContain(repo.getStorageUsageBytes());

    expect(await service.migrateLegacyContentBatch(1)).toEqual({ processedCount: 1, done: true });
    expect(db.prepare("select count(*) as count from content_blobs").get()).toEqual({ count: 0 });
    expect(repo.getStorageUsageBytes()).toBe(7);

    const textVersion = repo.latestFileVersion(repo.getFile(room.id, "note.txt")!.id)!;
    const binaryVersion = repo.latestFileVersion(repo.getFile(room.id, "image.bin")!.id)!;
    expect(textVersion.blob_key).not.toBe(binaryVersion.blob_key);
    expect(await blobStore.get(textVersion.blob_key!)).toEqual(new Uint8Array(Buffer.from("AQID", "utf8")));
    expect(await blobStore.get(binaryVersion.blob_key!)).toEqual(new Uint8Array([1, 2, 3]));
    expect((await service.readFileContent({ roomId: room.id, relativePath: "note.txt" })).content).toBe("AQID");
    expect((await service.readFileContent({ roomId: room.id, relativePath: "image.bin" })).content).toBe("AQID");
  });

  it("does not count a finalized blob until metadata references it", async () => {
    const { repo } = await createTestRepo();
    const blobStore = createInMemoryBlobStore();
    await blobStore.put(Buffer.from("orphan"));

    expect(repo.getStorageUsageBytes()).toBe(0);
  });
});

describe("decodeTransportContent / encodeRawBytesAsTransportContent", () => {
  it("are exact inverses of each other and of the base64/utf8 encoding used on the wire", () => {
    expect(decodeTransportContent("hello", "markdown")).toEqual(Buffer.from("hello", "utf8"));
    expect(decodeTransportContent("hello", "text")).toEqual(Buffer.from("hello", "utf8"));
    const rawBytes = Buffer.from([1, 2, 3, 4, 5]);
    expect(decodeTransportContent(rawBytes.toString("base64"), "binary")).toEqual(rawBytes);

    expect(encodeRawBytesAsTransportContent(Buffer.from("hello", "utf8"), "markdown")).toBe("hello");
    expect(encodeRawBytesAsTransportContent(rawBytes, "binary")).toBe(rawBytes.toString("base64"));
  });
});
