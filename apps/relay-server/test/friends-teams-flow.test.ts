import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { injectBootstrap } from "./bootstrapHelper.js";

describe("friends, teams, and room visibility", () => {
  it("adds existing friends to teams, grants rooms by team, and keeps rooms independent from team deletion", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });

    const bootstrap = await injectBootstrap(app, { displayName: "A", deviceName: "A laptop", teamName: "Team 1" });
    expect(bootstrap.statusCode).toBe(200);
    const owner = bootstrap.json();

    const team1Invite = (
      await app.inject({
        method: "POST",
        url: `/api/teams/${owner.team.id}/invites`,
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { role: "member", expiresInMinutes: 60, maxUses: 1 }
      })
    ).json();
    const joined = await app.inject({
      method: "POST",
      url: "/api/join",
      payload: { inviteToken: team1Invite.inviteToken, displayName: "B", deviceName: "B laptop" }
    });
    expect(joined.statusCode).toBe(200);
    const member = joined.json();

    const team2Response = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Team 2" }
    });
    expect(team2Response.statusCode).toBe(200);
    const team2 = team2Response.json().team;

    const friends = await app.inject({
      method: "GET",
      url: "/api/friends",
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(friends.statusCode).toBe(200);
    expect(friends.json().friends.map((friend: { id: string }) => friend.id).sort()).toEqual([member.user.id, owner.user.id].sort());

    const addToTeam2 = await app.inject({
      method: "POST",
      url: `/api/teams/${team2.id}/members`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { userId: member.user.id, role: "member" }
    });
    expect(addToTeam2.statusCode).toBe(200);

    const createdRoom = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Shared", type: "folder", sourcePath: "Shared", mountName: "Shared", capabilities: [] }
    });
    expect(createdRoom.statusCode).toBe(200);
    const room = createdRoom.json().room;

    const teamGrant = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "team", subjectId: team2.id, effect: "allow", preset: "reader", pathPattern: "**/*" }
    });
    expect(teamGrant.statusCode).toBe(200);

    const bRoomsAfterGrant = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(bRoomsAfterGrant.statusCode).toBe(200);
    expect(bRoomsAfterGrant.json().rooms).toEqual([expect.objectContaining({ id: room.id })]);

    const revokeFromTeam2 = await app.inject({
      method: "POST",
      url: `/api/teams/${team2.id}/members/${member.user.id}/revoke`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { reason: "Move teams" }
    });
    expect(revokeFromTeam2.statusCode).toBe(200);

    const bRoomsAfterRevoke = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(bRoomsAfterRevoke.statusCode).toBe(200);
    expect(bRoomsAfterRevoke.json().rooms).toEqual([]);

    await app.inject({
      method: "POST",
      url: `/api/teams/${team2.id}/members`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { userId: member.user.id, role: "member" }
    });
    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", permissions: ["room:read"], pathPattern: "**/*" }
    });
    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "team", subjectId: team2.id, effect: "deny", permissions: ["room:read"], pathPattern: "**/*" }
    });

    const bRoomsAfterDeny = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(bRoomsAfterDeny.statusCode).toBe(200);
    expect(bRoomsAfterDeny.json().rooms).toEqual([]);

    const teamOnlyRoom = (
      await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { name: "Team Only", type: "folder", sourcePath: "Team Only", mountName: "Team Only", capabilities: [] }
      })
    ).json().room;
    await app.inject({
      method: "POST",
      url: `/api/rooms/${teamOnlyRoom.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "team", subjectId: team2.id, effect: "allow", preset: "reader", pathPattern: "**/*" }
    });

    const deleteTeam2 = await app.inject({
      method: "DELETE",
      url: `/api/teams/${team2.id}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(deleteTeam2.statusCode).toBe(200);

    const bRoomsAfterTeamDelete = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(bRoomsAfterTeamDelete.statusCode).toBe(200);
    expect(bRoomsAfterTeamDelete.json().rooms).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: teamOnlyRoom.id })]));

    const ownerRoomsAfterTeamDelete = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(ownerRoomsAfterTeamDelete.statusCode).toBe(200);
    expect(ownerRoomsAfterTeamDelete.json().rooms).toEqual(expect.arrayContaining([expect.objectContaining({ id: teamOnlyRoom.id })]));

    const friendsBeforeAccept = await app.inject({
      method: "GET",
      url: "/api/friends",
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    const team3 = (
      await app.inject({
        method: "POST",
        url: "/api/teams",
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { name: "Team 3" }
      })
    ).json().team;
    const team3Invite = (
      await app.inject({
        method: "POST",
        url: `/api/teams/${team3.id}/invites`,
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { role: "member", expiresInMinutes: 60, maxUses: 1 }
      })
    ).json();

    const accepted = await app.inject({
      method: "POST",
      url: "/api/invites/accept",
      headers: { authorization: `Bearer ${member.deviceToken}` },
      payload: { inviteToken: team3Invite.inviteToken }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().team.id).toBe(team3.id);

    const friendsAfterAccept = await app.inject({
      method: "GET",
      url: "/api/friends",
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(friendsAfterAccept.json().friends).toHaveLength(friendsBeforeAccept.json().friends.length);

    const bMe = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(bMe.json().user.id).toBe(member.user.id);
    expect(bMe.json().teams).toEqual(expect.arrayContaining([expect.objectContaining({ id: team3.id, role: "member" })]));
  });

  it("scopes GET /api/teams to the caller's own memberships, except the server owner who sees every team", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });

    const o1Bootstrap = await injectBootstrap(app, { displayName: "O1", deviceName: "O1 laptop", teamName: "T1" });
    expect(o1Bootstrap.statusCode).toBe(200);
    const o1 = o1Bootstrap.json();
    const t1 = o1.team;

    const t1Invite = (
      await app.inject({
        method: "POST",
        url: `/api/teams/${t1.id}/invites`,
        headers: { authorization: `Bearer ${o1.deviceToken}` },
        payload: { role: "member", expiresInMinutes: 60, maxUses: 1 }
      })
    ).json();
    const m1Joined = await app.inject({
      method: "POST",
      url: "/api/join",
      payload: { inviteToken: t1Invite.inviteToken, displayName: "M1", deviceName: "M1 laptop" }
    });
    expect(m1Joined.statusCode).toBe(200);
    const m1 = m1Joined.json();

    // T2 is created by O1 (the server owner) so it exists on the same server, but M1 and O2/M2
    // never join it - it must stay invisible to anyone outside its membership.
    const t2Response = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { authorization: `Bearer ${o1.deviceToken}` },
      payload: { name: "T2" }
    });
    expect(t2Response.statusCode).toBe(200);
    const t2 = t2Response.json().team;

    const t2Invite = (
      await app.inject({
        method: "POST",
        url: `/api/teams/${t2.id}/invites`,
        headers: { authorization: `Bearer ${o1.deviceToken}` },
        payload: { role: "admin", expiresInMinutes: 60, maxUses: 2 }
      })
    ).json();
    const o2Joined = await app.inject({
      method: "POST",
      url: "/api/join",
      payload: { inviteToken: t2Invite.inviteToken, displayName: "O2", deviceName: "O2 laptop" }
    });
    expect(o2Joined.statusCode).toBe(200);
    const o2 = o2Joined.json();

    const m1TeamsResponse = await app.inject({
      method: "GET",
      url: "/api/teams",
      headers: { authorization: `Bearer ${m1.deviceToken}` }
    });
    expect(m1TeamsResponse.statusCode).toBe(200);
    const m1Teams = m1TeamsResponse.json().teams;
    // The full team object (including ownerUserId) is only returned for M1's own team - T2 is
    // absent entirely, not merely redacted.
    expect(m1Teams).toEqual([{ id: t1.id, slug: t1.slug, name: t1.name, ownerUserId: o1.user.id }]);

    const o2TeamsResponse = await app.inject({
      method: "GET",
      url: "/api/teams",
      headers: { authorization: `Bearer ${o2.deviceToken}` }
    });
    expect(o2TeamsResponse.statusCode).toBe(200);
    const o2Teams = o2TeamsResponse.json().teams;
    expect(o2Teams.map((team: { id: string }) => team.id)).toEqual([t2.id]);
    expect(o2Teams.find((team: { id: string }) => team.id === t1.id)).toBeUndefined();

    const ownerTeamsResponse = await app.inject({
      method: "GET",
      url: "/api/teams",
      headers: { authorization: `Bearer ${o1.deviceToken}` }
    });
    expect(ownerTeamsResponse.statusCode).toBe(200);
    expect(ownerTeamsResponse.json().teams.map((team: { id: string }) => team.id).sort()).toEqual([t1.id, t2.id].sort());

    // GET /api/team-directory is the ACL-picker replacement: unlike GET /api/teams, a non-member
    // (M1, who never joined T2) can still see T2 exists - but only its minimal id/name/slug, never
    // ownerUserId or membership, so the S5 leak fix stays intact.
    const m1DirectoryResponse = await app.inject({
      method: "GET",
      url: "/api/team-directory",
      headers: { authorization: `Bearer ${m1.deviceToken}` }
    });
    expect(m1DirectoryResponse.statusCode).toBe(200);
    const m1Directory = m1DirectoryResponse.json().teams;
    expect(m1Directory.map((team: { id: string }) => team.id).sort()).toEqual([t1.id, t2.id].sort());
    const t2InDirectory = m1Directory.find((team: { id: string }) => team.id === t2.id);
    expect(t2InDirectory).toEqual({ id: t2.id, name: t2.name, slug: t2.slug });
    expect(t2InDirectory.ownerUserId).toBeUndefined();
    for (const team of m1Directory) {
      expect(Object.keys(team).sort()).toEqual(["id", "name", "slug"]);
    }
  });

  it("does not leak a friend's membership in teams the caller does not share with them via GET /api/friends", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });

    const owner = (await injectBootstrap(app, { displayName: "Owner", deviceName: "Owner laptop", teamName: "Shared" })).json();
    const sharedTeam = owner.team;

    const sharedInviteForA = (
      await app.inject({
        method: "POST",
        url: `/api/teams/${sharedTeam.id}/invites`,
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { role: "member", expiresInMinutes: 60, maxUses: 1 }
      })
    ).json();
    const peerA = (
      await app.inject({
        method: "POST",
        url: "/api/join",
        payload: { inviteToken: sharedInviteForA.inviteToken, displayName: "PeerA", deviceName: "PeerA laptop" }
      })
    ).json();

    const sharedInviteForB = (
      await app.inject({
        method: "POST",
        url: `/api/teams/${sharedTeam.id}/invites`,
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { role: "member", expiresInMinutes: 60, maxUses: 1 }
      })
    ).json();
    const peerB = (
      await app.inject({
        method: "POST",
        url: "/api/join",
        payload: { inviteToken: sharedInviteForB.inviteToken, displayName: "PeerB", deviceName: "PeerB laptop" }
      })
    ).json();

    // A second, private team that only PeerB (and the server owner, who created it) belongs to -
    // PeerA is not a member of it and must not see it in PeerB's team list.
    const privateTeam = (
      await app.inject({
        method: "POST",
        url: "/api/teams",
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { name: "Private" }
      })
    ).json().team;
    await app.inject({
      method: "POST",
      url: `/api/teams/${privateTeam.id}/members`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { userId: peerB.user.id, role: "member" }
    });

    // PeerA (a non-owner caller) looks up the friend roster - PeerB is visible (roster stays
    // intact), but PeerB's team list must only show teams PeerA actually shares with them.
    const friendsAsPeerA = await app.inject({
      method: "GET",
      url: "/api/friends",
      headers: { authorization: `Bearer ${peerA.deviceToken}` }
    });
    expect(friendsAsPeerA.statusCode).toBe(200);
    const peerBAsSeenByPeerA = friendsAsPeerA.json().friends.find((friend: { id: string }) => friend.id === peerB.user.id);
    expect(peerBAsSeenByPeerA).toBeDefined();
    expect(peerBAsSeenByPeerA.teams.map((team: { id: string }) => team.id)).not.toContain(privateTeam.id);
    expect(peerBAsSeenByPeerA.teams.map((team: { id: string }) => team.id)).toContain(sharedTeam.id);

    // The owner also shares privateTeam with PeerB, and (being the server owner) sees the
    // unfiltered membership graph - so privateTeam legitimately appears from their view.
    const friendsAsOwner = await app.inject({
      method: "GET",
      url: "/api/friends",
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    const peerBAsSeenByOwner = friendsAsOwner.json().friends.find((friend: { id: string }) => friend.id === peerB.user.id);
    expect(peerBAsSeenByOwner.teams.map((team: { id: string }) => team.id)).toContain(privateTeam.id);
  });
});
