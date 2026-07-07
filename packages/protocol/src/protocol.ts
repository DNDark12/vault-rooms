export type SyncClientMessage =
  | { type: "hello"; requestId: string; token: string; client: { kind: "obsidian-plugin"; version: string; deviceName: string } }
  | { type: "subscribe_room"; requestId: string; roomId: string }
  | { type: "file_change"; requestId: string; roomId: string; relativePath: string; baseVersion: number; content: string }
  | { type: "file_delete"; requestId: string; roomId: string; relativePath: string; baseVersion: number };

export type SyncServerMessage =
  | { type: "hello_ok"; requestId: string; userId: string; deviceId: string }
  | { type: "hello_error"; requestId?: string; code: "UNAUTHORIZED" }
  | { type: "room_snapshot"; requestId: string; roomId: string; files: Array<{ relativePath: string; version: number; sha256: string | null; deleted: boolean }> }
  | { type: "file_change_ack"; requestId: string; roomId: string; relativePath: string; version: number; sha256: string }
  | { type: "file_delete_ack"; requestId: string; roomId: string; relativePath: string; version: number }
  | { type: "remote_file_change"; roomId: string; relativePath: string; version: number; sha256: string; content: string; updatedBy: { userId: string; displayName: string }; updatedAt: string }
  | { type: "remote_file_delete"; roomId: string; relativePath: string; version: number; deletedBy: { userId: string; displayName: string }; deletedAt: string }
  | { type: "file_change_rejected"; requestId: string; code: string; message: string; serverVersion?: number; serverSha256?: string | null; serverContent?: string }
  | { type: "revoked"; message: string }
  | { type: "room_deleted"; roomId: string }
  | { type: "room_access_revoked"; roomId: string };
