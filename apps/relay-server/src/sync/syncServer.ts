import type { FastifyInstance } from "fastify";
import { AppError, isCrdtEligiblePath, isEligiblePath, normalizeRelativePath, type SyncClientMessage } from "@vault-rooms/protocol";
import { createId } from "@vault-rooms/protocol";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import type { RoomRow } from "../db/schema.js";
import { requestTransport, type RequestTransport } from "../routes/security.routes.js";
import { authenticateActiveDeviceToken } from "../services/authService.js";
import { assertRoomPermission, hasRoomPermission } from "../services/policyService.js";
import { ConnectionRegistry, sendJson, type SyncConnection, type SyncSocket } from "./connectionRegistry.js";
import type { CrdtDocManager } from "./crdtDocManager.js";

export type SyncTimerHost = {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

export function registerSyncRoutes(
  app: FastifyInstance,
  repo: RelayRepository,
  registry: ConnectionRegistry,
  options: { maxFileBytes: number; maxConnections: number; timerHost: SyncTimerHost; crdtDocManager: CrdtDocManager }
): void {
  app.get("/sync", { websocket: true }, (socket, request) => {
    handleSyncSocket(socket, repo, registry, { ...options, transport: requestTransport(request) });
  });
}

export function handleSyncSocket(
  socket: SyncSocket & {
    on(event: "message", listener: (raw: { toString(): string }) => void): void;
    on(event: "close", listener: () => void): void;
  },
  repo: RelayRepository,
  registry: ConnectionRegistry,
  options: {
    maxFileBytes: number;
    maxConnections: number;
    transport: RequestTransport;
    timerHost: SyncTimerHost;
    crdtDocManager: CrdtDocManager;
  }
): void {
  if (registry.size() >= options.maxConnections) {
    socket.close(1013, "Too many connections");
    return;
  }

  const connection: SyncConnection = {
    id: createId("req"),
    socket,
    principal: null,
    subscriptions: new Set(),
    capabilities: { crdt: false }
  };
  registry.add(connection);

  let helloTimeout: unknown = options.timerHost.setTimeout(() => {
    helloTimeout = undefined;
    if (!connection.principal) {
      socket.close(1008, "Authentication timeout");
    }
  }, 10_000);
  const clearHelloTimeout = (): void => {
    if (helloTimeout !== undefined) {
      options.timerHost.clearTimeout(helloTimeout);
      helloTimeout = undefined;
    }
  };

  const ping = options.timerHost.setInterval(() => {
    if (socket.readyState === socket.OPEN) {
      socket.ping();
    }
  }, 30_000);

  socket.on("message", (raw) => {
    // handleMessage is async and this listener can't await it, so any rejection it produces
    // (a thrown error inside a message-type branch that isn't already caught locally) would
    // otherwise become an unhandled promise rejection - which, running inside the Obsidian
    // plugin's own process, risks taking down more than just this one connection. Every
    // message-type branch below also has its own try/catch for a clean client-facing
    // rejection; this is the last-resort backstop for anything that slips past those.
    handleMessage(repo, registry, connection, { ...options, onAuthenticated: clearHelloTimeout }, raw.toString()).catch((error) => {
      console.error("Vault Rooms relay: unhandled error while processing a sync message", error);
      try {
        connection.socket.close();
      } catch {
        // Socket may already be closed/closing; nothing more to do.
      }
    });
  });
  socket.on("close", () => {
    clearHelloTimeout();
    options.timerHost.clearInterval(ping);
    if (connection.principal) {
      try {
        repo.audit({
          teamId: null,
          actorType: "device",
          actorId: connection.principal.deviceId,
          action: "sync.disconnected",
          resourceType: "device",
          resourceId: connection.principal.deviceId,
          metadata: {}
        });
      } catch {
        // Server may already be shutting down (db closed); disconnect audit is best-effort.
      }
    }
    registry.remove(connection);
  });
}

async function handleMessage(
  repo: RelayRepository,
  registry: ConnectionRegistry,
  connection: SyncConnection,
  options: {
    maxFileBytes: number;
    transport: RequestTransport;
    onAuthenticated: () => void;
    crdtDocManager: CrdtDocManager;
  },
  raw: string
): Promise<void> {
  let message: SyncClientMessage;
  try {
    message = JSON.parse(raw) as SyncClientMessage;
  } catch {
    connection.socket.close();
    return;
  }

  if (message.type === "hello") {
    try {
      const principal = authenticateActiveDeviceToken(repo, message.token);
      repo.markDeviceTransport(principal.deviceId, options.transport);
      connection.principal = principal;
      connection.capabilities = { crdt: Boolean(message.capabilities?.crdt) };
      options.onAuthenticated();
      repo.audit({
        teamId: null,
        actorType: "device",
        actorId: principal.deviceId,
        action: "sync.connected",
        resourceType: "device",
        resourceId: principal.deviceId,
        metadata: { client: message.client }
      });
      sendJson(connection.socket, {
        type: "hello_ok",
        requestId: message.requestId,
        userId: principal.userId,
        deviceId: principal.deviceId
      });
    } catch {
      // A malformed/missing token, or any other unexpected failure - treat it the same as an
      // invalid one rather than letting it become an unhandled rejection.
      sendJson(connection.socket, { type: "hello_error", requestId: message.requestId, code: "UNAUTHORIZED" });
      connection.socket.close();
    }
    return;
  }

  if (!connection.principal) {
    sendJson(connection.socket, { type: "hello_error", code: "UNAUTHORIZED" });
    connection.socket.close();
    return;
  }

  if (message.type === "subscribe_room") {
    try {
      // A previously-mounted room can legitimately no longer exist by the time a client
      // (re)subscribes - e.g. the owner/admin deleted it while this device was offline. Treat
      // that as a normal "room_deleted" notice, not a crash.
      const room = repo.getRoom(message.roomId);
      if (!room) {
        sendJson(connection.socket, { type: "room_deleted", roomId: message.roomId });
        return;
      }
      try {
        assertRoomPermission({ repo, principal: connection.principal, room, permission: "sync:subscribe" });
      } catch {
        repo.audit({
          teamId: null,
          actorType: "device",
          actorId: connection.principal.deviceId,
          action: "sync.denied",
          resourceType: "room",
          resourceId: room.id,
          metadata: { permission: "sync:subscribe" }
        });
        sendJson(connection.socket, {
          type: "file_change_rejected",
          requestId: message.requestId,
          code: "PERMISSION_DENIED",
          message: "You do not have permission to subscribe to this room."
        });
        return;
      }
      connection.subscriptions.add(room.id);
      const snapshotAclRules = repo.listAclRulesForRoom(room.id);
      sendJson(connection.socket, {
        type: "room_snapshot",
        requestId: message.requestId,
        roomId: room.id,
        files: repo
          .listFiles(room.id)
          .filter((file) =>
            hasRoomPermission({
              repo,
              principal: connection.principal!,
              room,
              permission: "file:read",
              relativePath: file.relative_path,
              aclRules: snapshotAclRules
            })
          )
          .map((file) => ({
            relativePath: file.relative_path,
            version: file.version,
            sha256: file.sha256,
            deleted: Boolean(file.deleted_at),
            // Contract 1.11: only advertise a CRDT epoch for paths actually eligible for the CRDT
            // lane in a room that has opted in - otherwise omit the field entirely (not 0/null)
            // so an older client's type narrowing on "crdtEpoch in file" keeps working unchanged.
            ...(room.crdt_enabled && isCrdtEligiblePath(file.relative_path) ? { crdtEpoch: file.crdt_epoch } : {})
          }))
      });
    } catch (error) {
      sendRejection(connection.socket, message.requestId, error);
    }
    return;
  }

  if (message.type === "file_change") {
    try {
      const room = requireRoom(repo, message.roomId);
      const relativePath = normalizeRelativePath(message.relativePath);
      if (!isEligiblePath(relativePath)) {
        throw new AppError("INVALID_PATH", "This file type isn't supported for sync yet (supported: Markdown/text/canvas/JSON/CSV, common image formats, and PDF).", 422);
      }
      // Legacy write policy (contract 1.4, decided as "reject"): a room that has opted into CRDT
      // sync for this path no longer accepts whole-file writes through the CAS lane - the client
      // must use the crdt_* message types (or upgrade to a build that speaks them) instead. Reads
      // (file_change is never sent for a read) keep working unaffected via the materialized
      // files/file_versions rows CrdtDocManager's debounced materialize keeps fresh.
      if (room.crdt_enabled && isCrdtEligiblePath(relativePath)) {
        throw new AppError(
          "CRDT_WRITE_UNSUPPORTED",
          "This room has CRDT sync enabled for this file - use the CRDT sync message types (or upgrade) instead of a whole-file write.",
          409
        );
      }
      if (Buffer.byteLength(message.content, "utf8") > options.maxFileBytes) {
        throw new AppError("FILE_TOO_LARGE", "The file exceeds MAX_FILE_BYTES.", 413);
      }
      assertRoomPermission({ repo, principal: connection.principal, room, permission: "sync:push", relativePath });
      assertRoomPermission({
        repo,
        principal: connection.principal,
        room,
        permission: message.baseVersion === 0 ? "file:create" : "file:write",
        relativePath
      });
      const result = repo.writeFile({
        roomId: room.id,
        relativePath,
        baseVersion: message.baseVersion,
        content: message.content,
        actorUserId: connection.principal.userId
      });
      sendJson(connection.socket, {
        type: "file_change_ack",
        requestId: message.requestId,
        roomId: room.id,
        relativePath,
        version: result.version,
        sha256: result.sha256
      });
      const fileChangeAclRules = repo.listAclRulesForRoom(room.id);
      registry.broadcastToRoom(
        room.id,
        {
          type: "remote_file_change",
          roomId: room.id,
          relativePath,
          version: result.version,
          sha256: result.sha256,
          content: message.content,
          updatedBy: { userId: connection.principal.userId, displayName: connection.principal.userDisplayName },
          updatedAt: new Date().toISOString()
        },
        {
          exclude: connection,
          canReceive: (principal) =>
            hasRoomPermission({ repo, principal, room, permission: "file:read", relativePath, aclRules: fileChangeAclRules })
        }
      );
    } catch (error) {
      sendRejection(connection.socket, message.requestId, error);
    }
    return;
  }

  if (message.type === "file_delete") {
    try {
      const room = requireRoom(repo, message.roomId);
      const relativePath = normalizeRelativePath(message.relativePath);
      assertRoomPermission({ repo, principal: connection.principal, room, permission: "sync:push", relativePath });
      assertRoomPermission({ repo, principal: connection.principal, room, permission: "file:delete", relativePath });
      // Contract 1.5: deleteFile() already bumps files.crdt_epoch and purges the old epoch's
      // durable CRDT rows in the same transaction - but that leaves CrdtDocManager's in-memory
      // cache entry (if any) for the now-defunct epoch dangling until idle/LRU eviction notices.
      // Evict it immediately: harmless no-op for a file that never had a CRDT document, and closes
      // the loop on "destructive cleanup" covering in-memory state, not just durable rows.
      const beforeDelete = repo.getFile(room.id, relativePath);
      const result = repo.deleteFile({
        roomId: room.id,
        relativePath,
        baseVersion: message.baseVersion,
        actorUserId: connection.principal.userId
      });
      if (beforeDelete) {
        options.crdtDocManager.evictDocument(beforeDelete.id, beforeDelete.crdt_epoch);
      }
      sendJson(connection.socket, {
        type: "file_delete_ack",
        requestId: message.requestId,
        roomId: room.id,
        relativePath,
        version: result.version
      });
      const fileDeleteAclRules = repo.listAclRulesForRoom(room.id);
      registry.broadcastToRoom(
        room.id,
        {
          type: "remote_file_delete",
          roomId: room.id,
          relativePath,
          version: result.version,
          deletedBy: { userId: connection.principal.userId, displayName: connection.principal.userDisplayName },
          deletedAt: new Date().toISOString()
        },
        {
          exclude: connection,
          canReceive: (principal) =>
            hasRoomPermission({ repo, principal, room, permission: "file:read", relativePath, aclRules: fileDeleteAclRules })
        }
      );
    } catch (error) {
      sendRejection(connection.socket, message.requestId, error);
    }
    return;
  }

  // --- CRDT sync (docs/superpowers/plans/2026-07-20-crdt-sync.md Phase 4, contracts 1.2/1.3/
  // 1.7/1.8/1.9/1.10). Every branch below requires the sender to have advertised
  // capabilities.crdt on `hello` - a legacy build has no business initiating any of these. ---

  if (message.type === "crdt_create") {
    const roomId = message.roomId;
    const relativePath = message.relativePath;
    try {
      const room = requireRoom(repo, roomId);
      const normalizedPath = requireCrdtTarget(room, relativePath);
      requireCrdtCapability(connection);
      assertRoomPermission({ repo, principal: connection.principal, room, permission: "sync:push", relativePath: normalizedPath });
      assertRoomPermission({ repo, principal: connection.principal, room, permission: "file:create", relativePath: normalizedPath });
      const createdBy = { userId: connection.principal.userId, displayName: connection.principal.userDisplayName };
      const created = repo.createCrdtFile({ roomId: room.id, relativePath: normalizedPath, actorUserId: connection.principal.userId });
      options.crdtDocManager.createDocument(created.fileId, created.epoch, createdBy);
      sendJson(connection.socket, {
        type: "crdt_created",
        requestId: message.requestId,
        roomId: room.id,
        relativePath: normalizedPath,
        documentId: created.fileId,
        epoch: created.epoch
      });
    } catch (error) {
      sendCrdtRejection(connection.socket, message.requestId, roomId, relativePath, error);
    }
    return;
  }

  // Atomic rename (fourth hardware-testing round, 2026-07-23) - replaces the old client-side
  // delete-old+create-new translation, which discarded the file's id/epoch/history and left a
  // multi-second, uncorrelated gap on every OTHER subscriber's device between "old file gone" and
  // "new file appears" (see docs/superpowers/plans/2026-07-20-crdt-sync.md's fourth hardware-
  // testing round, item 3). `repo.renameFile` only updates `relative_path` - `CrdtDocManager`
  // caches by `(fileId, epoch)`, never by path (see crdtDocManager.ts's `key()`), so neither the
  // in-memory doc cache nor any pending materialize timer needs touching here at all.
  if (message.type === "crdt_rename") {
    const roomId = message.roomId;
    const relativePath = message.relativePath;
    try {
      const room = requireRoom(repo, roomId);
      const normalizedOldPath = requireCrdtTarget(room, message.oldRelativePath);
      const normalizedNewPath = requireCrdtTarget(room, relativePath);
      requireCrdtCapability(connection);
      assertRoomPermission({ repo, principal: connection.principal, room, permission: "sync:push", relativePath: normalizedOldPath });
      // Mirrors exactly the two permissions the old delete+create translation required - a rename
      // grants no capability beyond what was already achievable via that slower path.
      assertRoomPermission({ repo, principal: connection.principal, room, permission: "file:delete", relativePath: normalizedOldPath });
      assertRoomPermission({ repo, principal: connection.principal, room, permission: "file:create", relativePath: normalizedNewPath });
      const renamedBy = { userId: connection.principal.userId, displayName: connection.principal.userDisplayName };
      const result = repo.renameFile({
        roomId: room.id,
        oldRelativePath: normalizedOldPath,
        relativePath: normalizedNewPath,
        actorUserId: connection.principal.userId
      });
      sendJson(connection.socket, {
        type: "crdt_renamed",
        requestId: message.requestId,
        roomId: room.id,
        oldRelativePath: result.oldRelativePath,
        relativePath: result.relativePath,
        epoch: result.epoch
      });
      const renameAclRules = repo.listAclRulesForRoom(room.id);
      registry.broadcastToRoom(
        room.id,
        {
          type: "remote_crdt_rename",
          roomId: room.id,
          oldRelativePath: result.oldRelativePath,
          relativePath: result.relativePath,
          epoch: result.epoch,
          renamedBy
        },
        {
          exclude: connection,
          canReceive: (principal) =>
            hasRoomPermission({ repo, principal, room, permission: "file:read", relativePath: normalizedNewPath, aclRules: renameAclRules })
        }
      );
    } catch (error) {
      sendCrdtRejection(connection.socket, message.requestId, roomId, relativePath, error);
    }
    return;
  }

  if (message.type === "crdt_sync_step1") {
    const roomId = message.roomId;
    const relativePath = message.relativePath;
    try {
      const room = requireRoom(repo, roomId);
      const normalizedPath = requireCrdtTarget(room, relativePath);
      requireCrdtCapability(connection);
      if (!connection.subscriptions.has(room.id)) {
        throw new AppError("PERMISSION_DENIED", "Subscribe to the room before requesting a CRDT handshake.", 403);
      }
      assertRoomPermission({ repo, principal: connection.principal, room, permission: "sync:subscribe" });
      assertRoomPermission({ repo, principal: connection.principal, room, permission: "file:read", relativePath: normalizedPath });
      const file = repo.getFile(room.id, normalizedPath);
      if (!file || file.deleted_at) {
        throw new AppError("NOT_FOUND", "No CRDT document exists at this path yet - send crdt_create first.", 404);
      }
      if (message.epoch !== file.crdt_epoch) {
        throw new AppError("CRDT_STALE_EPOCH", "This document has moved to a new epoch.", 409, { currentEpoch: file.crdt_epoch });
      }
      // Answer the client's step1 with the diff it's missing, and independently ask the client
      // for whatever the server itself is missing (contract 1.3) - this second message is the
      // half of the handshake that recovers a local edit the client made but never got to send
      // before a prior disconnect.
      const diffUpdate = options.crdtDocManager.getDiffUpdateBase64(file.id, file.crdt_epoch, message.stateVector);
      sendJson(connection.socket, {
        type: "crdt_sync_step2",
        requestId: message.requestId,
        roomId: room.id,
        relativePath: normalizedPath,
        epoch: file.crdt_epoch,
        update: diffUpdate
      });
      const serverStateVector = options.crdtDocManager.getStateVectorBase64(file.id, file.crdt_epoch);
      sendJson(connection.socket, {
        type: "crdt_sync_step1",
        roomId: room.id,
        relativePath: normalizedPath,
        epoch: file.crdt_epoch,
        stateVector: serverStateVector
      });
    } catch (error) {
      sendCrdtRejection(connection.socket, message.requestId, roomId, relativePath, error);
    }
    return;
  }

  if (message.type === "crdt_sync_step2" || message.type === "crdt_update") {
    const roomId = message.roomId;
    const relativePath = message.relativePath;
    try {
      const room = requireRoom(repo, roomId);
      const normalizedPath = requireCrdtTarget(room, relativePath);
      requireCrdtCapability(connection);
      // Both message types carry a document update and get identical write-path checks (contract
      // 1.8: crdt_sync_step2 is a write message, not a read, even though it's the client's *reply*
      // to a server-initiated read-shaped step1 - y-protocols' read-only enforcement principle,
      // applied to our own envelope).
      assertRoomPermission({ repo, principal: connection.principal, room, permission: "sync:push", relativePath: normalizedPath });
      assertRoomPermission({ repo, principal: connection.principal, room, permission: "file:write", relativePath: normalizedPath });
      const file = repo.getFile(room.id, normalizedPath);
      if (!file || file.deleted_at) {
        throw new AppError("NOT_FOUND", "No CRDT document exists at this path yet - send crdt_create first.", 404);
      }
      if (message.epoch !== file.crdt_epoch) {
        throw new AppError("CRDT_STALE_EPOCH", "This document has moved to a new epoch.", 409, { currentEpoch: file.crdt_epoch });
      }
      const updatedBy = { userId: connection.principal.userId, displayName: connection.principal.userDisplayName };
      options.crdtDocManager.applyUpdate(file.id, file.crdt_epoch, message.update, updatedBy);
      // No ack for either message type (contract 1.3: no server-assigned update sequence/ack in
      // v1) - fan out to CRDT-capable peers now that the update has durably landed. The materialized
      // remote_file_change substitute for legacy/non-CRDT-capable peers is driven separately, from
      // CrdtDocManager's debounced materialize callback, not from every individual update.
      const aclRules = repo.listAclRulesForRoom(room.id);
      registry.broadcastToRoom(
        room.id,
        {
          type: "remote_crdt_update",
          roomId: room.id,
          relativePath: normalizedPath,
          epoch: file.crdt_epoch,
          update: message.update,
          updatedBy
        },
        {
          exclude: connection,
          canReceive: (principal) =>
            hasRoomPermission({ repo, principal, room, permission: "file:read", relativePath: normalizedPath, aclRules }),
          connectionFilter: (candidate) => candidate.capabilities.crdt
        }
      );
    } catch (error) {
      sendCrdtRejection(connection.socket, message.requestId, roomId, relativePath, error);
    }
    return;
  }
}

/** Contract 1.1/1.11: the room must have opted into CRDT and the path must be CRDT-eligible
 *  (`.md` only) - every CRDT message type is rejected outright otherwise. Returns the normalized
 *  path on success so callers don't have to normalize twice. */
function requireCrdtTarget(room: RoomRow, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  if (!room.crdt_enabled) {
    throw new AppError("CRDT_DISABLED", "This room has not enabled CRDT sync.", 409);
  }
  if (!isCrdtEligiblePath(normalized)) {
    throw new AppError("INVALID_PATH", "Only Markdown (.md) files use the CRDT sync lane.", 422);
  }
  return normalized;
}

/** Contract 1.2: a connection must have advertised `capabilities.crdt` on `hello` before it can
 *  use any CRDT-lane message type - absent/false means "no CRDT support", never assumed true. */
function requireCrdtCapability(connection: SyncConnection): void {
  if (!connection.capabilities.crdt) {
    throw new AppError("CRDT_CAPABILITY_REQUIRED", "This connection did not advertise CRDT support on hello.", 409);
  }
}

function sendCrdtRejection(socket: SyncSocket, requestId: string | undefined, roomId: string, relativePath: string, error: unknown): void {
  if (error instanceof AppError) {
    const details = error.details as Record<string, unknown> | undefined;
    sendJson(socket, {
      type: "crdt_rejected",
      requestId,
      roomId,
      relativePath,
      code: error.code,
      message: error.message,
      ...(details?.currentEpoch !== undefined ? { currentEpoch: details.currentEpoch as number } : {})
    });
    return;
  }
  sendJson(socket, {
    type: "crdt_rejected",
    requestId,
    roomId,
    relativePath,
    code: "VALIDATION_ERROR",
    message: "CRDT message could not be applied."
  });
}

function sendRejection(socket: SyncSocket, requestId: string, error: unknown): void {
  if (error instanceof AppError) {
    const details = error.details as Record<string, unknown> | undefined;
    sendJson(socket, {
      type: "file_change_rejected",
      requestId,
      code: error.code,
      message: error.message,
      ...(details?.serverVersion ? { serverVersion: details.serverVersion as number } : {}),
      ...(details?.serverSha256 !== undefined ? { serverSha256: details.serverSha256 as string | null } : {}),
      ...(details?.serverContent ? { serverContent: details.serverContent as string } : {})
    });
    return;
  }
  sendJson(socket, {
    type: "file_change_rejected",
    requestId,
    code: "VALIDATION_ERROR",
    message: "Sync message could not be applied."
  });
}

function requireRoom(repo: RelayRepository, roomId: string) {
  const room = repo.getRoom(roomId);
  if (!room) {
    throw new AppError("NOT_FOUND", "Room not found.", 404);
  }
  return room;
}
