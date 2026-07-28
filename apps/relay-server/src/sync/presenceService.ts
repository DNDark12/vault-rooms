import {
  AppError,
  isCrdtEligiblePath,
  normalizeRelativePath,
  type PresenceCursor,
  type RemotePresenceState
} from "@vault-rooms/protocol";
import type { DevicePrincipal, RelayRepository } from "../db/repositories/relayRepository.js";
import type { RoomRow } from "../db/schema.js";
import { hasRoomPermission } from "../services/policyService.js";
import type { FixedWindowRateLimiter } from "../security/rateLimiter.js";
import { ConnectionRegistry, sendJson, type SyncConnection } from "./connectionRegistry.js";
import { PresenceRegistry, type PresenceEntry, type PresenceTarget } from "./presenceRegistry.js";

/**
 * Live cursors / note presence v1 (docs/superpowers/specs/2026-07-28-live-cursors-design.md).
 *
 * Owns everything the registry deliberately doesn't: runtime validation of an unchecked wire
 * payload, authorization, identity stamping, snapshots, fanout, rate limiting, and lifecycle
 * cleanup. Nothing here writes to SQLite - presence is ephemeral by contract.
 *
 * Two things about this file are load-bearing and easy to regress:
 *
 * 1. **Every field is hand-validated.** The sync socket parses with an unchecked cast
 *    (`JSON.parse(raw) as SyncClientMessage`), so there is no schema layer to inherit. A malformed
 *    presence message must be *rejected*, never allowed to throw past `handleSet` - the outer socket
 *    handler treats an unhandled rejection as fatal and closes the connection, which would let
 *    cursor noise kill a healthy editing session.
 * 2. **A null cursor is cleanup, not an update.** It bypasses the rate limiter (a throttled client
 *    must still be able to retract its caret, or it strands a ghost on every peer) and it runs before
 *    any room/file lookup, so it stays idempotent even after the document was renamed or deleted.
 */

/** Presence payloads are capped well below the 10 MiB WebSocket frame limit: a serialized relative
 *  position is a few dozen bytes, so this is ~2 orders of magnitude of headroom and still bounds a
 *  hostile client. */
const MAX_PRESENCE_BYTES = 8 * 1024;

/** Relative-position JSON is Yjs's shape, not ours, so it is validated structurally rather than
 *  field-by-field: plain JSON only, bounded depth, bounded total size. */
const MAX_CURSOR_DEPTH = 8;
const MAX_CURSOR_NODES = 128;

export type PresenceSetMessage = {
  type: "presence_set";
  roomId: string;
  relativePath: string;
  epoch: number;
  clientId: number;
  cursor: PresenceCursor | null;
};

export class PresenceService {
  constructor(
    private readonly repo: RelayRepository,
    private readonly connections: ConnectionRegistry,
    private readonly registry: PresenceRegistry,
    private readonly limiter: FixedWindowRateLimiter
  ) {}

  handleSet(connection: SyncConnection, message: PresenceSetMessage, rawBytes: number): void {
    try {
      if (rawBytes > MAX_PRESENCE_BYTES) {
        throw new AppError("VALIDATION_ERROR", "This presence update is too large.", 413);
      }
      if (!connection.principal) {
        throw new AppError("UNAUTHORIZED", "Authenticate before sending presence.", 401);
      }
      if (!connection.capabilities.crdt || !connection.capabilities.presence) {
        throw new AppError(
          "CRDT_CAPABILITY_REQUIRED",
          "This connection did not advertise presence support on hello.",
          409
        );
      }
      if (typeof message.roomId !== "string" || typeof message.relativePath !== "string") {
        throw new AppError("VALIDATION_ERROR", "Presence requires a room and a relative path.", 422);
      }
      if (!Number.isInteger(message.epoch)) {
        throw new AppError("VALIDATION_ERROR", "Presence requires an integer epoch.", 422);
      }
      if (!isValidClientId(message.clientId)) {
        throw new AppError("VALIDATION_ERROR", "Presence requires an unsigned 32-bit renderer key.", 422);
      }
      if (!connection.subscriptions.has(message.roomId)) {
        throw new AppError("PERMISSION_DENIED", "Subscribe to the room before sending presence.", 403);
      }

      const relativePath = normalizeRelativePath(message.relativePath);
      const target: PresenceTarget = { roomId: message.roomId, relativePath, epoch: message.epoch };

      // Removal first, and deliberately before any room/file lookup: cleanup must not depend on an
      // object that may already have been renamed or deleted out from under it. The clientId guard
      // stops a delayed null from an already-retired adapter (epoch bump, recovery) from deleting the
      // replacement state that took its place.
      if (message.cursor === null) {
        const removed = this.registry.remove(connection, target, message.clientId);
        if (removed) this.broadcastRemoval(removed);
        return;
      }

      // Only real cursor movement consumes budget. Ordered after validation so a rejected message
      // never costs a client part of its allowance, and before the DB work so throttling actually
      // sheds load rather than just suppressing the send.
      if (!this.limiter.consume(connection.id)) return;

      const room = this.requireRoom(message.roomId);
      if (!room.crdt_enabled) {
        throw new AppError("CRDT_DISABLED", "This room has not enabled CRDT sync.", 409);
      }
      if (!isCrdtEligiblePath(relativePath)) {
        throw new AppError("INVALID_PATH", "Only Markdown (.md) files carry presence.", 422);
      }
      const file = this.repo.getFile(room.id, relativePath);
      if (!file || file.deleted_at) {
        throw new AppError("NOT_FOUND", "No CRDT document exists at this path.", 404);
      }
      if (file.crdt_epoch !== message.epoch) {
        throw new AppError("CRDT_STALE_EPOCH", "This document has moved to a new epoch.", 409, {
          currentEpoch: file.crdt_epoch
        });
      }
      assertCursorShape(message.cursor);

      const aclRules = this.repo.listAclRulesForRoom(room.id);
      const teamsByUser = new Map<string, string[]>();
      const canRead = this.pathReader(room, relativePath, aclRules, teamsByUser);
      if (!canRead(connection.principal)) {
        throw new AppError("PERMISSION_DENIED", "You do not have file:read permission for this path.", 403);
      }

      const result = this.registry.set(connection, target, {
        clientId: message.clientId,
        cursor: message.cursor,
        userId: connection.principal.userId,
        displayName: connection.principal.userDisplayName
      });

      // Remove-old before add-new, so a peer never briefly renders two carets for one human when a
      // replacement Y.Doc brings a new renderer key.
      if (result.retired) {
        this.fanout(result.retired, nullify(result.retired.state), canRead);
      }
      if (result.firstForConnectionDocument) {
        sendJson(connection.socket, {
          type: "presence_snapshot",
          roomId: room.id,
          relativePath,
          epoch: message.epoch,
          states: result.snapshot
        });
      }
      this.fanout(result.current, result.current.state, canRead);
    } catch (error) {
      // Contained on purpose: a rejected presence update is a diagnostic event, never a reason to
      // tear down CRDT editing or close a healthy sync socket.
      this.reject(connection, message, error);
    }
  }

  /** Client-side unsubscribe: drop only that connection's states for that room. */
  removeConnectionRoom(connection: SyncConnection, roomId: string): void {
    this.broadcastRemovals(this.registry.removeConnectionRoom(connection, roomId));
  }

  /** Socket close. Authoritative about the whole connection, so no clientId guard. */
  removeConnection(connection: SyncConnection): void {
    this.broadcastRemovals(this.registry.removeConnection(connection));
  }

  /** Document delete (both transports) and post-rename old-path clear. Pass the pre-delete epoch for
   *  a delete; omit `epoch` to clear whatever is live at the path. */
  removeDocument(roomId: string, relativePath: string, epoch?: number): void {
    this.broadcastRemovals(this.registry.removeDocument(roomId, normalizeRelativePath(relativePath), epoch));
  }

  /** Room deleted, or the room left the CRDT lane. */
  removeRoom(roomId: string): void {
    this.broadcastRemovals(this.registry.removeRoom(roomId));
  }

  /**
   * Path-aware ACL sweep. The existing `revalidateRoomAccess` only checks `sync:subscribe` at room
   * level, so revoking `file:read` on a single path fires no event at all and would leave that
   * cursor visible indefinitely. Team membership is memoized across the whole sweep.
   */
  revalidate(): void {
    const teamsByUser = new Map<string, string[]>();
    const aclByRoom = new Map<string, ReturnType<RelayRepository["listAclRulesForRoom"]>>();
    const roomById = new Map<string, RoomRow | null>();

    for (const entry of this.registry.listAll()) {
      const principal = entry.connection.principal;
      if (!principal) {
        this.dropEntry(entry, teamsByUser);
        continue;
      }
      if (!roomById.has(entry.roomId)) {
        roomById.set(entry.roomId, this.repo.getRoom(entry.roomId) ?? null);
      }
      const room = roomById.get(entry.roomId) ?? null;
      if (!room || !room.crdt_enabled) {
        this.dropEntry(entry, teamsByUser);
        continue;
      }
      if (!aclByRoom.has(entry.roomId)) {
        aclByRoom.set(entry.roomId, this.repo.listAclRulesForRoom(entry.roomId));
      }
      const aclRules = aclByRoom.get(entry.roomId) ?? [];
      const stillAllowed =
        entry.connection.subscriptions.has(entry.roomId) &&
        hasRoomPermission({
          repo: this.repo,
          principal,
          room,
          permission: "file:read",
          relativePath: entry.relativePath,
          aclRules,
          teamIds: teamIdsFor(this.repo, principal, teamsByUser)
        });
      if (stillAllowed) continue;

      this.dropEntry(entry, teamsByUser);
      if (entry.connection.socket.readyState === entry.connection.socket.OPEN) {
        sendJson(entry.connection.socket, {
          type: "presence_rejected",
          roomId: entry.roomId,
          relativePath: entry.relativePath,
          code: "PERMISSION_DENIED",
          message: "You no longer have read access to this path."
        });
      }
    }
  }

  private dropEntry(entry: PresenceEntry, teamsByUser: Map<string, string[]>): void {
    const removed = this.registry.remove(entry.connection, entry);
    if (removed) this.broadcastRemoval(removed, teamsByUser);
  }

  private requireRoom(roomId: string): RoomRow {
    const room = this.repo.getRoom(roomId);
    if (!room) throw new AppError("NOT_FOUND", "Room not found.", 404);
    return room;
  }

  /** Per-recipient `file:read` gate with one ACL load and one team memo per message/sweep. */
  private pathReader(
    room: RoomRow,
    relativePath: string,
    aclRules: ReturnType<RelayRepository["listAclRulesForRoom"]>,
    teamsByUser: Map<string, string[]>
  ): (principal: DevicePrincipal) => boolean {
    return (principal) =>
      hasRoomPermission({
        repo: this.repo,
        principal,
        room,
        permission: "file:read",
        relativePath,
        aclRules,
        teamIds: teamIdsFor(this.repo, principal, teamsByUser)
      });
  }

  private broadcastRemovals(entries: PresenceEntry[]): void {
    if (entries.length === 0) return;
    const teamsByUser = new Map<string, string[]>();
    for (const entry of entries) {
      this.broadcastRemoval(entry, teamsByUser);
    }
  }

  /**
   * Fans out a retraction, still gated on per-recipient `file:read`. The gate matters even for a
   * removal: the payload names the user, so delivering it to someone who never had read access on the
   * path would leak that they were editing it.
   *
   * That makes the gate unevaluable once the room is gone, so this deliberately stays silent in that
   * case - and the destructive callers compensate by clearing presence *before* the room is deleted,
   * while the ACL rules still exist. Any caller that removes presence after destroying its room will
   * silently not deliver.
   */
  private broadcastRemoval(entry: PresenceEntry, teamsByUser = new Map<string, string[]>()): void {
    const room = this.repo.getRoom(entry.roomId);
    if (!room) return;
    const aclRules = this.repo.listAclRulesForRoom(room.id);
    this.fanout(entry, nullify(entry.state), this.pathReader(room, entry.relativePath, aclRules, teamsByUser));
  }

  private fanout(
    entry: PresenceEntry,
    state: RemotePresenceState,
    canReceive: (principal: DevicePrincipal) => boolean
  ): void {
    this.connections.broadcastToRoom(
      entry.roomId,
      {
        type: "remote_presence",
        roomId: entry.roomId,
        relativePath: entry.relativePath,
        epoch: entry.epoch,
        state
      },
      {
        exclude: entry.connection,
        canReceive,
        // Presence never reaches a legacy or CRDT-only peer: it would be an unknown message type
        // there, and the whole-file lane has no editor binding to render it into.
        connectionFilter: (candidate) => candidate.capabilities.crdt && candidate.capabilities.presence
      }
    );
  }

  private reject(connection: SyncConnection, message: PresenceSetMessage, error: unknown): void {
    if (connection.socket.readyState !== connection.socket.OPEN) return;
    const appError = error instanceof AppError ? error : null;
    if (!appError) {
      console.error("Vault Rooms relay: unexpected presence failure", error);
    }
    const details = appError?.details as { currentEpoch?: number } | undefined;
    sendJson(connection.socket, {
      type: "presence_rejected",
      roomId: typeof message.roomId === "string" ? message.roomId : "",
      relativePath: typeof message.relativePath === "string" ? message.relativePath : "",
      code: appError?.code ?? "VALIDATION_ERROR",
      message: appError?.message ?? "This presence update could not be applied.",
      ...(details?.currentEpoch !== undefined ? { currentEpoch: details.currentEpoch } : {})
    });
  }
}

function teamIdsFor(
  repo: RelayRepository,
  principal: DevicePrincipal,
  memo: Map<string, string[]>
): string[] {
  const cached = memo.get(principal.userId);
  if (cached) return cached;
  const teamIds = repo.listUserTeams(principal.userId).map((team) => team.teamId);
  memo.set(principal.userId, teamIds);
  return teamIds;
}

function nullify(state: RemotePresenceState): RemotePresenceState {
  return { clientId: state.clientId, user: state.user, cursor: null };
}

function isValidClientId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

/** Both halves must be present and be bounded plain JSON. The relay never interprets the contents -
 *  that is the plugin's job via `Y.createRelativePositionFromJSON` - it only refuses to relay
 *  something unbounded or non-serializable. */
function assertCursorShape(cursor: PresenceCursor): void {
  if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
    throw new AppError("VALIDATION_ERROR", "A presence cursor must be an object.", 422);
  }
  for (const key of ["yanchor", "yhead"] as const) {
    const value = cursor[key];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new AppError("VALIDATION_ERROR", `A presence cursor requires a ${key} object.`, 422);
    }
  }
  let nodes = 0;
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_CURSOR_DEPTH) {
      throw new AppError("VALIDATION_ERROR", "This presence cursor is nested too deeply.", 422);
    }
    nodes += 1;
    if (nodes > MAX_CURSOR_NODES) {
      throw new AppError("VALIDATION_ERROR", "This presence cursor has too many fields.", 422);
    }
    if (value === null) return;
    const kind = typeof value;
    if (kind === "string" || kind === "number" || kind === "boolean") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (kind === "object") {
      // Rejects class instances, Dates, Maps - anything that would not survive the transport as the
      // plain object the plugin expects to rehydrate.
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new AppError("VALIDATION_ERROR", "A presence cursor must be plain JSON.", 422);
      }
      for (const item of Object.values(value as Record<string, unknown>)) walk(item, depth + 1);
      return;
    }
    throw new AppError("VALIDATION_ERROR", "A presence cursor must be plain JSON.", 422);
  };
  walk(cursor.yanchor, 1);
  walk(cursor.yhead, 1);
}
