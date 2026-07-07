import { Notice, PluginSettingTab, Setting } from "obsidian";
import type VaultRoomsPlugin from "./main.js";

export class VaultRoomsSettingTab extends PluginSettingTab {
  constructor(private readonly plugin: VaultRoomsPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderServerSettings(containerEl);
    this.renderSyncSettings(containerEl);
    this.renderServersSettings(containerEl);
  }

  private renderServerSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Relay server").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "This device hosts the relay server directly — no separate process or terminal needed. Set up or join from the Vault Rooms panel and it starts automatically if it isn't already running."
    });

    const status = this.plugin.getServerStatus();
    new Setting(containerEl)
      .setName("Status")
      .setDesc(
        status.running
          ? `Running — this device: ${status.localUrl}${
              status.lanUrl
                ? `, LAN: ${status.lanUrl}`
                : status.lanDetectionFailed
                  ? " — could NOT auto-detect a LAN IP; invite links will point at 127.0.0.1 and won't work for teammates until you set a Public URL override below, then restart the server."
                  : ""
            }`
          : status.error
            ? `Stopped — last error: ${status.error}`
            : "Stopped"
      )
      .addButton((button) =>
        button
          .setButtonText(status.running ? "Stop" : "Start")
          .setCta()
          .onClick(async () => {
            try {
              if (status.running) {
                await this.plugin.stopEmbeddedServer();
              } else {
                await this.plugin.startEmbeddedServer();
              }
            } catch (error) {
              new Notice(error instanceof Error ? error.message : "Vault Rooms server action failed");
            }
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Public URL override")
      .setDesc(
        "The server always listens on your local network so teammates can connect - no TLS in v0.1, so only run this on networks you trust. Set this only if LAN IP auto-detection picks the wrong network interface or fails outright (multiple network adapters, VPNs, some Wi-Fi drivers): this device's real LAN address, e.g. http://192.168.1.42:8787. Leave blank to auto-detect."
      )
      .addText((text) =>
        text
          .setPlaceholder("auto-detect")
          .setValue(this.plugin.settings.server.publicUrlOverride ?? "")
          .onChange(async (value) => {
            const trimmed = value.trim();
            this.plugin.settings.server.publicUrlOverride = trimmed || undefined;
            await this.plugin.saveSettings();
            if (this.plugin.getServerStatus().running) {
              new Notice("Restart the server for this change to take effect.");
            }
          })
      );

    new Setting(containerEl)
      .setName("Port")
      .setDesc("Leave blank to auto-pick a free port starting at 8787.")
      .addText((text) =>
        text
          .setPlaceholder("auto")
          .setValue(this.plugin.settings.server.port ? String(this.plugin.settings.server.port) : "")
          .onChange(async (value) => {
            const trimmed = value.trim();
            const parsed = trimmed ? Number.parseInt(trimmed, 10) : undefined;
            if (trimmed && (!Number.isInteger(parsed) || (parsed as number) <= 0 || (parsed as number) > 65535)) {
              return;
            }
            this.plugin.settings.server.port = parsed;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Allow remote bootstrap")
      .setDesc("Allow creating the first team from a non-localhost address. Leave off unless you know you need it.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.server.allowRemoteBootstrap).onChange(async (value) => {
          this.plugin.settings.server.allowRemoteBootstrap = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Max synced file size")
      .setDesc("Files larger than this (in bytes) are rejected. Default 5242880 (5 MB).")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.server.maxFileBytes)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            this.plugin.settings.server.maxFileBytes = parsed;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Start automatically")
      .setDesc("Start the relay server whenever this vault opens in Obsidian.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.server.autoStart).onChange(async (value) => {
          this.plugin.settings.server.autoStart = value;
          await this.plugin.saveSettings();
        })
      );
  }

  private renderSyncSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Sync").setHeading();

    new Setting(containerEl)
      .setName("Mount root")
      .setDesc("Default root for member-mounted rooms.")
      .addText((text) =>
        text.setValue(this.plugin.settings.mountRoot).onChange(async (value) => {
          this.plugin.settings.mountRoot = value.trim() || "Vault Rooms";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Debounce")
      .setDesc("Milliseconds to debounce local file changes.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.debounceMs)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            this.plugin.settings.debounceMs = parsed;
            await this.plugin.saveSettings();
          }
        })
      );
  }

  private renderServersSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Servers").setHeading();

    if (this.plugin.settings.servers.length === 0) {
      containerEl.createEl("p", { cls: "setting-item-description", text: "No servers connected yet." });
      return;
    }

    for (const server of this.plugin.settings.servers) {
      const active = server.id === this.plugin.getActiveServer()?.id;
      const isRevoked = server.status === "revoked";
      const setting = new Setting(containerEl)
        .setName(`${server.userDisplayName}${server.isServerOwner ? " (owner)" : ""}${active ? " - active" : ""}`)
        .setDesc(
          isRevoked
            ? `${server.baseUrl} (revoked) - this device's saved login no longer works on this server. Remove it below, then set up or join again.`
            : `${server.baseUrl} (${server.status})`
        );
      setting.addButton((button) =>
        button.setButtonText("Use").setDisabled(active).onClick(async () => {
          try {
            await this.plugin.activateServer(server.id);
            this.display();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Server switch failed");
          }
        })
      );
      setting.addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          try {
            await this.plugin.testConnection(server.baseUrl);
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Connection failed");
          }
        })
      );
      setting.addButton((button) =>
        button
          .setButtonText("Forget")
          .setWarning()
          .onClick(async () => {
            if (!window.confirm(`Remove "${server.baseUrl}" from this device? This only forgets it locally - it does not delete anything on the server.`)) {
              return;
            }
            await this.plugin.forgetServer(server.id);
            this.display();
          })
      );
    }
  }
}
