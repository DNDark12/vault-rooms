import { isConflictCopyPath, type MountedRoomState, type VaultAdapter, type VaultChangeEvent } from "./syncClient.js";

export function isWatchableChange(event: VaultChangeEvent, room: MountedRoomState): string | null {
  const prefix = `${room.mountPath.replace(/\/+$/g, "")}/`;
  if (!event.path.startsWith(prefix)) {
    return null;
  }
  const relativePath = event.path.slice(prefix.length);
  if (
    !relativePath ||
    relativePath.startsWith(".obsidian/") ||
    relativePath.startsWith(".git/") ||
    relativePath.startsWith("node_modules/") ||
    relativePath.endsWith(".tmp") ||
    relativePath.endsWith(".DS_Store") ||
    isConflictCopyPath(relativePath)
  ) {
    return null;
  }
  return relativePath;
}

export function registerMountedRoomWatcher(vault: VaultAdapter, room: MountedRoomState, cb: (event: VaultChangeEvent, relativePath: string) => void): void {
  vault.onChange((event) => {
    const relativePath = isWatchableChange(event, room);
    if (relativePath) {
      cb(event, relativePath);
    }
  });
}
