import type { MountedRoomState } from "./syncClient.js";

export type RelayServerConfig = {
  id: string;
  baseUrl: string;
  teamId: string;
  teamName: string;
  teamSlug: string;
  userId: string;
  userDisplayName: string;
  deviceId: string;
  deviceName: string;
  deviceToken: string;
  status: "active" | "revoked";
  role?: "owner" | "admin" | "member";
};

export type ServerBindMode = "local" | "lan";

export type EmbeddedServerSettings = {
  /** "local" binds 127.0.0.1 only (this device); "lan" binds 0.0.0.0 so LAN teammates can connect. */
  bindMode: ServerBindMode;
  /** Leave undefined to auto-pick a free port starting at 8787. */
  port?: number;
  allowRemoteBootstrap: boolean;
  maxFileBytes: number;
  /** Start the embedded relay server automatically when Obsidian loads this vault. */
  autoStart: boolean;
};

export type VaultRoomsSettings = {
  servers: RelayServerConfig[];
  activeServerId?: string;
  mountRoot: string;
  debounceMs: number;
  mountedRooms: Record<string, MountedRoomState>;
  roomMountPaths: Record<string, string>;
  server: EmbeddedServerSettings;
};

export const DEFAULT_SERVER_SETTINGS: EmbeddedServerSettings = {
  bindMode: "local",
  allowRemoteBootstrap: false,
  maxFileBytes: 5 * 1024 * 1024,
  autoStart: false
};

export const DEFAULT_SETTINGS: VaultRoomsSettings = {
  servers: [],
  mountRoot: "Vault Rooms",
  debounceMs: 750,
  mountedRooms: {},
  roomMountPaths: {},
  server: DEFAULT_SERVER_SETTINGS
};

export function activeServer(settings: VaultRoomsSettings): RelayServerConfig | undefined {
  return settings.servers.find((server) => server.id === settings.activeServerId) ?? settings.servers[0];
}
