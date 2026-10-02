import { portablePathKey } from "@vault-rooms/protocol";
import type { MountedRoomState } from "../syncClient.js";

export type PausedPathGroup = {
  key: string;
  paths: string[];
  reason: "server-collision" | "local-collision" | "recovery-pending";
  error?: string;
  pendingIntentCount: number;
};

/** Only persisted room state is read here; disk discovery is scoped to its mounted folder. */
export function pausedPathModel(room: MountedRoomState): PausedPathGroup[] {
  const livePaths = Object.entries(room.files)
    .filter(([, file]) => file.serverSha256 !== null || file.dirty)
    .map(([path]) => path);
  const liveByKey = new Map<string, string[]>();
  for (const path of livePaths) {
    const key = portablePathKey(path);
    liveByKey.set(key, [...(liveByKey.get(key) ?? []), path]);
  }
  const serverKeys = new Set((room.pathCollisionKeys ?? []).map(portablePathKey));
  const localKeys = new Set((room.pathLocalCollisionKeys ?? []).map(portablePathKey));
  for (const [key, paths] of liveByKey) if (paths.length > 1) localKeys.add(key);
  const recoveryKeys = new Set((room.pathRecoveryKeys ?? []).map(portablePathKey));
  return [...new Set([...serverKeys, ...localKeys, ...recoveryKeys])].sort().map((key) => {
    const paths = [...new Set([
      ...(room.pathCollisionPaths ?? []),
      ...Object.keys(room.files),
      ...(room.pendingCrdtTextPaths ?? []),
      ...(room.pendingCrdtOperations ?? []).flatMap((operation) => operation.kind === "rename"
        ? [operation.oldRelativePath, operation.relativePath] : [operation.relativePath])
    ].filter((path) => portablePathKey(path) === key))];
    return {
      key,
      paths: paths.length > 0 ? paths : [key],
      reason: serverKeys.has(key) ? "server-collision" : localKeys.has(key) ? "local-collision" : "recovery-pending",
      error: room.pathRecoveryErrors?.[key],
      pendingIntentCount: (room.pendingCrdtOperations ?? []).filter((operation) =>
        portablePathKey(operation.relativePath) === key || portablePathKey(operation.relativePath).startsWith(`${key}/`) ||
        (operation.kind === "rename" && (portablePathKey(operation.oldRelativePath) === key || portablePathKey(operation.oldRelativePath).startsWith(`${key}/`)))).length
    };
  });
}
