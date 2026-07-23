import type { FastifyInstance } from "fastify";
import { AppError, isCrdtEligiblePath, isEligiblePath, normalizeRelativePath } from "@vault-rooms/protocol";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import { getActivePrincipal } from "../services/authService.js";
import { assertRoomPermission, hasRoomPermission } from "../services/policyService.js";
import type { ConnectionRegistry } from "../sync/connectionRegistry.js";
import type { CrdtDocManager } from "../sync/crdtDocManager.js";

export type FileRoutesOptions = {
  maxFileBytes: number;
  connectionRegistry?: ConnectionRegistry;
  /** Phase 6: needed for the legacy-write-policy rejection (contract 1.4) and to evict a deleted
   *  file's cached CRDT doc via this REST delete route - the WS file_delete branch already does
   *  the same eviction (Phase 4); optional only so tests that don't exercise the CRDT lane can omit
   *  it. */
  crdtDocManager?: CrdtDocManager;
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
      throw new AppError("INVALID_PATH", "This file type isn't supported for sync yet (supported: Markdown/text/canvas/JSON/CSV, common image formats, and PDF).", 422);
    }
    // Legacy write policy (contract 1.4, decided as "reject") - see the identical check in
    // syncServer.ts's file_change branch for the WS equivalent. GET (this route's read sibling)
    // is unaffected: it keeps serving the materialized files/file_versions row CrdtDocManager's
    // debounced materialize keeps fresh, for both CRDT-capable and legacy clients.
    if (room.crdt_enabled && isCrdtEligiblePath(relativePath)) {
      throw new AppError(
        "CRDT_WRITE_UNSUPPORTED",
        "This room has CRDT sync enabled for this file - use the CRDT sync message types (or upgrade) instead of a whole-file write.",
        409
      );
    }
    if (Buffer.byteLength(body.content, "utf8") > options.maxFileBytes) {
      throw new AppError("FILE_TOO_LARGE", "The file exceeds MAX_FILE_BYTES.", 413);
    }

    const baseVersion = body.baseVersion ?? 0;
    assertRoomPermission({ repo, principal, room, permission: "sync:push", relativePath });
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
    assertRoomPermission({ repo, principal, room, permission: "sync:push", relativePath });
    assertRoomPermission({ repo, principal, room, permission: "file:delete", relativePath });
    // Contract 1.5: deleteFile() already bumps files.crdt_epoch and purges the old epoch's durable
    // CRDT rows transactionally - this just closes the loop on the in-memory cache too, mirroring
    // the WS file_delete branch (Phase 4 left this REST route as a known memory-hygiene gap,
    // harmless but noted, closed here in Phase 6). Inert for a file that never had a CRDT document.
    const beforeDelete = repo.getFile(room.id, relativePath);
    const result = repo.deleteFile({
      roomId: room.id,
      relativePath,
      baseVersion: body.baseVersion,
      actorUserId: principal.userId
    });
    if (beforeDelete) {
      options.crdtDocManager?.evictDocument(beforeDelete.id, beforeDelete.crdt_epoch);
    }
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
