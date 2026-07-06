import { Modal, Notice, Setting } from "obsidian";
import type VaultRoomsPlugin from "../main.js";
import { pluginOptions, VaultPathSuggestModal } from "./pickers.js";

export class CreateRoomModal extends Modal {
  private name = "Projects Demo";
  private type: "file" | "folder" = "folder";
  private sourcePath = "Projects/Demo";
  private mountName = "Projects Demo";
  private capabilities = [
    { pluginId: "obsidian-tasks-plugin", displayName: "Tasks", mode: "recommended" },
    { pluginId: "obsidian-kanban", displayName: "Kanban", mode: "recommended" }
  ];
  constructor(private readonly plugin: VaultRoomsPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Create Room" });
    new Setting(contentEl).setName("Name").addText((text) => text.setValue(this.name).onChange((value) => (this.name = value.trim())));
    new Setting(contentEl).setName("Type").addDropdown((dropdown) =>
      dropdown
        .addOption("folder", "Folder")
        .addOption("file", "File")
        .setValue(this.type)
        .onChange((value) => (this.type = value as "file" | "folder"))
    );
    new Setting(contentEl)
      .setName("Source path")
      .addText((text) => text.setValue(this.sourcePath).onChange((value) => (this.sourcePath = value.trim())))
      .addButton((button) =>
        button.setButtonText(this.type === "folder" ? "Choose folder" : "Choose file").onClick(() => {
          new VaultPathSuggestModal(this.app, this.type, (path) => {
            this.sourcePath = path;
            if (!this.name || this.name === "Projects Demo") {
              this.name = basename(path);
            }
            if (!this.mountName || this.mountName === "Projects Demo") {
              this.mountName = basename(path);
            }
            this.onOpen();
          }).open();
        })
      );
    new Setting(contentEl).setName("Mount name").addText((text) => text.setValue(this.mountName).onChange((value) => (this.mountName = value.trim())));
    contentEl.createEl("h3", { text: "Plugin capabilities" });
    const options = pluginOptions(this.app, this.capabilities);
    for (const capability of this.capabilities) {
      new Setting(contentEl)
        .setName("Plugin")
        .addDropdown((dropdown) => {
          for (const option of options) {
            dropdown.addOption(option.pluginId, option.displayName);
          }
          dropdown.setValue(capability.pluginId).onChange((pluginId) => {
            const selected = options.find((option) => option.pluginId === pluginId);
            capability.pluginId = pluginId;
            capability.displayName = selected?.displayName ?? pluginId;
            this.onOpen();
          });
        })
        .addDropdown((dropdown) =>
          dropdown
            .addOption("off", "Off")
            .addOption("optional", "Optional")
            .addOption("recommended", "Recommended")
            .addOption("required", "Required")
            .setValue(capability.mode)
            .onChange((value) => {
              capability.mode = value;
              if (value === "off") {
                this.capabilities = this.capabilities.filter((item) => item !== capability);
                this.onOpen();
              }
            })
        );
    }
    new Setting(contentEl).addButton((button) =>
      button.setButtonText("Add plugin").onClick(() => {
        const existing = new Set(this.capabilities.map((capability) => capability.pluginId));
        const option = options.find((candidate) => !existing.has(candidate.pluginId)) ?? options[0];
        if (!option) {
          new Notice("No plugins found.");
          return;
        }
        this.capabilities.push({ pluginId: option.pluginId, displayName: option.displayName, mode: "optional" });
        this.onOpen();
      })
    );
    new Setting(contentEl).addButton((button) =>
      button.setCta().setButtonText("Create").onClick(async () => {
        try {
          await this.plugin.createRoom({
            name: this.name,
            type: this.type,
            sourcePath: this.sourcePath,
            mountName: this.mountName,
            capabilities: this.capabilities.filter((capability) => capability.mode !== "off")
          });
          this.close();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Room creation failed");
        }
      })
    );
  }
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
