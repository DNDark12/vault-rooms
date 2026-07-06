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

  broadcastToRoom(roomId: string, message: SyncServerMessage, options?: { exclude?: SyncConnection; excludeDeviceId?: string }): void {
    for (const connection of this.connections) {
      if (
        connection === options?.exclude ||
        (options?.excludeDeviceId !== undefined && connection.principal?.deviceId === options.excludeDeviceId) ||
        !connection.subscriptions.has(roomId) ||
        connection.socket.readyState !== connection.socket.OPEN
      ) {
        continue;
      }
      sendJson(connection.socket, message);
    }
  }

  closeRevokedUser(teamId: string, userId: string): void {
    for (const connection of this.connections) {
      if (connection.principal?.teamId === teamId && connection.principal.userId === userId) {
        sendJson(connection.socket, { type: "revoked", message: "Your access to this team has been revoked." });
        connection.socket.close();
      }
    }
  }

  closeTeam(teamId: string): void {
    for (const connection of this.connections) {
      if (connection.principal?.teamId === teamId) {
        sendJson(connection.socket, { type: "revoked", message: "This team has been deleted." });
        connection.socket.close();
      }
    }
  }
}

export function sendJson(socket: WebSocket, payload: SyncServerMessage): void {
  socket.send(JSON.stringify(payload));
}
