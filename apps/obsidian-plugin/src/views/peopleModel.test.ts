import { describe, expect, it } from "vitest";
import type { AclRuleSummary, FriendSummary, RoomSummary, TeamSummary } from "../apiClient.js";
import { EDITOR_PERMISSION_SET, READER_PERMISSION_SET } from "../accessPresentation.js";
import { peopleModel } from "./peopleModel.js";

const room = (overrides: Partial<RoomSummary> = {}): RoomSummary => ({
  id: "daily",
  name: "Daily Report",
  type: "folder",
  sourcePath: "Daily Report",
  mountName: "Daily Report",
  ownerUserId: "owner",
  conflictPolicy: "keep_both",
  permissions: [...EDITOR_PERMISSION_SET],
  capabilities: [],
  crdtEnabled: true,
  ...overrides
});
const friend = (overrides: Partial<FriendSummary> = {}): FriendSummary => ({
  id: "hung",
  displayName: "hung",
  revokedAt: null,
  teams: [],
  ...overrides
});
const team: TeamSummary = { id: "ekyo", slug: "ekyo", name: "ekyo", ownerUserId: "owner" };
const acl = (overrides: Partial<AclRuleSummary> = {}): AclRuleSummary => ({
  id: "acl",
  roomId: "daily",
  subjectType: "user",
  subjectId: "hung",
  effect: "allow",
  permissions: [...EDITOR_PERMISSION_SET],
  pathPattern: "**/*",
  createdAt: "2026-07-30T00:00:00.000Z",
  ...overrides
});

describe("peopleModel", () => {
  it("groups direct, team-derived, and no-room access without destructive row state", () => {
    const direct = friend();
    const throughTeam = friend({ id: "huynd2", displayName: "huynd2", teams: [{ id: "ekyo", role: "member" }] });
    const none = friend({ id: "mai", displayName: "Mai" });
    const descriptor = peopleModel({
      currentUser: { id: "owner", displayName: "DNDark" },
      serverOwner: { id: "owner", displayName: "DNDark" },
      isServerOwner: true,
      rooms: [room()],
      friends: [direct, throughTeam, none],
      teams: [team],
      teamMembersByTeam: { ekyo: [
        { userId: "owner", displayName: "DNDark", role: "admin", revokedAt: null },
        { userId: "huynd2", displayName: "huynd2", role: "member", revokedAt: null }
      ] },
      myTeamRoles: { ekyo: "admin" },
      roomAclByRoom: new Map([["daily", [
        acl(),
        acl({ id: "team-acl", subjectType: "team", subjectId: "ekyo" })
      ]]]),
      canManageRoom: () => true,
      canManageTeam: () => true
    });

    expect(descriptor.withAccess.map((person) => [person.name, person.subtitle])).toEqual([
      ["hung", "Can edit · Daily Report"],
      ["huynd2", "Can edit · through ekyo"]
    ]);
    expect(descriptor.withoutAccess.map((person) => person.name)).toEqual(["Mai"]);
    expect(descriptor.teams[0]).toMatchObject({
      subtitle: "2 people · can edit 1 room",
      badge: "You're admin",
      canManage: true
    });
  });

  it("makes an ordinary member read-only and uses server-supplied access source", () => {
    const descriptor = peopleModel({
      currentUser: { id: "hung", displayName: "hung" },
      serverOwner: { id: "owner", displayName: "DNDark" },
      isServerOwner: false,
      rooms: [room({
        ownerUserId: "owner",
        permissions: [...READER_PERMISSION_SET],
        accessSummary: {
          level: "reader",
          sources: [{ type: "team", teamId: "ekyo", teamName: "ekyo" }]
        }
      })],
      friends: [friend({ id: "owner", displayName: "DNDark" }), friend()],
      teams: [team],
      teamMembersByTeam: { ekyo: [
        { userId: "hung", displayName: "hung", role: "member", revokedAt: null },
        { userId: "mai", displayName: "Mai", role: "member", revokedAt: null }
      ] },
      myTeamRoles: { ekyo: "member" },
      roomAclByRoom: new Map(),
      canManageRoom: () => false,
      canManageTeam: () => false
    });

    expect(descriptor.withAccess.map((person) => person.subtitle)).toEqual([
      "Server owner · manages access",
      "Can view · through ekyo · you"
    ]);
    expect(descriptor.teams[0]).toMatchObject({
      subtitle: "2 people · can view 1 room",
      badge: "Member",
      canManage: false
    });
    expect(descriptor.readOnlyNote).toBe("Only DNDark or an authorized manager can change who has access here.");
  });
});
