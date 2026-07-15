import type { RelayDb } from "../../src/db/sqlJsAdapter.js";

/** Exact durable schema shape shipped by tags 0.1.0-0.1.5. Tag 0.1.6 migrated
 * `invites` to its nullable current shape but left every other table unchanged. */
export const RELEASED_V01_SCHEMA = `
  create table teams(id text primary key, slug text unique not null, name text not null, owner_user_id text not null, created_at text not null, updated_at text not null);
  create table users(id text primary key, display_name text not null, revoked_at text, created_at text not null, updated_at text not null);
  create table server_meta(key text primary key, value text not null);
  create table team_members(team_id text not null, user_id text not null, role text not null, revoked_at text, created_at text not null, primary key(team_id, user_id));
  create table devices(id text primary key, user_id text not null, display_name text not null, token_hash text not null, revoked_at text, last_seen_at text, created_at text not null);
  create table invites(id text primary key, team_id text not null, created_by_user_id text not null, token_hash text not null, role text not null, expires_at text not null, max_uses integer not null, use_count integer not null, revoked_at text, created_at text not null);
  create table rooms(id text primary key, name text not null, type text not null, source_path text not null, mount_name text not null, owner_user_id text not null, conflict_policy text not null default 'keep_both', created_at text not null, updated_at text not null, unique(owner_user_id, mount_name));
  create table room_capabilities(id text primary key, room_id text not null, plugin_id text not null, display_name text not null, mode text not null, min_version text);
  create table acl_rules(id text primary key, room_id text not null, subject_type text not null, subject_id text not null, effect text not null, permissions_json text not null, path_pattern text not null, created_at text not null);
  create table files(id text primary key, room_id text not null, relative_path text not null, kind text not null, content_type text not null, version integer not null, sha256 text, size_bytes integer, deleted_at text, updated_by_user_id text, updated_at text not null, created_at text not null, unique(room_id, relative_path));
  create table file_versions(id text primary key, file_id text not null, version integer not null, sha256 text not null, size_bytes integer not null, content_storage_key text not null, created_by_user_id text not null, created_at text not null, unique(file_id, version));
  create table content_blobs(storage_key text primary key, content text not null, created_at text not null);
  create table audit_events(id text primary key, team_id text, actor_type text not null, actor_id text not null, action text not null, resource_type text not null, resource_id text not null, metadata_json text not null, ip_address text, created_at text not null);
`;

export const LEGACY_V01_SCHEMA = `
  create table teams(id text primary key, slug text unique not null, name text not null, owner_user_id text not null, created_at text not null, updated_at text not null);
  create table users(id text primary key, display_name text not null, created_at text not null, updated_at text not null);
  create table team_members(team_id text not null, user_id text not null, role text not null, revoked_at text, created_at text not null, primary key(team_id, user_id));
  create table devices(id text primary key, team_id text not null, user_id text not null, display_name text not null, token_hash text not null, revoked_at text, last_seen_at text, created_at text not null);
  create table invites(id text primary key, team_id text not null, created_by_user_id text not null, token_hash text not null, role text not null, expires_at text not null, max_uses integer not null, use_count integer not null, revoked_at text, created_at text not null);
  create table rooms(id text primary key, team_id text not null, name text not null, type text not null, source_path text not null, mount_name text not null, owner_user_id text not null, created_at text not null, updated_at text not null, unique(team_id, mount_name));
  create table room_capabilities(id text primary key, room_id text not null, plugin_id text not null, display_name text not null, mode text not null, min_version text);
  create table acl_rules(id text primary key, team_id text not null, room_id text not null, subject_type text not null, subject_id text not null, effect text not null, permissions_json text not null, path_pattern text not null, created_at text not null);
  create table files(id text primary key, room_id text not null, relative_path text not null, kind text not null, content_type text not null, version integer not null, sha256 text, size_bytes integer, deleted_at text, updated_by_user_id text, updated_at text not null, created_at text not null, unique(room_id, relative_path));
  create table file_versions(id text primary key, file_id text not null, version integer not null, sha256 text not null, size_bytes integer not null, content_storage_key text not null, created_by_user_id text not null, created_at text not null, unique(file_id, version));
  create table content_blobs(storage_key text primary key, content text not null, created_at text not null);
  create table audit_events(id text primary key, team_id text not null, actor_type text not null, actor_id text not null, action text not null, resource_type text not null, resource_id text not null, metadata_json text not null, ip_address text, created_at text not null);
  create table mcp_agent_tokens(id text primary key, team_id text not null, user_id text not null, display_name text not null, token_hash text not null, revoked_at text, created_at text not null);
`;

export const LEGACY_V01_DATA = `
    insert into users values ('usr_owner', 'Owner', '2026-01-01', '2026-01-02');
    insert into users values ('usr_member', 'Member', '2026-01-03', '2026-01-04');
    insert into teams values ('team_a', 'alpha', 'Alpha', 'usr_owner', '2026-01-01', '2026-01-02');
    insert into team_members values ('team_a', 'usr_owner', 'owner', null, '2026-01-01');
    insert into team_members values ('team_a', 'usr_member', 'member', null, '2026-01-03');
    insert into devices values ('dev_owner', 'team_a', 'usr_owner', 'Owner Mac', 'owner-token-hash', null, '2026-02-01', '2026-01-01');
    insert into devices values ('dev_member', 'team_a', 'usr_member', 'Member Mac', 'member-token-hash', null, null, '2026-01-03');
    insert into invites values ('inv_a', 'team_a', 'usr_owner', 'invite-token-hash', 'member', '2099-01-01', 5, 2, null, '2026-01-05');
    insert into rooms values ('room_a', 'team_a', 'Docs', 'folder', 'Shared', 'Docs', 'usr_owner', '2026-01-06', '2026-01-07');
    insert into room_capabilities values ('cap_a', 'room_a', 'canvas', 'Canvas', 'optional', null);
    insert into acl_rules values ('acl_user', 'team_a', 'room_a', 'user', 'usr_member', 'deny', '["file:write"]', 'private/**/*', '2026-01-08');
    insert into acl_rules values ('acl_role', 'team_a', 'room_a', 'role', 'member', 'allow', '["room:read","file:read"]', '**/*', '2026-01-09');
    insert into acl_rules values ('acl_device', 'team_a', 'room_a', 'device', 'dev_member', 'allow', '["file:write"]', '**/*', '2026-01-10');
    insert into acl_rules values ('acl_agent', 'team_a', 'room_a', 'agent', 'agt_a', 'allow', '["file:read"]', '**/*', '2026-01-11');
    insert into files values ('file_a', 'room_a', 'note.md', 'file', 'markdown', 1, 'sha-a', 5, null, 'usr_owner', '2026-01-12', '2026-01-12');
    insert into content_blobs values ('blob_a', 'hello', '2026-01-12');
    insert into file_versions values ('ver_a', 'file_a', 1, 'sha-a', 5, 'blob_a', 'usr_owner', '2026-01-12');
    insert into audit_events values ('aud_a', 'team_a', 'user', 'usr_owner', 'room.created', 'room', 'room_a', '{}', '127.0.0.1', '2026-01-12');
    insert into mcp_agent_tokens values ('agt_a', 'team_a', 'usr_owner', 'Old agent', 'agent-token-hash', null, '2026-01-12');
`;

export function seedLegacyV01Data(db: RelayDb): void {
  db.exec(LEGACY_V01_DATA);
}
