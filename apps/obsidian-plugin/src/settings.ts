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
  servers?: object[];
};

export function migrateVaultRoomsSettings(
  loaded: PersistedVaultRoomsSettings | null
): { settings: VaultRoomsSettings; migratedLegacy: boolean } {
  const persistedServers = loaded?.servers ?? [];
  // Released v0.1 entries already used the current server shape, but predate both transport
  // security fields. Treat adding either default as a real migration so loadSettings persists it
  // immediately instead of recreating an empty appliedRotationIds list on every startup.
  const migratedLegacy = persistedServers.some(
    (server) => isLegacyServerConnection(server) || !("securityMode" in server) || !("appliedRotationIds" in server)
  );
  const servers = persistedServers.map((server) =>
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
      activeServerId,
      mountedRooms,
      roomMountPaths: loaded?.roomMountPaths ?? DEFAULT_SETTINGS.roomMountPaths,
      server: { ...DEFAULT_SERVER_SETTINGS, ...(loaded?.server ?? {}) }
    }
  };
}

type LegacyServerConnection = {
  id: string;
  baseUrl: string;
  userId: string;
  userDisplayName: string;
  deviceId: string;
  deviceName: string;
  deviceToken: string;
  status: "active" | "revoked";
  role?: "owner" | "admin" | "member";
  teamId: string;
};

function isLegacyServerConnection(server: object): server is LegacyServerConnection {
  return "teamId" in server;
}

function migrateLegacyServerConnection(server: LegacyServerConnection): ServerConnection {
  return migrateServerConnectionSettings({
    id: server.id,
    baseUrl: server.baseUrl,
    userId: server.userId,
    userDisplayName: server.userDisplayName,
    deviceId: server.deviceId,
    deviceName: server.deviceName,
    deviceToken: server.deviceToken,
    isServerOwner: server.role === "owner",
    status: server.status
  });
}
