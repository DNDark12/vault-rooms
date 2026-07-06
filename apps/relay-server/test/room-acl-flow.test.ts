import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

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

  return { app, owner, member };
}

describe("rooms and ACL", () => {
  it("creates rooms, filters visibility, grants presets, and applies deny overrides", async () => {
    const { app, owner, member } = await bootstrapOwnerAndMember();

    const created = await app.inject({
      method: "POST",
      url: `/api/teams/${owner.team.id}/rooms`,
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
    // sourcePath (the owner) or into a separate folder under the team's mount root (everyone
    // else) - see roomMountPathFor() in apps/obsidian-plugin/src/main.ts.
    expect(room.ownerUserId).toBe(owner.user.id);

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/teams/${owner.team.id}/rooms`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Dup", type: "folder", sourcePath: "Other", mountName: "Projects Demo", capabilities: [] }
    });
    expect(duplicate.statusCode).toBe(409);

    const ownerRooms = await app.inject({
      method: "GET",
      url: `/api/teams/${owner.team.id}/rooms`,
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
      url: `/api/teams/${owner.team.id}/rooms`,
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
      url: `/api/teams/${owner.team.id}/rooms`,
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
      url: `/api/teams/${owner.team.id}/rooms`,
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(bAfterDeny.statusCode).toBe(200);
    expect(bAfterDeny.json().rooms).toEqual([]);
  });
});
