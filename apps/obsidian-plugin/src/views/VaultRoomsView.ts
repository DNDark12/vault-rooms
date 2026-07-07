import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type { TeamSummary } from "../apiClient.js";
import type VaultRoomsPlugin from "../main.js";

export const VAULT_ROOMS_VIEW_TYPE = "vault-rooms-view";

export class VaultRoomsView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: VaultRoomsPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VAULT_ROOMS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Vault Rooms";
  }

  getIcon(): string {
    return "box";
  }

  async onOpen(): Promise<void> {
    if (this.plugin.getActiveServer()) {
      await Promise.all([this.plugin.refreshRooms({ notify: false }), this.plugin.refreshTeams({ notify: false })]).catch((error) => {
        new Notice(error instanceof Error ? error.message : "Failed to load rooms");
      });
    }
    this.render();
  }

  render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("vault-rooms-view");

    const header = container.createDiv({ cls: "vault-rooms-header" });
    header.createEl("h2", { text: "Vault Rooms" });
    const server = this.plugin.getActiveServer();
    header.createEl("div", {
      cls: "vault-rooms-status",
      text: server ? `${server.userDisplayName} / ${server.baseUrl} / ${server.status}` : "No server connected yet"
    });

    this.renderServerSection(container);
    this.renderConnectionSection(container);

    if (!server) {
      container.createDiv({ cls: "vault-rooms-empty", text: "Set up or join a server above to load teams and rooms." });
      return;
    }

    this.renderFriendsSection(container);
    this.renderTeamsSection(container);
    this.renderRoomsSection(container);
  }

  private renderServerSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "vault-rooms-section" });
    section.createEl("h3", { text: "Server" });

    const status = this.plugin.getServerStatus();
    const card = section.createDiv({ cls: "vault-rooms-server-card" });
    const badgeRow = card.createDiv({ cls: "vault-rooms-badge-row" });
    badgeRow.createSpan({ cls: status.running ? "vault-rooms-badge is-running" : "vault-rooms-badge is-stopped", text: status.running ? "Running" : "Stopped" });

    if (status.running) {
      if (status.lanUrl) {
        const lanRow = card.createDiv({ cls: "vault-rooms-lan-row" });
        lanRow.createEl("div", { cls: "vault-rooms-room-meta", text: `LAN (share this): ${status.lanUrl}` });
        this.addPanelButton(lanRow, "Copy LAN URL", async () => {
          await navigator.clipboard.writeText(status.lanUrl ?? "");
          new Notice("LAN URL copied.");
        });
      } else {
        card.createEl("div", {
          cls: "vault-rooms-error",
          text: "Could not auto-detect this device's LAN IP - invite links would point at 127.0.0.1 and won't work for teammates. Set a Public URL override in Settings → Vault Rooms → Relay server, then restart the server."
        });
      }
    } else if (!status.running && status.error) {
      card.createEl("div", { cls: "vault-rooms-error", text: status.error });
    } else {
      card.createEl("div", { cls: "vault-rooms-room-meta", text: "Not running. Start it to set up or join a server." });
    }

    const actions = section.createDiv({ cls: "vault-rooms-actions" });
    if (status.running) {
      this.addPanelButton(actions, "Stop server", () => this.plugin.stopEmbeddedServer());
    } else {
      this.addPanelButton(
        actions,
        "Start Server",
        async () => {
          await this.plugin.startEmbeddedServer();
        },
        true
      );
    }
  }

  private renderConnectionSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "vault-rooms-section" });
    section.createEl("h3", { text: "Connection" });

    if (this.plugin.getActiveServer()) {
      const syncState = this.plugin.getSyncState();
      const badgeRow = section.createDiv({ cls: "vault-rooms-badge-row" });
      const label = syncState === "connected" ? "Live sync: connected" : syncState === "connecting" ? "Live sync: reconnecting…" : "Live sync: offline";
      const cls = syncState === "connected" ? "is-running" : syncState === "connecting" ? "is-connecting" : "is-stopped";
      badgeRow.createSpan({ cls: `vault-rooms-badge ${cls}`, text: label });
    }

    const serverRunning = this.plugin.getServerStatus().running;
    const actions = section.createDiv({ cls: "vault-rooms-actions" });
    this.addPanelButton(actions, "Set up server", () => this.plugin.openSetupServerModal(), true);
    this.addPanelButton(actions, "Join server", () => this.plugin.openJoinTeamModal());

    if (this.plugin.settings.servers.length === 0) {
      section.createDiv({
        cls: "vault-rooms-empty",
        text: serverRunning ? "Not connected yet. Set up a server, or join one via an invite link." : "Start the server above, then set up or join one."
      });
      return;
    }

    const active = this.plugin.getActiveServer();
    const list = section.createDiv({ cls: "vault-rooms-team-list" });
    for (const server of this.plugin.settings.servers) {
      const item = list.createDiv({ cls: server.id === active?.id ? "vault-rooms-team is-active" : "vault-rooms-team" });
      const title = item.createDiv({ cls: "vault-rooms-team-title" });
      title.createEl("strong", { text: server.baseUrl });
      title.createEl("span", { text: server.id === active?.id ? "active" : server.status });
      item.createEl("div", { cls: "vault-rooms-room-meta", text: `${server.userDisplayName}${server.isServerOwner ? " (owner)" : ""}` });
      const rowActions = item.createDiv({ cls: "vault-rooms-room-actions" });
      const useButton = this.addPanelButton(rowActions, "Use", () => this.plugin.activateServer(server.id));
      useButton.disabled = server.id === active?.id;
      this.addPanelButton(rowActions, "Test", () => this.plugin.testConnection(server.baseUrl));
    }
  }

  private renderFriendsSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "vault-rooms-section" });
    section.createEl("h3", { text: "Friends" });

    const server = this.plugin.getActiveServer();
    const list = section.createDiv({ cls: "vault-rooms-friend-list" });
    // "Friends" means everyone else on this server - showing your own account here just adds
    // noise (and there's nothing to do with it: you can't revoke yourself).
    const others = this.plugin.friends.filter((friend) => friend.id !== server?.userId);
    if (others.length === 0) {
      list.createDiv({ cls: "vault-rooms-empty", text: "No friends yet - share an invite link to add one." });
      return;
    }
    for (const friend of others) {
      const item = list.createDiv({ cls: friend.revokedAt ? "vault-rooms-friend is-revoked" : "vault-rooms-friend" });
      item.createEl("strong", { text: friend.displayName });
      item.createSpan({ text: friend.revokedAt ? " / revoked" : "" });
      if (server?.isServerOwner) {
        const rowActions = item.createDiv({ cls: "vault-rooms-room-actions" });
        const revoke = this.addPanelButton(rowActions, "Revoke", () => this.plugin.revokeFriend(friend.id));
        revoke.disabled = Boolean(friend.revokedAt);
      }
    }
  }

  private renderTeamsSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "vault-rooms-section" });
    section.createEl("h3", { text: "Teams" });

    const server = this.plugin.getActiveServer();
    if (server?.isServerOwner) {
      const actions = section.createDiv({ cls: "vault-rooms-actions" });
      let newTeamName = "";
      const nameInput = actions.createEl("input", { type: "text", attr: { placeholder: "New team name" } });
      nameInput.oninput = () => (newTeamName = nameInput.value.trim());
      this.addPanelButton(actions, "Create team", async () => {
        if (!newTeamName) {
          new Notice("Team name is required.");
          return;
        }
        await this.plugin.createTeam(newTeamName);
        this.render();
      });
    }

    if (this.plugin.teams.length === 0) {
      section.createDiv({ cls: "vault-rooms-empty", text: "No teams yet." });
      return;
    }

    const list = section.createDiv({ cls: "vault-rooms-team-card-list" });
    for (const team of this.plugin.teams) {
      this.renderTeamCard(list, team);
    }
  }

  private renderTeamCard(parent: HTMLElement, team: TeamSummary): void {
    const canManage = this.plugin.canManageTeam(team);
    const canDelete = this.plugin.canDeleteTeam(team);
    const members = this.plugin.teamMembersByTeam[team.id];

    const card = parent.createDiv({ cls: "vault-rooms-team-card" });
    const title = card.createDiv({ cls: "vault-rooms-team-title" });
    title.createEl("strong", { text: team.name });
    const role = this.plugin.myTeamRoles[team.id];
    if (role) {
      title.createEl("span", { text: role });
    }

    const memberList = card.createDiv({ cls: "vault-rooms-team-member-list" });
    if (!members) {
      memberList.createDiv({ cls: "vault-rooms-empty", text: "You are not a member of this team." });
    } else if (members.length === 0) {
      memberList.createDiv({ cls: "vault-rooms-empty", text: "No members." });
    } else {
      for (const member of members) {
        const item = memberList.createDiv({ cls: member.revokedAt ? "vault-rooms-team-member is-revoked" : "vault-rooms-team-member" });
        item.createEl("strong", { text: member.displayName });
        item.createSpan({ text: ` ${member.role}${member.revokedAt ? " / revoked" : ""}` });
        if (canManage) {
          const rowActions = item.createDiv({ cls: "vault-rooms-room-actions" });
          const remove = this.addPanelButton(rowActions, "Remove", () => this.plugin.removeTeamMember(team.id, member.userId));
          remove.disabled = Boolean(member.revokedAt);
        }
      }
    }

    const cardActions = card.createDiv({ cls: "vault-rooms-room-actions" });
    if (canManage) {
      const candidateFriends = this.plugin.friends.filter((friend) => !friend.revokedAt && !members?.some((member) => member.userId === friend.id));
      if (candidateFriends.length > 0) {
        const addFriendRow = card.createDiv({ cls: "vault-rooms-add-friend-row" });
        const select = addFriendRow.createEl("select");
        for (const friend of candidateFriends) {
          select.createEl("option", { text: friend.displayName, value: friend.id });
        }
        this.addPanelButton(addFriendRow, "Add friend", async () => {
          if (!select.value) {
            return;
          }
          await this.plugin.addFriendToTeam(team.id, select.value);
          this.render();
        });
      }
      this.addPanelButton(cardActions, "Invite link", () => this.plugin.createInvite(team.id));
    }
    if (canDelete) {
      const deleteButton = this.addPanelButton(cardActions, "Delete team", () => this.deleteTeamWithConfirm(team));
      deleteButton.addClass("mod-warning");
    }
  }

  private async deleteTeamWithConfirm(team: TeamSummary): Promise<void> {
    if (!window.confirm(`Delete team "${team.name}"? This removes its members, invites, and room access grants for everyone. Rooms are not deleted. This cannot be undone.`)) {
      return;
    }
    await this.plugin.deleteTeam(team.id);
    this.render();
  }

  private renderRoomsSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "vault-rooms-section" });
    section.createEl("h3", { text: "Rooms" });
    const actions = section.createDiv({ cls: "vault-rooms-actions" });
    this.addPanelButton(actions, "Create room", () => this.plugin.openCreateRoomModal());
    this.addPanelButton(actions, "Refresh", async () => {
      await Promise.all([this.plugin.refreshRooms(), this.plugin.refreshTeams()]);
    });

    if (this.plugin.visibleRooms.length === 0) {
      section.createDiv({ cls: "vault-rooms-empty", text: "No rooms loaded." });
      return;
    }

    for (const room of this.plugin.visibleRooms) {
      const item = section.createDiv({ cls: "vault-rooms-room" });
      const title = item.createDiv({ cls: "vault-rooms-room-title" });
      title.createEl("strong", { text: room.name });
      title.createEl("span", { text: room.type });
      item.createEl("div", { cls: "vault-rooms-room-meta", text: `Folder: ${room.mountName}` });
      item.createEl("div", { cls: "vault-rooms-room-meta", text: `Source: ${room.sourcePath}` });
      item.createEl("div", { cls: "vault-rooms-room-meta", text: `Permissions: ${room.permissions.join(", ") || "none"}` });
      item.createEl("div", {
        cls: "vault-rooms-room-meta",
        text: `Capabilities: ${room.capabilities.map((cap) => `${cap.displayName}: ${cap.installed ? "installed" : "missing"}`).join(", ") || "none"}`
      });
      const mounted = this.plugin.isRoomMounted(room.id);
      item.createEl("div", {
        cls: mounted ? "vault-rooms-mounted" : "vault-rooms-unmounted",
        text: mounted ? `Mounted: ${this.plugin.mountedPathFor(room.id) ?? room.mountName}` : "Not mounted"
      });
      const roomActions = item.createDiv({ cls: "vault-rooms-room-actions" });
      this.addPanelButton(roomActions, "Settings", () => this.plugin.openRoomSettingsModal(room));
      this.addPanelButton(
        roomActions,
        mounted ? "Unmount" : "Mount",
        async () => {
          if (mounted) {
            await this.plugin.unmountRoom(room.id);
          } else {
            await this.plugin.mountRoom(room);
          }
          this.render();
        },
        !mounted
      );
      if (mounted) {
        this.renderRoomConflicts(item, room.id);
      }
    }
  }

  private renderRoomConflicts(parent: HTMLElement, roomId: string): void {
    const conflicts = this.plugin.listRoomConflicts(roomId);
    if (conflicts.length === 0) {
      return;
    }
    const section = parent.createDiv({ cls: "vault-rooms-conflict-list" });
    section.createEl("div", {
      cls: "vault-rooms-error",
      text: `${conflicts.length} unresolved conflict${conflicts.length > 1 ? "s" : ""} - a teammate's edit and yours landed at the same time:`
    });
    for (const conflict of conflicts) {
      const row = section.createDiv({ cls: "vault-rooms-conflict-row" });
      row.createEl("div", { cls: "vault-rooms-room-meta", text: conflict.relativePath });
      const rowActions = row.createDiv({ cls: "vault-rooms-room-actions" });
      this.addPanelButton(rowActions, "Keep mine", async () => {
        await this.plugin.resolveRoomConflict(roomId, conflict.relativePath, conflict.conflictRelativePath, "mine");
        this.render();
      });
      this.addPanelButton(rowActions, "Keep synced version", async () => {
        await this.plugin.resolveRoomConflict(roomId, conflict.relativePath, conflict.conflictRelativePath, "theirs");
        this.render();
      });
    }
  }

  private addPanelButton(parent: HTMLElement, label: string, action: () => Promise<void> | void, cta = false): HTMLButtonElement {
    const button = parent.createEl("button", { text: label });
    if (cta) {
      button.addClass("mod-cta");
    }
    button.onClickEvent(async () => {
      button.disabled = true;
      try {
        await action();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "Vault Rooms action failed");
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }
}
