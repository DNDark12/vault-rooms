import { createId, portablePathKey } from "@vault-rooms/protocol";
import type { FileRow } from "./schema.js";
import type { RelayDb } from "./sqlJsAdapter.js";

/** Replace exact-spelling uniqueness with portable live uniqueness without discarding any row. */
export function migratePortablePaths(db: RelayDb): void {
  if (db.prepare("select 1 from server_meta where key = 'portable_paths_v1'").get()) return;
  const rows = db.prepare("select * from files").all() as FileRow[];
  const groups = new Map<string, FileRow[]>();
  for (const file of rows) {
    if (file.deleted_at) continue;
    const key = JSON.stringify([file.room_id, portablePathKey(file.relative_path)]);
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  const collisions = new Set([...groups.values()].filter(group => group.length > 1).flatMap(group => group.map(file => file.id)));
  const tombstoneFloors = new Map<string, number>();
  for (const file of rows) {
    if (!file.deleted_at) continue;
    const key = JSON.stringify([file.room_id, portablePathKey(file.relative_path)]);
    tombstoneFloors.set(key, Math.max(tombstoneFloors.get(key) ?? 0, file.version));
  }
  const now = new Date().toISOString();
  db.transaction(() => {
    db.exec(`
      create table if not exists portable_path_migration_backup(
        file_id text primary key, metadata_json text not null, migrated_at text not null
      );
      create table files_portable(
        id text primary key, room_id text not null, relative_path text not null,
        kind text not null, content_type text not null, version integer not null,
        sha256 text, size_bytes integer, deleted_at text, updated_by_user_id text,
        updated_at text not null, created_at text not null,
        crdt_epoch integer not null default 0, raw_size_bytes integer,
        path_key text not null check(length(path_key) > 0),
        path_collision integer not null default 0 check(path_collision in (0, 1))
      );
    `);
    for (const file of rows) {
      const floor = tombstoneFloors.get(JSON.stringify([file.room_id, portablePathKey(file.relative_path)])) ?? 0;
      const version = !file.deleted_at && !collisions.has(file.id) ? Math.max(file.version, floor + 1) : file.version;
      db.prepare("insert into portable_path_migration_backup values (?, ?, ?)").run(file.id, JSON.stringify(file), now);
      db.prepare("insert into files_portable values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        file.id, file.room_id, file.relative_path, file.kind, file.content_type, version,
        file.sha256, file.size_bytes, file.deleted_at, file.updated_by_user_id, file.updated_at,
        file.created_at, file.crdt_epoch, file.raw_size_bytes, portablePathKey(file.relative_path), collisions.has(file.id) ? 1 : 0
      );
      if (version !== file.version) {
        db.prepare("insert into file_versions(id, file_id, version, sha256, size_bytes, content_storage_key, created_by_user_id, created_at, blob_key, raw_size_bytes) select ?, file_id, ?, sha256, size_bytes, content_storage_key, created_by_user_id, ?, blob_key, raw_size_bytes from file_versions where file_id = ? and version = ?")
          .run(createId("ver"), version, now, file.id, file.version);
        db.prepare("insert into audit_events(id, team_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, ip_address, created_at) values (?, null, 'system', 'relay', 'file.portable_version_advanced', 'file', ?, ?, null, ?)")
          .run(createId("aud"), file.id, JSON.stringify({ fromVersion: file.version, version, pathKey: portablePathKey(file.relative_path) }), now);
      }
    }
    db.exec(`
      drop table files;
      alter table files_portable rename to files;
      create index idx_files_path_key on files(room_id, path_key);
      create unique index idx_files_portable_live on files(room_id, path_key)
        where deleted_at is null and path_collision = 0;
      create trigger files_portable_quarantine_insert before insert on files
        when new.deleted_at is null and new.path_collision = 0 and exists(
          select 1 from files where room_id = new.room_id and path_key = new.path_key and deleted_at is null and path_collision = 1
        ) begin select raise(abort, 'PATH_COLLISION'); end;
      create trigger files_portable_quarantine_update before update on files
        when new.deleted_at is null and new.path_collision = 0 and exists(
          select 1 from files where id != new.id and room_id = new.room_id and path_key = new.path_key and deleted_at is null and path_collision = 1
        ) begin select raise(abort, 'PATH_COLLISION'); end;
    `);
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      db.prepare("insert into audit_events(id, team_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, ip_address, created_at) values (?, null, 'system', 'relay', 'file.path_collision_detected', 'room', ?, ?, null, ?)").run(
        createId("aud"), group[0]!.room_id, JSON.stringify({ pathKey: portablePathKey(group[0]!.relative_path), files: group.map(file => ({ fileId: file.id, relativePath: file.relative_path })) }), now
      );
    }
    db.prepare("insert into server_meta values ('portable_paths_v1', '1')").run();
  })();
}
