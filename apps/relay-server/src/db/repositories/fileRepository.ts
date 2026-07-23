import { createHash } from "node:crypto";
import { AppError, contentTypeForPath, createId } from "@vault-rooms/protocol";
import type { FileRow, FileVersionWithContentRow, RoomRow } from "../schema.js";
import type { RelayDb } from "../sqlJsAdapter.js";

export type FileWriteResult = {
  ok: true;
  relativePath: string;
  version: number;
  sha256: string;
  content: string;
};

export type FileDeleteResult = {
  ok: true;
  relativePath: string;
  version: number;
};

export type AuditInput = {
  teamId: string | null;
  actorType: "user" | "device" | "system";
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: unknown;
  ipAddress?: string;
};

/** Owns file metadata, content versions, tombstones, and file audit events. */
export class RelayFileRepository {
  constructor(
    private readonly db: RelayDb,
    private readonly audit: (input: AuditInput) => void,
    private readonly getRoom: (roomId: string) => RoomRow | null,
    /** Bumps `files.crdt_epoch` and purges the old epoch's CRDT update log/snapshots, as plain
     *  statements (no transaction of its own) so `deleteFile` can call it atomically with its own
     *  tombstone update (docs/superpowers/plans/2026-07-20-crdt-sync.md contract 1.5 "delete wins,
     *  bump immediately"). Safe and inert to call on a file that never had any CRDT document. */
    private readonly bumpCrdtEpochStatements: (fileId: string) => void
  ) {}

  listFiles(roomId: string): FileRow[] {
    return this.db.prepare("select * from files where room_id = ? order by relative_path asc").all(roomId) as FileRow[];
  }

  getFile(roomId: string, relativePath: string): FileRow | null {
    return (
      (this.db.prepare("select * from files where room_id = ? and relative_path = ?").get(roomId, relativePath) as FileRow | undefined) ?? null
    );
  }

  /** Looks up a file by its stable id alone, without knowing (roomId, relativePath) up front -
   *  needed by the CRDT lane (docs/superpowers/plans/2026-07-20-crdt-sync.md Phase 4), which keys
   *  its in-memory doc cache by `(fileId, epoch)` and only discovers which room/path that maps to
   *  when it needs to materialize or fan out (e.g. from an async debounce timer with no request
   *  context at hand). */
  getFileById(fileId: string): FileRow | null {
    return (this.db.prepare("select * from files where id = ?").get(fileId) as FileRow | undefined) ?? null;
  }

  readFileContent(roomId: string, relativePath: string): { file: FileRow; content: string } {
    const file = this.getFile(roomId, relativePath);
    if (!file) {
      throw new AppError("NOT_FOUND", "File not found.", 404);
    }
    if (file.deleted_at) {
      throw new AppError("FILE_DELETED", "The file has been deleted.", 404);
    }
    const version = this.latestFileVersion(file.id);
    if (!version) {
      throw new AppError("NOT_FOUND", "File content not found.", 404);
    }
    return { file, content: version.content };
  }

  writeFile(input: { roomId: string; relativePath: string; baseVersion: number; content: string; actorUserId: string }): FileWriteResult {
    const write = this.db.transaction(() => {
      const existing = this.getFile(input.roomId, input.relativePath);
      const sha256 = sha256Text(input.content);
      const sizeBytes = Buffer.byteLength(input.content, "utf8");
      const now = new Date().toISOString();
      const storageKey = `sha256:${sha256}`;

      if (input.baseVersion === 0) {
        if (existing && !existing.deleted_at) {
          throw new AppError("FILE_EXISTS", "The file already exists.", 409, { serverVersion: existing.version });
        }
        const version = existing ? existing.version + 1 : 1;
        const fileId = existing?.id ?? createId("fil");
        if (existing) {
          this.db
            .prepare("update files set version = ?, sha256 = ?, size_bytes = ?, deleted_at = null, updated_by_user_id = ?, updated_at = ? where id = ?")
            .run(version, sha256, sizeBytes, input.actorUserId, now, existing.id);
        } else {
          this.db
            .prepare(
              "insert into files(id, room_id, relative_path, kind, content_type, version, sha256, size_bytes, deleted_at, updated_by_user_id, updated_at, created_at) values (?, ?, ?, 'file', ?, ?, ?, ?, null, ?, ?, ?)"
            )
            .run(fileId, input.roomId, input.relativePath, contentTypeForPath(input.relativePath), version, sha256, sizeBytes, input.actorUserId, now, now);
        }
        this.insertFileVersion({ fileId, version, sha256, sizeBytes, storageKey, content: input.content, actorUserId: input.actorUserId, now });
        this.auditFileEvent(input.roomId, input.actorUserId, version === 1 ? "file.created" : "file.updated", fileId, input.relativePath, version);
        return { ok: true as const, relativePath: input.relativePath, version, sha256, content: input.content };
      }

      if (!existing || existing.deleted_at) {
        throw new AppError(existing?.deleted_at ? "FILE_DELETED" : "NOT_FOUND", existing?.deleted_at ? "The file has been deleted." : "File not found.", 404);
      }
      if (existing.version !== input.baseVersion) {
        const room = this.getRoom(input.roomId);
        const ownerOverride = room?.conflict_policy === "owner_wins" && room.owner_user_id === input.actorUserId;
        if (!ownerOverride) {
          throw this.versionConflict(existing);
        }
        // "owner_wins": the owner's write always becomes canonical, even though it raced in
        // behind someone else's edit - fall through and apply it on top of the file's *actual*
        // current version instead of rejecting it, so the owner isn't the one who gets forked
        // into a conflict copy on their own device just because another device's write landed
        // a moment earlier.
      }

      const version = existing.version + 1;
      this.db
        .prepare("update files set version = ?, sha256 = ?, size_bytes = ?, updated_by_user_id = ?, updated_at = ? where id = ?")
        .run(version, sha256, sizeBytes, input.actorUserId, now, existing.id);
      this.insertFileVersion({ fileId: existing.id, version, sha256, sizeBytes, storageKey, content: input.content, actorUserId: input.actorUserId, now });
      this.auditFileEvent(input.roomId, input.actorUserId, "file.updated", existing.id, input.relativePath, version);
      return { ok: true as const, relativePath: input.relativePath, version, sha256, content: input.content };
    });
    return write();
  }

  deleteFile(input: { roomId: string; relativePath: string; baseVersion: number; actorUserId: string }): FileDeleteResult {
    const remove = this.db.transaction(() => {
      const existing = this.getFile(input.roomId, input.relativePath);
      if (!existing) {
        throw new AppError("NOT_FOUND", "File not found.", 404);
      }
      if (existing.version !== input.baseVersion) {
        throw this.versionConflict(existing);
      }
      const version = existing.version + 1;
      const now = new Date().toISOString();
      this.db
        .prepare("update files set version = ?, sha256 = null, size_bytes = null, deleted_at = ?, updated_by_user_id = ?, updated_at = ? where id = ?")
        .run(version, now, input.actorUserId, now, existing.id);
      // Contract 1.5: delete wins - bump the CRDT epoch and purge the old epoch's state
      // immediately, in the same transaction as the tombstone, not deferred to a later recreate.
      // Inert (but harmless) for a file that never had a CRDT document.
      this.bumpCrdtEpochStatements(existing.id);
      this.auditFileEvent(input.roomId, input.actorUserId, "file.deleted", existing.id, input.relativePath, version);
      return { ok: true as const, relativePath: input.relativePath, version };
    });
    return remove();
  }

  /** First-create flow for the CRDT lane (contract 1.10). Distinct from `writeFile`'s
   *  `baseVersion === 0` branch: a CRDT document has no whole-file `content` to write up front (its
   *  content lives in the Y.Doc / `crdt_updates`, not `file_versions`, until the first
   *  materialization) - but an initial empty `file_versions` row is still written here so a REST
   *  `GET` immediately after `crdt_create` (before any edit/materialize) reads "" instead of 404ing.
   *  Reviving a tombstoned path reuses `existing.crdt_epoch` as-is, without bumping it again:
   *  `deleteFile` already bumped it once and purged that epoch's CRDT rows (contract 1.5 "delete
   *  wins, bump immediately"), so there is nothing left at that epoch to collide with - a second
   *  bump here would just burn an epoch number on every delete+recreate cycle for no reason, and
   *  would be inconsistent with `writeFile`'s own tombstone-revival path (contract 1.9), which also
   *  does not bump. */
  createCrdtFile(input: { roomId: string; relativePath: string; actorUserId: string }): { fileId: string; epoch: number } {
    const create = this.db.transaction(() => {
      const existing = this.getFile(input.roomId, input.relativePath);
      if (existing && !existing.deleted_at) {
        throw new AppError("FILE_EXISTS", "The file already exists.", 409, { serverVersion: existing.version });
      }
      const now = new Date().toISOString();
      const version = existing ? existing.version + 1 : 1;
      // Reviving a tombstone reuses the epoch as-is - do NOT bump again here. `deleteFile` already
      // bumped it once (contract 1.5 "delete wins, bump immediately") and purged that epoch's rows,
      // so there is nothing left at `existing.crdt_epoch` to collide with; a second bump on top of
      // that would make a plain delete+recreate cycle skip an epoch number for no reason, which
      // would break a client that expects the same code path deleteFile's own contract 1.5 test
      // already established for the CAS lane (writeFile's baseVersion===0 revival also does not
      // bump - see crdt-persistence.test.ts's "stayed at the epoch delete already bumped to").
      const epoch = existing ? existing.crdt_epoch : 0;
      const fileId = existing?.id ?? createId("fil");
      const sha256 = sha256Text("");
      const sizeBytes = 0;
      const storageKey = `sha256:${sha256}`;
      if (existing) {
        this.db
          .prepare(
            "update files set version = ?, sha256 = ?, size_bytes = ?, deleted_at = null, updated_by_user_id = ?, updated_at = ?, crdt_epoch = ? where id = ?"
          )
          .run(version, sha256, sizeBytes, input.actorUserId, now, epoch, existing.id);
      } else {
        this.db
          .prepare(
            "insert into files(id, room_id, relative_path, kind, content_type, version, sha256, size_bytes, deleted_at, updated_by_user_id, updated_at, created_at, crdt_epoch) values (?, ?, ?, 'file', ?, ?, ?, ?, null, ?, ?, ?, ?)"
          )
          .run(fileId, input.roomId, input.relativePath, contentTypeForPath(input.relativePath), version, sha256, sizeBytes, input.actorUserId, now, now, epoch);
      }
      this.insertFileVersion({ fileId, version, sha256, sizeBytes, storageKey, content: "", actorUserId: input.actorUserId, now });
      this.auditFileEvent(input.roomId, input.actorUserId, "file.crdt_created", fileId, input.relativePath, version);
      return { fileId, epoch };
    });
    return create();
  }

  /** Writes a CRDT-materialized text snapshot into `files`/`file_versions` (contract 1.6) - always
   *  unconditional, never a compare-and-swap: the CRDT lane, not this row's `version` counter, is
   *  authoritative for a CRDT-enabled document's content, so there is no "conflicting base version"
   *  concept here the way there is for `writeFile`. Returns null if the file has since been deleted
   *  or no longer exists (a materialize timer can fire after the file was removed - a no-op, not an
   *  error, since there's nothing left to materialize into). */
  materializeCrdtContent(input: { fileId: string; content: string; actorUserId: string }): { version: number; sha256: string } | null {
    const materialize = this.db.transaction(() => {
      const existing = this.db.prepare("select * from files where id = ?").get(input.fileId) as FileRow | undefined;
      if (!existing || existing.deleted_at) {
        return null;
      }
      const sha256 = sha256Text(input.content);
      const sizeBytes = Buffer.byteLength(input.content, "utf8");
      const now = new Date().toISOString();
      const storageKey = `sha256:${sha256}`;
      const version = existing.version + 1;
      this.db
        .prepare("update files set version = ?, sha256 = ?, size_bytes = ?, updated_by_user_id = ?, updated_at = ? where id = ?")
        .run(version, sha256, sizeBytes, input.actorUserId, now, existing.id);
      this.insertFileVersion({ fileId: existing.id, version, sha256, sizeBytes, storageKey, content: input.content, actorUserId: input.actorUserId, now });
      this.auditFileEvent(existing.room_id, input.actorUserId, "file.crdt_materialized", existing.id, existing.relative_path, version);
      return { version, sha256 };
    });
    return materialize();
  }

  latestFileVersion(fileId: string): FileVersionWithContentRow | null {
    return (
      (this.db
        .prepare(
          `
            select fv.*, cb.content
            from file_versions fv
            join content_blobs cb on cb.storage_key = fv.content_storage_key
            where fv.file_id = ?
            order by fv.version desc
            limit 1
          `
        )
        .get(fileId) as FileVersionWithContentRow | undefined) ?? null
    );
  }

  private insertFileVersion(input: {
    fileId: string;
    version: number;
    sha256: string;
    sizeBytes: number;
    storageKey: string;
    content: string;
    actorUserId: string;
    now: string;
  }): void {
    this.db.prepare("insert or ignore into content_blobs(storage_key, content, created_at) values (?, ?, ?)").run(input.storageKey, input.content, input.now);
    this.db
      .prepare(
        "insert into file_versions(id, file_id, version, sha256, size_bytes, content_storage_key, created_by_user_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(createId("ver"), input.fileId, input.version, input.sha256, input.sizeBytes, input.storageKey, input.actorUserId, input.now);
  }

  private versionConflict(file: FileRow): AppError {
    const latest = this.latestFileVersion(file.id);
    return new AppError("VERSION_CONFLICT", "The file changed on the server before your edit was applied.", 409, {
      serverVersion: file.version,
      serverSha256: file.sha256,
      ...(latest ? { serverContent: latest.content } : {})
    });
  }

  private auditFileEvent(roomId: string, actorUserId: string, action: string, fileId: string, relativePath: string, version: number): void {
    this.audit({
      teamId: null,
      actorType: "user",
      actorId: actorUserId,
      action,
      resourceType: "file",
      resourceId: fileId,
      metadata: { roomId, relativePath, version }
    });
  }
}

function sha256Text(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
