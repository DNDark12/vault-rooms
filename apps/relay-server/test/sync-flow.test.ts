import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../src/app.js";
import type { RelayRepository } from "../src/db/repositories/relayRepository.js";
import { ConnectionRegistry } from "../src/sync/connectionRegistry.js";
import type { CrdtDocManager } from "../src/sync/crdtDocManager.js";
import { handleSyncSocket, type SyncTimerHost } from "../src/sync/syncServer.js";
import { injectBootstrap } from "./bootstrapHelper.js";

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
  it("keeps websocket framing headroom above the application file-size limit", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787", maxFileBytes: 32 });
    apps.push(app);
    const owner = (await injectBootstrap(app, { displayName: "A", deviceName: "A laptop" })).json();
    const room = (
      await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { name: "Room", type: "folder", sourcePath: "Room", mountName: "Room", capabilities: [] }
      })
    ).json().room;
    const socket = await connect(app);
    socket.sendJson({
      type: "hello",
      requestId: "hello-small-limit",
      token: owner.deviceToken,
      client: { kind: "obsidian-plugin", version: "0.2.0", deviceName: "A laptop" }
    });
    expect(await nextMessage(socket, "hello_ok")).toMatchObject({ requestId: "hello-small-limit" });

    socket.sendJson({
      type: "file_change",
      requestId: "oversized-file",
      roomId: room.id,
      relativePath: "Big.md",
      baseVersion: 0,
      content: "x".repeat(33)
    });
    expect(await nextMessage(socket, "file_change_rejected")).toMatchObject({
      requestId: "oversized-file",
      code: "FILE_TOO_LARGE"
    });
  });

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

  it("does not broadcast remote_file_change/remote_file_delete for paths outside a subscriber's path-scoped ACL grant", async () => {
    // Regression test: broadcastToRoom used to only check room-level subscription, not the
    // per-path file:read grant - so a member limited to "public/**/*" would still receive the
    // full content of files outside that scope in realtime, even though the REST read path
    // (file.routes.ts) already enforces file:read per path via assertRoomPermission.
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    apps.push(app);
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
        payload: { inviteToken: invite.inviteToken, displayName: "M", deviceName: "M laptop" }
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
    // Member M is a reader, but only scoped to "public/**/*" - unlike every other ACL fixture in
    // this file, which grants "**/*".
    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "reader", pathPattern: "public/**/*" }
    });
    // Room-level sync:subscribe still needs a room-scoped grant since evaluatePolicy's implicit
    // owner allow doesn't apply to M; grant it broadly so subscribing itself is not the reason
    // for any failure - only file:read is path-scoped in this test.
    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", permissions: ["sync:subscribe"], pathPattern: "**/*" }
    });

    const editor = await connect(app);
    editor.sendJson({ type: "hello", requestId: "hello-a", token: owner.deviceToken, client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "A laptop" } });
    await nextMessage(editor, "hello_ok");
    editor.sendJson({ type: "subscribe_room", requestId: "sub-a", roomId: room.id });
    await nextMessage(editor, "room_snapshot");

    const reader = await connect(app);
    reader.sendJson({ type: "hello", requestId: "hello-m", token: member.deviceToken, client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "M laptop" } });
    await nextMessage(reader, "hello_ok");
    reader.sendJson({ type: "subscribe_room", requestId: "sub-m", roomId: room.id });
    await nextMessage(reader, "room_snapshot");

    // A writes outside M's path grant via the WS file_change path - M must not see it.
    editor.sendJson({ type: "file_change", requestId: "secret-1", roomId: room.id, relativePath: "secret/plan.md", baseVersion: 0, content: "top secret" });
    expect(await nextMessage(editor, "file_change_ack")).toMatchObject({ requestId: "secret-1" });
    await expect(nextMessage(reader, "remote_file_change")).rejects.toThrow(/Timed out/);

    // A writes inside M's path grant - M must receive it.
    editor.sendJson({ type: "file_change", requestId: "public-1", roomId: room.id, relativePath: "public/notes.md", baseVersion: 0, content: "hello public" });
    expect(await nextMessage(editor, "file_change_ack")).toMatchObject({ requestId: "public-1" });
    expect(await nextMessage(reader, "remote_file_change")).toMatchObject({ relativePath: "public/notes.md", content: "hello public" });

    // Same gap, but via the REST write path (file.routes.ts), which calls the same
    // ConnectionRegistry.broadcastToRoom.
    const restSecret = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "secret/rest.md", baseVersion: 0, content: "rest secret" }
    });
    expect(restSecret.statusCode).toBe(200);
    await expect(nextMessage(reader, "remote_file_change")).rejects.toThrow(/Timed out/);

    const restPublic = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "public/rest.md", baseVersion: 0, content: "rest public" }
    });
    expect(restPublic.statusCode).toBe(200);
    expect(await nextMessage(reader, "remote_file_change")).toMatchObject({ relativePath: "public/rest.md", content: "rest public" });
  });

  it("filters room_snapshot files on subscribe_room to only paths the subscriber can file:read", async () => {
    // Regression test: subscribe_room's room_snapshot used to be built from an unfiltered
    // repo.listFiles(room.id) - so a member with room-wide sync:subscribe but a path-scoped
    // file:read grant (e.g. "public/**/*") would receive every file's relativePath/version/sha256
    // for the whole room on subscribe (and on reconnect), leaking the existence and content-hash
    // of files outside their read scope. This is the same confidentiality boundary the
    // remote_file_change/remote_file_delete broadcast fix established, leaked via the snapshot path.
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    apps.push(app);
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
        payload: { inviteToken: invite.inviteToken, displayName: "M", deviceName: "M laptop" }
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
    // Member M is a reader, but only scoped to "public/**/*" - unlike every other ACL fixture in
    // this file, which grants "**/*".
    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "reader", pathPattern: "public/**/*" }
    });
    // Room-level sync:subscribe is granted broadly so subscribing itself is not the reason for
    // any filtering - only file:read is path-scoped in this test.
    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", permissions: ["sync:subscribe"], pathPattern: "**/*" }
    });

    // Files are created BEFORE the reader subscribes, so they land in the snapshot rather than a
    // live broadcast.
    const publicWrite = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "public/a.md", baseVersion: 0, content: "hello public" }
    });
    expect(publicWrite.statusCode).toBe(200);
    const secretWrite = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "secret/b.md", baseVersion: 0, content: "top secret" }
    });
    expect(secretWrite.statusCode).toBe(200);

    const reader = await connect(app);
    reader.sendJson({ type: "hello", requestId: "hello-m", token: member.deviceToken, client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "M laptop" } });
    await nextMessage(reader, "hello_ok");
    reader.sendJson({ type: "subscribe_room", requestId: "sub-m", roomId: room.id });
    const readerSnapshot = await nextMessage(reader, "room_snapshot");
    expect(readerSnapshot.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ relativePath: "public/a.md" })])
    );
    expect(readerSnapshot.files).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ relativePath: "secret/b.md" })])
    );

    // A full-access reader (the owner) subscribing still gets the whole room.
    const ownerConn = await connect(app);
    ownerConn.sendJson({ type: "hello", requestId: "hello-a", token: owner.deviceToken, client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "A laptop" } });
    await nextMessage(ownerConn, "hello_ok");
    ownerConn.sendJson({ type: "subscribe_room", requestId: "sub-a", roomId: room.id });
    const ownerSnapshot = await nextMessage(ownerConn, "room_snapshot");
    expect(ownerSnapshot.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "public/a.md" }),
        expect.objectContaining({ relativePath: "secret/b.md" })
      ])
    );
  });

  it("filters GET /api/rooms/:roomId/files to only paths the caller can file:read", async () => {
    // Regression test: this REST listing endpoint used to do a single top-level
    // assertRoomPermission({ permission: "file:read" }) (relativePath defaulting to "") and then
    // return repo.listFiles(room.id) completely unfiltered - the exact same class of leak already
    // fixed for the WS room_snapshot and for the file-change/file-delete broadcasts, but missed
    // here. A reader scoped to "public/**/*" must not see files outside that scope in the listing.
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    apps.push(app);
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
        payload: { inviteToken: invite.inviteToken, displayName: "M", deviceName: "M laptop" }
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
    // Member M is a reader, but only scoped to "public/**/*" - unlike every other ACL fixture in
    // this file, which grants "**/*".
    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "reader", pathPattern: "public/**/*" }
    });

    const publicWrite = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "public/notes.md", baseVersion: 0, content: "hello public" }
    });
    expect(publicWrite.statusCode).toBe(200);
    const secretWrite = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "secret/plan.md", baseVersion: 0, content: "top secret" }
    });
    expect(secretWrite.statusCode).toBe(200);

    const listing = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files`,
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(listing.statusCode).toBe(200);
    expect(listing.json().files).toEqual(
      expect.arrayContaining([expect.objectContaining({ relativePath: "public/notes.md" })])
    );
    expect(listing.json().files).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ relativePath: "secret/plan.md" })])
    );

    // A full-access reader (the owner) still gets the whole room.
    const ownerListing = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(ownerListing.statusCode).toBe(200);
    expect(ownerListing.json().files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "public/notes.md" }),
        expect.objectContaining({ relativePath: "secret/plan.md" })
      ])
    );
  });

  it("excludes files matched by a more specific deny rule on a subpath despite a broad file:read allow, in GET /api/rooms/:roomId/files", async () => {
    // Sharper version of the same bug: a broad allow "**/*" plus a specific deny on a subpath
    // (e.g. "secret/**/*") should still block the denied files from the listing. Before the fix,
    // the single relativePath="" assertRoomPermission check trivially passed (the deny rule
    // doesn't match relativePath="") and the listing leaked every file including the denied ones.
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    apps.push(app);
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
        payload: { inviteToken: invite.inviteToken, displayName: "M", deviceName: "M laptop" }
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
    // Broad allow covering the whole room, including relativePath="".
    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "reader", pathPattern: "**/*" }
    });
    // More specific deny on a subpath - must still block those files from the listing.
    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "deny", permissions: ["file:read"], pathPattern: "secret/**/*" }
    });

    const publicWrite = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "public/notes.md", baseVersion: 0, content: "hello public" }
    });
    expect(publicWrite.statusCode).toBe(200);
    const secretWrite = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "secret/plan.md", baseVersion: 0, content: "top secret" }
    });
    expect(secretWrite.statusCode).toBe(200);

    const listing = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files`,
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(listing.statusCode).toBe(200);
    expect(listing.json().files).toEqual(
      expect.arrayContaining([expect.objectContaining({ relativePath: "public/notes.md" })])
    );
    expect(listing.json().files).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ relativePath: "secret/plan.md" })])
    );
  });

  it("revokes a live subscription (without closing the socket) when the team-membership grant behind it is revoked", async () => {
    // Regression test: access that was only ever granted via a team-subject ACL rule must be
    // re-checked on already-open subscriptions once the underlying team membership is revoked -
    // broadcastToRoom must stop delivering remote_file_change/remote_file_delete to that socket.
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    apps.push(app);
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

describe("WebSocket admission timeout", () => {
  it("closes unauthenticated sockets after 10 seconds and clears the timeout after hello", async () => {
    const timers = new FakeSyncTimerHost();
    const registry = new ConnectionRegistry();
    const unauthenticated = new FakeSyncSocket();

    handleSyncSocket(unauthenticated, {} as RelayRepository, registry, {
      maxFileBytes: 1024,
      maxConnections: 5,
      transport: "http",
      timerHost: timers,
      crdtDocManager: {} as unknown as CrdtDocManager
    });

    expect(registry.size()).toBe(1);
    timers.runTimeout(10_000);
    expect(unauthenticated.close).toHaveBeenCalledWith(1008, "Authentication timeout");
    expect(registry.size()).toBe(0);

    const authenticated = new FakeSyncSocket();
    const repo = {
      authenticateDeviceToken: () => ({
        deviceId: "device_1",
        deviceDisplayName: "Laptop",
        deviceRevokedAt: null,
        userId: "user_1",
        userDisplayName: "Owner",
        userRevokedAt: null,
        isServerOwner: true,
        tokenSecurity: "plain"
      }),
      getSecurityState: () => "plain_legacy",
      isLegacyPlainToken: () => false,
      markDeviceTransport: vi.fn(),
      audit: vi.fn()
    } as unknown as RelayRepository;
    handleSyncSocket(authenticated, repo, registry, {
      maxFileBytes: 1024,
      maxConnections: 5,
      transport: "http",
      timerHost: timers,
      crdtDocManager: {} as unknown as CrdtDocManager
    });
    authenticated.emitMessage(JSON.stringify({
      type: "hello",
      requestId: "hello-1",
      token: "token",
      client: { kind: "obsidian-plugin", version: "0.2.0", deviceName: "Laptop" }
    }));
    await Promise.resolve();

    expect(authenticated.sent).toEqual([expect.stringContaining('"type":"hello_ok"')]);
    expect(timers.clearedTimeouts).toHaveLength(1);
    authenticated.emitClose();
  });
});

class FakeSyncTimerHost implements SyncTimerHost {
  readonly clearedTimeouts: unknown[] = [];
  private readonly timeouts = new Map<number, { callback: () => void; delayMs: number }>();
  private nextHandle = 1;

  setInterval(): unknown {
    return "interval";
  }

  clearInterval(): void {}

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++;
    this.timeouts.set(handle, { callback, delayMs });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.clearedTimeouts.push(handle);
    this.timeouts.delete(handle as number);
  }

  runTimeout(delayMs: number): void {
    const entry = [...this.timeouts.entries()].find(([, timeout]) => timeout.delayMs === delayMs);
    if (!entry) throw new Error(`No timeout scheduled for ${delayMs}ms`);
    this.timeouts.delete(entry[0]);
    entry[1].callback();
  }
}

class FakeSyncSocket {
  readonly OPEN = 1;
  readonly readyState = 1;
  readonly sent: string[] = [];
  readonly close = vi.fn((code?: number, reason?: string) => {
    void code;
    void reason;
    this.emitClose();
  });
  private messageListener?: (raw: { toString(): string }) => void;
  private closeListener?: () => void;

  send(payload: string): void {
    this.sent.push(payload);
  }

  ping(): void {}

  on(event: "message" | "close", listener: ((raw: { toString(): string }) => void) | (() => void)): void {
    if (event === "message") this.messageListener = listener as (raw: { toString(): string }) => void;
    else this.closeListener = listener as () => void;
  }

  emitMessage(raw: string): void {
    this.messageListener?.({ toString: () => raw });
  }

  emitClose(): void {
    this.closeListener?.();
  }
}

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
