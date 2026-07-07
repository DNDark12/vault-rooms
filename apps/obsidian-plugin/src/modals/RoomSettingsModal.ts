import { Modal, Notice, Setting } from "obsidian";
import type { AclRuleSummary, RoomSummary } from "../apiClient.js";
import type VaultRoomsPlugin from "../main.js";
import { pluginOptions, VaultPathSuggestModal } from "./pickers.js";

const PERMISSIONS = [
  "room:read",
  "room:write",
  "room:delete",
  "file:read",
  "file:write",
  "file:create",
  "file:delete",
  "sync:subscribe",
  "sync:push",
  "mcp:use",
  "tool:list_files",
  "tool:read_file",
  "tool:write_file",
  "tool:list_tasks",
  "tool:create_task",
  "tool:update_task_status",
  "tool:create_kanban_card",
  "tool:move_kanban_card"
];

type CapabilityDraft = { pluginId: string; displayName: string; mode: string; minVersion?: string };

export class RoomSettingsModal extends Modal {
  private name: string;
  private type: "file" | "folder";
  private sourcePath: string;
  private mountName: string;
  private localMountPath: string;
  private capabilities: CapabilityDraft[];
  private aclRules: AclRuleSummary[] = [];
  private subjectType: "role" | "user" | "device" | "agent" = "role";
  private subjectId = "member";
  private effect: "allow" | "deny" = "allow";
  private preset: "reader" | "editor" | "custom" = "reader";
  private pathPattern = "**/*";
  private customPermissions = new Set<string>(["room:read", "file:read", "sync:subscribe"]);

  constructor(
    private readonly plugin: VaultRoomsPlugin,
    private room: RoomSummary
  ) {
    super(plugin.app);
    this.name = room.name;
    this.type = room.type;
    this.sourcePath = room.sourcePath;
    this.mountName = room.mountName;
    this.localMountPath = plugin.settings.roomMountPaths[room.id] ?? plugin.roomMountPathFor(room);
    this.capabilities = room.capabilities.map((capability) => ({
      pluginId: capability.pluginId,
      displayName: capability.displayName,
      mode: capability.mode,
      minVersion: capability.minVersion
    }));
  }

  onOpen(): void {
    this.render();
    void this.loadAccessData();
  }

  private async loadAccessData(): Promise<void> {
    try {
      await this.plugin.refreshTeamMembers({ notify: false });
      this.aclRules = await this.plugin.listRoomAcl(this.room.id);
      this.render();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Failed to load room settings");
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("vault-rooms-settings-modal");
    contentEl.createEl("h2", { text: `Room Settings: ${this.room.name}` });

    this.renderRoomFields(contentEl);
    this.renderCapabilities(contentEl);
    this.renderAccess(contentEl);
    this.renderDangerZone(contentEl);
  }

  private renderRoomFields(parent: HTMLElement): void {
    parent.createEl("h3", { text: "Room" });
    new Setting(parent).setName("Name").addText((text) => text.setValue(this.name).onChange((value) => (this.name = value.trim())));
    new Setting(parent).setName("Type").addDropdown((dropdown) =>
      dropdown
        .addOption("folder", "Folder")
        .addOption("file", "File")
        .setValue(this.type)
        .onChange((value) => (this.type = value as "file" | "folder"))
    );
    new Setting(parent)
      .setName("Source path")
      .addText((text) => text.setValue(this.sourcePath).onChange((value) => (this.sourcePath = value.trim())))
      .addButton((button) =>
        button.setButtonText(this.type === "folder" ? "Choose folder" : "Choose file").onClick(() => {
          new VaultPathSuggestModal(this.app, this.type, (path) => {
            this.sourcePath = path;
            if (!this.name) {
              this.name = basename(path);
            }
            if (!this.mountName) {
              this.mountName = basename(path);
            }
            this.render();
          }).open();
        })
      );
    new Setting(parent).setName("Mount name").addText((text) => text.setValue(this.mountName).onChange((value) => (this.mountName = value.trim())));
    new Setting(parent)
      .setName("Local mount path")
      .setDesc(this.plugin.isRoomMounted(this.room.id) ? "Used after next unmount/mount." : "Used when this room is mounted.")
      .addText((text) => text.setValue(this.localMountPath).onChange((value) => (this.localMountPath = value.trim())));
  }

  private renderCapabilities(parent: HTMLElement): void {
    parent.createEl("h3", { text: "Plugin capabilities" });
    const options = pluginOptions(this.app, this.capabilities);
    for (const capability of this.capabilities) {
      new Setting(parent)
        .setName("Plugin")
        .addDropdown((dropdown) => {
          for (const option of options) {
            dropdown.addOption(option.pluginId, option.displayName);
          }
          dropdown.setValue(capability.pluginId).onChange((pluginId) => {
            const selected = options.find((option) => option.pluginId === pluginId);
            capability.pluginId = pluginId;
            capability.displayName = selected?.displayName ?? pluginId;
            this.render();
          });
        })
        .addDropdown((dropdown) =>
          dropdown
            .addOption("optional", "Optional")
            .addOption("recommended", "Recommended")
            .addOption("required", "Required")
            .setValue(capability.mode)
            .onChange((value) => (capability.mode = value))
        )
        .addText((text) => text.setPlaceholder("min version").setValue(capability.minVersion ?? "").onChange((value) => (capability.minVersion = value.trim() || undefined)))
        .addButton((button) =>
          button.setButtonText("Remove").onClick(() => {
            this.capabilities = this.capabilities.filter((item) => item !== capability);
            this.render();
          })
        );
    }
    new Setting(parent).addButton((button) =>
      button.setButtonText("Add plugin").onClick(() => {
        const existing = new Set(this.capabilities.map((capability) => capability.pluginId));
        const option = options.find((candidate) => !existing.has(candidate.pluginId)) ?? options[0];
        if (!option) {
          new Notice("No plugins found.");
          return;
        }
        this.capabilities.push({ pluginId: option.pluginId, displayName: option.displayName, mode: "optional" });
        this.render();
      })
    );

    new Setting(parent).addButton((button) =>
      button.setCta().setButtonText("Save room settings").onClick(async () => {
        try {
          await this.plugin.updateRoomSettings(
            this.room.id,
            {
              name: this.name,
              type: this.type,
              sourcePath: this.sourcePath,
              mountName: this.mountName,
              capabilities: this.capabilities
            },
            this.localMountPath
          );
          this.room = this.plugin.visibleRooms.find((room) => room.id === this.room.id) ?? this.room;
          this.render();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Room update failed");
        }
      })
    );
  }

  private renderAccess(parent: HTMLElement): void {
    parent.createEl("h3", { text: "Room access" });
    parent.createEl("p", {
      cls: "vault-rooms-setting-hint",
      text: "Grant a whole team role, a specific member, or (advanced) a specific device/agent id access to this room."
    });

    new Setting(parent).setName("Grant access to").addDropdown((dropdown) =>
      dropdown
        .addOption("role", "Whole team role")
        .addOption("user", "Specific team member")
        .addOption("device", "Specific device (advanced)")
        .addOption("agent", "Specific agent (advanced)")
        .setValue(this.subjectType)
        .onChange((value) => {
          this.subjectType = value as "role" | "user" | "device" | "agent";
          this.subjectId = this.defaultSubjectId();
          this.render();
        })
    );

    if (this.subjectType === "role") {
      new Setting(parent).setName("Role").addDropdown((dropdown) =>
        dropdown
          .addOption("member", "Member")
          .addOption("admin", "Admin")
          .addOption("owner", "Owner")
          .setValue(this.subjectId)
          .onChange((value) => (this.subjectId = value))
      );
    } else if (this.subjectType === "user") {
      const activeMembers = this.plugin.teamMembers.filter((member) => !member.revokedAt);
      if (activeMembers.length === 0) {
        new Setting(parent).setDesc("No active team members yet - invite someone first.");
      } else {
        new Setting(parent).setName("Team member").addDropdown((dropdown) => {
          for (const member of activeMembers) {
            dropdown.addOption(member.userId, `${member.displayName} (${member.role})`);
          }
          dropdown.setValue(this.subjectId).onChange((value) => (this.subjectId = value));
        });
      }
    } else {
      new Setting(parent)
        .setName(this.subjectType === "device" ? "Device id" : "Agent id")
        .setDesc("Paste the exact device or agent id - only use this for advanced/automation setups.")
        .addText((text) => text.setValue(this.subjectId).onChange((value) => (this.subjectId = value.trim())));
    }

    new Setting(parent)
      .setName("Access")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("allow", "Allow")
          .addOption("deny", "Deny")
          .setValue(this.effect)
          .onChange((value) => (this.effect = value as "allow" | "deny"))
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("reader", "Reader")
          .addOption("editor", "Editor")
          .addOption("custom", "Custom")
          .setValue(this.preset)
          .onChange((value) => {
            this.preset = value as "reader" | "editor" | "custom";
            this.render();
          })
      );
    new Setting(parent).setName("Path pattern").addText((text) => text.setValue(this.pathPattern).onChange((value) => (this.pathPattern = value.trim() || "**/*")));

    if (this.preset === "custom") {
      const permissions = parent.createDiv({ cls: "vault-rooms-permission-grid" });
      for (const permission of PERMISSIONS) {
        const label = permissions.createEl("label");
        const checkbox = label.createEl("input", { type: "checkbox" });
        checkbox.checked = this.customPermissions.has(permission);
        checkbox.onchange = () => {
          if (checkbox.checked) {
            this.customPermissions.add(permission);
          } else {
            this.customPermissions.delete(permission);
          }
        };
        label.createSpan({ text: permission });
      }
    }

    new Setting(parent)
      .addButton((button) =>
        button.setButtonText("Add whole team as editor").onClick(async () => {
          await this.grantWholeTeamEditor();
        })
      )
      .addButton((button) =>
        button.setCta().setButtonText("Apply access").onClick(async () => {
          await this.grantAccess({
            subjectType: this.subjectType,
            subjectId: this.subjectId,
            effect: this.effect,
            ...(this.preset === "custom" ? { permissions: [...this.customPermissions] } : { preset: this.preset }),
            pathPattern: this.pathPattern
          });
        })
      );

    const acl = parent.createDiv({ cls: "vault-rooms-acl-list" });
    if (this.aclRules.length === 0) {
      acl.createDiv({ cls: "vault-rooms-empty", text: "No explicit room access rules." });
      return;
    }
    for (const rule of this.aclRules) {
      const row = new Setting(acl)
        .setName(`${rule.effect} - ${this.subjectLabel(rule)}`)
        .setDesc(`${rule.permissions.join(", ")} / ${rule.pathPattern}`);
      row.addButton((button) =>
        button
          .setButtonText("Remove")
          .setWarning()
          .onClick(async () => {
            try {
              await this.plugin.removeRoomAccess(this.room.id, rule.id);
              this.aclRules = await this.plugin.listRoomAcl(this.room.id);
              this.render();
            } catch (error) {
              new Notice(error instanceof Error ? error.message : "Failed to remove access rule");
            }
          })
      );
    }
  }

  private renderDangerZone(parent: HTMLElement): void {
    if (!this.room.permissions.includes("room:delete")) {
      return;
    }
    parent.createEl("h3", { text: "Danger zone" });
    new Setting(parent)
      .setName("Delete room")
      .setDesc("Permanently deletes this room and all of its files/history on the server for every member. This cannot be undone.")
      .addButton((button) =>
        button
          .setButtonText("Delete room")
          .setWarning()
          .onClick(async () => {
            if (!window.confirm(`Delete room "${this.room.name}"? This removes it and all of its files for every member. This cannot be undone.`)) {
              return;
            }
            try {
              await this.plugin.deleteRoom(this.room);
              this.close();
            } catch (error) {
              new Notice(error instanceof Error ? error.message : "Failed to delete room");
            }
          })
      );
  }

  private async grantAccess(input: {
    subjectType: "user" | "role" | "device" | "agent";
    subjectId: string;
    effect: "allow" | "deny";
    preset?: "reader" | "editor";
    permissions?: string[];
    pathPattern: string;
  }): Promise<void> {
    if (!input.subjectId) {
      new Notice("Subject id is required.");
      return;
    }
    if (input.permissions && input.permissions.length === 0) {
      new Notice("Pick at least one permission.");
      return;
    }
    try {
      await this.plugin.grantRoomAccess(this.room.id, input);
      this.aclRules = await this.plugin.listRoomAcl(this.room.id);
      this.render();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Room access update failed");
    }
  }

  private async grantWholeTeamEditor(): Promise<void> {
    try {
      await this.plugin.grantRoomAccess(this.room.id, { subjectType: "role", subjectId: "member", effect: "allow", preset: "editor", pathPattern: "**/*" });
      await this.plugin.grantRoomAccess(this.room.id, { subjectType: "role", subjectId: "admin", effect: "allow", preset: "editor", pathPattern: "**/*" });
      this.aclRules = await this.plugin.listRoomAcl(this.room.id);
      this.render();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Whole team access update failed");
    }
  }

  private defaultSubjectId(): string {
    if (this.subjectType === "role") {
      return "member";
    }
    if (this.subjectType === "user") {
      return this.plugin.teamMembers.find((member) => !member.revokedAt)?.userId ?? "";
    }
    return "";
  }

  private subjectLabel(rule: AclRuleSummary): string {
    if (rule.subjectType === "user") {
      const member = this.plugin.teamMembers.find((candidate) => candidate.userId === rule.subjectId);
      return member ? `${member.displayName} (${member.role})` : rule.subjectId;
    }
    return `${rule.subjectType}:${rule.subjectId}`;
  }
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
