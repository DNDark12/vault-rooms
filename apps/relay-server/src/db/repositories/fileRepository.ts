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
    private readonly getRoom: (roomId: string) => RoomRow | null
  ) {}

  listFiles(roomId: string): FileRow[] {
    return this.db.prepare("select * from files where room_id = ? order by relative_path asc").all(roomId) as FileRow[];
  }

  getFile(roomId: string, relativePath: string): FileRow | null {
    return (
      (this.db.prepare("select * from files where room_id = ? and relative_path = ?").get(roomId, relativePath) as FileRow | undefined) ?? null
    );
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
      this.auditFileEvent(input.roomId, input.actorUserId, "file.deleted", existing.id, input.relativePath, version);
      return { ok: true as const, relativePath: input.relativePath, version };
    });
    return remove();
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
