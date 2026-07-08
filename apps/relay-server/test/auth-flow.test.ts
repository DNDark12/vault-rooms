import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { injectBootstrap } from "./bootstrapHelper.js";

describe("server bootstrap and invite flow", () => {
  it("bootstraps locally once, invites B, joins B, and lists members", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      publicUrl: "http://192.168.1.10:8788",
      allowRemoteBootstrap: false
    });

    const remoteBootstrap = await injectBootstrap(
      app,
      { displayName: "A", deviceName: "A laptop", teamName: "Demo" },
      { remoteAddress: "192.168.1.50" }
    );
    expect(remoteBootstrap.statusCode).toBe(403);

    const bootstrap = await injectBootstrap(app, { displayName: "A", deviceName: "A laptop", teamName: "Demo" });
    expect(bootstrap.statusCode).toBe(200);
    const owner = bootstrap.json();
    expect(owner.isServerOwner).toBe(true);
    expect(owner.team.slug).toBe("demo");
    expect(owner.deviceToken).toMatch(/^tr_dev_/);

    // Bootstrap is first-owner-wins: once server_meta.owner_user_id is set, a second bootstrap
    // call is rejected instead of creating a second server owner (even with a correct PIN).
    const secondBootstrap = await injectBootstrap(app, { displayName: "A2", deviceName: "A2 laptop", teamName: "Demo" });
    expect(secondBootstrap.statusCode).toBe(403);

    const duplicateTeam = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Demo" }
    });
    expect(duplicateTeam.statusCode).toBe(200);
    expect(duplicateTeam.json().team.slug).toBe("demo-2");

    const unauthenticatedMe = await app.inject({ method: "GET", url: "/api/me" });
    expect(unauthenticatedMe.statusCode).toBe(401);

    const invite = await app.inject({
      method: "POST",
      url: `/api/teams/${owner.team.id}/invites`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { role: "member", expiresInMinutes: 60, maxUses: 1 }
    });
    expect(invite.statusCode).toBe(200);
    const invitePayload = invite.json();
    expect(invitePayload.inviteToken).toMatch(/^tr_inv_/);
    expect(invitePayload.serverUrl).toBe("http://192.168.1.10:8788");
    expect(invitePayload.joinUrl).toContain(encodeURIComponent("http://192.168.1.10:8788"));

    const joined = await app.inject({
      method: "POST",
      url: "/api/join",
      payload: { inviteToken: invitePayload.inviteToken, displayName: "B", deviceName: "B laptop" }
    });
    expect(joined.statusCode).toBe(200);
    const b = joined.json();
    expect(b.team.id).toBe(owner.team.id);
    expect(b.isServerOwner).toBe(false);
    expect(b.user.displayName).toBe("B");
    expect(b.deviceToken).toMatch(/^tr_dev_/);

    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${b.deviceToken}` }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ id: b.user.id, displayName: "B" });
    expect(me.json().teams).toEqual([expect.objectContaining({ id: owner.team.id, role: "member" })]);

    const members = await app.inject({
      method: "GET",
      url: `/api/teams/${owner.team.id}/members`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(members.statusCode).toBe(200);
    expect(members.json().members).toEqual([
      expect.objectContaining({ displayName: "A", role: "admin", revokedAt: null }),
      expect.objectContaining({ displayName: "B", role: "member", revokedAt: null })
    ]);
  });
});
