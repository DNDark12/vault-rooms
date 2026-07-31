import type {
  AclRuleSummary,
  FriendSummary,
  RoomSummary,
  TeamMemberSummary,
  TeamSummary
} from "../apiClient.js";
import {
  EDITOR_PERMISSION_SET,
  READER_PERMISSION_SET,
  samePermissionSet
} from "../accessPresentation.js";

export type PersonAccessPresentation = {
  id: string;
  name: string;
  subtitle: string;
  hasAccess: boolean;
  isCurrentUser: boolean;
  canManage: boolean;
};

export type TeamAccessPresentation = {
  id: string;
  name: string;
  subtitle: string;
  badge?: "You're admin" | "Member";
  canManage: boolean;
};

export type PeopleDescriptor = {
  withAccess: PersonAccessPresentation[];
  withoutAccess: PersonAccessPresentation[];
  teams: TeamAccessPresentation[];
  readOnlyNote?: string;
};

type PeopleModelInput = {
  currentUser: { id: string; displayName: string };
  serverOwner?: { id: string; displayName: string };
  isServerOwner: boolean;
  rooms: RoomSummary[];
  friends: FriendSummary[];
  teams: TeamSummary[];
  teamMembersByTeam: Record<string, TeamMemberSummary[]>;
  myTeamRoles: Record<string, "admin" | "member">;
  roomAclByRoom: ReadonlyMap<string, readonly AclRuleSummary[]>;
  canManageRoom: (room: RoomSummary) => boolean;
  canManageTeam: (team: TeamSummary) => boolean;
};

type AccessHit = {
  level: "reader" | "editor" | "custom";
  roomName: string;
  teamName?: string;
};

export function peopleModel(input: PeopleModelInput): PeopleDescriptor {
  const canManageAnything =
    input.isServerOwner ||
    input.rooms.some(input.canManageRoom) ||
    input.teams.some(input.canManageTeam);
  const people = new Map<string, PersonAccessPresentation>();

  if (!input.isServerOwner) {
    if (input.serverOwner && input.serverOwner.id !== input.currentUser.id) {
      people.set(input.serverOwner.id, {
        id: input.serverOwner.id,
        name: input.serverOwner.displayName,
        subtitle: "Server owner · manages access",
        hasAccess: true,
        isCurrentUser: false,
        canManage: false
      });
    }
    const selfHits = currentUserHits(input.rooms);
    people.set(input.currentUser.id, {
      id: input.currentUser.id,
      name: input.currentUser.displayName,
      subtitle: `${summarizeHits(selfHits)} · you`,
      hasAccess: selfHits.length > 0,
      isCurrentUser: true,
      canManage: false
    });
  }

  for (const friend of input.friends) {
    if (friend.id === input.currentUser.id || people.has(friend.id) || friend.revokedAt) continue;
    const hits = managedUserHits(friend, input.rooms, input.teams, input.roomAclByRoom);
    people.set(friend.id, {
      id: friend.id,
      name: friend.displayName,
      subtitle: hits.length > 0 ? summarizeHits(hits) : "Not in any room",
      hasAccess: hits.length > 0,
      isCurrentUser: false,
      canManage: input.isServerOwner
    });
  }

  const entries = [...people.values()];
  return {
    withAccess: entries.filter((person) => person.hasAccess),
    withoutAccess: entries.filter((person) => !person.hasAccess),
    teams: input.teams.map((team) => teamPresentation(team, input)),
    readOnlyNote: canManageAnything
      ? undefined
      : `Only ${input.serverOwner?.displayName ?? "the server owner"} or an authorized manager can change who has access here.`
  };
}

function currentUserHits(rooms: RoomSummary[]): AccessHit[] {
  return rooms.map((room) => {
    const summary = room.accessSummary;
    const team = summary?.sources.find(
      (source): source is Extract<NonNullable<RoomSummary["accessSummary"]>["sources"][number], { type: "team" }> =>
        source.type === "team"
    );
    return {
      level: summary?.level ?? (room.permissions.includes("sync:push") ? "editor" : "reader"),
      roomName: room.name,
      teamName: team?.teamName
    };
  });
}

function managedUserHits(
  friend: FriendSummary,
  rooms: RoomSummary[],
  teams: TeamSummary[],
  roomAclByRoom: ReadonlyMap<string, readonly AclRuleSummary[]>
): AccessHit[] {
  const teamIds = new Set(friend.teams.map((team) => team.id));
  const teamNames = new Map(teams.map((team) => [team.id, team.name]));
  const hits: AccessHit[] = [];
  for (const room of rooms) {
    if (room.ownerUserId === friend.id) {
      hits.push({ level: "editor", roomName: room.name });
      continue;
    }
    const rules = roomAclByRoom.get(room.id) ?? [];
    const direct = rules.find(
      (rule) => rule.effect === "allow" && rule.subjectType === "user" && rule.subjectId === friend.id
    );
    if (direct) {
      hits.push({ level: accessLevel(direct.permissions), roomName: room.name });
      continue;
    }
    const teamRule = rules.find(
      (rule) => rule.effect === "allow" && rule.subjectType === "team" && teamIds.has(rule.subjectId)
    );
    if (teamRule) {
      hits.push({
        level: accessLevel(teamRule.permissions),
        roomName: room.name,
        teamName: teamNames.get(teamRule.subjectId)
      });
    }
  }
  return hits;
}

function teamPresentation(team: TeamSummary, input: PeopleModelInput): TeamAccessPresentation {
  const roomLevels = input.rooms.flatMap((room): Array<"reader" | "editor" | "custom"> => {
    const managedRule = (input.roomAclByRoom.get(room.id) ?? []).find(
      (rule) => rule.effect === "allow" && rule.subjectType === "team" && rule.subjectId === team.id
    );
    if (managedRule) return [accessLevel(managedRule.permissions)];
    const currentSource = room.accessSummary?.sources.find(
      (source) => source.type === "team" && source.teamId === team.id
    );
    return currentSource ? [room.accessSummary?.level ?? "reader"] : [];
  });
  const members = input.teamMembersByTeam[team.id]?.filter((member) => !member.revokedAt).length;
  const memberCopy = members === undefined ? "People count unavailable" : `${members} ${members === 1 ? "person" : "people"}`;
  const strongest = roomLevels.includes("editor")
    ? "edit"
    : roomLevels.includes("reader")
      ? "view"
      : roomLevels.includes("custom")
        ? "custom access to"
        : "access to";
  const roomCopy = `${roomLevels.length} ${roomLevels.length === 1 ? "room" : "rooms"}`;
  const role = input.myTeamRoles[team.id];
  return {
    id: team.id,
    name: team.name,
    subtitle: `${memberCopy} · can ${strongest} ${roomCopy}`,
    badge: role === "admin" ? "You're admin" : role === "member" ? "Member" : undefined,
    canManage: input.canManageTeam(team)
  };
}

function accessLevel(permissions: readonly string[]): "reader" | "editor" | "custom" {
  if (samePermissionSet(permissions, EDITOR_PERMISSION_SET)) return "editor";
  if (samePermissionSet(permissions, READER_PERMISSION_SET)) return "reader";
  return "custom";
}

function summarizeHits(hits: AccessHit[]): string {
  if (hits.length === 0) return "No room access";
  const strongest = hits.some((hit) => hit.level === "editor")
    ? "Can edit"
    : hits.some((hit) => hit.level === "reader")
      ? "Can view"
      : "Custom access";
  const teamNames = [...new Set(hits.map((hit) => hit.teamName).filter((name): name is string => Boolean(name)))];
  if (teamNames.length === 1 && hits.every((hit) => hit.teamName === teamNames[0])) {
    return `${strongest} · through ${teamNames[0]}`;
  }
  const roomNames = [...new Set(hits.map((hit) => hit.roomName))];
  return roomNames.length <= 2
    ? `${strongest} · ${roomNames.join(", ")}`
    : `${strongest} · ${roomNames.length} rooms`;
}
