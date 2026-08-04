import { createHash } from "node:crypto";
import { AppError, contentTypeForPath, createId } from "@vault-rooms/protocol";
import type { CrdtOperationReceiptRow, FileRow, FileVersionWithContentRow, RoomRow } from "../schema.js";
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

  deleteFile(input: {
    roomId: string;
    relativePath: string;
    baseVersion: number;
    actorUserId: string;
    /** Set for a path whose content the CRDT lane owns, which makes the compare-and-swap
     *  `baseVersion` gate below meaningless and actively harmful: `materializeCrdtContent` bumps
     *  `files.version` on its own debounce, with no `file_change_ack`/`remote_file_change` carrying
     *  that new version back to the deleting client's per-file tracking. So a client's `serverVersion`
     *  for a CRDT file is stale by design the moment anyone types, and every delete it attempts fails
     *  `VERSION_CONFLICT` *forever* - the file becomes locally undeletable, which is what surfaced on
     *  real hardware as repeated "The file changed on the server before your edit was applied" errors
     *  (eighth hardware-testing round, 2026-07-24). Skipping the check restores the same intent the
     *  CAS lane has - "delete what's there" - for a lane where `version` is not the client's to track.
     *  Deletion remains fully permission-gated (`sync:push` + `file:delete`) at both call sites. */
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

  /**
   * Atomic rename for a file in a CRDT-enabled room (fourth hardware-testing round, 2026-07-23):
   * updates only `relative_path` (+ `content_type`, recomputed from the new extension) - `id`,
   * `crdt_epoch`, `version`, and all `file_versions`/CRDT history stay untouched. Replaces the old
   * client-side delete-old+create-new translation, which discarded the file's identity (a fresh
   * `fileId`/epoch) and left every other subscriber with a multi-second, uncorrelated gap between
   * "old file deleted" and "new file created" (see this repo's fourth-hardware-testing-round
   * notes). `CrdtDocManager` caches by `(fileId, epoch)`, never by path (see `crdtDocManager.ts`'s
   * `key()`), so a caller needs no doc-cache/materialize-timer bookkeeping around this at all - the
   * cache stays valid across the rename automatically. Does not bump `version`: content is
   * unchanged, only the path is, so no new `file_versions` row is written either.
   */
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
      // A rename's target is NEVER auto-disambiguated, unlike a colliding create. The name a user
      // typed is authoritative: silently filing their note under a machine-picked name is both worse
      // UX and - as a real-hardware run proved - unstable, because each rewritten name collides again
      // and drives an unbounded rename loop (twelfth hardware-testing round, 2026-07-24; the eleventh
      // round's attempt to share one policy between create and rename was simply wrong). A create's
      // name is machine-generated ("Untitled") and therefore safe to adjust; a rename's is not. A
      // genuine conflict is reported so the client can tell the user to pick another name - and the
      // client's handling of that rejection is non-destructive (it forks nothing).
      const targetPath = input.relativePath;
      if (input.oldRelativePath !== targetPath) {
        const conflict = this.getFile(input.roomId, targetPath);
        if (conflict && !conflict.deleted_at) {
          throw new AppError("FILE_EXISTS", "A file already exists at the new path.", 409, { serverVersion: conflict.version });
        }
        if (conflict) {
          // A *tombstoned* row is not a logical conflict (the path is free as far as users are
          // concerned) but it still occupies the `unique(room_id, relative_path)` slot - so the update
          // below would fail the constraint with a raw SQLite error, which `sendCrdtRejection` could
          // only report as the useless generic "CRDT message could not be applied." That is exactly
          // what renaming a note onto a previously-deleted name produced on real hardware (tenth
          // hardware-testing round, 2026-07-24). Retire the dead row so the rename can land: its
          // content is already unreachable, and the rename's own broadcast tells peers the new state.
          this.bumpCrdtEpochStatements(conflict.id);
          this.db.prepare("delete from file_versions where file_id = ?").run(conflict.id);
          this.db.prepare("delete from files where id = ?").run(conflict.id);
        }
      }
      const now = new Date().toISOString();
      this.db
        .prepare("update files set relative_path = ?, content_type = ?, updated_by_user_id = ?, updated_at = ? where id = ?")
        .run(targetPath, contentTypeForPath(targetPath), input.actorUserId, now, existing.id);
      this.auditFileEvent(input.roomId, input.actorUserId, "file.renamed", existing.id, targetPath, existing.version);
      return { ok: true as const, oldRelativePath: input.oldRelativePath, relativePath: targetPath, epoch: existing.crdt_epoch };
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
      // Two devices creating a note at the same path are creating two *different* notes - each has
      // its own identity - not one shared note (seventh hardware-testing round, 2026-07-24). This is
      // the single most ordinary case there is, because Obsidian names every new note with the same
      // default ("Untitled"/"Chưa đặt tên.md"), so both devices pressing Ctrl+N collide immediately.
      // Rejecting the second one with FILE_EXISTS was an unrecoverable dead end (the client's session
      // never opened, so that note never synced at all), and merging them into one document would
      // interleave two unrelated notes' text. Instead the colliding creator gets its own distinct
      // path, disambiguated by who created it - mirroring how Obsidian itself resolves a local name
      // clash. The caller relays the assigned path back to the client, which renames its local file
      // to match (see syncServer.ts / CrdtSessionManager.ensureEpoch).
      // Reopening a note this client already has must attach to the existing document, never fork a
      // renamed copy of it. Without this distinction, an unmount/remount cycle (which clears the
      // client's known epochs) re-sent crdt_create for every file it already had, each collided, each
      // was handed a disambiguated name, and the client renamed its local file to match - so every
      // remount duplicated the room's notes as "… (DNDark)", "… (huynd2)", … (fifteenth
      // hardware-testing round, 2026-07-24).
      const live = this.getFile(input.roomId, input.relativePath);
      if (input.adoptIfExists && live && !live.deleted_at) {
        return { fileId: live.id, epoch: live.crdt_epoch, relativePath: input.relativePath };
      }
      const relativePath = this.freeCrdtPath(input.roomId, input.relativePath, input.actorDisplayName);
      const existing = this.getFile(input.roomId, relativePath);
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
          .run(fileId, input.roomId, relativePath, contentTypeForPath(relativePath), version, sha256, sizeBytes, input.actorUserId, now, now, epoch);
      }
      this.insertFileVersion({ fileId, version, sha256, sizeBytes, storageKey, content: "", actorUserId: input.actorUserId, now });
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

  /**
   * Resolves `relativePath` to a path with no *live* file at it, disambiguating a collision with the
   * creator's name (`Untitled.md` -> `Untitled (B laptop).md`, then ` (B laptop) 2`, ...) - see
   * `createCrdtFile`'s doc comment for why a collision means "a second, different note" rather than
   * "the same note". A tombstoned path is NOT a collision: reviving it in place is the established
   * delete-then-recreate behavior (contract 1.5/1.9), so only `deleted_at === null` rows block.
   * The suffix goes before the extension so the result stays CRDT-eligible (`.md`), and the display
   * name is stripped of path separators/control characters so it can never escape the room subtree or
   * produce an unwritable filename. Bounded: after enough taken candidates it falls back to the file
   * id-shaped unique suffix rather than looping.
   */
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
    // Deliberately NOT stripping any pre-existing " (name)"/" (name) 2" looking suffix. An earlier
    // attempt to do that (as belt-and-braces against suffix accumulation) could not tell a
    // machine-added suffix from a name the user genuinely typed, so it rewrote real titles like
    // "Report12 (DNDark) 27" back to the "Report12" stem and then picked an arbitrary free number -
    // renames swapped names chaotically and drove an unbounded loop on real hardware (twelfth
    // hardware-testing round, 2026-07-24). Accumulation is prevented at the source instead: only a
    // *create* disambiguates (a rename never does), and the client no longer re-submits an assigned
    // name as a fresh request.
    const base = hasExtension ? relativePath.slice(0, lastDot) : relativePath;
    // A display name is user-chosen, so neutralize anything that shouldn't end up inside a filename:
    // path separators, characters Windows rejects, and control characters. Done by code point rather
    // than with a regex character class on purpose - a class spanning control characters trips
    // `no-control-regex` however it is written (literal bytes or `\u` escapes), and literal bytes are
    // worse still: they made git treat this file as binary and made `grep` render them as blanks, which
    // is exactly what hid a real NUL-vs-space key mismatch elsewhere from a grep-based audit.
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

function structuralPayloadHash(operationKind: "create" | "rename", payload: unknown[]): string {
  return sha256Text(JSON.stringify([operationKind, ...payload]));
}

function assertValidOperationId(operationId: string): void {
  if (!operationId || operationId.length > 200) {
    throw new AppError("VALIDATION_ERROR", "A CRDT operation ID must be between 1 and 200 characters.", 422);
  }
}
