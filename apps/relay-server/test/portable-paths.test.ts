import { afterEach, describe, expect, it } from "vitest";
import { contentTypeForPath, portablePathKey } from "@vault-rooms/protocol";
import { runMigrations } from "../src/db/migrations.js";
import { RelayRepository } from "../src/db/repositories/relayRepository.js";
import { openSqlJsDb, type RelayDb } from "../src/db/sqlJsAdapter.js";
import { createAppWithDb } from "../src/appCore.js";
import { injectBootstrap } from "./bootstrapHelper.js";
import type { ConnectionRegistry } from "../src/sync/connectionRegistry.js";
import type { SyncServerMessage } from "@vault-rooms/protocol";
const databases: RelayDb[] = [];
afterEach(async () => { for (const db of databases.splice(0))
  await db.close(); });
async function fixture() {
  const db = await openSqlJsDb(":memory:");
  databases.push(db);
  runMigrations(db);
  const repo = new RelayRepository(db);
  const room = repo.createRoom({ name: "Room", type: "folder", sourcePath: "Room", mountName: "Room", ownerUserId: "owner", capabilities: [], crdtEnabled: false });
  const write = (relativePath: string, baseVersion = 0, content = "original") => repo.writeFile({ roomId: room.id, relativePath, baseVersion, content, actorUserId: "owner" });
  return { db, repo, room, write };
}
describe("portable file identity", () => {
  it("uses one live identity for case and NFC/NFD aliases even through the repository", async () => {
    const { repo, room, write } = await fixture();
    write("Secret/Café.csv");
    const original = repo.getFile(room.id, "Secret/Café.csv")!;
    expect(repo.getFile(room.id, "secret/Cafe\u0301.CSV")?.id).toBe(original.id);
    expect(() => write("secret/Cafe\u0301.CSV")).toThrowError(expect.objectContaining({ code: "FILE_EXISTS" }));
    const updated = write("secret/Cafe\u0301.CSV", 1, "updated");
    expect(updated.relativePath).toBe("Secret/Café.csv");
    expect(repo.listFiles(room.id)).toHaveLength(1);
  });
  it("enforces live uniqueness in SQLite, independently of repository checks", async () => {
    const { db, room, write } = await fixture();
    write("Note.md");
    expect(db.prepare("select name from sqlite_master where type='index' and name='idx_files_portable_live'").get()).toBeTruthy();
    expect(() => db.prepare("insert into files select 'other', room_id, 'note.md', kind, content_type, version, sha256, size_bytes, deleted_at, updated_by_user_id, updated_at, created_at, crdt_epoch, raw_size_bytes, path_key, path_collision from files where room_id = ?").run(room.id)).toThrow(/UNIQUE/);
  });
  it.each(["CON.md", "Notes /x.csv", "Notes./x.csv", "data?.csv", "a:b.csv"])("rejects new portable-invalid path %s at the repository", async (path) => {
    const { write } = await fixture();
    expect(() => write(path)).toThrowError(expect.objectContaining({ code: "INVALID_PATH", statusCode: 422 }));
  });
  it("revives an alias tombstone with the new spelling and a strictly newer version", async () => {
    const { repo, room, write } = await fixture();
    write("Note.csv");
    const original = repo.getFile(room.id, "Note.csv")!;
    repo.deleteFile({ roomId: room.id, relativePath: "Note.csv", baseVersion: 1, actorUserId: "owner" });
    const revived = write("note.CSV", 0, "new");
    expect(revived.version).toBe(3);
    expect(repo.getFile(room.id, "NOTE.csv")).toMatchObject({ id: original.id, relative_path: "note.CSV", deleted_at: null });
  });
  it("case-only rename preserves ID/history/epoch and creates no alias tombstone", async () => {
    const { repo, room, write } = await fixture();
    write("Note.md");
    const original = repo.getFile(room.id, "Note.md")!;
    repo.renameFile({ roomId: room.id, oldRelativePath: "Note.md", relativePath: "note.MD", actorUserId: "owner" });
    expect(repo.listFiles(room.id)).toHaveLength(1);
    expect(repo.getFile(room.id, "Note.md")).toMatchObject({ id: original.id, relative_path: "note.MD", crdt_epoch: original.crdt_epoch });
    expect(repo.latestFileVersion(original.id)?.content).toBe("original");
  });
  it("an adopted CRDT alias returns the server spelling", async () => {
    const { repo, room } = await fixture();
    const created = repo.createCrdtFile({ roomId: room.id, relativePath: "Notes/Café.md", actorUserId: "owner" });
    const adopted = repo.createCrdtFile({ roomId: room.id, relativePath: "notes/Cafe\u0301.MD", actorUserId: "owner", adoptIfExists: true });
    expect(adopted).toEqual(created);
  });
  it("structurally normalizes direct CRDT creates before enforcing portable uniqueness", async () => {
    const { repo, room } = await fixture();
    const created = repo.createCrdtFile({ roomId: room.id, relativePath: "Folder//Note.md", actorUserId: "owner" });
    const adopted = repo.createCrdtFile({ roomId: room.id, relativePath: "folder\\note.MD", actorUserId: "owner", adoptIfExists: true });
    expect(created.relativePath).toBe("Folder/Note.md");
    expect(adopted).toEqual(created);
    expect(repo.listFiles(room.id)).toHaveLength(1);
  });
});
function makeLegacyFiles(db: RelayDb, roomId: string, rows: Array<{
  id: string;
  path: string;
  deleted?: boolean;
  version?: number;
}>) {
  db.exec("drop table files");
  db.exec(`create table files(id text primary key, room_id text not null, relative_path text not null, kind text not null, content_type text not null, version integer not null, sha256 text, size_bytes integer, deleted_at text, updated_by_user_id text, updated_at text not null, created_at text not null, crdt_epoch integer not null default 0, raw_size_bytes integer, unique(room_id, relative_path))`);
  db.prepare("delete from server_meta where key = 'portable_paths_v1'").run();
  for (const row of rows)
    db.prepare("insert into files values (?, ?, ?, 'file', ?, ?, null, 0, ?, 'owner', 'now', 'now', 0, 0)").run(row.id, roomId, row.path, contentTypeForPath(row.path), row.version ?? 1, row.deleted ? "now" : null);
}
describe("portable path legacy preflight", () => {
  it("owner repairs a quarantined identity by ID without losing the other identity or CRDT history", async () => {
    const { db, repo, room } = await fixture();
    makeLegacyFiles(db, room.id, [{ id: "a", path: "Note.md" }, { id: "b", path: "note.MD" }]);
    runMigrations(db);
    repo.appendCrdtUpdate("a", 0, "AQID");
    const result = repo.renameFileById({ roomId: room.id, fileId: "a", relativePath: "Recovered.md", actorUserId: "owner" });
    expect(result.oldRelativePath).toBe("Note.md");
    expect(repo.getFile(room.id, "Recovered.md")).toMatchObject({ id: "a", crdt_epoch: 0, path_collision: 0 });
    expect(repo.getFile(room.id, "NOTE.md")).toMatchObject({ id: "b", relative_path: "note.MD", path_collision: 0 });
    expect(repo.getFile(room.id, "NOTE.md")!.version).toBe(3);
    expect(repo.listCrdtUpdatesSince("a", 0, 0)).toHaveLength(1);
    expect(repo.listPathCollisions(room.id)).toEqual([]);
  });
  it("REST exposes every flagged row to current clients and only the owner can repair it", async () => {
    const db = await openSqlJsDb(":memory:");
    const app = await createAppWithDb(db);
    try {
      const owner = (await injectBootstrap(app, { displayName: "Owner", deviceName: "Laptop", teamName: "Team" })).json();
      const headers = { authorization: `Bearer ${owner.deviceToken}` };
      const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Room", type: "folder", sourcePath: "Room", mountName: "Room", capabilities: [], crdtEnabled: false } })).json().room;
      const repo = (app as unknown as {
        testRepo: RelayRepository;
      }).testRepo;
      makeLegacyFiles(db, room.id, [{ id: "a", path: "Note.md" }, { id: "b", path: "note.MD" }]);
      runMigrations(db);
      const legacy = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/files`, headers });
      expect(legacy.statusCode).toBe(409);
      expect(legacy.json().error.code).toBe("PATH_COLLISION");
      const files = (await app.inject({ method: "GET", url: `/api/rooms/${room.id}/files?capabilities=portablePaths`, headers })).json().files;
      expect(files).toHaveLength(2);
      expect(files.every((file: {
        pathCollision: boolean;
        fileId: string;
      }) => file.pathCollision && file.fileId)).toBe(true);
      const groups = (await app.inject({ method: "GET", url: `/api/rooms/${room.id}/path-collisions`, headers })).json().groups;
      expect(groups[0].files.map((file: {
        fileId: string;
      }) => file.fileId)).toEqual(["a", "b"]);
      const messages: SyncServerMessage[] = [];
      const registry = (app as unknown as {
        testConnectionRegistry: ConnectionRegistry;
      }).testConnectionRegistry;
      registry.add({ id: owner.device.id, principal: repo.authenticateDeviceToken(owner.deviceToken), subscriptions: new Set([room.id]), capabilities: { crdt: true, presence: false, extendedBinarySync: true, portablePaths: true }, socket: { OPEN: 1, readyState: 1, send: payload => { messages.push(JSON.parse(payload)); }, close() { }, ping() { } } });
      const repaired = await app.inject({ method: "POST", url: `/api/rooms/${room.id}/files/rename`, headers, payload: { fileId: "a", relativePath: "Recovered.md" } });
      expect(repaired.statusCode).toBe(200);
      expect(repaired.json()).toMatchObject({ ok: true, fileId: "a", relativePath: "Recovered.md", oldRelativePath: "Note.md", epoch: 0 });
      expect(repo.getFile(room.id, "note.MD")?.id).toBe("b");
      expect(messages).toEqual([expect.objectContaining({ type: "room_snapshot", files: [expect.objectContaining({ relativePath: "Recovered.md", deleted: false }), expect.objectContaining({ relativePath: "note.MD", deleted: false, version: 3 })] })]);
      const snapshot = messages[0] as Extract<SyncServerMessage, {
        type: "room_snapshot";
      }>;
      expect(snapshot.files.some(file => file.pathCollision || file.deleted)).toBe(false);
      const invalid = await app.inject({ method: "POST", url: `/api/rooms/${room.id}/files/rename`, headers, payload: { fileId: "b", relativePath: "CON.md" } });
      expect(invalid.json().error.code).toBe("INVALID_PATH");
      const badRoom = await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Bad", type: "folder", sourcePath: "CON", mountName: "Room", capabilities: [] } });
      expect(badRoom.json().error.code).toBe("INVALID_PATH");
      const invite = (await app.inject({ method: "POST", url: `/api/teams/${owner.team.id}/invites`, headers, payload: { role: "member", expiresInMinutes: 60, maxUses: 1 } })).json();
      const member = (await app.inject({ method: "POST", url: "/api/join", payload: { inviteToken: invite.inviteToken, displayName: "Member", deviceName: "Phone" } })).json();
      const denied = await app.inject({ method: "POST", url: `/api/rooms/${room.id}/files/rename`, headers: { authorization: `Bearer ${member.deviceToken}` }, payload: { fileId: "b", relativePath: "other.md" } });
      expect(denied.statusCode).toBe(403);
    }
    finally {
      await app.close();
    }
  });
  it("preserves both live aliases, marks the group and audits only once", async () => {
    const { db, repo, room, write } = await fixture();
    makeLegacyFiles(db, room.id, [{ id: "a", path: "Secret/Café.csv" }, { id: "b", path: "secret/Cafe\u0301.csv" }]);
    runMigrations(db);
    expect(repo.listFiles(room.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "a", path_key: "secret/café.csv", path_collision: 1 }),
      expect.objectContaining({ id: "b", path_key: "secret/café.csv", path_collision: 1 })
    ]));
    expect(() => write("SECRET/CAFÉ.csv")).toThrowError(expect.objectContaining({ code: "PATH_COLLISION" }));
    expect(db.prepare("select count(*) as n from portable_path_migration_backup").get()).toEqual({ n: 2 });
    const before = db.prepare("select * from audit_events where action = 'file.path_collision_detected'").all();
    expect(before).toHaveLength(1);
    runMigrations(db);
    expect(db.prepare("select * from audit_events where action = 'file.path_collision_detected'").all()).toEqual(before);
  });
  it("a live row plus alias tombstone is not quarantined and next version stays above both", async () => {
    const { db, repo, room, write } = await fixture();
    write("Note.csv");
    write("Note.csv", 1, "live-v2");
    const liveId = repo.getFile(room.id, "Note.csv")!.id;
    makeLegacyFiles(db, room.id, [{ id: liveId, path: "Note.csv", version: 2 }, { id: "dead", path: "note.CSV", version: 9, deleted: true }]);
    runMigrations(db);
    expect(repo.listFiles(room.id).map(file => file.path_collision)).toEqual([0, 0]);
    expect(repo.getFile(room.id, "NOTE.csv")).toMatchObject({ id: liveId, version: 10 });
    expect(repo.latestFileVersion(liveId)).toMatchObject({ version: 10, content: "live-v2" });
    expect(db.prepare("select version from file_versions where file_id = ? order by version").all(liveId)).toEqual([{ version: 2 }, { version: 10 }]);
    expect(write("NOTE.csv", 10, "new").version).toBe(11);
    expect(repo.getFileById("dead")?.version).toBe(9);
  });
  it("legacy-invalid names stay readable and can be renamed to a portable name", async () => {
    const { db, repo, room } = await fixture();
    makeLegacyFiles(db, room.id, [{ id: "legacy", path: "CON.csv" }]);
    runMigrations(db);
    expect(repo.getFile(room.id, "CON.csv")?.id).toBe("legacy");
    repo.renameFile({ roomId: room.id, oldRelativePath: "CON.csv", relativePath: "valid.csv", actorUserId: "owner" });
    expect(repo.getFile(room.id, "valid.csv")?.id).toBe("legacy");
  });
});
