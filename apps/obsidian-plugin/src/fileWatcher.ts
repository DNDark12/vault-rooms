import { isEligiblePath } from "@vault-rooms/protocol";
import { isConflictCopyPath, type MountedRoomState, type VaultAdapter, type VaultChangeEvent } from "./syncClient.js";

/** Shared by isWatchableChange (single-path events) and classifyRenameEvent (each side of a
 *  rename/move) - one place that decides "is this vault-relative path something we sync at all". */
function relativePathIfWatchable(path: string, room: MountedRoomState): string | null {
  const prefix = `${room.mountPath.replace(/\/+$/g, "")}/`;
  if (!path.startsWith(prefix)) {
    return null;
  }
  const relativePath = path.slice(prefix.length);
  if (
    !relativePath ||
    relativePath.startsWith(".obsidian/") ||
    relativePath.startsWith(".git/") ||
    relativePath.startsWith("node_modules/") ||
    relativePath.endsWith(".tmp") ||
    relativePath.endsWith(".DS_Store") ||
    isConflictCopyPath(relativePath) ||
    // Skip file types we don't sync at all (v0.1: text/markdown/canvas/json/csv plus common
    // image formats and PDF) - avoids a doomed round trip to the server on every keystroke/save
    // for files that were never eligible in the first place.
    !isEligiblePath(relativePath)
  ) {
    return null;
  }
  return relativePath;
}

export function isWatchableChange(event: VaultChangeEvent, room: MountedRoomState): string | null {
  return relativePathIfWatchable(event.path, room);
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
export function classifyRenameEvent(oldPath: string, newPath: string, room: MountedRoomState): RenameClassification {
  const oldRelativePath = relativePathIfWatchable(oldPath, room);
  const newRelativePath = relativePathIfWatchable(newPath, room);
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

/** Returns an unsubscribe function - callers must invoke it when the room is unmounted, or the
 *  underlying vault listener (and everything it closes over) stays registered for the rest of
 *  the session even though it'll never match this room's mountPath again.
 *
 *  A rename/move is translated into a delete-of-old plus create-of-new (see classifyRenameEvent)
 *  so callers only ever need to handle the same "create" | "modify" | "delete" shape they already
 *  do for plain vault events - there is no separate "move" concept in the sync protocol. */
export function registerMountedRoomWatcher(vault: VaultAdapter, room: MountedRoomState, cb: (event: VaultChangeEvent, relativePath: string) => void): () => void {
  return vault.onChange((event) => {
    if (event.type === "rename") {
      const classification = classifyRenameEvent(event.oldPath, event.path, room);
      if (classification.kind === "rename") {
        cb({ type: "delete", path: event.oldPath }, classification.oldRelativePath);
        cb({ type: "create", path: event.path }, classification.relativePath);
      } else if (classification.kind === "delete") {
        cb({ type: "delete", path: event.oldPath }, classification.relativePath);
      } else if (classification.kind === "create") {
        cb({ type: "create", path: event.path }, classification.relativePath);
      }
      return;
    }
    const relativePath = isWatchableChange(event, room);
    if (relativePath) {
      cb(event, relativePath);
    }
  });
}
