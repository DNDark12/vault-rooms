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
};

export type EmbeddedServerSettings = {
  /** Leave undefined to auto-pick a free port starting at 8787. */
  port?: number;
  /** Runtime-managed remembered auto port. Leave undefined for first auto-pick. */
  pinnedPort?: number;
  allowRemoteBootstrap: boolean;
  maxFileBytes: number;
  /** Start the embedded relay server automatically when Obsidian loads this vault. */
  autoStart: boolean;
  /**
   * Manual override for the URL embedded in invite links (e.g. "http://192.168.1.42:8787").
   * Only needed if LAN IP auto-detection picks the wrong network interface or fails outright
   * (multiple NICs, VPNs, some Wi-Fi adapters, etc.) - leave blank to use the auto-detected LAN IP.
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

export function activeServer(settings: VaultRoomsSettings): ServerConnection | undefined {
  return settings.servers.find((server) => server.id === settings.activeServerId) ?? settings.servers[0];
}
