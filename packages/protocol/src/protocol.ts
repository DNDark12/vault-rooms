import type { ErrorCode } from "./errors.js";

/** Capability negotiation (docs/superpowers/plans/2026-07-20-crdt-sync.md contract 1.2). Optional
 *  and additive so an older client that doesn't send it still parses under this type - absent means
 *  "no CRDT support", never assumed true.
 *
 *  `presence` (live cursors, docs/superpowers/specs/2026-07-28-live-cursors-design.md) is only
 *  meaningful alongside `crdt: true` - the relay clamps it to false otherwise, since presence is
 *  scoped to live CRDT documents and there is nothing to attach a caret to on the whole-file lane. */
export type SyncClientCapabilities = { crdt?: boolean; presence?: boolean };

/**
 * A cursor as it crosses the wire: two *JSON-serialized* Yjs relative positions
 * (`Y.relativePositionToJSON`), never live `Y.RelativePosition` objects. `unknown` rather than a
 * structural type on purpose - the shape is Yjs's to define, the relay only validates that it is a
 * bounded plain-JSON object and never interprets it, and the plugin rehydrates it with
 * `Y.createRelativePositionFromJSON` before handing it to the renderer.
 */
export type PresenceCursor = {
  yanchor: unknown;
  yhead: unknown;
};

/**
 * One peer's presence on a document, as broadcast by the relay. `user` is stamped server-side from
 * the connection's authenticated principal - a client can never supply or spoof it.
 *
 * `clientId` is an opaque *renderer key*, not an identity: it is the Yjs `Doc.clientID` that
 * `y-codemirror.next` uses to key `getStates()` and to filter out its own cursor. The plugin builds
 * a fresh `Y.Doc` (and therefore a fresh random clientID) on every epoch change, recovery, and
 * remount, so nothing durable may be keyed on it. The relay enforces only that it is unique among
 * live states for one document, because `getStates()` is a Map and colliding keys would make one
 * peer's caret overwrite another's in the renderer.
 *
 * A `cursor: null` state means "this peer is gone" - removals fan out as a null-cursor state rather
 * than a separate message type, which keeps an unknown or stale removal idempotent.
 */
export type RemotePresenceState = {
  clientId: number;
  user: {
    userId: string;
    displayName: string;
    /**
     * Relay-assigned room-session hue in degrees, `[0, 360)`. The relay owns it so every receiver
     * agrees about who is which colour - a client-side hash cannot, because two users hashing into
     * one slot look identical on one screen and distinct on another.
     *
     * Optional on purpose, in both directions. Sync frames are untrusted input, and a mixed-version
     * LAN legitimately produces states without a hue; the plugin validates the range and falls back
     * to a local hash rather than rendering an invalid colour. Note this carries a *number*, never a
     * CSS value: `y-codemirror.next` injects the caret colour as an inline style attribute, so
     * accepting relay-supplied CSS text here would hand a remote server a style injection.
     *
     * Clients never submit it - `PresenceSet` has no `user` at all, and the relay stamps identity
     * and hue from the authenticated principal and its own lease table.
     */
    hue?: number;
  };
  cursor: PresenceCursor | null;
};

/**
 * A client announcing (or retracting) its cursor on one document. Deliberately has no requestId:
 * presence is fire-and-forget ephemeral state, not a request awaiting an ack.
 */
export type PresenceSet = {
  type: "presence_set";
  roomId: string;
  relativePath: string;
  epoch: number;
  clientId: number;
  /** `null` retracts this connection's presence for the document. Idempotent, and deliberately exempt
   *  from the update rate limit - cleanup is not cursor noise, and a throttled client must still be
   *  able to remove its caret or it would strand a ghost on every peer. */
  cursor: PresenceCursor | null;
};

/** The other live states for a document, sent once to a connection on its first non-null
 *  `presence_set`. Everything after that arrives as individual `remote_presence` fanouts. */
export type PresenceSnapshot = {
  type: "presence_snapshot";
  roomId: string;
  relativePath: string;
  epoch: number;
  states: RemotePresenceState[];
};

export type RemotePresence = {
  type: "remote_presence";
  roomId: string;
  relativePath: string;
  epoch: number;
  state: RemotePresenceState;
};

/** Correlated by (roomId, relativePath) rather than a requestId - presence is fire-and-forget, and a
 *  rejection is a diagnostic event that must never tear down the CRDT document session. */
export type PresenceRejected = {
  type: "presence_rejected";
  roomId: string;
  relativePath: string;
  code: ErrorCode;
  message: string;
  currentEpoch?: number;
};

export type SyncClientMessage =
  | { type: "hello"; requestId: string; token: string; client: { kind: "obsidian-plugin"; version: string; deviceName: string }; capabilities?: SyncClientCapabilities }
  | { type: "subscribe_room"; requestId: string; roomId: string }
  | { type: "unsubscribe_room"; requestId: string; roomId: string }
  | { type: "file_change"; requestId: string; roomId: string; relativePath: string; baseVersion: number; content: string }
  | { type: "file_delete"; requestId: string; roomId: string; relativePath: string; baseVersion: number }
  // --- CRDT sync (contract 1.3/1.8/1.10) - all scoped by roomId + relativePath + epoch. ---
  | {
      type: "crdt_create";
      requestId: string;
      roomId: string;
      relativePath: string;
      /**
       * `true` when the sender is (re)establishing a session for a note it *already has* - reopening
       * after an unmount/remount, binding an editor, reacting to a remote update - rather than
       * announcing a brand-new note the user just made. The distinction decides what happens when the
       * path is already taken server-side: adopt that existing document, or treat this as a second,
       * different note and give it a disambiguated name. Getting it wrong in the "adopt" direction
       * merges two unrelated notes; getting it wrong in the other direction duplicated a note on every
       * remount, renaming the local file to `… (device 1)` / `… (device 2)` (fifteenth hardware-testing
       * round). Absent is treated as `false` so an older client keeps the previous behavior.
       */
      adoptIfExists?: boolean;
    }
  | { type: "crdt_sync_step1"; requestId: string; roomId: string; relativePath: string; epoch: number; stateVector: string }
  | { type: "crdt_sync_step2"; requestId: string; roomId: string; relativePath: string; epoch: number; update: string }
  | { type: "crdt_update"; requestId: string; roomId: string; relativePath: string; epoch: number; update: string }
  // --- CRDT atomic rename (fourth hardware-testing round, 2026-07-23) - replaces the old
  // delete-old+create-new translation for a rename inside a CRDT-enabled room: preserves the
  // file's stable id/epoch/history (CrdtDocManager caches by (fileId, epoch), never by path, so a
  // pure path change needs no doc/epoch churn at all - see relayRepository.ts's renameFile). ---
  | { type: "crdt_rename"; requestId: string; roomId: string; oldRelativePath: string; relativePath: string }
  // --- Live cursors / note presence (docs/superpowers/specs/2026-07-28-live-cursors-design.md) ---
  | PresenceSet;

export type SyncServerMessage =
  | { type: "hello_ok"; requestId: string; userId: string; deviceId: string }
  | {
      type: "hello_error";
      requestId?: string;
      code: "UNAUTHORIZED";
      /** User-facing prose. Optional so a relay predating it stays a valid message: the client then
       *  looks up its own wording by `code` rather than showing the identifier or nothing at all. */
      message?: string;
    }
  | {
      type: "room_snapshot";
      requestId: string;
      roomId: string;
      files: Array<{ relativePath: string; version: number; sha256: string | null; deleted: boolean; crdtEpoch?: number }>;
    }
  | { type: "file_change_ack"; requestId: string; roomId: string; relativePath: string; version: number; sha256: string }
  | { type: "file_delete_ack"; requestId: string; roomId: string; relativePath: string; version: number }
  | {
      type: "remote_file_change";
      roomId: string;
      relativePath: string;
      version: number;
      sha256: string;
      content: string;
      updatedBy: { userId: string; displayName: string };
      updatedAt: string;
      /** Present when this path is a live CRDT document (creation announce and materialized fanout).
       *  A CRDT-capable receiver records it as the known epoch for the path, so a later
       *  `ensureSession` for the file it just wrote to disk *adopts* that document instead of trying
       *  to `crdt_create` it. Without this the receiving device's own vault-watcher "create" event
       *  fired a `crdt_create` that collided with the very document it had just been sent - which,
       *  once collisions started auto-renaming instead of failing, became an unbounded
       *  rename/announce feedback loop between the two devices (ninth hardware-testing round). */
      crdtEpoch?: number;
    }
  | { type: "remote_file_delete"; roomId: string; relativePath: string; version: number; deletedBy: { userId: string; displayName: string }; deletedAt: string }
  | { type: "file_change_rejected"; requestId: string; code: string; message: string; serverVersion?: number; serverSha256?: string | null; serverContent?: string }
  | { type: "revoked"; message: string }
  | { type: "room_deleted"; roomId: string }
  | { type: "room_access_revoked"; roomId: string }
  | { type: "security_upgrade_available"; httpsUrl: string; wssUrl: string }
  // --- CRDT sync (contract 1.3/1.8/1.10/1.11) ---
  | {
      type: "crdt_created";
      requestId: string;
      roomId: string;
      relativePath: string;
      documentId: string;
      epoch: number;
      /**
       * `true` when this answer *adopted* a document that already existed at the path rather than
       * creating one. The client must not seed an adopted document from its local disk copy: the
       * server's document already holds that content, so seeding duplicates it - and because unmounting
       * clears the client's persisted state, every remount duplicated the note again (seventeenth
       * hardware-testing round). Absent/false means the document was genuinely created by this request,
       * in which case the local disk copy is its only content and must be seeded.
       */
      adopted?: boolean;
    }
  | { type: "crdt_sync_step1"; roomId: string; relativePath: string; epoch: number; stateVector: string }
  | { type: "crdt_sync_step2"; requestId: string; roomId: string; relativePath: string; epoch: number; update: string }
  | { type: "remote_crdt_update"; roomId: string; relativePath: string; epoch: number; update: string; updatedBy: { userId: string; displayName: string } }
  | { type: "room_mode_changed"; roomId: string; crdtEnabled: boolean }
  | { type: "crdt_rejected"; requestId?: string; roomId: string; relativePath: string; code: string; message: string; currentEpoch?: number }
  // --- CRDT atomic rename (fourth hardware-testing round, 2026-07-23) ---
  | { type: "crdt_renamed"; requestId: string; roomId: string; oldRelativePath: string; relativePath: string; epoch: number }
  | {
      type: "remote_crdt_rename";
      roomId: string;
      oldRelativePath: string;
      relativePath: string;
      epoch: number;
      renamedBy: { userId: string; displayName: string };
    }
  // --- Live cursors / note presence (docs/superpowers/specs/2026-07-28-live-cursors-design.md) ---
  // Sent only to connections that advertised `crdt: true` *and* `presence: true` and that still hold
  // per-path `file:read`, so a member whose ACL doesn't cover a path never learns another peer is
  // editing it.
  | PresenceSnapshot
  | RemotePresence
  | PresenceRejected;
