import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import * as Y from "yjs";
import { EDITOR_PERMISSIONS, READER_PERMISSIONS } from "@vault-rooms/policy";
import { createApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrations.js";
import { openSqlJsDb } from "../src/db/sqlJsAdapter.js";
import { injectBootstrap } from "./bootstrapHelper.js";

async function bootstrapOwnerAndMember() {
  const app = await createApp({
    dbPath: ":memory:",
    publicUrl: "http://127.0.0.1:8787",
    allowRemoteBootstrap: false
  });
  const owner = (await injectBootstrap(app, { displayName: "A", deviceName: "A laptop", teamName: "Demo" })).json();
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

  return { app, owner, member };
}

describe("rooms and ACL", () => {
  it("creates rooms, filters visibility, grants presets, and applies deny overrides", async () => {
    const { app, owner, member } = await bootstrapOwnerAndMember();

    const created = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: {
        name: "Projects Demo",
        type: "folder",
        sourcePath: "Projects/Demo",
        mountName: "Projects Demo",
        capabilities: [{ pluginId: "obsidian-kanban", displayName: "Kanban", mode: "recommended" }]
      }
    });
    expect(created.statusCode).toBe(200);
    const room = created.json().room;
    // The Obsidian plugin needs this to decide whether a device should mount in place at
    // sourcePath (the owner) or into a separate folder under the mount root (everyone else) -
    // see roomMountPathFor() in apps/obsidian-plugin/src/main.ts.
    expect(room.ownerUserId).toBe(owner.user.id);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Dup", type: "folder", sourcePath: "Other", mountName: "Projects Demo", capabilities: [] }
    });
    expect(duplicate.statusCode).toBe(409);

    const ownerRooms = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(ownerRooms.statusCode).toBe(200);
    expect(ownerRooms.json().rooms[0]).toMatchObject({ id: room.id, sourcePath: "Projects/Demo", permissions: expect.arrayContaining(["file:write"]) });

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/rooms/${room.id}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: {
        name: "Projects Demo Updated",
        type: "folder",
        sourcePath: "Projects/Demo",
        mountName: "Projects Demo Updated",
        capabilities: [
          { pluginId: "obsidian-kanban", displayName: "Kanban", mode: "optional" },
          { pluginId: "obsidian-tasks-plugin", displayName: "Tasks", mode: "required" }
        ]
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().room).toMatchObject({
      id: room.id,
      name: "Projects Demo Updated",
      mountName: "Projects Demo Updated",
      capabilities: expect.arrayContaining([
        expect.objectContaining({ pluginId: "obsidian-kanban", mode: "optional" }),
        expect.objectContaining({ pluginId: "obsidian-tasks-plugin", mode: "required" })
      ])
    });

    const bBeforeGrant = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(bBeforeGrant.statusCode).toBe(200);
    expect(bBeforeGrant.json().rooms).toEqual([]);

    const grantReader = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "reader", pathPattern: "**/*" }
    });
    expect(grantReader.statusCode).toBe(200);

    const aclList = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(aclList.statusCode).toBe(200);
    expect(aclList.json().aclRules).toEqual([expect.objectContaining({ subjectId: member.user.id, effect: "allow", pathPattern: "**/*" })]);

    const bAfterGrant = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(bAfterGrant.statusCode).toBe(200);
    expect(bAfterGrant.json().rooms[0]).toMatchObject({
      id: room.id,
      permissions: expect.arrayContaining(["file:read", "sync:subscribe"]),
      capabilities: expect.arrayContaining([expect.objectContaining({ pluginId: "obsidian-kanban", installed: null })])
    });
    expect(bAfterGrant.json().rooms[0].permissions).not.toContain("file:write");

    const denyRead = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "deny", permissions: ["file:read", "room:read"], pathPattern: "**/*" }
    });
    expect(denyRead.statusCode).toBe(200);

    const bAfterDeny = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(bAfterDeny.statusCode).toBe(200);
    expect(bAfterDeny.json().rooms).toEqual([]);

    // Third-hardware-testing-round item 2: re-granting access after a deny-based revoke must
    // actually restore visibility - a stale deny rule for the exact same subject/path must not
    // permanently out-live a fresh allow grant that covers the same permissions.
    const regrantReader = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "reader", pathPattern: "**/*" }
    });
    expect(regrantReader.statusCode).toBe(200);

    const bAfterRegrant = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(bAfterRegrant.statusCode).toBe(200);
    expect(bAfterRegrant.json().rooms[0]).toMatchObject({
      id: room.id,
      permissions: expect.arrayContaining(["file:read", "sync:subscribe"])
    });

    const aclAfterRegrant = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(aclAfterRegrant.statusCode).toBe(200);
    const rulesAfterRegrant = aclAfterRegrant.json().aclRules as Array<{ subjectId: string; effect: string; permissions: string[]; pathPattern: string }>;
    // The stale deny rule (file:read/room:read, fully covered by the reader preset's re-grant) is
    // gone entirely - not just shadowed - and the fresh allow rule is present.
    expect(rulesAfterRegrant.filter((rule) => rule.subjectId === member.user.id && rule.effect === "deny")).toEqual([]);
    expect(rulesAfterRegrant).toEqual(
      expect.arrayContaining([expect.objectContaining({ subjectId: member.user.id, effect: "allow", pathPattern: "**/*" })])
    );
  });

  it("[third-hardware-testing-round item 2] narrows (rather than deletes) a deny rule whose permissions only partially overlap the new allow grant", async () => {
    const { app, owner, member } = await bootstrapOwnerAndMember();
    const created = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Projects Demo", type: "folder", sourcePath: "Projects/Demo", mountName: "Projects Demo", capabilities: [] }
    });
    const room = created.json().room;

    // Deny room:read, file:read, and file:write (broader than what the next allow grant covers).
    const deny = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "deny", permissions: ["room:read", "file:read", "file:write"], pathPattern: "**/*" }
    });
    expect(deny.statusCode).toBe(200);

    // Allow only room:read and file:read (a narrower reader-only re-grant) - file:write should stay denied.
    const regrant = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", permissions: ["room:read", "file:read", "sync:subscribe"], pathPattern: "**/*" }
    });
    expect(regrant.statusCode).toBe(200);

    const aclList = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    const rules = aclList.json().aclRules as Array<{ subjectId: string; effect: string; permissions: string[]; pathPattern: string }>;
    const remainingDenyRules = rules.filter((rule) => rule.subjectId === member.user.id && rule.effect === "deny");
    expect(remainingDenyRules).toHaveLength(1);
    // Only the non-overlapping permission (file:write) survives on the narrowed deny rule.
    expect(remainingDenyRules[0]?.permissions).toEqual(["file:write"]);

    const bAfterRegrant = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(bAfterRegrant.json().rooms[0]).toMatchObject({ id: room.id, permissions: expect.arrayContaining(["room:read", "file:read"]) });
    expect(bAfterRegrant.json().rooms[0].permissions).not.toContain("file:write");
  });

  it("rejects a sourcePath that tries to traverse outside the vault, on both create and update", async () => {
    const { app, owner } = await bootstrapOwnerAndMember();

    const traversalCreate = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Evil", type: "folder", sourcePath: "../../etc", mountName: "Evil", capabilities: [] }
    });
    expect(traversalCreate.statusCode).toBe(422);
    expect(traversalCreate.json().error.code).toBe("INVALID_PATH");

    const absoluteCreate = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Evil2", type: "folder", sourcePath: "/etc/passwd", mountName: "Evil2", capabilities: [] }
    });
    expect(absoluteCreate.statusCode).toBe(422);
    expect(absoluteCreate.json().error.code).toBe("INVALID_PATH");

    const legit = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Fine", type: "folder", sourcePath: "Projects/Demo", mountName: "Fine", capabilities: [] }
    });
    expect(legit.statusCode).toBe(200);
    const room = legit.json().room;

    const traversalUpdate = await app.inject({
      method: "PATCH",
      url: `/api/rooms/${room.id}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Fine", type: "folder", sourcePath: "../outside", mountName: "Fine", capabilities: [] }
    });
    expect(traversalUpdate.statusCode).toBe(422);
    expect(traversalUpdate.json().error.code).toBe("INVALID_PATH");
  });
});

type App = Awaited<ReturnType<typeof createApp>>;
const openApps: App[] = [];
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close();
  for (const app of openApps.splice(0)) await app.close();
});

async function roomWithMember(options: { crdtEnabled?: boolean } = {}) {
  const { app, owner, member } = await bootstrapOwnerAndMember();
  openApps.push(app);
  const room = (
    await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Shared", type: "folder", sourcePath: "Shared", mountName: "Shared", capabilities: [], crdtEnabled: options.crdtEnabled ?? false }
    })
  ).json().room;
  const acl = (token: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/rooms/${room.id}/acl`, headers: { authorization: `Bearer ${token}` }, payload });
  const rulesFor = async (userId: string) =>
    (
      (await app.inject({ method: "GET", url: `/api/rooms/${room.id}/acl`, headers: { authorization: `Bearer ${owner.deviceToken}` } })).json()
        .aclRules as Array<{ subjectId: string; effect: string; permissions: string[]; pathPattern: string }>
    ).filter((rule) => rule.subjectId === userId);
  const put = (token: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: `/api/rooms/${room.id}/files/content`, headers: { authorization: `Bearer ${token}` }, payload });
  return { app, owner, member, room, acl, rulesFor, put };
}

async function syncSocket(app: App, token: string, roomId: string) {
  await app.ready();
  const socket = (await app.injectWS("/sync")) as unknown as WebSocket;
  openSockets.push(socket);
  const queue: Array<Record<string, any>> = [];
  socket.on("message", (raw: WebSocket.RawData) => queue.push(JSON.parse(raw.toString())));
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  const next = async (types: string[]) => {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const index = queue.findIndex((message) => types.includes(message.type));
      if (index !== -1) return queue.splice(index, 1)[0]!;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${types.join("/")}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  send({ type: "hello", requestId: "h", token, client: { kind: "obsidian-plugin", version: "0.3.0", deviceName: "d" }, capabilities: { crdt: true } });
  await next(["hello_ok"]);
  send({ type: "subscribe_room", requestId: "s", roomId });
  await next(["room_snapshot"]);
  return { send, next };
}

describe("Blocked access", () => {
  it("stores an older client's Blocked choice - a deny of the reader preset - as a full block", async () => {
    const { member, owner, acl, rulesFor } = await roomWithMember();

    expect((await acl(owner.deviceToken, { subjectType: "user", subjectId: member.user.id, effect: "deny", preset: "reader", pathPattern: "secret/**/*" })).statusCode).toBe(200);

    const [rule] = await rulesFor(member.user.id);
    expect(new Set(rule!.permissions)).toEqual(new Set(EDITOR_PERMISSIONS));
  });

  it("rejects an unknown preset, and the blocked preset on an allow rule", async () => {
    const { member, owner, acl } = await roomWithMember();

    const unknown = await acl(owner.deviceToken, { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "admin", pathPattern: "**/*" });
    const blockedAllow = await acl(owner.deviceToken, { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "blocked", pathPattern: "**/*" });

    expect(unknown.statusCode).toBe(422);
    expect(blockedAllow.statusCode).toBe(422);
  });

  it("closes a Blocked folder to reading, creating, writing, deleting and renaming, on both lanes", async () => {
    const { app, owner, member, room, acl, put } = await roomWithMember({ crdtEnabled: true });
    expect((await put(owner.deviceToken, { relativePath: "secret/plan.txt", baseVersion: 0, content: "plan" })).statusCode).toBe(200);
    const ownerSocket = await syncSocket(app, owner.deviceToken, room.id);
    ownerSocket.send({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "secret/notes.md" });
    const created = await ownerSocket.next(["crdt_created"]);
    await acl(owner.deviceToken, { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "editor", pathPattern: "**/*" });
    await acl(owner.deviceToken, { subjectType: "user", subjectId: member.user.id, effect: "deny", preset: "blocked", pathPattern: "secret/**/*" });

    const token = member.deviceToken;
    const read = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/files/content?path=secret/plan.txt`, headers: { authorization: `Bearer ${token}` } });
    const write = await put(token, { relativePath: "secret/plan.txt", baseVersion: 1, content: "changed" });
    const create = await put(token, { relativePath: "secret/new.txt", baseVersion: 0, content: "new" });
    const remove = await app.inject({ method: "POST", url: `/api/rooms/${room.id}/files/delete`, headers: { authorization: `Bearer ${token}` }, payload: { relativePath: "secret/plan.txt", baseVersion: 1 } });
    for (const response of [read, write, create, remove]) {
      expect(response.statusCode).toBe(403);
    }

    const memberSocket = await syncSocket(app, token, room.id);
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "changed");
    const update = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
    const attempts = [
      { type: "crdt_update", requestId: "u", roomId: room.id, relativePath: "secret/notes.md", epoch: created.epoch, update },
      { type: "crdt_create", requestId: "c", roomId: room.id, relativePath: "secret/other.md" },
      { type: "crdt_rename", requestId: "r", roomId: room.id, oldRelativePath: "secret/notes.md", relativePath: "open/notes.md" },
      { type: "file_change", requestId: "f", roomId: room.id, relativePath: "secret/plan.txt", baseVersion: 1, content: "changed" },
      { type: "file_delete", requestId: "d", roomId: room.id, relativePath: "secret/plan.txt", baseVersion: 1 }
    ];
    for (const attempt of attempts) {
      memberSocket.send(attempt);
      const answer = await memberSocket.next(["crdt_rejected", "file_change_rejected", "crdt_created", "crdt_renamed", "file_change_ack", "file_delete_ack"]);
      expect(answer).toMatchObject({ code: "PERMISSION_DENIED" });
    }

    // Outside the blocked scope the editor grant still applies.
    expect((await put(token, { relativePath: "open/readme.txt", baseVersion: 0, content: "hello" })).statusCode).toBe(200);
  });

  it("replaces a Block when Can view is granted for the same person and scope", async () => {
    const { member, owner, acl, rulesFor } = await roomWithMember();
    await acl(owner.deviceToken, { subjectType: "user", subjectId: member.user.id, effect: "deny", preset: "blocked", pathPattern: "secret/**/*" });

    await acl(owner.deviceToken, { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "reader", pathPattern: "secret/**/*" });

    const rules = await rulesFor(member.user.id);
    expect(rules.filter((rule) => rule.effect === "deny")).toEqual([]);
    expect(rules).toEqual([expect.objectContaining({ effect: "allow", pathPattern: "secret/**/*" })]);
  });

  it("replaces a whole-room Block when the person accepts a new room invite", async () => {
    const { app, member, owner, room, acl, rulesFor } = await roomWithMember();
    await acl(owner.deviceToken, { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "editor", pathPattern: "**/*" });
    await acl(owner.deviceToken, { subjectType: "user", subjectId: member.user.id, effect: "deny", preset: "blocked", pathPattern: "**/*" });
    const invite = (
      await app.inject({ method: "POST", url: `/api/rooms/${room.id}/invites`, headers: { authorization: `Bearer ${owner.deviceToken}` }, payload: { preset: "reader" } })
    ).json();

    const accepted = await app.inject({
      method: "POST",
      url: "/api/invites/accept",
      headers: { authorization: `Bearer ${member.deviceToken}` },
      payload: { inviteToken: invite.inviteToken }
    });

    expect(accepted.statusCode).toBe(200);
    expect((await rulesFor(member.user.id)).filter((rule) => rule.effect === "deny")).toEqual([]);
  });

  it("returns a conflicting file's content only to callers who may read it", async () => {
    const { app, owner, member, room, acl, put } = await roomWithMember();
    expect((await put(owner.deviceToken, { relativePath: "inbox/report.txt", baseVersion: 0, content: "server copy" })).statusCode).toBe(200);
    // A drop-box style grant: may write into inbox/, may not read it.
    await acl(owner.deviceToken, { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "editor", pathPattern: "**/*" });
    await acl(owner.deviceToken, { subjectType: "user", subjectId: member.user.id, effect: "deny", permissions: ["file:read"], pathPattern: "inbox/**/*" });

    const ownerConflict = await put(owner.deviceToken, { relativePath: "inbox/report.txt", baseVersion: 7, content: "stale" });
    const memberConflict = await put(member.deviceToken, { relativePath: "inbox/report.txt", baseVersion: 7, content: "stale" });

    expect(ownerConflict.json().error).toMatchObject({ code: "VERSION_CONFLICT", details: { serverContent: "server copy" } });
    expect(memberConflict.json().error.code).toBe("VERSION_CONFLICT");
    expect(memberConflict.json().error.details).not.toHaveProperty("serverContent");
    expect(memberConflict.json().error.details).not.toHaveProperty("serverSha256");

    const memberSocket = await syncSocket(app, member.deviceToken, room.id);
    memberSocket.send({ type: "file_change", requestId: "f", roomId: room.id, relativePath: "inbox/report.txt", baseVersion: 7, content: "stale" });
    const rejected = await memberSocket.next(["file_change_rejected"]);
    expect(rejected.code).toBe("VERSION_CONFLICT");
    expect(rejected).not.toHaveProperty("serverContent");
    expect(rejected).not.toHaveProperty("serverSha256");
  });
});

describe("Blocked access migration", () => {
  it("widens denies that match the old reader-only Blocked, once, keeping a backup and an audit trail", async () => {
    const db = await openSqlJsDb(":memory:");
    runMigrations(db);
    // Make the database look like one written before this migration existed.
    db.prepare("delete from server_meta where key = 'acl_reader_denies_blocked'").run();
    const insertRule = db.prepare(
      "insert into acl_rules(id, room_id, subject_type, subject_id, effect, permissions_json, path_pattern, created_at) values (?, 'room_1', 'user', 'usr_b', 'deny', ?, ?, '2026-09-01T00:00:00.000Z')"
    );
    insertRule.run("acl_old_block", JSON.stringify([...READER_PERMISSIONS].reverse()), "secret/**/*");
    insertRule.run("acl_custom", JSON.stringify(["file:read"]), "inbox/**/*");

    runMigrations(db);

    const permissionsOf = (id: string) =>
      JSON.parse((db.prepare("select permissions_json from acl_rules where id = ?").get(id) as { permissions_json: string }).permissions_json) as string[];
    expect(new Set(permissionsOf("acl_old_block"))).toEqual(new Set(EDITOR_PERMISSIONS));
    expect(permissionsOf("acl_custom")).toEqual(["file:read"]);
    const backup = db.prepare("select rule_id, permissions_json from acl_rule_migration_backup").all() as Array<{ rule_id: string; permissions_json: string }>;
    expect(backup).toEqual([{ rule_id: "acl_old_block", permissions_json: JSON.stringify([...READER_PERMISSIONS].reverse()) }]);
    expect(db.prepare("select resource_id from audit_events where action = 'acl.block_migrated'").all()).toEqual([{ resource_id: "room_1" }]);

    // A later reader-only deny is someone's deliberate custom rule, not the old Blocked button.
    insertRule.run("acl_later", JSON.stringify([...READER_PERMISSIONS]), "later/**/*");
    runMigrations(db);
    expect(permissionsOf("acl_later")).toEqual([...READER_PERMISSIONS]);
    await db.close();
  });
});
