import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createAppWithDb } from "../src/appCore.js";
import { openRelayDb } from "../src/db/db.js";
import { createRelayCore } from "../src/relayCore.js";
import { certPemToDerBase64Url, generateServerIdentity } from "../src/security/identity.js";
import { injectBootstrap } from "./bootstrapHelper.js";

describe("room, team, and friend invites", () => {
  it("includes pinned identity material on TLS invite links and keeps plain links compatible", async () => {
    const db = await openRelayDb(":memory:");
    const core = createRelayCore(db);
    core.repo.setSecurityState("pinned_tls");
    const serverId = core.repo.getOrCreateServerId();
    const identity = await generateServerIdentity(serverId);
    const persisted = { serverId, identity, rotations: [] };
    const app = await createAppWithDb(db, {
      core,
      publicUrl: "https://relay.example:8788",
      security: { runtime: { getIdentity: () => persisted, httpsUrl: () => "https://relay.example:8788" } }
    });
    const owner = (await injectBootstrap(app, { displayName: "Owner", deviceName: "Owner laptop", teamName: "Demo" })).json();

    const invite = await app.inject({
      method: "POST",
      url: `/api/teams/${owner.team.id}/invites`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: {}
    });
    const joinUrl = new URL(invite.json().joinUrl);
    expect(joinUrl.searchParams.get("serverId")).toBe(serverId);
    expect(joinUrl.searchParams.get("security")).toBe("pinned-tls");
    expect(joinUrl.searchParams.get("tlsName")).toBe(identity.tlsName);
    expect(joinUrl.searchParams.get("fp")).toBe(identity.identitySpkiSha256);
    expect(joinUrl.searchParams.get("idc")).toBe(certPemToDerBase64Url(identity.identityCertPem));
    await app.close();

    const plainApp = await createApp({ dbPath: ":memory:", publicUrl: "http://relay.example:8787" });
    const plainOwner = (await injectBootstrap(plainApp, { displayName: "Owner", deviceName: "Owner laptop", teamName: "Demo" })).json();
    const plainInvite = await plainApp.inject({
      method: "POST",
      url: `/api/teams/${plainOwner.team.id}/invites`,
      headers: { authorization: `Bearer ${plainOwner.deviceToken}` },
      payload: {}
    });
    expect(new URL(plainInvite.json().joinUrl).searchParams.get("security")).toBeNull();
    await plainApp.close();
  });

  it("creates and accepts room invites with an idempotent preset upgrade", async () => {
    const db = await openRelayDb(":memory:");
    const app = await createAppWithDb(db, { publicUrl: "http://192.168.1.10:8788" });
    const owner = (await injectBootstrap(app, { displayName: "Owner", deviceName: "Owner laptop", teamName: "Demo" })).json();
    const room = (
      await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { name: "Shared", type: "folder", sourcePath: "Shared", mountName: "Shared", capabilities: [] }
      })
    ).json().room;

    const invalidPreset = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/invites`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { preset: "owner" }
    });
    expect(invalidPreset.statusCode).toBe(422);

    const readerInvite = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/invites`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { preset: "reader" }
    });
    expect(readerInvite.statusCode).toBe(200);
    expect(readerInvite.json()).toMatchObject({
      inviteId: expect.stringMatching(/^tr_inv_|^inv_/),
      inviteToken: expect.stringMatching(/^tr_inv_/),
      serverUrl: "http://192.168.1.10:8788",
      joinUrl: expect.stringContaining("obsidian://vault-rooms")
    });

    const joined = await app.inject({
      method: "POST",
      url: "/api/join",
      payload: { inviteToken: readerInvite.json().inviteToken, displayName: "Reader", deviceName: "Reader laptop" }
    });
    expect(joined.statusCode).toBe(200);
    const reader = joined.json();
    expect(reader).toMatchObject({ inviteType: "room", room: { id: room.id }, isServerOwner: false });

    const visibleAsReader = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${reader.deviceToken}` }
    });
    expect(visibleAsReader.json().rooms[0]).toMatchObject({ id: room.id, permissions: expect.arrayContaining(["file:read"]) });
    expect(visibleAsReader.json().rooms[0].permissions).not.toContain("file:write");

    const unauthorizedInvite = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/invites`,
      headers: { authorization: `Bearer ${reader.deviceToken}` },
      payload: { preset: "editor" }
    });
    expect(unauthorizedInvite.statusCode).toBe(403);

    const editorInvite = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/invites`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { preset: "editor" }
    });
    const upgraded = await app.inject({
      method: "POST",
      url: "/api/invites/accept",
      headers: { authorization: `Bearer ${reader.deviceToken}` },
      payload: { inviteToken: editorInvite.json().inviteToken }
    });
    expect(upgraded.statusCode).toBe(200);
    expect(upgraded.json()).toMatchObject({ inviteType: "room", room: { id: room.id } });

    const acl = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    const readerRules = acl.json().aclRules.filter((rule: { subjectId: string; pathPattern: string; effect: string }) =>
      rule.subjectId === reader.user.id && rule.pathPattern === "**/*" && rule.effect === "allow"
    );
    expect(readerRules).toHaveLength(1);
    expect(readerRules[0].permissions).toContain("file:write");

    const grantActors = db.prepare("select actor_id from audit_events where action = 'acl.granted' and resource_id = ?").all(room.id) as Array<{ actor_id: string }>;
    expect(new Set(grantActors.map((event) => event.actor_id))).toEqual(new Set([owner.user.id]));

    const pendingInvite = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/invites`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { preset: "reader" }
    });
    expect(pendingInvite.statusCode).toBe(200);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${room.id}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(deleted.statusCode).toBe(200);
    expect(db.prepare("select count(*) as count from invites where room_id = ?").get(room.id)).toEqual({ count: 0 });

    await app.close();
  });

  it("creates friend invites only for the server owner and grants no team or room", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    const owner = (await injectBootstrap(app, { displayName: "Owner", deviceName: "Owner laptop", teamName: "Demo" })).json();
    const friendInvite = await app.inject({
      method: "POST",
      url: "/api/invites",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: {}
    });
    expect(friendInvite.statusCode).toBe(200);

    const joined = await app.inject({
      method: "POST",
      url: "/api/join",
      payload: { inviteToken: friendInvite.json().inviteToken, displayName: "Friend", deviceName: "Friend laptop" }
    });
    expect(joined.statusCode).toBe(200);
    const friend = joined.json();
    expect(friend.inviteType).toBe("friend");
    expect(friend.team).toBeUndefined();
    expect(friend.room).toBeUndefined();

    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${friend.deviceToken}` } });
    expect(me.json().teams).toEqual([]);
    const rooms = await app.inject({ method: "GET", url: "/api/rooms", headers: { authorization: `Bearer ${friend.deviceToken}` } });
    expect(rooms.json().rooms).toEqual([]);

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/invites",
      headers: { authorization: `Bearer ${friend.deviceToken}` },
      payload: {}
    });
    expect(forbidden.statusCode).toBe(403);

    const noOpInvite = await app.inject({
      method: "POST",
      url: "/api/invites",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: {}
    });
    const noOp = await app.inject({
      method: "POST",
      url: "/api/invites/accept",
      headers: { authorization: `Bearer ${friend.deviceToken}` },
      payload: { inviteToken: noOpInvite.json().inviteToken }
    });
    expect(noOp.statusCode).toBe(200);
    expect(noOp.json()).toEqual({ inviteType: "friend", alreadyConnected: true });

    await app.close();
  });

  it("updates an existing team membership role without duplicating it", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    const owner = (await injectBootstrap(app, { displayName: "Owner", deviceName: "Owner laptop", teamName: "Demo" })).json();
    const friendInvite = await app.inject({
      method: "POST",
      url: "/api/invites",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: {}
    });
    const friend = (
      await app.inject({
        method: "POST",
        url: "/api/join",
        payload: { inviteToken: friendInvite.json().inviteToken, displayName: "Friend", deviceName: "Friend laptop" }
      })
    ).json();

    for (const role of ["member", "admin"] as const) {
      const invite = await app.inject({
        method: "POST",
        url: `/api/teams/${owner.team.id}/invites`,
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { role }
      });
      const accepted = await app.inject({
        method: "POST",
        url: "/api/invites/accept",
        headers: { authorization: `Bearer ${friend.deviceToken}` },
        payload: { inviteToken: invite.json().inviteToken }
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({ inviteType: "team", team: { id: owner.team.id } });
    }

    const members = await app.inject({
      method: "GET",
      url: `/api/teams/${owner.team.id}/members`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    const matching = members.json().members.filter((member: { userId: string }) => member.userId === friend.user.id);
    expect(matching).toEqual([expect.objectContaining({ role: "admin", revokedAt: null })]);

    await app.close();
  });
});
