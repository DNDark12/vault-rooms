import type { TeamRole } from "@vault-rooms/protocol";

export type TeamRow = {
  id: string;
  slug: string;
  name: string;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
};

export type UserRow = {
  id: string;
  display_name: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DeviceRow = {
  id: string;
  user_id: string;
  display_name: string;
  revoked_at: string | null;
  last_seen_at: string | null;
  last_transport: "http" | "https" | null;
  token_security: "plain" | "tls";
  created_at: string;
};

export type DevicePrincipalRow = {
  device_id: string;
  device_display_name: string;
  device_revoked_at: string | null;
  user_id: string;
  user_display_name: string;
  user_revoked_at: string | null;
  server_owner_id: string | null;
  token_security: "plain" | "tls";
};

export type InviteRow = {
  id: string;
  team_id: string | null;
  room_id: string | null;
  permission_preset: "reader" | "editor" | null;
  created_by_user_id: string;
  token_hash: string;
  role: "member" | "admin" | null;
  expires_at: string;
  max_uses: number;
  use_count: number;
  revoked_at: string | null;
  created_at: string;
};

export type MemberRow = {
  user_id: string;
  display_name: string;
  role: TeamRole;
  revoked_at: string | null;
};

export type RoomRow = {
  id: string;
  name: string;
  type: "file" | "folder";
  source_path: string;
  mount_name: string;
  owner_user_id: string;
  conflict_policy: "keep_both" | "owner_wins";
  created_at: string;
  updated_at: string;
  /** CRDT sync opt-in flag (docs/superpowers/plans/2026-07-20-crdt-sync.md contract 1.11). SQLite
   *  boolean (0/1), default 0. Only `.md` files in a room with this set to 1 use the CRDT lane;
   *  everything else stays on the whole-file compare-and-swap lane. */
  crdt_enabled: 0 | 1;
};

export type RoomCapabilityRow = {
  id: string;
  room_id: string;
  plugin_id: string;
  display_name: string;
  mode: "required" | "recommended" | "optional";
  min_version: string | null;
};

export type AclRuleRow = {
  id: string;
  room_id: string;
  subject_type: "user" | "team";
  subject_id: string;
  effect: "allow" | "deny";
  permissions_json: string;
  path_pattern: string;
  created_at: string;
};

export type FileRow = {
  id: string;
  room_id: string;
  relative_path: string;
  kind: "file" | "folder";
  content_type: "markdown" | "text";
  version: number;
  sha256: string | null;
  size_bytes: number | null;
  deleted_at: string | null;
  updated_by_user_id: string | null;
  updated_at: string;
  created_at: string;
  /** Authoritative CRDT document epoch for this file (contract 1.9). Lives on the FileRow itself
   *  (not in crdt_updates/crdt_snapshots) specifically so it survives purging those tables - after
   *  a delete or recreate-at-same-path bumps it, the server never loses track of the current/next
   *  epoch even though the old epoch's update log and snapshots are gone. Default 0; bumped
   *  immediately on file delete (contract 1.5 "delete wins"), not deferred to recreate. */
  crdt_epoch: number;
};

export type CrdtUpdateRow = {
  id: string;
  file_id: string;
  epoch: number;
  seq: number;
  update_blob: string;
  created_at: string;
};

export type CrdtSnapshotRow = {
  id: string;
  file_id: string;
  epoch: number;
  state_vector: string;
  snapshot_blob: string;
  up_to_seq: number;
  created_at: string;
};

export type FileVersionWithContentRow = {
  id: string;
  file_id: string;
  version: number;
  sha256: string;
  size_bytes: number;
  content_storage_key: string;
  created_by_user_id: string;
  created_at: string;
  content: string;
};

export type AuditEventRow = {
  id: string;
  team_id: string | null;
  actor_type: "user" | "device" | "system";
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata_json: string;
  ip_address: string | null;
  created_at: string;
};
