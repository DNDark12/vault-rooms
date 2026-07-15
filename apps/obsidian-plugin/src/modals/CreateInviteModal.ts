import { Modal, Notice, Setting } from "obsidian";
import type VaultRoomsPlugin from "../main.js";

type InviteType = "room" | "team" | "friend";

export class CreateInviteModal extends Modal {
  private inviteType: InviteType;
  private roomId = "";
  private roomPreset: "reader" | "editor" = "reader";
  private teamId = "";
  private teamRole: "member" | "admin" = "member";

  constructor(private readonly plugin: VaultRoomsPlugin) {
    super(plugin.app);
    const availableTypes = this.availableInviteTypes();
    this.inviteType = availableTypes[0] ?? "friend";
    const rooms = this.manageableRooms();
    const teams = this.manageableTeams();
    this.roomId = rooms[0]?.id ?? "";
    this.teamId = teams[0]?.id ?? "";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("Create invite");
    contentEl.createEl("p", {
      cls: "vault-rooms-setting-hint",
      text: "Choose what this invite grants when someone joins this server."
    });
    new Setting(contentEl).setName("Invite type").addDropdown((dropdown) => {
      for (const type of this.availableInviteTypes()) {
        dropdown.addOption(type, type === "room" ? "Room" : type === "team" ? "Team" : "Friend");
      }
      dropdown.setValue(this.inviteType).onChange((value) => {
        this.inviteType = value as InviteType;
        this.onOpen();
      });
    });

    if (this.inviteType === "room") {
      this.renderRoomFields(contentEl);
    } else if (this.inviteType === "team") {
      this.renderTeamFields(contentEl);
    } else {
      contentEl.createEl("p", { cls: "vault-rooms-setting-hint", text: "Adds the person as a friend on this server without granting room or team access." });
    }

    new Setting(contentEl).addButton((button) =>
      button.setCta().setButtonText("Create invite").onClick(async () => {
        try {
          await this.submit();
          this.close();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Invite creation failed");
        }
      })
    );
  }

  private renderRoomFields(parent: HTMLElement): void {
    const rooms = this.manageableRooms();
    new Setting(parent).setName("Room").addDropdown((dropdown) => {
      if (rooms.length === 0) {
        dropdown.addOption("", "No manageable rooms");
      } else {
        for (const room of rooms) {
          dropdown.addOption(room.id, room.name);
        }
      }
      dropdown.setValue(this.roomId).onChange((value) => (this.roomId = value));
    });
    new Setting(parent).setName("Permission").addDropdown((dropdown) =>
      dropdown
        .addOption("reader", "Reader")
        .addOption("editor", "Editor")
        .setValue(this.roomPreset)
        .onChange((value) => (this.roomPreset = value as "reader" | "editor"))
    );
  }

  private renderTeamFields(parent: HTMLElement): void {
    const teams = this.manageableTeams();
    new Setting(parent).setName("Team").addDropdown((dropdown) => {
      if (teams.length === 0) {
        dropdown.addOption("", "No manageable teams");
      } else {
        for (const team of teams) {
          dropdown.addOption(team.id, team.name);
        }
      }
      dropdown.setValue(this.teamId).onChange((value) => (this.teamId = value));
    });
    new Setting(parent).setName("Role").addDropdown((dropdown) =>
      dropdown
        .addOption("member", "Member")
        .addOption("admin", "Admin")
        .setValue(this.teamRole)
        .onChange((value) => (this.teamRole = value as "member" | "admin"))
    );
  }

  private async submit(): Promise<void> {
    if (this.inviteType === "room") {
      if (!this.roomId) {
        throw new Error("You do not manage any rooms on this server.");
      }
      await this.plugin.createRoomInvite(this.roomId, this.roomPreset);
      return;
    }
    if (this.inviteType === "team") {
      if (!this.teamId) {
        throw new Error("You do not manage any teams on this server.");
      }
      await this.plugin.createInvite(this.teamId, this.teamRole);
      return;
    }
    if (!this.plugin.getActiveServer()?.isServerOwner) {
      throw new Error("Only the server owner can create friend invites.");
    }
    await this.plugin.createFriendInvite();
  }

  private manageableRooms() {
    return this.plugin.visibleRooms.filter((room) => this.plugin.canManageRoom(room));
  }

  private manageableTeams() {
    return this.plugin.teams.filter((team) => this.plugin.canManageTeam(team));
  }

  private availableInviteTypes(): InviteType[] {
    return [
      ...(this.manageableRooms().length > 0 ? (["room"] as const) : []),
      ...(this.manageableTeams().length > 0 ? (["team"] as const) : []),
      ...(this.plugin.getActiveServer()?.isServerOwner ? (["friend"] as const) : [])
    ];
  }
}
