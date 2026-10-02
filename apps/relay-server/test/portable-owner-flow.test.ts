import { describe, expect, it, vi } from "vitest";
import { createAppWithDb } from "../src/appCore.js";
import { openSqlJsDb } from "../src/db/sqlJsAdapter.js";
import type { RelayRepository } from "../src/db/repositories/relayRepository.js";
import type { ConnectionRegistry, SyncConnection } from "../src/sync/connectionRegistry.js";
import type { SyncServerMessage } from "@vault-rooms/protocol";
import { injectBootstrap } from "./bootstrapHelper.js";
async function setup() {
  const db = await openSqlJsDb(":memory:");
  const app = await createAppWithDb(db);
  const owner = (await injectBootstrap(app, { displayName: "Owner", deviceName: "Laptop", teamName: "Team" })).json();
  const headers = { authorization: `Bearer ${owner.deviceToken}` };
  const room = (await app.inject({
    method: "POST", url: "/api/rooms", headers, payload: {
      name: "Room", type: "folder", sourcePath: "Room", mountName: "Room", capabilities: [], crdtEnabled: false
    }
  })).json().room;
  const { testRepo: repo, testConnectionRegistry: registry } = app as unknown as {
    testRepo: RelayRepository;
    testConnectionRegistry: ConnectionRegistry;
  };
  const invite = (await app.inject({
    method: "POST", url: `/api/teams/${owner.team.id}/invites`, headers,
    payload: { role: "member", expiresInMinutes: 60, maxUses: 4 }
  })).json();
  const subscribe = async (label: string, paths: string[]) => {
    const member = (await app.inject({
      method: "POST", url: "/api/join", payload: {
        inviteToken: invite.inviteToken, displayName: label, deviceName: label
      }
    })).json();
    repo.createAclRule({
      roomId: room.id, actorUserId: owner.user.id, subjectType: "user", subjectId: member.user.id,
      effect: "allow", permissions: ["sync:subscribe"], pathPattern: "**/*"
    });
    for (const path of paths)
      repo.createAclRule({
        roomId: room.id, actorUserId: owner.user.id, subjectType: "user", subjectId: member.user.id,
        effect: "allow", permissions: ["file:read"], pathPattern: path
      });
    const messages: SyncServerMessage[] = [];
    const connection: SyncConnection = {
      id: member.device.id, principal: repo.authenticateDeviceToken(member.deviceToken), subscriptions: new Set([room.id]),
      capabilities: { crdt: true, presence: false, extendedBinarySync: true, portablePaths: true },
      socket: { OPEN: 1, readyState: 1, send: payload => { messages.push(JSON.parse(payload)); }, close() { }, ping() { } }
    };
    registry.add(connection);
    return { messages, member };
  };
  const rename = (fileId: string, relativePath: string) => app.inject({
    method: "POST", url: `/api/rooms/${room.id}/files/rename`,
    headers, payload: { fileId, relativePath }
  });
  return { app, db, repo, registry, owner, room, subscribe, rename };
}
describe("owner portable name repair", () => {
  it("rejects a missing or null rename body with the normal validation response", async () => {
    const { app, room, owner } = await setup();
    try {
      for (const payload of [undefined, "null"]) {
        const response = await app.inject({ method: "POST", url: `/api/rooms/${room.id}/files/rename`, headers: { authorization: `Bearer ${owner.deviceToken}`, ...(payload ? { "content-type": "application/json" } : {}) }, ...(payload ? { payload } : {}) });
        expect(response.statusCode).toBe(422);
        expect(response.json().error.code).toBe("VALIDATION_ERROR");
      }
    }
    finally {
      await app.close();
    }
  });
  it.each([false, true])("partitions rename events by read permission on both paths (Live editing: %s)", async (liveEditing) => {
    const { app, repo, owner, room, subscribe, rename } = await setup();
    try {
      const both = await subscribe("both", ["Old.md", "New.md"]);
      const oldOnly = await subscribe("old", ["Old.md"]);
      const newOnly = await subscribe("new", ["New.md"]);
      const neither = await subscribe("neither", []);
      repo.writeFile({ roomId: room.id, relativePath: "Old.md", baseVersion: 0, content: "unchanged", actorUserId: owner.user.id });
      const original = repo.getFile(room.id, "Old.md")!;
      repo.setRoomCrdtEnabled({ roomId: room.id, actorUserId: owner.user.id, enabled: liveEditing });
      const response = await rename(original.id, "New.md");
      expect(response.statusCode).toBe(200);
      const events = (messages: SyncServerMessage[]) => messages.filter(message => message.type !== "room_snapshot");
      expect(events(both.messages)).toEqual(liveEditing ? [expect.objectContaining({ type: "remote_crdt_rename", oldRelativePath: "Old.md", relativePath: "New.md" })] : [expect.objectContaining({ type: "remote_file_delete", relativePath: "Old.md" }), expect.objectContaining({ type: "remote_file_change", relativePath: "New.md" })]);
      expect(events(oldOnly.messages)).toEqual([expect.objectContaining({ type: "remote_file_delete", relativePath: "Old.md" })]);
      expect(events(newOnly.messages)).toEqual([expect.objectContaining({ type: "remote_file_change", relativePath: "New.md", content: "unchanged", ...(liveEditing ? { crdtEpoch: original.crdt_epoch } : {}) })]);
      expect(events(neither.messages)).toEqual([]);
      expect(JSON.stringify(oldOnly.messages)).not.toContain("New.md");
      expect(JSON.stringify(newOnly.messages)).not.toContain("Old.md");
      expect(JSON.stringify(neither.messages)).not.toMatch(/Old\.md|New\.md/);
      for (const peer of [both, oldOnly, newOnly, neither])
        expect(peer.messages.some(message => message.type === "room_snapshot")).toBe(false);
    }
    finally {
      await app.close();
    }
  });
  it("reconciles collision repair by snapshot while preserving both identities and their histories", async () => {
    const { app, db, repo, owner, room, subscribe, rename } = await setup();
    try {
      const peer = await subscribe("peer", ["**/*"]);
      repo.writeFile({ roomId: room.id, relativePath: "Old.md", baseVersion: 0, content: "first", actorUserId: owner.user.id });
      repo.writeFile({ roomId: room.id, relativePath: "Alias.md", baseVersion: 0, content: "second", actorUserId: owner.user.id });
      const first = repo.getFile(room.id, "Old.md")!;
      const second = repo.getFile(room.id, "Alias.md")!;
      // Model the legacy preflight's quarantined rows without selecting either identity as winner.
      db.prepare("update files set path_collision = 1 where id in (?, ?)").run(first.id, second.id);
      db.prepare("update files set relative_path = 'old.MD', path_key = ? where id = ?").run(first.path_key, second.id);
      expect((await rename(first.id, "Recovered.md")).statusCode).toBe(200);
      expect(peer.messages).toEqual([expect.objectContaining({
        type: "room_snapshot", files: expect.arrayContaining([
          expect.objectContaining({ relativePath: "Recovered.md", deleted: false }),
          expect.objectContaining({ relativePath: "old.MD", deleted: false })
        ])
      })]);
      expect(repo.getFile(room.id, "Recovered.md")).toMatchObject({ id: first.id, crdt_epoch: first.crdt_epoch });
      expect(repo.getFile(room.id, "old.MD")).toMatchObject({ id: second.id, crdt_epoch: second.crdt_epoch });
      expect(repo.latestFileVersion(first.id)?.content).toBe("first");
      expect(repo.latestFileVersion(second.id)?.content).toBe("second");
    }
    finally {
      await app.close();
    }
  });
  it.each(["content", "identity", "epoch", "delete"])("falls back to a fresh snapshot if %s changes during content I/O", async (change) => {
    const { app, db, repo, room, owner, subscribe, rename } = await setup();
    try {
      const peer = await subscribe("peer", ["**/*"]);
      repo.writeFile({ roomId: room.id, relativePath: "Old.csv", baseVersion: 0, content: "original", actorUserId: owner.user.id });
      const fileId = repo.getFile(room.id, "Old.csv")!.id;
      const read = repo.readFileContent.bind(repo);
      const spy = vi.spyOn(repo, "readFileContent").mockImplementation((roomId, path) => {
        const result = read(roomId, path);
        if (change === "content")
          repo.writeFile({ roomId, relativePath: path, baseVersion: result.file.version, content: "newer", actorUserId: owner.user.id });
        else if (change === "identity") {
          db.prepare("delete from files where id = ?").run(fileId);
          repo.writeFile({ roomId, relativePath: path, baseVersion: 0, content: "replacement", actorUserId: owner.user.id });
        }
        else if (change === "epoch")
          db.prepare("update files set crdt_epoch = crdt_epoch + 1 where id = ?").run(fileId);
        else
          repo.deleteFile({ roomId, relativePath: path, baseVersion: result.file.version, actorUserId: owner.user.id });
        return result;
      });
      expect((await rename(fileId, "New.csv")).statusCode).toBe(200);
      spy.mockRestore();
      expect(peer.messages).toEqual([expect.objectContaining({ type: "room_snapshot" })]);
      const snapshot = peer.messages[0] as Extract<SyncServerMessage, { type: "room_snapshot" }>;
      expect(snapshot.files).toContainEqual(expect.objectContaining({
        relativePath: "New.csv", deleted: change === "delete",
        version: change === "content" || change === "delete" ? 2 : 1
      }));
      expect(JSON.stringify(peer.messages)).not.toContain("original");
    }
    finally {
      await app.close();
    }
  });
  it.each(["content read", "fanout"])("keeps the committed rename and snapshot fallback after a failed %s", async (failure) => {
    const { app, repo, registry, room, owner, subscribe, rename } = await setup();
    try {
      const peer = await subscribe("peer", ["**/*"]);
      repo.writeFile({ roomId: room.id, relativePath: "Old.csv", baseVersion: 0, content: "original", actorUserId: owner.user.id });
      const fileId = repo.getFile(room.id, "Old.csv")!.id;
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const failureSpy = failure === "content read"
        ? vi.spyOn(repo, "readFileContent").mockImplementationOnce(() => { throw new Error("read failed"); })
        : vi.spyOn(registry, "broadcastToRoom").mockImplementationOnce(() => { throw new Error("fanout failed"); });
      const response = await rename(fileId, "New.csv");
      failureSpy.mockRestore();
      warning.mockRestore();
      expect(response.json()).toMatchObject({ ok: true, fileId, relativePath: "New.csv", version: 1 });
      expect(peer.messages).toEqual([expect.objectContaining({ type: "room_snapshot" })]);
      expect(repo.getFile(room.id, "New.csv")?.id).toBe(fileId);
    }
    finally {
      await app.close();
    }
  });
  it("preserves binary identity/history and exact bytes, and rejects a repair that changes its encoding", async () => {
    const { app, repo, owner, room, rename } = await setup();
    try {
      repo.writeFile({ roomId: room.id, relativePath: "Photo.png", baseVersion: 0, content: "AP+AAQ==", actorUserId: owner.user.id });
      const original = repo.getFile(room.id, "Photo.png")!;
      expect((await rename(original.id, "Recovered.txt")).statusCode).toBe(422);
      expect(repo.getFile(room.id, "Photo.png")?.id).toBe(original.id);
      expect((await rename(original.id, "Recovered.png")).statusCode).toBe(200);
      expect(repo.getFile(room.id, "Recovered.png")).toMatchObject({ id: original.id, crdt_epoch: original.crdt_epoch });
      expect(repo.latestFileVersion(original.id)?.content).toBe("AP+AAQ==");
    }
    finally {
      await app.close();
    }
  });
  it("returns the committed rename result and a fresh snapshot if the identity moves again during content I/O", async () => {
    const { app, repo, owner, room, subscribe, rename } = await setup();
    try {
      const peer = await subscribe("peer", ["**/*"]);
      repo.writeFile({ roomId: room.id, relativePath: "Old.csv", baseVersion: 0, content: "original", actorUserId: owner.user.id });
      const fileId = repo.getFile(room.id, "Old.csv")!.id;
      const originalRead = repo.readFileContent.bind(repo);
      const spy = vi.spyOn(repo, "readFileContent").mockImplementation((roomId, path) => {
        const result = originalRead(roomId, path);
        if (path === "First.csv")
          repo.renameFileById({ roomId, fileId, relativePath: "Second.csv", actorUserId: owner.user.id });
        return result;
      });
      const response = await rename(fileId, "First.csv");
      spy.mockRestore();
      expect(response.json()).toMatchObject({ ok: true, relativePath: "First.csv", fileId, version: 1 });
      expect(peer.messages.every(message => message.type === "room_snapshot")).toBe(true);
      expect(peer.messages).toContainEqual(expect.objectContaining({ files: expect.arrayContaining([expect.objectContaining({ relativePath: "Second.csv", deleted: false })]) }));
      expect(repo.getFile(room.id, "Second.csv")?.id).toBe(fileId);
    }
    finally {
      await app.close();
    }
  });
  it("uses the current room mode if Live editing changes during rename content I/O", async () => {
    const { app, repo, room, owner, subscribe, rename } = await setup();
    try {
      const peer = await subscribe("peer", ["**/*"]);
      repo.writeFile({ roomId: room.id, relativePath: "Old.md", baseVersion: 0, content: "note", actorUserId: owner.user.id });
      const fileId = repo.getFile(room.id, "Old.md")!.id;
      repo.setRoomCrdtEnabled({ roomId: room.id, actorUserId: owner.user.id, enabled: true });
      const read = repo.readFileContent.bind(repo);
      vi.spyOn(repo, "readFileContent").mockImplementation((roomId, path) => {
        const result = read(roomId, path);
        repo.setRoomCrdtEnabled({ roomId, actorUserId: owner.user.id, enabled: false });
        return result;
      });
      expect((await rename(fileId, "New.md")).statusCode).toBe(200);
      expect(peer.messages.map(message => message.type)).toEqual(["remote_file_delete", "remote_file_change", "room_snapshot"]);
      expect(peer.messages.filter(message => "crdtEpoch" in message)).toEqual([]);
      const snapshot = peer.messages[2] as Extract<SyncServerMessage, {
        type: "room_snapshot";
      }>;
      expect(snapshot.files.some(file => file.crdtEpoch !== undefined)).toBe(false);
    }
    finally {
      await app.close();
    }
  });
});
