import type { App, PluginManifest } from "obsidian";
import type { RelayApiClient, RoomSummary } from "../apiClient.js";
import type { ServerConnection, VaultRoomsSettings } from "../settings.js";

/**
 * Narrow, structurally-typed facade over VaultRoomsPlugin that controllers depend on instead of
 * the plugin itself. Getter-backed state stays live, so controllers can read current settings and
 * visible rooms without holding the plugin's full mutable surface.
 */
export interface PluginContext {
  readonly app: App;
  readonly manifest: PluginManifest;
  readonly settings: VaultRoomsSettings; // live reference, never a snapshot
  readonly visibleRooms: RoomSummary[]; // live reference, never a snapshot
  apiFor(server: ServerConnection): RelayApiClient;
  requireActiveServer(): ServerConnection;
  saveSettings(): Promise<void>;
  renderOpenRoomsViews(): void;
  openJoinServer?(): void;
  removeSavedConnection?(server: ServerConnection): Promise<void>;
}
