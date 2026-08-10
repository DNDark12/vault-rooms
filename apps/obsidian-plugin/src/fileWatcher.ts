import { isCrdtEligiblePath } from "@vault-rooms/protocol";
import { isConflictCopyPath, type MountedRoomState, type VaultAdapter, type VaultChangeEvent } from "./syncClient.js";

/** File-sync scope shared by the live watcher and mount-time enumeration. Extension is deliberately
 * unrestricted; these exclusions are local/private/generated paths that must never enter either
 * lane. Keeping one predicate prevents initial mount from uploading paths the watcher ignores. */
export function isSyncableRelativePath(relativePath: string, configDir: string): boolean {
  if (!relativePath) {
    return false;
  }
  const normalizedConfigDir = configDir.replace(/^\/+|\/+$/g, "");
  if (
    (normalizedConfigDir && (relativePath === normalizedConfigDir || relativePath.startsWith(`${normalizedConfigDir}/`))) ||
    relativePath.endsWith(".tmp") ||
    isConflictCopyPath(relativePath)
  ) {
    return false;
  }
  const segments = relativePath.split("/");
  return !segments.some((segment) => segment.startsWith(".") || segment === "node_modules");
}

/** Shared by isWatchableChange (single-path events) and classifyRenameEvent (each side of a
 *  rename/move) - one place that decides "is this vault-relative path something we sync at all".
 *  configDir is required (no fallback default) - a room mounted at the vault root needs the
 *  caller's actual (possibly user-customized) Vault#configDir to filter out the real config
 *  folder, so callers must always pass it explicitly rather than risk silently assuming a
 *  default that may not match. */
function relativePathIfWatchable(path: string, room: MountedRoomState, configDir: string): string | null {
  const mountPath = room.mountPath.replace(/^\/+|\/+$/g, "");
  const prefix = mountPath ? `${mountPath}/` : "";
  if (prefix && !path.startsWith(prefix)) {
    return null;
  }
  const relativePath = prefix ? path.slice(prefix.length) : path;
  if (!isSyncableRelativePath(relativePath, configDir)) {
    return null;
  }
  return relativePath;
}

export function isWatchableChange(event: VaultChangeEvent, room: MountedRoomState, configDir: string): string | null {
  return relativePathIfWatchable(event.path, room, configDir);
}

/** Routes Markdown create/modify events through CRDT; deletes stay on the CAS lane. */
export function isCrdtManagedLocalChange(room: { crdtEnabled: boolean }, eventType: "create" | "modify" | "delete", relativePath: string): boolean {
  return room.crdtEnabled && eventType !== "delete" && isCrdtEligiblePath(relativePath);
}

export type RenameClassification =
  | { kind: "rename"; oldRelativePath: string; relativePath: string }
  | { kind: "create"; relativePath: string }
  | { kind: "delete"; relativePath: string }
  | { kind: "ignore" };

/**
 * Classifies a vault rename/move event against one mounted room's mountPath, independently
 * checking the old and new absolute paths: both inside the room is a rename, old-in/new-out is
 * effectively a delete of the old path, old-out/new-in is effectively a create of the new path,
 * and both outside (or either side ineligible/a conflict copy) is ignored entirely.
 */
export function classifyRenameEvent(oldPath: string, newPath: string, room: MountedRoomState, configDir: string): RenameClassification {
  const oldRelativePath = relativePathIfWatchable(oldPath, room, configDir);
  const newRelativePath = relativePathIfWatchable(newPath, room, configDir);
  if (oldRelativePath && newRelativePath) {
    return { kind: "rename", oldRelativePath, relativePath: newRelativePath };
  }
  if (oldRelativePath) {
    return { kind: "delete", relativePath: oldRelativePath };
  }
  if (newRelativePath) {
    return { kind: "create", relativePath: newRelativePath };
  }
  return { kind: "ignore" };
}

/** Correlates the synthetic delete/create events emitted for one rename. */
export type RenameHint = { renamedToRelativePath: string } | { renamedFromRelativePath: string };

/** Returns an unsubscribe function - callers must invoke it when the room is unmounted, or the
 *  underlying vault listener (and everything it closes over) stays registered for the rest of
 *  the session even though it'll never match this room's mountPath again.
 *
 *  A rename/move is translated into a delete-of-old plus create-of-new (see classifyRenameEvent)
 *  so callers only ever need to handle the same "create" | "modify" | "delete" shape they already
 *  do for plain vault events - there is no separate "move" concept in the sync protocol. A rename
 *  fully inside the room additionally carries a RenameHint on each of the two calls (see its doc
 *  comment) for callers that want to recognize and specially handle that case. */
export function registerMountedRoomWatcher(
  vault: VaultAdapter,
  room: MountedRoomState,
  cb: (event: VaultChangeEvent, relativePath: string, renameHint?: RenameHint) => void,
  configDir: string
): () => void {
  return vault.onChange((event) => {
    if (event.type === "rename") {
      const classification = classifyRenameEvent(event.oldPath, event.path, room, configDir);
      if (classification.kind === "rename") {
        cb({ type: "delete", path: event.oldPath }, classification.oldRelativePath, { renamedToRelativePath: classification.relativePath });
        cb({ type: "create", path: event.path }, classification.relativePath, { renamedFromRelativePath: classification.oldRelativePath });
      } else if (classification.kind === "delete") {
        cb({ type: "delete", path: event.oldPath }, classification.relativePath);
      } else if (classification.kind === "create") {
        cb({ type: "create", path: event.path }, classification.relativePath);
      }
      return;
    }
    const relativePath = isWatchableChange(event, room, configDir);
    if (relativePath) {
      cb(event, relativePath);
    }
  });
}
