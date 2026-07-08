import { AppError, type AclRule, type Permission } from "@vault-rooms/protocol";
import { evaluatePolicy } from "@vault-rooms/policy";
import type { DevicePrincipal, RelayRepository } from "../db/repositories/relayRepository.js";
import type { RoomRow } from "../db/schema.js";
import type { ConnectionRegistry } from "../sync/connectionRegistry.js";

export function hasRoomPermission(input: {
  repo: RelayRepository;
  principal: DevicePrincipal;
  room: RoomRow;
  permission: Permission;
  relativePath?: string;
  // Optional pre-loaded ACL rules for the room. Callers evaluating this permission for many
  // recipients in one pass (e.g. ConnectionRegistry.broadcastToRoom) should load the room's ACL
  // rules once via repo.listAclRulesForRoom and pass them here, instead of re-querying per
  // recipient.
  aclRules?: AclRule[];
}): boolean {
  const resource = input.permission.startsWith("room:")
    ? { type: "room" as const, roomId: input.room.id, roomOwnerUserId: input.room.owner_user_id }
    : { type: "file" as const, roomId: input.room.id, roomOwnerUserId: input.room.owner_user_id, relativePath: input.relativePath ?? "" };
  return evaluatePolicy({
    subject: {
      type: "user",
      id: input.principal.userId,
      userId: input.principal.userId,
      teamIds: input.repo.listUserTeams(input.principal.userId).map((team) => team.teamId)
    },
    resource,
    permission: input.permission,
    aclRules: input.aclRules ?? input.repo.listAclRulesForRoom(input.room.id),
    membershipRevokedAt: input.principal.userRevokedAt,
    deviceRevokedAt: input.principal.deviceRevokedAt
  }).allowed;
}

export function assertRoomPermission(input: {
  repo: RelayRepository;
  principal: DevicePrincipal;
  room: RoomRow;
  permission: Permission;
  relativePath?: string;
}): void {
  const resource = input.permission.startsWith("room:")
    ? { type: "room" as const, roomId: input.room.id, roomOwnerUserId: input.room.owner_user_id }
    : { type: "file" as const, roomId: input.room.id, roomOwnerUserId: input.room.owner_user_id, relativePath: input.relativePath ?? "" };
  const decision = evaluatePolicy({
    subject: {
      type: "user",
      id: input.principal.userId,
      userId: input.principal.userId,
      teamIds: input.repo.listUserTeams(input.principal.userId).map((team) => team.teamId)
    },
    resource,
    permission: input.permission,
    aclRules: input.repo.listAclRulesForRoom(input.room.id),
    membershipRevokedAt: input.principal.userRevokedAt,
    deviceRevokedAt: input.principal.deviceRevokedAt
  });
  if (!decision.allowed) {
    input.repo.audit({
      teamId: null,
      actorType: "user",
      actorId: input.principal.userId,
      action: "acl.denied",
      resourceType: "room",
      resourceId: input.room.id,
      metadata: { permission: input.permission, relativePath: input.relativePath, reason: decision.reason }
    });
    throw new AppError("PERMISSION_DENIED", `You do not have ${input.permission} permission for this path.`, 403);
  }
}

export function revalidateRoomAccess(repo: RelayRepository, registry: ConnectionRegistry | undefined): void {
  registry?.revalidateAccess((roomId, principal) => {
    const room = repo.getRoom(roomId);
    if (!room) return true; // handled separately by room_deleted broadcast
    return hasRoomPermission({ repo, principal, room, permission: "sync:subscribe" });
  });
}
