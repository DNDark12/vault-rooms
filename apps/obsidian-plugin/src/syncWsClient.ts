import type { SyncClientMessage, SyncServerMessage } from "@vault-rooms/protocol";
import type { RelayApiClient } from "./apiClient.js";
import type { ServerConnection } from "./settings.js";
import type { MountedRoomState } from "./syncClient.js";
import { VaultSyncEngine } from "./syncClient.js";

export type SyncConnectionState = "connected" | "connecting" | "offline";

export type RoomSyncSocketDeps = {
  getMountedRoom: (roomId: string) => MountedRoomState | undefined;
  getApi: () => RelayApiClient;
  syncEngine: VaultSyncEngine;
  /** Called after any remote change/delete is applied locally, so settings can be saved and views refreshed. */
  onApplied: () => void;
  onRevoked: () => void;
  /** Called when the owner/admin deletes a room that this device has mounted or subscribed to. */
  onRoomDeleted: (roomId: string) => void;
  /** Called when this device's grant to a still-existing room is revoked (e.g. removed from the team that granted it). */
  onAccessRevoked: (roomId: string) => void;
  /** Called whenever the live-sync connection state changes, so the panel can show it. */
  onStateChange?: (state: SyncConnectionState) => void;
};

const MIN_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const HEALTH_PROBE_TIMEOUT_MS = 2500;

/**
 * Keeps a live WebSocket connection to the relay's /sync endpoint so remote edits made by
 * teammates show up locally without the user manually re-mounting the room. Local edits still
 * push over REST (see VaultSyncEngine.pushLocalChange); the relay broadcasts those pushes (from
 * REST or WS) to every other subscribed connection, and this class applies what it receives.
 */
export class RoomSyncSocket {
  private socket: WebSocket | null = null;
  private helloAcked = false;
  private closedByUser = true;
  private reconnectTimer: number | null = null;
  private reconnectDelayMs = MIN_RECONNECT_DELAY_MS;
  private readonly pendingSubscriptions = new Set<string>();
  private readonly subscribedRooms = new Set<string>();
  private state: SyncConnectionState = "offline";

  constructor(
    private readonly server: ServerConnection,
    private readonly deps: RoomSyncSocketDeps
  ) {}

  getState(): SyncConnectionState {
    return this.state;
  }

  private setState(state: SyncConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.deps.onStateChange?.(state);
  }

  connect(): void {
    this.closedByUser = false;
    this.setState("connecting");
    void this.open();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.helloAcked = false;
    this.setState("offline");
  }

  subscribe(roomId: string): void {
    if (this.subscribedRooms.has(roomId)) {
      return;
    }
    if (this.helloAcked) {
      this.send({ type: "subscribe_room", requestId: createRequestId(), roomId });
    } else {
      this.pendingSubscriptions.add(roomId);
    }
  }

  private async open(): Promise<void> {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
    let healthy = false;
    try {
      const response = await fetch(`${this.server.baseUrl.replace(/\/+$/, "")}/health`, { signal: controller.signal });
      healthy = response.ok;
    } catch {
      healthy = false;
    } finally {
      window.clearTimeout(timeoutId);
    }
    if (this.closedByUser) {
      return;
    }
    if (!healthy) {
      this.scheduleReconnect();
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(toWsUrl(this.server.baseUrl));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.send({
        type: "hello",
        requestId: createRequestId(),
        token: this.server.deviceToken,
        client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: this.server.deviceName }
      });
    });
    socket.addEventListener("message", (event) => {
      void this.handleMessage(String(event.data));
    });
    socket.addEventListener("close", () => {
      this.helloAcked = false;
      // Re-queue whatever was subscribed so the next successful hello resubscribes it. Without
      // this, an automatic reconnect (server restart, brief network drop) re-established the
      // socket and said hello, but every room silently stopped getting real-time updates forever
      // after - pendingSubscriptions was already drained from the first connect, and nothing ever
      // refilled it.
      for (const roomId of this.subscribedRooms) {
        this.pendingSubscriptions.add(roomId);
      }
      this.subscribedRooms.clear();
      if (!this.closedByUser) {
        this.setState("connecting");
        this.scheduleReconnect();
      } else {
        this.setState("offline");
      }
    });
    // Connection failures always also fire "close" (per the WebSocket spec), which is what
    // schedules the reconnect above - no need to (and must not) force-close here too, since
    // re-closing an already-failing socket can re-enter this handler synchronously.
    socket.addEventListener("error", () => {});
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) {
      return;
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  }

  private send(message: SyncClientMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: SyncServerMessage;
    try {
      message = JSON.parse(raw) as SyncServerMessage;
    } catch {
      return;
    }

    switch (message.type) {
      case "hello_ok": {
        this.helloAcked = true;
        this.reconnectDelayMs = MIN_RECONNECT_DELAY_MS;
        this.setState("connected");
        for (const roomId of this.pendingSubscriptions) {
          this.send({ type: "subscribe_room", requestId: createRequestId(), roomId });
        }
        this.pendingSubscriptions.clear();
        return;
      }
      case "hello_error":
      case "revoked": {
        this.setState("offline");
        this.deps.onRevoked();
        this.disconnect();
        return;
      }
      case "room_snapshot": {
        this.subscribedRooms.add(message.roomId);
        await this.reconcileSnapshot(message.roomId, message.files);
        return;
      }
      case "remote_file_change": {
        const room = this.deps.getMountedRoom(message.roomId);
        if (!room) {
          return;
        }
        await this.deps.syncEngine.applyRemoteChange(
          room,
          { relativePath: message.relativePath, version: message.version, sha256: message.sha256, content: message.content },
          message.updatedBy.displayName
        );
        this.deps.onApplied();
        return;
      }
      case "remote_file_delete": {
        const room = this.deps.getMountedRoom(message.roomId);
        if (!room) {
          return;
        }
        await this.deps.syncEngine.applyRemoteDelete(room, { relativePath: message.relativePath, version: message.version }, message.deletedBy.displayName);
        this.deps.onApplied();
        return;
      }
      case "room_deleted": {
        this.subscribedRooms.delete(message.roomId);
        this.deps.onRoomDeleted(message.roomId);
        return;
      }
      case "room_access_revoked": {
        this.subscribedRooms.delete(message.roomId);
        this.deps.onAccessRevoked(message.roomId);
        return;
      }
      default:
        return;
    }
  }

  private async reconcileSnapshot(
    roomId: string,
    files: Array<{ relativePath: string; version: number; sha256: string | null; deleted: boolean }>
  ): Promise<void> {
    const room = this.deps.getMountedRoom(roomId);
    if (!room) {
      return;
    }
    const api = this.deps.getApi();
    let changed = false;
    for (const file of files) {
      const local = room.files[file.relativePath];
      if (local?.dirty || local?.localDeleted) {
        // A local edit or delete is pending push; let the normal push/conflict path reconcile
        // this file instead of auto-applying the remote state over it (which would otherwise
        // silently resurrect a file the user just deleted, or clobber an unpushed edit).
        continue;
      }
      if (file.deleted) {
        if (local && local.serverSha256 !== null) {
          await this.deps.syncEngine.applyRemoteDelete(room, { relativePath: file.relativePath, version: file.version }, "sync");
          changed = true;
        }
        continue;
      }
      if (!local || local.serverVersion !== file.version || local.serverSha256 !== file.sha256) {
        const content = await api.readFile(roomId, file.relativePath);
        await this.deps.syncEngine.applyRemoteChange(room, content, "sync");
        changed = true;
      }
    }
    if (changed) {
      this.deps.onApplied();
    }
  }
}

function toWsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/sync`;
}

function createRequestId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
