import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
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
      await Promise.all([this.plugin.refreshRooms({ notify: false }), this.plugin.refreshTeamMembers({ notify: false })]).catch((error) => {
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
      text: server ? `${server.teamName} / ${server.userDisplayName} / ${server.status}` : "No team connected yet"
    });

    this.renderServerSection(container);
    this.renderTeamSection(container);

    if (!server) {
      container.createDiv({ cls: "vault-rooms-empty", text: "Set up or join a team above to load rooms." });
      return;
    }

    this.renderMembers(container);
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
      card.createEl("div", { cls: "vault-rooms-room-meta", text: `This device: ${status.localUrl}` });
      if (status.lanUrl) {
        const lanRow = card.createDiv({ cls: "vault-rooms-lan-row" });
        lanRow.createEl("div", { cls: "vault-rooms-room-meta", text: `LAN (share this): ${status.lanUrl}` });
        this.addPanelButton(lanRow, "Copy LAN URL", async () => {
          await navigator.clipboard.writeText(status.lanUrl ?? "");
          new Notice("LAN URL copied.");
        });
      } else {
        card.createEl("div", {
          cls: "vault-rooms-room-meta",
          text: "Only this device can connect. Enable LAN access in Settings → Vault Rooms to invite teammates."
        });
      }
    } else if (!status.running && status.error) {
      card.createEl("div", { cls: "vault-rooms-error", text: status.error });
    } else {
      card.createEl("div", { cls: "vault-rooms-room-meta", text: "Not running. Start it to set up or join a team." });
    }

    const actions = section.createDiv({ cls: "vault-rooms-actions" });
    if (status.running) {
      this.addPanelButton(actions, "Stop Server", () => this.plugin.stopEmbeddedServer());
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

  private renderTeamSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "vault-rooms-section" });
    section.createEl("h3", { text: "Team" });

    const serverRunning = this.plugin.getServerStatus().running;
    const actions = section.createDiv({ cls: "vault-rooms-actions" });
    this.addPanelButton(actions, "Set Up Team", () => this.plugin.openSetupTeamModal(), true);
    this.addPanelButton(actions, "Join Team", () => this.plugin.openJoinTeamModal());

    if (this.plugin.settings.servers.length === 0) {
      section.createDiv({
        cls: "vault-rooms-empty",
        text: serverRunning ? "No teams yet. Set up a team on this server, or join one via an invite link." : "Start the server above, then set up or join a team."
      });
      return;
    }

    const active = this.plugin.getActiveServer();
    const list = section.createDiv({ cls: "vault-rooms-team-list" });
    for (const server of this.plugin.settings.servers) {
      const item = list.createDiv({ cls: server.id === active?.id ? "vault-rooms-team is-active" : "vault-rooms-team" });
      const title = item.createDiv({ cls: "vault-rooms-team-title" });
      title.createEl("strong", { text: server.teamName });
      title.createEl("span", { text: server.id === active?.id ? "active" : server.status });
      item.createEl("div", { cls: "vault-rooms-room-meta", text: `${server.userDisplayName} / ${server.baseUrl}` });
      const rowActions = item.createDiv({ cls: "vault-rooms-room-actions" });
      const useButton = this.addPanelButton(rowActions, "Use", () => this.plugin.activateServer(server.id));
      useButton.disabled = server.id === active?.id;
      this.addPanelButton(rowActions, "Test", () => this.plugin.testConnection(server.baseUrl));
    }
  }

  private renderMembers(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "vault-rooms-section" });
    section.createEl("h3", { text: "Team Members" });
    const actions = section.createDiv({ cls: "vault-rooms-actions" });
    this.addPanelButton(actions, "Invite Member", () => this.plugin.createInvite("member"));
    this.addPanelButton(actions, "Invite Admin", () => this.plugin.createInvite("admin"));
    const server = this.plugin.getActiveServer();
    const list = section.createDiv({ cls: "vault-rooms-member-list" });
    if (this.plugin.teamMembers.length === 0) {
      list.createDiv({ cls: "vault-rooms-empty", text: "No members loaded." });
      return;
    }
    for (const member of this.plugin.teamMembers) {
      const item = list.createDiv({ cls: member.revokedAt ? "vault-rooms-member is-revoked" : "vault-rooms-member" });
      item.createEl("strong", { text: member.displayName });
      item.createSpan({ text: ` ${member.role}${member.revokedAt ? " / revoked" : ""}` });
      const rowActions = item.createDiv({ cls: "vault-rooms-room-actions" });
      const revoke = this.addPanelButton(rowActions, "Revoke", () => this.plugin.revokeTeamMember(member.userId));
      revoke.disabled = member.userId === server?.userId || member.role === "owner" || Boolean(member.revokedAt);
    }
  }

  private renderRoomsSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "vault-rooms-section" });
    section.createEl("h3", { text: "Rooms" });
    const actions = section.createDiv({ cls: "vault-rooms-actions" });
    this.addPanelButton(actions, "Create Room", () => this.plugin.openCreateRoomModal());
    this.addPanelButton(actions, "Refresh", async () => {
      await Promise.all([this.plugin.refreshRooms(), this.plugin.refreshTeamMembers()]);
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
