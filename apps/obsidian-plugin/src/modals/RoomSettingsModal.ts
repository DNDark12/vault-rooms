import { Modal, Notice, Setting } from "obsidian";
import type { AclRuleSummary, RoomSummary } from "../apiClient.js";
import type VaultRoomsPlugin from "../main.js";
import { confirmModal } from "./ConfirmModal.js";
import { setDestructiveCompat } from "../obsidianCompat.js";
import { pluginOptions, VaultPathSuggestModal } from "./pickers.js";

const PERMISSIONS = ["room:read", "room:write", "room:delete", "file:read", "file:write", "file:create", "file:delete", "sync:subscribe", "sync:push"];

type CapabilityDraft = { pluginId: string; displayName: string; mode: string; minVersion?: string };

export class RoomSettingsModal extends Modal {
  private name: string;
  /** Rooms are always folder rooms now - see CreateRoomModal.ts's matching note. Kept as a literal
   *  "folder" purely because updateRoomSettings' input type still carries a type field the server
   *  stores for back-compat with rooms created before this change. */
  private readonly type = "folder" as const;
  private sourcePath: string;
  private mountName: string;
  private localMountPath: string;
  /** Once the user edits "Mount name" directly, stop overwriting it when "Name" changes. */
  private mountNameTouched = false;
  private conflictPolicy: "keep_both" | "owner_wins";
  // CRDT room-mode toggle (docs/superpowers/plans/2026-07-20-crdt-sync.md contract 1.11, Phase 6
  // UI) - default off, matches RoomSummary.crdtEnabled's server default for a freshly created room.
  private crdtEnabled: boolean;
  private capabilities: CapabilityDraft[];
  private aclRules: AclRuleSummary[] = [];
  private subjectType: "team" | "user" = "team";
  private subjectId = "";
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
    this.sourcePath = room.sourcePath;
    this.mountName = room.mountName;
    this.conflictPolicy = room.conflictPolicy;
    this.crdtEnabled = room.crdtEnabled;
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
      await this.plugin.refreshTeams({ notify: false });
      this.subjectId = this.subjectId || this.defaultSubjectId();
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
    this.setTitle(`Room settings: ${this.room.name}`);

    this.renderRoomFields(contentEl);
    this.renderCapabilities(contentEl);
    this.renderAccess(contentEl);
    this.renderDangerZone(contentEl);
  }

  private renderRoomFields(parent: HTMLElement): void {
    new Setting(parent).setName("Room").setHeading();
    new Setting(parent).setName("Name").addText((text) =>
      text.setValue(this.name).onChange((value) => {
        this.name = value.trim();
        if (!this.mountNameTouched) {
          this.mountName = sanitizeMountName(this.name);
        }
      })
    );
    const isOwner = this.isOwnRoom();
    if (isOwner) {
      // For the owner, "Source path" (server-side) and "Local mount path" (client-side override)
      // are the same thing: the owner's device always mounts the room's real folder in place (see
      // main.ts's mountPathForRoom doc comment). Showing both as separately-editable fields let the
      // room drift into a broken state - an override different from sourcePath silently watched/
      // synced the wrong folder. Collapse to a single field that drives sourcePath directly; no
      // override is offered or persisted for the owner (see updateRoomSettings()).
      new Setting(parent)
        .setName("Room folder")
        .setDesc("The folder in your vault that this room shares - this is the content that actually gets synced to every member.")
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
    } else {
      new Setting(parent)
        .setName("Source path")
        .setDesc("The folder in the owner's vault that this room shares - this is the content that actually gets synced to every member. Only the owner can change this.")
        .addText((text) => text.setValue(this.sourcePath).setDisabled(true));
    }
    new Setting(parent)
      .setName("Mount name")
      .setDesc("The folder name teammates' copies sync into (auto-follows Name above; edit here for a different, filesystem-safe folder name).")
      .addText((text) =>
        text.setValue(this.mountName).onChange((value) => {
          this.mountName = value.trim();
          this.mountNameTouched = true;
        })
      );
    if (!isOwner) {
      new Setting(parent)
        .setName("Local mount path")
        .setDesc(
          "Where this device keeps its local copy of the room's files (a folder under Settings → Vault Rooms → Sync → Mount root by default). Leave blank to use that default." +
            (this.plugin.isRoomMounted(this.room.id) ? " Changing this takes effect after the next unmount/mount." : "")
        )
        .addText((text) => text.setValue(this.localMountPath).onChange((value) => (this.localMountPath = value.trim())));
    }
    new Setting(parent)
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
    if (this.isOwnRoom()) {
      new Setting(parent)
        .setName("Live editing (CRDT sync)")
        .setDesc(
          "Experimental, opt-in, and Markdown-only: lets multiple people type in the same note at the same time, merging edits automatically instead of the usual conflict-copy behavior above. Applies only to this room's .md files - other file types keep syncing as whole-file pushes either way. Vault Rooms builds from before this feature can still read notes in this mode, but cannot push a direct edit to one - they're told to upgrade instead."
        )
        .addToggle((toggle) =>
          toggle.setValue(this.crdtEnabled).onChange((value) => {
            this.crdtEnabled = value;
          })
        );
    }
  }

  private isOwnRoom(): boolean {
    return this.room.ownerUserId === this.plugin.getActiveServer()?.userId;
  }

  private applyChosenPath(path: string): void {
    this.sourcePath = path;
    if (!this.name) {
      this.name = basename(path);
    }
    if (!this.mountNameTouched) {
      this.mountName = sanitizeMountName(this.name || basename(path));
    }
    this.render();
  }

  private renderCapabilities(parent: HTMLElement): void {
    new Setting(parent).setName("Plugin capabilities").setHeading();
    parent.createEl("p", {
      cls: "vault-rooms-setting-hint",
      text: "Optional hints shown to members about which plugin works best with this room's files - nothing is enforced. Anyone can edit the plain Markdown directly, or use a different plugin, with or without these installed."
    });
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
              conflictPolicy: this.conflictPolicy,
              capabilities: this.capabilities,
              ...(this.isOwnRoom() ? { crdtEnabled: this.crdtEnabled } : {})
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
    new Setting(parent).setName("Room access").setHeading();
    parent.createEl("p", {
      cls: "vault-rooms-setting-hint",
      text: "Grant a whole team or a specific friend access to this room."
    });

    new Setting(parent).setName("Grant access to").addDropdown((dropdown) =>
      dropdown
        .addOption("team", "Team")
        .addOption("user", "Specific friend")
        .setValue(this.subjectType)
        .onChange((value) => {
          this.subjectType = value as "team" | "user";
          this.subjectId = this.defaultSubjectId();
          this.render();
        })
    );

    if (this.subjectType === "team") {
      if (this.plugin.teamDirectory.length === 0) {
        new Setting(parent).setDesc("No teams yet - create one from the Vault Rooms panel first.");
      } else {
        new Setting(parent).setName("Team").addDropdown((dropdown) => {
          for (const team of this.plugin.teamDirectory) {
            dropdown.addOption(team.id, team.name);
          }
          dropdown.setValue(this.subjectId).onChange((value) => (this.subjectId = value));
        });
      }
    } else {
      const activeFriends = this.plugin.friends.filter((friend) => !friend.revokedAt);
      if (activeFriends.length === 0) {
        new Setting(parent).setDesc("No friends yet - invite someone first.");
      } else {
        new Setting(parent).setName("Friend").addDropdown((dropdown) => {
          for (const friend of activeFriends) {
            dropdown.addOption(friend.id, friend.displayName);
          }
          dropdown.setValue(this.subjectId).onChange((value) => (this.subjectId = value));
        });
      }
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

    const applyRow = new Setting(parent);
    if (this.subjectType === "team") {
      applyRow.addButton((button) =>
        button.setButtonText("Add team as editor").onClick(async () => {
          if (!this.subjectId) {
            new Notice("Pick a team first.");
            return;
          }
          await this.grantAccess({ subjectType: "team", subjectId: this.subjectId, effect: "allow", preset: "editor", pathPattern: "**/*" });
        })
      );
    }
    applyRow.addButton((button) =>
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
        setDestructiveCompat(button.setButtonText("Remove"))
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
    new Setting(parent).setName("Danger zone").setHeading();
    new Setting(parent)
      .setName("Delete room")
      .setDesc("Permanently deletes this room and all of its files/history on the server for every member. This cannot be undone.")
      .addButton((button) =>
        setDestructiveCompat(button.setButtonText("Delete room"))
          .onClick(async () => {
            if (!(await confirmModal(this.app, "Delete room", `Delete room "${this.room.name}"? This removes it and all of its files for every member. This cannot be undone.`, "Delete room"))) {
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
    subjectType: "user" | "team";
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

  private defaultSubjectId(): string {
    if (this.subjectType === "team") {
      return this.plugin.teamDirectory[0]?.id ?? "";
    }
    if (this.subjectType === "user") {
      return this.plugin.friends.find((friend) => !friend.revokedAt)?.id ?? "";
    }
    return "";
  }

  private subjectLabel(rule: AclRuleSummary): string {
    if (rule.subjectType === "user") {
      const friend = this.plugin.friends.find((candidate) => candidate.id === rule.subjectId);
      return friend ? friend.displayName : rule.subjectId;
    }
    if (rule.subjectType === "team") {
      const team = this.plugin.teamDirectory.find((candidate) => candidate.id === rule.subjectId);
      return team ? team.name : rule.subjectId;
    }
    return `${rule.subjectType}:${rule.subjectId}`;
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
