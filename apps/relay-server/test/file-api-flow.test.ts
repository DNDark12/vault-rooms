import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

async function setupFileFlow() {
  const app = await createApp({
    dbPath: ":memory:",
    publicUrl: "http://127.0.0.1:8787",
    maxFileBytes: 32
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
  const room = (
    await app.inject({
      method: "POST",
      url: `/api/teams/${owner.team.id}/rooms`,
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

  return { app, owner, member, room };
}

describe("file REST API", () => {
  it("stores versions, detects conflicts, tombstones deletes, revives creates, and rejects unsafe writes", async () => {
    const { app, owner, member, room } = await setupFileFlow();

    const created = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "Board.md", baseVersion: 0, content: "# Board\n" }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ ok: true, relativePath: "Board.md", version: 1 });

    const existing = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "Board.md", baseVersion: 0, content: "# Board again\n" }
    });
    expect(existing.statusCode).toBe(409);
    expect(existing.json().error).toMatchObject({ code: "FILE_EXISTS", details: { serverVersion: 1 } });

    const readByB = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files/content?path=Board.md`,
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(readByB.statusCode).toBe(200);
    expect(readByB.json()).toMatchObject({ relativePath: "Board.md", version: 1, content: "# Board\n" });

    const updatedByB = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${member.deviceToken}` },
      payload: { relativePath: "Board.md", baseVersion: 1, content: "# Board\n- Card\n" }
    });
    expect(updatedByB.statusCode).toBe(200);
    expect(updatedByB.json()).toMatchObject({ version: 2 });

    const stale = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${member.deviceToken}` },
      payload: { relativePath: "Board.md", baseVersion: 1, content: "# Stale\n" }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: "VERSION_CONFLICT", details: { serverVersion: 2, serverContent: "# Board\n- Card\n" } });

    const deleted = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/files/delete`,
      headers: { authorization: `Bearer ${member.deviceToken}` },
      payload: { relativePath: "Board.md", baseVersion: 2 }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ ok: true, version: 3 });

    const list = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files`,
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().files).toEqual([expect.objectContaining({ relativePath: "Board.md", version: 3, deleted: true })]);

    const tombstoneRead = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files/content?path=Board.md`,
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(tombstoneRead.statusCode).toBe(404);
    expect(tombstoneRead.json().error.code).toBe("FILE_DELETED");

    const revived = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "Board.md", baseVersion: 0, content: "# Revived\n" }
    });
    expect(revived.statusCode).toBe(200);
    expect(revived.json()).toMatchObject({ version: 4 });

    const unsafe = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "../secret.md", baseVersion: 0, content: "no" }
    });
    expect(unsafe.statusCode).toBe(422);
    expect(unsafe.json().error.code).toBe("INVALID_PATH");

    const oversized = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "Big.md", baseVersion: 0, content: "x".repeat(33) }
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error.code).toBe("FILE_TOO_LARGE");
  });
});
