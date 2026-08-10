import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppWithDb } from "../src/appCore.js";
import { openSqlJsDb } from "../src/db/sqlJsAdapter.js";
import { createRelayCore } from "../src/relayCore.js";
import { blobKeyForBytes, createInMemoryBlobStore, shardedRelativePath } from "../src/storage/blobStore.js";
import { createFsBlobStore } from "../src/storage/fsBlobStore.js";
import { injectBootstrap } from "./bootstrapHelper.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("external blob storage amplification", () => {
  it("keeps SQLite metadata small across 100 near-limit binary replacements", async () => {
    const directory = temporaryDirectory("vault-rooms-amplification-");
    const dbPath = join(directory, "relay.sqlite");
    const db = await openSqlJsDb(dbPath);
    const core = createRelayCore(db, { blobStore: createInMemoryBlobStore(), maxFileBytes: 5 * 1024 * 1024 });
    const room = core.repo.createRoom({
      name: "Soak",
      type: "folder",
      sourcePath: "Soak",
      mountName: "Soak",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    const payload = Buffer.alloc(Math.floor(4.9 * 1024 * 1024), 0x5a);
    let version = 0;
    const sizes: number[] = [];

    for (let index = 0; index < 100; index += 1) {
      payload.writeUInt32BE(index, 0);
      const result = await core.contentWriteService.writeFile({
        roomId: room.id,
        relativePath: "large.bin",
        baseVersion: version,
        content: payload.toString("base64"),
        actorUserId: "usr_owner"
      });
      version = result.version;
      await db.flush();
      sizes.push(statSync(dbPath).size);
    }

    expect(Math.max(...sizes)).toBeLessThan(1024 * 1024);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(256 * 1024);
    await db.durable(() => core.repo.getOrCreateServerId());
    expect(statSync(dbPath).size).toBeLessThan(1024 * 1024);
    await db.close();
  }, 30_000);

  it("does not make SQLite grow with cumulative external payload", async () => {
    const directory = temporaryDirectory("vault-rooms-cumulative-");
    const dbPath = join(directory, "relay.sqlite");
    const db = await openSqlJsDb(dbPath);
    const core = createRelayCore(db, { blobStore: createInMemoryBlobStore() });
    const room = core.repo.createRoom({
      name: "Cumulative",
      type: "folder",
      sourcePath: "Cumulative",
      mountName: "Cumulative",
      ownerUserId: "usr_owner",
      capabilities: []
    });

    for (let index = 0; index < 100; index += 1) {
      const payload = Buffer.alloc(64 * 1024, index);
      await core.contentWriteService.writeFile({
        roomId: room.id,
        relativePath: `file-${index}.bin`,
        baseVersion: 0,
        content: payload.toString("base64"),
        actorUserId: "usr_owner"
      });
    }
    await db.flush();

    expect(core.repo.getStorageUsageBytes()).toBe(100 * 64 * 1024);
    expect(statSync(dbPath).size).toBeLessThan(1024 * 1024);
    await db.close();
  });

  it("resumes legacy migration after reopening SQLite and the filesystem blob store", async () => {
    const directory = temporaryDirectory("vault-rooms-migration-restart-");
    const dbPath = join(directory, "relay.sqlite");
    const blobDirectory = join(directory, "blobs");
    let db = await openSqlJsDb(dbPath);
    let core = createRelayCore(db, { blobStore: createFsBlobStore(blobDirectory) });
    const room = core.repo.createRoom({
      name: "Migration",
      type: "folder",
      sourcePath: "Migration",
      mountName: "Migration",
      ownerUserId: "usr_owner",
      capabilities: []
    });
    core.repo.writeFile({ roomId: room.id, relativePath: "a.md", baseVersion: 0, content: "alpha", actorUserId: "usr_owner" });
    core.repo.writeFile({
      roomId: room.id,
      relativePath: "b.bin",
      baseVersion: 0,
      content: Buffer.from([0, 1, 2, 255]).toString("base64"),
      actorUserId: "usr_owner"
    });

    expect(await core.contentWriteService.migrateLegacyContentBatch(1)).toEqual({ processedCount: 1, done: false });
    await db.close();

    db = await openSqlJsDb(dbPath);
    core = createRelayCore(db, { blobStore: createFsBlobStore(blobDirectory) });
    expect(await core.contentWriteService.migrateLegacyContentBatch(10)).toEqual({ processedCount: 1, done: true });
    expect((await core.contentWriteService.readFileContent({ roomId: room.id, relativePath: "a.md" })).content).toBe("alpha");
    expect((await core.contentWriteService.readFileContent({ roomId: room.id, relativePath: "b.bin" })).content).toBe(
      Buffer.from([0, 1, 2, 255]).toString("base64")
    );
    expect((db.prepare("select count(*) as count from content_blobs").get() as { count: number }).count).toBe(0);
    expect((db.prepare("select count(*) as count from file_versions where blob_key is not null").get() as { count: number }).count).toBe(2);
    await db.close();
  });

  it("converges two clients and collects both crash-window artifacts after restart", async () => {
    const directory = temporaryDirectory("vault-rooms-binary-crash-restart-");
    const dbPath = join(directory, "relay.sqlite");
    const blobDirectory = join(directory, "blobs");
    const blobStore = createFsBlobStore(blobDirectory);
    let db = await openSqlJsDb(dbPath);
    let core = createRelayCore(db, { blobStore });
    let app = await createAppWithDb(db, { core, ownsDb: true, publicUrl: "http://127.0.0.1:8787" });

    const owner = (await injectBootstrap(app, { displayName: "A", deviceName: "A laptop", teamName: "Crash test" })).json();
    const invite = (
      await app.inject({
        method: "POST",
        url: `/api/teams/${owner.team.id}/invites`,
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { role: "member", expiresInMinutes: 60, maxUses: 1 }
      })
    ).json();
    const member = (
      await app.inject({
        method: "POST",
        url: "/api/join",
        payload: { inviteToken: invite.inviteToken, displayName: "B", deviceName: "B laptop" }
      })
    ).json();
    const room = (
      await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { name: "Binary", type: "folder", sourcePath: "Binary", mountName: "Binary", capabilities: [], crdtEnabled: false }
      })
    ).json().room;
    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "editor", pathPattern: "**/*" }
    });

    const firstBytes = Buffer.from([0, 1, 2, 3, 254, 255]);
    const created = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/raw?path=image.bin&baseVersion=0`,
      headers: { authorization: `Bearer ${owner.deviceToken}`, "content-type": "application/octet-stream" },
      payload: firstBytes
    });
    expect(created.statusCode).toBe(200);
    const firstKey = blobKeyForBytes(firstBytes);

    const readByB = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files/raw?path=image.bin`,
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(readByB.rawPayload).toEqual(firstBytes);

    const uncommittedBytes = Buffer.from([9, 9, 9, 9]);
    const uncommittedKey = await blobStore.put(uncommittedBytes);
    const tempKey = blobKeyForBytes(new Uint8Array([8, 8, 8, 8]));
    const tempPath = `${join(blobDirectory, shardedRelativePath(tempKey))}.tmp-crash`;
    mkdirSync(dirname(tempPath), { recursive: true });
    writeFileSync(tempPath, new Uint8Array([8, 8]));

    const committedBytes = Buffer.from([4, 5, 6, 7, 128, 129]);
    const committedKey = await blobStore.put(committedBytes);
    core.repo.writeFile({
      roomId: room.id,
      relativePath: "image.bin",
      baseVersion: 1,
      content: committedBytes.toString("base64"),
      actorUserId: member.user.id,
      blobKey: committedKey
    });
    await app.close();

    db = await openSqlJsDb(dbPath);
    core = createRelayCore(db, { blobStore });
    app = await createAppWithDb(db, { core, ownsDb: true, publicUrl: "http://127.0.0.1:8787" });
    let sweep = await core.contentWriteService.sweepOrphanedBlobStoreBatch(1);
    while (!sweep.done) {
      sweep = await core.contentWriteService.sweepOrphanedBlobStoreBatch(1);
    }

    expect(await blobStore.has(firstKey)).toBe(false);
    expect(await blobStore.has(uncommittedKey)).toBe(false);
    expect(await blobStore.has(committedKey)).toBe(true);
    expect(existsSync(tempPath)).toBe(false);

    const readByA = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files/raw?path=image.bin`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(readByA.statusCode).toBe(200);
    expect(readByA.headers["x-vault-rooms-version"]).toBe("2");
    expect(readByA.rawPayload).toEqual(committedBytes);
    await app.close();
  });
});
