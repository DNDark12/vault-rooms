import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../src/app.js";

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  for (const app of apps.splice(0)) {
    await app.close();
  }
});

type JsonSocket = WebSocket & { sendJson: (payload: unknown) => void };

async function connect(url: string): Promise<JsonSocket> {
  const socket = new WebSocket(url) as JsonSocket;
  socket.sendJson = (payload: unknown) => socket.send(JSON.stringify(payload));
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function nextMessage(socket: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString());
      if (message.type === type) {
        clearTimeout(timeout);
        socket.off("message", onMessage);
        resolve(message);
      }
    };
    socket.on("message", onMessage);
  });
}

async function bootstrapOwnerAndMember() {
  const app = await createApp({
    dbPath: ":memory:",
    publicUrl: "http://127.0.0.1:8787",
    allowRemoteBootstrap: false
  });
  const owner = (
    await app.inject({
      method: "POST",
      url: "/api/teams/bootstrap",
      remoteAddress: "127.0.0.1",
      payload: { teamName: "Demo", ownerDisplayName: "A", ownerDeviceName: "A laptop" }
    })
  ).json();
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

  const created = await app.inject({
    method: "POST",
    url: `/api/teams/${owner.team.id}/rooms`,
    headers: { authorization: `Bearer ${owner.deviceToken}` },
    payload: { name: "Projects Demo", type: "folder", sourcePath: "Projects/Demo", mountName: "Projects Demo", capabilities: [] }
  });
  const room = created.json().room;

  return { app, owner, member, room };
}

describe("delete room/team/acl", () => {
  it("bootstraps the owner with role=owner and members with their invite role", async () => {
    const { owner, member } = await bootstrapOwnerAndMember();
    expect(owner.role).toBe("owner");
    expect(member.role).toBe("member");
  });

  it("rejects room deletion from a member with no manage rights, then allows the owner", async () => {
    const { app, owner, member, room } = await bootstrapOwnerAndMember();

    const memberDelete = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${room.id}`,
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(memberDelete.statusCode).toBe(403);

    const ownerDelete = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${room.id}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(ownerDelete.statusCode).toBe(200);

    const afterDelete = await app.inject({
      method: "GET",
      url: `/api/teams/${owner.team.id}/rooms`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(afterDelete.json().rooms).toEqual([]);

    const patchDeleted = await app.inject({
      method: "PATCH",
      url: `/api/rooms/${room.id}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "x", type: "folder", sourcePath: "x", mountName: "x", capabilities: [] }
    });
    expect(patchDeleted.statusCode).toBe(404);
  });

  it("grants then removes a room ACL rule", async () => {
    const { app, owner, member, room } = await bootstrapOwnerAndMember();

    const grant = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "reader", pathPattern: "**/*" }
    });
    expect(grant.statusCode).toBe(200);
    const aclId = grant.json().aclRule.id;

    const bBefore = await app.inject({
      method: "GET",
      url: `/api/teams/${owner.team.id}/rooms`,
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(bBefore.json().rooms).toHaveLength(1);

    const memberRemove = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${room.id}/acl/${aclId}`,
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(memberRemove.statusCode).toBe(403);

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${room.id}/acl/${aclId}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(remove.statusCode).toBe(200);

    const bAfter = await app.inject({
      method: "GET",
      url: `/api/teams/${owner.team.id}/rooms`,
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(bAfter.json().rooms).toEqual([]);
  });

  it("rejects team deletion from non-owners, then lets the owner delete the whole team", async () => {
    const { app, owner, member } = await bootstrapOwnerAndMember();

    const memberDelete = await app.inject({
      method: "DELETE",
      url: `/api/teams/${owner.team.id}`,
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(memberDelete.statusCode).toBe(403);

    const ownerDelete = await app.inject({
      method: "DELETE",
      url: `/api/teams/${owner.team.id}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(ownerDelete.statusCode).toBe(200);

    const afterDelete = await app.inject({
      method: "GET",
      url: `/api/teams/${owner.team.id}/rooms`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    // The owner's own device token is gone along with the team, so this now fails auth.
    expect(afterDelete.statusCode).toBe(401);
  });

  it("notifies a subscribed WebSocket peer when their room is deleted, and does not crash on re-subscribe to an already-deleted room", async () => {
    const { app, owner, member, room } = await bootstrapOwnerAndMember();
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const syncUrl = `ws://127.0.0.1:${address.port}/sync`;

    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "reader", pathPattern: "**/*" }
    });

    const b = await connect(syncUrl);
    b.sendJson({ type: "hello", requestId: "hello-b", token: member.deviceToken, client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "B laptop" } });
    await nextMessage(b, "hello_ok");
    b.sendJson({ type: "subscribe_room", requestId: "sub-b", roomId: room.id });
    await nextMessage(b, "room_snapshot");

    const roomDeletedWhileSubscribed = nextMessage(b, "room_deleted");
    const ownerDelete = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${room.id}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(ownerDelete.statusCode).toBe(200);
    expect(await roomDeletedWhileSubscribed).toMatchObject({ roomId: room.id });

    // Simulates a device that had this room mounted but was offline when it was deleted: it
    // reconnects and tries to (re)subscribe to a room id that no longer exists server-side.
    // Before the fix this threw inside the fire-and-forget message handler (unhandled rejection)
    // instead of sending a normal response.
    b.sendJson({ type: "subscribe_room", requestId: "sub-b-again", roomId: room.id });
    expect(await nextMessage(b, "room_deleted")).toMatchObject({ roomId: room.id });
  });
});
