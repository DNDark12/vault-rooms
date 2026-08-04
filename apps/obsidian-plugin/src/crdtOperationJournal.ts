import type { MountedRoomState, PendingCrdtOperation } from "./syncClient.js";
import { CrdtRejectedError } from "./crdtSession.js";

export type CrdtOperationJournalDeps = {
  getRoom: (roomId: string) => MountedRoomState | undefined;
  persist: () => Promise<void>;
  canReplay: (room: MountedRoomState) => boolean;
  pathExists: (roomId: string, relativePath: string) => Promise<boolean>;
  create: (roomId: string, relativePath: string, operationId: string) => Promise<{ relativePath: string }>;
  rename: (roomId: string, oldRelativePath: string, relativePath: string, operationId: string) => Promise<{ relativePath: string }>;
  resolveCreate: (roomId: string, relativePath: string, operationId: string) => Promise<{ relativePath: string }>;
  resolveRename: (roomId: string, oldRelativePath: string, relativePath: string, operationId: string) => Promise<{ relativePath: string }>;
  reconcilePath: (roomId: string, relativePath: string) => Promise<void>;
  queueDelete: (roomId: string, relativePath: string) => Promise<void>;
  convertToCas: (
    roomId: string,
    operation: PendingCrdtOperation,
    outcome: { committed: boolean; relativePath: string }
  ) => Promise<void>;
  onUnsupported: (roomId: string) => void;
  onReplayError: (roomId: string, operation: PendingCrdtOperation, error: Error) => void;
  createOperationId?: () => string;
  now?: () => string;
};

export type JournalDeleteDisposition =
  | { handled: true }
  | { handled: false; relativePath: string };

type ReadyRoom = { receiptsSupported: boolean };

/**
 * Durable, per-room ordering for CRDT structural mutations. The journal deliberately owns only
 * create/rename intent; file content stays in Yjs and deletes ultimately return to the existing CAS
 * coordinator after any ambiguous structural attempt has been resolved through a relay receipt.
 */
export class CrdtOperationJournal {
  private readonly readyRooms = new Map<string, ReadyRoom>();
  private readonly replayChains = new Map<string, Promise<void>>();
  private readonly unsupportedNotified = new Set<string>();
  private persistChain: Promise<void> = Promise.resolve();
  private readonly createOperationId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: CrdtOperationJournalDeps) {
    this.createOperationId = deps.createOperationId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async recordCreate(roomId: string, relativePath: string): Promise<void> {
    const room = this.deps.getRoom(roomId);
    if (!room) return;
    const operations = operationsFor(room);
    if (!operations.some((operation) => operation.relativePath === relativePath && !operation.deleteAfterAck)) {
      operations.push({
        operationId: this.createOperationId(),
        kind: "create",
        relativePath,
        queuedAt: this.now()
      });
    }
    await this.persist();
    this.scheduleReplay(roomId);
  }

  async recordRename(roomId: string, oldRelativePath: string, relativePath: string): Promise<void> {
    const room = this.deps.getRoom(roomId);
    if (!room) return;
    const operations = operationsFor(room);
    const existingIndex = findLastIndex(operations, (operation) => operation.relativePath === oldRelativePath && !operation.deleteAfterAck);
    const existing = existingIndex >= 0 ? operations[existingIndex] : undefined;
    if (existing && !existing.attemptedAt) {
      existing.relativePath = relativePath;
    } else {
      operations.push({
        operationId: this.createOperationId(),
        kind: "rename",
        oldRelativePath,
        relativePath,
        queuedAt: this.now()
      });
    }
    await this.persist();
    this.scheduleReplay(roomId);
  }

  async recordDelete(roomId: string, relativePath: string): Promise<JournalDeleteDisposition> {
    const room = this.deps.getRoom(roomId);
    if (!room) return { handled: false, relativePath };
    const operations = operationsFor(room);
    let targetPath = relativePath;

    for (;;) {
      const index = findLastIndex(operations, (operation) => operation.relativePath === targetPath && !operation.deleteAfterAck);
      if (index < 0) {
        await this.persist();
        return { handled: false, relativePath: targetPath };
      }
      const operation = operations[index]!;
      if (operation.attemptedAt) {
        operation.deleteAfterAck = true;
        await this.persist();
        this.scheduleReplay(roomId);
        return { handled: true };
      }

      operations.splice(index, 1);
      if (operation.kind === "create") {
        await this.persist();
        return { handled: true };
      }
      targetPath = operation.oldRelativePath;
      // Continue reducing into the preceding operation in this lineage. If there is none, the
      // caller must issue the ordinary CAS delete at the original server path.
    }
  }

  isPathProtected(roomId: string, relativePath: string): boolean {
    const operations = this.deps.getRoom(roomId)?.pendingCrdtOperations ?? [];
    return operations.some(
      (operation) =>
        operation.relativePath === relativePath ||
        (operation.kind === "rename" && operation.oldRelativePath === relativePath)
    );
  }

  markSnapshotReady(roomId: string, receiptsSupported: boolean): void {
    this.readyRooms.set(roomId, { receiptsSupported });
    this.scheduleReplay(roomId);
  }

  markDisconnected(): void {
    this.readyRooms.clear();
  }

  async drain(roomId: string): Promise<void> {
    await (this.replayChains.get(roomId) ?? Promise.resolve());
  }

  private scheduleReplay(roomId: string): void {
    const previous = this.replayChains.get(roomId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.replay(roomId));
    this.replayChains.set(roomId, next);
  }

  private async replay(roomId: string): Promise<void> {
    const ready = this.readyRooms.get(roomId);
    const room = this.deps.getRoom(roomId);
    if (!ready || !room || !this.deps.canReplay(room)) return;
    const operations = operationsFor(room);
    if (room.crdtEnabled !== true) {
      while (operations.length > 0 && this.readyRooms.get(roomId) === ready && this.deps.canReplay(room)) {
        const operation = operations[0]!;
        const finalIntent = finalIntentForHead(operations);
        if (!finalIntent.deleted && !(await this.deps.pathExists(roomId, finalIntent.relativePath))) {
          this.deps.onReplayError(
            roomId,
            operation,
            Object.assign(
              new Error(`The local file "${finalIntent.relativePath}" no longer exists, so its offline operation was not converted.`),
              { code: "LOCAL_PATH_MISSING" }
            )
          );
          return;
        }

        let committed = false;
        let resolvedPath = operation.relativePath;
        if (operation.attemptedAt) {
          if (!ready.receiptsSupported) {
            if (!this.unsupportedNotified.has(roomId)) {
              this.unsupportedNotified.add(roomId);
              this.deps.onUnsupported(roomId);
            }
            return;
          }
          try {
            const resolved = operation.kind === "create"
              ? await this.deps.resolveCreate(roomId, operation.relativePath, operation.operationId)
              : await this.deps.resolveRename(roomId, operation.oldRelativePath, operation.relativePath, operation.operationId);
            committed = true;
            resolvedPath = resolved.relativePath;
          } catch (error) {
            const replayError = toError(error);
            // A receipt-capable relay checks an existing receipt before the current room mode. This
            // rejection therefore proves the old attempt never committed and may move to CAS safely.
            if (!(replayError instanceof CrdtRejectedError) || replayError.code !== "CRDT_DISABLED") {
              this.deps.onReplayError(roomId, operation, replayError);
              return;
            }
          }
        }

        const follower = operations.slice(1).find(
          (candidate) => candidate.kind === "rename" && candidate.oldRelativePath === operation.relativePath
        );
        if (follower?.kind === "rename") {
          if (follower.attemptedAt) {
            this.deps.onReplayError(
              roomId,
              operation,
              new Error("An attempted follower cannot be rebased while converting CRDT operations to CAS.")
            );
            return;
          }
          if (committed) {
            follower.oldRelativePath = resolvedPath;
          } else if (operation.kind === "rename") {
            follower.oldRelativePath = operation.oldRelativePath;
          } else {
            const index = operations.indexOf(follower);
            operations[index] = {
              operationId: follower.operationId,
              kind: "create",
              relativePath: follower.relativePath,
              queuedAt: follower.queuedAt,
              ...(follower.deleteAfterAck ? { deleteAfterAck: true } : {})
            };
          }
        } else {
          await this.deps.convertToCas(roomId, operation, { committed, relativePath: resolvedPath });
        }
        operations.shift();
        await this.persist();
      }
      return;
    }
    if (!ready.receiptsSupported) {
      if (operations.length > 0 && !this.unsupportedNotified.has(roomId)) {
        this.unsupportedNotified.add(roomId);
        this.deps.onUnsupported(roomId);
      }
      return;
    }

    while (operations.length > 0 && this.readyRooms.get(roomId) === ready && this.deps.canReplay(room)) {
      const operation = operations[0]!;
      const finalIntent = finalIntentForHead(operations);
      if (!finalIntent.deleted && !(await this.deps.pathExists(roomId, finalIntent.relativePath))) {
        this.deps.onReplayError(
          roomId,
          operation,
          Object.assign(
            new Error(`The local file "${finalIntent.relativePath}" no longer exists, so its CRDT operation was not replayed.`),
            { code: "LOCAL_PATH_MISSING" }
          )
        );
        return;
      }

      let resolved: { relativePath: string };
      try {
        if (!operation.attemptedAt) {
          operation.attemptedAt = this.now();
          await this.persist();
        }
        resolved = operation.kind === "create"
          ? await this.deps.create(roomId, operation.relativePath, operation.operationId)
          : await this.deps.rename(roomId, operation.oldRelativePath, operation.relativePath, operation.operationId);
      } catch (error) {
        const replayError = toError(error);
        if (
          replayError instanceof CrdtRejectedError &&
          replayError.code !== "CRDT_OPERATION_DEVICE_MISMATCH"
        ) {
          // A protocol rejection proves the relay did not commit this operation. It is therefore
          // safe to make the payload editable again. Give that editable payload a fresh operation
          // ID so one ID is never reused for a different mutation; transport failures remain
          // ambiguous and keep attemptedAt plus the exact original ID/payload.
          delete operation.attemptedAt;
          operation.operationId = this.createOperationId();
          await this.persist();
        }
        this.deps.onReplayError(roomId, operation, replayError);
        return;
      }

      try {
        const hasFollower = hasLineageFollower(operations, operation.operationId, operation.relativePath);
        if (operation.deleteAfterAck) {
          await this.deps.queueDelete(roomId, resolved.relativePath);
        } else if (!hasFollower) {
          // A restart can leave no live session at the final local path. This is especially important
          // when an attempted create at A is followed by an offline rename to B: the receipt must be
          // resolved at A first, but the only disk text now lives at B. Re-open/reconcile B before the
          // journal stops protecting it so that content, not only the structural rename, converges.
          await this.deps.reconcilePath(roomId, resolved.relativePath);
        }
        if (resolved.relativePath !== operation.relativePath) {
          rebaseUnattemptedFollowers(operations, operation.operationId, operation.relativePath, resolved.relativePath);
        }
        const completedIndex = operations.findIndex((candidate) => candidate.operationId === operation.operationId);
        if (completedIndex >= 0) operations.splice(completedIndex, 1);
        await this.persist();
      } catch (error) {
        // The relay ACK already proved the structural mutation committed. Keep the attempted
        // operation immutable so the next replay resolves the same receipt before retrying this
        // local follow-up; assigning a new ID here could create a duplicate document.
        this.deps.onReplayError(roomId, operation, toError(error));
        return;
      }
    }
  }

  private persist(): Promise<void> {
    const next = this.persistChain.catch(() => undefined).then(() => this.deps.persist());
    this.persistChain = next;
    return next;
  }
}

function operationsFor(room: MountedRoomState): PendingCrdtOperation[] {
  return (room.pendingCrdtOperations ??= []);
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function finalIntentForHead(operations: PendingCrdtOperation[]): { relativePath: string; deleted: boolean } {
  let relativePath = operations[0]!.relativePath;
  let deleted = operations[0]!.deleteAfterAck === true;
  for (let index = 1; index < operations.length && !deleted; index += 1) {
    const operation = operations[index]!;
    if (operation.kind === "rename" && operation.oldRelativePath === relativePath) {
      relativePath = operation.relativePath;
      deleted = operation.deleteAfterAck === true;
    }
  }
  return { relativePath, deleted };
}

function rebaseUnattemptedFollowers(
  operations: PendingCrdtOperation[],
  completedOperationId: string,
  requestedPath: string,
  resolvedPath: string
): void {
  const completedIndex = operations.findIndex((operation) => operation.operationId === completedOperationId);
  for (let index = completedIndex + 1; index < operations.length; index += 1) {
    const follower = operations[index]!;
    if (follower.attemptedAt || follower.kind !== "rename" || follower.oldRelativePath !== requestedPath) continue;
    follower.oldRelativePath = resolvedPath;
    return;
  }
}

function hasLineageFollower(
  operations: PendingCrdtOperation[],
  completedOperationId: string,
  relativePath: string
): boolean {
  const completedIndex = operations.findIndex((operation) => operation.operationId === completedOperationId);
  return operations.slice(completedIndex + 1).some(
    (operation) => operation.kind === "rename" && operation.oldRelativePath === relativePath
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
