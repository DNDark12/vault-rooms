import { isConflictCopyPath, type MountedRoomState, VaultSyncEngine } from "./syncClient.js";

/** Error codes the relay returns for requests that can never succeed by retrying unchanged (see
 *  file.routes.ts) - as opposed to network failures or transient server errors, which are worth
 *  retrying. Kept intentionally narrow (422-family validation codes only, per the audited finding)
 *  rather than guessing at every code that might also warrant giving up. */
const TERMINAL_ERROR_CODES = new Set(["FILE_TOO_LARGE", "INVALID_PATH", "VALIDATION_ERROR"]);

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
  private readonly pendingTimers = new Map<string, number>();
  private readonly pushChains = new Map<string, Promise<void>>();
  private readonly schedule: (fn: () => void, ms: number) => number;
  private readonly cancel: (id: number) => void;

  constructor(private readonly deps: RoomPushCoordinatorDeps) {
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
    this.cancel = deps.cancel ?? ((id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>));
  }

  /** Handles one already-classified local vault event for this room. */
  handleLocalChange(type: "create" | "modify" | "delete", relativePath: string): void {
    if (isConflictCopyPath(relativePath)) {
      return;
    }
    if (type === "delete") {
      this.handleLocalDelete(relativePath);
      return;
    }
    this.handleLocalEdit(relativePath);
  }

  /** Re-enqueues every file currently marked dirty or pending-delete (and not terminally failed)
   *  through the exact same debounced/serialized push machinery - call this when connectivity is
   *  restored (e.g. the sync socket reaches "connected") instead of maintaining a second queue. */
  retryPending(): void {
    if (!this.deps.isStillMounted()) {
      return;
    }
    for (const [relativePath, state] of Object.entries(this.deps.room.files)) {
      if (state.syncError) {
        continue;
      }
      if (state.localDeleted) {
        this.enqueue(relativePath, () => this.deps.syncEngine.pushLocalDelete(this.deps.room, relativePath));
      } else if (state.dirty) {
        this.enqueue(relativePath, () => this.deps.syncEngine.pushLocalChange(this.deps.room, relativePath, this.deps.deviceName));
      }
    }
  }

  /** Cancels all pending debounce timers - call on unmount/dispose so nothing fires after teardown. */
  dispose(): void {
    for (const timer of this.pendingTimers.values()) {
      this.cancel(timer);
    }
    this.pendingTimers.clear();
  }

  private handleLocalEdit(relativePath: string): void {
    const { room } = this.deps;
    const existing = room.files[relativePath];
    room.files[relativePath] = existing
      ? { ...existing, dirty: true, localDeleted: false, syncError: undefined }
      : { serverVersion: 0, serverSha256: null, localSha256: null, dirty: true };
    this.deps.onPersist();
    this.debounce(relativePath, () => this.enqueue(relativePath, () => this.deps.syncEngine.pushLocalChange(room, relativePath, this.deps.deviceName)));
  }

  private handleLocalDelete(relativePath: string): void {
    const { room } = this.deps;
    const current = room.files[relativePath];
    if (!current || current.serverSha256 === null) {
      // Never pushed (or already a tombstone) - nothing to tell the server, just drop tracking.
      // Also cancel any debounce timer already armed for this path (e.g. from the create/edit that
      // preceded this delete), so it can't fire later against a path that no longer has anything
      // to push.
      const existingTimer = this.pendingTimers.get(relativePath);
      if (existingTimer !== undefined) {
        this.cancel(existingTimer);
        this.pendingTimers.delete(relativePath);
      }
      delete room.files[relativePath];
      this.deps.onPersist();
      return;
    }
    room.files[relativePath] = { ...current, localDeleted: true, syncError: undefined };
    this.deps.onPersist();
    this.debounce(relativePath, () => this.enqueue(relativePath, () => this.deps.syncEngine.pushLocalDelete(room, relativePath)));
  }

  private debounce(relativePath: string, run: () => void): void {
    const existingTimer = this.pendingTimers.get(relativePath);
    if (existingTimer !== undefined) {
      this.cancel(existingTimer);
    }
    const timer = this.schedule(() => {
      this.pendingTimers.delete(relativePath);
      if (!this.deps.isStillMounted()) {
        return;
      }
      run();
    }, this.deps.debounceMs);
    this.pendingTimers.set(relativePath, timer);
  }

  /** Chains onto any push already in flight for this path, so overlapping pushes for the same
   *  path never race each other (see the class doc comment). */
  private enqueue(relativePath: string, push: () => Promise<void>): void {
    if (!this.deps.isStillMounted()) {
      return;
    }
    const previous = this.pushChains.get(relativePath) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => {
        if (!this.deps.isStillMounted()) {
          return;
        }
        return push();
      })
      .then(() => {
        if (this.deps.isStillMounted()) {
          this.deps.onPersist();
        }
      })
      .catch((error) => {
        if (!this.deps.isStillMounted()) {
          return;
        }
        if (isTerminalSyncError(error)) {
          const state = this.deps.room.files[relativePath];
          if (state) {
            this.deps.room.files[relativePath] = { ...state, syncError: error instanceof Error ? error.message : String(error) };
          }
          this.deps.onPersist();
        }
        this.deps.onError(relativePath, error);
      });
    this.pushChains.set(relativePath, next);
  }
}
