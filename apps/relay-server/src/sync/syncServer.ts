import type { FastifyInstance } from "fastify";
import { AppError, isEligiblePath, normalizeRelativePath, type SyncClientMessage } from "@vault-rooms/protocol";
import { createId } from "@vault-rooms/protocol";
import type WebSocket from "ws";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import { isActivePrincipal } from "../db/repositories/relayRepository.js";
import { assertRoomPermission } from "../services/policyService.js";
import { ConnectionRegistry, sendJson, type SyncConnection } from "./connectionRegistry.js";

export function registerSyncRoutes(
  app: FastifyInstance,
  repo: RelayRepository,
  registry: ConnectionRegistry,
  options: { maxFileBytes: number }
): void {
  app.get("/sync", { websocket: true }, (socket: WebSocket) => {
    const connection: SyncConnection = {
      id: createId("req"),
      socket,
      principal: null,
      subscriptions: new Set()
    };
    registry.add(connection);

    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.ping();
      }
    }, 30_000);

    socket.on("message", (raw) => {
      void handleMessage(repo, registry, connection, options, raw.toString());
    });
    socket.on("close", () => {
      clearInterval(ping);
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
  });
}

async function handleMessage(
  repo: RelayRepository,
  registry: ConnectionRegistry,
  connection: SyncConnection,
  options: { maxFileBytes: number },
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
    const principal = repo.authenticateDeviceToken(message.token);
    if (!isActivePrincipal(principal)) {
      sendJson(connection.socket, { type: "hello_error", requestId: message.requestId, code: "UNAUTHORIZED" });
      connection.socket.close();
      return;
    }
    connection.principal = principal;
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
    return;
  }

  if (!connection.principal) {
    sendJson(connection.socket, { type: "hello_error", code: "UNAUTHORIZED" });
    connection.socket.close();
    return;
  }

  if (message.type === "subscribe_room") {
    // A previously-mounted room can legitimately no longer exist by the time a client
    // (re)subscribes - e.g. the owner/admin deleted it while this device was offline. Treat
    // that as a normal "room_deleted" notice, not a crash: requireRoom() throws, and letting
    // that escape this handler would become an unhandled rejection (handleMessage runs
    // fire-and-forget from the "message" socket listener).
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
    sendJson(connection.socket, {
      type: "room_snapshot",
      requestId: message.requestId,
      roomId: room.id,
      files: repo.listFiles(room.id).map((file) => ({
        relativePath: file.relative_path,
        version: file.version,
        sha256: file.sha256,
        deleted: Boolean(file.deleted_at)
      }))
    });
    return;
  }

  if (message.type === "file_change") {
    try {
      const room = requireRoom(repo, message.roomId);
      const relativePath = normalizeRelativePath(message.relativePath);
      if (!isEligiblePath(relativePath)) {
        throw new AppError("INVALID_PATH", "This file type isn't supported for sync yet (v0.1 supports Markdown/text/canvas/JSON/CSV plus common image formats and PDF).", 422);
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
        { exclude: connection }
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
      const result = repo.deleteFile({
        roomId: room.id,
        relativePath,
        baseVersion: message.baseVersion,
        actorUserId: connection.principal.userId
      });
      sendJson(connection.socket, {
        type: "file_delete_ack",
        requestId: message.requestId,
        roomId: room.id,
        relativePath,
        version: result.version
      });
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
        { exclude: connection }
      );
    } catch (error) {
      sendRejection(connection.socket, message.requestId, error);
    }
  }
}

function sendRejection(socket: WebSocket, requestId: string, error: unknown): void {
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
