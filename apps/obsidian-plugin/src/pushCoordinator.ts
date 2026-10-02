import { portablePathKey } from "@vault-rooms/protocol";
import type { RenameHint } from "./fileWatcher.js";
import { userFacingError } from "./errorMessages.js";
import { getMountedFileEntry, isMountedPathBlocked, localPortablePathError, isConflictCopyPath, type MountedRoomState, VaultSyncEngine } from "./syncClient.js";
import { PANEL_COPY } from "./views/panelCopy.js";
import { pausedPathModel } from "./views/pausedPathModel.js";

/** Errors that cannot succeed by retrying the same write. */
const TERMINAL_ERROR_CODES = new Set(["FILE_TOO_LARGE", "INVALID_PATH", "VALIDATION_ERROR", "STORAGE_QUOTA_EXCEEDED"]);

export function isTerminalSyncError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TERMINAL_ERROR_CODES.has(code);
}

export type RoomPushCoordinatorDeps = {
  room: MountedRoomState;
  syncEngine: VaultSyncEngine;
  deviceName: string;
  /** Persists settings so pending state (dirty/localDeleted) survives a mid-debounce restart. */
  onPersist: () => void;
  onError: (relativePath: string, error: unknown) => void;
  debounceMs: number;
  /** Checked before scheduling/running any push - lets the caller bail out if the room was
   *  unmounted or replaced while a debounce timer or retry was pending. */
  isStillMounted: () => boolean;
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (id: number) => void;
};

/**
 * Coordinates local -> server pushes for one mounted room: debounces rapid edits per path,
 * serializes pushes per path (so overlapping in-flight pushes for the same path can't
 * self-conflict), marks files dirty/pending-delete synchronously so a mid-debounce restart doesn't
 * lose track of unsynced work, and re-drives any still-pending work on retryPending() (e.g. when
 * the live-sync socket reconnects). This is the coordination logic that used to live untested
 * inline in main.ts's watchMountedRoom().
 */
export class RoomPushCoordinator {
  private disposed = false;
  private readonly pendingTimers = new Map<string, number>();
  private readonly invalidNamesNotified = new Set<string>();
  private readonly blockedPathsNotified = new Set<string>();
  private readonly pushChains = new Map<string, Promise<void>>();
  private readonly schedule: (fn: () => void, ms: number) => number;
  private readonly cancel: (id: number) => void;

  constructor(private readonly deps: RoomPushCoordinatorDeps) {
    this.schedule = deps.schedule ?? ((fn, ms) => window.setTimeout(fn, ms));
    this.cancel = deps.cancel ?? ((id) => window.clearTimeout(id));
  }

  /** Handles one already-classified local vault event for this room. */
  handleLocalChange(type: "create" | "modify" | "delete", relativePath: string, renameHint?: RenameHint): void {
    if (this.disposed) return;
    if (relativePath.split("/").some((part) => part.startsWith(".")) || isConflictCopyPath(relativePath) || this.notifyBlockedPath(relativePath)) {
      return;
    }
    const renamedTo = renameHint && "renamedToRelativePath" in renameHint ? renameHint.renamedToRelativePath : undefined;
    const tracked = getMountedFileEntry(this.deps.room, relativePath)?.[1];
    if (renamedTo && this.notifyBlockedPath(renamedTo)) return;
    if (renamedTo && !this.isValidNewName(renamedTo)) return;
    if (type !== "delete" && (renameHint || !tracked?.serverSha256) && !this.isValidNewName(relativePath)) return;
    if (renamedTo && portablePathKey(renamedTo) === portablePathKey(relativePath)) {
      const entry = getMountedFileEntry(this.deps.room, relativePath);
      const trackedPath = entry?.[0] ?? relativePath;
      if (entry?.[1].serverSha256) {
        this.deps.room.files[trackedPath] = { ...entry[1], localDeleted: true, renamedToRelativePath: renamedTo, syncError: undefined };
        this.deps.onPersist();
        this.debounce(relativePath, () => this.enqueue(relativePath, () => this.pushPendingRename(trackedPath, renamedTo)));
      }
      return;
    }
    if (type === "delete") {
      this.handleLocalDelete(relativePath);
      return;
    }
    this.handleLocalEdit(relativePath);
  }

  /** Shared with the watcher so its CRDT early return also explains the paused edit. */
  notifyBlockedPath(relativePath: string): boolean {
    const room = this.deps.room;
    if (!isMountedPathBlocked(room, relativePath)) return false;
    const key = portablePathKey(relativePath);
    const reason = pausedPathModel(room).find((group) => group.key === key || key.startsWith(`${group.key}/`))?.reason ?? "local-collision";
    const notificationKey = `${relativePath}\0${reason}`;
    if (!this.blockedPathsNotified.has(notificationKey)) {
      this.blockedPathsNotified.add(notificationKey);
      const description = reason === "server-collision" ? PANEL_COPY.pausedPaths.serverCollision
        : reason === "local-collision" ? PANEL_COPY.pausedPaths.localCollision : PANEL_COPY.pausedPaths.recoveryPending;
      this.deps.onError(relativePath, Object.assign(new Error(PANEL_COPY.pausedPaths.editNotice(relativePath, description)), {
        code: "PATH_COLLISION", reason
      }));
    }
    return true;
  }

  /** Re-enqueues every file currently marked dirty or pending-delete (and not terminally failed)
   *  through the exact same debounced/serialized push machinery - call this when connectivity is
   *  restored (e.g. the sync socket reaches "connected") instead of maintaining a second queue. */
  retryPending(): void {
    if (this.disposed || !this.deps.isStillMounted()) {
      return;
    }
    for (const [relativePath, state] of Object.entries(this.deps.room.files)) {
      if (state.syncError || isMountedPathBlocked(this.deps.room, relativePath)) {
        continue;
      }
      if (state.renamedToRelativePath) {
        this.enqueue(relativePath, () => this.pushPendingRename(relativePath, state.renamedToRelativePath!));
      } else if (state.localDeleted) {
        this.enqueue(relativePath, () => this.deps.syncEngine.pushLocalDelete(this.deps.room, relativePath));
      } else if (state.dirty) {
        this.enqueue(relativePath, () => this.deps.syncEngine.pushLocalChange(this.deps.room, relativePath, this.deps.deviceName));
      }
    }
  }

  /** Cancels all pending debounce timers - call on unmount/dispose so nothing fires after teardown. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.pendingTimers.values()) {
      this.cancel(timer);
    }
    this.pendingTimers.clear();
  }

  private handleLocalEdit(relativePath: string): void {
    const { room } = this.deps;
    const entry = getMountedFileEntry(room, relativePath);
    const trackedPath = entry?.[0] ?? relativePath;
    const existing = entry?.[1];
    if (existing?.renamedToRelativePath) {
      room.files[trackedPath] = { ...existing, dirty: true };
      this.deps.onPersist();
      this.debounce(relativePath, () => this.enqueue(relativePath, () => this.pushPendingRename(trackedPath, existing.renamedToRelativePath!)));
      return;
    }
    room.files[trackedPath] = existing
      ? { ...existing, dirty: true, localDeleted: false, syncError: undefined }
      : { serverVersion: 0, serverSha256: null, localSha256: null, dirty: true };
    this.deps.onPersist();
    this.debounce(relativePath, () => this.enqueue(relativePath, () => this.deps.syncEngine.pushLocalChange(room, relativePath, this.deps.deviceName)));
  }

  private handleLocalDelete(relativePath: string): void {
    const { room } = this.deps;
    const entry = getMountedFileEntry(room, relativePath);
    const trackedPath = entry?.[0] ?? relativePath;
    const current = entry?.[1];
    if (!current || current.serverSha256 === null) {
      // Never pushed (or already a tombstone) - nothing to tell the server, just drop tracking.
      // Also cancel any debounce timer already armed for this path (e.g. from the create/edit that
      // preceded this delete), so it can't fire later against a path that no longer has anything
      // to push.
      const existingTimer = this.pendingTimers.get(portablePathKey(relativePath));
      if (existingTimer !== undefined) {
        this.cancel(existingTimer);
        this.pendingTimers.delete(portablePathKey(relativePath));
      }
      delete room.files[trackedPath];
      this.deps.onPersist();
      return;
    }
    room.files[trackedPath] = { ...current, localDeleted: true, syncError: undefined };
    this.deps.onPersist();
    this.debounce(relativePath, () => this.enqueue(relativePath, () => this.deps.syncEngine.pushLocalDelete(room, relativePath)));
  }

  private isValidNewName(relativePath: string): boolean {
    const error = localPortablePathError(relativePath);
    if (!error) return true;
    const notificationKey = `${relativePath}\0${error.message}`;
    if (!this.invalidNamesNotified.has(notificationKey)) {
      this.invalidNamesNotified.add(notificationKey);
      this.deps.onError(relativePath, error);
    }
    return false;
  }

  private async pushPendingRename(oldRelativePath: string, relativePath: string): Promise<void> {
    const { room, syncEngine } = this.deps;
    if (isMountedPathBlocked(room, oldRelativePath) || isMountedPathBlocked(room, relativePath)) return;
    await syncEngine.pushLocalDelete(room, oldRelativePath, { renamedToRelativePath: relativePath });
    // Persist a pending create before awaiting the network so a reconnect can resume after deletion.
    room.files[relativePath] = { serverVersion: 0, serverSha256: null, localSha256: null, dirty: true };
    this.deps.onPersist();
    await syncEngine.pushLocalChange(room, relativePath, this.deps.deviceName);
  }

  private debounce(relativePath: string, run: () => void): void {
    const existingTimer = this.pendingTimers.get(portablePathKey(relativePath));
    if (existingTimer !== undefined) {
      this.cancel(existingTimer);
    }
    const timer = this.schedule(() => {
      this.pendingTimers.delete(portablePathKey(relativePath));
      if (this.disposed || !this.deps.isStillMounted()) {
        return;
      }
      run();
    }, this.deps.debounceMs);
    this.pendingTimers.set(portablePathKey(relativePath), timer);
  }

  /** Chains onto any push already in flight for this path, so overlapping pushes for the same
   *  path never race each other (see the class doc comment). */
  private enqueue(relativePath: string, push: () => Promise<void>): void {
    if (this.disposed || !this.deps.isStillMounted() || isMountedPathBlocked(this.deps.room, relativePath)) {
      return;
    }
    const previous = this.pushChains.get(portablePathKey(relativePath)) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => {
        if (this.disposed || !this.deps.isStillMounted() || isMountedPathBlocked(this.deps.room, relativePath)) {
          return;
        }
        return push();
      })
      .then(() => {
        if (!this.disposed && this.deps.isStillMounted()) {
          this.deps.onPersist();
        }
      })
      .catch((error) => {
        if (this.disposed || !this.deps.isStillMounted()) {
          return;
        }
        if (isTerminalSyncError(error)) {
          const entry = getMountedFileEntry(this.deps.room, relativePath);
          const state = entry?.[1];
          if (state) {
            // `syncError` is rendered in the rooms panel, so it is a display sink. `onError` below
            // still receives the raw error for logging and diagnostics.
            this.deps.room.files[entry![0]] = {
              ...state,
              syncError: userFacingError(error, "The file could not be synced.")
            };
          }
          this.deps.onPersist();
        }
        this.deps.onError(relativePath, error);
      });
    this.pushChains.set(portablePathKey(relativePath), next);
  }
}
