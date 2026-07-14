import type { RelayDb } from "./sqlJsAdapter.js";

export function runMigrations(db: RelayDb): void {
  // Capture this before any ALTER/CREATE statements. Released v0.1 databases did not have
  // devices.team_id, but they did predate the transport-security columns; the earlier
  // team-scoped development schema had team_id. Both are v0.1 upgrade sources and both must get
  // the durable marker used by embedded restore classification.
  const upgradingV01 = isV01Schema(db);
  migrateLegacyV01Schema(db);

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
      last_transport text,
      token_security text not null default 'plain',
      created_at text not null
    );

    create table if not exists invites(
      id text primary key,
      team_id text,
      room_id text,
      permission_preset text,
      created_by_user_id text not null,
      token_hash text not null,
      role text,
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

  rebuildLegacyInvitesTable(db);

  // Schema evolution for databases created before a column existed: `create table if not exists`
  // above only bootstraps brand new files, so an already-existing `rooms` table from an older
  // version of the plugin needs the new column added explicitly. Safe to run on every startup.
  addColumnIfMissing(db, "rooms", "conflict_policy", "text not null default 'keep_both'");
  addColumnIfMissing(db, "devices", "last_transport", "text");
  addColumnIfMissing(db, "devices", "token_security", "text not null default 'plain'");
  if (upgradingV01) {
    db.prepare("insert or replace into server_meta(key, value) values ('legacy_v01_migrated', '1')").run();
  }
}

export function isV01Schema(db: RelayDb): boolean {
  const columns = db.prepare("pragma table_info(devices)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  return (
    names.has("team_id") ||
    (names.has("token_hash") && (!names.has("last_transport") || !names.has("token_security")))
  );
}

function migrateLegacyV01Schema(db: RelayDb): void {
  if (!columnExists(db, "devices", "team_id")) {
    return;
  }

  assertNoLegacyShareConflicts(db);

  const aclResourceColumn = columnExists(db, "acl_rules", "room_id") ? "room_id" : "share_id";
  const addUserRevocationColumnSql = columnExists(db, "users", "revoked_at")
    ? ""
    : "alter table users add column revoked_at text;";
  const roomsMigrationSql = columnExists(db, "rooms", "team_id")
    ? `
      alter table rooms rename to rooms_v01_source;
      create table rooms(
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
      insert into rooms(
        id, name, type, source_path, mount_name, owner_user_id,
        conflict_policy, created_at, updated_at
      )
      select id, name, type, source_path, mount_name, owner_user_id,
             'keep_both', created_at, updated_at
      from rooms_v01_source;
      drop table rooms_v01_source;
    `
    : "";
  const sharesMigrationSql = tableExists(db, "shares")
    ? `
      insert into rooms(
        id, name, type, source_path, mount_name, owner_user_id,
        conflict_policy, created_at, updated_at
      )
      select s.id, s.name, s.type, s.source_path, s.mount_name, s.owner_user_id,
             'keep_both', s.created_at, s.updated_at
      from shares s
      where not exists (select 1 from rooms r where r.id = s.id);
    `
    : "";
  const shareCapabilitiesMigrationSql = tableExists(db, "share_capabilities")
    ? `
      create table if not exists room_capabilities(
        id text primary key,
        room_id text not null,
        plugin_id text not null,
        display_name text not null,
        mode text not null,
        min_version text
      );
      insert or ignore into room_capabilities(id, room_id, plugin_id, display_name, mode, min_version)
      select id, share_id, plugin_id, display_name, mode, min_version
      from share_capabilities;
    `
    : "";
  const filesMigrationSql = columnExists(db, "files", "share_id")
    ? `
      alter table files rename to files_v01_source;
      create table files(
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
      insert into files(
        id, room_id, relative_path, kind, content_type, version, sha256,
        size_bytes, deleted_at, updated_by_user_id, updated_at, created_at
      )
      select id, share_id, relative_path, kind, content_type, version, sha256,
             size_bytes, deleted_at, updated_by_user_id, updated_at, created_at
      from files_v01_source;
      drop table files_v01_source;
    `
    : "";
  const invitesMigrationSql = columnExists(db, "invites", "room_id")
    ? ""
    : `
      alter table invites rename to invites_v01_source;
      create table invites(
        id text primary key,
        team_id text,
        room_id text,
        permission_preset text,
        created_by_user_id text not null,
        token_hash text not null,
        role text,
        expires_at text not null,
        max_uses integer not null,
        use_count integer not null,
        revoked_at text,
        created_at text not null
      );
      insert into invites(
        id, team_id, room_id, permission_preset, created_by_user_id,
        token_hash, role, expires_at, max_uses, use_count, revoked_at, created_at
      )
      select id, team_id, null, null, created_by_user_id,
             token_hash, role, expires_at, max_uses, use_count, revoked_at, created_at
      from invites_v01_source;
      drop table invites_v01_source;
    `;

  const migrate = db.transaction(() => {
    // Keep the raw ACL records even when their old subject type no longer exists in the current
    // protocol. This is archival data, not an active authorization surface.
    db.exec(`
      create table if not exists legacy_acl_rules_v01(
        id text primary key,
        team_id text not null,
        room_id text not null,
        subject_type text not null,
        subject_id text not null,
        effect text not null,
        permissions_json text not null,
        path_pattern text not null,
        created_at text not null
      );

      insert or ignore into legacy_acl_rules_v01(
        id, team_id, room_id, subject_type, subject_id, effect,
        permissions_json, path_pattern, created_at
      )
      select id, team_id, ${aclResourceColumn}, subject_type, subject_id, effect,
             permissions_json, path_pattern, created_at
      from acl_rules;

      alter table acl_rules rename to acl_rules_v01_source;
      create table acl_rules(
        id text primary key,
        room_id text not null,
        subject_type text not null,
        subject_id text not null,
        effect text not null,
        permissions_json text not null,
        path_pattern text not null,
        created_at text not null
      );

      insert into acl_rules(
        id, room_id, subject_type, subject_id, effect,
        permissions_json, path_pattern, created_at
      )
      select id, ${aclResourceColumn}, 'user', subject_id, effect,
             permissions_json, path_pattern, created_at
      from acl_rules_v01_source
      where subject_type = 'user';

      insert or ignore into acl_rules(
        id, room_id, subject_type, subject_id, effect,
        permissions_json, path_pattern, created_at
      )
      select ar.id || ':' || tm.user_id, ar.${aclResourceColumn}, 'user', tm.user_id, ar.effect,
             ar.permissions_json, ar.path_pattern, ar.created_at
      from acl_rules_v01_source ar
      join team_members tm on tm.team_id = ar.team_id and tm.revoked_at is null
      where ar.subject_type = 'role'
        and ar.subject_id in ('admin', 'member')
        and tm.role = ar.subject_id;

      insert or ignore into acl_rules(
        id, room_id, subject_type, subject_id, effect,
        permissions_json, path_pattern, created_at
      )
      select ar.id || ':' || t.owner_user_id, ar.${aclResourceColumn}, 'user', t.owner_user_id, ar.effect,
             ar.permissions_json, ar.path_pattern, ar.created_at
      from acl_rules_v01_source ar
      join teams t on t.id = ar.team_id
      where ar.subject_type = 'role' and ar.subject_id = 'owner';

      drop table acl_rules_v01_source;

      create table if not exists server_meta(
        key text primary key,
        value text not null
      );
      insert or ignore into server_meta(key, value)
      select 'owner_user_id', owner_user_id
      from teams
      order by created_at asc, id asc
      limit 1;
      insert or replace into server_meta(key, value) values ('legacy_v01_migrated', '1');

      ${addUserRevocationColumnSql}
      update team_members set role = 'admin' where role = 'owner';

      alter table devices rename to devices_v01_source;
      create table devices(
        id text primary key,
        user_id text not null,
        display_name text not null,
        token_hash text not null,
        revoked_at text,
        last_seen_at text,
        last_transport text,
        token_security text not null default 'plain',
        created_at text not null
      );
      insert into devices(
        id, user_id, display_name, token_hash, revoked_at, last_seen_at,
        last_transport, token_security, created_at
      )
      select id, user_id, display_name, token_hash, revoked_at, last_seen_at,
             null, 'plain', created_at
      from devices_v01_source;
      drop table devices_v01_source;

      ${roomsMigrationSql}
      ${sharesMigrationSql}
      ${shareCapabilitiesMigrationSql}
      ${filesMigrationSql}
      ${invitesMigrationSql}

      alter table audit_events rename to audit_events_v01_source;
      create table audit_events(
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
      insert into audit_events(
        id, team_id, actor_type, actor_id, action, resource_type,
        resource_id, metadata_json, ip_address, created_at
      )
      select id, team_id, actor_type, actor_id, action, resource_type,
             resource_id, metadata_json, ip_address, created_at
      from audit_events_v01_source;
      drop table audit_events_v01_source;
    `);
  });

  migrate();
}

function assertNoLegacyShareConflicts(db: RelayDb): void {
  if (!tableExists(db, "shares")) {
    return;
  }
  if (tableExists(db, "rooms")) {
    const roomConflict = db
      .prepare(`
        select s.id
        from shares s
        join rooms r on r.id = s.id
        where r.name is not s.name
           or r.type is not s.type
           or r.source_path is not s.source_path
           or r.mount_name is not s.mount_name
           or r.owner_user_id is not s.owner_user_id
           or r.created_at is not s.created_at
           or r.updated_at is not s.updated_at
        limit 1
      `)
      .get() as { id: string } | undefined;
    if (roomConflict) {
      throw new Error(`Legacy share ${roomConflict.id} conflicts with coexisting room data.`);
    }
  }
  if (tableExists(db, "share_capabilities") && tableExists(db, "room_capabilities")) {
    const capabilityConflict = db
      .prepare(`
        select sc.id
        from share_capabilities sc
        join room_capabilities rc on rc.id = sc.id
        where rc.room_id is not sc.share_id
           or rc.plugin_id is not sc.plugin_id
           or rc.display_name is not sc.display_name
           or rc.mode is not sc.mode
           or rc.min_version is not sc.min_version
        limit 1
      `)
      .get() as { id: string } | undefined;
    if (capabilityConflict) {
      throw new Error(
        `Legacy share capability ${capabilityConflict.id} conflicts with coexisting room capability data.`
      );
    }
  }
}

function rebuildLegacyInvitesTable(db: RelayDb): void {
  const columns = db.prepare("pragma table_info(invites)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "room_id")) {
    return;
  }
  const rebuild = db.transaction(() => {
    db.exec(`
      alter table invites rename to invites_pre_room_invites;
      create table invites(
        id text primary key,
        team_id text,
        room_id text,
        permission_preset text,
        created_by_user_id text not null,
        token_hash text not null,
        role text,
        expires_at text not null,
        max_uses integer not null,
        use_count integer not null,
        revoked_at text,
        created_at text not null
      );
      insert into invites(
        id, team_id, room_id, permission_preset, created_by_user_id,
        token_hash, role, expires_at, max_uses, use_count, revoked_at, created_at
      )
      select id, team_id, null, null, created_by_user_id,
             token_hash, role, expires_at, max_uses, use_count, revoked_at, created_at
      from invites_pre_room_invites;
      drop table invites_pre_room_invites;
    `);
  });
  rebuild();
}

function addColumnIfMissing(db: RelayDb, table: string, column: string, definition: string): void {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existing) => existing.name === column)) {
    return;
  }
  db.exec(`alter table ${table} add column ${column} ${definition}`);
}

function columnExists(db: RelayDb, table: string, column: string): boolean {
  return Boolean(db.prepare(`select 1 from pragma_table_info('${table}') where name = ?`).get(column));
}

function tableExists(db: RelayDb, table: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table));
}
