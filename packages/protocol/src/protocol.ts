/** Capability negotiation (docs/superpowers/plans/2026-07-20-crdt-sync.md contract 1.2). Optional
 *  and additive so an older client that doesn't send it still parses under this type - absent means
 *  "no CRDT support", never assumed true. */
export type SyncClientCapabilities = { crdt?: boolean };

export type SyncClientMessage =
  | { type: "hello"; requestId: string; token: string; client: { kind: "obsidian-plugin"; version: string; deviceName: string }; capabilities?: SyncClientCapabilities }
  | { type: "subscribe_room"; requestId: string; roomId: string }
  | { type: "file_change"; requestId: string; roomId: string; relativePath: string; baseVersion: number; content: string }
  | { type: "file_delete"; requestId: string; roomId: string; relativePath: string; baseVersion: number }
  // --- CRDT sync (contract 1.3/1.8/1.10) - all scoped by roomId + relativePath + epoch. ---
  | { type: "crdt_create"; requestId: string; roomId: string; relativePath: string }
  | { type: "crdt_sync_step1"; requestId: string; roomId: string; relativePath: string; epoch: number; stateVector: string }
  | { type: "crdt_sync_step2"; requestId: string; roomId: string; relativePath: string; epoch: number; update: string }
  | { type: "crdt_update"; requestId: string; roomId: string; relativePath: string; epoch: number; update: string };

export type SyncServerMessage =
  | { type: "hello_ok"; requestId: string; userId: string; deviceId: string }
  | { type: "hello_error"; requestId?: string; code: "UNAUTHORIZED" }
  | {
      type: "room_snapshot";
      requestId: string;
      roomId: string;
      files: Array<{ relativePath: string; version: number; sha256: string | null; deleted: boolean; crdtEpoch?: number }>;
    }
  | { type: "file_change_ack"; requestId: string; roomId: string; relativePath: string; version: number; sha256: string }
  | { type: "file_delete_ack"; requestId: string; roomId: string; relativePath: string; version: number }
  | { type: "remote_file_change"; roomId: string; relativePath: string; version: number; sha256: string; content: string; updatedBy: { userId: string; displayName: string }; updatedAt: string }
  | { type: "remote_file_delete"; roomId: string; relativePath: string; version: number; deletedBy: { userId: string; displayName: string }; deletedAt: string }
  | { type: "file_change_rejected"; requestId: string; code: string; message: string; serverVersion?: number; serverSha256?: string | null; serverContent?: string }
  | { type: "revoked"; message: string }
  | { type: "room_deleted"; roomId: string }
  | { type: "room_access_revoked"; roomId: string }
  | { type: "security_upgrade_available"; httpsUrl: string; wssUrl: string }
  // --- CRDT sync (contract 1.3/1.8/1.10/1.11) ---
  | { type: "crdt_created"; requestId: string; roomId: string; relativePath: string; documentId: string; epoch: number }
  | { type: "crdt_sync_step1"; roomId: string; relativePath: string; epoch: number; stateVector: string }
  | { type: "crdt_sync_step2"; requestId: string; roomId: string; relativePath: string; epoch: number; update: string }
  | { type: "remote_crdt_update"; roomId: string; relativePath: string; epoch: number; update: string; updatedBy: { userId: string; displayName: string } }
  | { type: "room_mode_changed"; roomId: string; crdtEnabled: boolean }
  | { type: "crdt_rejected"; requestId?: string; roomId: string; relativePath: string; code: string; message: string; currentEpoch?: number };
