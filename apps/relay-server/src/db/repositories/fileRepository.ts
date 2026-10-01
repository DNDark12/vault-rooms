import { createHash } from "node:crypto";
import { AppError, contentTypeForPath, createId, isCrdtEligiblePath, type ContentType } from "@vault-rooms/protocol";
import type { CrdtOperationReceiptRow, FileRow, FileVersionWithContentRow, RoomRow } from "../schema.js";
import type { RelayDb } from "../sqlJsAdapter.js";

export type FileWriteResult = {
  ok: true;
  relativePath: string;
  version: number;
  sha256: string;
  content: string;
  orphanedBlobKeys?: string[];
};

export type FileDeleteResult = {
  ok: true;
  relativePath: string;
  version: number;
  orphanedBlobKeys?: string[];
};

export type FileRenameResult = {
  ok: true;
  oldRelativePath: string;
  relativePath: string;
  epoch: number;
};

export type CrdtCreateResult = {
  fileId: string;
  epoch: number;
  relativePath: string;
};

export type IdempotentCrdtCreateResult = {
  result: CrdtCreateResult;
  adopted: boolean;
  replayed: boolean;
};

export type IdempotentCrdtRenameResult = {
  result: FileRenameResult;
  replayed: boolean;
};

export type CrdtRenameInput = {
  roomId: string;
  oldRelativePath: string;
  relativePath: string;
  actorUserId: string;
  actorDisplayName?: string;
};

export type CrdtCreateInput = {
  roomId: string;
  relativePath: string;
  actorUserId: string;
  actorDisplayName?: string;
  adoptIfExists?: boolean;
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

export type LegacyContentReference = {
  versionId: string;
  fileId: string;
  fileVersion: number;
  contentStorageKey: string;
  contentType: ContentType;
  content: string;
};

/** Owns file metadata, content versions, tombstones, and file audit events. */
export class RelayFileRepository {
  constructor(
    private readonly db: RelayDb,
    private readonly audit: (input: AuditInput) => void,
    private readonly getRoom: (roomId: string) => RoomRow | null,
    /** Bumps the CRDT epoch and purges prior state within the caller's transaction. */
    private readonly bumpCrdtEpochStatements: (fileId: string) => void,
    /** Stored-content ceiling enforced inside write transactions. */
    private readonly maxStoredContentBytes: number
  ) {}

  listFiles(roomId: string): FileRow[] {
    return this.db.prepare("select * from files where room_id = ? order by relative_path asc").all(roomId) as FileRow[];
  }

  getFile(roomId: string, relativePath: string): FileRow | null {
    return (
      (this.db.prepare("select * from files where room_id = ? and relative_path = ?").get(roomId, relativePath) as FileRow | undefined) ?? null
    );
  }

  /** Looks up a file by stable ID for CRDT materialization and fanout. */
  getFileById(fileId: string): FileRow | null {
    return (this.db.prepare("select * from files where id = ?").get(fileId) as FileRow | undefined) ?? null;
  }

  readFileContent(roomId: string, relativePath: string): { file: FileRow; content: string | null; blobKey: string | null } {
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
    return { file, content: version.content, blobKey: version.blob_key };
  }

  writeFile(input: {
    roomId: string;
    relativePath: string;
    baseVersion: number;
    content: string;
    actorUserId: string;
    /** Raw-byte key already finalized by ContentWriteService. */
    blobKey?: string;
    /** A whole-file-lane write: rechecked here, as it commits, against the room switching this note
     *  to live editing after the request's own check. */
    wholeFileLane?: boolean;
  }): FileWriteResult {
    const write = this.db.transaction(() => {
      if (input.wholeFileLane && isCrdtEligiblePath(input.relativePath) && this.getRoom(input.roomId)?.crdt_enabled) {
        throw new AppError("CRDT_WRITE_UNSUPPORTED", "This note uses live editing - update the plugin to edit it.", 409);
      }
      const existing = this.getFile(input.roomId, input.relativePath);
      const sha256 = sha256Text(input.content);
      const sizeBytes = Buffer.byteLength(input.content, "utf8");
      const contentType = contentTypeForPath(input.relativePath);
      const rawSizeBytes = this.decodedByteLength(input.content, contentType);
      const now = new Date().toISOString();
      const storageKey = input.blobKey ? `blob:${input.blobKey}` : `sha256:${sha256}`;
      const storedBytes = input.blobKey ? rawSizeBytes : sizeBytes;

      if (input.baseVersion === 0) {
        if (existing && !existing.deleted_at) {
          throw new AppError("FILE_EXISTS", "The file already exists.", 409, { serverVersion: existing.version });
        }
        const version = existing ? existing.version + 1 : 1;
        const fileId = existing?.id ?? createId("fil");
        this.assertQuotaAllows(existing?.id ?? null, version, storageKey, input.blobKey ?? null, storedBytes);
        if (existing) {
          this.db
            .prepare(
              "update files set version = ?, sha256 = ?, size_bytes = ?, raw_size_bytes = ?, deleted_at = null, updated_by_user_id = ?, updated_at = ? where id = ?"
            )
            .run(version, sha256, sizeBytes, rawSizeBytes, input.actorUserId, now, existing.id);
        } else {
          this.db
            .prepare(
              "insert into files(id, room_id, relative_path, kind, content_type, version, sha256, size_bytes, raw_size_bytes, deleted_at, updated_by_user_id, updated_at, created_at) values (?, ?, ?, 'file', ?, ?, ?, ?, ?, null, ?, ?, ?)"
            )
            .run(fileId, input.roomId, input.relativePath, contentType, version, sha256, sizeBytes, rawSizeBytes, input.actorUserId, now, now);
        }
        const orphanedBlobKeys = this.insertFileVersion({ fileId, version, sha256, sizeBytes, rawSizeBytes, storageKey, content: input.content, actorUserId: input.actorUserId, now, blobKey: input.blobKey });
        this.auditFileEvent(input.roomId, input.actorUserId, version === 1 ? "file.created" : "file.updated", fileId, input.relativePath, version);
        return { ok: true as const, relativePath: input.relativePath, version, sha256, content: input.content, ...(orphanedBlobKeys.length ? { orphanedBlobKeys } : {}) };
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
      this.assertQuotaAllows(existing.id, version, storageKey, input.blobKey ?? null, storedBytes);
      this.db
        .prepare(
          "update files set version = ?, sha256 = ?, size_bytes = ?, raw_size_bytes = ?, updated_by_user_id = ?, updated_at = ? where id = ?"
        )
        .run(version, sha256, sizeBytes, rawSizeBytes, input.actorUserId, now, existing.id);
      const orphanedBlobKeys = this.insertFileVersion({ fileId: existing.id, version, sha256, sizeBytes, rawSizeBytes, storageKey, content: input.content, actorUserId: input.actorUserId, now, blobKey: input.blobKey });
      this.auditFileEvent(input.roomId, input.actorUserId, "file.updated", existing.id, input.relativePath, version);
      return { ok: true as const, relativePath: input.relativePath, version, sha256, content: input.content, ...(orphanedBlobKeys.length ? { orphanedBlobKeys } : {}) };
    });
    return write();
  }

  deleteFile(input: {
    roomId: string;
    relativePath: string;
    baseVersion: number;
    actorUserId: string;
    /** Skips CAS version checks when CRDT owns the content version. */
    crdtAuthoritative?: boolean;
  }): FileDeleteResult {
    const remove = this.db.transaction(() => {
      const existing = this.getFile(input.roomId, input.relativePath);
      if (!existing) {
        throw new AppError("NOT_FOUND", "File not found.", 404);
      }
      if (!input.crdtAuthoritative && existing.version !== input.baseVersion) {
        throw this.versionConflict(existing);
      }
      const version = existing.version + 1;
      const now = new Date().toISOString();
      this.db
        .prepare("update files set version = ?, sha256 = null, size_bytes = null, raw_size_bytes = null, deleted_at = ?, updated_by_user_id = ?, updated_at = ? where id = ?")
        .run(version, now, input.actorUserId, now, existing.id);
      // Deletion invalidates the current CRDT epoch before removing version data.
      this.bumpCrdtEpochStatements(existing.id);
      // Tombstones retain no history; shared blobs remain reference-checked.
      const orphanedBlobKeys = this.deleteAllVersionsAndCollectBlobs(existing.id);
      this.auditFileEvent(input.roomId, input.actorUserId, "file.deleted", existing.id, input.relativePath, version);
      return { ok: true as const, relativePath: input.relativePath, version, ...(orphanedBlobKeys.length ? { orphanedBlobKeys } : {}) };
    });
    return remove();
  }

  /** Renames a CRDT file without changing its identity, epoch, or content version. */
  renameFile(input: CrdtRenameInput): FileRenameResult {
    return this.db.transaction(() => this.renameFileStatements(input))();
  }

  renameCrdtFileIdempotent(input: CrdtRenameInput & { operationId: string; deviceId: string }): IdempotentCrdtRenameResult {
    assertValidOperationId(input.operationId);
    return this.db.transaction(() => {
      const payloadHash = structuralPayloadHash("rename", [input.oldRelativePath, input.relativePath]);
      const receipt = this.getCrdtOperationReceipt(input.roomId, input.operationId);
      if (receipt) {
        this.assertMatchingReceipt(receipt, input.deviceId, "rename", payloadHash);
        return { result: JSON.parse(receipt.result_json) as FileRenameResult, replayed: true };
      }
      this.assertOperationIdUnusedInOtherRoom(input.roomId, input.operationId);
      const result = this.renameFileStatements(input);
      this.insertCrdtOperationReceipt({
        roomId: input.roomId,
        operationId: input.operationId,
        deviceId: input.deviceId,
        operationKind: "rename",
        payloadHash,
        result
      });
      return { result, replayed: false };
    })();
  }

  private renameFileStatements(input: CrdtRenameInput): FileRenameResult {
      const existing = this.getFile(input.roomId, input.oldRelativePath);
      if (!existing || existing.deleted_at) {
        throw new AppError(existing?.deleted_at ? "FILE_DELETED" : "NOT_FOUND", existing?.deleted_at ? "The file has been deleted." : "File not found.", 404);
      }
      // User-authored rename targets are never auto-disambiguated.
      const targetPath = input.relativePath;
      const moves = input.oldRelativePath !== targetPath;
      // Clients keep versions per path and ignore anything at or below the one they last saw there, so
      // a path's version must never go backwards - on either side of the move.
      let version = existing.version;
      if (moves) {
        const conflict = this.getFile(input.roomId, targetPath);
        if (conflict && !conflict.deleted_at) {
          throw new AppError("FILE_EXISTS", "A file already exists at the new path.", 409, { serverVersion: conflict.version });
        }
        if (conflict) {
          // Remove the tombstone occupying the unique path slot, landing above its version.
          version = Math.max(version, conflict.version + 1);
          this.bumpCrdtEpochStatements(conflict.id);
          this.deleteAllVersionsAndCollectBlobs(conflict.id);
          this.db.prepare("delete from files where id = ?").run(conflict.id);
        }
      }
      const now = new Date().toISOString();
      this.db
        .prepare("update files set relative_path = ?, content_type = ?, version = ?, updated_by_user_id = ?, updated_at = ? where id = ?")
        .run(targetPath, contentTypeForPath(targetPath), version, input.actorUserId, now, existing.id);
      if (version !== existing.version) {
        this.db.prepare("update file_versions set version = ? where file_id = ? and version = ?").run(version, existing.id, existing.version);
      }
      if (moves) {
        // A tombstone newer than anything seen at the old path, so a file created there later continues
        // above it rather than restarting at version 1.
        this.db
          .prepare(
            "insert into files(id, room_id, relative_path, kind, content_type, version, sha256, size_bytes, raw_size_bytes, deleted_at, updated_by_user_id, updated_at, created_at) values (?, ?, ?, 'file', ?, ?, null, null, 0, ?, ?, ?, ?)"
          )
          .run(createId("fil"), input.roomId, input.oldRelativePath, contentTypeForPath(input.oldRelativePath), existing.version + 1, now, input.actorUserId, now, now);
      }
      this.auditFileEvent(input.roomId, input.actorUserId, "file.renamed", existing.id, targetPath, version);
      return { ok: true as const, oldRelativePath: input.oldRelativePath, relativePath: targetPath, epoch: existing.crdt_epoch };
  }

  /** Creates an empty CRDT file row or revives its already-bumped epoch. */
  createCrdtFile(input: CrdtCreateInput): CrdtCreateResult {
    return this.db.transaction(() => this.createCrdtFileStatements(input))();
  }

  replayCrdtCreateReceipt(input: {
    roomId: string;
    relativePath: string;
    adoptIfExists?: boolean;
    operationId: string;
    deviceId: string;
  }): { result: CrdtCreateResult; adopted: boolean } | null {
    assertValidOperationId(input.operationId);
    const receipt = this.getCrdtOperationReceipt(input.roomId, input.operationId);
    if (!receipt) {
      this.assertOperationIdUnusedInOtherRoom(input.roomId, input.operationId);
      return null;
    }
    this.assertMatchingReceipt(
      receipt,
      input.deviceId,
      "create",
      structuralPayloadHash("create", [input.relativePath, input.adoptIfExists === true])
    );
    return JSON.parse(receipt.result_json) as { result: CrdtCreateResult; adopted: boolean };
  }

  createCrdtFileIdempotent(input: CrdtCreateInput & { operationId: string; deviceId: string }): IdempotentCrdtCreateResult {
    assertValidOperationId(input.operationId);
    return this.db.transaction(() => {
      const payloadHash = structuralPayloadHash("create", [input.relativePath, input.adoptIfExists === true]);
      const receipt = this.getCrdtOperationReceipt(input.roomId, input.operationId);
      if (receipt) {
        this.assertMatchingReceipt(receipt, input.deviceId, "create", payloadHash);
        const recorded = JSON.parse(receipt.result_json) as { result: CrdtCreateResult; adopted: boolean };
        return { ...recorded, replayed: true };
      }
      this.assertOperationIdUnusedInOtherRoom(input.roomId, input.operationId);
      const existingBeforeCreate = this.getFile(input.roomId, input.relativePath);
      const result = this.createCrdtFileStatements(input);
      const adopted = Boolean(existingBeforeCreate && !existingBeforeCreate.deleted_at && result.fileId === existingBeforeCreate.id);
      this.insertCrdtOperationReceipt({
        roomId: input.roomId,
        operationId: input.operationId,
        deviceId: input.deviceId,
        operationKind: "create",
        payloadHash,
        result: { result, adopted }
      });
      return { result, adopted, replayed: false };
    })();
  }

  private createCrdtFileStatements(input: CrdtCreateInput): CrdtCreateResult {
      // New-note collisions disambiguate; existing notes adopt their document.
      const live = this.getFile(input.roomId, input.relativePath);
      if (input.adoptIfExists && live && !live.deleted_at) {
        return { fileId: live.id, epoch: live.crdt_epoch, relativePath: input.relativePath };
      }
      const relativePath = this.freeCrdtPath(input.roomId, input.relativePath, input.actorDisplayName);
      const existing = this.getFile(input.roomId, relativePath);
      const now = new Date().toISOString();
      const version = existing ? existing.version + 1 : 1;
      // Deletion already bumped the epoch before tombstone revival.
      const epoch = existing ? existing.crdt_epoch : 0;
      const fileId = existing?.id ?? createId("fil");
      const sha256 = sha256Text("");
      const sizeBytes = 0;
      const rawSizeBytes = 0;
      const storageKey = `sha256:${sha256}`;
      if (existing) {
        this.db
          .prepare(
            "update files set version = ?, sha256 = ?, size_bytes = ?, raw_size_bytes = ?, deleted_at = null, updated_by_user_id = ?, updated_at = ?, crdt_epoch = ? where id = ?"
          )
          .run(version, sha256, sizeBytes, rawSizeBytes, input.actorUserId, now, epoch, existing.id);
      } else {
        this.db
          .prepare(
            "insert into files(id, room_id, relative_path, kind, content_type, version, sha256, size_bytes, raw_size_bytes, deleted_at, updated_by_user_id, updated_at, created_at, crdt_epoch) values (?, ?, ?, 'file', ?, ?, ?, ?, ?, null, ?, ?, ?, ?)"
          )
          .run(fileId, input.roomId, relativePath, contentTypeForPath(relativePath), version, sha256, sizeBytes, rawSizeBytes, input.actorUserId, now, now, epoch);
      }
      this.insertFileVersion({ fileId, version, sha256, sizeBytes, rawSizeBytes, storageKey, content: "", actorUserId: input.actorUserId, now });
      this.auditFileEvent(input.roomId, input.actorUserId, "file.crdt_created", fileId, relativePath, version);
      return { fileId, epoch, relativePath };
  }

  replayCrdtRenameReceipt(input: {
    roomId: string;
    oldRelativePath: string;
    relativePath: string;
    operationId: string;
    deviceId: string;
  }): FileRenameResult | null {
    assertValidOperationId(input.operationId);
    const receipt = this.getCrdtOperationReceipt(input.roomId, input.operationId);
    if (!receipt) {
      this.assertOperationIdUnusedInOtherRoom(input.roomId, input.operationId);
      return null;
    }
    this.assertMatchingReceipt(
      receipt,
      input.deviceId,
      "rename",
      structuralPayloadHash("rename", [input.oldRelativePath, input.relativePath])
    );
    return JSON.parse(receipt.result_json) as FileRenameResult;
  }

  private getCrdtOperationReceipt(roomId: string, operationId: string): CrdtOperationReceiptRow | null {
    return (
      (this.db
        .prepare("select * from crdt_operation_receipts where room_id = ? and operation_id = ?")
        .get(roomId, operationId) as CrdtOperationReceiptRow | undefined) ?? null
    );
  }

  private assertMatchingReceipt(
    receipt: CrdtOperationReceiptRow,
    deviceId: string,
    operationKind: "create" | "rename",
    payloadHash: string
  ): void {
    if (receipt.device_id !== deviceId) {
      throw new AppError(
        "CRDT_OPERATION_DEVICE_MISMATCH",
        "This CRDT operation receipt belongs to another device.",
        409
      );
    }
    if (receipt.operation_kind !== operationKind || receipt.payload_hash !== payloadHash) {
      throw new AppError(
        "VALIDATION_ERROR",
        "This operation ID was already used for a different CRDT mutation.",
        422
      );
    }
  }

  private assertOperationIdUnusedInOtherRoom(roomId: string, operationId: string): void {
    const receipt = this.db
      .prepare("select room_id from crdt_operation_receipts where operation_id = ? and room_id != ? limit 1")
      .get(operationId, roomId);
    if (receipt) {
      throw new AppError(
        "VALIDATION_ERROR",
        "This operation ID was already used for a different CRDT mutation.",
        422
      );
    }
  }

  private insertCrdtOperationReceipt(input: {
    roomId: string;
    operationId: string;
    deviceId: string;
    operationKind: "create" | "rename";
    payloadHash: string;
    result: unknown;
  }): void {
    this.db
      .prepare(
        "insert into crdt_operation_receipts(room_id, operation_id, device_id, operation_kind, payload_hash, result_json, created_at) values (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.roomId,
        input.operationId,
        input.deviceId,
        input.operationKind,
        input.payloadHash,
        JSON.stringify(input.result),
        new Date().toISOString()
      );
  }

  /** Disambiguates a new CRDT path while allowing tombstone revival. */
  private freeCrdtPath(roomId: string, relativePath: string, actorDisplayName?: string): string {
    const isTaken = (candidate: string): boolean => {
      const row = this.getFile(roomId, candidate);
      return Boolean(row && !row.deleted_at);
    };
    if (!isTaken(relativePath)) {
      return relativePath;
    }
    const lastDot = relativePath.lastIndexOf(".");
    const lastSlash = relativePath.lastIndexOf("/");
    const hasExtension = lastDot > lastSlash + 1;
    const extension = hasExtension ? relativePath.slice(lastDot) : "";
    // Preserve user-authored suffixes; only creates are disambiguated.
    const base = hasExtension ? relativePath.slice(0, lastDot) : relativePath;
    // Sanitize user-controlled display names for cross-platform filenames.
    const forbiddenInFilename = new Set([...'/\\:*?"<>|']);
    const safeName = [...(actorDisplayName ?? "")]
      .map((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        const isControl = codePoint < 0x20 || codePoint === 0x7f;
        return isControl || forbiddenInFilename.has(character) ? " " : character;
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
    const label = safeName.length > 0 ? safeName : "copy";
    const first = `${base} (${label})${extension}`;
    if (!isTaken(first)) {
      return first;
    }
    for (let counter = 2; counter <= 50; counter++) {
      const candidate = `${base} (${label}) ${counter}${extension}`;
      if (!isTaken(candidate)) {
        return candidate;
      }
    }
    return `${base} (${label}) ${createId("fil").slice(-8)}${extension}`;
  }

  /** Materializes CRDT text. Returns null without writing for a deleted file, a superseded epoch, or a
   *  room that has left the CRDT lane - whole-file writes own that content now. This path stays quota-exempt. */
  materializeCrdtContent(input: { fileId: string; epoch: number; content: string; actorUserId: string; blobKey?: string }): ({ version: number; sha256: string } & { orphanedBlobKeys?: string[] }) | null {
    const materialize = this.db.transaction(() => {
      const existing = this.db.prepare("select * from files where id = ?").get(input.fileId) as FileRow | undefined;
      if (!existing || existing.deleted_at || existing.crdt_epoch !== input.epoch || !this.getRoom(existing.room_id)?.crdt_enabled) {
        return null;
      }
      const sha256 = sha256Text(input.content);
      const sizeBytes = Buffer.byteLength(input.content, "utf8");
      const rawSizeBytes = this.decodedByteLength(input.content, contentTypeForPath(existing.relative_path));
      const now = new Date().toISOString();
      const storageKey = input.blobKey ? `blob:${input.blobKey}` : `sha256:${sha256}`;
      const version = existing.version + 1;
      this.db
        .prepare(
          "update files set version = ?, sha256 = ?, size_bytes = ?, raw_size_bytes = ?, updated_by_user_id = ?, updated_at = ? where id = ?"
        )
        .run(version, sha256, sizeBytes, rawSizeBytes, input.actorUserId, now, existing.id);
      const orphanedBlobKeys = this.insertFileVersion({ fileId: existing.id, version, sha256, sizeBytes, rawSizeBytes, storageKey, content: input.content, actorUserId: input.actorUserId, now, blobKey: input.blobKey });
      this.auditFileEvent(existing.room_id, input.actorUserId, "file.crdt_materialized", existing.id, existing.relative_path, version);
      return { version, sha256, ...(orphanedBlobKeys.length ? { orphanedBlobKeys } : {}) };
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
            left join content_blobs cb on cb.storage_key = fv.content_storage_key
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
    rawSizeBytes: number;
    storageKey: string;
    content: string;
    actorUserId: string;
    now: string;
    /** Raw-byte key already finalized by ContentWriteService. */
    blobKey?: string;
  }): string[] {
    if (input.blobKey) {
      if (!this.isExternalBlobReferenced(input.blobKey)) {
        this.adjustStorageUsage(input.rawSizeBytes);
      }
    } else {
      const insertedBlob = this.db
        .prepare("insert or ignore into content_blobs(storage_key, content, created_at) values (?, ?, ?)")
        .run(input.storageKey, input.content, input.now);
      if (insertedBlob.changes > 0) {
        this.adjustStorageUsage(this.storedByteLength(input.content));
      }
    }
    this.db
      .prepare(
        "insert into file_versions(id, file_id, version, sha256, size_bytes, content_storage_key, created_by_user_id, created_at, raw_size_bytes, blob_key) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        createId("ver"),
        input.fileId,
        input.version,
        input.sha256,
        input.sizeBytes,
        input.storageKey,
        input.actorUserId,
        input.now,
        input.rawSizeBytes,
        input.blobKey ?? null
      );
    return this.pruneSupersededVersions(input.fileId, input.version);
  }

  /** Prunes older versions and their now-unreferenced blobs. */
  private pruneSupersededVersions(fileId: string, currentVersion: number): string[] {
    const superseded = this.db
      .prepare("select distinct content_storage_key, blob_key, raw_size_bytes from file_versions where file_id = ? and version < ?")
      .all(fileId, currentVersion) as Array<{ content_storage_key: string; blob_key: string | null; raw_size_bytes: number | null }>;
    if (superseded.length === 0) {
      return [];
    }
    this.db.prepare("delete from file_versions where file_id = ? and version < ?").run(fileId, currentVersion);
    const orphanedBlobKeys = new Set<string>();
    for (const { content_storage_key: storageKey, blob_key: blobKey, raw_size_bytes: rawSizeBytes } of superseded) {
      this.collectBlobIfUnreferenced(storageKey);
      if (blobKey && !this.isExternalBlobReferenced(blobKey)) {
        this.adjustStorageUsage(-(rawSizeBytes ?? 0));
        orphanedBlobKeys.add(blobKey);
      }
    }
    return [...orphanedBlobKeys];
  }

  /** Deletes every version and collects now-unreferenced blobs. */
  deleteAllVersionsAndCollectBlobs(fileId: string): string[] {
    const versions = this.db
      .prepare("select distinct content_storage_key, blob_key, raw_size_bytes from file_versions where file_id = ?")
      .all(fileId) as Array<{ content_storage_key: string; blob_key: string | null; raw_size_bytes: number | null }>;
    if (versions.length === 0) {
      return [];
    }
    this.db.prepare("delete from file_versions where file_id = ?").run(fileId);
    const orphanedBlobKeys = new Set<string>();
    for (const { content_storage_key: storageKey, blob_key: blobKey, raw_size_bytes: rawSizeBytes } of versions) {
      this.collectBlobIfUnreferenced(storageKey);
      if (blobKey && !this.isExternalBlobReferenced(blobKey)) {
        this.adjustStorageUsage(-(rawSizeBytes ?? 0));
        orphanedBlobKeys.add(blobKey);
      }
    }
    return [...orphanedBlobKeys];
  }

  /** Deletes a blob only after its final version reference is gone. */
  private collectBlobIfUnreferenced(storageKey: string): void {
    const blob = this.db.prepare("select length(cast(content as blob)) as len from content_blobs where storage_key = ?").get(storageKey) as
      | { len: number }
      | undefined;
    if (!blob) {
      return;
    }
    const deleted = this.db
      .prepare("delete from content_blobs where storage_key = ? and not exists (select 1 from file_versions where content_storage_key = ?)")
      .run(storageKey, storageKey);
    if (deleted.changes > 0) {
      this.adjustStorageUsage(-blob.len);
    }
  }

  private storedByteLength(content: string): number {
    return Buffer.byteLength(content, "utf8");
  }

  /** Returns real file bytes, not base64 transport bytes. */
  private decodedByteLength(content: string, contentType: ContentType): number {
    return contentType === "binary" ? Buffer.from(content, "base64").length : Buffer.byteLength(content, "utf8");
  }

  private adjustStorageUsage(deltaBytes: number): void {
    if (deltaBytes === 0) {
      return;
    }
    this.db.prepare("update storage_usage set blob_bytes = blob_bytes + ? where id = 1").run(deltaBytes);
  }

  getStorageUsageBytes(): number {
    const row = this.db.prepare("select blob_bytes from storage_usage where id = 1").get() as { blob_bytes: number } | undefined;
    return row?.blob_bytes ?? 0;
  }

  /** Current stored bytes for one room; shared blobs are counted in every referencing room. */
  getRoomStorageBytes(roomId: string): number {
    const row = this.db
      .prepare(
        `select coalesce(sum(case when fv.blob_key is null then f.size_bytes else f.raw_size_bytes end), 0) as total
         from files f
         left join file_versions fv on fv.file_id = f.id and fv.version = f.version
         where f.room_id = ? and f.deleted_at is null`
      )
      .get(roomId) as
      | { total: number }
      | undefined;
    return row?.total ?? 0;
  }

  listLegacyContentReferences(batchSize: number): LegacyContentReference[] {
    return this.db
      .prepare(
        `select fv.id as version_id, fv.file_id, fv.version, fv.content_storage_key,
                f.content_type, cb.content
         from file_versions fv
         join files f on f.id = fv.file_id
         join content_blobs cb on cb.storage_key = fv.content_storage_key
         where fv.blob_key is null
         order by fv.id
         limit ?`
      )
      .all(batchSize)
      .map((row) => {
        const value = row as {
          version_id: string;
          file_id: string;
          version: number;
          content_storage_key: string;
          content_type: ContentType;
          content: string;
        };
        return {
          versionId: value.version_id,
          fileId: value.file_id,
          fileVersion: value.version,
          contentStorageKey: value.content_storage_key,
          contentType: value.content_type,
          content: value.content
        };
      });
  }

  migrateLegacyContentReference(input: LegacyContentReference & { blobKey: string; rawSizeBytes: number }): boolean {
    return this.db.transaction(() => {
      const current = this.db
        .prepare("select blob_key, content_storage_key from file_versions where id = ?")
        .get(input.versionId) as { blob_key: string | null; content_storage_key: string } | undefined;
      if (!current || current.blob_key !== null || current.content_storage_key !== input.contentStorageKey) {
        return false;
      }

      const firstExternalReference = !this.isExternalBlobReferenced(input.blobKey);
      this.db
        .prepare("update file_versions set blob_key = ?, content_storage_key = ?, raw_size_bytes = ? where id = ?")
        .run(input.blobKey, `blob:${input.blobKey}`, input.rawSizeBytes, input.versionId);
      this.db
        .prepare("update files set raw_size_bytes = ? where id = ? and version = ?")
        .run(input.rawSizeBytes, input.fileId, input.fileVersion);
      if (firstExternalReference) {
        this.adjustStorageUsage(input.rawSizeBytes);
      }
      this.collectBlobIfUnreferenced(input.contentStorageKey);
      return true;
    })();
  }

  hasLegacyContentReferences(): boolean {
    return Boolean(this.db.prepare("select 1 from file_versions where blob_key is null limit 1").get());
  }

  /** Backfills one resumable batch of legacy raw sizes and retention. */
  backfillStorageBatch(batchSize: number): { processedCount: number; done: boolean } {
    const rows = this.db.prepare("select id from files where raw_size_bytes is null limit ?").all(batchSize) as Array<{ id: string }>;
    for (const { id } of rows) {
      this.backfillOneFile(id);
    }
    const remaining = this.db.prepare("select 1 from files where raw_size_bytes is null limit 1").get();
    return { processedCount: rows.length, done: !remaining };
  }

  private backfillOneFile(fileId: string): void {
    const backfill = this.db.transaction(() => {
      const file = this.db.prepare("select * from files where id = ?").get(fileId) as FileRow | undefined;
      if (!file || file.raw_size_bytes !== null) {
        // A delete or live write already resolved this row.
        return;
      }
      if (file.deleted_at) {
        // Legacy tombstones may still retain versions and must not be reselected.
        this.deleteAllVersionsAndCollectBlobs(fileId);
        this.db.prepare("update files set raw_size_bytes = 0 where id = ?").run(fileId);
        return;
      }
      const latest = this.latestFileVersion(fileId);
      const rawSizeBytes = latest?.content !== null && latest ? this.decodedByteLength(latest.content, contentTypeForPath(file.relative_path)) : 0;
      this.db.prepare("update files set raw_size_bytes = ? where id = ?").run(rawSizeBytes, fileId);
      if (latest) {
        this.db.prepare("update file_versions set raw_size_bytes = ? where id = ?").run(rawSizeBytes, latest.id);
        this.pruneSupersededVersions(fileId, latest.version);
      }
    });
    backfill();
  }

  /** Sweeps one resumable batch of unreferenced legacy blobs. */
  sweepOrphanedBlobsBatch(batchSize: number): { processedCount: number; done: boolean } {
    const sweep = this.db.transaction(() => {
      const orphans = this.db
        .prepare(
          "select storage_key, length(cast(content as blob)) as len from content_blobs " +
            "where not exists (select 1 from file_versions where content_storage_key = content_blobs.storage_key) limit ?"
        )
        .all(batchSize) as Array<{ storage_key: string; len: number }>;
      for (const { storage_key: storageKey } of orphans) {
        // Re-check the reference in the delete statement.
        this.db
          .prepare("delete from content_blobs where storage_key = ? and not exists (select 1 from file_versions where content_storage_key = ?)")
          .run(storageKey, storageKey);
      }
      this.recomputeStorageUsage();
      const remaining = this.db
        .prepare(
          "select 1 from content_blobs where not exists (select 1 from file_versions where content_storage_key = content_blobs.storage_key) limit 1"
        )
        .get();
      return { processedCount: orphans.length, done: !remaining };
    });
    return sweep();
  }

  isBlobKeyReferenced(blobKey: string): boolean {
    return Boolean(
      this.db
        .prepare("select 1 from file_versions where blob_key = ? or content_storage_key = ? or content_storage_key = ? limit 1")
        .get(blobKey, blobKey, `blob:${blobKey}`)
    );
  }

  private isExternalBlobReferenced(blobKey: string): boolean {
    return Boolean(this.db.prepare("select 1 from file_versions where blob_key = ? limit 1").get(blobKey));
  }

  private recomputeStorageUsage(): void {
    const row = this.db.prepare(`
      select coalesce(sum(bytes), 0) as total
      from (
        select length(cast(cb.content as blob)) as bytes
        from content_blobs cb
        where exists (select 1 from file_versions fv where fv.content_storage_key = cb.storage_key)
        union all
        select max(raw_size_bytes) as bytes
        from file_versions
        where blob_key is not null
        group by blob_key
      )
    `).get() as { total: number } | undefined;
    this.db.prepare("update storage_usage set blob_bytes = ?, recomputed_at = ? where id = 1").run(row?.total ?? 0, new Date().toISOString());
  }

  listBlobKeysForFile(fileId: string): string[] {
    return (this.db.prepare("select distinct blob_key from file_versions where file_id = ? and blob_key is not null").all(fileId) as Array<{ blob_key: string }>).map(
      (row) => row.blob_key
    );
  }

  /** Rejects writes that exceed the cap or worsen an over-limit store. */
  private assertQuotaAllows(
    fileId: string | null,
    currentVersion: number,
    storageKey: string,
    blobKey: string | null,
    storedBytes: number
  ): void {
    const currentUsage = this.getStorageUsageBytes();
    const alreadyReferenced = blobKey ? this.isExternalBlobReferenced(blobKey) : this.blobAlreadyStored(storageKey);
    const newlyAllocated = alreadyReferenced ? 0 : storedBytes;
    const reclaimable = fileId ? this.computeReclaimableBytes(fileId, currentVersion, storageKey, blobKey) : 0;
    const projectedUsage = currentUsage + newlyAllocated - reclaimable;
    // Over-limit stores may accept non-growing writes.
    const allowedCeiling = Math.max(currentUsage, this.maxStoredContentBytes);
    if (projectedUsage > allowedCeiling) {
      throw new AppError(
        "STORAGE_QUOTA_EXCEEDED",
        "The store on the hosting device is full. Delete files in this room, then run the reclaim command on the hosting device.",
        413
      );
    }
  }

  private blobAlreadyStored(storageKey: string): boolean {
    return Boolean(this.db.prepare("select 1 from content_blobs where storage_key = ?").get(storageKey));
  }

  /** Predicts bytes freed by the versions this write supersedes. */
  private computeReclaimableBytes(
    fileId: string,
    currentVersion: number,
    newStorageKey: string,
    newBlobKey: string | null
  ): number {
    const candidates = this.db
      .prepare("select distinct content_storage_key, blob_key, raw_size_bytes from file_versions where file_id = ? and version < ?")
      .all(fileId, currentVersion) as Array<{ content_storage_key: string; blob_key: string | null; raw_size_bytes: number | null }>;
    let reclaimable = 0;
    for (const { content_storage_key: candidateKey, blob_key: candidateBlobKey, raw_size_bytes: rawSizeBytes } of candidates) {
      if (candidateBlobKey) {
        if (candidateBlobKey === newBlobKey) {
          continue;
        }
        const stillReferencedElsewhere = this.db
          .prepare("select 1 from file_versions where blob_key = ? and not (file_id = ? and version < ?) limit 1")
          .get(candidateBlobKey, fileId, currentVersion);
        if (!stillReferencedElsewhere) {
          reclaimable += rawSizeBytes ?? 0;
        }
        continue;
      }
      if (candidateKey === newStorageKey) {
        continue; // The new version keeps this blob.
      }
      const stillReferencedElsewhere = this.db
        .prepare("select 1 from file_versions where content_storage_key = ? and not (file_id = ? and version < ?) limit 1")
        .get(candidateKey, fileId, currentVersion);
      if (stillReferencedElsewhere) {
        continue;
      }
      const blob = this.db.prepare("select length(cast(content as blob)) as len from content_blobs where storage_key = ?").get(candidateKey) as
        | { len: number }
        | undefined;
      if (blob) {
        reclaimable += blob.len;
      }
    }
    return reclaimable;
  }

  private versionConflict(file: FileRow): AppError {
    const latest = this.latestFileVersion(file.id);
    return new AppError("VERSION_CONFLICT", "The file changed on the server before your edit was applied.", 409, {
      serverVersion: file.version,
      serverSha256: file.sha256,
      ...(latest?.content !== null && latest ? { serverContent: latest.content } : {}),
      ...(latest?.blob_key ? { serverBlobKey: latest.blob_key, serverContentType: file.content_type } : {})
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

function structuralPayloadHash(operationKind: "create" | "rename", payload: unknown[]): string {
  return sha256Text(JSON.stringify([operationKind, ...payload]));
}

function assertValidOperationId(operationId: string): void {
  if (!operationId || operationId.length > 200) {
    throw new AppError("VALIDATION_ERROR", "A CRDT operation ID must be between 1 and 200 characters.", 422);
  }
}
