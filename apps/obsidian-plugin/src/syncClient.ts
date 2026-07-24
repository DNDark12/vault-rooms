import { isCrdtEligiblePath, isEligibleBinaryPath } from "@vault-rooms/protocol";

export type VaultChangeEvent = { type: "create" | "modify" | "delete"; path: string } | { type: "rename"; path: string; oldPath: string };

export interface VaultAdapter {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  /** Byte-accurate read for images/PDFs - `read()` decodes as UTF-8 text and corrupts these. */
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  delete(path: string): Promise<void>;
  /** Moves/renames a file in place (fourth hardware-testing round, 2026-07-23) - used to apply a
   *  `remote_crdt_rename` on a device that has no open session for the path (so there's no live
   *  Y.Doc/editor to rekey, just a plain on-disk file to move to match the new name). A no-op is
   *  not implied when the source doesn't exist - callers check `exists()` first where that matters. */
  rename(oldPath: string, newPath: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  /** Returns an unsubscribe function - callers are responsible for calling it once they no longer
   *  need this particular registration (e.g. a room was unmounted), otherwise the listener stays
   *  registered for the plugin's whole lifetime. */
  onChange(cb: (event: VaultChangeEvent) => void): () => void;
}

export type RelayFileApi = {
  readFile(roomId: string, relativePath: string): Promise<{ relativePath: string; version: number; sha256: string; content: string }>;
  writeFile(roomId: string, relativePath: string, baseVersion: number, content: string): Promise<{ ok: true; relativePath: string; version: number; sha256: string }>;
  deleteFile(roomId: string, relativePath: string, baseVersion: number): Promise<{ ok: true; relativePath: string; version: number }>;
};

export type MountedFileState = {
  serverVersion: number;
  serverSha256: string | null;
  localSha256: string | null;
  dirty: boolean;
  /** True while a local delete of this path is pushed/retried but hasn't yet been confirmed by
   *  the server - the discriminator that lets the retry driver (see pushCoordinator.ts) tell "this
   *  path needs a pending EDIT re-pushed" (dirty) apart from "this path needs a pending DELETE
   *  re-pushed" (localDeleted). Optional/additive so settings saved before this field existed load
   *  unaffected (treated as "no pending delete"). */
  localDeleted?: boolean;
  /** Set when the last push attempt for this path failed with a terminal (non-retryable) error,
   *  e.g. FILE_TOO_LARGE or INVALID_PATH - see pushCoordinator.ts's isTerminalSyncError. Retrying a
   *  terminal error can never succeed without the user changing something, so the retry driver
   *  skips paths with this set instead of retrying forever; persisted so the failure survives a
   *  restart as a durable (if not yet surfaced in the UI) indicator. Cleared on the next successful
   *  push attempt for this path. */
  syncError?: string;
};

export type MountedRoomState = {
  roomId: string;
  /** Which saved server (settings.servers[].id) this room's files live on. Only one server is
   *  "active" (connected/syncing) at a time - see main.ts's connectSyncSocket()/activateServer() -
   *  so this lets mount/watch/subscribe logic tell "my room, but a different, currently-inactive
   *  server" apart from "my room, on the active server," instead of routing every mounted room's
   *  push/pull through whichever server happens to be active right now. Optional only so that
   *  mountedRooms entries saved before this field existed don't crash on load; treated the same as
   *  "belongs to a different server" (paused until re-mounted) rather than assumed to be current. */
  serverId?: string;
  mountPath: string;
  files: Record<string, MountedFileState>;
  /** True once the room has been non-destructively unmounted (see main.ts's unmountRoom) - local
   *  files and tracking are left in place, only the watcher/live-sync subscription stop. Optional/
   *  additive so rooms saved before this field existed load as "not unmounted" (i.e. actively
   *  mounted), matching their pre-existing behavior. */
  unmounted?: boolean;
  /**
   * Client-side cache of this room's CRDT mode (contract 1.11), last learned from either a fresh
   * `refreshRooms()` REST fetch or a live `room_mode_changed` push - see main.ts's
   * `persistRoomFlagsForMountedRooms()`/`connectSyncSocket()`'s `onRoomModeChanged` wiring. Exists
   * so `resolveRoomCrdtEnabled` has a synchronously-available last-known value at plugin startup,
   * before `visibleRooms` (which requires a network round trip) is populated - see
   * CLAUDE.md's post-hardware-testing audit notes for the bug this closes (a CRDT-managed file's
   * local edit getting misrouted into the legacy whole-file CAS lane during that startup window).
   * Optional/additive so rooms saved before this field existed load with no persisted opinion
   * (falls through to `false` in `resolveRoomCrdtEnabled` until the next refresh).
   */
  crdtEnabled?: boolean;
  /**
   * Client-side cache of whether this device currently has `sync:push` for this room (third
   * hardware-testing round, item 1) - last learned from either a fresh `refreshRooms()` REST fetch
   * (`RoomSummary.permissions`) or, at mount time, the `RoomSummary` passed to
   * `RoomMountController.mountRoom()`. There is no live push equivalent of `room_mode_changed` for
   * ACL/permission changes (see `ConnectionRegistry.revalidateAccess` - it only ever fully revokes a
   * subscription on loss of `room:read`, it does not notify on a narrower permission downgrade like
   * losing `sync:push` while keeping `room:read`), so `refreshRooms()` freshness is the accepted
   * staleness bound here: a permission *downgrade* becoming visible with a short lag is a much
   * smaller risk than the bug this field closes (an upgrade never being usable, or - the sharper
   * case - a read-only member's local file divergence being treated as a real edit worth protecting
   * with dirty-tracking, a push attempt, or a conflict-fork). Used via `resolveCanPushLocalEdits`
   * at call sites that only have a `roomId` (no fresh `RoomSummary` in hand); `VaultSyncEngine`'s own
   * methods read this field directly with a safe `?? false` default (see `reconcileLocalEdits`/
   * `applyRemoteChange`/`applyRemoteDelete`), since they only ever receive a `MountedRoomState`, not
   * `visibleRooms`. Optional/additive so rooms saved before this field existed load with no
   * persisted opinion (falls through to `false`, the safe default, until the next refresh/mount).
   */
  canPushLocalEdits?: boolean;
};

/**
 * Resolves whether a room is CRDT-enabled with a safe startup fallback chain: prefer the freshest,
 * network-confirmed `visibleRooms` entry when the room is present there, else fall back to the
 * client's last-known persisted value (`MountedRoomState.crdtEnabled`), else `false`. Callers
 * (main.ts's `watchMountedRoom` vault-watcher callback and `connectSyncSocket`'s
 * `isRoomCrdtEnabled`) use this instead of reading `visibleRooms` directly, so CRDT-lane routing
 * stays correct even before a fresh `refreshRooms()` call has resolved (e.g. immediately after
 * Obsidian starts).
 */
export function resolveRoomCrdtEnabled(
  visibleRoom: { crdtEnabled: boolean } | undefined,
  mountedRoomState: { crdtEnabled?: boolean } | undefined
): boolean {
  if (visibleRoom) {
    return visibleRoom.crdtEnabled;
  }
  return Boolean(mountedRoomState?.crdtEnabled);
}

/**
 * Resolves whether this device can currently push local edits to a room (third hardware-testing
 * round, item 1) - mirrors `resolveRoomCrdtEnabled`'s fallback-chain shape, but defaults to `false`
 * rather than the CRDT resolver's implicit-`false`-anyway default, spelled out explicitly here
 * because unlike CRDT-enablement (a room-level feature toggle, safe to assume off), push capability
 * is a *permission* - an unknown/stale state must never be treated as "can push," since the whole
 * point is to never risk a push attempt or a spurious dirty-mark for a device that actually can't
 * write. The worst case of defaulting `false` too eagerly (a legitimate editor's edit not pushed for
 * a few seconds until `visibleRooms` resolves) self-heals via the existing debounce/retry machinery;
 * defaulting `true` too eagerly reintroduces exactly the bug this closes.
 */
export function resolveCanPushLocalEdits(
  visibleRoom: { permissions: string[] } | undefined,
  mountedRoomState: { canPushLocalEdits?: boolean } | undefined
): boolean {
  if (visibleRoom) {
    return visibleRoom.permissions.includes("sync:push");
  }
  return mountedRoomState?.canPushLocalEdits ?? false;
}

export function mountPathForRoom(input: {
  owner: boolean;
  mountRoot: string;
  mountName: string;
  sourcePath: string;
}): string {
  return input.owner ? stripSlashes(input.sourcePath) : [stripSlashes(input.mountRoot), input.mountName].map(stripSlashes).join("/");
}

/**
 * Decides the effective local mount path for a room, given a possibly-stale per-room override
 * (settings.roomMountPaths[room.id]). For the room OWNER, "Local mount path" is no longer a
 * supported concept - the owner's device always mounts in place at the room's real sourcePath (see
 * mountPathForRoom's doc comment), so any existing override is ignored rather than honored. This
 * makes the fix self-healing for rooms that already have a stray owner override saved from before
 * "Local mount path" was hidden for owners (e.g. earlier testing): re-derive from sourcePath every
 * time instead of trusting the stored value. Non-owners keep full control of their override, which
 * remains a legitimate, user-facing setting.
 */
export function resolveRoomMountPath(input: {
  owner: boolean;
  configuredOverride: string | undefined;
  mountRoot: string;
  mountName: string;
  sourcePath: string;
}): string {
  if (!input.owner) {
    const configured = input.configuredOverride?.trim();
    if (configured) {
      return configured;
    }
  }
  return mountPathForRoom({
    owner: input.owner,
    mountRoot: input.mountRoot,
    mountName: input.mountName,
    sourcePath: input.sourcePath
  });
}

export async function createConflictCopyPath(vault: VaultAdapter, path: string, deviceName: string, now = new Date()): Promise<string> {
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf(".");
  const basename = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  const timestamp = formatConflictTimestamp(now);
  const base = `${directory}${basename} (conflict ${deviceName} ${timestamp})`;
  let candidate = `${base}${extension}`;
  let suffix = 2;
  while (await vault.exists(candidate)) {
    candidate = `${base} ${suffix}${extension}`;
    suffix += 1;
  }
  return candidate;
}

export function isConflictCopyPath(path: string): boolean {
  return /\(conflict .+ \d{4}-\d{2}-\d{2}T\d{6}\)(?: \d+)?\.[^/]+$/.test(path);
}

const CONFLICT_SUFFIX = /\s\(conflict .+ \d{4}-\d{2}-\d{2}T\d{6}\)(?: \d+)?(?=\.[^/]+$)/;

/** Reverses createConflictCopyPath()'s naming: strips the inserted "(conflict ...)" suffix to get
 *  back the canonical path this conflict copy forked from. Returns null for a non-conflict path. */
export function canonicalPathForConflictCopy(path: string): string | null {
  if (!isConflictCopyPath(path)) {
    return null;
  }
  return path.replace(CONFLICT_SUFFIX, "");
}

export class VaultSyncEngine {
  constructor(
    private readonly vault: VaultAdapter,
    private readonly api: RelayFileApi,
    private readonly now: () => Date = () => new Date()
  ) {}

  static async sha256(content: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Reads a synced file's content as the string form used for hashing/transport: raw text for
   * Markdown/text/canvas/etc, or base64 for images/PDFs. `vault.read()` decodes bytes as UTF-8, so
   * it silently corrupts binary files - `isEligibleBinaryPath` (keyed off the room-relative path,
   * which shares the conflict copy's extension) picks the byte-accurate path instead.
   */
  private async readContent(path: string, relativePath: string): Promise<string> {
    if (isEligibleBinaryPath(relativePath)) {
      return arrayBufferToBase64(await this.vault.readBinary(path));
    }
    return this.vault.read(path);
  }

  private async writeContent(path: string, relativePath: string, content: string): Promise<void> {
    if (isEligibleBinaryPath(relativePath)) {
      await this.vault.writeBinary(path, base64ToArrayBuffer(content));
      return;
    }
    await this.vault.write(path, content);
  }

  async applyRemoteChange(
    room: MountedRoomState,
    remote: { relativePath: string; version: number; sha256: string; content: string },
    deviceName: string,
    allowSameVersion = false
  ): Promise<void> {
    const path = mountedPath(room, remote.relativePath);
    const existingState = room.files[remote.relativePath];
    if (existingState && (remote.version < existingState.serverVersion || (!allowSameVersion && remote.version === existingState.serverVersion))) {
      return;
    }
    // Third-hardware-testing-round item 1: a room this device can't push to has no legitimate basis
    // to ever have a real "conflicting local edit" - never fork a conflict copy for it, even if
    // `dirty` is (incorrectly) true from stale pre-fix persisted state. Just apply the remote
    // content silently, same as the non-dirty case.
    if ((room.canPushLocalEdits ?? false) && existingState?.dirty && (await this.vault.exists(path))) {
      const local = await this.readContent(path, remote.relativePath);
      await this.writeContent(await createConflictCopyPath(this.vault, path, deviceName, this.now()), remote.relativePath, local);
    }
    await this.writeContent(path, remote.relativePath, remote.content);
    room.files[remote.relativePath] = {
      serverVersion: remote.version,
      serverSha256: remote.sha256,
      localSha256: await VaultSyncEngine.sha256(remote.content),
      dirty: false
    };
  }

  async applyRemoteDelete(
    room: MountedRoomState,
    remote: { relativePath: string; version: number },
    deviceName: string,
    allowSameVersion = false
  ): Promise<void> {
    const path = mountedPath(room, remote.relativePath);
    const existingState = room.files[remote.relativePath];
    if (existingState && (remote.version < existingState.serverVersion || (!allowSameVersion && remote.version === existingState.serverVersion))) {
      return;
    }
    // Same defense-in-depth as applyRemoteChange above: never fork a conflict copy for a room this
    // device can't push to, regardless of a possibly-stale `dirty` flag.
    if ((room.canPushLocalEdits ?? false) && existingState?.dirty && (await this.vault.exists(path))) {
      const local = await this.readContent(path, remote.relativePath);
      await this.writeContent(await createConflictCopyPath(this.vault, path, deviceName, this.now()), remote.relativePath, local);
    }
    if (await this.vault.exists(path)) {
      await this.vault.delete(path);
    }
    room.files[remote.relativePath] = {
      serverVersion: remote.version,
      serverSha256: null,
      localSha256: null,
      dirty: false
    };
  }

  async pushLocalChange(room: MountedRoomState, relativePath: string, deviceName: string): Promise<void> {
    if (isConflictCopyPath(relativePath)) {
      return;
    }
    const path = mountedPath(room, relativePath);
    // A queued push can reach here after the file is already gone again by the time it actually
    // runs (e.g. a debounced rename-away, or an A->B->A bounce within one debounce window) - push
    // against final on-disk state, not the stale event that scheduled this call, so a file that no
    // longer exists locally is simply not pushed instead of throwing "file not found".
    if (!(await this.vault.exists(path))) {
      return;
    }
    const content = await this.readContent(path, relativePath);
    const current = room.files[relativePath];
    const localSha = await VaultSyncEngine.sha256(content);
    if (current?.serverSha256 === localSha) {
      room.files[relativePath] = { ...current, localSha256: localSha, dirty: false, localDeleted: false };
      return;
    }

    // A tombstoned entry (serverSha256: null, from applyRemoteDelete) or a never-tracked file
    // (current undefined) both mean "no live server content to base a write on," so baseVersion
    // must be 0 - only trust current.serverVersion as a real prior version when serverSha256 is
    // non-null. Otherwise a file recreated after a remote delete would send the tombstone's real
    // (non-zero) version and the server would unconditionally reject it with FILE_DELETED.
    const baseVersion = current?.serverSha256 != null ? current.serverVersion : 0;
    try {
      const result = await this.api.writeFile(room.roomId, relativePath, baseVersion, content);
      room.files[relativePath] = {
        serverVersion: result.version,
        serverSha256: result.sha256,
        localSha256: localSha,
        dirty: false
      };
    } catch (error) {
      if (isVersionConflict(error)) {
        await this.writeContent(await createConflictCopyPath(this.vault, path, deviceName, this.now()), relativePath, content);
        await this.writeContent(path, relativePath, error.serverContent);
        room.files[relativePath] = {
          serverVersion: error.serverVersion,
          serverSha256: error.serverSha256,
          localSha256: await VaultSyncEngine.sha256(error.serverContent),
          dirty: false
        };
        return;
      }
      throw error;
    }
  }

  /**
   * Pushes a local delete of `relativePath` to the server. If the path was never pushed (no
   * tracked server version) - or is already a server-side tombstone - there is nothing to delete
   * remotely, so this just drops the local tracking entry. Mirrors pushLocalChange's final-state
   * check: if the file has reappeared on disk by the time this actually runs (e.g. an A->B->A
   * rename bounce within one debounce window), the delete is skipped rather than deleting a file
   * that's actually back - whatever recreated it will push its own create/modify separately.
   */
  async pushLocalDelete(room: MountedRoomState, relativePath: string): Promise<void> {
    if (isConflictCopyPath(relativePath)) {
      return;
    }
    const current = room.files[relativePath];
    if (!current || current.serverSha256 === null) {
      delete room.files[relativePath];
      return;
    }
    const path = mountedPath(room, relativePath);
    if (await this.vault.exists(path)) {
      room.files[relativePath] = { ...current, localDeleted: false };
      return;
    }
    await this.api.deleteFile(room.roomId, relativePath, current.serverVersion);
    delete room.files[relativePath];
  }

  /**
   * Resolves a local conflict copy against its canonical file. Conflict copies never sync (see
   * isConflictCopyPath checks above) - they're purely a local safety net - so this only ever
   * touches files on this one device:
   * - "mine": overwrite the canonical file with the conflict copy's content and push it as a new
   *   version, then remove the now-redundant conflict copy.
   * - "theirs": keep the canonical file as-is (it already holds the version that won) and just
   *   remove the conflict copy.
   */
  async resolveConflict(room: MountedRoomState, relativePath: string, conflictRelativePath: string, keep: "mine" | "theirs", deviceName: string): Promise<void> {
    const conflictPath = mountedPath(room, conflictRelativePath);
    if (keep === "theirs") {
      if (await this.vault.exists(conflictPath)) {
        await this.vault.delete(conflictPath);
      }
      return;
    }
    if (!(await this.vault.exists(conflictPath))) {
      // Someone (or a previous click) already removed the conflict copy - nothing left to keep.
      return;
    }
    const path = mountedPath(room, relativePath);
    const conflictContent = await this.readContent(conflictPath, relativePath);
    await this.writeContent(path, relativePath, conflictContent);
    if (await this.vault.exists(conflictPath)) {
      await this.vault.delete(conflictPath);
    }
    await this.pushLocalChange(room, relativePath, deviceName);
  }

  /**
   * Re-hashes every already-tracked file's on-disk content against what was last synced, marking
   * it dirty if they no longer match. The watcher that normally marks a file dirty on edit (see
   * pushCoordinator.ts) is off while a room is unmounted, so an edit made during that window would
   * otherwise be invisible on remount - mountRoom()'s listing-driven loop would see the server
   * version unchanged, skip the file, and never notice the local edit exists, let alone protect it
   * with a conflict copy. Call this before that loop on every (re)mount so such edits are treated
   * as dirty-equivalent, matching normal dirty-file handling in applyRemoteChange/applyRemoteDelete.
   * Already-dirty files and files with no local copy to compare are left untouched.
   */
  async reconcileLocalEdits(room: MountedRoomState): Promise<void> {
    // Third-hardware-testing-round item 1: a room this device can't push to has no legitimate basis
    // to ever treat a local content divergence as a real edit worth protecting - any such divergence
    // must always silently defer to the synced/server version, never dirty-track. Skip the whole
    // reconcile for such a room rather than gating each iteration.
    if (!(room.canPushLocalEdits ?? false)) {
      return;
    }
    for (const [relativePath, tracked] of Object.entries(room.files)) {
      if (tracked.dirty || tracked.serverSha256 === null) {
        continue;
      }
      // Second-hardware-testing-round item 2: a CRDT-managed path's on-disk content changes
      // constantly and legitimately via the CRDT lane (yCollab live edits, CrdtSessionManager's
      // materialize write-back) - none of which ever touch tracked.localSha256, since CRDT edits
      // bypass this CAS-lane bookkeeping entirely by design (that's the whole point of the CRDT-lane
      // routing fix from the prior hardware-testing round). Without this skip, every (re)mount's
      // reconcile sees the hash mismatch and marks the file dirty purely as an artifact of never
      // updating the tracked hash - not a real unsynced edit - and the next remote apply then forks
      // a spurious conflict copy for it.
      if (room.crdtEnabled && isCrdtEligiblePath(relativePath)) {
        continue;
      }
      const path = mountedPath(room, relativePath);
      if (!(await this.vault.exists(path))) {
        continue;
      }
      const content = await this.readContent(path, relativePath);
      const localSha = await VaultSyncEngine.sha256(content);
      if (localSha !== tracked.localSha256) {
        room.files[relativePath] = { ...tracked, localSha256: localSha, dirty: true };
      }
    }
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const buffer = Buffer.from(base64, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function mountedPath(room: MountedRoomState, relativePath: string): string {
  return `${stripSlashes(room.mountPath)}/${stripSlashes(relativePath)}`;
}

function stripSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function formatConflictTimestamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

function isVersionConflict(error: unknown): error is {
  code: "VERSION_CONFLICT";
  serverVersion: number;
  serverSha256: string;
  serverContent: string;
} {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "VERSION_CONFLICT";
}
