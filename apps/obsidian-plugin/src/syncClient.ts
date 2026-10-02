import { assertPortablePath, isCrdtEligiblePath, isEligibleBinaryPath, portablePathKey } from "@vault-rooms/protocol";

export type VaultChangeEvent = { type: "create" | "modify" | "delete"; path: string } | { type: "rename"; path: string; oldPath: string };

export interface VaultAdapter {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  /** Byte-accurate read for images/PDFs - `read()` decodes as UTF-8 text and corrupts these. */
  readBinary(path: string): Promise<ArrayBuffer>;
  /** Text read that rejects a file which is not UTF-8 instead of decoding it with replacement
   *  characters. Used for text about to be pushed; adapters without it fall back to `read()`. */
  readStrictUtf8?(path: string): Promise<string>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  delete(path: string): Promise<void>;
  /** Moves a file in place. */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Move the current file to a local conflict copy, then create the survivor exclusively.
   * Recovery must never overwrite content read before an asynchronous preservation/download. */
  recoverFile?(path: string, conflictCopyPath: string, replacement?: { content: string; contentEncoding: "utf8" | "base64" }): Promise<void>;
  /** Explicit local repair bypasses portable alias lookup only for the selected exact file. */
  renameExact?(oldPath: string, newPath: string): Promise<void>;
  /** Scoped synchronous tree discovery, including empty aliased folders. */
  pathCollisions?(prefix: string): Array<{ key: string; paths: string[] }>;
  isFolderExact?(path: string): boolean;
  exists(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  /** Returns an unsubscribe function - callers are responsible for calling it once they no longer
   *  need this particular registration (e.g. a room was unmounted), otherwise the listener stays
   *  registered for the plugin's whole lifetime. */
  onChange(cb: (event: VaultChangeEvent) => void): () => void;
}

export type RelayFileApi = {
  readFile(
    roomId: string,
    relativePath: string
  ): Promise<{ relativePath: string; version: number; sha256: string; content: string; contentEncoding?: "utf8" | "base64" }>;
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
  /** Durable CAS case-only rename intent; delete the old name before creating this spelling. */
  renamedToRelativePath?: string;
  /** Set when the last push attempt for this path failed with a terminal (non-retryable) error,
   *  e.g. FILE_TOO_LARGE or INVALID_PATH - see pushCoordinator.ts's isTerminalSyncError. Retrying a
   *  terminal error can never succeed without the user changing something, so the retry driver
   *  skips paths with this set instead of retrying forever; persisted so the failure survives a
   *  restart as a durable (if not yet surfaced in the UI) indicator. Cleared on the next successful
   *  push attempt for this path. */
  syncError?: string;
};

export type PendingCrdtOperation =
  | {
      operationId: string;
      kind: "create";
      relativePath: string;
      queuedAt: string;
      attemptedAt?: string;
      deleteAfterAck?: true;
    }
  | {
      operationId: string;
      kind: "rename";
      oldRelativePath: string;
      relativePath: string;
      queuedAt: string;
      attemptedAt?: string;
      deleteAfterAck?: true;
    };

export type LocalPathRepairOptions = {
  preserveCrdt(paths: string[]): Promise<void>;
  persist(): Promise<void>;
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
  /** Last known CRDT mode, available before the first room refresh completes. */
  crdtEnabled?: boolean;
  /** Last known `sync:push` permission. Unknown defaults to false. */
  canPushLocalEdits?: boolean;
  /** Durable structural intent for CRDT create/rename operations that have not yet received an ACK.
   *  Optional so settings written before the offline journal load as an empty queue. */
  pendingCrdtOperations?: PendingCrdtOperation[];
  /** Existing Markdown files changed before their CRDT session could open (for example, Obsidian
   *  started while the relay was stopped). Snapshot/materialized-file handling protects these
   *  paths until the next CRDT handshake has merged the on-disk text. */
  pendingCrdtTextPaths?: string[];
  /** Quarantined server identities. Never infer a local deletion from these entries. */
  pathCollisionKeys?: string[];
  /** Resolved keys remain paused until local preservation and authoritative pull finish. */
  pathRecoveryKeys?: string[];
  /** Retain original spellings to recover exact-hashed CRDT caches across a restart. */
  pathCollisionPaths?: string[];
  pathLocalCollisionKeys?: string[];
  pathRecoveryErrors?: Record<string, string>;
  /** Local repair history retains tracking and structural intent without replaying it. */
  pathRepairBackups?: Array<{ repairedAt: string; files: Record<string, MountedFileState>; operations: PendingCrdtOperation[] }>;
};

/** Looks up tracking by portable identity while retaining the stored spelling. */
export function getMountedFileEntry(room: MountedRoomState, relativePath: string): [string, MountedFileState] | undefined {
  const key = portablePathKey(relativePath);
  const entries = Object.entries(room.files).filter(([path]) => portablePathKey(path) === key);
  const live = entries.filter(([, state]) => state.serverSha256 !== null || state.dirty);
  const candidates = live.length > 0 ? live : entries;
  return candidates.find(([path]) => path === relativePath) ?? candidates[0];
}

/** Conflicting legacy tracking is preserved and paused instead of choosing a local winner. */
export function isMountedPathBlocked(room: MountedRoomState, relativePath: string, allowRecovery = false): boolean {
  const key = portablePathKey(relativePath);
  if (room.pathCollisionKeys?.some((path) => portablePathKey(path) === key)) return true;
  if (room.pathLocalCollisionKeys?.some((path) => pathMatchesKey(relativePath, portablePathKey(path)))) return true;
  if (!allowRecovery && room.pathRecoveryKeys?.some((path) => portablePathKey(path) === key)) return true;
  const live = Object.entries(room.files).filter(([path, state]) =>
    portablePathKey(path) === key && (state.serverSha256 !== null || state.dirty));
  return live.length > 1;
}

export function updatePathCollisionKeys(room: MountedRoomState, files: Array<{ relativePath: string; pathCollision?: boolean }>): void {
  const priorPaths = collisionRecoveryPaths(room);
  const collisionPaths = files.filter((file) => file.pathCollision).map((file) => file.relativePath);
  const currentKeys = new Set(collisionPaths.map(portablePathKey));
  room.pathCollisionKeys = [...currentKeys];
  room.pathRecoveryKeys = [...new Set(priorPaths.map(portablePathKey))].filter((key) => !currentKeys.has(key));
  room.pathCollisionPaths = [...new Set([...priorPaths, ...collisionPaths])];
}

export function collisionRecoveryPaths(room: MountedRoomState): string[] {
  const keys = new Set([...(room.pathCollisionKeys ?? []), ...(room.pathRecoveryKeys ?? [])].map(portablePathKey));
  return [...new Set([...(room.pathCollisionPaths ?? []), ...keys, ...Object.keys(room.files).filter((path) => keys.has(portablePathKey(path)))])];
}

export function completePathRecovery(room: MountedRoomState, relativePath: string): void {
  const key = portablePathKey(relativePath);
  room.pathRecoveryKeys = room.pathRecoveryKeys?.filter((path) => portablePathKey(path) !== key);
  room.pathCollisionPaths = room.pathCollisionPaths?.filter((path) => portablePathKey(path) !== key);
  if (room.pathRecoveryErrors) delete room.pathRecoveryErrors[key];
}

function pathMatchesKey(path: string, key: string): boolean {
  const candidate = portablePathKey(path);
  return candidate === key || candidate.startsWith(`${key}/`);
}

/** Only names about to be created/changed use portable validation; legacy reads/deletes remain valid. */
export function localPortablePathError(relativePath: string): Error | undefined {
  try {
    assertPortablePath(relativePath);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

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

/** Resolves `sync:push`, defaulting unknown permission state to false. */
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

// The trailing `(?:\.[^/]+)?` is optional (2026-08-03 sync-widening fix): createConflictCopyPath
// above leaves `extension` empty for a path with no dot (e.g. `LICENSE`, now a legitimately synced
// binary file), so its conflict copy is `LICENSE (conflict ... 2026-...)` with nothing after the
// closing paren. Requiring an extension here used to make that copy invisible to this function -
// treated as a brand-new file rather than a conflict copy, so it never appeared in conflict
// resolution and got pushed upstream like any other create.
export function isConflictCopyPath(path: string): boolean {
  return /\(conflict .+ \d{4}-\d{2}-\d{2}T\d{6}\)(?: \d+)?(?:\.[^/]+)?$/.test(path);
}

// Same optional-extension fix as isConflictCopyPath above, via an alternation in the lookahead
// instead of a plain anchor: either "an extension runs to the end" (unchanged behavior) or "this is
// already the end of the string" (the extensionless case).
const CONFLICT_SUFFIX = /\s\(conflict .+ \d{4}-\d{2}-\d{2}T\d{6}\)(?: \d+)?(?=\.[^/]+$|$)/;

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
  private async readContent(path: string, relativePath: string, options: { forPush?: boolean } = {}): Promise<string> {
    if (isEligibleBinaryPath(relativePath)) {
      return arrayBufferToBase64(await this.vault.readBinary(path));
    }
    // Pushed text has to be UTF-8: other bytes would arrive on every device as replacement characters.
    if (options.forPush && this.vault.readStrictUtf8) {
      return this.vault.readStrictUtf8(path);
    }
    return this.vault.read(path);
  }

  /**
   * `contentEncoding`, when supplied, is the relay's authoritative classification (2026-08-03) and
   * is trusted over this device's own local `isEligibleBinaryPath` guess - the whole point is that a
   * receiver shouldn't have to re-derive it from the path extension at all. Omitted only when
   * talking to a relay that predates the field, in which case the local guess is the only option
   * (and, for a build new enough to have this code, agrees with a same-version relay anyway).
   */
  private async writeContent(path: string, relativePath: string, content: string, contentEncoding?: "utf8" | "base64"): Promise<void> {
    const isBinary = contentEncoding ? contentEncoding === "base64" : isEligibleBinaryPath(relativePath);
    if (isBinary) {
      await this.vault.writeBinary(path, base64ToArrayBuffer(content));
      return;
    }
    await this.vault.write(path, content);
  }

  /** Protect data kept while a server key was quarantined before pulling its surviving identity. */
  async preserveRecoveredLocalFile(
    room: MountedRoomState,
    remote: { relativePath: string; sha256: string | null },
    deviceName: string
  ): Promise<void> {
    if (isMountedPathBlocked(room, remote.relativePath, true)) return;
    const entry = getMountedFileEntry(room, remote.relativePath);
    const relativePath = entry?.[0] ?? remote.relativePath;
    const path = mountedPath(room, relativePath);
    if (await this.vault.exists(path)) {
      const content = await this.readContent(path, relativePath);
      await this.preserveRecoveredText(room, relativePath, content, remote.sha256, deviceName);
    }
    // Do not clear pending intent here: the disk may change again before the survivor arrives.
  }

  async preserveRecoveredText(room: MountedRoomState, relativePath: string, content: string, expectedSha256: string | null, deviceName: string): Promise<void> {
    if (await VaultSyncEngine.sha256(content) === expectedSha256) return;
    const path = mountedPath(room, relativePath);
    let copyPath: string;
    try {
      copyPath = await createConflictCopyPath(this.vault, path, deviceName, this.now());
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "PATH_COLLISION") throw error;
      // An aliased parent folder cannot be selected even for a new child. Keep every cached
      // text at the unambiguous room root so exact-folder repair can proceed safely.
      copyPath = await createConflictCopyPath(this.vault, mountedPath(room, relativePath.split("/").join(" - ")), deviceName, this.now());
    }
    await this.writeContent(copyPath, relativePath, content);
  }

  async applyRemoteChange(
    room: MountedRoomState,
    remote: { relativePath: string; version: number; sha256: string; content: string; contentEncoding?: "utf8" | "base64" },
    deviceName: string,
    allowSameVersion = false,
    recoveringCollision = false
  ): Promise<void> {
    if (isMountedPathBlocked(room, remote.relativePath, recoveringCollision)) return;
    const entry = getMountedFileEntry(room, remote.relativePath);
    const trackedPath = entry?.[0] ?? remote.relativePath;
    const existingState = entry?.[1];
    // A case-only CAS rename arrives as delete/create. Its tombstone may retain the old
    // spelling in tracking, but the recreated file must use the new server spelling on disk.
    const diskRelativePath = existingState?.serverSha256 === null ? remote.relativePath : trackedPath;
    const path = mountedPath(room, diskRelativePath);
    if (existingState && (remote.version < existingState.serverVersion || (!allowSameVersion && remote.version === existingState.serverVersion))) {
      return;
    }
    // Read-only local divergence never creates a conflict copy.
    if (!recoveringCollision && (room.canPushLocalEdits ?? false) && existingState?.dirty && (await this.vault.exists(path))) {
      const local = await this.readContent(path, remote.relativePath);
      await this.writeContent(await createConflictCopyPath(this.vault, path, deviceName, this.now()), remote.relativePath, local);
    }
    if (recoveringCollision) {
      await this.replaceRecoveredFile(path, remote.relativePath, deviceName, remote);
    } else {
      await this.writeContent(path, remote.relativePath, remote.content, remote.contentEncoding);
    }
    room.files[trackedPath] = {
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
    allowSameVersion = false,
    recoveringCollision = false
  ): Promise<void> {
    if (isMountedPathBlocked(room, remote.relativePath, recoveringCollision)) return;
    const entry = getMountedFileEntry(room, remote.relativePath);
    const trackedPath = entry?.[0] ?? remote.relativePath;
    const path = mountedPath(room, trackedPath);
    const existingState = entry?.[1];
    if (existingState && (remote.version < existingState.serverVersion || (!allowSameVersion && remote.version === existingState.serverVersion))) {
      return;
    }
    // Same defense-in-depth as applyRemoteChange above: never fork a conflict copy for a room this
    // device can't push to, regardless of a possibly-stale `dirty` flag.
    if (!recoveringCollision && (room.canPushLocalEdits ?? false) && existingState?.dirty && (await this.vault.exists(path))) {
      const local = await this.readContent(path, remote.relativePath);
      await this.writeContent(await createConflictCopyPath(this.vault, path, deviceName, this.now()), remote.relativePath, local);
    }
    if (recoveringCollision) {
      await this.replaceRecoveredFile(path, remote.relativePath, deviceName);
    } else if (await this.vault.exists(path)) {
      await this.vault.delete(path);
    }
    room.files[trackedPath] = {
      serverVersion: remote.version,
      serverSha256: null,
      localSha256: null,
      dirty: false
    };
  }

  private async replaceRecoveredFile(path: string, relativePath: string, deviceName: string,
    replacement?: { content: string; contentEncoding?: "utf8" | "base64" }): Promise<void> {
    if (!this.vault.recoverFile) throw new Error("This vault adapter cannot safely recover a paused file.");
    const copyPath = await createConflictCopyPath(this.vault, path, deviceName, this.now());
    await this.vault.recoverFile(path, copyPath, replacement && {
      content: replacement.content,
      contentEncoding: replacement.contentEncoding ?? (isEligibleBinaryPath(relativePath) ? "base64" : "utf8")
    });
  }

  async listLocalPathCollisions(room: MountedRoomState): Promise<Array<{ key: string; paths: string[] }>> {
    const scoped = this.scanLocalPathCollisions(room);
    if (scoped) return scoped;
    const groups = new Map<string, string[]>();
    const mountSegments = room.mountPath.split("/").filter(Boolean);
    for (const path of await this.vault.list(room.mountPath)) {
      const segments = path.split("/");
      if (!mountSegments.every((segment, index) => portablePathKey(segment) === portablePathKey(segments[index] ?? ""))) continue;
      const relativePath = segments.slice(mountSegments.length).join("/");
      if (!relativePath || isConflictCopyPath(relativePath) || relativePath.split("/").some(segment => segment.startsWith("."))) continue;
      const key = portablePathKey(relativePath);
      const paths = groups.get(key) ?? [];
      if (!paths.includes(relativePath)) paths.push(relativePath);
      groups.set(key, paths);
    }
    const collisions = [...groups].filter(([, paths]) => paths.length > 1).map(([key, paths]) => ({ key, paths }));
    room.pathLocalCollisionKeys = [...new Set([...(room.pathLocalCollisionKeys ?? []), ...collisions.map(group => group.key)])];
    room.pathCollisionPaths = [...new Set([...(room.pathCollisionPaths ?? []), ...collisions.flatMap(group => group.paths)])];
    return collisions;
  }

  scanLocalPathCollisions(room: MountedRoomState): Array<{ key: string; paths: string[] }> | undefined {
    if (!this.vault.pathCollisions) return undefined;
    const collisions = this.vault.pathCollisions(room.mountPath);
    // A manual rename can remove the disk alias while an old CRDT identity/intent remains.
    // Only explicit preservation releases that prior quarantine.
    room.pathLocalCollisionKeys = [...new Set([...(room.pathLocalCollisionKeys ?? []), ...collisions.map(group => group.key)])];
    room.pathCollisionPaths = [...new Set([...(room.pathCollisionPaths ?? []), ...collisions.flatMap(group => group.paths)])];
    return collisions;
  }

  /** An authoritative snapshot also resolves abandoned paths that no longer exist remotely. */
  async recoverAbsentSnapshotPaths(room: MountedRoomState, files: Array<{ relativePath: string }>, deviceName: string): Promise<boolean> {
    const present = new Set(files.map(file => portablePathKey(file.relativePath)));
    let changed = false;
    for (const key of [...(room.pathRecoveryKeys ?? [])]) {
      if (present.has(portablePathKey(key)) || isMountedPathBlocked(room, key, true)) continue;
      if (room.pendingCrdtTextPaths?.some(path => portablePathKey(path) === portablePathKey(key)) ||
        room.pendingCrdtOperations?.some(operation => portablePathKey(operation.relativePath) === portablePathKey(key) ||
          (operation.kind === "rename" && portablePathKey(operation.oldRelativePath) === portablePathKey(key)))) continue;
      const path = getMountedFileEntry(room, key)?.[0] ?? room.pathCollisionPaths?.find(path => portablePathKey(path) === portablePathKey(key)) ?? key;
      try {
        await this.applyRemoteDelete(room, { relativePath: path, version: getMountedFileEntry(room, path)?.[1].serverVersion ?? 0 }, deviceName, true, true);
        completePathRecovery(room, path);
      } catch (error) {
        (room.pathRecoveryErrors ??= {})[portablePathKey(key)] = error instanceof Error ? error.message : String(error);
      }
      changed = true;
    }
    return changed;
  }

  async repairLocalPathCollision(room: MountedRoomState, exactRelativePath: string, newRelativePath: string, options: LocalPathRepairOptions): Promise<void> {
    assertPortablePath(newRelativePath);
    const key = portablePathKey(exactRelativePath);
    if (key === portablePathKey(newRelativePath)) throw new Error("Choose a distinct name, not another spelling of the same path.");
    if (isMountedPathBlocked(room, newRelativePath) || getMountedFileEntry(room, newRelativePath) || await this.vault.exists(mountedPath(room, newRelativePath))) {
      throw new Error("The destination already exists or is paused.");
    }
    if (!this.vault.renameExact) throw new Error("This vault adapter cannot repair an exact local path.");
    const collisions = await this.listLocalPathCollisions(room);
    const paths = [...new Set([exactRelativePath, ...(collisions.find(group => group.key === key)?.paths ?? []),
      ...Object.keys(room.files).filter(path => pathMatchesKey(path, key)),
      ...(await this.vault.list(room.mountPath)).map(path => path.split("/").slice(room.mountPath.split("/").filter(Boolean).length).join("/")).filter(path => pathMatchesKey(path, key)),
      ...(room.pathCollisionPaths ?? []).filter(path => pathMatchesKey(path, key))])];
    if ((room.pendingCrdtOperations ?? []).some(operation => pathMatchesKey(operation.relativePath, key) ||
      (operation.kind === "rename" && pathMatchesKey(operation.oldRelativePath, key)))) {
      throw new Error("Preserve and retire the uncertain structural intent before renaming this local file.");
    }
    this.pauseLocalRecovery(room, paths);
    await options.persist();
    await options.preserveCrdt(paths);
    const backup = Object.fromEntries(Object.entries(room.files).filter(([path]) => pathMatchesKey(path, key)).map(([path, state]) => [path, { ...state }]));
    (room.pathRepairBackups ??= []).push({ repairedAt: this.now().toISOString(), files: backup, operations: [] });
    await options.persist();
    const isFolder = this.vault.isFolderExact?.(mountedPath(room, exactRelativePath)) ?? paths.some(path => path.startsWith(`${exactRelativePath}/`));
    await this.vault.renameExact(mountedPath(room, exactRelativePath), mountedPath(room, newRelativePath));
    // The old identity is pulled afresh only after its files/caches have been preserved.
    for (const path of Object.keys(backup)) delete room.files[path];
    const selected = paths.filter(path => path === exactRelativePath || path.startsWith(`${exactRelativePath}/`));
    const descendants = selected.filter(path => path !== exactRelativePath && !isConflictCopyPath(path) && !path.split("/").some(segment => segment.startsWith(".")));
    const newPaths = isFolder ? descendants.map(path => newRelativePath + path.slice(exactRelativePath.length)) : [newRelativePath];
    for (const path of newPaths) {
      room.files[path] = { serverVersion: 0, serverSha256: null, localSha256: null, dirty: true };
      if (room.crdtEnabled && isCrdtEligiblePath(path)) room.pendingCrdtTextPaths = [...new Set([...(room.pendingCrdtTextPaths ?? []), path])];
    }
    if (isFolder) {
      room.pathRecoveryKeys = room.pathRecoveryKeys?.filter(path => portablePathKey(path) !== key);
      room.pathCollisionPaths = room.pathCollisionPaths?.filter(path => portablePathKey(path) !== key);
    }
    const remainingCollisions = await this.listLocalPathCollisions(room);
    room.pathLocalCollisionKeys = [...new Set([...(room.pathLocalCollisionKeys ?? []).filter(path => portablePathKey(path) !== key), ...remainingCollisions.map(group => group.key)])];
    await options.persist();
  }

  async abandonAmbiguousLocalPathIntents(room: MountedRoomState, relativePath: string, options: LocalPathRepairOptions): Promise<void> {
    const keys = new Set([portablePathKey(relativePath)]);
    const operations = room.pendingCrdtOperations ?? [];
    // Preserve the whole connected rename chain; dropping only its first link can replay a
    // destructive follower against the survivor later.
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const operation of operations) {
        const paths = [operation.relativePath, ...(operation.kind === "rename" ? [operation.oldRelativePath] : [])];
        if (!paths.some(path => [...keys].some(key => pathMatchesKey(path, key)))) continue;
        for (const path of paths) if (!keys.has(portablePathKey(path))) { keys.add(portablePathKey(path)); expanded = true; }
      }
    }
    const affected = operations.filter(operation => [...keys].some(key => pathMatchesKey(operation.relativePath, key) ||
      (operation.kind === "rename" && pathMatchesKey(operation.oldRelativePath, key))));
    const files = Object.fromEntries(Object.entries(room.files).filter(([path]) => [...keys].some(key => pathMatchesKey(path, key))).map(([path, state]) => [path, { ...state }]));
    const paths = [...new Set([...keys, ...Object.keys(files), ...(room.pathCollisionPaths ?? []).filter(path => keys.has(portablePathKey(path))),
      ...affected.flatMap(operation => [operation.relativePath, ...(operation.kind === "rename" ? [operation.oldRelativePath] : [])])])];
    this.pauseLocalRecovery(room, paths);
    await options.persist();
    await options.preserveCrdt(paths);
    (room.pathRepairBackups ??= []).push({ repairedAt: this.now().toISOString(), files, operations: affected.map(operation => ({ ...operation })) });
    await options.persist();
    const remainingCollisions = await this.listLocalPathCollisions(room);
    const priorTextPaths = room.pendingCrdtTextPaths;
    room.pendingCrdtOperations = operations.filter(operation => !affected.includes(operation));
    room.pendingCrdtTextPaths = priorTextPaths?.filter(path => ![...keys].some(key => pathMatchesKey(path, key)));
    for (const path of Object.keys(files)) delete room.files[path];
    room.pathLocalCollisionKeys = [...new Set([...(room.pathLocalCollisionKeys ?? []).filter(path => !keys.has(portablePathKey(path))), ...remainingCollisions.map(group => group.key)])];
    const folders = paths.filter(path => this.vault.isFolderExact?.(mountedPath(room, path)));
    room.pathRecoveryKeys = room.pathRecoveryKeys?.filter(key => !folders.some(path => portablePathKey(path) === portablePathKey(key)));
    room.pathCollisionPaths = room.pathCollisionPaths?.filter(path => !folders.some(folder => portablePathKey(folder) === portablePathKey(path)));
    try {
      await options.persist();
    } catch (error) {
      Object.assign(room.files, files);
      const current = room.pendingCrdtOperations ?? [];
      const affectedIds = new Set(affected.map(operation => operation.operationId));
      const originalIds = new Set(operations.map(operation => operation.operationId));
      // Other paths keep syncing while settings save awaits. Restore only retired intentions;
      // never replace the current journal/text list and discard newly queued unrelated edits.
      room.pendingCrdtOperations = [
        ...operations.filter(operation => affectedIds.has(operation.operationId) || current.some(candidate => candidate.operationId === operation.operationId)),
        ...current.filter(operation => !originalIds.has(operation.operationId))
      ];
      room.pendingCrdtTextPaths = [...new Set([...(priorTextPaths ?? []).filter(path => [...keys].some(key => pathMatchesKey(path, key))), ...(room.pendingCrdtTextPaths ?? [])])];
      throw error;
    }
  }

  private pauseLocalRecovery(room: MountedRoomState, paths: string[]): void {
    room.pathRecoveryKeys = [...new Set([...(room.pathRecoveryKeys ?? []), ...paths.map(portablePathKey)])];
    room.pathCollisionPaths = [...new Set([...(room.pathCollisionPaths ?? []), ...paths])];
  }

  async pushLocalChange(room: MountedRoomState, relativePath: string, deviceName: string): Promise<void> {
    if (isConflictCopyPath(relativePath) || isMountedPathBlocked(room, relativePath)) {
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
    const content = await this.readContent(path, relativePath, { forPush: true });
    const entry = getMountedFileEntry(room, relativePath);
    const trackedPath = entry?.[0] ?? relativePath;
    const current = entry?.[1];
    const localSha = await VaultSyncEngine.sha256(content);
    if (current?.serverSha256 === localSha) {
      room.files[trackedPath] = { ...current, localSha256: localSha, dirty: false, localDeleted: false };
      return;
    }

    // A tombstoned entry (serverSha256: null, from applyRemoteDelete) or a never-tracked file
    // (current undefined) both mean "no live server content to base a write on," so baseVersion
    // must be 0 - only trust current.serverVersion as a real prior version when serverSha256 is
    // non-null. Otherwise a file recreated after a remote delete would send the tombstone's real
    // (non-zero) version and the server would unconditionally reject it with FILE_DELETED.
    const baseVersion = current?.serverSha256 != null ? current.serverVersion : 0;
    if (baseVersion === 0) assertPortablePath(relativePath);
    try {
      const result = await this.api.writeFile(room.roomId, trackedPath, baseVersion, content);
      room.files[trackedPath] = {
        serverVersion: result.version,
        serverSha256: result.sha256,
        localSha256: localSha,
        dirty: false
      };
    } catch (error) {
      if (isVersionConflict(error)) {
        await this.writeContent(await createConflictCopyPath(this.vault, path, deviceName, this.now()), relativePath, content);
        await this.writeContent(path, relativePath, error.serverContent);
        room.files[trackedPath] = {
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
  async pushLocalDelete(room: MountedRoomState, relativePath: string, options: { renamedToRelativePath?: string } = {}): Promise<void> {
    if (isConflictCopyPath(relativePath) || isMountedPathBlocked(room, relativePath)) {
      return;
    }
    const entry = getMountedFileEntry(room, relativePath);
    const trackedPath = entry?.[0] ?? relativePath;
    const current = entry?.[1];
    if (!current || current.serverSha256 === null) {
      delete room.files[trackedPath];
      return;
    }
    const path = mountedPath(room, relativePath);
    if (!options.renamedToRelativePath && await this.vault.exists(path)) {
      room.files[trackedPath] = { ...current, localDeleted: false };
      return;
    }
    await this.api.deleteFile(room.roomId, trackedPath, current.serverVersion);
    delete room.files[trackedPath];
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
    // Read-only rooms always defer to server content.
    if (!(room.canPushLocalEdits ?? false)) {
      return;
    }
    for (const [relativePath, tracked] of Object.entries(room.files)) {
      if (isMountedPathBlocked(room, relativePath) || tracked.dirty || tracked.serverSha256 === null) {
        continue;
      }
      // CRDT writes bypass CAS hashes and are not local divergence.
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

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const buffer = Buffer.from(base64, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function mountedPath(room: MountedRoomState, relativePath: string): string {
  const mountPath = stripSlashes(room.mountPath);
  const filePath = stripSlashes(relativePath);
  return mountPath ? `${mountPath}/${filePath}` : filePath;
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
  // The relay leaves the copy out for a caller who may not read the file; there is nothing to
  // resolve against then, so the push fails and the local file stays as it is.
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "VERSION_CONFLICT" &&
    typeof (error as { serverContent?: unknown }).serverContent === "string"
  );
}
