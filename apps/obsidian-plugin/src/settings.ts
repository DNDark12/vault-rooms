import type { SecurityMode } from "@vault-rooms/protocol";
import type { MountedRoomState } from "./syncClient.js";

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
      : migrateServerConnectionSettings(server as ServerConnection)
  );
  const activeServerId = loaded?.activeServerId;
  // v0.1 mounted-room records did not store their server. With exactly one saved server the
  // association is certain; with multiple entries, using merely the active one could route a
  // room to the wrong relay and push local changes into an unrelated room ID. Preserve ambiguous
  // tracking without serverId so current sync code pauses it until the user re-mounts deliberately.
  const inferredMountServerId = servers.length === 1 ? servers[0]?.id : undefined;
  const mountedRooms = Object.fromEntries(
    Object.entries(loaded?.mountedRooms ?? {}).map(([roomId, room]) => [
      roomId,
      room.serverId || !inferredMountServerId ? room : { ...room, serverId: inferredMountServerId }
    ])
  );

  return {
    migratedLegacy,
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
