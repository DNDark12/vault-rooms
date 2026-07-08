import type WebSocket from "ws";
import type { SyncServerMessage } from "@vault-rooms/protocol";
import type { DevicePrincipal } from "../db/repositories/relayRepository.js";

export type SyncConnection = {
  id: string;
  socket: WebSocket;
  principal: DevicePrincipal | null;
  subscriptions: Set<string>;
};

export class ConnectionRegistry {
  private readonly connections = new Set<SyncConnection>();

  add(connection: SyncConnection): void {
    this.connections.add(connection);
  }

  remove(connection: SyncConnection): void {
    this.connections.delete(connection);
  }

  size(): number {
    return this.connections.size;
  }

  broadcastToRoom(
    roomId: string,
    message: SyncServerMessage,
    options?: {
      exclude?: SyncConnection;
      excludeDeviceId?: string;
      // Per-recipient authorization gate (e.g. a path-scoped file:read check). A recipient for
      // whom this returns false is silently skipped - not closed, not sent a rejection - since
      // that message type is meant for the acting device, not passive observers. When omitted,
      // every room subscriber receives the message (existing behavior for room-level events).
      canReceive?: (principal: DevicePrincipal) => boolean;
    }
  ): void {
    for (const connection of this.connections) {
      if (
        connection === options?.exclude ||
        (options?.excludeDeviceId !== undefined && connection.principal?.deviceId === options.excludeDeviceId) ||
        !connection.subscriptions.has(roomId) ||
        connection.socket.readyState !== connection.socket.OPEN ||
        (options?.canReceive !== undefined && (!connection.principal || !options.canReceive(connection.principal)))
      ) {
        continue;
      }
      sendJson(connection.socket, message);
    }
  }

  revalidateAccess(isStillAllowed: (roomId: string, principal: DevicePrincipal) => boolean): void {
    for (const connection of this.connections) {
      if (!connection.principal) continue;
      for (const roomId of connection.subscriptions) {
        if (isStillAllowed(roomId, connection.principal)) continue;
        connection.subscriptions.delete(roomId);
        if (connection.socket.readyState === connection.socket.OPEN) {
          sendJson(connection.socket, { type: "room_access_revoked", roomId });
        }
      }
    }
  }

  closeRevokedUser(userId: string): void {
    for (const connection of this.connections) {
      if (connection.principal?.userId === userId) {
        sendJson(connection.socket, { type: "revoked", message: "Your access to this server has been revoked." });
        connection.socket.close();
      }
    }
  }

  closeRevokedDevice(deviceId: string): void {
    for (const connection of this.connections) {
      if (connection.principal?.deviceId === deviceId) {
        sendJson(connection.socket, { type: "revoked", message: "Your access to this server has been revoked." });
        connection.socket.close();
      }
    }
  }
}

export function sendJson(socket: WebSocket, payload: SyncServerMessage): void {
  socket.send(JSON.stringify(payload));
}
