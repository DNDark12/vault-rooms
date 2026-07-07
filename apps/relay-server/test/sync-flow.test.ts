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

async function setupSyncFlow() {
  const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
  apps.push(app);
  const owner = (
    await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      remoteAddress: "127.0.0.1",
      payload: { displayName: "A", deviceName: "A laptop", teamName: "Demo" }
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
  const room = (
    await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Projects Demo", type: "folder", sourcePath: "Projects/Demo", mountName: "Projects Demo", capabilities: [] }
    })
  ).json().room;
  await app.inject({
    method: "POST",
    url: `/api/rooms/${room.id}/acl`,
    headers: { authorization: `Bearer ${owner.deviceToken}` },
    payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "editor", pathPattern: "**/*" }
  });
  await app.inject({
    method: "PUT",
    url: `/api/rooms/${room.id}/files/content`,
    headers: { authorization: `Bearer ${owner.deviceToken}` },
    payload: { relativePath: "Board.md", baseVersion: 0, content: "# Board\n" }
  });
  return { app, owner, member, room };
}

describe("WebSocket sync", () => {
  it("authenticates, broadcasts changes/deletes, rejects conflicts, snapshots on reconnect, and closes revoked sockets", async () => {
    const { app, owner, member, room } = await setupSyncFlow();
    const a = await connect(app);
    const b = await connect(app);

    a.sendJson({ type: "hello", requestId: "hello-a", token: owner.deviceToken, client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "A laptop" } });
    b.sendJson({ type: "hello", requestId: "hello-b", token: member.deviceToken, client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "B laptop" } });
    expect(await nextMessage(a, "hello_ok")).toMatchObject({ requestId: "hello-a", userId: owner.user.id });
    expect(await nextMessage(b, "hello_ok")).toMatchObject({ requestId: "hello-b", userId: member.user.id });

    a.sendJson({ type: "subscribe_room", requestId: "sub-a", roomId: room.id });
    b.sendJson({ type: "subscribe_room", requestId: "sub-b", roomId: room.id });
    expect(await nextMessage(a, "room_snapshot")).toMatchObject({ roomId: room.id, files: [expect.objectContaining({ relativePath: "Board.md", version: 1 })] });
    expect(await nextMessage(b, "room_snapshot")).toMatchObject({ roomId: room.id, files: [expect.objectContaining({ relativePath: "Board.md", version: 1 })] });

    a.sendJson({ type: "file_change", requestId: "a-change", roomId: room.id, relativePath: "Board.md", baseVersion: 1, content: "# Board\nA\n" });
    expect(await nextMessage(a, "file_change_ack")).toMatchObject({ requestId: "a-change", version: 2 });
    expect(await nextMessage(b, "remote_file_change")).toMatchObject({ relativePath: "Board.md", version: 2, content: "# Board\nA\n" });

    b.sendJson({ type: "file_change", requestId: "b-change", roomId: room.id, relativePath: "Board.md", baseVersion: 2, content: "# Board\nB\n" });
    expect(await nextMessage(b, "file_change_ack")).toMatchObject({ requestId: "b-change", version: 3 });
    expect(await nextMessage(a, "remote_file_change")).toMatchObject({ relativePath: "Board.md", version: 3, content: "# Board\nB\n" });

    b.sendJson({ type: "file_delete", requestId: "b-delete", roomId: room.id, relativePath: "Board.md", baseVersion: 3 });
    expect(await nextMessage(b, "file_delete_ack")).toMatchObject({ requestId: "b-delete", version: 4 });
    expect(await nextMessage(a, "remote_file_delete")).toMatchObject({ relativePath: "Board.md", version: 4 });

    // This REST write is authenticated as the owner device (same device as `a`), so the
    // broadcast excludes `a` but B (a different device) still gets it live.
    await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "Race.md", baseVersion: 0, content: "one" }
    });
    expect(await nextMessage(b, "remote_file_change")).toMatchObject({ relativePath: "Race.md", version: 1, content: "one" });

    a.sendJson({ type: "file_change", requestId: "race-a", roomId: room.id, relativePath: "Race.md", baseVersion: 1, content: "two" });
    b.sendJson({ type: "file_change", requestId: "race-b", roomId: room.id, relativePath: "Race.md", baseVersion: 1, content: "three" });
    expect(await nextMessage(a, "file_change_ack")).toMatchObject({ requestId: "race-a", version: 2 });
    expect(await nextMessage(b, "remote_file_change")).toMatchObject({ relativePath: "Race.md", version: 2, content: "two" });
    expect(await nextMessage(b, "file_change_rejected")).toMatchObject({ requestId: "race-b", code: "VERSION_CONFLICT", serverVersion: 2 });

    await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "Offline.md", baseVersion: 0, content: "server" }
    });
    b.close();
    await waitForClose(b);
    const b2 = await connect(app);
    b2.sendJson({ type: "hello", requestId: "hello-b2", token: member.deviceToken, client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "B laptop" } });
    expect(await nextMessage(b2, "hello_ok")).toMatchObject({ requestId: "hello-b2" });
    b2.sendJson({ type: "subscribe_room", requestId: "sub-b2", roomId: room.id });
    const snapshot = await nextMessage(b2, "room_snapshot");
    expect(snapshot.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "Board.md", deleted: true }),
        expect.objectContaining({ relativePath: "Offline.md", deleted: false }),
        expect.objectContaining({ relativePath: "Race.md", version: 2 })
      ])
    );

    // Team-membership revoke alone no longer force-closes sockets (visibility is re-evaluated on
    // the next room/file operation instead). Revoking the friend entirely (server owner only) is
    // the closest equivalent of "kick this user off my server" the old test exercised.
    const revokedMessage = nextMessage(b2, "revoked");
    const close = waitForClose(b2);
    const revoke = await app.inject({
      method: "POST",
      url: `/api/friends/${member.user.id}/revoke`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(revoke.statusCode).toBe(200);
    expect(await revokedMessage).toMatchObject({ message: "Your access to this server has been revoked." });
    await close;

    const b3 = await connect(app);
    b3.sendJson({ type: "hello", requestId: "hello-b3", token: member.deviceToken, client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "B laptop" } });
    expect(await nextMessage(b3, "hello_error")).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("broadcasts REST-pushed writes and deletes to subscribed WebSocket peers", async () => {
    // Regression test: the Obsidian plugin's local edits push over REST (PUT/POST), not the WS
    // file_change/file_delete messages. Other devices only see those edits if the REST routes
    // also broadcast through the same ConnectionRegistry the WS handler uses.
    const { app, owner, member, room } = await setupSyncFlow();
    const b = await connect(app);
    b.sendJson({ type: "hello", requestId: "hello-b", token: member.deviceToken, client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "B laptop" } });
    await nextMessage(b, "hello_ok");
    b.sendJson({ type: "subscribe_room", requestId: "sub-b", roomId: room.id });
    await nextMessage(b, "room_snapshot");

    const created = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "FromRest.md", baseVersion: 0, content: "from rest" }
    });
    expect(created.statusCode).toBe(200);
    expect(await nextMessage(b, "remote_file_change")).toMatchObject({ relativePath: "FromRest.md", version: 1, content: "from rest" });

    const deleted = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/files/delete`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "FromRest.md", baseVersion: 1 }
    });
    expect(deleted.statusCode).toBe(200);
    expect(await nextMessage(b, "remote_file_delete")).toMatchObject({ relativePath: "FromRest.md", version: 2 });
  });

  it("revokes a live subscription (without closing the socket) when the team-membership grant behind it is revoked", async () => {
    // Regression test: access that was only ever granted via a team-subject ACL rule must be
    // re-checked on already-open subscriptions once the underlying team membership is revoked -
    // broadcastToRoom must stop delivering remote_file_change/remote_file_delete to that socket.
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    apps.push(app);
    const owner = (
      await app.inject({
        method: "POST",
        url: "/api/bootstrap",
        remoteAddress: "127.0.0.1",
        payload: { displayName: "A", deviceName: "A laptop", teamName: "Demo" }
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
    const room = (
      await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { name: "Projects Demo", type: "folder", sourcePath: "Projects/Demo", mountName: "Projects Demo", capabilities: [] }
      })
    ).json().room;
    // Grant access only via a team-subject ACL rule - member has no user-specific ACL rule.
    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "team", subjectId: owner.team.id, effect: "allow", preset: "editor", pathPattern: "**/*" }
    });
    await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "Board.md", baseVersion: 0, content: "# Board\n" }
    });

    const b = await connect(app);
    b.sendJson({ type: "hello", requestId: "hello-b", token: member.deviceToken, client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "B laptop" } });
    await nextMessage(b, "hello_ok");
    b.sendJson({ type: "subscribe_room", requestId: "sub-b", roomId: room.id });
    await nextMessage(b, "room_snapshot");

    const revoke = await app.inject({
      method: "POST",
      url: `/api/teams/${owner.team.id}/members/${member.user.id}/revoke`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { reason: "No longer needed" }
    });
    expect(revoke.statusCode).toBe(200);

    expect(await nextMessage(b, "room_access_revoked")).toMatchObject({ roomId: room.id });
    expect(b.readyState).toBe(WebSocket.OPEN);

    // A fresh subscribe attempt must now be rejected as PERMISSION_DENIED.
    b.sendJson({ type: "subscribe_room", requestId: "sub-b-again", roomId: room.id });
    expect(await nextMessage(b, "file_change_rejected")).toMatchObject({ requestId: "sub-b-again", code: "PERMISSION_DENIED" });

    // Another device writing to the room must no longer reach the revoked socket.
    await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "Board.md", baseVersion: 1, content: "# Board\nOwner\n" }
    });
    await expect(nextMessage(b, "remote_file_change")).rejects.toThrow(/Timed out/);
  });

  it("revokes a live subscription when the ACL rule granting access is deleted", async () => {
    // Same regression as above, but the access-shrinking mutation is deleting the ACL rule
    // itself rather than revoking team membership.
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    apps.push(app);
    const owner = (
      await app.inject({
        method: "POST",
        url: "/api/bootstrap",
        remoteAddress: "127.0.0.1",
        payload: { displayName: "A", deviceName: "A laptop", teamName: "Demo" }
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
    const room = (
      await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { name: "Projects Demo", type: "folder", sourcePath: "Projects/Demo", mountName: "Projects Demo", capabilities: [] }
      })
    ).json().room;
    const aclRule = (
      await app.inject({
        method: "POST",
        url: `/api/rooms/${room.id}/acl`,
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { subjectType: "team", subjectId: owner.team.id, effect: "allow", preset: "editor", pathPattern: "**/*" }
      })
    ).json().aclRule;

    const b = await connect(app);
    b.sendJson({ type: "hello", requestId: "hello-b", token: member.deviceToken, client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "B laptop" } });
    await nextMessage(b, "hello_ok");
    b.sendJson({ type: "subscribe_room", requestId: "sub-b", roomId: room.id });
    await nextMessage(b, "room_snapshot");

    const deleteAcl = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${room.id}/acl/${aclRule.id}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(deleteAcl.statusCode).toBe(200);

    expect(await nextMessage(b, "room_access_revoked")).toMatchObject({ roomId: room.id });
    expect(b.readyState).toBe(WebSocket.OPEN);
  });
});

type JsonSocket = WebSocket & { sendJson: (payload: unknown) => void };

// Broadcasts can arrive on a socket in quick, uninterruptible bursts (e.g. two peers racing to
// write the same file). A "attach a one-shot listener, wait for a match" helper can silently
// drop messages that arrive while no listener happens to be attached between two sequential
// `await nextMessage(...)` calls. To make ordering irrelevant, every message received on a
// socket is buffered into a queue from the moment it connects, and `nextMessage` searches that
// queue (waiting for new arrivals if needed) instead of racing a transient listener.
const messageQueues = new WeakMap<WebSocket, unknown[]>();
const messageWaiters = new WeakMap<WebSocket, Array<() => void>>();
const closedSockets = new WeakSet<WebSocket>();

async function connect(app: Awaited<ReturnType<typeof createApp>>): Promise<JsonSocket> {
  await app.ready();
  const socket = (await app.injectWS("/sync")) as unknown as JsonSocket;
  socket.sendJson = (payload: unknown) => socket.send(JSON.stringify(payload));
  sockets.push(socket);
  messageQueues.set(socket, []);
  messageWaiters.set(socket, []);
  socket.on("message", (raw: WebSocket.RawData) => {
    messageQueues.get(socket)!.push(JSON.parse(raw.toString()));
    for (const wake of messageWaiters.get(socket)!.splice(0)) {
      wake();
    }
  });
  socket.on("close", () => {
    closedSockets.add(socket);
    for (const wake of messageWaiters.get(socket)!.splice(0)) {
      wake();
    }
  });
  return socket;
}

async function nextMessage(socket: WebSocket, type: string): Promise<any> {
  const deadline = Date.now() + 2_000;
  const queue = messageQueues.get(socket);
  if (!queue) {
    throw new Error("Socket was not created via connect()");
  }
  for (;;) {
    const index = queue.findIndex((message) => (message as { type?: string }).type === type);
    if (index !== -1) {
      return queue.splice(index, 1)[0];
    }
    if (closedSockets.has(socket)) {
      throw new Error(`Socket closed while waiting for ${type}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for ${type}`);
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, remaining);
      messageWaiters.get(socket)!.push(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

async function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}
