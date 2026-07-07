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

export type DevicePrincipalRow = {
  device_id: string;
  device_display_name: string;
  device_revoked_at: string | null;
  user_id: string;
  user_display_name: string;
  user_revoked_at: string | null;
  server_owner_id: string | null;
};

export type InviteRow = {
  id: string;
  team_id: string;
  created_by_user_id: string;
  token_hash: string;
  role: "member" | "admin";
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

