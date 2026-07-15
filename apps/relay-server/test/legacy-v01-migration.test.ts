import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { openSqlJsDb, type RelayDb } from "../src/db/sqlJsAdapter.js";
import { LEGACY_V01_SCHEMA, RELEASED_V01_SCHEMA, seedLegacyV01Data } from "./fixtures/legacyV01.js";

function columnNames(db: RelayDb, table: string): string[] {
  return (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

describe("v0.1 database migration", () => {
  it("preserves shares-only v0.1 rows when no rooms table exists", async () => {
    const db = await openSqlJsDb(":memory:");
    db.exec(`${LEGACY_V01_SCHEMA}
      alter table acl_rules rename column room_id to share_id;
      alter table files rename column room_id to share_id;
      drop table rooms;
      create table shares(id text primary key, team_id text not null, name text not null, type text not null, source_path text not null, mount_name text not null, owner_user_id text not null, created_at text not null, updated_at text not null, unique(team_id, mount_name));
      create table share_capabilities(id text primary key, share_id text not null, plugin_id text not null, display_name text not null, mode text not null, min_version text);

      insert into users values ('usr_owner', 'Owner', '2026-01-01', '2026-01-01');
      insert into users values ('usr_member', 'Member', '2026-01-01', '2026-01-01');
      insert into teams values ('team_a', 'alpha', 'Alpha', 'usr_owner', '2026-01-01', '2026-01-01');
      insert into team_members values ('team_a', 'usr_owner', 'owner', null, '2026-01-01');
      insert into devices values ('dev_owner', 'team_a', 'usr_owner', 'Mac', 'share-token-hash', null, null, '2026-01-01');
      insert into shares values ('share_a', 'team_a', 'Shared docs', 'folder', 'Shared', 'Docs', 'usr_owner', '2026-01-01', '2026-01-01');
      insert into share_capabilities values ('share_cap_a', 'share_a', 'canvas', 'Canvas', 'optional', null);
      insert into acl_rules values ('share_acl_a', 'team_a', 'share_a', 'user', 'usr_member', 'allow', '["file:read"]', '**/*', '2026-01-01');
      insert into files values ('share_file_a', 'share_a', 'note.md', 'file', 'markdown', 1, 'share-sha', 5, null, 'usr_owner', '2026-01-01', '2026-01-01');
    `);

    runMigrations(db);

    expect(db.prepare("select id, owner_user_id, mount_name from rooms where id = 'share_a'").get()).toEqual({
      id: "share_a",
      owner_user_id: "usr_owner",
      mount_name: "Docs"
    });
    expect(db.prepare("select room_id from room_capabilities where id = 'share_cap_a'").get()).toEqual({ room_id: "share_a" });
    expect(db.prepare("select room_id from acl_rules where id = 'share_acl_a'").get()).toEqual({ room_id: "share_a" });
    expect(db.prepare("select room_id, relative_path from files where id = 'share_file_a'").get()).toEqual({
      room_id: "share_a",
      relative_path: "note.md"
    });
    await db.close();
  });

  it("preserves the earliest share-scoped v0.1 rows when empty room tables already coexist", async () => {
    const db = await openSqlJsDb(":memory:");
    db.exec(`${LEGACY_V01_SCHEMA}
      alter table acl_rules rename column room_id to share_id;
      alter table files rename column room_id to share_id;
      create table shares(id text primary key, team_id text not null, name text not null, type text not null, source_path text not null, mount_name text not null, owner_user_id text not null, created_at text not null, updated_at text not null, unique(team_id, mount_name));
      create table share_capabilities(id text primary key, share_id text not null, plugin_id text not null, display_name text not null, mode text not null, min_version text);

      insert into users values ('usr_owner', 'Owner', '2026-01-01', '2026-01-01');
      insert into users values ('usr_member', 'Member', '2026-01-01', '2026-01-01');
      insert into teams values ('team_a', 'alpha', 'Alpha', 'usr_owner', '2026-01-01', '2026-01-01');
      insert into team_members values ('team_a', 'usr_owner', 'owner', null, '2026-01-01');
      insert into team_members values ('team_a', 'usr_member', 'member', null, '2026-01-01');
      insert into devices values ('dev_owner', 'team_a', 'usr_owner', 'Mac', 'share-token-hash', null, null, '2026-01-01');
      insert into shares values ('share_a', 'team_a', 'Shared docs', 'folder', 'Shared', 'Docs', 'usr_owner', '2026-01-01', '2026-01-01');
      insert into share_capabilities values ('share_cap_a', 'share_a', 'canvas', 'Canvas', 'optional', null);
      insert into acl_rules values ('share_acl_a', 'team_a', 'share_a', 'user', 'usr_member', 'allow', '["room:read","file:read"]', '**/*', '2026-01-01');
      insert into files values ('share_file_a', 'share_a', 'note.md', 'file', 'markdown', 1, 'share-sha', 5, null, 'usr_owner', '2026-01-01', '2026-01-01');
      insert into content_blobs values ('share_blob_a', 'hello', '2026-01-01');
      insert into file_versions values ('share_ver_a', 'share_file_a', 1, 'share-sha', 5, 'share_blob_a', 'usr_owner', '2026-01-01');
    `);

    runMigrations(db);

    expect(db.prepare("select id, source_path, mount_name from rooms where id = 'share_a'").get()).toEqual({
      id: "share_a",
      source_path: "Shared",
      mount_name: "Docs"
    });
    expect(columnNames(db, "files")).toContain("room_id");
    expect(columnNames(db, "files")).not.toContain("share_id");
    expect(db.prepare("select room_id, relative_path, sha256 from files where id = 'share_file_a'").get()).toEqual({
      room_id: "share_a",
      relative_path: "note.md",
      sha256: "share-sha"
    });
    expect(db.prepare("select room_id, plugin_id from room_capabilities where id = 'share_cap_a'").get()).toEqual({
      room_id: "share_a",
      plugin_id: "canvas"
    });
    expect(db.prepare("select room_id, subject_type, subject_id from acl_rules where id = 'share_acl_a'").get()).toEqual({
      room_id: "share_a",
      subject_type: "user",
      subject_id: "usr_member"
    });
    expect(db.prepare("select content_storage_key from file_versions where id = 'share_ver_a'").get()).toEqual({
      content_storage_key: "share_blob_a"
    });
    await db.close();
  });

  it("rolls back rather than silently dropping a share that conflicts with a coexisting room ID", async () => {
    const db = await openSqlJsDb(":memory:");
    db.exec(`${LEGACY_V01_SCHEMA}
      alter table acl_rules rename column room_id to share_id;
      alter table files rename column room_id to share_id;
      create table shares(id text primary key, team_id text not null, name text not null, type text not null, source_path text not null, mount_name text not null, owner_user_id text not null, created_at text not null, updated_at text not null, unique(team_id, mount_name));
      create table share_capabilities(id text primary key, share_id text not null, plugin_id text not null, display_name text not null, mode text not null, min_version text);

      insert into users values ('usr_owner', 'Owner', '2026-01-01', '2026-01-01');
      insert into teams values ('team_a', 'alpha', 'Alpha', 'usr_owner', '2026-01-01', '2026-01-01');
      insert into devices values ('dev_owner', 'team_a', 'usr_owner', 'Mac', 'share-token-hash', null, null, '2026-01-01');
      insert into rooms values ('shared_id', 'team_a', 'Room data', 'folder', 'Room', 'Room mount', 'usr_owner', '2026-01-01', '2026-01-01');
      insert into shares values ('shared_id', 'team_a', 'Different share data', 'folder', 'Share', 'Share mount', 'usr_owner', '2026-01-01', '2026-01-01');
    `);

    expect(() => runMigrations(db)).toThrow(/conflicts with coexisting room/i);
    expect(columnNames(db, "devices")).toContain("team_id");
    expect(db.prepare("select name from rooms where id = 'shared_id'").get()).toEqual({ name: "Room data" });
    expect(db.prepare("select name from shares where id = 'shared_id'").get()).toEqual({ name: "Different share data" });
    await db.close();
  });

  it("rolls back rather than silently dropping a share capability with a conflicting current ID", async () => {
    const db = await openSqlJsDb(":memory:");
    db.exec(`${LEGACY_V01_SCHEMA}
      alter table acl_rules rename column room_id to share_id;
      alter table files rename column room_id to share_id;
      create table shares(id text primary key, team_id text not null, name text not null, type text not null, source_path text not null, mount_name text not null, owner_user_id text not null, created_at text not null, updated_at text not null, unique(team_id, mount_name));
      create table share_capabilities(id text primary key, share_id text not null, plugin_id text not null, display_name text not null, mode text not null, min_version text);

      insert into users values ('usr_owner', 'Owner', '2026-01-01', '2026-01-01');
      insert into teams values ('team_a', 'alpha', 'Alpha', 'usr_owner', '2026-01-01', '2026-01-01');
      insert into devices values ('dev_owner', 'team_a', 'usr_owner', 'Mac', 'share-token-hash', null, null, '2026-01-01');
      insert into rooms values ('shared_id', 'team_a', 'Same data', 'folder', 'Shared', 'Same mount', 'usr_owner', '2026-01-01', '2026-01-01');
      insert into shares values ('shared_id', 'team_a', 'Same data', 'folder', 'Shared', 'Same mount', 'usr_owner', '2026-01-01', '2026-01-01');
      insert into room_capabilities values ('cap_id', 'shared_id', 'canvas', 'Current Canvas', 'required', null);
      insert into share_capabilities values ('cap_id', 'shared_id', 'canvas', 'Legacy Canvas', 'optional', null);
    `);

    expect(() => runMigrations(db)).toThrow(/conflicts with coexisting room capability/i);
    expect(columnNames(db, "devices")).toContain("team_id");
    expect(db.prepare("select display_name from room_capabilities where id = 'cap_id'").get()).toEqual({
      display_name: "Current Canvas"
    });
    expect(db.prepare("select display_name from share_capabilities where id = 'cap_id'").get()).toEqual({
      display_name: "Legacy Canvas"
    });
    await db.close();
  });

  it("upgrades the exact 0.1.0-0.1.5 release schema without resetting credentials or pending invites", async () => {
    const db = await openSqlJsDb(":memory:");
    db.exec(`${RELEASED_V01_SCHEMA}
      insert into users values ('usr_owner', 'Owner', null, '2026-01-01', '2026-01-01');
      insert into server_meta values ('owner_user_id', 'usr_owner');
      insert into devices values ('dev_owner', 'usr_owner', 'Mac', 'release-token-hash', null, '2026-02-01', '2026-01-01');
      insert into invites values ('inv_release', 'team_a', 'usr_owner', 'invite-hash', 'member', '2099-01-01', 5, 2, null, '2026-01-02');
    `);

    runMigrations(db);

    expect(db.prepare("select token_hash, last_seen_at, last_transport, token_security from devices where id = 'dev_owner'").get()).toEqual({
      token_hash: "release-token-hash",
      last_seen_at: "2026-02-01",
      last_transport: null,
      token_security: "plain"
    });
    expect(db.prepare("select id, team_id, room_id, token_hash, use_count from invites where id = 'inv_release'").get()).toEqual({
      id: "inv_release",
      team_id: "team_a",
      room_id: null,
      token_hash: "invite-hash",
      use_count: 2
    });
    expect(db.prepare("select value from server_meta where key = 'owner_user_id'").get()).toEqual({ value: "usr_owner" });
    expect(db.prepare("select value from server_meta where key = 'legacy_v01_migrated'").get()).toEqual({ value: "1" });
    await db.close();
  });

  it("preserves durable data and converts the team-scoped schema in place", async () => {
    const db = await openSqlJsDb(":memory:");
    db.exec(LEGACY_V01_SCHEMA);
    seedLegacyV01Data(db);

    runMigrations(db);

    expect(columnNames(db, "devices")).not.toContain("team_id");
    expect(db.prepare("select id, user_id, token_hash, last_seen_at, last_transport, token_security from devices where id = 'dev_owner'").get()).toEqual({
      id: "dev_owner",
      user_id: "usr_owner",
      token_hash: "owner-token-hash",
      last_seen_at: "2026-02-01",
      last_transport: null,
      token_security: "plain"
    });
    expect(db.prepare("select value from server_meta where key = 'owner_user_id'").get()).toEqual({ value: "usr_owner" });
    expect(db.prepare("select value from server_meta where key = 'legacy_v01_migrated'").get()).toEqual({ value: "1" });
    expect(db.prepare("select role from team_members where team_id = 'team_a' and user_id = 'usr_owner'").get()).toEqual({ role: "admin" });
    expect(db.prepare("select revoked_at from users where id = 'usr_member'").get()).toEqual({ revoked_at: null });

    expect(columnNames(db, "rooms")).not.toContain("team_id");
    expect(db.prepare("select id, owner_user_id, source_path, mount_name, conflict_policy from rooms").get()).toEqual({
      id: "room_a",
      owner_user_id: "usr_owner",
      source_path: "Shared",
      mount_name: "Docs",
      conflict_policy: "keep_both"
    });
    expect(db.prepare("select relative_path, sha256 from files").get()).toEqual({ relative_path: "note.md", sha256: "sha-a" });
    expect(db.prepare("select content from content_blobs").get()).toEqual({ content: "hello" });
    expect(db.prepare("select content_storage_key from file_versions").get()).toEqual({ content_storage_key: "blob_a" });
    expect(db.prepare("select plugin_id from room_capabilities").get()).toEqual({ plugin_id: "canvas" });

    expect(db.prepare("select id, team_id, room_id, token_hash, use_count, role from invites").get()).toEqual({
      id: "inv_a",
      team_id: "team_a",
      room_id: null,
      token_hash: "invite-token-hash",
      use_count: 2,
      role: "member"
    });
    expect(db.prepare("select team_id, action, ip_address from audit_events").get()).toEqual({
      team_id: "team_a",
      action: "room.created",
      ip_address: "127.0.0.1"
    });

    expect(db.prepare("select id, subject_type, subject_id from acl_rules where id = 'acl_user'").get()).toEqual({
      id: "acl_user",
      subject_type: "user",
      subject_id: "usr_member"
    });
    expect(db.prepare("select subject_type, subject_id, permissions_json from acl_rules where id like 'acl_role:%'").get()).toEqual({
      subject_type: "user",
      subject_id: "usr_member",
      permissions_json: '["room:read","file:read"]'
    });
    expect(db.prepare("select count(*) as count from legacy_acl_rules_v01").get()).toEqual({ count: 4 });
    expect(db.prepare("select count(*) as count from acl_rules where subject_type in ('device', 'agent')").get()).toEqual({ count: 0 });
    expect(db.prepare("select token_hash from mcp_agent_tokens where id = 'agt_a'").get()).toEqual({ token_hash: "agent-token-hash" });

    runMigrations(db);
    expect(db.prepare("select count(*) as count from devices").get()).toEqual({ count: 2 });
    expect(db.prepare("select count(*) as count from acl_rules").get()).toEqual({ count: 2 });
    expect(db.prepare("select count(*) as count from legacy_acl_rules_v01").get()).toEqual({ count: 4 });
    await db.close();
  });

  it("rolls the entire migration back when current uniqueness cannot represent legacy rows", async () => {
    const db = await openSqlJsDb(":memory:");
    db.exec(LEGACY_V01_SCHEMA);
    db.exec(`
      insert into users values ('usr_owner', 'Owner', '2026-01-01', '2026-01-01');
      insert into teams values ('team_a', 'alpha', 'Alpha', 'usr_owner', '2026-01-01', '2026-01-01');
      insert into teams values ('team_b', 'beta', 'Beta', 'usr_owner', '2026-01-02', '2026-01-02');
      insert into devices values ('dev_a', 'team_a', 'usr_owner', 'Mac', 'hash', null, null, '2026-01-01');
      insert into rooms values ('room_a', 'team_a', 'A', 'folder', 'A', 'Same', 'usr_owner', '2026-01-01', '2026-01-01');
      insert into rooms values ('room_b', 'team_b', 'B', 'folder', 'B', 'Same', 'usr_owner', '2026-01-02', '2026-01-02');
    `);

    expect(() => runMigrations(db)).toThrow(/usr_owner.*Same/i);
    expect(columnNames(db, "devices")).toContain("team_id");
    expect(db.prepare("select count(*) as count from rooms").get()).toEqual({ count: 2 });
    expect(db.prepare("select count(*) as count from users").get()).toEqual({ count: 1 });
    await db.close();
  });
});
