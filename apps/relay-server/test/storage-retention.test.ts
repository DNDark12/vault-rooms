import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createId, portablePathKey } from "@vault-rooms/protocol";
import { recomputeStorageUsage, runMigrations } from "../src/db/migrations.js";
import { RelayRepository } from "../src/db/repositories/relayRepository.js";
import { openSqlJsDb, type RelayDb } from "../src/db/sqlJsAdapter.js";
import { scheduleStorageBackfill, type StorageMaintenanceTimerHost } from "../src/services/storageMaintenance.js";
import { createContentWriteService } from "../src/storage/contentWriteService.js";
import { createInMemoryBlobStore } from "../src/storage/blobStore.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A real on-disk path, not ":memory:" - lets a test close and reopen a genuinely durable image
 *  instead of just constructing a second repository over the same in-memory database object. */
function temporaryDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "vault-rooms-storage-retention-"));
  temporaryDirectories.push(directory);
  return join(directory, "relay.sqlite");
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** A real, distinct raw-byte payload of the given size, base64-encoded exactly as the binary
 *  transport lane (contentTypeForPath) encodes it on the wire. */
function randomBase64Payload(rawSizeBytes: number): string {
  return randomBytes(rawSizeBytes).toString("base64");
}

async function createTestRepo(maxStoredContentBytes?: number): Promise<{ db: RelayDb; repo: RelayRepository }> {
  const db = await openSqlJsDb(":memory:");
  runMigrations(db);
  const repo = new RelayRepository(db, maxStoredContentBytes);
  return { db, repo };
}

function hasIndex(db: RelayDb, name: string): boolean {
  return Boolean(db.prepare("select name from sqlite_master where type = 'index' and name = ?").get(name));
}

function columnNames(db: RelayDb, table: string): string[] {
  return (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe("storage retention schema and usage accounting (Phase A Task 1)", () => {
  it("gives a fresh database the new columns, the index, and a zeroed storage_usage row", async () => {
    const { db } = await createTestRepo();

    expect(columnNames(db, "files")).toContain("raw_size_bytes");
    expect(columnNames(db, "file_versions")).toContain("raw_size_bytes");
    expect(hasIndex(db, "idx_file_versions_storage_key")).toBe(true);

    const usage = db.prepare("select * from storage_usage where id = 1").get() as
      | { id: number; blob_bytes: number; recomputed_at: string }
      | undefined;
    expect(usage).toBeDefined();
    expect(usage?.blob_bytes).toBe(0);
    expect(typeof usage?.recomputed_at).toBe("string");

    await db.close();
  });

  it("adds the new columns/index/row to a database created at the previous shape, without losing rows", async () => {
    const db = await openSqlJsDb(":memory:");
    // Simulate a legacy database without retention columns or usage accounting.
    db.exec(`
      create table teams(
        id text primary key, slug text unique not null, name text not null,
        owner_user_id text not null, created_at text not null, updated_at text not null
      );
      create table users(
        id text primary key, display_name text not null, revoked_at text,
        created_at text not null, updated_at text not null
      );
      create table rooms(
        id text primary key, name text not null, type text not null, source_path text not null,
        mount_name text not null, owner_user_id text not null,
        conflict_policy text not null default 'keep_both',
        created_at text not null, updated_at text not null,
        unique(owner_user_id, mount_name)
      );
      create table files(
        id text primary key, room_id text not null, relative_path text not null, kind text not null,
        content_type text not null, version integer not null, sha256 text, size_bytes integer,
        deleted_at text, updated_by_user_id text, updated_at text not null, created_at text not null,
        unique(room_id, relative_path)
      );
      create table file_versions(
        id text primary key, file_id text not null, version integer not null, sha256 text not null,
        size_bytes integer not null, content_storage_key text not null,
        created_by_user_id text not null, created_at text not null,
        unique(file_id, version)
      );
      create table content_blobs(
        storage_key text primary key, content text not null, created_at text not null
      );
      insert into users values ('usr_owner', 'Owner', null, 'now', 'now');
      insert into rooms values ('room_1', 'Room', 'folder', '/vault/room', 'room', 'usr_owner', 'keep_both', 'now', 'now');
      insert into files values (
        'fil_1', 'room_1', 'note.md', 'file', 'markdown', 1, 'abc', 5, null, 'usr_owner', 'now', 'now'
      );
      insert into file_versions values ('ver_1', 'fil_1', 1, 'abc', 5, 'sha256:abc', 'usr_owner', 'now');
      insert into content_blobs values ('sha256:abc', 'hello', 'now');
    `);

    runMigrations(db);

    expect(columnNames(db, "files")).toContain("raw_size_bytes");
    expect(columnNames(db, "file_versions")).toContain("raw_size_bytes");
    expect(hasIndex(db, "idx_file_versions_storage_key")).toBe(true);

    // Existing rows survive untouched, with the new column present but unbackfilled (null).
    const file = db.prepare("select * from files where id = 'fil_1'").get() as {
      raw_size_bytes: number | null;
      relative_path: string;
    };
    expect(file.relative_path).toBe("note.md");
    expect(file.raw_size_bytes).toBeNull();
    const version = db.prepare("select * from file_versions where id = 'ver_1'").get() as {
      raw_size_bytes: number | null;
    };
    expect(version.raw_size_bytes).toBeNull();

    await db.close();
  });

  it("does not count unreferenced legacy blobs after migration", async () => {
    const db = await openSqlJsDb(":memory:");
    db.exec(`
      create table content_blobs(
        storage_key text primary key, content text not null, created_at text not null
      );
      insert into content_blobs values ('sha256:a', 'hello', 'now');
      insert into content_blobs values ('sha256:b', 'a longer piece of content here', 'now');
    `);

    runMigrations(db);

    const usage = db.prepare("select blob_bytes from storage_usage where id = 1").get() as { blob_bytes: number };
    expect(usage.blob_bytes).toBe(0);

    await db.close();
  });

  it("recomputeStorageUsage is an exact recount, safe to call repeatedly", async () => {
    const { db } = await createTestRepo();
    db.exec("insert into content_blobs values ('sha256:x', 'abcde', 'now')");
    recomputeStorageUsage(db);
    let usage = db.prepare("select blob_bytes from storage_usage where id = 1").get() as { blob_bytes: number };
    expect(usage.blob_bytes).toBe(0);

    recomputeStorageUsage(db);
    usage = db.prepare("select blob_bytes from storage_usage where id = 1").get() as { blob_bytes: number };
    expect(usage.blob_bytes).toBe(0);

    await db.close();
  });
});

describe("raw_size_bytes and storage_usage bookkeeping on write (Phase A Task 1)", () => {
  it("records the real decoded size on files and file_versions for markdown/text content", async () => {
    const { repo } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    repo.writeFile({ roomId: room.id, relativePath: "note.md", baseVersion: 0, content: "hello", actorUserId: "usr_owner" });

    const file = repo.getFile(room.id, "note.md");
    expect(file?.raw_size_bytes).toBe(Buffer.byteLength("hello", "utf8"));
  });

  it("records the decoded (not transport) size for binary content", async () => {
    const { repo } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const rawBytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const base64Content = rawBytes.toString("base64");
    repo.writeFile({ roomId: room.id, relativePath: "image.png", baseVersion: 0, content: base64Content, actorUserId: "usr_owner" });

    const file = repo.getFile(room.id, "image.png");
    // Base64 transport bytes exceed the decoded file size.
    expect(file?.size_bytes).toBe(Buffer.byteLength(base64Content, "utf8"));
    expect(file?.raw_size_bytes).toBe(rawBytes.length);
    expect(file?.raw_size_bytes).toBeLessThan(file?.size_bytes ?? Infinity);
  });

  it("grows storage_usage by the stored (transport) byte length exactly once per distinct blob", async () => {
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const before = repo.getStorageUsageBytes();
    repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "shared content", actorUserId: "usr_owner" });
    const afterFirst = repo.getStorageUsageBytes();
    expect(afterFirst - before).toBe(Buffer.byteLength("shared content", "utf8"));

    // A second file with byte-identical content dedupes onto the same blob - zero new bytes.
    repo.writeFile({ roomId: room.id, relativePath: "b.md", baseVersion: 0, content: "shared content", actorUserId: "usr_owner" });
    const afterSecond = repo.getStorageUsageBytes();
    expect(afterSecond).toBe(afterFirst);

    // Matches a full recount from content_blobs.
    recomputeStorageUsage(db);
    expect(repo.getStorageUsageBytes()).toBe(afterSecond);
  });

  it("keeps raw_size_bytes and storage_usage correct across a CRDT create and materialize", async () => {
    const { repo } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const before = repo.getStorageUsageBytes();
    const created = repo.createCrdtFileIdempotent({
      roomId: room.id,
      relativePath: "note.md",
      actorUserId: "usr_owner",
      operationId: "op_1",
      deviceId: "dev_1"
    });
    const afterCreate = repo.getFileById(created.result.fileId);
    expect(afterCreate?.raw_size_bytes).toBe(0);
    // The globally deduplicated empty blob may already exist.
    expect(repo.getStorageUsageBytes()).toBeGreaterThanOrEqual(before);

    repo.materializeCrdtContent({ fileId: created.result.fileId, epoch: created.result.epoch, content: "typed content", actorUserId: "usr_owner" });
    const afterMaterialize = repo.getFileById(created.result.fileId);
    expect(afterMaterialize?.raw_size_bytes).toBe(Buffer.byteLength("typed content", "utf8"));
  });
});

function fileVersionCount(db: RelayDb, fileId: string): number {
  return (db.prepare("select count(*) as n from file_versions where file_id = ?").get(fileId) as { n: number }).n;
}

function blobCount(db: RelayDb): number {
  return (db.prepare("select count(*) as n from content_blobs").get() as { n: number }).n;
}

function recount(db: RelayDb): number {
  const row = db.prepare("select sum(length(cast(content as blob))) as total from content_blobs").get() as { total: number | null };
  return row?.total ?? 0;
}

describe("latest-only retention and reference-checked blob collection (Phase A Task 2)", () => {
  it("leaves exactly one file_versions row and one blob after many writes of distinct content - fast logic-level check (gates 1-3)", async () => {
    // Payload size does not affect the retention invariant itself; see the next test for the
    // milestone's actual acceptance-gate payload scale (~4.9 MiB binaries).
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    let write = repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "v0", actorUserId: "usr_owner" });
    const fileId = repo.getFile(room.id, "a.md")!.id;
    for (let i = 1; i < 100; i++) {
      write = repo.writeFile({
        roomId: room.id,
        relativePath: "a.md",
        baseVersion: write.version,
        content: `distinct content #${i}`,
        actorUserId: "usr_owner"
      });
    }

    expect(fileVersionCount(db, fileId)).toBe(1);
    expect(blobCount(db)).toBe(1);
    expect(repo.getStorageUsageBytes()).toBe(recount(db));
  });

  it(
    "keeps blob usage bounded across 100 writes of a distinct ~4.9 MiB binary payload, at the milestone's actual acceptance scale (gates 1, 3)",
    async () => {
      const { repo, db } = await createTestRepo();
      const room = repo.createRoom({
        name: "Room",
        type: "folder",
        sourcePath: "/vault/room",
        mountName: "room",
        ownerUserId: "usr_owner",
        capabilities: []
      });
      // .bin has no eligible-text extension, so this travels the same base64 binary lane real
      // audio/video/Office payloads use (contentTypeForPath) - a plain string of equivalent length
      // would only exercise the markdown/text lane, not the one gate 1 is actually about.
      const rawSizeBytes = Math.round(4.9 * 1024 * 1024);
      let write = repo.writeFile({
        roomId: room.id,
        relativePath: "asset.bin",
        baseVersion: 0,
        content: randomBase64Payload(rawSizeBytes),
        actorUserId: "usr_owner"
      });
      const fileId = repo.getFile(room.id, "asset.bin")!.id;
      for (let i = 1; i < 100; i++) {
        write = repo.writeFile({
          roomId: room.id,
          relativePath: "asset.bin",
          baseVersion: write.version,
          content: randomBase64Payload(rawSizeBytes),
          actorUserId: "usr_owner"
        });
      }

      expect(fileVersionCount(db, fileId)).toBe(1);
      expect(blobCount(db)).toBe(1);
      expect(repo.getStorageUsageBytes()).toBe(recount(db));
      // The bound is the transport size of the single retained ~4.9 MiB payload, not O(writes).
      expect(repo.getStorageUsageBytes()).toBe(Buffer.byteLength(write.content, "utf8"));
      expect(repo.getStorageUsageBytes()).toBeLessThan(10 * 1024 * 1024); // nowhere near 100x a single payload
    },
    20000 // ~4.9 MiB x 100 real payloads take longer than the tiny-string unit test above
  );

  it("keeps a shared blob alive when pruning one file's history, and reclaims once both are gone (gate 5)", async () => {
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "shared", actorUserId: "usr_owner" });
    repo.writeFile({ roomId: room.id, relativePath: "b.md", baseVersion: 0, content: "shared", actorUserId: "usr_owner" });
    expect(blobCount(db)).toBe(1);
    const usageWithBoth = repo.getStorageUsageBytes();

    // b.md still references the shared blob.
    repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 1, content: "a's own new content", actorUserId: "usr_owner" });
    expect(blobCount(db)).toBe(2); // "shared" (still referenced by b) + "a's own new content"
    expect(repo.getStorageUsageBytes()).toBe(recount(db));
    expect(repo.getStorageUsageBytes()).toBeGreaterThan(usageWithBoth - Buffer.byteLength("shared", "utf8"));

    // The final reference is removed.
    repo.writeFile({ roomId: room.id, relativePath: "b.md", baseVersion: 1, content: "b's own new content", actorUserId: "usr_owner" });
    const row = db.prepare("select 1 from content_blobs where storage_key = ?").get(`sha256:${sha256Hex("shared")}`);
    expect(row).toBeUndefined();
    expect(repo.getStorageUsageBytes()).toBe(recount(db));
  });

  it("keeps a blob alive across two versions of the same file that share it (content reverted, then changed)", async () => {
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    let write = repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "original", actorUserId: "usr_owner" });
    write = repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: write.version, content: "changed", actorUserId: "usr_owner" });
    write = repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: write.version, content: "original", actorUserId: "usr_owner" });

    expect(blobCount(db)).toBe(1);
    const row = db.prepare("select 1 from content_blobs where storage_key = ?").get(`sha256:${sha256Hex("original")}`);
    expect(row).toBeDefined();
    expect(repo.getStorageUsageBytes()).toBe(recount(db));

    repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: write.version, content: "final", actorUserId: "usr_owner" });
    expect(blobCount(db)).toBe(1);
    expect(repo.getStorageUsageBytes()).toBe(recount(db));
  });

  it("applies the same pruning to the CRDT materialize path, so a materialized note does not accumulate versions", async () => {
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const created = repo.createCrdtFileIdempotent({
      roomId: room.id,
      relativePath: "note.md",
      actorUserId: "usr_owner",
      operationId: "op_1",
      deviceId: "dev_1"
    });
    for (let i = 0; i < 20; i++) {
      repo.materializeCrdtContent({ fileId: created.result.fileId, epoch: created.result.epoch, content: `typed content #${i}`, actorUserId: "usr_owner" });
    }

    expect(fileVersionCount(db, created.result.fileId)).toBe(1);
    expect(repo.getStorageUsageBytes()).toBe(recount(db));
  });
});

describe("reclaim on tombstone, rename, and room delete (Phase A Task 3)", () => {
  it("prunes remaining versions and reclaims blobs on file delete (gate 4)", async () => {
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const write = repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "gone soon", actorUserId: "usr_owner" });
    const fileId = repo.getFile(room.id, "a.md")!.id;
    expect(blobCount(db)).toBeGreaterThan(0);

    repo.deleteFile({ roomId: room.id, relativePath: "a.md", baseVersion: write.version, actorUserId: "usr_owner" });

    expect(fileVersionCount(db, fileId)).toBe(0);
    expect(blobCount(db)).toBe(0);
    expect(repo.getStorageUsageBytes()).toBe(0);
    expect(repo.getStorageUsageBytes()).toBe(recount(db));
  });

  it("does not reclaim a blob a delete's file still shares with another live file", async () => {
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const write = repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "shared", actorUserId: "usr_owner" });
    repo.writeFile({ roomId: room.id, relativePath: "b.md", baseVersion: 0, content: "shared", actorUserId: "usr_owner" });

    repo.deleteFile({ roomId: room.id, relativePath: "a.md", baseVersion: write.version, actorUserId: "usr_owner" });

    const row = db.prepare("select 1 from content_blobs where storage_key = ?").get(`sha256:${sha256Hex("shared")}`);
    expect(row).toBeDefined();
    expect(repo.getStorageUsageBytes()).toBe(recount(db));
  });

  it("collects the tombstoned target's blobs when a rename lands on a previously-deleted path", async () => {
    // Simulate a legacy tombstone that still owns version rows.
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const targetWrite = repo.writeFile({ roomId: room.id, relativePath: "target.md", baseVersion: 0, content: "old dead content", actorUserId: "usr_owner" });
    const targetFileId = repo.getFile(room.id, "target.md")!.id;
    // Legacy deletion left the blob reference behind.
    db.prepare("update files set deleted_at = ? where id = ?").run(new Date().toISOString(), targetFileId);
    expect(fileVersionCount(db, targetFileId)).toBe(1);
    const blobBefore = db.prepare("select 1 from content_blobs where storage_key = ?").get(`sha256:${sha256Hex("old dead content")}`);
    expect(blobBefore).toBeDefined();
    recomputeStorageUsage(db); // the direct SQL above bypassed storage_usage bookkeeping on purpose

    repo.writeFile({ roomId: room.id, relativePath: "other.md", baseVersion: 0, content: "still alive", actorUserId: "usr_owner" });
    repo.renameFile({ roomId: room.id, oldRelativePath: "other.md", relativePath: "target.md", actorUserId: "usr_owner" });

    expect(fileVersionCount(db, targetFileId)).toBe(0);
    const blobAfter = db.prepare("select 1 from content_blobs where storage_key = ?").get(`sha256:${sha256Hex("old dead content")}`);
    expect(blobAfter).toBeUndefined();
    expect(repo.getFile(room.id, "target.md")?.relative_path).toBe("target.md");
    expect(repo.getStorageUsageBytes()).toBe(recount(db));
  });

  it("prunes versions and reclaims unshared blobs on room delete, but keeps a blob another room still references", async () => {
    const { repo, db } = await createTestRepo();
    const roomA = repo.createRoom({
      name: "Room A",
      type: "folder",
      sourcePath: "/vault/roomA",
      mountName: "roomA",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const roomB = repo.createRoom({
      name: "Room B",
      type: "folder",
      sourcePath: "/vault/roomB",
      mountName: "roomB",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    repo.writeFile({ roomId: roomA.id, relativePath: "a.md", baseVersion: 0, content: "cross-room shared", actorUserId: "usr_owner" });
    repo.writeFile({ roomId: roomA.id, relativePath: "unique.md", baseVersion: 0, content: "only in room A", actorUserId: "usr_owner" });
    repo.writeFile({ roomId: roomB.id, relativePath: "b.md", baseVersion: 0, content: "cross-room shared", actorUserId: "usr_owner" });

    repo.deleteRoom({ roomId: roomA.id, actorUserId: "usr_owner" });

    expect(repo.listFiles(roomA.id)).toHaveLength(0);
    const uniqueGone = db.prepare("select 1 from content_blobs where storage_key = ?").get(`sha256:${sha256Hex("only in room A")}`);
    expect(uniqueGone).toBeUndefined();
    const sharedSurvives = db.prepare("select 1 from content_blobs where storage_key = ?").get(`sha256:${sha256Hex("cross-room shared")}`);
    expect(sharedSurvives).toBeDefined();
    expect(repo.getFile(roomB.id, "b.md")).not.toBeNull();
    expect(repo.getStorageUsageBytes()).toBe(recount(db));
  });
});

describe("projected quota inside writeFile's transaction (Phase A Task 4)", () => {
  it("rejects a write that genuinely increases usage past the ceiling, with no mutation and no usage change", async () => {
    const { repo, db } = await createTestRepo(20);
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "0123456789", actorUserId: "usr_owner" });
    const usageBefore = repo.getStorageUsageBytes();

    expect(() =>
      repo.writeFile({ roomId: room.id, relativePath: "b.md", baseVersion: 0, content: "this is definitely over twenty bytes", actorUserId: "usr_owner" })
    ).toThrowError(expect.objectContaining({ code: "STORAGE_QUOTA_EXCEEDED" }));

    expect(repo.getFile(room.id, "b.md")).toBeNull();
    expect(repo.getStorageUsageBytes()).toBe(usageBefore);
    expect(repo.getStorageUsageBytes()).toBe(recount(db));
  });

  it("accepts a replacement that shrinks usage while already over the limit, and the store stays over the limit afterward", async () => {
    // Seed content before applying a newly lowered limit.
    const db = await openSqlJsDb(":memory:");
    runMigrations(db);
    const seedRepo = new RelayRepository(db, Number.MAX_SAFE_INTEGER);
    const room = seedRepo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const bigWrite = seedRepo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "way way way over the configured limit", actorUserId: "usr_owner" });

    const repo = new RelayRepository(db, 20);
    const usageOverLimit = repo.getStorageUsageBytes();
    expect(usageOverLimit).toBeGreaterThan(20);

    // Shrinking replacements must remain available above the limit.
    repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: bigWrite.version, content: "smaller but still large content", actorUserId: "usr_owner" });

    expect(repo.getStorageUsageBytes()).toBeGreaterThan(20);
  });

  it("does not double-count a write whose payload is already stored (dedup)", async () => {
    const { repo } = await createTestRepo(20);
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "0123456789012345", actorUserId: "usr_owner" });
    const usageAfterFirst = repo.getStorageUsageBytes();
    expect(usageAfterFirst).toBeLessThanOrEqual(20);

    // Deduplication allocates no additional bytes.
    expect(() =>
      repo.writeFile({ roomId: room.id, relativePath: "b.md", baseVersion: 0, content: "0123456789012345", actorUserId: "usr_owner" })
    ).not.toThrow();
    expect(repo.getStorageUsageBytes()).toBe(usageAfterFirst);
  });

  it("judges a write that supersedes a version on its net effect after the superseded blob is reclaimed", async () => {
    const { repo } = await createTestRepo(20);
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const write = repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "0123456789012345", actorUserId: "usr_owner" });
    // Same-size replacement has zero net growth after reclaim.
    expect(() =>
      repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: write.version, content: "fedcba9876543210", actorUserId: "usr_owner" })
    ).not.toThrow();
  });

  it("cannot be crossed by two concurrent writes that each pass the check (no route-level TOCTOU)", async () => {
    // The standalone path exposes repository-level quota races. Calling writeA() then writeB()
    // back-to-back is not a simplification of "concurrent" here, it is the strongest test this
    // architecture admits: assertQuotaAllows runs inside the very same this.db.transaction(...) as
    // the version-check and insert (fileRepository.ts's writeFile), and that transaction body is
    // fully synchronous with no internal await. Node has no preemptive threading, so nothing can
    // interleave two synchronous function calls - two Fastify route handlers each awaiting
    // repo.writeFile() concurrently still execute writeA's entire transaction before writeB's can
    // begin. The test below drives that same guarantee through actual async call sites (Promise.all
    // over two deferred writes) to demonstrate it holds however the caller schedules the two writes,
    // not just when called in the exact order below.
    const { repo } = await createTestRepo(30);
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const writeA = () => repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "0".repeat(20), actorUserId: "usr_owner" });
    const writeB = () => repo.writeFile({ roomId: room.id, relativePath: "b.md", baseVersion: 0, content: "1".repeat(20), actorUserId: "usr_owner" });

    writeA();
    expect(() => writeB()).toThrowError(expect.objectContaining({ code: "STORAGE_QUOTA_EXCEEDED" }));
    expect(repo.getStorageUsageBytes()).toBe(20);
  });

  it("still cannot be crossed when both writes are dispatched from concurrent async call sites (Promise.all), not called back-to-back", async () => {
    const { repo } = await createTestRepo(30);
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    // A microtask hop before each write, so both "requests" are genuinely in flight (neither has
    // started its transaction yet) before either resolves - as close to two real concurrent async
    // route handlers as a single-threaded runtime allows.
    const writeA = async () => {
      await Promise.resolve();
      return repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "0".repeat(20), actorUserId: "usr_owner" });
    };
    const writeB = async () => {
      await Promise.resolve();
      return repo.writeFile({ roomId: room.id, relativePath: "b.md", baseVersion: 0, content: "1".repeat(20), actorUserId: "usr_owner" });
    };

    const results = await Promise.allSettled([writeA(), writeB()]);
    const succeeded = results.filter((result) => result.status === "fulfilled");
    const failed = results.filter((result) => result.status === "rejected");

    expect(succeeded).toHaveLength(1); // exactly one of the two crosses the ceiling and must be rejected
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED" });
    expect(repo.getStorageUsageBytes()).toBe(20); // the ceiling (30) was never crossed
  });

  it("still allows reads, deletes, room delete, and GC over the limit", async () => {
    // Seed content before applying a newly lowered limit.
    const db = await openSqlJsDb(":memory:");
    runMigrations(db);
    const seedRepo = new RelayRepository(db, Number.MAX_SAFE_INTEGER);
    const room = seedRepo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    seedRepo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "well over ten bytes of content", actorUserId: "usr_owner" });

    const repo = new RelayRepository(db, 10);
    const write = repo.getFile(room.id, "a.md")!;
    expect(repo.getStorageUsageBytes()).toBeGreaterThan(10);

    expect(() => repo.readFileContent(room.id, "a.md")).not.toThrow();
    expect(repo.listFiles(room.id)).toHaveLength(1);

    expect(() => repo.deleteFile({ roomId: room.id, relativePath: "a.md", baseVersion: write.version, actorUserId: "usr_owner" })).not.toThrow();
    expect(repo.getStorageUsageBytes()).toBe(0);

    // Seed another over-limit file through the uncapped repository.
    seedRepo.writeFile({ roomId: room.id, relativePath: "b.md", baseVersion: 0, content: "well over ten bytes again", actorUserId: "usr_owner" });
    expect(repo.getStorageUsageBytes()).toBeGreaterThan(10);
    expect(() => repo.deleteRoom({ roomId: room.id, actorUserId: "usr_owner" })).not.toThrow();
  });

  it("parses MAX_STORED_CONTENT_BYTES from the environment, defaulting to 256 MiB", async () => {
    const { resolveRuntimeConfig } = await import("../src/config.js");
    const withEnv = await resolveRuntimeConfig({ MAX_STORED_CONTENT_BYTES: "1048576" }, undefined, async () => true);
    expect(withEnv.maxStoredContentBytes).toBe(1048576);

    const withoutEnv = await resolveRuntimeConfig({}, undefined, async () => true);
    expect(withoutEnv.maxStoredContentBytes).toBe(268435456);
  });

  it("leaves CRDT materialize exempt from the quota by design - it is a non-client write, not a rejectable one", async () => {
    const { repo } = await createTestRepo(20);
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const created = repo.createCrdtFileIdempotent({
      roomId: room.id,
      relativePath: "note.md",
      actorUserId: "usr_owner",
      operationId: "op_1",
      deviceId: "dev_1"
    });

    // Materializing content well past the 20-byte ceiling must not throw - see the doc comment on
    // materializeCrdtContent for why this is the intended behavior, not a bug.
    expect(() =>
      repo.materializeCrdtContent({
        fileId: created.result.fileId,
        epoch: created.result.epoch,
        content: "this typed content is deliberately far longer than the twenty byte ceiling",
        actorUserId: "usr_owner"
      })
    ).not.toThrow();
    expect(repo.getStorageUsageBytes()).toBeGreaterThan(20);

    // A subsequent whole-file client write against the same over-limit store is still rejected -
    // the exemption is specific to materialize, not a side effect of already being over budget.
    expect(() =>
      repo.writeFile({ roomId: room.id, relativePath: "other.md", baseVersion: 0, content: "more bytes on top", actorUserId: "usr_owner" })
    ).toThrowError(expect.objectContaining({ code: "STORAGE_QUOTA_EXCEEDED" }));
  });
});

/** Seeds a file with an un-pruned multi-version history and a null raw_size_bytes, as if the row
 *  predates Phase A Task 1/2 (schema migrated in, but never touched by a live write since). */
function seedLegacyFileHistory(db: RelayDb, roomId: string, relativePath: string, contents: string[]): string {
  const fileId = createId("fil");
  const now = new Date().toISOString();
  const latestContent = contents[contents.length - 1]!;
  db.prepare(
    "insert into files(id, room_id, relative_path, kind, content_type, version, sha256, size_bytes, raw_size_bytes, deleted_at, updated_by_user_id, updated_at, created_at, path_key) values (?, ?, ?, 'file', 'markdown', ?, ?, ?, null, null, 'usr_owner', ?, ?, ?)"
  ).run(fileId, roomId, relativePath, contents.length, sha256Hex(latestContent), Buffer.byteLength(latestContent, "utf8"), now, now, portablePathKey(relativePath));
  contents.forEach((content, index) => {
    const version = index + 1;
    const sha = sha256Hex(content);
    const storageKey = `sha256:${sha}`;
    db.prepare("insert or ignore into content_blobs(storage_key, content, created_at) values (?, ?, ?)").run(storageKey, content, now);
    db.prepare(
      "insert into file_versions(id, file_id, version, sha256, size_bytes, raw_size_bytes, content_storage_key, created_by_user_id, created_at) values (?, ?, ?, ?, ?, null, ?, 'usr_owner', ?)"
    ).run(createId("ver"), fileId, version, sha, Buffer.byteLength(content, "utf8"), storageKey, now);
  });
  return fileId;
}

describe("resumable backfill and explicit reclaim (Phase A Task 5)", () => {
  it("backfills raw_size_bytes and prunes old versions across many files in bounded passes (gate 9)", async () => {
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const fileIds: string[] = [];
    for (let i = 0; i < 25; i++) {
      fileIds.push(seedLegacyFileHistory(db, room.id, `note-${i}.md`, [`v0 for ${i}`, `v1 for ${i}`, `final content for ${i}`]));
    }
    // What a real restart's runMigrations() would have already done to storage_usage.
    recomputeStorageUsage(db);

    let processed = 0;
    let done = false;
    let iterations = 0;
    while (!done) {
      const result = repo.backfillStorageBatch(5);
      expect(result.processedCount).toBeLessThanOrEqual(5);
      processed += result.processedCount;
      done = result.done;
      iterations += 1;
      expect(iterations).toBeLessThan(20); // guards against an infinite-loop regression
    }
    expect(processed).toBe(25);

    for (const fileId of fileIds) {
      expect(fileVersionCount(db, fileId)).toBe(1);
    }
    const stillNull = db.prepare("select count(*) as n from files where raw_size_bytes is null").get() as { n: number };
    expect(stillNull.n).toBe(0);
    expect(repo.getStorageUsageBytes()).toBe(recount(db));
  });

  it("resumes after a real close/reopen of a durable on-disk image, mid-backfill, without double-counting or losing rows (gate 9)", async () => {
    // A real file path, not ":memory:" - the previous version of this test only constructed a
    // second RelayRepository over the same live in-memory database object, which cannot catch a bug
    // in what actually gets persisted to and re-read from disk across a genuine process restart.
    const dbPath = temporaryDbPath();
    const db = await openSqlJsDb(dbPath);
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
    const fileIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      fileIds.push(seedLegacyFileHistory(db, room.id, `note-${i}.md`, [`old ${i}`, `newer ${i}`, `latest ${i}`]));
    }
    recomputeStorageUsage(db);

    // Simulate a process that dies right after the first batch, but after that batch's writes made
    // it to the durable image on disk.
    const firstPass = repo.backfillStorageBatch(4);
    expect(firstPass.processedCount).toBe(4);
    expect(firstPass.done).toBe(false);
    await db.flush();
    await db.close();

    // Restart: a fresh process reopens the same path from bytes on disk, with no in-memory state
    // carried over and no cursor to hand off - resuming depends entirely on the rows' own
    // raw_size_bytes column, exactly as a real restart would.
    const dbAfterRestart = await openSqlJsDb(dbPath);
    const repoAfterRestart = new RelayRepository(dbAfterRestart);
    let done = firstPass.done;
    let processedAfterRestart = 0;
    let iterations = 0;
    while (!done) {
      const result = repoAfterRestart.backfillStorageBatch(4);
      processedAfterRestart += result.processedCount;
      done = result.done;
      iterations += 1;
      expect(iterations).toBeLessThan(20);
    }
    expect(processedAfterRestart).toBe(6); // the remaining 6 of 10, no double-processing

    for (const fileId of fileIds) {
      expect(fileVersionCount(dbAfterRestart, fileId)).toBe(1);
    }
    const stillNull = dbAfterRestart.prepare("select count(*) as n from files where raw_size_bytes is null").get() as { n: number };
    expect(stillNull.n).toBe(0);
    expect(repoAfterRestart.getStorageUsageBytes()).toBe(recount(dbAfterRestart));
    await dbAfterRestart.close();
  });

  it("a deliberately corrupted storage_usage self-heals on the next start", async () => {
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "some real content", actorUserId: "usr_owner" });

    db.prepare("update storage_usage set blob_bytes = ? where id = 1").run(999999);
    expect(repo.getStorageUsageBytes()).toBe(999999);
    expect(repo.getStorageUsageBytes()).not.toBe(recount(db));

    // Every startup runs this (see relayCore.ts), and it always ends with recomputeStorageUsage.
    runMigrations(db);
    expect(repo.getStorageUsageBytes()).toBe(recount(db));
  });

  it("enforces quota correctly even before any backfill has run (raw_size_bytes still null)", async () => {
    const db = await openSqlJsDb(":memory:");
    runMigrations(db);
    const seedRepo = new RelayRepository(db, Number.MAX_SAFE_INTEGER);
    const room = seedRepo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    seedLegacyFileHistory(db, room.id, "legacy.md", ["already well over the configured tiny limit"]);
    recomputeStorageUsage(db);

    const repo = new RelayRepository(db, 10);
    expect(repo.getStorageUsageBytes()).toBeGreaterThan(10);
    // raw_size_bytes is still null on the seeded row - the quota check must not depend on it.
    expect(db.prepare("select raw_size_bytes from files where relative_path = 'legacy.md'").get()).toEqual({ raw_size_bytes: null });

    expect(() =>
      repo.writeFile({
        roomId: room.id,
        relativePath: "new.md",
        baseVersion: 0,
        content: "another chunk of content that adds real bytes",
        actorUserId: "usr_owner"
      })
    ).toThrowError(expect.objectContaining({ code: "STORAGE_QUOTA_EXCEEDED" }));
  });
});

/** Deletes a file_versions row directly via SQL, leaving its blob behind with zero references -
 *  reproducing the pre-Phase-A tombstone-cleanup gap (a real historical bug fixed in Task 3 by
 *  introducing deleteAllVersionsAndCollectBlobs) that no mutation-triggered collection path can see. */
function orphanBlobDirectly(db: RelayDb, fileId: string): void {
  db.prepare("delete from file_versions where file_id = ?").run(fileId);
}

describe("orphaned blob sweep (Phase A review fix)", () => {
  it("does not subtract an orphan that startup recount already excluded", async () => {
    const db = await openSqlJsDb(":memory:");
    db.exec("create table content_blobs(storage_key text primary key, content text not null, created_at text not null)");
    db.exec("insert into content_blobs values ('sha256:orphan', 'orphan', 'now')");
    runMigrations(db);
    const repo = new RelayRepository(db);

    expect(repo.getStorageUsageBytes()).toBe(0);
    expect(repo.sweepOrphanedBlobsBatch(10)).toEqual({ processedCount: 1, done: true });
    expect(repo.getStorageUsageBytes()).toBe(0);
    await db.close();
  });

  it("finds and reclaims a blob orphaned by code that predates Phase A's own collection logic", async () => {
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const write = repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "orphaned soon", actorUserId: "usr_owner" });
    const fileId = repo.getFile(room.id, "a.md")!.id;
    expect(blobCount(db)).toBe(1);
    const usageBeforeOrphan = repo.getStorageUsageBytes();

    // Simulate a legacy database that already has this exact gap: file_versions gone, content_blobs
    // row (and the bytes storage_usage counts for it) left behind.
    orphanBlobDirectly(db, fileId);
    expect(blobCount(db)).toBe(1); // still there - nothing has swept it yet
    expect(repo.getStorageUsageBytes()).toBe(usageBeforeOrphan); // still counted, per migrations.ts's unconditional sum
    void write;

    const result = repo.sweepOrphanedBlobsBatch(10);

    expect(result).toEqual({ processedCount: 1, done: true });
    expect(blobCount(db)).toBe(0);
    expect(repo.getStorageUsageBytes()).toBe(0);
    expect(repo.getStorageUsageBytes()).toBe(recount(db));
  });

  it("leaves a blob alone while any file_versions row still references it", async () => {
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "still referenced", actorUserId: "usr_owner" });

    const result = repo.sweepOrphanedBlobsBatch(10);

    expect(result).toEqual({ processedCount: 0, done: true });
    expect(blobCount(db)).toBe(1);
    expect(repo.getStorageUsageBytes()).toBe(recount(db));
  });

  it("resumes across multiple bounded batches without double-counting reclaimed bytes", async () => {
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const fileIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      repo.writeFile({ roomId: room.id, relativePath: `note-${i}.md`, baseVersion: 0, content: `distinct orphan content #${i}`, actorUserId: "usr_owner" });
      fileIds.push(repo.getFile(room.id, `note-${i}.md`)!.id);
    }
    for (const fileId of fileIds) {
      orphanBlobDirectly(db, fileId);
    }
    expect(blobCount(db)).toBe(5);

    let processed = 0;
    let done = false;
    let iterations = 0;
    while (!done) {
      const result = repo.sweepOrphanedBlobsBatch(2);
      expect(result.processedCount).toBeLessThanOrEqual(2);
      processed += result.processedCount;
      done = result.done;
      iterations += 1;
      expect(iterations).toBeLessThan(10); // guards against an infinite-loop regression
    }

    expect(processed).toBe(5);
    expect(blobCount(db)).toBe(0);
    expect(repo.getStorageUsageBytes()).toBe(0);
    expect(repo.getStorageUsageBytes()).toBe(recount(db));
  });
});

describe("scheduleStorageBackfill - orphan sweep phase (Phase A review fix)", () => {
  it("moves on to sweeping orphaned blobs once raw-size backfill reports done, in the same scheduler", async () => {
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "will be orphaned", actorUserId: "usr_owner" });
    const fileId = repo.getFile(room.id, "a.md")!.id;
    orphanBlobDirectly(db, fileId);
    expect(blobCount(db)).toBe(1);

    const { host, runNext, pendingCount } = fakeTimerHost();
    const handle = scheduleStorageBackfill(repo, host);
    try {
      // Backfill has nothing to do (raw_size_bytes is already populated by writeFile) and reports
      // done immediately - that is what triggers the phase switch, which schedules a fresh timer
      // for the first sweep batch rather than stopping.
      expect(runNext()).toBe(true);
      await vi.waitFor(() => expect(pendingCount()).toBe(1));
      expect(runNext()).toBe(true);

      await vi.waitFor(() => expect(blobCount(db)).toBe(0));
      expect(repo.getStorageUsageBytes()).toBe(recount(db));
    } finally {
      handle.cancel();
    }
  });
});

describe("scheduleStorageBackfill - external blob-store sweep phase (Phase B Task 4, sweep-only scope)", () => {
  it("migrates legacy references before sweeping either store", async () => {
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    repo.writeFile({ roomId: room.id, relativePath: "legacy.md", baseVersion: 0, content: "legacy", actorUserId: "usr_owner" });
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore);
    const { host, runNext, pendingCount } = fakeTimerHost();
    const handle = scheduleStorageBackfill(repo, host, service);

    try {
      expect(runNext()).toBe(true);
      await vi.waitFor(() => expect(pendingCount()).toBe(1));
      expect(runNext()).toBe(true);
      await vi.waitFor(() => expect(repo.latestFileVersion(repo.getFile(room.id, "legacy.md")!.id)?.blob_key).toBeTruthy());
      expect(db.prepare("select 1 from content_blobs limit 1").get()).toBeUndefined();
      expect(await blobStore.list()).toHaveLength(1);
    } finally {
      handle.cancel();
    }
  });

  it("moves on to sweeping the external BlobStore once backfill and content_blobs sweep both report done, when a contentWriteService is supplied", async () => {
    const { repo } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const blobStore = createInMemoryBlobStore();
    const service = createContentWriteService(repo, blobStore);
    await service.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "kept", actorUserId: "usr_owner" });
    // A finalized key without metadata must be swept and is not quota-counted.
    await blobStore.put(Buffer.from("orphaned bytes"));
    expect(await blobStore.list()).toHaveLength(2);

    const { host, runNext, pendingCount } = fakeTimerHost();
    const handle = scheduleStorageBackfill(repo, host, service);
    try {
      expect(runNext()).toBe(true); // backfill: done immediately (nothing legacy to backfill)
      await vi.waitFor(() => expect(pendingCount()).toBe(1));
      expect(runNext()).toBe(true); // migration: no legacy references
      await vi.waitFor(() => expect(pendingCount()).toBe(1));
      expect(runNext()).toBe(true); // content_blobs sweep
      await vi.waitFor(() => expect(pendingCount()).toBe(1));
      expect(runNext()).toBe(true); // external sweep

      await vi.waitFor(async () => expect(await blobStore.list()).toHaveLength(1));
      const version = repo.latestFileVersion(repo.getFile(room.id, "a.md")!.id);
      expect(await blobStore.list()).toEqual([version?.blob_key]);
    } finally {
      handle.cancel();
    }
  });

  it("never schedules a blob-store sweep phase when contentWriteService is omitted - existing callers are unaffected", async () => {
    const { repo } = await createTestRepo();
    const { host, runNext, pendingCount } = fakeTimerHost();
    const handle = scheduleStorageBackfill(repo, host);
    try {
      expect(runNext()).toBe(true); // backfill
      await vi.waitFor(() => expect(pendingCount()).toBe(1));
      expect(runNext()).toBe(true); // content_blobs sweep
      await vi.waitFor(() => expect(pendingCount()).toBe(0)); // no third phase ever scheduled
    } finally {
      handle.cancel();
    }
  });
});

describe("0.2.6 client compatibility - hashes and size_bytes untouched by retention (gate 10, P2 review fix)", () => {
  it("never changes a file's current sha256, size_bytes, or content across writes, backfill, and orphan sweep", async () => {
    // A 0.2.6 client predates raw_size_bytes and latest-only pruning entirely - it only ever reads
    // the current version through the same readFileContent/getFile fields it always has. If Phase A
    // retention touched either field on the *current* version, an old client polling the server could
    // see a hash/size it doesn't recognize and wrongly treat its own copy as conflicting.
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    let write = repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "v1 content", actorUserId: "usr_owner" });
    for (let i = 0; i < 5; i++) {
      write = repo.writeFile({
        roomId: room.id,
        relativePath: "a.md",
        baseVersion: write.version,
        content: `v${i + 2} content`,
        actorUserId: "usr_owner"
      });
    }
    const expectedContent = write.content;
    const expectedSha256 = write.sha256;
    const expectedSizeBytes = Buffer.byteLength(expectedContent, "utf8");

    // Legacy backfill and orphan sweep both run unconditionally on every startup, even over a file
    // that was never in a legacy shape.
    let done = false;
    while (!done) {
      done = repo.backfillStorageBatch(50).done;
    }
    repo.sweepOrphanedBlobsBatch(50);

    const { file, content } = repo.readFileContent(room.id, "a.md");
    expect(content).toBe(expectedContent);
    expect(file.sha256).toBe(expectedSha256);
    expect(file.size_bytes).toBe(expectedSizeBytes);
    expect(file.version).toBe(write.version);

    // Retention/backfill/sweep never fabricate an extra file row as a side effect - a client-visible
    // conflict copy could only ever come from the ordinary write-conflict path, which none of this
    // touches.
    expect(repo.listFiles(room.id).map((row) => row.relative_path)).toEqual(["a.md"]);
  });
});

/** A deterministic stand-in for the real setTimeout/clearTimeout-backed timer hosts
 *  (nodeStorageTimerHost/windowStorageTimerHost) - lets a test fire (or never fire) a scheduled
 *  batch on its own terms instead of racing a real clock. */
function fakeTimerHost(): {
  host: StorageMaintenanceTimerHost;
  runNext: () => boolean;
  pendingCount: () => number;
} {
  let nextHandle = 0;
  const scheduled = new Map<number, () => void>();
  const host: StorageMaintenanceTimerHost = {
    setTimeout: (callback) => {
      const handle = nextHandle;
      nextHandle += 1;
      scheduled.set(handle, callback);
      return handle;
    },
    clearTimeout: (handle) => {
      scheduled.delete(handle as number);
    }
  };
  return {
    host,
    runNext: () => {
      const [handle] = scheduled.keys();
      if (handle === undefined) {
        return false;
      }
      const callback = scheduled.get(handle)!;
      scheduled.delete(handle);
      callback();
      return true;
    },
    pendingCount: () => scheduled.size
  };
}

describe("scheduleStorageBackfill - timer lifecycle (Phase A review fix)", () => {
  it("clears the pending timer on cancel, so a batch scheduled before cancel() never fires", () => {
    const repo = new RelayRepository({} as unknown as RelayDb);
    const batchSpy = vi.spyOn(repo, "backfillStorageBatch").mockReturnValue({ processedCount: 0, done: true });
    const { host, runNext, pendingCount } = fakeTimerHost();

    const handle = scheduleStorageBackfill(repo, host);
    expect(pendingCount()).toBe(1);
    handle.cancel();
    handle.cancel(); // idempotent - stop() may legitimately call this more than once
    expect(pendingCount()).toBe(0);
    expect(runNext()).toBe(false); // nothing left to fire

    expect(batchSpy).not.toHaveBeenCalled();
  });

  it("runs every batch through repo.withExclusiveAccess rather than calling backfillStorageBatch directly", async () => {
    const { repo, db } = await createTestRepo();
    const room = repo.createRoom({
      name: "Room",
      type: "folder",
      sourcePath: "/vault/room",
      mountName: "room",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    seedLegacyFileHistory(db, room.id, "legacy.md", ["legacy content"]);
    recomputeStorageUsage(db);

    const exclusiveAccessSpy = vi.spyOn(repo, "withExclusiveAccess");
    const { host, runNext } = fakeTimerHost();

    const handle = scheduleStorageBackfill(repo, host);
    try {
      expect(runNext()).toBe(true); // fires the first (and, since done, only) batch
      await vi.waitFor(() => {
        expect(exclusiveAccessSpy).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(db.prepare("select raw_size_bytes from files where relative_path = 'legacy.md'").get()).toEqual({ raw_size_bytes: expect.any(Number) });
      });
    } finally {
      handle.cancel();
    }
  });

  it("catches a batch failure (e.g. the DB closing mid-flight) instead of letting it escape as an unhandled rejection", async () => {
    const { repo } = await createTestRepo();
    vi.spyOn(repo, "withExclusiveAccess").mockRejectedValue(new Error("RelayDb is closed"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { host, runNext, pendingCount } = fakeTimerHost();

    const handle = scheduleStorageBackfill(repo, host);
    expect(runNext()).toBe(true);
    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Storage maintenance stopped"), expect.any(Error));
    });
    // The failure stops the chain rather than re-arming another timer.
    expect(pendingCount()).toBe(0);

    handle.cancel();
    consoleErrorSpy.mockRestore();
  });
});
