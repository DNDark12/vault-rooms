import type { FastifyInstance } from "fastify";
import { AppError, type CapabilityMode, type ConflictPolicy, type Permission, type SubjectType } from "@vault-rooms/protocol";
import { evaluatePolicy, expandPreset } from "@vault-rooms/policy";
import type { DevicePrincipal, RelayRepository } from "../db/repositories/relayRepository.js";
import { canManageRoom } from "../db/repositories/relayRepository.js";
import type { RoomRow } from "../db/schema.js";
import { getActivePrincipal } from "../services/authService.js";
import { revalidateRoomAccess } from "../services/policyService.js";
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
  app.post("/api/rooms", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const body = request.body as Partial<{
      name: string;
      type: "file" | "folder";
      sourcePath: string;
      mountName: string;
      conflictPolicy: ConflictPolicy;
      capabilities: Array<{ pluginId: string; displayName: string; mode: CapabilityMode; minVersion?: string }>;
    }>;
    validateRoomBody(body);

    try {
      const room = repo.createRoom({
        name: body.name!,
        type: body.type!,
        sourcePath: body.sourcePath!,
        mountName: body.mountName!,
        ownerUserId: principal.userId,
        conflictPolicy: body.conflictPolicy,
        capabilities: body.capabilities ?? []
      });
      return { room: toRoomResponse(room) };
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw new AppError("VALIDATION_ERROR", "mountName must be unique for this owner.", 409);
      }
      throw error;
    }
  });

  app.get("/api/rooms", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const teamIds = repo.listUserTeams(principal.userId).map((team) => team.teamId);
    const rooms = repo
      .listAllRooms()
      .map((room) => visibleRoom(repo, principal, room, teamIds))
      .filter((room): room is NonNullable<typeof room> => room !== null);

    return { rooms };
  });

  app.patch("/api/rooms/:roomId", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { roomId } = request.params as { roomId: string };
    const room = requireRoom(repo, roomId);
    if (!canManageRoom(principal, room)) {
      throw new AppError("PERMISSION_DENIED", "Only the room owner or server owner can update room settings.", 403);
    }

    const body = request.body as Partial<{
      name: string;
      type: "file" | "folder";
      sourcePath: string;
      mountName: string;
      conflictPolicy: ConflictPolicy;
      capabilities: Array<{ pluginId: string; displayName: string; mode: CapabilityMode; minVersion?: string }>;
    }>;
    validateRoomBody(body);

    try {
      const updated = repo.updateRoom({
        roomId,
        actorUserId: principal.userId,
        name: body.name!,
        type: body.type!,
        sourcePath: body.sourcePath!,
        mountName: body.mountName!,
        conflictPolicy: body.conflictPolicy,
        capabilities: body.capabilities ?? []
      });
      const teamIds = repo.listUserTeams(principal.userId).map((team) => team.teamId);
      return { room: visibleRoom(repo, principal, updated, teamIds) ?? managedRoomResponse(repo, updated) };
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw new AppError("VALIDATION_ERROR", "mountName must be unique for this owner.", 409);
      }
      throw error;
    }
  });

  app.get("/api/rooms/:roomId/acl", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { roomId } = request.params as { roomId: string };
    const room = requireRoom(repo, roomId);
    if (!canManageRoom(principal, room)) {
      throw new AppError("PERMISSION_DENIED", "Only the room owner or server owner can inspect room permissions.", 403);
    }

    return { aclRules: repo.listAclRulesForRoom(roomId) };
  });

  app.post("/api/rooms/:roomId/acl", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { roomId } = request.params as { roomId: string };
    const room = requireRoom(repo, roomId);
    if (!canManageRoom(principal, room)) {
      throw new AppError("PERMISSION_DENIED", "Only the room owner or server owner can grant room permissions.", 403);
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
    if (!isSubjectType(body.subjectType)) {
      throw new AppError("VALIDATION_ERROR", "subjectType must be user, team, device, or agent.", 422);
    }
    if (body.effect !== "allow" && body.effect !== "deny") {
      throw new AppError("VALIDATION_ERROR", "effect must be allow or deny.", 422);
    }
    const permissions = body.preset ? expandPreset(body.preset) : body.permissions;
    if (!permissions || permissions.length === 0) {
      throw new AppError("VALIDATION_ERROR", "preset or permissions must be provided.", 422);
    }

    const aclRule = repo.createAclRule({
      roomId,
      actorUserId: principal.userId,
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      effect: body.effect,
      permissions,
      pathPattern: body.pathPattern
    });
    revalidateRoomAccess(repo, options.connectionRegistry);
    return { aclRule };
  });

  app.delete("/api/rooms/:roomId/acl/:aclId", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { roomId, aclId } = request.params as { roomId: string; aclId: string };
    const room = requireRoom(repo, roomId);
    if (!canManageRoom(principal, room)) {
      throw new AppError("PERMISSION_DENIED", "Only the room owner or server owner can remove room permissions.", 403);
    }
    repo.deleteAclRule({ aclId, roomId, actorUserId: principal.userId });
    revalidateRoomAccess(repo, options.connectionRegistry);
    return { ok: true };
  });

  app.delete("/api/rooms/:roomId", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { roomId } = request.params as { roomId: string };
    const room = requireRoom(repo, roomId);
    if (!canManageRoom(principal, room)) {
      throw new AppError("PERMISSION_DENIED", "Only the room owner or server owner can delete rooms.", 403);
    }
    repo.deleteRoom({ roomId, actorUserId: principal.userId });
    options.connectionRegistry?.broadcastToRoom(roomId, { type: "room_deleted", roomId });
    return { ok: true };
  });
}

function visibleRoom(repo: RelayRepository, principal: DevicePrincipal, room: RoomRow, teamIds: string[]) {
  const subject = { type: "user" as const, id: principal.userId, userId: principal.userId, teamIds };
  const roomRead = evaluatePolicy({
    subject,
    resource: { type: "room", roomId: room.id, roomOwnerUserId: room.owner_user_id },
    permission: "room:read",
    aclRules: repo.listAclRulesForRoom(room.id),
    membershipRevokedAt: principal.userRevokedAt,
    deviceRevokedAt: principal.deviceRevokedAt
  });
  if (!roomRead.allowed) {
    return null;
  }

  const aclRules = repo.listAclRulesForRoom(room.id);
  return {
    ...managedRoomResponse(repo, room),
    permissions: LISTED_PERMISSIONS.filter((permission) =>
      evaluatePolicy({
        subject,
        resource: resourceFor(permission, room),
        permission,
        aclRules,
        membershipRevokedAt: principal.userRevokedAt,
        deviceRevokedAt: principal.deviceRevokedAt
      }).allowed
    )
  };
}

function resourceFor(permission: Permission, room: RoomRow) {
  if (permission.startsWith("room:")) {
    return { type: "room" as const, roomId: room.id, roomOwnerUserId: room.owner_user_id };
  }
  return { type: "file" as const, roomId: room.id, roomOwnerUserId: room.owner_user_id, relativePath: "" };
}

function managedRoomResponse(repo: RelayRepository, room: RoomRow) {
  return {
    ...toRoomResponse(room),
    permissions: [] as Permission[],
    capabilities: repo.listCapabilities(room.id).map((capability) => ({
      pluginId: capability.plugin_id,
      displayName: capability.display_name,
      mode: capability.mode,
      minVersion: capability.min_version ?? undefined,
      installed: null
    }))
  };
}

function toRoomResponse(room: RoomRow) {
  return {
    id: room.id,
    name: room.name,
    type: room.type,
    sourcePath: room.source_path,
    mountName: room.mount_name,
    ownerUserId: room.owner_user_id,
    conflictPolicy: room.conflict_policy
  };
}

function requireRoom(repo: RelayRepository, roomId: string): RoomRow {
  const room = repo.getRoom(roomId);
  if (!room) {
    throw new AppError("NOT_FOUND", "Room not found.", 404);
  }
  return room;
}

function validateRoomBody(body: Partial<{ name: string; type: "file" | "folder"; sourcePath: string; mountName: string; conflictPolicy: ConflictPolicy }>): void {
  if (!body.name || !body.type || !body.sourcePath || !body.mountName) {
    throw new AppError("VALIDATION_ERROR", "name, type, sourcePath, and mountName are required.", 422);
  }
  if (body.type !== "file" && body.type !== "folder") {
    throw new AppError("VALIDATION_ERROR", "type must be file or folder.", 422);
  }
  if (!isSafeMountName(body.mountName)) {
    throw new AppError("INVALID_PATH", "mountName must be a safe single path segment.", 422);
  }
  if (body.conflictPolicy !== undefined && body.conflictPolicy !== "keep_both" && body.conflictPolicy !== "owner_wins") {
    throw new AppError("VALIDATION_ERROR", "conflictPolicy must be keep_both or owner_wins.", 422);
  }
}

function isSubjectType(value: string): value is SubjectType {
  return value === "user" || value === "team" || value === "device" || value === "agent";
}

function isSafeMountName(value: string): boolean {
  return Boolean(value) && !value.includes("/") && !value.includes("\\") && !value.startsWith(".") && value !== "." && value !== "..";
}
