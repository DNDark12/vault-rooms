import { FileSystemAdapter, Notice } from "obsidian";
import { join } from "node:path";
import { RelayApiClient } from "../apiClient.js";
import { activeServer, type ServerConnection } from "../settings.js";
import { EmbeddedRelayServer, type EmbeddedServerStatus } from "../serverManager.js";
import type { PluginContext } from "./PluginContext.js";

type ServerConnectionManagerContext = Pick<PluginContext, "app" | "manifest" | "settings" | "saveSettings" | "renderOpenRoomsViews">;

/** Owns the embedded relay server lifecycle and per-server RelayApiClient construction/revocation. */
export class ServerConnectionManager {
  private embeddedServer: EmbeddedRelayServer | null = null;

  constructor(private readonly ctx: ServerConnectionManagerContext) {}

  getServerStatus(): EmbeddedServerStatus {
    return this.embeddedServer?.getStatus() ?? { running: false };
  }

  async startEmbeddedServer(): Promise<EmbeddedServerStatus> {
    const server = this.getOrCreateEmbeddedServer();
    const previousPinnedPort = this.ctx.settings.server.pinnedPort;
    const status = await server.start(this.ctx.settings.server);
    this.ctx.renderOpenRoomsViews();
    if (status.running) {
      if (!this.ctx.settings.server.port && status.port !== this.ctx.settings.server.pinnedPort) {
        this.ctx.settings.server.pinnedPort = status.port;
        await this.ctx.saveSettings();
      }
      if (status.portPinChanged) {
        const reason =
          status.portPinFallbackReason === "zombie"
            ? "The old port still looks like a previous Vault Rooms server instance."
            : status.portPinFallbackReason === "occupied"
              ? "The old port is occupied by another app."
              : "The old port is occupied.";
        new Notice(
          `Vault Rooms server moved from port ${previousPinnedPort} to ${status.port}. ${reason} Invite links and saved logins that reference the old port may need regenerating.`,
          0
        );
      }
      new Notice(`Vault Rooms server running at ${status.localUrl}`);
    }
    return status;
  }

  async stopEmbeddedServer(): Promise<void> {
    await this.embeddedServer?.stop();
    this.ctx.renderOpenRoomsViews();
    new Notice("Vault Rooms server stopped.");
  }

  /** Best-effort teardown for plugin unload - unlike stopEmbeddedServer(), does not render views or show a Notice (see VaultRoomsPlugin.onunload's doc comment). */
  async stopSilently(): Promise<void> {
    await this.embeddedServer?.stop();
  }

  private getOrCreateEmbeddedServer(): EmbeddedRelayServer {
    if (!this.embeddedServer) {
      const adapter = this.ctx.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) {
        throw new Error("Vault Rooms requires the desktop app (filesystem access).");
      }
      const pluginDir = join(adapter.getBasePath(), this.ctx.manifest.dir ?? `.obsidian/plugins/${this.ctx.manifest.id}`);
      const dataDir = join(pluginDir, "server-data");
      this.embeddedServer = new EmbeddedRelayServer(dataDir);
    }
    return this.embeddedServer;
  }

  getActiveServer(): ServerConnection | undefined {
    return activeServer(this.ctx.settings);
  }

  /** Same-process read, no network round-trip - see EmbeddedRelayServer.getBootstrapPin(). */
  getBootstrapPin(): string | null {
    return this.getOrCreateEmbeddedServer().getBootstrapPin();
  }

  /**
   * Whether this device has already bootstrapped its own hosted server. Bootstrap is a one-time
   * action per device install (the embedded server is a singleton - one process, one database, one
   * owner identity - so there is no such thing as "another" server to set up on top of it), and the
   * created owner identity is permanent: the underlying database keeps its owner forever, even
   * across Stop/Start, so re-running setup against it always fails ("Bootstrap has already been
   * completed"). The panel uses this to stop offering "Set up server" once it would only ever fail.
   */
  hasOwnServer(): boolean {
    return this.ctx.settings.servers.some((server) => server.isServerOwner);
  }

  async testConnection(baseUrl: string): Promise<void> {
    await new RelayApiClient(baseUrl).testConnection();
    new Notice(`Connected to Vault Rooms`);
  }

  apiFor(server: ServerConnection): RelayApiClient {
    return new RelayApiClient(server.baseUrl, server.deviceToken, () => this.markServerRevoked(server));
  }

  /**
   * A 401 from a server means the saved device token no longer resolves to anything there - most
   * commonly because that server's data was reset/recreated since the token was issued (fresh
   * install, wiped data dir, or switching between embedded/standalone with different data files).
   * Reflect that in the UI (Settings → Vault Rooms → Servers already shows `status`) instead of
   * leaving it as a one-off error toast with no lasting trace, so it's clear this server needs to
   * be removed and set up/joined again rather than retried.
   */
  private markServerRevoked(server: ServerConnection): void {
    if (server.status === "revoked") {
      return;
    }
    server.status = "revoked";
    void this.ctx.saveSettings();
    this.ctx.renderOpenRoomsViews();
    new Notice(`"${server.baseUrl}" - saved login is no longer valid on this server. Remove it and set up/join again from Settings → Vault Rooms → Servers.`);
  }

  requireActiveServer(): ServerConnection {
    const server = this.getActiveServer();
    if (!server) {
      throw new Error("No active Vault Rooms server.");
    }
    return server;
  }

  upsertServer(
    baseUrl: string,
    response: {
      user: { id: string; displayName: string };
      device: { id: string; displayName: string };
      deviceToken: string;
      isServerOwner: boolean;
    }
  ): void {
    const config: ServerConnection = {
      id: response.device.id,
      baseUrl,
      userId: response.user.id,
      userDisplayName: response.user.displayName,
      deviceId: response.device.id,
      deviceName: response.device.displayName,
      deviceToken: response.deviceToken,
      isServerOwner: response.isServerOwner,
      status: "active"
    };
    this.ctx.settings.servers = [...this.ctx.settings.servers.filter((server) => server.id !== config.id), config];
    this.ctx.settings.activeServerId = config.id;
  }
}
