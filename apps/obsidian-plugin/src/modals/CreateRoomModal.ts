import { App, Modal, Notice, Setting, TFolder } from "obsidian";
import type VaultRoomsPlugin from "../main.js";
import { pluginOptions, VaultPathSuggestModal } from "./pickers.js";

export class CreateRoomModal extends Modal {
  private name = "Projects Demo";
  /** Not user-facing - inferred from whichever picker button was used, or from what the typed
   *  path actually resolves to in the vault. Only matters as a hint server-side; see note below. */
  private type: "file" | "folder" = "folder";
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
    contentEl.createEl("h2", { text: "Create Room" });
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
      .setDesc("The folder (or single file) in your vault to share. Pick one with the buttons below, or type a path directly.")
      .addText((text) =>
        text.setValue(this.sourcePath).onChange((value) => {
          this.sourcePath = value.trim();
          this.type = inferPathType(this.app, this.sourcePath, this.type);
        })
      )
      .addButton((button) =>
        button.setButtonText("Choose folder").onClick(() => {
          new VaultPathSuggestModal(this.app, "folder", (path) => this.applyChosenPath(path, "folder")).open();
        })
      )
      .addButton((button) =>
        button.setButtonText("Choose file").onClick(() => {
          new VaultPathSuggestModal(this.app, "file", (path) => this.applyChosenPath(path, "file")).open();
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
    contentEl.createEl("h3", { text: "Plugin capabilities" });
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

  private applyChosenPath(path: string, type: "file" | "folder"): void {
    this.sourcePath = path;
    this.type = type;
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

/**
 * "Type" isn't actually load-bearing anywhere in sync/mount/policy logic (the server just stores
 * it, and the client's own mount loop treats every room's mountPath as a directory regardless) -
 * it only ever mattered for which file-picker button was used. So there's no user-facing "Type"
 * control: infer it instead, from whatever the typed path currently resolves to in the vault, and
 * fall back to whatever was last known (usually "folder") if the path doesn't exist yet.
 */
function inferPathType(app: App, path: string, previous: "file" | "folder"): "file" | "folder" {
  if (!path) {
    return previous;
  }
  const file = app.vault.getAbstractFileByPath(path);
  if (!file) {
    return previous;
  }
  return file instanceof TFolder ? "folder" : "file";
}

/** Keeps "Mount name" a single, filesystem-safe path segment (matches the server's isSafeMountName check). */
function sanitizeMountName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[/\\]+/g, "-")
    .replace(/^\.+/, "");
  return cleaned || "Room";
}
