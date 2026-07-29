import { AppError, type PresenceCursor, type RemotePresenceState } from "@vault-rooms/protocol";
import type { SyncConnection } from "./connectionRegistry.js";

/**
 * Live cursors / note presence v1 (docs/superpowers/specs/2026-07-28-live-cursors-design.md).
 *
 * The in-memory ownership layer for presence, deliberately kept free of I/O: no sockets, no policy
 * evaluation, no repository, no SQLite. Presence is ephemeral by contract, so a relay restart
 * legitimately forgets every cursor - there is nothing here to persist or migrate. Authorization,
 * validation, fanout, and rate limiting all live in PresenceService.
 *
 * Keying is `(connection, roomId, relativePath, epoch)` with `clientId` held as a *value*, not part
 * of the key. That choice is what makes the client's Y.Doc churn self-healing: the plugin builds a
 * fresh Y.Doc (and therefore a fresh random clientID) on every epoch change, NOT_FOUND recovery,
 * and remount, so a connection's renderer key changes often while its identity does not. Keying by
 * connection means the new state simply *replaces* the old one and `set` hands back the retired
 * entry, letting the service emit remove-old then add-new instead of accumulating ghosts.
 *
 * `clientId` still has to be unique among live states for one document, though, and that is enforced
 * here for a reason that lives entirely on the client: `y-codemirror.next` consumes `getStates()` as
 * a `Map<number, State>` keyed by clientId and skips whichever entry matches its own
 * `doc.clientID`. Two connections sharing a live key therefore collide in the renderer - one remote
 * caret overwrites the other in the map, and it disappears entirely for the peer whose own clientID
 * happens to equal it. Connection keying protects this registry; per-document clientId uniqueness
 * protects the thing downstream of it.
 */

export type PresenceTarget = {
  roomId: string;
  relativePath: string;
  epoch: number;
};

export type PresenceEntry = PresenceTarget & {
  connection: SyncConnection;
  state: RemotePresenceState;
};

export type PresenceSetInput = {
  clientId: number;
  cursor: PresenceCursor;
  userId: string;
  displayName: string;
};

export type PresenceSetResult = {
  /** `true` when this connection had no prior state for this document - the service uses it to
   *  decide whether the sender is owed a one-time `presence_snapshot` of its peers. */
  firstForConnectionDocument: boolean;
  /** The state this call displaced, when the same connection changed its renderer key. Must be
   *  broadcast as a null-cursor removal *before* `current`, or peers keep the stale caret. */
  retired: PresenceEntry | null;
  current: PresenceEntry;
  /** The other connections' live states for this document, excluding the caller's own. */
  snapshot: RemotePresenceState[];
};

/**
 * Room-session hue leases (docs/superpowers/plans/2026-07-28-room-session-presence-colors.md).
 *
 * Hues are held as integer *milli-degrees* rather than floats. Two reasons, both practical: a Set of
 * integers makes "is this colour already taken" an exact question (float equality on a golden-angle
 * accumulation is not), and it makes probing for a free slot terminate in a bounded number of steps.
 * The wire value is `slot / 1000`, so 137508 crosses as 137.508.
 */
const HUE_SLOTS = 360_000;
/** The golden angle (137.50776...°), rounded to the slot resolution. Successive multiples of it stay
 *  far apart on the colour wheel for any number of users, which is why it beats even spacing: even
 *  spacing has to know the final count up front, and a room's population changes as people join. */
const GOLDEN_ANGLE_SLOTS = 137_508;

/** One human's colour in one room, shared by every connection they have open to it. Keyed by userId,
 *  never by connection or device, so a laptop and a desktop are one caret colour. */
type RoomHueLease = {
  hueSlot: number;
  connections: Set<SyncConnection>;
};

type RoomHueState = {
  /** Randomised per room *session* so two rooms don't open on the same colour, and so a room that
   *  empties out and refills doesn't deterministically reissue the previous session's assignments. */
  startSlot: number;
  nextOrdinal: number;
  users: Map<string, RoomHueLease>;
  usedSlots: Set<number>;
};

function documentKey(target: PresenceTarget): string {
  // Newline as the separator: room IDs are generated (never user-supplied) and the epoch is numeric,
  // so neither side can contain one. That keeps the composition unambiguous for any relative path,
  // including one carrying whatever punctuation a naive delimiter would collide on.
  return `${target.roomId}\n${target.relativePath}\n${target.epoch}`;
}

export class PresenceRegistry {
  /** Injectable so hue allocation is testable. Production passes nothing and gets `Math.random`. */
  constructor(private readonly random: () => number = Math.random) {}

  /** connection -> documentKey -> entry. Nested so per-connection teardown (the socket-close and
   *  unsubscribe paths) is a direct lookup rather than a scan of every live state on the server. */
  private readonly byConnection = new Map<SyncConnection, Map<string, PresenceEntry>>();

  /** roomId -> that room session's hue allocation state. */
  private readonly huesByRoom = new Map<string, RoomHueState>();

  /** connection -> roomId -> userId. The reverse index exists so releasing a connection's leases is a
   *  direct lookup instead of a scan across every room's lease table, and so cleanup knows which
   *  user's lease a given connection was attached to without consulting `connection.principal`
   *  (which a teardown path may reach after the principal is gone). */
  private readonly hueRoomsByConnection = new Map<SyncConnection, Map<string, string>>();

  set(connection: SyncConnection, target: PresenceTarget, input: PresenceSetInput): PresenceSetResult {
    const key = documentKey(target);
    const live = this.entriesForDocument(key);

    // Collision check first, so a rejected claim leaves the registry completely untouched.
    for (const entry of live) {
      if (entry.connection !== connection && entry.state.clientId === input.clientId) {
        throw new AppError(
          "VALIDATION_ERROR",
          "This presence renderer key is already live for this document.",
          409
        );
      }
    }

    const documents = this.byConnection.get(connection) ?? new Map<string, PresenceEntry>();
    if (!this.byConnection.has(connection)) {
      this.byConnection.set(connection, documents);
    }

    const previous = documents.get(key) ?? null;
    const current: PresenceEntry = {
      ...target,
      connection,
      state: {
        clientId: input.clientId,
        user: {
          userId: input.userId,
          displayName: input.displayName,
          // The authoritative allocation boundary. PresenceService also calls joinRoom on a
          // successful CRDT-room subscribe, but only so hues follow join order; joinRoom is
          // idempotent, and doing it here as well guarantees a valid hue even if some future
          // lifecycle path reaches set() without that hook having run.
          hue: this.joinRoom(connection, target.roomId, input.userId)
        },
        cursor: input.cursor
      }
    };
    documents.set(key, current);

    return {
      firstForConnectionDocument: previous === null,
      // Only a genuine renderer-key change needs a removal broadcast; a plain cursor move reuses
      // the same key and would otherwise emit a pointless remove/add pair on every keystroke.
      retired: previous !== null && previous.state.clientId !== input.clientId ? previous : null,
      current,
      snapshot: live.filter((entry) => entry.connection !== connection).map((entry) => entry.state)
    };
  }

  get(connection: SyncConnection, target: PresenceTarget): PresenceEntry | undefined {
    return this.byConnection.get(connection)?.get(documentKey(target));
  }

  listDocument(target: PresenceTarget): PresenceEntry[] {
    return this.entriesForDocument(documentKey(target));
  }

  listAll(): PresenceEntry[] {
    const entries: PresenceEntry[] = [];
    for (const documents of this.byConnection.values()) {
      entries.push(...documents.values());
    }
    return entries;
  }

  /**
   * Removes one connection's state for one document. `expectedClientId` guards the client-requested
   * path: a null `presence_set` from an adapter that has already been retired (epoch bump, recovery)
   * must not delete the replacement state that took its place, so a mismatch is a no-op. Relay-owned
   * cleanup omits it, since those paths are authoritative about the whole connection.
   */
  remove(connection: SyncConnection, target: PresenceTarget, expectedClientId?: number): PresenceEntry | null {
    const documents = this.byConnection.get(connection);
    if (!documents) return null;
    const key = documentKey(target);
    const entry = documents.get(key);
    if (!entry) return null;
    if (expectedClientId !== undefined && entry.state.clientId !== expectedClientId) return null;
    documents.delete(key);
    if (documents.size === 0) this.byConnection.delete(connection);
    return entry;
  }

  removeConnection(connection: SyncConnection): PresenceEntry[] {
    const documents = this.byConnection.get(connection);
    for (const roomId of [...(this.hueRoomsByConnection.get(connection)?.keys() ?? [])]) {
      this.releaseRoomHue(connection, roomId);
    }
    if (!documents) return [];
    this.byConnection.delete(connection);
    return [...documents.values()];
  }

  removeConnectionRoom(connection: SyncConnection, roomId: string): PresenceEntry[] {
    const removed = this.removeWhere((entry) => entry.connection === connection && entry.roomId === roomId);
    this.releaseRoomHue(connection, roomId);
    return removed;
  }

  /** Clears a document for every connection. `epoch` omitted means "every epoch of this path" - the
   *  delete path uses the pre-delete epoch explicitly, while a rename clears whatever is live. */
  removeDocument(roomId: string, relativePath: string, epoch?: number): PresenceEntry[] {
    return this.removeWhere(
      (entry) =>
        entry.roomId === roomId &&
        entry.relativePath === relativePath &&
        (epoch === undefined || entry.epoch === epoch)
    );
  }

  removeRoom(roomId: string): PresenceEntry[] {
    const removed = this.removeWhere((entry) => entry.roomId === roomId);
    this.huesByRoom.delete(roomId);
    for (const [connection, rooms] of [...this.hueRoomsByConnection.entries()]) {
      if (!rooms.delete(roomId)) continue;
      if (rooms.size === 0) this.hueRoomsByConnection.delete(connection);
    }
    return removed;
  }

  /**
   * Leases a hue for `userId` in `roomId` and returns it in degrees, `[0, 360)`.
   *
   * Idempotent for one `(connection, roomId)` pair, and shared across every connection authenticated
   * as the same user: reconnects, ACL refreshes, and a second device all get the colour the user
   * already has. A new colour is minted only for a user with no live connection to the room.
   */
  joinRoom(connection: SyncConnection, roomId: string, userId: string): number {
    const room = this.huesByRoom.get(roomId) ?? {
      startSlot: this.randomStartSlot(),
      nextOrdinal: 0,
      users: new Map<string, RoomHueLease>(),
      usedSlots: new Set<number>()
    };
    this.huesByRoom.set(roomId, room);

    const rooms = this.hueRoomsByConnection.get(connection) ?? new Map<string, string>();
    this.hueRoomsByConnection.set(connection, rooms);

    const existingUserId = rooms.get(roomId);
    const existingLease = existingUserId === undefined ? undefined : room.users.get(existingUserId);
    if (existingLease && existingUserId === userId) {
      return existingLease.hueSlot / 1000;
    }
    // A connection's principal never changes mid-socket, so this only fires if a future lifecycle
    // path reuses a connection object for a different user. Release the stale membership rather than
    // leaving the old lease pinned open by a connection that no longer belongs to it.
    if (existingUserId !== undefined) this.releaseRoomHue(connection, roomId);

    const lease = room.users.get(userId) ?? { hueSlot: this.allocateHueSlot(room), connections: new Set<SyncConnection>() };
    room.users.set(userId, lease);
    lease.connections.add(connection);
    rooms.set(roomId, userId);
    return lease.hueSlot / 1000;
  }

  /**
   * Drops leases whose connection no longer holds the room subscription.
   *
   * `revalidateRoomAccess` mutates `connection.subscriptions` directly and never notifies presence
   * (see connectionRegistry.ts), so an ACL change that revokes room access would otherwise leave the
   * hue leased. Every call site of `revalidateRoomAccess` pairs it with `PresenceService.revalidate`,
   * which is where this runs.
   */
  removeUnsubscribedRoomHues(): void {
    for (const [connection, rooms] of [...this.hueRoomsByConnection.entries()]) {
      for (const roomId of [...rooms.keys()]) {
        if (connection.subscriptions.has(roomId)) continue;
        this.releaseRoomHue(connection, roomId);
      }
    }
  }

  private releaseRoomHue(connection: SyncConnection, roomId: string): void {
    const rooms = this.hueRoomsByConnection.get(connection);
    const userId = rooms?.get(roomId);
    if (!rooms || userId === undefined) return;
    rooms.delete(roomId);
    if (rooms.size === 0) this.hueRoomsByConnection.delete(connection);

    const room = this.huesByRoom.get(roomId);
    const lease = room?.users.get(userId);
    if (!room || !lease) return;
    lease.connections.delete(connection);
    // The user still has another device in this room - keep their colour.
    if (lease.connections.size > 0) return;
    room.users.delete(userId);
    room.usedSlots.delete(lease.hueSlot);
    // Nobody is left, so the room session is over. Dropping the state is what gives the next session
    // a fresh random start rather than replaying this one's assignments.
    if (room.users.size === 0) this.huesByRoom.delete(roomId);
  }

  /** Golden-angle stride, then linear probing onto the first free slot. `usedSlots.size + 1` probes
   *  are enough to find a gap while fewer than HUE_SLOTS users are live, which the relay's connection
   *  cap is orders of magnitude below - so the loop is bounded and the throw is unreachable in
   *  practice, kept only so an impossible state fails loudly instead of reissuing a live colour. */
  private allocateHueSlot(room: RoomHueState): number {
    const baseSlot = (room.startSlot + room.nextOrdinal * GOLDEN_ANGLE_SLOTS) % HUE_SLOTS;
    room.nextOrdinal += 1;

    for (let probe = 0; probe <= room.usedSlots.size; probe += 1) {
      const candidate = (baseSlot + probe) % HUE_SLOTS;
      if (room.usedSlots.has(candidate)) continue;
      room.usedSlots.add(candidate);
      return candidate;
    }
    throw new AppError("VALIDATION_ERROR", "No live-cursor colour is available for this room.", 409);
  }

  private randomStartSlot(): number {
    return Math.min(HUE_SLOTS - 1, Math.max(0, Math.floor(this.random() * HUE_SLOTS)));
  }

  size(): number {
    let total = 0;
    for (const documents of this.byConnection.values()) {
      total += documents.size;
    }
    return total;
  }

  private entriesForDocument(key: string): PresenceEntry[] {
    const entries: PresenceEntry[] = [];
    for (const documents of this.byConnection.values()) {
      const entry = documents.get(key);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  private removeWhere(predicate: (entry: PresenceEntry) => boolean): PresenceEntry[] {
    const removed: PresenceEntry[] = [];
    for (const [connection, documents] of [...this.byConnection.entries()]) {
      for (const [key, entry] of [...documents.entries()]) {
        if (!predicate(entry)) continue;
        documents.delete(key);
        removed.push(entry);
      }
      if (documents.size === 0) this.byConnection.delete(connection);
    }
    return removed;
  }
}
