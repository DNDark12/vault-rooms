import { Modal, Notice, Setting } from "obsidian";
import type VaultRoomsPlugin from "../main.js";

export class SetupTeamModal extends Modal {
  private serverUrl: string;
  private teamName = "";
  private displayName = "A";
  private deviceName = "A laptop";

  constructor(
    private readonly plugin: VaultRoomsPlugin,
    defaultServerUrl = "http://127.0.0.1:8787"
  ) {
    super(plugin.app);
    this.serverUrl = defaultServerUrl;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Set Up Vault Rooms" });
    new Setting(contentEl).setName("Server URL").addText((text) => text.setValue(this.serverUrl).onChange((value) => (this.serverUrl = value.trim())));
    new Setting(contentEl).setName("Display name").addText((text) => text.setValue(this.displayName).onChange((value) => (this.displayName = value.trim())));
    new Setting(contentEl).setName("Device name").addText((text) => text.setValue(this.deviceName).onChange((value) => (this.deviceName = value.trim())));
    new Setting(contentEl)
      .setName("First team name")
      .setDesc("Optional - creates a team you own right away. You can create more teams later.")
      .addText((text) => text.setValue(this.teamName).onChange((value) => (this.teamName = value.trim())));
    new Setting(contentEl).addButton((button) =>
      button.setButtonText("Test connection").onClick(async () => {
        await this.plugin.testConnection(this.serverUrl);
      })
    );
    new Setting(contentEl).addButton((button) =>
      button.setCta().setButtonText("Set up server").onClick(async () => {
        try {
          await this.plugin.setupServer(this.serverUrl, this.displayName, this.deviceName, this.teamName || undefined);
          this.close();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Server setup failed");
        }
      })
    );
  }
}
