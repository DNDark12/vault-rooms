import type { SyncServerMessage } from "@vault-rooms/protocol";
import type { DevicePrincipal } from "../db/repositories/relayRepository.js";

export type SyncSocket = {
  readonly OPEN: number;
  readonly readyState: number;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  ping(): void;
};

export type SyncConnection = {
  id: string;
  socket: SyncSocket;
  principal: DevicePrincipal | null;
  subscriptions: Set<string>;
  // Capability negotiation (docs/superpowers/plans/2026-07-20-crdt-sync.md contract 1.2). Defaults
  // to { crdt: false, presence: false } until a "hello" advertising them is processed - absent/older
  // clients never advertise support, so fanout branching in later phases can trust this
  // rather than re-deriving it from message.client.version.
  //
  // `presence` (live cursors, docs/superpowers/specs/2026-07-28-live-cursors-design.md) is clamped
  // to false unless `crdt` is also true: presence is scoped to live CRDT documents, so there is
  // nothing for a whole-file-lane connection to attach a caret to.
  //
  // `extendedBinarySync` (2026-08-03 sync-widening) - defaults to false until a "hello" advertises
  // it, same as crdt/presence. Gates room_snapshot's file list and remote_file_change's fanout (see
  // syncServer.ts) so a connection that hasn't advertised it never learns a legacy-ineligible path
  // (@vault-rooms/protocol's isLegacyEligiblePath) exists in the room at all - the same
  // invisible-unless-you-opt-in treatment CRDT already gets from older clients, and for the same
  // reason: a client that doesn't understand the new default-to-binary rule would silently corrupt
  // such a file on disk rather than merely fail to sync it.
  capabilities: { crdt: boolean; presence: boolean; extendedBinarySync: boolean };
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
      // Connection-level filter (docs/superpowers/plans/2026-07-20-crdt-sync.md contract 1.2) -
      // distinct from canReceive, which only sees the ACL-relevant DevicePrincipal. This exists so
      // the CRDT lane can partition a room's subscribers into "gets remote_crdt_update" vs "gets
      // the materialized remote_file_change instead" by capability, without threading connection
      // internals through the ACL-focused canReceive predicate.
      connectionFilter?: (connection: SyncConnection) => boolean;
    }
  ): void {
    for (const connection of this.connections) {
      if (
        connection === options?.exclude ||
        (options?.excludeDeviceId !== undefined && connection.principal?.deviceId === options.excludeDeviceId) ||
        !connection.subscriptions.has(roomId) ||
        connection.socket.readyState !== connection.socket.OPEN ||
        (options?.canReceive !== undefined && (!connection.principal || !options.canReceive(connection.principal))) ||
        (options?.connectionFilter !== undefined && !options.connectionFilter(connection))
      ) {
        continue;
      }
      // One recipient's failing socket must not silently truncate delivery to everyone after it in
      // this loop. Presence made this materially more likely (fanout runs at caret-movement
      // frequency), but the hazard predates it and applies to every broadcast. Deliberately does not
      // close the socket - its own error/close lifecycle stays canonical and owns cleanup.
      try {
        sendJson(connection.socket, message);
      } catch (error) {
        console.warn("Vault Rooms relay: could not deliver a room broadcast", error);
      }
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

  closeDeviceConnections(deviceId: string, reason: "credentials_rotated"): void {
    for (const connection of this.connections) {
      if (connection.principal?.deviceId === deviceId) {
        connection.socket.close(4001, reason);
      }
    }
  }

  closeLegacyPlainTokenConnections(): void {
    for (const connection of this.connections) {
      if (connection.principal?.tokenSecurity === "plain") {
        connection.socket.close(4002, "tls_enforced");
      }
    }
  }

  broadcastAuthenticated(message: SyncServerMessage): void {
    for (const connection of this.connections) {
      if (connection.principal && connection.socket.readyState === connection.socket.OPEN) {
        sendJson(connection.socket, message);
      }
    }
  }
}

export function sendJson(socket: SyncSocket, payload: SyncServerMessage): void {
  socket.send(JSON.stringify(payload));
}
