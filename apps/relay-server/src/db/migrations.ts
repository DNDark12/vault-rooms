import type { RelayDb } from "./sqlJsAdapter.js";

export function runMigrations(db: RelayDb): void {
  db.exec(`
    create table if not exists teams(
      id text primary key,
      slug text unique not null,
      name text not null,
      owner_user_id text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists users(
      id text primary key,
      display_name text not null,
      revoked_at text,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists server_meta(
      key text primary key,
      value text not null
    );

    create table if not exists team_members(
      team_id text not null,
      user_id text not null,
      role text not null,
      revoked_at text,
      created_at text not null,
      primary key(team_id, user_id)
    );

    create table if not exists devices(
      id text primary key,
      user_id text not null,
      display_name text not null,
      token_hash text not null,
      revoked_at text,
      last_seen_at text,
      created_at text not null
    );

    create table if not exists invites(
      id text primary key,
      team_id text not null,
      created_by_user_id text not null,
      token_hash text not null,
      role text not null,
      expires_at text not null,
      max_uses integer not null,
      use_count integer not null,
      revoked_at text,
      created_at text not null
    );

    create table if not exists rooms(
      id text primary key,
      name text not null,
      type text not null,
      source_path text not null,
      mount_name text not null,
      owner_user_id text not null,
      conflict_policy text not null default 'keep_both',
      created_at text not null,
      updated_at text not null,
      unique(owner_user_id, mount_name)
    );

    create table if not exists room_capabilities(
      id text primary key,
      room_id text not null,
      plugin_id text not null,
      display_name text not null,
      mode text not null,
      min_version text
    );

    create table if not exists acl_rules(
      id text primary key,
      room_id text not null,
      subject_type text not null,
      subject_id text not null,
      effect text not null,
      permissions_json text not null,
      path_pattern text not null,
      created_at text not null
    );

    create table if not exists files(
      id text primary key,
      room_id text not null,
      relative_path text not null,
      kind text not null,
      content_type text not null,
      version integer not null,
      sha256 text,
      size_bytes integer,
      deleted_at text,
      updated_by_user_id text,
      updated_at text not null,
      created_at text not null,
      unique(room_id, relative_path)
    );

    create table if not exists file_versions(
      id text primary key,
      file_id text not null,
      version integer not null,
      sha256 text not null,
      size_bytes integer not null,
      content_storage_key text not null,
      created_by_user_id text not null,
      created_at text not null,
      unique(file_id, version)
    );

    create table if not exists content_blobs(
      storage_key text primary key,
      content text not null,
      created_at text not null
    );

    create table if not exists audit_events(
      id text primary key,
      team_id text,
      actor_type text not null,
      actor_id text not null,
      action text not null,
      resource_type text not null,
      resource_id text not null,
      metadata_json text not null,
      ip_address text,
      created_at text not null
    );
  `);

  // Schema evolution for databases created before a column existed: `create table if not exists`
  // above only bootstraps brand new files, so an already-existing `rooms` table from an older
  // version of the plugin needs the new column added explicitly. Safe to run on every startup.
  addColumnIfMissing(db, "rooms", "conflict_policy", "text not null default 'keep_both'");
}

function addColumnIfMissing(db: RelayDb, table: string, column: string, definition: string): void {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existing) => existing.name === column)) {
    return;
  }
  db.exec(`alter table ${table} add column ${column} ${definition}`);
}
