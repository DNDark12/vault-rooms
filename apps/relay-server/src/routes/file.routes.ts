import type { FastifyInstance } from "fastify";
import {
  AppError,
  contentTypeForPath,
  isCrdtEligiblePath,
  isLegacyEligiblePath,
  isValidBase64,
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

export type FileRoutesOptions = {
  maxFileBytes: number;
  connectionRegistry?: ConnectionRegistry;
  /** Phase 6: needed for the legacy-write-policy rejection (contract 1.4) and to evict a deleted
   *  file's cached CRDT doc via this REST delete route - the WS file_delete branch already does
   *  the same eviction (Phase 4); optional only so tests that don't exercise the CRDT lane can omit
   *  it. */
  crdtDocManager?: CrdtDocManager;
  /** Live cursors: this REST delete route is the second delete transport, so it needs the same
   *  presence teardown the WS `file_delete` branch does - covering only one of them leaks a cursor
   *  pinned to an epoch the delete just retired. */
  presenceService: PresenceService;
};

// Mixed-version compatibility (2026-08-03 sync-widening). REST has no persistent handshake to hang
// a negotiated capability off of the way the WS "hello" message does, so a REST caller declares it
// fresh on every request instead via `?capabilities=extendedBinarySync` - cheap to do since a
// stateless request already restates everything else it needs (auth header, path, etc). Absent
// means false, same safe default as the WS connection capability it mirrors.
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
    const { file, content } = repo.readFileContent(room.id, relativePath);
    return {
      relativePath,
      version: file.version,
      sha256: file.sha256,
      content,
      contentEncoding: contentTypeForPath(relativePath) === "binary" ? "base64" : "utf8"
    };
  });

  app.put("/api/rooms/:roomId/files/content", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const room = requireRoom(repo, (request.params as { roomId: string }).roomId);
    const body = request.body as Partial<{ relativePath: string; baseVersion: number; content: string }>;
    if (!body.relativePath || typeof body.content !== "string") {
      throw new AppError("VALIDATION_ERROR", "This sync request was missing the file path or its contents.", 422);
    }
    const relativePath = normalizeRelativePath(body.relativePath);
    // Every path that normalizes cleanly syncs now (2026-08-03: file-type sync widened to match
    // Obsidian's own vault surface - see isEligiblePath in @vault-rooms/protocol).
    // Legacy write policy (contract 1.4, decided as "reject") - see the identical check in
    // syncServer.ts's file_change branch for the WS equivalent. GET (this route's read sibling)
    // is unaffected: it keeps serving the materialized files/file_versions row CrdtDocManager's
    // debounced materialize keeps fresh, for both CRDT-capable and legacy clients.
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
        contentEncoding,
        updatedBy: { userId: principal.userId, displayName: principal.userDisplayName },
        updatedAt: new Date().toISOString()
      },
      {
        excludeDeviceId: principal.deviceId,
        canReceive: (recipient) =>
          hasRoomPermission({ repo, principal: recipient, room, permission: "file:read", relativePath, aclRules: fileChangeAclRules }),
        // Mixed-version compatibility (2026-08-03 sync-widening) - same gate as syncServer.ts's WS
        // file_change branch: a live WS connection that hasn't advertised extendedBinarySync never
        // receives fanout for a path it wouldn't have understood before the widening, regardless of
        // which transport (REST here, WS there) produced the write.
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
    const result = repo.deleteFile({
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
