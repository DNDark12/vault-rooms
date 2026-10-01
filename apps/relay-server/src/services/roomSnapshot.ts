import { AppError, isCrdtEligiblePath, isLegacyEligiblePath, type SyncServerMessage } from "@vault-rooms/protocol";
import type { DevicePrincipal, RelayRepository } from "../db/repositories/relayRepository.js";
import type { RoomRow } from "../db/schema.js";
import { hasRoomPermission } from "./policyService.js";
export function visibleRoomFiles(repo: RelayRepository, principal: DevicePrincipal, room: RoomRow, capabilities: {
  extendedBinarySync?: boolean;
  portablePaths?: boolean;
}) {
  const aclRules = repo.listAclRulesForRoom(room.id);
  const files = repo.listFiles(room.id).filter(file => hasRoomPermission({ repo, principal, room, permission: "file:read", relativePath: file.relative_path, aclRules }) &&
    (capabilities.extendedBinarySync || isLegacyEligiblePath(file.relative_path)));
  if (!capabilities.portablePaths && files.some(file => file.path_collision && !file.deleted_at)) {
    throw new AppError("PATH_COLLISION", "Update the plugin and ask the room owner to rename the overlapping files before syncing.", 409);
  }
  // A tombstone must never cause a client to delete a live alias at the same portable key.
  const liveKeys = new Set(files.filter(file => !file.deleted_at).map(file => file.path_key));
  const newestDeleted = new Map<string, number>();
  for (const file of files)
    if (file.deleted_at)
      newestDeleted.set(file.path_key, Math.max(newestDeleted.get(file.path_key) ?? 0, file.version));
  const seenDeleted = new Set<string>();
  return files.filter(file => {
    if (!file.deleted_at)
      return true;
    if (liveKeys.has(file.path_key) || file.version !== newestDeleted.get(file.path_key) || seenDeleted.has(file.path_key))
      return false;
    seenDeleted.add(file.path_key);
    return true;
  });
}
export function roomSnapshot(repo: RelayRepository, principal: DevicePrincipal, room: RoomRow, capabilities: {
  extendedBinarySync?: boolean;
  portablePaths?: boolean;
}, requestId: string): Extract<SyncServerMessage, {
  type: "room_snapshot";
}> {
  return {
    type: "room_snapshot", requestId, roomId: room.id, files: visibleRoomFiles(repo, principal, room, capabilities).map(file => ({
      relativePath: file.relative_path, version: file.version, sha256: file.sha256, deleted: Boolean(file.deleted_at),
      ...(file.path_collision ? { pathCollision: true, fileId: file.id } : {}),
      ...(room.crdt_enabled && isCrdtEligiblePath(file.relative_path) ? { crdtEpoch: file.crdt_epoch } : {})
    }))
  };
}
