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
    expect(me.json().serverId).toMatch(/^srv_/);
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

  // Onboarding: the host cannot enumerate its own network interfaces (Obsidian's plugin review treats that as
  // fingerprinting), so the address teammates actually reach it on is the one legitimate signal available for
  // spotting a stale Public URL override - the failure mode that otherwise only surfaces as a teammate saying
  // "I can't connect", long after a DHCP lease changed.
  it("records the host a remote client connected with, and reports it to the owner only", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
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

    // The teammate reaches the server on its real LAN address.
    await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${member.deviceToken}`, host: "192.168.12.21:8787" }
    });

    const ownerView = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${owner.deviceToken}`, host: "127.0.0.1:8787" }
    });
    // The owner's own loopback request must not overwrite the useful observation.
    expect(ownerView.json().observedClientHost).toMatchObject({ host: "192.168.12.21" });

    const memberView = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${member.deviceToken}`, host: "192.168.12.21:8787" }
    });
    // Only the owner can act on it, and only they should see where others connect from.
    expect(memberView.json().observedClientHost).toBeUndefined();

    await app.close();
  });

  // User-facing error messages (docs/superpowers/plans/2026-07-29-user-facing-error-messages.md).
  // This is the very first request a new device makes, so "something was missing" would leave someone
  // staring at a join form with no idea which box is empty - the per-field detail has to survive the
  // rewrite, just phrased as the thing the user fills in rather than the wire field name.
  it("names the missing join inputs without exposing wire field names", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    await injectBootstrap(app, { displayName: "Owner", deviceName: "Owner laptop", teamName: "Demo" });

    const cases: Array<{ payload: Record<string, string>; expected: string }> = [
      { payload: {}, expected: "This join request needs a complete invite link, your display name and a name for this device." },
      {
        payload: { inviteToken: "tr_whatever" },
        expected: "This join request needs your display name and a name for this device."
      },
      {
        payload: { inviteToken: "tr_whatever", displayName: "Alice" },
        expected: "This join request needs a name for this device."
      }
    ];

    for (const { payload, expected } of cases) {
      const response = await app.inject({ method: "POST", url: "/api/join", payload });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
      expect(response.json().error.message).toBe(expected);
      // The three wire field names must not reappear.
      expect(response.json().error.message).not.toMatch(/inviteToken|displayName|deviceName/);
    }

    await app.close();
  });
});
