import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("friends, teams, and room visibility", () => {
  it("adds existing friends to teams, grants rooms by team, and keeps rooms independent from team deletion", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });

    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      remoteAddress: "127.0.0.1",
      payload: { displayName: "A", deviceName: "A laptop", teamName: "Team 1" }
    });
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
});
