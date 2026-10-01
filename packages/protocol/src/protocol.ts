import type { ErrorCode } from "./errors.js";

/** Optional capabilities default to false for older clients. */
export type SyncClientCapabilities = { crdt?: boolean; presence?: boolean; extendedBinarySync?: boolean; portablePaths?: boolean };

/** JSON-serialized Yjs relative positions. */
export type PresenceCursor = {
  yanchor: unknown;
  yhead: unknown;
};

/** Relay-stamped ephemeral presence; clientId is only a renderer key. */
export type RemotePresenceState = {
  clientId: number;
  user: {
    userId: string;
    displayName: string;
    /** Optional relay-assigned room-session hue in degrees. */
    hue?: number;
  };
  cursor: PresenceCursor | null;
};

/** Fire-and-forget cursor announcement or retraction. */
export type PresenceSet = {
  type: "presence_set";
  roomId: string;
  relativePath: string;
  epoch: number;
  clientId: number;
  /** null retracts presence and bypasses the update rate limit. */
  cursor: PresenceCursor | null;
};

/** Initial peer states sent on first presence publication. */
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

/** Diagnostic rejection that does not close the CRDT session. */
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
  | {
      type: "file_change";
      requestId: string;
      roomId: string;
      relativePath: string;
      baseVersion: number;
      content: string;
      /** Optional sender hint; the relay derives the authoritative encoding. */
      contentEncoding?: "utf8" | "base64";
    }
  | { type: "file_delete"; requestId: string; roomId: string; relativePath: string; baseVersion: number }
  // CRDT messages are scoped by room, path, and epoch.
  | {
      type: "crdt_create";
      requestId: string;
      /** Stable across reconnect/restart retries. Optional for pre-journal clients. */
      operationId?: string;
      roomId: string;
      relativePath: string;
      /** Adopt an existing document instead of disambiguating a new note. */
      adoptIfExists?: boolean;
    }
  | { type: "crdt_sync_step1"; requestId: string; roomId: string; relativePath: string; epoch: number; stateVector: string }
  | { type: "crdt_sync_step2"; requestId: string; roomId: string; relativePath: string; epoch: number; update: string }
  | { type: "crdt_update"; requestId: string; roomId: string; relativePath: string; epoch: number; update: string }
  // Atomic CRDT rename preserves file identity and epoch.
  | { type: "crdt_rename"; requestId: string; operationId?: string; roomId: string; oldRelativePath: string; relativePath: string }
  | PresenceSet;

export type SyncServerMessage =
  | {
      type: "hello_ok";
      requestId: string;
      userId: string;
      deviceId: string;
      /** Relay-owned capabilities. Optional so older hello_ok frames stay valid. */
      capabilities?: { crdtOperationReceipts?: boolean; portablePaths?: boolean };
    }
  | {
      type: "hello_error";
      requestId?: string;
      code: "UNAUTHORIZED";
      /** Optional user-facing prose for backward compatibility. */
      message?: string;
    }
  | {
      type: "room_snapshot";
      requestId: string;
      roomId: string;
      files: Array<{ relativePath: string; version: number; sha256: string | null; deleted: boolean; crdtEpoch?: number; pathCollision?: boolean; fileId?: string }>;
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
      /** Content lane; absent on older relays. */
      contentEncoding?: "utf8" | "base64";
      updatedBy: { userId: string; displayName: string };
      updatedAt: string;
      /** Known epoch for adopting a live CRDT document. */
      crdtEpoch?: number;
    }
  | { type: "remote_file_delete"; roomId: string; relativePath: string; version: number; deletedBy: { userId: string; displayName: string }; deletedAt: string }
  | { type: "file_change_rejected"; requestId: string; code: string; message: string; serverVersion?: number; serverSha256?: string | null; serverContent?: string }
  | { type: "revoked"; message: string }
  | { type: "room_deleted"; roomId: string }
  | { type: "room_access_revoked"; roomId: string }
  | { type: "security_upgrade_available"; httpsUrl: string; wssUrl: string }
  // CRDT sync.
  | {
      type: "crdt_created";
      requestId: string;
      roomId: string;
      relativePath: string;
      documentId: string;
      epoch: number;
      /** Prevents seeding a document that already existed. */
      adopted?: boolean;
    }
  | { type: "crdt_sync_step1"; roomId: string; relativePath: string; epoch: number; stateVector: string }
  | { type: "crdt_sync_step2"; requestId: string; roomId: string; relativePath: string; epoch: number; update: string }
  | { type: "remote_crdt_update"; roomId: string; relativePath: string; epoch: number; update: string; updatedBy: { userId: string; displayName: string } }
  | { type: "room_mode_changed"; roomId: string; crdtEnabled: boolean }
  | { type: "crdt_rejected"; requestId?: string; roomId: string; relativePath: string; code: string; message: string; currentEpoch?: number }
  // Atomic CRDT rename.
  | { type: "crdt_renamed"; requestId: string; roomId: string; oldRelativePath: string; relativePath: string; epoch: number }
  | {
      type: "remote_crdt_rename";
      roomId: string;
      oldRelativePath: string;
      relativePath: string;
      epoch: number;
      renamedBy: { userId: string; displayName: string };
    }
  // Presence requires advertised support and file read access.
  | PresenceSnapshot
  | RemotePresence
  | PresenceRejected;
