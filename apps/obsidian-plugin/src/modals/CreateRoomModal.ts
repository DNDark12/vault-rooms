import { Modal, Notice, Setting } from "obsidian";
import type VaultRoomsPlugin from "../main.js";
import { pluginOptions, VaultPathSuggestModal } from "./pickers.js";

export class CreateRoomModal extends Modal {
  private name = "Projects Demo";
  /** Rooms are always folder rooms now - single-file rooms are no longer creatable (their sync
   *  prefix logic never actually worked - see the audited finding). Kept as a literal "folder" for
   *  now purely because RoomSummary/createRoom's input type still carries a type field the server
   *  stores for back-compat with rooms created before this change. */
  private readonly type = "folder" as const;
  private sourcePath = "Projects/Demo";
  private mountName = "Projects Demo";
  /** Once the user edits "Mount name" directly, stop overwriting it when "Name" changes. */
  private mountNameTouched = false;
  private conflictPolicy: "keep_both" | "owner_wins" = "keep_both";
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
    this.setTitle("Create room");
    new Setting(contentEl).setName("Name").addText((text) =>
      text.setValue(this.name).onChange((value) => {
        this.name = value.trim();
        if (!this.mountNameTouched) {
          this.mountName = sanitizeMountName(this.name);
        }
      })
    );
    new Setting(contentEl)
      .setName("Source path")
      .setDesc("The folder in your vault to share. Pick one with the button below, or type a path directly.")
      .addText((text) =>
        text.setValue(this.sourcePath).onChange((value) => {
          this.sourcePath = value.trim();
        })
      )
      .addButton((button) =>
        button.setButtonText("Choose folder").onClick(() => {
          new VaultPathSuggestModal(this.app, "folder", (path) => this.applyChosenPath(path)).open();
        })
      );
    new Setting(contentEl)
      .setName("Mount name")
      .setDesc("The folder name teammates' copies sync into (auto-follows Name above; edit here for a different, filesystem-safe folder name).")
      .addText((text) =>
        text.setValue(this.mountName).onChange((value) => {
          this.mountName = value.trim();
          this.mountNameTouched = true;
        })
      );
    new Setting(contentEl)
      .setName("When edits conflict")
      .setDesc(
        "Keep both: a losing write is never lost - it's saved as a local-only conflict copy on whichever device pushed second. Owner's version always wins: your writes always become the room's canonical version, even if someone else's edit landed a moment earlier - good for files you autosave frequently (e.g. a drawing) so they don't keep forking."
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("keep_both", "Keep both (default)")
          .addOption("owner_wins", "Owner's version always wins")
          .setValue(this.conflictPolicy)
          .onChange((value) => {
            this.conflictPolicy = value as "keep_both" | "owner_wins";
          })
      );
    new Setting(contentEl).setName("Plugin capabilities").setHeading();
    contentEl.createEl("p", {
      cls: "vault-rooms-setting-hint",
      text: "Optional hints shown to members about which plugin works best with this room's files - nothing is enforced. Anyone can edit the plain Markdown directly, or use a different plugin, with or without these installed."
    });
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
            conflictPolicy: this.conflictPolicy,
            capabilities: this.capabilities.filter((capability) => capability.mode !== "off")
          });
          this.close();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Room creation failed");
        }
      })
    );
  }

  private applyChosenPath(path: string): void {
    this.sourcePath = path;
    if (!this.name || this.name === "Projects Demo") {
      this.name = basename(path);
    }
    if (!this.mountNameTouched) {
      this.mountName = sanitizeMountName(this.name);
    }
    this.onOpen();
  }
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** Keeps "Mount name" a single, filesystem-safe path segment (matches the server's isSafeMountName check). */
function sanitizeMountName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[/\\]+/g, "-")
    .replace(/^\.+/, "");
  return cleaned || "Room";
}
