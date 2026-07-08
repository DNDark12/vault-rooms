import type { FastifyInstance } from "fastify";
import { AppError, isEligiblePath, normalizeRelativePath } from "@vault-rooms/protocol";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import { getActivePrincipal } from "../services/authService.js";
import { assertRoomPermission, hasRoomPermission } from "../services/policyService.js";
import type { ConnectionRegistry } from "../sync/connectionRegistry.js";

export type FileRoutesOptions = {
  maxFileBytes: number;
  connectionRegistry?: ConnectionRegistry;
};

export function registerFileRoutes(app: FastifyInstance, repo: RelayRepository, options: FileRoutesOptions): void {
  app.get("/api/rooms/:roomId/files", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const room = requireRoom(repo, (request.params as { roomId: string }).roomId);
    const listAclRules = repo.listAclRulesForRoom(room.id);
    return {
      files: repo
        .listFiles(room.id)
        .filter((file) =>
          hasRoomPermission({
            repo,
            principal,
            room,
            permission: "file:read",
            relativePath: file.relative_path,
            aclRules: listAclRules
          })
        )
        .map((file) => ({
          relativePath: file.relative_path,
          kind: file.kind,
          version: file.version,
          sha256: file.sha256,
          deleted: Boolean(file.deleted_at)
        }))
    };
  });

  app.get("/api/rooms/:roomId/files/content", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const room = requireRoom(repo, (request.params as { roomId: string }).roomId);
    const query = request.query as Partial<{ path: string }>;
    const relativePath = normalizeRelativePath(query.path ?? "");
    assertRoomPermission({ repo, principal, room, permission: "file:read", relativePath });
    const { file, content } = repo.readFileContent(room.id, relativePath);
    return {
      relativePath,
      version: file.version,
      sha256: file.sha256,
      content
    };
  });

  app.put("/api/rooms/:roomId/files/content", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const room = requireRoom(repo, (request.params as { roomId: string }).roomId);
    const body = request.body as Partial<{ relativePath: string; baseVersion: number; content: string }>;
    if (!body.relativePath || typeof body.content !== "string") {
      throw new AppError("VALIDATION_ERROR", "relativePath and content are required.", 422);
    }
    const relativePath = normalizeRelativePath(body.relativePath);
    if (!isEligiblePath(relativePath)) {
      throw new AppError("INVALID_PATH", "This file type isn't supported for sync yet (v0.1 supports Markdown/text/canvas/JSON/CSV plus common image formats and PDF).", 422);
    }
    if (Buffer.byteLength(body.content, "utf8") > options.maxFileBytes) {
      throw new AppError("FILE_TOO_LARGE", "The file exceeds MAX_FILE_BYTES.", 413);
    }

    const baseVersion = body.baseVersion ?? 0;
    assertRoomPermission({
      repo,
      principal,
      room,
      permission: baseVersion === 0 ? "file:create" : "file:write",
      relativePath
    });
    const result = repo.writeFile({
      roomId: room.id,
      relativePath,
      baseVersion,
      content: body.content,
      actorUserId: principal.userId
    });
    const fileChangeAclRules = repo.listAclRulesForRoom(room.id);
    options.connectionRegistry?.broadcastToRoom(
      room.id,
      {
        type: "remote_file_change",
        roomId: room.id,
        relativePath,
        version: result.version,
        sha256: result.sha256,
        content: body.content,
        updatedBy: { userId: principal.userId, displayName: principal.userDisplayName },
        updatedAt: new Date().toISOString()
      },
      {
        excludeDeviceId: principal.deviceId,
        canReceive: (recipient) =>
          hasRoomPermission({ repo, principal: recipient, room, permission: "file:read", relativePath, aclRules: fileChangeAclRules })
      }
    );
    return { ok: true, relativePath: result.relativePath, version: result.version, sha256: result.sha256 };
  });

  app.post("/api/rooms/:roomId/files/delete", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const room = requireRoom(repo, (request.params as { roomId: string }).roomId);
    const body = request.body as Partial<{ relativePath: string; baseVersion: number }>;
    if (!body.relativePath || typeof body.baseVersion !== "number") {
      throw new AppError("VALIDATION_ERROR", "relativePath and baseVersion are required.", 422);
    }
    const relativePath = normalizeRelativePath(body.relativePath);
    assertRoomPermission({ repo, principal, room, permission: "file:delete", relativePath });
    const result = repo.deleteFile({
      roomId: room.id,
      relativePath,
      baseVersion: body.baseVersion,
      actorUserId: principal.userId
    });
    const fileDeleteAclRules = repo.listAclRulesForRoom(room.id);
    options.connectionRegistry?.broadcastToRoom(
      room.id,
      {
        type: "remote_file_delete",
        roomId: room.id,
        relativePath,
        version: result.version,
        deletedBy: { userId: principal.userId, displayName: principal.userDisplayName },
        deletedAt: new Date().toISOString()
      },
      {
        excludeDeviceId: principal.deviceId,
        canReceive: (recipient) =>
          hasRoomPermission({ repo, principal: recipient, room, permission: "file:read", relativePath, aclRules: fileDeleteAclRules })
      }
    );
    return result;
  });
}

function requireRoom(repo: RelayRepository, roomId: string) {
  const room = repo.getRoom(roomId);
  if (!room) {
    throw new AppError("NOT_FOUND", "Room not found.", 404);
  }
  return room;
}
