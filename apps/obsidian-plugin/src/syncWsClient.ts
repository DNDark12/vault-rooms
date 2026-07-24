import { PRODUCT_VERSION, type SyncClientMessage, type SyncServerMessage } from "@vault-rooms/protocol";
import { WebSocket as NodeWebSocket } from "ws";
import { requestUrlWithTimeout, type RelayApiClient } from "./apiClient.js";
import type { CrdtWsBridge } from "./crdtSession.js";
import {
  assertPinMaterial,
  InvalidPinMaterialError,
  pinnedRequest,
  type PinnedServerInfo
} from "./pinnedTransport.js";
import { certDerBase64UrlToPem } from "vault-rooms-relay/embedded-core";
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
  onSecurityUpgradeAvailable?: () => void;
  onPinnedTransportFailure?: (error: Error) => Promise<"retry" | "normal" | "stop">;
  onHelloOk?: () => void;
  /** Called when the server pushes a live CRDT room-mode toggle (contract 1.11) for a room. Lets
   *  the caller mirror the new `crdtEnabled` flag onto persisted `MountedRoomState`/`visibleRooms`
   *  immediately, rather than waiting on the follow-up snapshot re-subscribe below to eventually
   *  reflect it via a full `refreshRooms()` round trip - see `resolveRoomCrdtEnabled` and CLAUDE.md's
   *  post-hardware-testing audit notes. Optional so a socket used purely for tests/diagnostics
   *  doesn't need one wired up. */
  onRoomModeChanged?: (roomId: string, crdtEnabled: boolean) => void;
  /** CRDT message-lane bridge (docs/superpowers/plans/2026-07-20-crdt-sync.md Phase 5) - handles
   *  every CRDT-lane server message (crdt_created, crdt_rejected, crdt_sync_step1/step2,
   *  remote_crdt_update) and re-runs the bidirectional handshake for live sessions on (re)connect
   *  (contract 1.3, blocker 1: outbound recovery). Optional so a socket used purely for
   *  tests/diagnostics doesn't need one wired up. */
  crdt?: CrdtWsBridge;
};

const MIN_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const HEALTH_PROBE_TIMEOUT_MS = 2500;
const HELLO_ACK_TIMEOUT_MS = 10_000;

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
  private helloAckTimer: number | null = null;
  private reconnectDelayMs = MIN_RECONNECT_DELAY_MS;
  private readonly desiredSubscriptions = new Set<string>();
  private socketGeneration = 0;
  private remoteApplyChain: Promise<void> = Promise.resolve();
  private state: SyncConnectionState = "offline";
  private handlingPinnedFailure = false;
  private upgradeProbeRequested = false;

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
    this.socketGeneration += 1;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHelloAckTimer();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.helloAcked = false;
    this.upgradeProbeRequested = false;
    this.setState("offline");
  }

  subscribe(roomId: string): void {
    if (this.desiredSubscriptions.has(roomId)) {
      return;
    }
    this.desiredSubscriptions.add(roomId);
    if (this.helloAcked) {
      this.send({ type: "subscribe_room", requestId: createRequestId(), roomId });
    }
  }

  private async open(): Promise<void> {
    const generation = ++this.socketGeneration;
    this.clearHelloAckTimer();
    const previousSocket = this.socket;
    this.socket = null;
    previousSocket?.close();
    try {
      const healthUrl = `${this.server.baseUrl.replace(/\/+$/, "")}/health`;
      const pinned = pinnedInfoForServer(this.server);
      const response = pinned
        ? await pinnedRequest(pinned, { url: healthUrl, timeoutMs: HEALTH_PROBE_TIMEOUT_MS })
        : await requestUrlWithTimeout({ url: healthUrl, throw: false }, HEALTH_PROBE_TIMEOUT_MS);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Health probe failed with status ${response.status}.`);
      }
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) {
        return;
      }
      if (this.server.securityMode === "pinned-tls" && this.deps.onPinnedTransportFailure) {
        const decision = await this.deps.onPinnedTransportFailure(toError(error));
        if (!this.isCurrentGeneration(generation)) return;
        if (decision === "stop") {
          this.closedByUser = true;
          this.setState("offline");
          return;
        }
        if (decision === "retry") {
          void this.open();
          return;
        }
      }
      this.scheduleReconnect();
      return;
    }
    if (!this.isCurrentGeneration(generation)) {
      return;
    }

    let socket: WebSocket;
    try {
      socket = openSyncSocket(this.server);
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (!this.isCurrentGeneration(generation)) {
      socket.close();
      return;
    }
    this.socket = socket;
    let messageChain: Promise<void> = Promise.resolve();
    socket.addEventListener("open", () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.send({
        type: "hello",
        requestId: createRequestId(),
        token: this.server.deviceToken,
        client: { kind: "obsidian-plugin", version: PRODUCT_VERSION, deviceName: this.server.deviceName },
        // Contract 1.2: this build always speaks the CRDT lane. A room that hasn't opted into
        // crdtEnabled simply never receives any crdt_*/remote_crdt_update message regardless of
        // what a connection advertises here - advertising true is safe and unconditional.
        capabilities: { crdt: true }
      });
      this.clearHelloAckTimer();
      this.helloAckTimer = window.setTimeout(() => {
        if (this.isCurrentSocket(socket, generation) && !this.helloAcked) {
          socket.close();
        }
      }, HELLO_ACK_TIMEOUT_MS);
    });
    socket.addEventListener("message", (event) => {
      if (!this.isCurrentSocket(socket, generation)) return;
      messageChain = messageChain
        .then(async () => {
          if (this.isCurrentSocket(socket, generation)) {
            await this.handleMessage(String(event.data));
          }
        })
        .catch((error: unknown) => {
          console.error("Vault Rooms: failed to process a live sync message", toError(error));
        });
    });
    socket.addEventListener("close", (event) => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.clearHelloAckTimer();
      this.socket = null;
      this.helloAcked = false;
      this.upgradeProbeRequested = false;
      const code = (event as CloseEvent | undefined)?.code;
      if (code === 4001 || code === 4002) {
        // The server deliberately invalidated this credential. The workflow that caused the
        // rotation/enforcement owns the next connection; retrying this socket would authenticate
        // with the now-invalid token and falsely classify the device as revoked.
        this.closedByUser = true;
        this.setState("offline");
        return;
      }
      if (this.handlingPinnedFailure) {
        return;
      }
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
    socket.addEventListener("error", (event) => {
      if (
        !this.isCurrentSocket(socket, generation) ||
        this.server.securityMode !== "pinned-tls" ||
        !this.deps.onPinnedTransportFailure ||
        this.handlingPinnedFailure
      ) {
        return;
      }
      this.handlingPinnedFailure = true;
      const eventError: unknown = "error" in event ? (event as { error?: unknown }).error : undefined;
      const error = event instanceof Error ? event : eventError instanceof Error ? eventError : new Error("Pinned WebSocket connection failed.");
      void this.deps.onPinnedTransportFailure(error).then(
        (decision) => {
          this.handlingPinnedFailure = false;
          // A failed WebSocket normally emits close before this async classification resolves.
          // The close handler clears this.socket while deliberately deferring reconnect here, so
          // generation ownership—not socket field identity—is the correct stale-result guard.
          if (!this.isCurrentGeneration(generation)) return;
          if (decision === "stop") {
            this.closedByUser = true;
            this.socket = null;
            this.clearHelloAckTimer();
            this.setState("offline");
          } else if (decision === "retry") {
            void this.open();
          } else {
            this.scheduleReconnect();
          }
        },
        () => {
          this.handlingPinnedFailure = false;
          if (this.isCurrentGeneration(generation)) this.scheduleReconnect();
        }
      );
    });
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
    if (this.socket && this.socket.readyState === NodeWebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.closedByUser && generation === this.socketGeneration;
  }

  private isCurrentSocket(socket: WebSocket, generation: number): boolean {
    return this.isCurrentGeneration(generation) && this.socket === socket;
  }

  private clearHelloAckTimer(): void {
    if (this.helloAckTimer !== null) {
      window.clearTimeout(this.helloAckTimer);
      this.helloAckTimer = null;
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
        this.clearHelloAckTimer();
        this.helloAcked = true;
        this.reconnectDelayMs = MIN_RECONNECT_DELAY_MS;
        this.setState("connected");
        this.deps.onHelloOk?.();
        if (this.server.securityMode === "plain" && !this.upgradeProbeRequested) {
          this.upgradeProbeRequested = true;
          this.deps.onSecurityUpgradeAvailable?.();
        }
        for (const roomId of this.desiredSubscriptions) {
          this.send({ type: "subscribe_room", requestId: createRequestId(), roomId });
        }
        // Contract 1.3/blocker 1: re-run the bidirectional handshake for every live CRDT session on
        // (re)connect - this is what recovers a local edit made while this socket was offline (the
        // server's reply to this re-sent step1 is what will ask the client for its missing update).
        this.deps.crdt?.onConnected();
        return;
      }
      case "security_upgrade_available": {
        this.upgradeProbeRequested = true;
        this.deps.onSecurityUpgradeAvailable?.();
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
        // Contract 1.11: feed per-file crdtEpoch entries to the CRDT bridge before the CAS-lane
        // reconciliation below - independent concerns over the same message, same as how a CRDT-
        // eligible file's entry still also participates in ordinary CAS-lane bookkeeping until a
        // session actually opens for it.
        this.deps.crdt?.handleRoomSnapshot(message.roomId, message.files);
        await this.enqueueRemoteApply(() => this.reconcileSnapshot(message.roomId, message.files));
        return;
      }
      case "remote_file_change": {
        await this.enqueueRemoteApply(async () => {
          const room = this.deps.getMountedRoom(message.roomId);
          if (!room) return;
          // Second-hardware-testing-round item 1: the relay now sends this materialized broadcast
          // to every subscriber with file:read (CRDT-capable or not - see relayCore.ts's
          // createCrdtMaterializedHandler), since a CRDT-capable device with no open session for
          // this exact path would otherwise never learn about the change at all (remote_crdt_update
          // is silently dropped by crdtSession.ts when no session exists). If a CRDT session IS
          // already open for this path, that lane already owns it live - applying this coarser
          // snapshot on top could clobber in-flight editor state, so skip it here. isSessionOpen
          // always returns false for a path that was never a CRDT target (or when there's no CRDT
          // bridge at all, e.g. a non-CRDT room), so this is a no-op change for the ordinary CAS-lane
          // case - every relative_path gets applied exactly as before.
          if (this.deps.crdt?.isSessionOpen(message.roomId, message.relativePath)) {
            return;
          }
          await this.deps.syncEngine.applyRemoteChange(
            room,
            { relativePath: message.relativePath, version: message.version, sha256: message.sha256, content: message.content },
            message.updatedBy.displayName
          );
          this.deps.onApplied();
        });
        return;
      }
      case "remote_file_delete": {
        await this.enqueueRemoteApply(async () => {
          const room = this.deps.getMountedRoom(message.roomId);
          if (!room) return;
          await this.deps.syncEngine.applyRemoteDelete(
            room,
            { relativePath: message.relativePath, version: message.version },
            message.deletedBy.displayName
          );
          this.deps.onApplied();
        });
        return;
      }
      case "room_deleted": {
        await this.enqueueRemoteApply(async () => {
          this.desiredSubscriptions.delete(message.roomId);
          this.deps.onRoomDeleted(message.roomId);
        });
        return;
      }
      case "room_access_revoked": {
        await this.enqueueRemoteApply(async () => {
          this.desiredSubscriptions.delete(message.roomId);
          this.deps.onAccessRevoked(message.roomId);
        });
        return;
      }
      case "room_mode_changed": {
        // Mirror the new flag onto persisted/visible state immediately (see onRoomModeChanged's
        // doc comment) - independent of, and ahead of, the snapshot re-fetch below.
        this.deps.onRoomModeChanged?.(message.roomId, message.crdtEnabled);
        // Contract 1.11's live-toggle path: reuse the existing snapshot-fetch mechanism (a fresh
        // subscribe_room) rather than inventing a partial-update merge - simplest correct behavior,
        // and it's exactly what a client would send on first subscribe anyway.
        if (this.desiredSubscriptions.has(message.roomId)) {
          this.send({ type: "subscribe_room", requestId: createRequestId(), roomId: message.roomId });
        }
        return;
      }
      case "crdt_created":
      case "crdt_rejected":
      case "crdt_sync_step1":
      case "crdt_sync_step2":
      case "remote_crdt_update":
      case "crdt_renamed":
      case "remote_crdt_rename": {
        await this.enqueueRemoteApply(() => this.deps.crdt?.handleServerMessage(message) ?? Promise.resolve());
        return;
      }
      default:
        return;
    }
  }

  /** Passthrough for the CRDT session bridge to send client->server CRDT-lane messages through
   *  this socket's normal send() (which already guards on OPEN readyState) - kept as its own method
   *  rather than exposing send() itself, since send() is otherwise private implementation detail. */
  sendCrdtMessage(message: SyncClientMessage): void {
    this.send(message);
  }

  private enqueueRemoteApply(operation: () => Promise<void>): Promise<void> {
    const execution = this.remoteApplyChain.then(operation);
    this.remoteApplyChain = execution.catch(() => undefined);
    return execution;
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
      try {
        const local = room.files[file.relativePath];
        if (local?.dirty || local?.localDeleted) {
          // A local edit or delete is pending push; let the normal push/conflict path reconcile
          // this file instead of auto-applying the remote state over it (which would otherwise
          // silently resurrect a file the user just deleted, or clobber an unpushed edit).
          continue;
        }
        if (file.deleted) {
          if (local && local.serverSha256 !== null) {
            await this.deps.syncEngine.applyRemoteDelete(room, { relativePath: file.relativePath, version: file.version }, "sync", true);
            changed = true;
          }
          continue;
        }
        if (!local || local.serverVersion !== file.version || local.serverSha256 !== file.sha256) {
          const content = await api.readFile(roomId, file.relativePath);
          await this.deps.syncEngine.applyRemoteChange(room, content, "sync", true);
          changed = true;
        }
      } catch (error) {
        console.error(`Vault Rooms: failed to reconcile snapshot file "${file.relativePath}"`, toError(error));
      }
    }
    if (changed) {
      this.deps.onApplied();
    }
  }
}

export function openSyncSocket(server: ServerConnection): WebSocket {
  const pinned = pinnedInfoForServer(server);
  if (!pinned) {
    return new WebSocket(toWsUrl(server.baseUrl));
  }
  assertPinMaterial(pinned);
  const options: NodeWebSocket.ClientOptions & { servername: string } = {
    ca: certDerBase64UrlToPem(pinned.identityCertificateDer),
    servername: pinned.tlsName,
    rejectUnauthorized: true
  };
  return new NodeWebSocket(toWsUrl(server.baseUrl), options) as unknown as WebSocket;
}

function pinnedInfoForServer(server: ServerConnection): PinnedServerInfo | undefined {
  if (server.securityMode !== "pinned-tls") {
    return undefined;
  }
  if (!server.tlsName || !server.identityCertificateDer || !server.pinnedIdentitySpkiSha256) {
    throw new InvalidPinMaterialError();
  }
  return {
    tlsName: server.tlsName,
    identityCertificateDer: server.identityCertificateDer,
    pinnedIdentitySpkiSha256: server.pinnedIdentitySpkiSha256
  };
}

export function toWsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/sync`;
}

function createRequestId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
