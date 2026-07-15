import { Modal, Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type { MigrationMode } from "@vault-rooms/protocol";
import type { SettingDefinitionItem } from "obsidian";
import type VaultRoomsPlugin from "./main.js";
import { pinnedInfoForServer } from "./controllers/ServerConnectionManager.js";
import { confirmModal } from "./modals/ConfirmModal.js";
import { refreshSettingTab, setDestructiveCompat } from "./obsidianCompat.js";
import { isRestrictedPort } from "./restrictedPorts.js";

export class VaultRoomsSettingTab extends PluginSettingTab {
  constructor(private readonly plugin: VaultRoomsPlugin) {
    super(plugin.app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Vault Rooms settings",
        searchable: false,
        render: (setting) => {
          this.renderSettings(setting.settingEl);
        }
      }
    ];
  }

  /** Fallback for Obsidian runtimes that don't call getSettingDefinitions() (pre-1.13, or any
   *  build where the app doesn't wire that dispatch up) - the app core calls this unconditionally
   *  when it doesn't know about the declarative API, and gets a TypeError if it's missing. Kept
   *  in sync with getSettingDefinitions()'s render callback above; only one of the two runs on any
   *  given Obsidian version, per Obsidian's own SettingTab#display() doc. */
  display(): void {
    this.renderSettings(this.containerEl);
  }

  private renderSettings(containerEl: HTMLElement): void {
    containerEl.empty();
    this.renderServerSettings(containerEl);
    this.renderSyncSettings(containerEl);
    this.renderServersSettings(containerEl);
  }

  private refresh(): void {
    refreshSettingTab(this, (containerEl) => this.renderSettings(containerEl));
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
                  ? " — invite links will point at 127.0.0.1 until you set a Public URL override below, then restart the server."
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
            this.refresh();
          })
      );

    if (status.running) {
      this.renderTransportSecurity(containerEl, status);
    }

    new Setting(containerEl)
      .setName("Public URL override")
      .setDesc(
        "The server listens on your local network, but the plugin does not read your network interfaces automatically. Set this to this device's LAN address before sharing invites, e.g. 192.168.1.100 - just the address, no http:// or port needed (both are filled in automatically, and any port you do include is ignored in favor of the server's real one). Leave this field blank entirely to use loopback for this device only."
      )
      .addText((text) =>
        text
          .setPlaceholder("192.168.1.100")
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
            if (parsed !== undefined && isRestrictedPort(parsed)) {
              new Notice(`Port ${parsed} is blocked by Obsidian's Electron runtime and can never be reached - choose a different port.`);
              return;
            }
            this.plugin.settings.server.port = parsed;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max synced file size (MB)")
      .setDesc("Files larger than this are rejected. Default 5 MB.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.server.maxFileBytes / (1024 * 1024))).onChange(async (value) => {
          const parsedMb = Number.parseFloat(value);
          if (Number.isFinite(parsedMb) && parsedMb > 0) {
            this.plugin.settings.server.maxFileBytes = Math.round(parsedMb * 1024 * 1024);
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
            this.refresh();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Server switch failed");
          }
        })
      );
      setting.addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          try {
            await this.plugin.testConnection(server.baseUrl, pinnedInfoForServer(server));
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Connection failed");
          }
        })
      );
      setting.addButton((button) =>
        setDestructiveCompat(button.setButtonText("Forget"))
          .onClick(async () => {
            if (!(await confirmModal(this.app, "Forget server", `Remove "${server.baseUrl}" from this device? This only forgets it locally - it does not delete anything on the server.`, "Forget"))) {
              return;
            }
            await this.plugin.forgetServer(server.id);
            this.refresh();
          })
      );
    }
  }

  private renderTransportSecurity(
    containerEl: HTMLElement,
    status: Extract<ReturnType<VaultRoomsPlugin["getServerStatus"]>, { running: true }>
  ): void {
    if (status.securityState === "plain_legacy") {
      new Setting(containerEl)
        .setName("Transport security")
        .setDesc(
          "This team is using legacy plaintext HTTP/WS. Tokens and content are not encrypted on the LAN. Enable TLS migration to protect future traffic."
        )
        .addButton((button) =>
          button.setButtonText("Enable TLS migration").onClick(async () => {
            const mode = await chooseMigrationMode(this.app);
            if (!mode) return;
            await this.plugin.enableTlsMigration(mode);
            this.refresh();
          })
        );
      return;
    }

    const identity = status.pinnedInfo;
    const detail = identity
      ? `${identity.tlsName} — fingerprint ${identity.pinnedIdentitySpkiSha256}${status.httpsUrl ? ` — ${status.httpsUrl}` : ""}`
      : "Pinned identity unavailable";
    if (status.securityState === "tls_migrating") {
      new Setting(containerEl)
        .setName("TLS migration")
        .setDesc(`${detail} — ${status.plainDeviceCount ?? 0} active device(s) still seen on legacy HTTP.`)
        .addButton((button) =>
          setDestructiveCompat(button.setButtonText("Enforce TLS"))
            .onClick(async () => {
              if (
                !(await confirmModal(
                  this.app,
                  "Enforce TLS",
                  "Disable the legacy HTTP/WS listener now? Devices that have not migrated will stop connecting.",
                  "Enforce TLS"
                ))
              ) {
                return;
              }
              await this.plugin.enforceTls();
              this.refresh();
            })
        );
      return;
    }

    new Setting(containerEl)
      .setName("Pinned TLS")
      .setDesc(detail)
      .addButton((button) =>
        setDestructiveCompat(button.setButtonText("Rotate server identity"))
          .onClick(async () => {
            if (
              !(await confirmModal(
                this.app,
                "Rotate server identity",
                "Rotate the pinned server identity and restart only the TLS listener? Connected TLS clients will verify the signed rotation before reconnecting.",
                "Rotate identity"
              ))
            ) {
              return;
            }
            await this.plugin.rotateIdentity();
            this.refresh();
          })
      );
  }
}

function chooseMigrationMode(app: App): Promise<MigrationMode | null> {
  return new Promise((resolve) => {
    class MigrationModeModal extends Modal {
      private selected: MigrationMode | null = null;

      onOpen(): void {
        this.setTitle("Enable TLS migration");
        this.contentEl.createEl("p", {
          text: "Normal migration trusts one authenticated plaintext response to learn the new pin, so an active attacker on the local network could replace that first pin. Use Strict migration for sensitive teams; it requires a fresh pinned invite link from the owner."
        });
        new Setting(this.contentEl)
          .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
          .addButton((button) =>
            button.setButtonText("Normal").setCta().onClick(() => {
              this.selected = "non_strict";
              this.close();
            })
          )
          .addButton((button) =>
            button.setButtonText("Strict").onClick(() => {
              this.selected = "strict";
              this.close();
            })
          );
      }

      onClose(): void {
        this.contentEl.empty();
        resolve(this.selected);
      }
    }
    new MigrationModeModal(app).open();
  });
}
