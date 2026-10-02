import type { FastifyInstance } from "fastify";
import {
  AppError,
  createId,
  portablePathKey,
  contentTypeForPath,
  isCrdtEligiblePath,
  isLegacyEligiblePath,
  isValidBase64,
  isValidUtf8,
  normalizeRelativePath
} from "@vault-rooms/protocol";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import { getActivePrincipal } from "../services/authService.js";
import { assertRoomPermission, hasRoomPermission } from "../services/policyService.js";
import { roomSnapshot, visibleRoomFiles } from "../services/roomSnapshot.js";
import { formatFileLimit } from "../services/userFacingMessages.js";
import { fileContentByteLength } from "../services/fileContentSize.js";
import type { ConnectionRegistry } from "../sync/connectionRegistry.js";
import type { CrdtDocManager } from "../sync/crdtDocManager.js";
import type { PresenceService } from "../sync/presenceService.js";
import type { ContentWriteService } from "../storage/contentWriteService.js";
import { decodeTransportContent } from "../storage/contentWriteService.js";
import { rawHttpResponse } from "../services/rawHttpResponse.js";

export type FileRoutesOptions = {
  maxFileBytes: number;
  connectionRegistry?: ConnectionRegistry;
  /** Shared external-content read/write seam. */
  contentWriteService: ContentWriteService;
  /** Evicts CRDT state after REST deletion. */
  crdtDocManager?: CrdtDocManager;
  /** Clears live cursors after REST deletion. */
  presenceService: PresenceService;
};

// REST clients declare binary-sync support on each request.
function hasCapability(request: { query: unknown }, capability: string): boolean {
  const query = request.query as Partial<{ capabilities: string | string[] }>;
  const raw = query.capabilities;
  const values = Array.isArray(raw) ? raw : (raw ?? "").split(",");
  return values.map((value) => value.trim()).includes(capability);
}

export function registerFileRoutes(app: FastifyInstance, repo: RelayRepository, options: FileRoutesOptions): void {
  app.get("/api/rooms/:roomId/path-collisions", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const room = requireRoom(repo, (request.params as {
      roomId: string;
    }).roomId);
    if (principal.userId !== room.owner_user_id)
      throw new AppError("PERMISSION_DENIED", "Only the room owner can repair overlapping file names.", 403);
    return { groups: repo.listPathCollisions(room.id) };
  });
  app.post("/api/rooms/:roomId/files/rename", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const room = requireRoom(repo, (request.params as {
      roomId: string;
    }).roomId);
    if (principal.userId !== room.owner_user_id)
      throw new AppError("PERMISSION_DENIED", "Only the room owner can repair file names.", 403);
    const body = request.body as Partial<{
      fileId: string;
      relativePath: string;
    }>;
    if (!body || typeof body.fileId !== "string" || typeof body.relativePath !== "string")
      throw new AppError("VALIDATION_ERROR", "Choose a file and enter its new name.", 422);
    const relativePath = normalizeRelativePath(body.relativePath);
    const outcome = await repo.withExclusiveAccess(async () => {
      const activePrincipal = getActivePrincipal(repo, request);
      const currentRoom = requireRoom(repo, room.id);
      if (activePrincipal.userId !== currentRoom.owner_user_id)
        throw new AppError("PERMISSION_DENIED", "Only the room owner can repair file names.", 403);
      const before = repo.getFileById(body.fileId!);
      if (!before || before.room_id !== room.id || before.deleted_at)
        throw new AppError("NOT_FOUND", "File not found.", 404);
      assertRoomPermission({ repo, principal: activePrincipal, room: currentRoom, permission: "file:delete", relativePath: before.relative_path });
      assertRoomPermission({ repo, principal: activePrincipal, room: currentRoom, permission: "file:create", relativePath });
      assertRoomPermission({ repo, principal: activePrincipal, room: currentRoom, permission: "sync:push", relativePath: before.relative_path });
      assertRoomPermission({ repo, principal: activePrincipal, room: currentRoom, permission: "sync:push", relativePath });
      const target = before.path_key === portablePathKey(relativePath) ? null : repo.getFile(room.id, relativePath);
      const blobKeys = target ? repo.listBlobKeysForFile(target.id) : [];
      const result = await repo.durable(() => repo.renameFileById({ roomId: room.id, fileId: before.id, relativePath, actorUserId: principal.userId }));
      const file = repo.getFileById(before.id)!;
      const deletedVersion = Math.max(before.version + 1, ...repo.listFiles(room.id).filter(row => row.path_key === before.path_key && row.deleted_at).map(row => row.version));
      return { before, result, blobKeys, file, deletedVersion, crdtEnabled: currentRoom.crdt_enabled };
    });
    const { before, result, file, deletedVersion } = outcome;
    const updatedBy = { userId: principal.userId, displayName: principal.userDisplayName };
    let needsSnapshot = Boolean(before.path_collision);
    try {
      if (!before.path_collision) {
        const { content, file: current } = await options.contentWriteService.readFileContent({ roomId: room.id, relativePath: file.relative_path });
        const latest = repo.getFileById(file.id);
        const currentRoom = repo.getRoom(room.id);
        if (currentRoom && latest && !latest.deleted_at && latest.id === current.id && latest.relative_path === file.relative_path && latest.version === file.version && latest.crdt_epoch === file.crdt_epoch && current.version === file.version) {
          needsSnapshot = currentRoom.crdt_enabled !== outcome.crdtEnabled;
          const sameKey = before.path_key === file.path_key;
          const aclRules = repo.listAclRulesForRoom(room.id);
          const canRead = (recipient: typeof principal, path: string) => hasRoomPermission({ repo, principal: recipient, room: currentRoom, permission: "file:read", relativePath: path, aclRules });
          const liveEditing = Boolean(currentRoom.crdt_enabled) && isCrdtEligiblePath(file.relative_path);
          if (liveEditing)
            options.connectionRegistry?.broadcastToRoom(room.id, { type: "remote_crdt_rename", roomId: room.id, oldRelativePath: before.relative_path, relativePath: file.relative_path, epoch: file.crdt_epoch, renamedBy: updatedBy }, {
              canReceive: recipient => canRead(recipient, before.relative_path) && canRead(recipient, file.relative_path),
              connectionFilter: connection => connection.capabilities.crdt
            });
          if (!sameKey)
            options.connectionRegistry?.broadcastToRoom(room.id, { type: "remote_file_delete", roomId: room.id, relativePath: before.relative_path, version: deletedVersion, deletedBy: updatedBy, deletedAt: new Date().toISOString() }, {
              canReceive: recipient => canRead(recipient, before.relative_path),
              connectionFilter: connection => (connection.capabilities.extendedBinarySync || isLegacyEligiblePath(before.relative_path)) && !(liveEditing && connection.capabilities.crdt && connection.principal && canRead(connection.principal, file.relative_path))
            });
          options.connectionRegistry?.broadcastToRoom(room.id, { type: "remote_file_change", roomId: room.id, relativePath: file.relative_path, version: current.version, sha256: current.sha256 ?? "", content, contentEncoding: current.content_type === "binary" ? "base64" : "utf8", updatedBy, updatedAt: new Date().toISOString(), ...(liveEditing ? { crdtEpoch: file.crdt_epoch } : {}) }, {
            canReceive: recipient => canRead(recipient, file.relative_path),
            connectionFilter: connection => (connection.capabilities.extendedBinarySync || isLegacyEligiblePath(file.relative_path)) && !(liveEditing && connection.capabilities.crdt && connection.principal && canRead(connection.principal, before.relative_path))
          });
          if (!sameKey)
            options.presenceService.removeDocument(room.id, before.relative_path, before.crdt_epoch);
        }
        else {
          needsSnapshot = true;
        }
      }
    }
    catch (error) {
      needsSnapshot = true;
      // The durable rename succeeded; a concurrent move/delete is reconciled below.
      console.warn("Vault Rooms relay: could not announce a repaired file name", error);
    }
    // Quarantined names need a full snapshot; stale or failed fanout also reconciles current state.
    const currentRoom = needsSnapshot ? repo.getRoom(room.id) : null;
    if (currentRoom)
      options.connectionRegistry?.broadcastToRoom(room.id, connection => roomSnapshot(repo, connection.principal!, currentRoom, connection.capabilities, createId("req")), {
        connectionFilter: connection => Boolean(connection.principal && connection.capabilities.portablePaths)
      });
    await options.contentWriteService.collectOrphanedBlobKeys(outcome.blobKeys);
    return { ...result, fileId: file.id, version: file.version };
  });
  app.get("/api/rooms/:roomId/files", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const room = requireRoom(repo, (request.params as {
      roomId: string;
    }).roomId);
    return {
      files: visibleRoomFiles(repo, principal, room, {
        extendedBinarySync: hasCapability(request, "extendedBinarySync"), portablePaths: hasCapability(request, "portablePaths")
      }).map(file => ({
        relativePath: file.relative_path, kind: file.kind, version: file.version, sha256: file.sha256,
        deleted: Boolean(file.deleted_at), ...(file.path_collision ? { pathCollision: true, fileId: file.id } : {})
      }))
    };
  });

  app.get("/api/rooms/:roomId/files/content", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const room = requireRoom(repo, (request.params as { roomId: string }).roomId);
    const query = request.query as Partial<{ path: string }>;
    const relativePath = normalizeRelativePath(query.path ?? "");
    // Same invisibility as the files-list route above: a caller that hasn't declared the capability
    // gets NOT_FOUND rather than base64 content it doesn't know is base64 - it should never have
    // learned this path exists in the first place (its own file list was already filtered), so this
    // only matters as defense-in-depth against a stale cache or a hand-crafted request.
    if (!isLegacyEligiblePath(relativePath) && !hasCapability(request, "extendedBinarySync")) {
      throw new AppError("NOT_FOUND", "File not found.", 404);
    }
    assertRoomPermission({ repo, principal, room, permission: "file:read", relativePath });
    const { file, content } = await options.contentWriteService.readFileContent({ roomId: room.id, relativePath });
    return {
      relativePath,
      version: file.version,
      sha256: file.sha256,
      content,
      contentEncoding: contentTypeForPath(relativePath) === "binary" ? "base64" : "utf8"
    };
  });

  app.get("/api/rooms/:roomId/files/raw", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const room = requireRoom(repo, (request.params as { roomId: string }).roomId);
    const query = request.query as Partial<{ path: string }>;
    const relativePath = normalizeRelativePath(query.path ?? "");
    assertRoomPermission({ repo, principal, room, permission: "file:read", relativePath });
    const { file, content } = await options.contentWriteService.readFileContent({ roomId: room.id, relativePath });
    return rawHttpResponse(decodeTransportContent(content, contentTypeForPath(relativePath)), "application/octet-stream", {
      "x-vault-rooms-version": String(file.version),
      "x-vault-rooms-sha256": file.sha256 ?? ""
    });
  });

  app.put("/api/rooms/:roomId/files/raw", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const room = requireRoom(repo, (request.params as { roomId: string }).roomId);
    const query = request.query as Partial<{ path: string; baseVersion: string }>;
    const relativePath = normalizeRelativePath(query.path ?? "");
    const baseVersion = Number(query.baseVersion ?? 0);
    if (!Number.isSafeInteger(baseVersion) || baseVersion < 0 || !(request.body instanceof Uint8Array)) {
      throw new AppError("VALIDATION_ERROR", "This raw sync request is invalid.", 422);
    }
    if (request.body.byteLength > options.maxFileBytes) {
      throw new AppError(
        "FILE_TOO_LARGE",
        `This file is larger than this server accepts (limit ${formatFileLimit(options.maxFileBytes)}).`,
        413
      );
    }
    if (room.crdt_enabled && isCrdtEligiblePath(relativePath)) {
      throw new AppError("CRDT_WRITE_UNSUPPORTED", "This note uses live editing - update the plugin to edit it.", 409);
    }
    assertRoomPermission({ repo, principal, room, permission: "sync:push", relativePath });
    assertRoomPermission({
      repo,
      principal,
      room,
      permission: baseVersion === 0 ? "file:create" : "file:write",
      relativePath
    });
    const contentType = contentTypeForPath(relativePath);
    if (contentType !== "binary" && !isValidUtf8(request.body)) {
      throw new AppError("VALIDATION_ERROR", "This file isn't UTF-8 text, so syncing it would damage it.", 422);
    }
    const content = Buffer.from(request.body).toString(contentType === "binary" ? "base64" : "utf8");
    const result = await options.contentWriteService.writeFile({
      roomId: room.id,
      relativePath,
      baseVersion,
      content,
      actorUserId: principal.userId,
      revealServerContent: hasRoomPermission({ repo, principal, room, permission: "file:read", relativePath }),
      wholeFileLane: true
    });
    const aclRules = repo.listAclRulesForRoom(room.id);
    options.connectionRegistry?.broadcastToRoom(
      room.id,
      {
        type: "remote_file_change",
        roomId: room.id,
        relativePath: result.relativePath,
        version: result.version,
        sha256: result.sha256,
        content,
        contentEncoding: contentType === "binary" ? "base64" : "utf8",
        updatedBy: { userId: principal.userId, displayName: principal.userDisplayName },
        updatedAt: new Date().toISOString()
      },
      {
        excludeDeviceId: principal.deviceId,
        canReceive: (recipient) =>
          hasRoomPermission({ repo, principal: recipient, room, permission: "file:read", relativePath, aclRules }),
        connectionFilter: (recipient) => recipient.capabilities.extendedBinarySync || isLegacyEligiblePath(relativePath)
      }
    );
    return { ok: true, relativePath: result.relativePath, version: result.version, sha256: result.sha256 };
  });

  app.put("/api/rooms/:roomId/files/content", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const room = requireRoom(repo, (request.params as { roomId: string }).roomId);
    const body = request.body as Partial<{ relativePath: string; baseVersion: number; content: string }>;
    if (!body.relativePath || typeof body.content !== "string") {
      throw new AppError("VALIDATION_ERROR", "This sync request was missing the file path or its contents.", 422);
    }
    const relativePath = normalizeRelativePath(body.relativePath);
    // Markdown in CRDT rooms cannot be written through the CAS lane.
    if (room.crdt_enabled && isCrdtEligiblePath(relativePath)) {
      throw new AppError(
        "CRDT_WRITE_UNSUPPORTED",
        "This note uses live editing - update the plugin to edit it.",
        409
      );
    }
    const contentEncoding = contentTypeForPath(relativePath) === "binary" ? "base64" : "utf8";
    if (contentEncoding === "base64" && !isValidBase64(body.content)) {
      throw new AppError("VALIDATION_ERROR", "This file's contents were not valid for its type.", 422);
    }
    if (fileContentByteLength(body.content, contentEncoding) > options.maxFileBytes) {
      throw new AppError(
        "FILE_TOO_LARGE",
        `This file is larger than this server accepts (limit ${formatFileLimit(options.maxFileBytes)}).`,
        413
      );
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
    const result = await options.contentWriteService.writeFile({
      roomId: room.id,
      relativePath,
      baseVersion,
      content: body.content,
      actorUserId: principal.userId,
      revealServerContent: hasRoomPermission({ repo, principal, room, permission: "file:read", relativePath }),
      wholeFileLane: true
    });
    const fileChangeAclRules = repo.listAclRulesForRoom(room.id);
    options.connectionRegistry?.broadcastToRoom(
      room.id,
      {
        type: "remote_file_change",
        roomId: room.id,
        relativePath: result.relativePath,
        version: result.version,
        sha256: result.sha256,
        content: body.content,
        contentEncoding,
        updatedBy: { userId: principal.userId, displayName: principal.userDisplayName },
        updatedAt: new Date().toISOString()
      },
      {
        excludeDeviceId: principal.deviceId,
        canReceive: (recipient) =>
          hasRoomPermission({ repo, principal: recipient, room, permission: "file:read", relativePath, aclRules: fileChangeAclRules }),
        // Older clients receive only the original file types.
        connectionFilter: (recipient) => recipient.capabilities.extendedBinarySync || isLegacyEligiblePath(relativePath)
      }
    );
    return { ok: true, relativePath: result.relativePath, version: result.version, sha256: result.sha256 };
  });

  app.post("/api/rooms/:roomId/files/delete", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const room = requireRoom(repo, (request.params as { roomId: string }).roomId);
    const body = request.body as Partial<{ relativePath: string; baseVersion: number }>;
    if (!body.relativePath || typeof body.baseVersion !== "number") {
      throw new AppError("VALIDATION_ERROR", "This delete request was missing the file path or the version it was based on.", 422);
    }
    const relativePath = normalizeRelativePath(body.relativePath);
    assertRoomPermission({ repo, principal, room, permission: "sync:push", relativePath });
    assertRoomPermission({ repo, principal, room, permission: "file:delete", relativePath });
    // Contract 1.5: deleteFile() already bumps files.crdt_epoch and purges the old epoch's durable
    // CRDT rows transactionally - this just closes the loop on the in-memory cache too, mirroring
    // the WS file_delete branch (Phase 4 left this REST route as a known memory-hygiene gap,
    // harmless but noted, closed here in Phase 6). Inert for a file that never had a CRDT document.
    const beforeDelete = repo.getFile(room.id, relativePath);
    const result = await options.contentWriteService.deleteFile({
      roomId: room.id,
      relativePath,
      baseVersion: body.baseVersion,
      actorUserId: principal.userId,
      // Same reasoning as the WS file_delete branch - see deleteFile's `crdtAuthoritative` doc comment.
      crdtAuthoritative: Boolean(room.crdt_enabled) && isCrdtEligiblePath(relativePath)
    });
    if (beforeDelete) {
      options.crdtDocManager?.evictDocument(beforeDelete.id, beforeDelete.crdt_epoch);
      // Live cursors: mirrors the WS file_delete branch. The delete bumped the epoch, so any live
      // cursor is pinned to an epoch that no longer exists - clear it with the pre-delete epoch.
      options.presenceService.removeDocument(room.id, relativePath, beforeDelete.crdt_epoch);
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
          hasRoomPermission({ repo, principal: recipient, room, permission: "file:read", relativePath, aclRules: fileDeleteAclRules }),
        connectionFilter: (recipient) => recipient.capabilities.extendedBinarySync || isLegacyEligiblePath(relativePath)
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
