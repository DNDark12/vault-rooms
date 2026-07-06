import { Notice, PluginSettingTab, Setting } from "obsidian";
import type VaultRoomsPlugin from "./main.js";
import type { ServerBindMode } from "./settings.js";

export class VaultRoomsSettingTab extends PluginSettingTab {
  constructor(private readonly plugin: VaultRoomsPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Vault Rooms" });

    this.renderServerSettings(containerEl);
    this.renderSyncSettings(containerEl);
    this.renderTeamsSettings(containerEl);
  }

  private renderServerSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Relay server" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "This device hosts the relay server directly — no separate process or terminal needed. Start it, then set up or join a team from the Vault Rooms panel."
    });

    const status = this.plugin.getServerStatus();
    new Setting(containerEl)
      .setName("Status")
      .setDesc(
        status.running
          ? `Running — this device: ${status.localUrl}${status.lanUrl ? `, LAN: ${status.lanUrl}` : ""}`
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
      .setName("Network access")
      .setDesc("\"This device only\" is safest. Choose \"Local network\" so teammates on the same LAN can connect via an invite link. There is no TLS in v0.1 — only use LAN mode on networks you trust.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("local", "This device only (127.0.0.1)")
          .addOption("lan", "Local network (LAN)")
          .setValue(this.plugin.settings.server.bindMode)
          .onChange(async (value) => {
            this.plugin.settings.server.bindMode = value as ServerBindMode;
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
    containerEl.createEl("h3", { text: "Sync" });

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

  private renderTeamsSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Teams" });

    if (this.plugin.settings.servers.length === 0) {
      containerEl.createEl("p", { cls: "setting-item-description", text: "No teams connected yet." });
      return;
    }

    for (const server of this.plugin.settings.servers) {
      const active = server.id === this.plugin.getActiveServer()?.id;
      const isRevoked = server.status === "revoked";
      const setting = new Setting(containerEl)
        .setName(`${server.teamName} - ${server.userDisplayName}${active ? " - active" : ""}`)
        .setDesc(
          isRevoked
            ? `${server.baseUrl} (revoked) - this device's saved login no longer works on this server. Remove it below, then set up or join the team again.`
            : `${server.baseUrl} (${server.status})`
        );
      setting.addButton((button) =>
        button.setButtonText("Use").setDisabled(active).onClick(async () => {
          try {
            await this.plugin.activateServer(server.id);
            this.display();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Team switch failed");
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
      if (server.role === "owner") {
        setting.addButton((button) =>
          button
            .setButtonText("Delete team")
            .setWarning()
            .onClick(async () => {
              if (
                !window.confirm(
                  `Delete team "${server.teamName}"? This permanently deletes every room, file, and member in the team for everyone. This cannot be undone.`
                )
              ) {
                return;
              }
              try {
                await this.plugin.deleteTeam(server.id);
                this.display();
              } catch (error) {
                new Notice(error instanceof Error ? error.message : "Failed to delete team");
              }
            })
        );
      }
      setting.addButton((button) =>
        button
          .setButtonText("Forget")
          .setWarning()
          .onClick(async () => {
            if (!window.confirm(`Remove "${server.teamName}" from this device? This only forgets it locally - it does not delete anything on the server.`)) {
              return;
            }
            await this.plugin.forgetServer(server.id);
            this.display();
          })
      );
    }
  }
}
