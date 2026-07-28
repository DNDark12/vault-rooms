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

function documentKey(target: PresenceTarget): string {
  // Newline as the separator: room IDs are generated (never user-supplied) and the epoch is numeric,
  // so neither side can contain one. That keeps the composition unambiguous for any relative path,
  // including one carrying whatever punctuation a naive delimiter would collide on.
  return `${target.roomId}\n${target.relativePath}\n${target.epoch}`;
}

export class PresenceRegistry {
  /** connection -> documentKey -> entry. Nested so per-connection teardown (the socket-close and
   *  unsubscribe paths) is a direct lookup rather than a scan of every live state on the server. */
  private readonly byConnection = new Map<SyncConnection, Map<string, PresenceEntry>>();

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
        user: { userId: input.userId, displayName: input.displayName },
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
    if (!documents) return [];
    this.byConnection.delete(connection);
    return [...documents.values()];
  }

  removeConnectionRoom(connection: SyncConnection, roomId: string): PresenceEntry[] {
    return this.removeWhere((entry) => entry.connection === connection && entry.roomId === roomId);
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
    return this.removeWhere((entry) => entry.roomId === roomId);
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
