import type { FastifyInstance } from "fastify";
import { AppError, type CapabilityMode, type Permission, type SubjectType } from "@vault-rooms/protocol";
import { EDITOR_PERMISSIONS, READER_PERMISSIONS, evaluatePolicy, expandPreset } from "@vault-rooms/policy";
import type { DevicePrincipal, RelayRepository } from "../db/repositories/relayRepository.js";
import { canManageTeam } from "../db/repositories/relayRepository.js";
import type { RoomRow } from "../db/schema.js";
import { getActivePrincipal } from "../services/authService.js";
import type { ConnectionRegistry } from "../sync/connectionRegistry.js";

const LISTED_PERMISSIONS: Permission[] = [
  "room:read",
  "room:write",
  "room:delete",
  "file:read",
  "file:write",
  "file:create",
  "file:delete",
  "sync:subscribe",
  "sync:push"
];

export type RoomRoutesOptions = {
  connectionRegistry?: ConnectionRegistry;
};

export function registerRoomRoutes(app: FastifyInstance, repo: RelayRepository, options: RoomRoutesOptions = {}): void {
  app.post("/api/teams/:teamId/rooms", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { teamId } = request.params as { teamId: string };
    if (!canManageTeam(principal, teamId)) {
      throw new AppError("PERMISSION_DENIED", "Only owners and admins can create rooms.", 403);
    }

    const body = request.body as Partial<{
      name: string;
      type: "file" | "folder";
      sourcePath: string;
      mountName: string;
      capabilities: Array<{ pluginId: string; displayName: string; mode: CapabilityMode; minVersion?: string }>;
    }>;
    if (!body.name || !body.type || !body.sourcePath || !body.mountName) {
      throw new AppError("VALIDATION_ERROR", "name, type, sourcePath, and mountName are required.", 422);
    }
    if (body.type !== "file" && body.type !== "folder") {
      throw new AppError("VALIDATION_ERROR", "type must be file or folder.", 422);
    }
    if (!isSafeMountName(body.mountName)) {
      throw new AppError("INVALID_PATH", "mountName must be a safe single path segment.", 422);
    }

    try {
      const room = repo.createRoom({
        teamId,
        name: body.name,
        type: body.type,
        sourcePath: body.sourcePath,
        mountName: body.mountName,
        ownerUserId: principal.userId,
        capabilities: body.capabilities ?? []
      });
      return { room: toRoomResponse(room) };
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw new AppError("VALIDATION_ERROR", "mountName must be unique within the team.", 409);
      }
      throw error;
    }
  });

  app.get("/api/teams/:teamId/rooms", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { teamId } = request.params as { teamId: string };
    if (principal.teamId !== teamId) {
      throw new AppError("PERMISSION_DENIED", "You are not a member of this team.", 403);
    }

    const aclRules = repo.listAclRulesForTeam(teamId);
    const rooms = repo
      .listTeamRooms(teamId)
      .map((room) => visibleRoom(repo, principal, room, aclRules))
      .filter((room): room is NonNullable<typeof room> => room !== null);

    return { rooms };
  });

  app.patch("/api/rooms/:roomId", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { roomId } = request.params as { roomId: string };
    const room = repo.getRoom(roomId);
    if (!room) {
      throw new AppError("NOT_FOUND", "Room not found.", 404);
    }
    if (!canManageTeam(principal, room.team_id)) {
      throw new AppError("PERMISSION_DENIED", "Only owners and admins can update room settings.", 403);
    }

    const body = request.body as Partial<{
      name: string;
      type: "file" | "folder";
      sourcePath: string;
      mountName: string;
      capabilities: Array<{ pluginId: string; displayName: string; mode: CapabilityMode; minVersion?: string }>;
    }>;
    if (!body.name || !body.type || !body.sourcePath || !body.mountName) {
      throw new AppError("VALIDATION_ERROR", "name, type, sourcePath, and mountName are required.", 422);
    }
    if (body.type !== "file" && body.type !== "folder") {
      throw new AppError("VALIDATION_ERROR", "type must be file or folder.", 422);
    }
    if (!isSafeMountName(body.mountName)) {
      throw new AppError("INVALID_PATH", "mountName must be a safe single path segment.", 422);
    }

    try {
      const updated = repo.updateRoom({
        roomId,
        actorUserId: principal.userId,
        name: body.name,
        type: body.type,
        sourcePath: body.sourcePath,
        mountName: body.mountName,
        capabilities: body.capabilities ?? []
      });
      return { room: visibleRoom(repo, principal, updated, repo.listAclRulesForTeam(updated.team_id)) };
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw new AppError("VALIDATION_ERROR", "mountName must be unique within the team.", 409);
      }
      throw error;
    }
  });

  app.get("/api/rooms/:roomId/acl", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { roomId } = request.params as { roomId: string };
    const room = repo.getRoom(roomId);
    if (!room) {
      throw new AppError("NOT_FOUND", "Room not found.", 404);
    }
    if (!canManageTeam(principal, room.team_id)) {
      throw new AppError("PERMISSION_DENIED", "Only owners and admins can inspect room permissions.", 403);
    }

    return { aclRules: repo.listAclRulesForRoom(roomId) };
  });

  app.post("/api/rooms/:roomId/acl", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { roomId } = request.params as { roomId: string };
    const room = repo.getRoom(roomId);
    if (!room) {
      throw new AppError("NOT_FOUND", "Room not found.", 404);
    }
    if (!canManageTeam(principal, room.team_id)) {
      throw new AppError("PERMISSION_DENIED", "Only owners and admins can grant room permissions.", 403);
    }

    const body = request.body as Partial<{
      subjectType: SubjectType;
      subjectId: string;
      effect: "allow" | "deny";
      preset: "reader" | "editor";
      permissions: Permission[];
      pathPattern: string;
    }>;
    if (!body.subjectType || !body.subjectId || !body.effect || !body.pathPattern) {
      throw new AppError("VALIDATION_ERROR", "subjectType, subjectId, effect, and pathPattern are required.", 422);
    }
    if (body.effect !== "allow" && body.effect !== "deny") {
      throw new AppError("VALIDATION_ERROR", "effect must be allow or deny.", 422);
    }
    const permissions = body.preset ? expandPreset(body.preset) : body.permissions;
    if (!permissions || permissions.length === 0) {
      throw new AppError("VALIDATION_ERROR", "preset or permissions must be provided.", 422);
    }

    const aclRule = repo.createAclRule({
      teamId: room.team_id,
      roomId,
      actorUserId: principal.userId,
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      effect: body.effect,
      permissions,
      pathPattern: body.pathPattern
    });
    return { aclRule };
  });

  app.delete("/api/rooms/:roomId/acl/:aclId", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { roomId, aclId } = request.params as { roomId: string; aclId: string };
    const room = repo.getRoom(roomId);
    if (!room) {
      throw new AppError("NOT_FOUND", "Room not found.", 404);
    }
    if (!canManageTeam(principal, room.team_id)) {
      throw new AppError("PERMISSION_DENIED", "Only owners and admins can remove room permissions.", 403);
    }
    repo.deleteAclRule({ aclId, roomId, teamId: room.team_id, actorUserId: principal.userId });
    return { ok: true };
  });

  app.delete("/api/rooms/:roomId", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { roomId } = request.params as { roomId: string };
    const room = repo.getRoom(roomId);
    if (!room) {
      throw new AppError("NOT_FOUND", "Room not found.", 404);
    }
    if (!canManageTeam(principal, room.team_id)) {
      throw new AppError("PERMISSION_DENIED", "Only owners and admins can delete rooms.", 403);
    }
    repo.deleteRoom({ roomId, teamId: room.team_id, actorUserId: principal.userId });
    options.connectionRegistry?.broadcastToRoom(roomId, { type: "room_deleted", roomId });
    return { ok: true };
  });
}

function visibleRoom(repo: RelayRepository, principal: DevicePrincipal, room: RoomRow, aclRules: ReturnType<RelayRepository["listAclRulesForTeam"]>) {
  const subject = { type: "user" as const, id: principal.userId, role: principal.role, userId: principal.userId };
  const roomRead = evaluatePolicy({
    teamId: principal.teamId,
    subject,
    resource: { type: "room", roomId: room.id, roomOwnerUserId: room.owner_user_id },
    permission: "room:read",
    aclRules,
    membershipRevokedAt: principal.memberRevokedAt,
    deviceRevokedAt: principal.deviceRevokedAt
  });
  if (!roomRead.allowed) {
    return null;
  }

  return {
    ...toRoomResponse(room),
    permissions: LISTED_PERMISSIONS.filter((permission) =>
      evaluatePolicy({
        teamId: principal.teamId,
        subject,
        resource: resourceFor(permission, room),
        permission,
        aclRules,
        membershipRevokedAt: principal.memberRevokedAt,
        deviceRevokedAt: principal.deviceRevokedAt
      }).allowed
    ),
    capabilities: repo.listCapabilities(room.id).map((capability) => ({
      pluginId: capability.plugin_id,
      displayName: capability.display_name,
      mode: capability.mode,
      minVersion: capability.min_version ?? undefined,
      installed: null
    }))
  };
}

function resourceFor(permission: Permission, room: RoomRow) {
  if (permission.startsWith("room:")) {
    return { type: "room" as const, roomId: room.id, roomOwnerUserId: room.owner_user_id };
  }
  return { type: "file" as const, roomId: room.id, roomOwnerUserId: room.owner_user_id, relativePath: "" };
}

function toRoomResponse(room: RoomRow) {
  return {
    id: room.id,
    name: room.name,
    type: room.type,
    sourcePath: room.source_path,
    mountName: room.mount_name,
    ownerUserId: room.owner_user_id
  };
}

function isSafeMountName(value: string): boolean {
  return Boolean(value) && !value.includes("/") && !value.includes("\\") && !value.startsWith(".") && value !== "." && value !== "..";
}
