import type { FastifyInstance } from "fastify";
import {
  AppError,
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
function hasExtendedBinarySyncCapability(request: { query: unknown }): boolean {
  const query = request.query as Partial<{ capabilities: string | string[] }>;
  const raw = query.capabilities;
  const values = Array.isArray(raw) ? raw : (raw ?? "").split(",");
  return values.map((value) => value.trim()).includes("extendedBinarySync");
}

export function registerFileRoutes(app: FastifyInstance, repo: RelayRepository, options: FileRoutesOptions): void {
  app.get("/api/rooms/:roomId/files", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const room = requireRoom(repo, (request.params as { roomId: string }).roomId);
    const listAclRules = repo.listAclRulesForRoom(room.id);
    const extendedBinarySync = hasExtendedBinarySyncCapability(request);
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
        // See hasExtendedBinarySyncCapability above / isLegacyEligiblePath's doc comment: a caller
        // that hasn't declared the capability never learns a legacy-ineligible path exists.
        .filter((file) => extendedBinarySync || isLegacyEligiblePath(file.relative_path))
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
    // Same invisibility as the files-list route above: a caller that hasn't declared the capability
    // gets NOT_FOUND rather than base64 content it doesn't know is base64 - it should never have
    // learned this path exists in the first place (its own file list was already filtered), so this
    // only matters as defense-in-depth against a stale cache or a hand-crafted request.
    if (!isLegacyEligiblePath(relativePath) && !hasExtendedBinarySyncCapability(request)) {
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
        relativePath,
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
    return { ok: true, relativePath, version: result.version, sha256: result.sha256 };
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
        relativePath,
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
