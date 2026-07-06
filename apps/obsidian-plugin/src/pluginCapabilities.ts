import type { App } from "obsidian";
import type { RoomSummary } from "./apiClient.js";

export function withInstalledCapabilities(app: App, room: RoomSummary): RoomSummary {
  const plugins = (app as App & { plugins?: { enabledPlugins?: Set<string> } }).plugins;
  return {
    ...room,
    capabilities: room.capabilities.map((capability) => ({
      ...capability,
      installed: plugins?.enabledPlugins?.has(capability.pluginId) ?? false
    }))
  };
}
