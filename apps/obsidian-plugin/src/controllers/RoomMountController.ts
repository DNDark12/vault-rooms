import { Notice } from "obsidian";
import { isEligiblePath } from "@vault-rooms/protocol";
import type { RoomSummary } from "../apiClient.js";
import {
  canonicalPathForConflictCopy,
  isConflictCopyPath,
  resolveRoomMountPath,
  type VaultAdapter,
  VaultSyncEngine
} from "../syncClient.js";
import { listFiles } from "../vaultTraversal.js";
import type { PluginContext } from "./PluginContext.js";

export type RoomMountControllerDeps = Pick<
  PluginContext,
  "app" | "settings" | "visibleRooms" | "apiFor" | "requireActiveServer" | "saveSettings" | "renderOpenRoomsViews"
> & {
  vaultAdapter: VaultAdapter;
  getSyncEngine(): VaultSyncEngine;
  stopWatchingRoom(roomId: string): void;
  watchMountedRoom(roomId: string): void;
  subscribeRoom(roomId: string): void;
  /** Drops in-memory CRDT session state and deletes persisted CRDT documents for a room (contract
   *  1.12: cleanup on leaving/unmounting a room). Optional so tests that don't touch the CRDT lane
   *  don't need to stub it. */
  disposeCrdtRoom?(roomId: string): void;
};

/** Owns local mount/unmount state, conflict discovery, and mount-time reconciliation. */
export class RoomMountController {
  constructor(private readonly deps: RoomMountControllerDeps) {}

  async mountFirstVisibleRoom(): Promise<void> {
    const rooms = this.deps.visibleRooms;
    const room = rooms[0];
    if (!room) {
      new Notice("No visible rooms to mount.");
      return;
    }
    await this.mountRoom(room);
  }

  /**
   * (Re)mounts a room locally. The relay server's file listing is always treated as the
   * authoritative source of truth (the owner/host is where files actually live) - this matters
   * most when a member is removed from a room and later re-added: any files that were deleted on
   * the server in the meantime carry a tombstone (`deleted: true`) in the listing and must be
   * removed locally rather than left behind as stale copies. Files whose server version already
   * matches what we last synced are left untouched so we don't clobber unpushed local edits;
   * everything else is routed through VaultSyncEngine so dirty local edits get a conflict copy
   * instead of being silently overwritten.
   */
  async mountRoom(room: RoomSummary): Promise<void> {
    // Single-file rooms are no longer supported (see CreateRoomModal.ts) - their sync prefix logic
    // never actually worked (mountPath was always treated as a directory), so mounting one would
    // silently sync nothing at all with no indication why. Rooms created before this change can
    // still exist server-side (the server keeps accepting the stored `type` for back-compat); flag
    // it clearly instead of proceeding into a no-op mount.
    if (room.type === "file") {
      new Notice(`"${room.name}" is a single-file room, which is no longer supported - recreate it as a folder room.`);
      return;
    }
    const server = this.deps.requireActiveServer();
    const settings = this.deps.settings;
    const mountPath = this.roomMountPathFor(room);
    const state = (settings.mountedRooms[room.id] = settings.mountedRooms[room.id] ?? {
      roomId: room.id,
      serverId: server.id,
      mountPath,
      files: {}
    });
    state.mountPath = mountPath;
    state.serverId = server.id;
    state.unmounted = false;
    // Third-hardware-testing-round item 1: mirror this device's actual write access onto the
    // persisted state *before* reconcileLocalEdits/the "push anything unknown" loop below run, so
    // both read the freshest permission instead of whatever was last persisted (possibly stale/
    // unset on a first-ever mount). `room` is the RoomSummary this call was given directly, so no
    // fallback-resolver is needed here - `permissions` is always present.
    const canPushLocalEdits = room.permissions.includes("sync:push");
    state.canPushLocalEdits = canPushLocalEdits;

    // Capture the engine once for this whole mount, so a mid-mount server switch cannot route the
    // remainder of the operation through the newly-active server's engine.
    const syncEngine = this.deps.getSyncEngine();
    // The watcher (which normally marks an edited file dirty - see pushCoordinator.ts) is off
    // while a room is unmounted, so an edit made during that window would otherwise be invisible
    // here: the listing loop below only compares against the server's version and would skip a
    // file whose server version hasn't changed, silently downloading over the local edit. Re-hash
    // every already-tracked file first so such edits are treated as dirty-equivalent and get a
    // conflict copy instead of being clobbered.
    await syncEngine.reconcileLocalEdits(state);
    const api = this.deps.apiFor(server);
    const files = await api.listFiles(room.id);
    const knownRelativePaths = new Set(files.files.map((file) => file.relativePath));
    for (const file of files.files) {
      const tracked = state.files[file.relativePath];
      if (file.deleted) {
        if (tracked) {
          await syncEngine.applyRemoteDelete(state, { relativePath: file.relativePath, version: file.version }, server.deviceName);
        }
        continue;
      }
      if (tracked && !tracked.dirty && tracked.serverVersion === file.version) {
        continue;
      }
      const content = await api.readFile(room.id, file.relativePath);
      await syncEngine.applyRemoteChange(state, content, server.deviceName);
    }

    // The server's listing only covers what's already been synced. On the room owner's own
    // device, mountPath is the real sourcePath folder, which typically already has real content
    // before the room ever existed - without this, that pre-existing content would just sit there
    // forever, since the local file watcher only reacts to *future* edits. Push anything under
    // mountPath the server has never heard of (skips anything it already knows about, including
    // tombstoned/deleted paths - those are intentional server-side deletions, not "missing" files).
    //
    // Third-hardware-testing-round item 1: a room this device can't push to has no legitimate basis
    // to ever push anything here - skip the whole loop rather than attempting (and silently
    // swallowing failures for) pushes that can only ever be rejected server-side.
    if (canPushLocalEdits) {
      const localPaths = await this.deps.vaultAdapter.list(mountPath);
      const configDir = this.deps.app.vault.configDir.replace(/\/+$/, "");
      for (const localPath of localPaths) {
        if (!mountPath && (localPath === configDir || localPath.startsWith(`${configDir}/`))) {
          continue;
        }
        const relativePath = mountPath ? localPath.slice(mountPath.length + 1) : localPath;
        if (!relativePath || knownRelativePaths.has(relativePath) || !isEligiblePath(relativePath)) {
          continue;
        }
        try {
          await syncEngine.pushLocalChange(state, relativePath, server.deviceName);
        } catch (error) {
          console.error(`Vault Rooms: failed to push existing file "${relativePath}" to room ${room.name}`, error);
        }
      }
    }

    this.deps.watchMountedRoom(room.id);
    this.deps.subscribeRoom(room.id);
    await this.deps.saveSettings();
    this.deps.renderOpenRoomsViews();
    new Notice(`Mounted ${room.name}`);
  }

  /**
   * Non-destructively unmounts a room: stops the local watcher and live-sync subscription for it,
   * but leaves local files and tracking (settings.mountedRooms[roomId]) in place - see
   * MountedRoomState.unmounted. This matters most for re-mounting later: without kept tracking,
   * mountRoom() would see no tracked state for any file and download the server's copy over
   * whatever is on disk, with no conflict copy, silently discarding any local edits made in the
   * meantime. Use forgetRoom() for the old fully-destructive "drop everything" behavior.
   */
  async unmountRoom(roomId: string): Promise<void> {
    const room = this.deps.visibleRooms.find((candidate) => candidate.id === roomId);
    const roomState = this.deps.settings.mountedRooms[roomId];
    this.deps.stopWatchingRoom(roomId);
    if (roomState) {
      roomState.unmounted = true;
    }
    // Contract 1.12: leaving/unmounting a room deletes its persisted CRDT documents - a later
    // remount starts CRDT state fresh via crdt_create/the handshake rather than risk reloading a
    // persisted doc that's gone stale relative to whatever happened on the server in the meantime.
    this.deps.disposeCrdtRoom?.(roomId);
    await this.deps.saveSettings();
    this.deps.renderOpenRoomsViews();
    new Notice(`Unmounted ${room?.name ?? "room"}`);
  }

  /** Destructively forgets a room's local tracking (the old unmountRoom() behavior) - local files
   *  on disk are left alone (same as unmountRoom), but this device's sync tracking for the room is
   *  dropped entirely, so a later mount starts over as if the room were never mounted here. */
  async forgetRoom(roomId: string): Promise<void> {
    const room = this.deps.visibleRooms.find((candidate) => candidate.id === roomId);
    this.dropRoomTracking(roomId);
    await this.deps.saveSettings();
    this.deps.renderOpenRoomsViews();
    new Notice(`Forgot ${room?.name ?? "room"} on this device`);
  }

  dropRoomTracking(roomId: string): void {
    this.deps.stopWatchingRoom(roomId);
    delete this.deps.settings.mountedRooms[roomId];
    delete this.deps.settings.roomMountPaths[roomId];
    this.deps.disposeCrdtRoom?.(roomId);
  }

  isRoomMounted(roomId: string): boolean {
    const state = this.deps.settings.mountedRooms[roomId];
    return Boolean(state) && !state?.unmounted;
  }

  mountedPathFor(roomId: string): string | undefined {
    return this.deps.settings.mountedRooms[roomId]?.mountPath;
  }

  /** Which server (settings.servers[].id) a mounted room belongs to - see the serverId note on
   *  MountedRoomState. Used by the panel to tell whether a mounted room is under the currently
   *  active server (syncing) or a different, currently-inactive one (paused). */
  mountedRoomServerId(roomId: string): string | undefined {
    return this.deps.settings.mountedRooms[roomId]?.serverId;
  }

  /**
   * Conflict copies are local-only files (see isConflictCopyPath - they're never pushed or
   * synced), so finding them is a plain local file-listing scan, not a server call. Used to
   * render a "Resolve" list per mounted room instead of leaving people to sort them out by hand
   * in the file explorer.
   */
  listRoomConflicts(roomId: string): Array<{ relativePath: string; conflictRelativePath: string }> {
    const mountPath = this.mountedPathFor(roomId);
    if (!mountPath) {
      return [];
    }
    const prefix = mountPath.replace(/\/+$/, "");
    const conflicts: Array<{ relativePath: string; conflictRelativePath: string }> = [];
    const mountedRoot = this.deps.app.vault.getAbstractFileByPath(prefix);
    for (const file of mountedRoot ? listFiles(mountedRoot) : []) {
      const path = file.path;
      if (path !== prefix && !path.startsWith(`${prefix}/`)) {
        continue;
      }
      if (!isConflictCopyPath(path)) {
        continue;
      }
      const canonical = canonicalPathForConflictCopy(path);
      if (!canonical) {
        continue;
      }
      conflicts.push({
        relativePath: canonical.slice(prefix.length + 1),
        conflictRelativePath: path.slice(prefix.length + 1)
      });
    }
    return conflicts;
  }

  async resolveRoomConflict(roomId: string, relativePath: string, conflictRelativePath: string, keep: "mine" | "theirs"): Promise<void> {
    const server = this.deps.requireActiveServer();
    const roomState = this.deps.settings.mountedRooms[roomId];
    if (!roomState) {
      throw new Error("Room is not mounted.");
    }
    await this.deps.getSyncEngine().resolveConflict(roomState, relativePath, conflictRelativePath, keep, server.deviceName);
    await this.deps.saveSettings();
    this.deps.renderOpenRoomsViews();
    new Notice(keep === "mine" ? "Kept your version and re-synced it." : "Kept the synced version and removed your local copy.");
  }

  /**
   * The room owner's device mounts in place at the room's real `sourcePath` (their existing vault
   * folder) - there's nothing to "download," their files already live there, so a separate copy
   * would just be an empty shadow folder that never gets used. Everyone else mounts into a fresh
   * folder under the configured mount root, since they have no pre-existing copy of the room.
   */
  roomMountPathFor(room: RoomSummary): string {
    const server = this.deps.requireActiveServer();
    const isOwner = room.ownerUserId === server.userId;
    return resolveRoomMountPath({
      owner: isOwner,
      configuredOverride: this.deps.settings.roomMountPaths[room.id],
      mountRoot: this.deps.settings.mountRoot,
      mountName: room.mountName,
      sourcePath: room.sourcePath
    });
  }
}
