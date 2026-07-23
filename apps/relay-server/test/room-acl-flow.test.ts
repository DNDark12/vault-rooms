import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
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
