import { isCrdtEligiblePath, normalizeRelativePath, type SecurityMode } from "@vault-rooms/protocol";
import type { MountedRoomState, PendingCrdtOperation } from "./syncClient.js";

/** One entry per SERVER (a device identity on that relay), not per team - a user can belong to many teams on the same server. */
export type ServerConnection = {
  id: string;
  baseUrl: string;
  userId: string;
  userDisplayName: string;
  deviceId: string;
  deviceName: string;
  deviceToken: string;
  isServerOwner: boolean;
  status: "active" | "revoked";
  securityMode: SecurityMode;
  pinnedIdentitySpkiSha256?: string;
  identityCertificateDer?: string;
  tlsName?: string;
  serverId?: string;
  lastSuccessfulConnectionAt?: string;
  /**
   * The server owner's display name, cached from /api/me so a saved-but-inactive connection can still be
   * named after a person. Optional and additive: entries saved before this field existed simply fall back
   * to the port until their next successful refresh.
   */
  serverOwnerDisplayName?: string;
  securityState?: "ok" | "pin_mismatch" | "migrating";
  appliedRotationIds?: string[];
};

export type EmbeddedServerSettings = {
  /** Leave undefined to auto-pick a free port starting at 8787. */
  port?: number;
  /** Runtime-managed remembered auto port. Leave undefined for first auto-pick. */
  pinnedPort?: number;
  /** Runtime-managed remembered TLS port. Leave undefined to start at the HTTP port plus one. */
  tlsPort?: number;
  maxFileBytes: number;
  /** Start the embedded relay server automatically when Obsidian loads this vault. */
  autoStart: boolean;
  /**
   * Manual override for the URL embedded in invite links (e.g. "http://192.168.1.100:8787").
   * Leave blank to keep invites on loopback for this device only.
   */
  publicUrlOverride?: string;
};

export type VaultRoomsSettings = {
  servers: ServerConnection[];
  /** Raw persisted entries that could not be safely interpreted; retained so a later version can recover them. */
  unrecognizedServers?: unknown[];
  activeServerId?: string;
  mountRoot: string;
  debounceMs: number;
  mountedRooms: Record<string, MountedRoomState>;
  roomMountPaths: Record<string, string>;
  server: EmbeddedServerSettings;
};

export const DEFAULT_SERVER_SETTINGS: EmbeddedServerSettings = {
  maxFileBytes: 5 * 1024 * 1024,
  autoStart: false
};

export const DEFAULT_SETTINGS: VaultRoomsSettings = {
  servers: [],
  unrecognizedServers: [],
  mountRoot: "Vault Rooms",
  debounceMs: 300,
  mountedRooms: {},
  roomMountPaths: {},
  server: DEFAULT_SERVER_SETTINGS
};

export function activeServer(settings: VaultRoomsSettings): ServerConnection | undefined {
  return settings.servers.find((server) => server.id === settings.activeServerId) ?? settings.servers[0];
}

export function isOwnEmbeddedServerConnection(server: ServerConnection): boolean {
  if (!server.isServerOwner) return false;
  try {
    const hostname = new URL(server.baseUrl).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

export function migrateServerConnectionSettings<
  T extends { baseUrl: string; securityMode?: SecurityMode; appliedRotationIds?: string[] }
>(server: T): T & { securityMode: SecurityMode; appliedRotationIds: string[] } {
  return {
    ...server,
    securityMode: server.securityMode ?? (server.baseUrl.startsWith("https://") ? "os-trusted-tls" : "plain"),
    appliedRotationIds: server.appliedRotationIds ?? []
  };
}

export type PersistedVaultRoomsSettings = Partial<Omit<VaultRoomsSettings, "servers">> & {
  servers?: unknown[];
};

export function migrateVaultRoomsSettings(
  loaded: PersistedVaultRoomsSettings | null
): { settings: VaultRoomsSettings; migratedLegacy: boolean } {
  const persistedServers = Array.isArray(loaded?.servers) ? loaded.servers : [];
  const recognizedServers = persistedServers.filter(isRecognizedServerConnection);
  const unrecognizedServers = [
    ...(Array.isArray(loaded?.unrecognizedServers) ? loaded.unrecognizedServers : []),
    ...persistedServers.filter((server) => !isRecognizedServerConnection(server))
  ];
  // Released v0.1 entries already used the current server shape, but predate both transport
  // security fields. Treat adding either default as a real migration so loadSettings persists it
  // immediately instead of recreating an empty appliedRotationIds list on every startup.
  const migratedLegacy = unrecognizedServers.length > (loaded?.unrecognizedServers?.length ?? 0) || recognizedServers.some(
    (server) => isLegacyServerConnection(server) || !("securityMode" in server) || !("appliedRotationIds" in server)
  );
  const servers = recognizedServers.map((server) =>
    isLegacyServerConnection(server)
      ? migrateLegacyServerConnection(server)
      : migrateServerConnectionSettings(server)
  );
  const activeServerId = loaded?.activeServerId;
  // v0.1 mounted-room records did not store their server. With exactly one saved server the
  // association is certain; with multiple entries, using merely the active one could route a
  // room to the wrong relay and push local changes into an unrelated room ID. Preserve ambiguous
  // tracking without serverId so current sync code pauses it until the user re-mounts deliberately.
  const inferredMountServerId = servers.length === 1 ? servers[0]?.id : undefined;
  let journalMigrated = false;
  const mountedRooms = Object.fromEntries(
    Object.entries(loaded?.mountedRooms ?? {}).map(([roomId, room]) => {
      const rawOperations = (room as MountedRoomState & { pendingCrdtOperations?: unknown }).pendingCrdtOperations;
      const sanitizedOperations = Array.isArray(rawOperations)
        ? rawOperations.flatMap((operation) => {
            const sanitized = sanitizePendingCrdtOperation(operation);
            if (!sanitized) journalMigrated = true;
            return sanitized ? [sanitized] : [];
          })
        : rawOperations === undefined
          ? undefined
          : [];
      if (rawOperations !== undefined && !Array.isArray(rawOperations)) {
        journalMigrated = true;
      }
      const rawTextPaths = (room as MountedRoomState & { pendingCrdtTextPaths?: unknown }).pendingCrdtTextPaths;
      const sanitizedTextPaths = Array.isArray(rawTextPaths)
        ? Array.from(new Set(rawTextPaths.flatMap((path) => {
            if (typeof path !== "string") return [];
            const normalized = sanitizedJournalPath(path);
            return normalized && isCrdtEligiblePath(normalized) ? [normalized] : [];
          })))
        : rawTextPaths === undefined
          ? undefined
          : [];
      if (
        rawTextPaths !== undefined &&
        (!Array.isArray(rawTextPaths) || sanitizedTextPaths?.length !== rawTextPaths.length)
      ) {
        journalMigrated = true;
      }
      const withServer = room.serverId || !inferredMountServerId ? room : { ...room, serverId: inferredMountServerId };
      const withJournal = sanitizedOperations === undefined
        ? withServer
        : { ...withServer, pendingCrdtOperations: sanitizedOperations };
      return [
        roomId,
        sanitizedTextPaths === undefined
          ? withJournal
          : { ...withJournal, pendingCrdtTextPaths: sanitizedTextPaths }
      ];
    })
  );

  return {
    migratedLegacy: migratedLegacy || journalMigrated,
    settings: {
      ...DEFAULT_SETTINGS,
      ...loaded,
      servers,
      unrecognizedServers,
      activeServerId,
      mountedRooms,
      roomMountPaths: loaded?.roomMountPaths ?? DEFAULT_SETTINGS.roomMountPaths,
      server: { ...DEFAULT_SERVER_SETTINGS, ...(loaded?.server ?? {}) }
    }
  };
}

function sanitizePendingCrdtOperation(value: unknown): PendingCrdtOperation | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.operationId !== "string" ||
    value.operationId.length === 0 ||
    value.operationId.length > 200 ||
    typeof value.queuedAt !== "string" ||
    value.queuedAt.length === 0 ||
    (value.attemptedAt !== undefined && typeof value.attemptedAt !== "string") ||
    (value.deleteAfterAck !== undefined && value.deleteAfterAck !== true)
  ) {
    return null;
  }
  const relativePath = sanitizedJournalPath(value.relativePath);
  if (!relativePath) return null;
  const common = {
    operationId: value.operationId,
    relativePath,
    queuedAt: value.queuedAt,
    ...(typeof value.attemptedAt === "string" ? { attemptedAt: value.attemptedAt } : {}),
    ...(value.deleteAfterAck === true ? { deleteAfterAck: true as const } : {})
  };
  if (value.kind === "create") {
    return { ...common, kind: "create" };
  }
  if (value.kind === "rename") {
    const oldRelativePath = sanitizedJournalPath(value.oldRelativePath);
    return oldRelativePath ? { ...common, kind: "rename", oldRelativePath } : null;
  }
  return null;
}

function sanitizedJournalPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const normalized = normalizeRelativePath(value);
    return normalized === value ? normalized : null;
  } catch {
    return null;
  }
}

type LegacyServerConnection = Record<string, unknown> & {
  id: string;
  baseUrl: string;
  userId: string;
  userDisplayName: string;
  deviceId: string;
  deviceName: string;
  deviceToken: string;
  status: "active" | "revoked";
  isServerOwner?: boolean;
  securityMode?: SecurityMode;
  appliedRotationIds?: string[];
  role?: "owner" | "admin" | "member";
  teamId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLegacyServerConnection(server: Record<string, unknown>): server is LegacyServerConnection {
  return typeof server.teamId === "string";
}

function isRecognizedServerConnection(server: unknown): server is ServerConnection | LegacyServerConnection {
  if (!isRecord(server)) return false;
  const hasCommonFields =
    typeof server.id === "string" &&
    typeof server.baseUrl === "string" &&
    typeof server.userId === "string" &&
    typeof server.userDisplayName === "string" &&
    typeof server.deviceId === "string" &&
    typeof server.deviceName === "string" &&
    typeof server.deviceToken === "string" &&
    (server.status === "active" || server.status === "revoked");
  if (!hasCommonFields) return false;
  return isLegacyServerConnection(server) || typeof server.isServerOwner === "boolean";
}

function migrateLegacyServerConnection(server: LegacyServerConnection): ServerConnection {
  const migrated: Record<string, unknown> = { ...server };
  delete migrated.teamId;
  delete migrated.role;
  return migrateServerConnectionSettings({
    ...(migrated as unknown as ServerConnection),
    isServerOwner: server.isServerOwner ?? server.role === "owner"
  });
}
