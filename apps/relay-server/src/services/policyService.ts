import { AppError, type Permission } from "@vault-rooms/protocol";
import { evaluatePolicy } from "@vault-rooms/policy";
import type { DevicePrincipal, RelayRepository } from "../db/repositories/relayRepository.js";
import type { RoomRow } from "../db/schema.js";

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
    teamId: input.room.team_id,
    subject: { type: "user", id: input.principal.userId, role: input.principal.role, userId: input.principal.userId },
    resource,
    permission: input.permission,
    aclRules: input.repo.listAclRulesForTeam(input.room.team_id),
    membershipRevokedAt: input.principal.memberRevokedAt,
    deviceRevokedAt: input.principal.deviceRevokedAt
  });
  if (!decision.allowed) {
    input.repo.audit({
      teamId: input.room.team_id,
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
