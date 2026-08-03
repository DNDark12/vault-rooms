import { ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type { AclRuleSummary, RoomSummary } from "../apiClient.js";
import { EDITOR_PERMISSION_SET, accessRulePresentation } from "../accessPresentation.js";
import { userFacingError } from "../errorMessages.js";
import type VaultRoomsPlugin from "../main.js";
import { setDestructiveCompat } from "../obsidianCompat.js";
import { sanitizeRoomMountName } from "../onboarding.js";
import { confirmModal } from "./ConfirmModal.js";
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
  "sync:push"
] as const;

type CapabilityDraft = {
  pluginId: string;
  displayName: string;
  mode: string;
  minVersion?: string;
};

type AccessChoice = "reader" | "editor" | "deny" | "custom";

export class RoomSettingsModal extends Modal {
  private name: string;
  private readonly type = "folder" as const;
  private sourcePath: string;
  private mountName: string;
  private localMountPath: string;
  private mountNameTouched = false;
  private conflictPolicy: "keep_both" | "owner_wins";
  private crdtEnabled: boolean;
  private capabilities: CapabilityDraft[];
  private aclRules: AclRuleSummary[] = [];

  private advancedExpanded = false;
  private accessFormExpanded = false;
  /** The scroll container from the previous render, read only to carry scrollTop across re-renders. */
  private scrollEl?: HTMLElement;
  private rawPermissionsVisible = false;
  private expandedAclRules = new Set<string>();
  private subjectType: "team" | "user" = "team";
  private subjectId = "";
  private accessChoice: AccessChoice = "editor";
  private accessScope: "everything" | "folder" = "everything";
  private accessFolder = "";
  private customPermissions = new Set<string>(EDITOR_PERMISSION_SET);

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
      new Notice(userFacingError(error, "Failed to load room settings"));
    }
  }

  onClose(): void {
    // Drops the reference to a detached element and makes a reopened modal start at the top.
    this.scrollEl = undefined;
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    // Every render replaces the scroll container, so its scrollTop would reset to 0. Adding a plugin
    // suggestion or toggling Advanced re-renders from a control far down the modal, and jumping the user
    // back to the title loses the row they were working in.
    const previousScrollTop = this.scrollEl?.scrollTop ?? 0;
    contentEl.empty();
    contentEl.addClass("vault-rooms-settings-modal");
    this.setTitle(this.room.name);

    const scroll = contentEl.createDiv({ cls: "vault-rooms-settings-scroll" });
    this.scrollEl = scroll;
    this.renderSharing(scroll);
    this.renderAccess(scroll);
    this.renderAdvanced(scroll);
    this.renderDangerZone(scroll);
    // Children exist by now, so scrollHeight is final and this lands on the same content as before.
    scroll.scrollTop = previousScrollTop;
  }

  private renderSharing(parent: HTMLElement): void {
    new Setting(parent).setName("Sharing").setHeading();
    const sharing = parent.createDiv({ cls: "vault-rooms-settings-card" });
    const isOwner = this.isOwnRoom();

    const folder = new Setting(sharing)
      .setName(isOwner ? "In your vault at" : "Shared from the owner's vault at")
      .setDesc(this.sourcePath || "No folder selected");
    if (isOwner) {
      folder.addButton((button) =>
        button.setButtonText("Change").onClick(() => {
          new VaultPathSuggestModal(this.app, "folder", (path) => this.applyChosenPath(path)).open();
        })
      );
    }

    new Setting(sharing).setName("Room name").addText((text) =>
      text.setValue(this.name).onChange((value) => {
        this.name = value.trim();
        if (!this.mountNameTouched) {
          this.mountName = sanitizeRoomMountName(this.name);
        }
      })
    );

    new Setting(sharing)
      .setName("Live editing")
      .setDesc("Type in the same Markdown note at the same time. Other file types keep normal file syncing.")
      .addToggle((toggle) =>
        toggle.setValue(this.crdtEnabled).onChange((value) => {
          this.crdtEnabled = value;
        })
      );

    new Setting(parent).addButton((button) =>
      button.setCta().setButtonText("Save changes").onClick(async () => {
        await this.saveChanges();
      })
    );
  }

  private renderAccess(parent: HTMLElement): void {
    const heading = parent.createDiv({ cls: "vault-rooms-section-heading-row" });
    new Setting(heading).setName("Who can access").setHeading();
    heading.createSpan({ cls: "vault-rooms-card-status", text: String(this.aclRules.length) });

    const list = parent.createDiv({ cls: "vault-rooms-acl-list vault-rooms-access-list" });
    if (this.aclRules.length === 0) {
      list.createDiv({
        cls: "vault-rooms-empty-state",
        text: "Only the room owner and server owner can access this room so far."
      });
    }
    for (const rule of this.aclRules) {
      this.renderAccessRule(list, rule);
    }

    if (!this.accessFormExpanded) {
      new Setting(parent).addButton((button) =>
        button.setButtonText("Give someone access").onClick(() => {
          this.accessFormExpanded = true;
          this.subjectId = this.subjectId || this.defaultSubjectId();
          this.render();
        })
      );
      return;
    }
    this.renderAccessForm(parent);
  }

  private renderAccessRule(parent: HTMLElement, rule: AclRuleSummary): void {
    const presentation = accessRulePresentation(rule);
    const card = parent.createDiv({ cls: "vault-rooms-access-card" });
    const row = card.createDiv({ cls: "vault-rooms-access-row" });
    const copy = row.createDiv({ cls: "vault-rooms-access-copy" });
    copy.createEl("strong", { text: this.subjectLabel(rule) });
    copy.createDiv({ cls: "vault-rooms-card-status", text: presentation.summary });
    const expanded = this.expandedAclRules.has(rule.id);
    const manage = row.createEl("button", { text: expanded ? "Close Manage" : "Manage" });
    manage.onClickEvent(() => {
      if (expanded) this.expandedAclRules.delete(rule.id);
      else this.expandedAclRules.add(rule.id);
      this.render();
    });
    if (!expanded) return;

    const details = card.createDiv({ cls: "vault-rooms-access-details" });
    if (presentation.rawPermissions || this.rawPermissionsVisible) {
      details.createDiv({
        cls: "vault-rooms-raw-permissions",
        text: `Permissions: ${rule.permissions.join(", ")}`
      });
      details.createDiv({
        cls: "vault-rooms-raw-permissions",
        text: `Path: ${rule.pathPattern}`
      });
    }
    // Level change and removal share one row; a deny rule has no level to change, so it gets the
    // removal control on its own.
    this.renderAccessLevelChange(details, rule, presentation.kind);
  }

  /**
   * Manage previously offered only Remove access, so the sole way to change someone from edit to view was
   * to remove them and grant again from scratch.
   *
   * `acl_rules` has no unique key on (room, subject, path) and `createAclRule` always inserts, so
   * re-granting the same subject and path does not replace the old rule - it adds a second one, and the
   * wider of the two keeps winning. Changing a level therefore has to create the new rule and delete the
   * old one. It grants first: if the delete then fails the subject briefly holds two rules, which is
   * harmless, whereas deleting first and failing to grant would drop their access entirely.
   */
  private renderAccessLevelChange(
    parent: HTMLElement,
    rule: AclRuleSummary,
    kind: "reader" | "editor" | "custom" | "deny"
  ): void {
    const row = parent.createDiv({ cls: "vault-rooms-access-manage-row" });
    if (kind === "deny") {
      this.renderRemoveAccess(row, rule);
      return;
    }
    const select = row.createEl("select");
    select.createEl("option", { text: "Can edit", value: "editor" });
    select.createEl("option", { text: "Can view", value: "reader" });
    if (kind === "custom") {
      // Never silently collapse a hand-built permission set into a preset name.
      select.createEl("option", { text: "Custom (unchanged)", value: "custom" });
    }
    select.value = kind === "editor" || kind === "reader" ? kind : "custom";
    select.setAttribute("aria-label", `Access level for ${this.subjectLabel(rule)}`);

    // Changing the level saves immediately - there is no separate apply step. Because the write is a
    // grant followed by a delete rather than one update, a failure is reported and the list is reloaded
    // from the server so the control can never show a level the server does not hold.
    select.onchange = async () => {
      const preset = select.value;
      if (preset !== "reader" && preset !== "editor") return;
      if (preset === kind) return;
      select.disabled = true;
      try {
        await this.plugin.grantRoomAccess(this.room.id, {
          subjectType: rule.subjectType,
          subjectId: rule.subjectId,
          effect: "allow",
          pathPattern: rule.pathPattern,
          preset
        });
        await this.plugin.removeRoomAccess(this.room.id, rule.id);
        new Notice(
          `${this.subjectLabel(rule)} can now ${preset === "editor" ? "edit" : "view"} this room.`
        );
      } catch (error) {
        new Notice(userFacingError(error, "Failed to change access"));
      }
      this.aclRules = await this.plugin.listRoomAcl(this.room.id);
      this.expandedAclRules.delete(rule.id);
      this.render();
    };

    this.renderRemoveAccess(row, rule);
  }

  /**
   * Same destructive treatment as Delete room, so one visual language covers both.
   *
   * A bare ButtonComponent rather than a Setting: Setting brings a full flex layout box with its own
   * padding and border, which pushed this control out of alignment with the select beside it and with
   * the row above.
   */
  private renderRemoveAccess(row: HTMLElement, rule: AclRuleSummary): void {
    const button = new ButtonComponent(row);
    button.buttonEl.addClass("vault-rooms-access-remove");
    setDestructiveCompat(button.setButtonText("Remove access")).onClick(async () => {
        const confirmed = await confirmModal(
          this.app,
          "Remove room access",
          `Remove ${this.subjectLabel(rule)} from "${this.room.name}"?`,
          "Remove access"
        );
        if (!confirmed) return;
        try {
          await this.plugin.removeRoomAccess(this.room.id, rule.id);
          this.aclRules = await this.plugin.listRoomAcl(this.room.id);
          this.expandedAclRules.delete(rule.id);
          this.render();
        } catch (error) {
          new Notice(userFacingError(error, "Failed to remove access"));
        }
    });
  }

  private renderAccessForm(parent: HTMLElement): void {
    const form = parent.createDiv({ cls: "vault-rooms-access-form vault-rooms-settings-card" });
    new Setting(form).setName("Who").addDropdown((dropdown) => {
      const options = this.accessSubjects();
      if (options.length === 0) {
        dropdown.addOption("", "Invite someone or create a team first");
      } else {
        for (const option of options) {
          dropdown.addOption(`${option.type}:${option.id}`, option.label);
        }
      }
      dropdown
        .setValue(this.subjectId ? `${this.subjectType}:${this.subjectId}` : "")
        .onChange((value) => {
          const [type, ...id] = value.split(":");
          this.subjectType = type === "user" ? "user" : "team";
          this.subjectId = id.join(":");
        });
    });

    new Setting(form).setName("They can").addDropdown((dropdown) => {
      dropdown
        .addOption("editor", "Can edit")
        .addOption("reader", "Can view")
        .addOption("deny", "Blocked");
      if (this.advancedExpanded) {
        dropdown.addOption("custom", "Custom permissions");
      }
      dropdown
        .setValue(this.accessChoice)
        .onChange((value) => {
          this.accessChoice = value as AccessChoice;
          this.render();
        });
    });

    new Setting(form).setName("Where").addDropdown((dropdown) =>
      dropdown
        .addOption("everything", "Everything in this room")
        .addOption("folder", "Only a certain folder…")
        .setValue(this.accessScope)
        .onChange((value) => {
          this.accessScope = value as "everything" | "folder";
          this.render();
        })
    );
    if (this.accessScope === "folder") {
      new Setting(form)
        .setName("Folder")
        .setDesc("Type a folder inside this room, for example Meetings.")
        .addText((text) =>
          text
            .setPlaceholder("Meetings")
            .setValue(this.accessFolder)
            .onChange((value) => (this.accessFolder = value))
        );
    }
    if (this.accessChoice === "custom" && this.advancedExpanded) {
      this.renderCustomPermissions(form);
    }

    const actions = new Setting(form);
    actions.addButton((button) =>
      button.setCta().setButtonText("Give access").onClick(async () => {
        await this.confirmAndGrantAccess();
      })
    );
    actions.addButton((button) =>
      button.setButtonText("Cancel").onClick(() => {
        this.accessFormExpanded = false;
        this.render();
      })
    );
  }

  private renderCustomPermissions(parent: HTMLElement): void {
    const permissions = parent.createDiv({ cls: "vault-rooms-permission-grid" });
    for (const permission of PERMISSIONS) {
      const label = permissions.createEl("label");
      const checkbox = label.createEl("input", { type: "checkbox" });
      checkbox.checked = this.customPermissions.has(permission);
      checkbox.onchange = () => {
        if (checkbox.checked) this.customPermissions.add(permission);
        else this.customPermissions.delete(permission);
      };
      label.createSpan({ text: permission });
    }
  }

  private renderAdvanced(parent: HTMLElement): void {
    const disclosure = new Setting(parent).setName("Advanced");
    disclosure.settingEl.addClass("vault-rooms-settings-disclosure");
    disclosure.addButton((button) =>
      button.setButtonText(this.advancedExpanded ? "Hide" : "Show").onClick(() => {
        this.advancedExpanded = !this.advancedExpanded;
        if (!this.advancedExpanded && this.accessChoice === "custom") {
          this.accessChoice = "editor";
        }
        this.render();
      })
    );
    if (!this.advancedExpanded) return;

    const advanced = parent.createDiv({ cls: "vault-rooms-settings-card vault-rooms-advanced-settings" });
    new Setting(advanced)
      .setName("Folder name on teammates' computers")
      .addText((text) =>
        text.setValue(this.mountName).onChange((value) => {
          this.mountName = value.trim();
          this.mountNameTouched = true;
        })
      );
    if (!this.isOwnRoom()) {
      new Setting(advanced)
        .setName("Folder on this computer")
        .setDesc(
          this.plugin.isRoomMounted(this.room.id)
            ? "This change takes effect after you remove and add the room again."
            : "Leave blank to use the default Vault Rooms folder."
        )
        .addText((text) =>
          text.setValue(this.localMountPath).onChange((value) => {
            this.localMountPath = value.trim();
          })
        );
    }
    new Setting(advanced)
      .setName("If two people save at once")
      .setDesc("Keep both never loses a write.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("keep_both", "Keep both copies")
          .addOption("owner_wins", "Keep the room owner's copy")
          .setValue(this.conflictPolicy)
          .onChange((value) => {
            this.conflictPolicy = value as "keep_both" | "owner_wins";
          })
      );
    this.renderCapabilities(advanced);
    new Setting(advanced)
      .setName("Show raw permissions")
      .setDesc("For troubleshooting custom access rules.")
      .addToggle((toggle) =>
        toggle.setValue(this.rawPermissionsVisible).onChange((value) => {
          this.rawPermissionsVisible = value;
          this.render();
        })
      );
    advanced.createDiv({
      cls: "vault-rooms-setting-hint",
      text: "Use Save changes above to apply these room settings."
    });
  }

  private renderCapabilities(parent: HTMLElement): void {
    new Setting(parent).setName("Plugin suggestions").setHeading();
    parent.createDiv({
      cls: "vault-rooms-setting-hint",
      text: "Shown to members as a hint. Nothing is enforced."
    });
    const options = pluginOptions(this.app, this.capabilities);
    for (const capability of this.capabilities) {
      const row = new Setting(parent)
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
        .addButton((button) => {
          const label = `Remove ${capability.displayName}`;
          button
            .setIcon("trash-2")
            .setTooltip(label)
            .onClick(() => {
              this.capabilities = this.capabilities.filter((item) => item !== capability);
              this.render();
            });
          button.buttonEl.setAttribute("aria-label", label);
        });
      row.settingEl.addClass("vault-rooms-capability-row");
    }
    new Setting(parent).addButton((button) =>
      button.setButtonText("Add plugin suggestion").onClick(() => {
        const existing = new Set(this.capabilities.map((capability) => capability.pluginId));
        const option = options.find((candidate) => !existing.has(candidate.pluginId)) ?? options[0];
        if (!option) {
          new Notice("No plugins found.");
          return;
        }
        this.capabilities.push({
          pluginId: option.pluginId,
          displayName: option.displayName,
          mode: "optional"
        });
        this.render();
      })
    );
  }

  private renderDangerZone(parent: HTMLElement): void {
    if (!this.plugin.canManageRoom(this.room)) return;
    const danger = parent.createDiv({ cls: "vault-rooms-room-danger-zone" });
    new Setting(danger).setName("Delete this room").setHeading();
    danger.createDiv({
      cls: "vault-rooms-setting-hint",
      text: "Removes it and its history for everyone. This can't be undone."
    });
    const action = new Setting(danger);
    action.settingEl.addClass("vault-rooms-danger-action");
    action.addButton((button) =>
      setDestructiveCompat(button.setButtonText("Delete room")).onClick(async () => {
        const confirmed = await confirmModal(
          this.app,
          "Delete room",
          `Delete room "${this.room.name}"? This removes it and all of its files for every member. This cannot be undone.`,
          "Delete room"
        );
        if (!confirmed) return;
        try {
          await this.plugin.deleteRoom(this.room);
          this.close();
        } catch (error) {
          new Notice(userFacingError(error, "Failed to delete room"));
        }
      })
    );
  }

  private async saveChanges(): Promise<void> {
    if (!this.name) {
      new Notice("Room name is required.");
      return;
    }
    if (!this.sourcePath) {
      new Notice("Choose a folder to share.");
      return;
    }
    if (!this.mountName) {
      new Notice("Folder name on teammates' computers is required.");
      return;
    }
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
          crdtEnabled: this.crdtEnabled
        },
        this.localMountPath
      );
      this.room = this.plugin.visibleRooms.find((room) => room.id === this.room.id) ?? {
        ...this.room,
        name: this.name,
        sourcePath: this.sourcePath,
        mountName: this.mountName,
        conflictPolicy: this.conflictPolicy,
        capabilities: this.capabilities.map((capability) => ({
          ...capability,
          installed: this.room.capabilities.find((item) => item.pluginId === capability.pluginId)?.installed ?? null
        })),
        crdtEnabled: this.crdtEnabled
      };
      new Notice("Room settings saved.");
      this.render();
    } catch (error) {
      new Notice(userFacingError(error, "Room update failed"));
    }
  }

  private async confirmAndGrantAccess(): Promise<void> {
    if (!this.subjectId) {
      new Notice("Choose a person or team first.");
      return;
    }
    const pathPattern = this.pathPattern();
    if (!pathPattern) return;
    if (this.accessChoice === "custom" && this.customPermissions.size === 0) {
      new Notice("Pick at least one permission.");
      return;
    }
    const label = this.subjectLabelFor(this.subjectType, this.subjectId);
    const action = this.accessChoice === "deny"
      ? "block"
      : this.accessChoice === "reader"
        ? "let view"
        : this.accessChoice === "editor"
          ? "let edit"
          : "give custom access to";
    const confirmed = await confirmModal(
      this.app,
      "Confirm room access",
      `${action[0]?.toUpperCase()}${action.slice(1)} ${label} in "${this.room.name}"?`,
      this.accessChoice === "deny" ? "Block access" : "Give access"
    );
    if (!confirmed) return;

    const input = {
      subjectType: this.subjectType,
      subjectId: this.subjectId,
      effect: this.accessChoice === "deny" ? "deny" as const : "allow" as const,
      pathPattern,
      ...(this.accessChoice === "custom"
        ? { permissions: [...this.customPermissions] }
        : { preset: this.accessChoice === "deny" ? "reader" : this.accessChoice })
    };
    try {
      await this.plugin.grantRoomAccess(this.room.id, input);
      this.aclRules = await this.plugin.listRoomAcl(this.room.id);
      this.accessFormExpanded = false;
      this.render();
    } catch (error) {
      new Notice(userFacingError(error, "Room access update failed"));
    }
  }

  private pathPattern(): string | null {
    if (this.accessScope === "everything") return "**/*";
    const folder = this.accessFolder.trim().replace(/^\/+|\/+$/g, "");
    if (!folder) {
      new Notice("Type the folder that this access applies to.");
      return null;
    }
    if (folder.includes("*")) {
      new Notice("Use a folder name here, not a path pattern.");
      return null;
    }
    return `${folder}/**/*`;
  }

  private accessSubjects(): Array<{ type: "team" | "user"; id: string; label: string }> {
    return [
      ...this.plugin.teamDirectory.map((team) => ({
        type: "team" as const,
        id: team.id,
        label: `${team.name} — team`
      })),
      ...this.plugin.friends
        .filter((friend) => !friend.revokedAt)
        .map((friend) => ({
          type: "user" as const,
          id: friend.id,
          label: `${friend.displayName} — person`
        }))
    ];
  }

  private defaultSubjectId(): string {
    const first = this.accessSubjects()[0];
    if (!first) return "";
    this.subjectType = first.type;
    return first.id;
  }

  private subjectLabel(rule: AclRuleSummary): string {
    return this.subjectLabelFor(rule.subjectType, rule.subjectId);
  }

  private subjectLabelFor(subjectType: "user" | "team", subjectId: string): string {
    if (subjectType === "user") {
      return this.plugin.friends.find((friend) => friend.id === subjectId)?.displayName ?? subjectId;
    }
    return this.plugin.teamDirectory.find((team) => team.id === subjectId)?.name ?? subjectId;
  }

  private isOwnRoom(): boolean {
    return this.room.ownerUserId === this.plugin.getActiveServer()?.userId;
  }

  private applyChosenPath(path: string): void {
    this.sourcePath = path;
    if (!this.name) this.name = basename(path);
    if (!this.mountNameTouched) {
      this.mountName = sanitizeRoomMountName(this.name || basename(path));
    }
    this.render();
  }
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
