import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { injectBootstrap } from "./bootstrapHelper.js";

type App = Awaited<ReturnType<typeof createApp>>;

async function bootstrapOwnerWithTeam(app: App) {
  const response = await injectBootstrap(app, { displayName: "Owner", deviceName: "Owner laptop", teamName: "Core" });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    team: { id: string };
    deviceToken: string;
  };
}

async function joinAsMember(app: App, ownerToken: string, teamId: string, role: "member" | "admin", name: string) {
  const invite = (
    await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/invites`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { role, expiresInMinutes: 60, maxUses: 1 }
    })
  ).json() as { inviteToken: string };
  const joined = await app.inject({
    method: "POST",
    url: "/api/join",
    payload: { inviteToken: invite.inviteToken, displayName: name, deviceName: `${name} laptop` }
  });
  expect(joined.statusCode).toBe(200);
  return joined.json() as { deviceToken: string };
}

describe("GET /api/audit", () => {
  it("lets the server owner read the server-wide log, newest first", async () => {
    const app = await createApp({ dbPath: ":memory:" });
    const owner = await bootstrapOwnerWithTeam(app);
    await joinAsMember(app, owner.deviceToken, owner.team.id, "member", "B");

    const response = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      events: Array<{ action: string; createdAt: string; metadata: unknown; teamId: string | null }>;
      limit: number;
      offset: number;
    };
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    const actions = body.events.map((event) => event.action);
    expect(actions).toContain("invite.created");
    expect(actions).toContain("member.joined");
    // Newest-first ordering.
    const times = body.events.map((event) => Date.parse(event.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // metadata_json comes back parsed, not as a raw string.
    for (const event of body.events) {
      expect(typeof event.metadata).toBe("object");
    }
  });

  it("rejects unauthenticated and non-owner server-wide reads", async () => {
    const app = await createApp({ dbPath: ":memory:" });
    const owner = await bootstrapOwnerWithTeam(app);
    const member = await joinAsMember(app, owner.deviceToken, owner.team.id, "member", "B");

    const unauthenticated = await app.inject({ method: "GET", url: "/api/audit" });
    expect(unauthenticated.statusCode).toBe(401);

    const memberWide = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(memberWide.statusCode).toBe(403);

    // A plain member also cannot read a specific team's log they don't manage.
    const memberTeam = await app.inject({
      method: "GET",
      url: `/api/audit?teamId=${owner.team.id}`,
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(memberTeam.statusCode).toBe(403);
  });

  it("lets a team admin read only their team's rows", async () => {
    const app = await createApp({ dbPath: ":memory:" });
    const owner = await bootstrapOwnerWithTeam(app);
    const admin = await joinAsMember(app, owner.deviceToken, owner.team.id, "admin", "A");

    const response = await app.inject({
      method: "GET",
      url: `/api/audit?teamId=${owner.team.id}`,
      headers: { authorization: `Bearer ${admin.deviceToken}` }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { events: Array<{ teamId: string | null }> };
    expect(body.events.length).toBeGreaterThan(0);
    for (const event of body.events) {
      expect(event.teamId).toBe(owner.team.id);
    }
  });

  it("paginates with limit/offset and validates page params", async () => {
    const app = await createApp({ dbPath: ":memory:" });
    const owner = await bootstrapOwnerWithTeam(app);
    await joinAsMember(app, owner.deviceToken, owner.team.id, "member", "B");
    const headers = { authorization: `Bearer ${owner.deviceToken}` };

    const all = (await app.inject({ method: "GET", url: "/api/audit", headers })).json() as { events: Array<{ id: string }> };
    expect(all.events.length).toBeGreaterThanOrEqual(2);

    const first = (await app.inject({ method: "GET", url: "/api/audit?limit=1", headers })).json() as { events: Array<{ id: string }> };
    const second = (await app.inject({ method: "GET", url: "/api/audit?limit=1&offset=1", headers })).json() as {
      events: Array<{ id: string }>;
    };
    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
    expect(first.events[0]!.id).toBe(all.events[0]!.id);
    expect(second.events[0]!.id).toBe(all.events[1]!.id);

    expect((await app.inject({ method: "GET", url: "/api/audit?limit=0", headers })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/audit?limit=201", headers })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/audit?offset=-1", headers })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/audit?limit=abc", headers })).statusCode).toBe(422);
  });
});
