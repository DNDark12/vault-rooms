import { Modal, Notice, Setting } from "obsidian";
import type VaultRoomsPlugin from "../main.js";
import { defaultDeviceName } from "./deviceName.js";

export class SetupTeamModal extends Modal {
  private teamName = "";
  private displayName = "";
  private deviceName = "";

  constructor(private readonly plugin: VaultRoomsPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("Set up server");
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Creates your account and device identity on this device's relay server (starting it first if it isn't running yet - no separate address to enter). Do this once per server - after that, use \"Create team\" and \"Invite\" from the Vault Rooms panel."
    });
    new Setting(contentEl)
      .setName("Display name")
      .setDesc("This is what teammates will see you as.")
      .addText((text) => {
        window.setTimeout(() => text.inputEl.focus(), 0);
        text.setValue(this.displayName).onChange((value) => (this.displayName = value.trim()));
      });
    new Setting(contentEl)
      .setName("Device name")
      .setDesc("Identifies this specific device (shown in conflict-copy filenames, and lets a lost/stolen device be revoked separately from your account later).")
      .addText((text) => text.setValue(this.deviceName || defaultDeviceName()).onChange((value) => (this.deviceName = value.trim())));
    new Setting(contentEl)
      .setName("First team name")
      .setDesc("Optional - creates a team you own right away. You can create more teams later.")
      .addText((text) => text.setValue(this.teamName).onChange((value) => (this.teamName = value.trim())));
    new Setting(contentEl).addButton((button) =>
      button.setCta().setButtonText("Set up server").onClick(async () => {
        if (!this.displayName) {
          new Notice("Display name is required.");
          return;
        }
        try {
          await this.plugin.setupServer(this.displayName, this.deviceName || "Obsidian desktop", this.teamName || undefined);
          this.close();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Server setup failed");
        }
      })
    );
  }
}
