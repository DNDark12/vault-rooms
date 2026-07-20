import { ItemView, Notice, Setting, WorkspaceLeaf } from "obsidian";
import type { AuditEventSummary, TeamSummary } from "../apiClient.js";
import { pinnedInfoForServer } from "../controllers/ServerConnectionManager.js";
import { lanSharePresentation } from "../lanShareReachability.js";
import type VaultRoomsPlugin from "../main.js";
import { confirmModal } from "../modals/ConfirmModal.js";
import { ConnectionDiagnosticsModal } from "../modals/ConnectionDiagnosticsModal.js";

export const VAULT_ROOMS_VIEW_TYPE = "vault-rooms-view";

export class VaultRoomsView extends ItemView {
  /** Which collapsible sections are currently collapsed, by key. Not persisted to disk - it's a
   *  transient display preference, not data, so it resets (all expanded) when the view is closed
   *  and reopened or Obsidian restarts; that's an acceptable, simple default. */
  private collapsedSections = new Set<string>();

  /** Loaded audit page(s), or null when nothing has been fetched yet. Transient like
   *  collapsedSections: audit data is a point-in-time snapshot the user explicitly (re)loads, not
   *  live state, so it resets when the view closes. */
  private auditEvents: AuditEventSummary[] | null = null;
  private auditHasMore = false;
  /** Team filter for non-owner viewers (a team admin can only read their own team's log). */
  private auditTeamId: string | undefined;
  /** Which server the cached audit page belongs to - switching the active connection must drop the
   *  cache, or the previous server's events would render under the new one's heading. */
  private auditServerId: string | undefined;

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
    if (this.plugin.getActiveServer() && !this.plugin.activeServerIsOwnStoppedServer()) {
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
    const headerSetting = new Setting(header).setName("Vault Rooms").setHeading();
    if (this.plugin.canCreateAnyInvite()) {
      headerSetting.addButton((button) => button.setCta().setButtonText("Invite").onClick(() => this.plugin.openCreateInviteModal()));
    }

    this.renderHostingSection(container);
    this.renderActiveConnectionSection(container);
    this.renderOtherServersSection(container);

    const server = this.plugin.getActiveServer();
    if (!server) {
      container.createDiv({ cls: "vault-rooms-empty", text: "Set up or join a server above to load teams and rooms." });
      return;
    }
    if (server.securityState === "pin_mismatch") {
      container.createDiv({
        cls: "vault-rooms-error",
        text: "Sync is blocked because this server presented an unverified identity. Compare the saved and presented fingerprints with the server owner; there is no trust-anyway bypass."
      });
    }

    this.renderFriendsSection(container);
    this.renderTeamsSection(container);
    this.renderRoomsSection(container);
    this.renderAuditSection(container);
  }

  /** A collapsible block: a clickable header (title + optional count badge + chevron) that toggles
   *  whether renderBody() runs. Collapse state is keyed and remembered across re-renders (but not
   *  across closing/reopening the view - see the collapsedSections field doc comment). Use this for
   *  anything that can grow long (lists of friends/teams/rooms/servers); leave short, always-useful
   *  controls (hosting toggle, current connection status) as plain, non-collapsible sections so
   *  they're never accidentally hidden. */
  private renderCollapsibleSection(parent: HTMLElement, key: string, title: string, count: number | undefined, renderBody: (body: HTMLElement) => void): void {
    const section = parent.createDiv({ cls: "vault-rooms-section" });
    const collapsed = this.collapsedSections.has(key);
    const headerEl = section.createDiv({ cls: "vault-rooms-section-header" });
    // Not a Setting().setHeading() here: this heading shares one clickable flex row with the count
    // badge and chevron below (the whole row toggles collapse), which the Setting heading API's
    // full `.setting-item` row doesn't fit - see vault-rooms-section-title in styles.css for the
    // heading-equivalent look this preserves instead.
    headerEl.createDiv({ cls: "vault-rooms-section-title", text: title });
    if (count !== undefined) {
      headerEl.createSpan({ cls: "vault-rooms-section-count", text: String(count) });
    }
    headerEl.createSpan({ cls: "vault-rooms-section-chevron", text: collapsed ? "▸" : "▾" });
    headerEl.onClickEvent(() => {
      if (collapsed) {
        this.collapsedSections.delete(key);
      } else {
        this.collapsedSections.add(key);
      }
      this.render();
    });
    if (!collapsed) {
      renderBody(section.createDiv({ cls: "vault-rooms-section-body" }));
    }
  }

  /** Whether this device hosts a relay server at all - orthogonal to which server this device is
   *  currently *using* as a client (see renderActiveConnectionSection): a host is also a client of
   *  its own server, and a joining member never sees this section do anything but sit stopped. */
  private renderHostingSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "vault-rooms-section" });
    new Setting(section).setName("This device's server").setHeading();

    const status = this.plugin.getServerStatus();
    const card = section.createDiv({ cls: "vault-rooms-server-card" });
    const badgeRow = card.createDiv({ cls: "vault-rooms-badge-row" });
    badgeRow.createSpan({ cls: status.running ? "vault-rooms-badge is-running" : "vault-rooms-badge is-stopped", text: status.running ? "Running" : "Stopped" });

    if (status.running) {
      if (status.legacyV01BackupAvailable) {
        card.createDiv({
          cls: "vault-rooms-error",
          text: "A v0.1 database archived by an earlier upgrade build is available. Restore it to recover the original users, teams, rooms, files, and history."
        });
      }
      if (status.lanUrl) {
        const lanRow = card.createDiv({ cls: "vault-rooms-lan-row" });
        lanRow.createDiv({ cls: "vault-rooms-room-meta", text: `LAN (share this): ${status.lanUrl}` });
        const lanInput = lanRow.createEl("input", { value: status.lanUrl });
        lanInput.readOnly = true;
        const reachability = this.plugin.getLanShareReachability();
        const presentation = lanSharePresentation(reachability);
        if (presentation) {
          const lanBadgeRow = card.createDiv({ cls: "vault-rooms-badge-row" });
          lanBadgeRow.createSpan({
            cls: `vault-rooms-badge ${presentation.className}`,
            text: presentation.label
          });
        }
        if (reachability.status === "unreachable") {
          card.createDiv({
            cls: "vault-rooms-error",
            text: `This device cannot reach the configured LAN share URL (${reachability.error}). Update Public URL override, then restart the server to check the LAN URL again.`
          });
        }
        card.createDiv({
          cls: "vault-rooms-room-meta",
          text: "This host-side check does not guarantee that a teammate's firewall or Wi-Fi client isolation will allow the connection."
        });
      } else {
        card.createDiv({
          cls: "vault-rooms-error",
          text: "Invite links would point at 127.0.0.1 and won't work for teammates. Set a Public URL override in Settings → Vault Rooms → Relay server, then restart the server."
        });
      }
    } else if (!status.running && status.error) {
      card.createDiv({ cls: "vault-rooms-error", text: status.error });
    } else {
      card.createDiv({ cls: "vault-rooms-room-meta", text: "Not running. Only start this if you want to host a room for others - joining someone else's server doesn't need it." });
    }

    const actions = section.createDiv({ cls: "vault-rooms-actions" });
    if (status.running) {
      this.addPanelButton(actions, "Stop server", () => this.plugin.stopEmbeddedServer());
      if (status.legacyV01BackupAvailable) {
        this.addPanelButton(actions, "Restore v0.1 data", () => this.plugin.restoreLegacyV01Data(), true);
      }
    } else {
      this.addPanelButton(actions, "Start server", async () => {
        await this.plugin.startEmbeddedServer();
      });
    }
  }

  /** The one server this device is currently using as a client (whether that's its own hosted
   *  server or someone else's) - always visible, never collapsed, since "am I actually synced right
   *  now" is exactly the kind of thing you glance at, not something to hide behind a click. Only
   *  this server's mounted rooms are live: see "Other servers" below for what that means. */
  private renderActiveConnectionSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "vault-rooms-section" });
    new Setting(section).setName("Active connection").setHeading();

    const server = this.plugin.getActiveServer();
    const hasOwnServer = this.plugin.hasOwnServer();
    const serverStatus = this.plugin.getServerStatus();
    const needsOwnerRecovery = !hasOwnServer && serverStatus.running && serverStatus.bootstrapped;
    if (!server) {
      section.createDiv({
        cls: "vault-rooms-empty",
        text: this.plugin.settings.servers.length > 0 ? "No server selected - pick one under \"Other servers\" below, or join/set up a new one." : "Not connected to any server yet."
      });
      const actions = section.createDiv({ cls: "vault-rooms-actions" });
      // "Set up server" only ever makes sense once, ever, per device - see hasOwnServer()'s doc
      // comment. Hide it afterwards instead of leaving it there to fail with a confusing "already
      // bootstrapped" error; "Join" has no such limit; you can join as many other people's servers
      // as you like.
      if (!hasOwnServer) {
        this.addPanelButton(actions, needsOwnerRecovery ? "Recover server access" : "Set up server", () => this.plugin.openSetupServerModal(), true);
      }
      // Join becomes the primary (CTA) action once Set up is no longer offered.
      this.addPanelButton(actions, "Join server", () => this.plugin.openJoinTeamModal(), hasOwnServer);
      return;
    }

    const card = section.createDiv({ cls: "vault-rooms-server-card" });
    card.createDiv({ text: `${server.baseUrl} - ${server.userDisplayName}${server.isServerOwner ? " (owner)" : ""}` });
    if (this.plugin.activeServerIsOwnEmbeddedServer()) {
      card.createDiv({ cls: "vault-rooms-room-meta", text: "Local owner connection" });
    }
    const badgeRow = card.createDiv({ cls: "vault-rooms-badge-row" });
    if (this.plugin.activeServerIsOwnStoppedServer()) {
      badgeRow.createSpan({ cls: "vault-rooms-badge is-stopped", text: "Live sync: server stopped" });
      card.createDiv({
        cls: "vault-rooms-room-meta",
        text: "Start this device's server above (\"This device's server\"), or enable \"Start automatically\" in Settings → Vault Rooms → Relay server."
      });
    } else {
      const syncState = this.plugin.getSyncState();
      const label = syncState === "connected" ? "Live sync: connected" : syncState === "connecting" ? "Live sync: reconnecting…" : "Live sync: offline";
      const cls = syncState === "connected" ? "is-running" : syncState === "connecting" ? "is-connecting" : "is-stopped";
      badgeRow.createSpan({ cls: `vault-rooms-badge ${cls}`, text: label });
    }

    // Only "Join another server" belongs here: a person can legitimately be a client of many
    // servers (each teammate's own), but can only ever own one hosted server on this device (see
    // hasOwnServer()) - there is no such thing as "another" server to set up on top of that one, so
    // once this device already hosts a server, that action simply stops being offered anywhere.
    if (!hasOwnServer) {
      return;
    }
    const actions = section.createDiv({ cls: "vault-rooms-actions" });
    this.addPanelButton(actions, "Join another server", () => this.plugin.openJoinTeamModal());
  }

  /**
   * Every *other* saved server (logins this device remembers but isn't currently using) - a plain
   * list, not an action menu. "Set up/Join another server" already lives in Active connection
   * above regardless of whether anything is saved here yet, so this section only ever needs to
   * render when there's something to actually list.
   *
   * Only one server is ever live at a time: switching (or setting up/joining another) makes that
   * one active instead. Rooms mounted under a server that isn't active are simply paused - their
   * local files stay put and nothing is lost, but neither pushes nor live updates happen until you
   * switch back to that server (see the note under Rooms below). There's no background multi-server
   * sync; this is a deliberate simplification, not a bug you're missing a setting for.
   */
  private renderOtherServersSection(parent: HTMLElement): void {
    const active = this.plugin.getActiveServer();
    const others = this.plugin.settings.servers.filter((server) => server.id !== active?.id);
    if (others.length === 0) {
      return;
    }

    this.renderCollapsibleSection(parent, "other-servers", "Other servers", others.length, (body) => {
      body.createEl("p", {
        cls: "vault-rooms-setting-hint",
        text: "Only the active connection above syncs live. Switching here pauses sync for rooms mounted under the server you're leaving, and resumes it for rooms under this one."
      });
      const list = body.createDiv({ cls: "vault-rooms-team-list" });
      for (const server of others) {
        const item = list.createDiv({ cls: "vault-rooms-team" });
        const title = item.createDiv({ cls: "vault-rooms-team-title" });
        title.createEl("strong", { text: server.baseUrl });
        title.createSpan({ text: server.status });
        item.createDiv({ cls: "vault-rooms-room-meta", text: `${server.userDisplayName}${server.isServerOwner ? " (owner)" : ""}` });
        const rowActions = item.createDiv({ cls: "vault-rooms-room-actions" });
        this.addPanelButton(rowActions, "Use", () => this.plugin.activateServer(server.id));
        this.addPanelButton(rowActions, "Test", () => {
          new ConnectionDiagnosticsModal(this.plugin, server.baseUrl, () =>
            this.plugin.diagnoseConnection(server.baseUrl, pinnedInfoForServer(server), server.deviceToken)
          ).open();
        });
      }
    });
  }

  private renderFriendsSection(parent: HTMLElement): void {
    const server = this.plugin.getActiveServer();
    // "Friends" means everyone else on this server - showing your own account here just adds
    // noise (and there's nothing to do with it: you can't revoke yourself).
    const others = this.plugin.friends.filter((friend) => friend.id !== server?.userId);

    this.renderCollapsibleSection(parent, "friends", "Friends", others.length, (body) => {
      const list = body.createDiv({ cls: "vault-rooms-friend-list" });
      if (others.length === 0) {
        list.createDiv({
          cls: "vault-rooms-empty",
          text: this.plugin.activeServerIsOwnStoppedServer() ? "This device's server is stopped - start it above to load friends." : "No friends yet - share an invite link to add one."
        });
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
    });
  }

  private renderTeamsSection(parent: HTMLElement): void {
    const server = this.plugin.getActiveServer();

    this.renderCollapsibleSection(parent, "teams", "Teams", this.plugin.teams.length, (body) => {
      if (server?.isServerOwner) {
        const actions = body.createDiv({ cls: "vault-rooms-actions" });
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
        body.createDiv({
          cls: "vault-rooms-empty",
          text: this.plugin.activeServerIsOwnStoppedServer() ? "This device's server is stopped - start it above to load teams." : "No teams yet."
        });
        return;
      }

      const list = body.createDiv({ cls: "vault-rooms-team-card-list" });
      for (const team of this.plugin.teams) {
        this.renderTeamCard(list, team);
      }
    });
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
      title.createSpan({ text: role });
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
    }
    if (canDelete) {
      const deleteButton = this.addPanelButton(cardActions, "Delete team", () => this.deleteTeamWithConfirm(team));
      deleteButton.addClass("mod-warning");
    }
  }

  private async deleteTeamWithConfirm(team: TeamSummary): Promise<void> {
    if (!(await confirmModal(this.app, "Delete team", `Delete team "${team.name}"? This removes its members, invites, and room access grants for everyone. Rooms are not deleted. This cannot be undone.`, "Delete team"))) {
      return;
    }
    await this.plugin.deleteTeam(team.id);
    this.render();
  }

  private renderRoomsSection(parent: HTMLElement): void {
    this.renderCollapsibleSection(parent, "rooms", "Rooms", this.plugin.visibleRooms.length, (body) => {
      const actions = body.createDiv({ cls: "vault-rooms-actions" });
      this.addPanelButton(actions, "Create room", () => this.plugin.openCreateRoomModal());
      this.addPanelButton(actions, "Refresh", async () => {
        await Promise.all([this.plugin.refreshRooms(), this.plugin.refreshTeams()]);
      });

      if (this.plugin.visibleRooms.length === 0) {
        body.createDiv({
          cls: "vault-rooms-empty",
          text: this.plugin.activeServerIsOwnStoppedServer() ? "This device's server is stopped - start it above to load rooms." : "No rooms loaded."
        });
        return;
      }

      const activeServerId = this.plugin.getActiveServer()?.id;
      for (const room of this.plugin.visibleRooms) {
        const item = body.createDiv({ cls: "vault-rooms-room" });
        const title = item.createDiv({ cls: "vault-rooms-room-title" });
        title.createEl("strong", { text: room.name });
        title.createSpan({ text: room.type });
        item.createDiv({ cls: "vault-rooms-room-meta", text: `Folder: ${room.mountName}` });
        item.createDiv({ cls: "vault-rooms-room-meta", text: `Source: ${room.sourcePath}` });
        item.createDiv({ cls: "vault-rooms-room-meta", text: `Permissions: ${room.permissions.join(", ") || "none"}` });
        item.createDiv({
          cls: "vault-rooms-room-meta",
          text: `Capabilities: ${room.capabilities.map((cap) => `${cap.displayName}: ${cap.installed ? "installed" : "missing"}`).join(", ") || "none"}`
        });
        const mounted = this.plugin.isRoomMounted(room.id);
        item.createDiv({
          cls: mounted ? "vault-rooms-mounted" : "vault-rooms-unmounted",
          text: mounted ? `Mounted: ${this.plugin.mountedPathFor(room.id) ?? room.mountName}` : "Not mounted"
        });
        // Only the active server's rooms actually sync (see "Other servers" above) - a room mounted
        // under a server this device isn't currently using would otherwise look identical to a
        // normally-syncing one, which is exactly the confusing silent-pause this note prevents.
        if (mounted && this.plugin.mountedRoomServerId(room.id) !== undefined && this.plugin.mountedRoomServerId(room.id) !== activeServerId) {
          item.createDiv({
            cls: "vault-rooms-error",
            text: "Not syncing right now - this room was mounted under a different server. Switch to that server (Other servers, above) to resume."
          });
        }
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
    });
  }

  private renderRoomConflicts(parent: HTMLElement, roomId: string): void {
    const conflicts = this.plugin.listRoomConflicts(roomId);
    if (conflicts.length === 0) {
      return;
    }
    const section = parent.createDiv({ cls: "vault-rooms-conflict-list" });
    section.createDiv({
      cls: "vault-rooms-error",
      text: `${conflicts.length} unresolved conflict${conflicts.length > 1 ? "s" : ""} - a teammate's edit and yours landed at the same time:`
    });
    for (const conflict of conflicts) {
      const row = section.createDiv({ cls: "vault-rooms-conflict-row" });
      row.createDiv({ cls: "vault-rooms-room-meta", text: conflict.relativePath });
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

  private static readonly AUDIT_PAGE_SIZE = 50;

  /** Read-only viewer over the server's audit trail (connects/denials/revocations/security state
   *  changes - see repo.audit call sites). Data loads on explicit request, not on every render:
   *  the panel re-renders often (sync state changes, section toggles) and the audit log is a
   *  point-in-time snapshot, not live state worth refetching each time. */
  private renderAuditSection(parent: HTMLElement): void {
    const server = this.plugin.getActiveServer();
    if (!server) {
      return;
    }
    const managedTeams = this.plugin.teams.filter((team) => this.plugin.canManageTeam(team));
    // The server enforces this too (owner or team admin only) - hiding the section here just
    // avoids offering a button that can only ever produce a permission error.
    if (!server.isServerOwner && managedTeams.length === 0) {
      return;
    }
    if (this.auditServerId !== server.id) {
      this.auditServerId = server.id;
      this.auditEvents = null;
      this.auditHasMore = false;
      this.auditTeamId = undefined;
    }

    this.renderCollapsibleSection(parent, "audit", "Audit log", this.auditEvents?.length, (body) => {
      body.createEl("p", {
        cls: "vault-rooms-setting-hint",
        text: server.isServerOwner
          ? "Server-wide activity and security events, newest first."
          : "Activity for teams you manage, newest first."
      });

      const actions = body.createDiv({ cls: "vault-rooms-actions" });
      if (!server.isServerOwner) {
        if (this.auditTeamId === undefined || !managedTeams.some((team) => team.id === this.auditTeamId)) {
          this.auditTeamId = managedTeams[0]?.id;
        }
        if (managedTeams.length > 1) {
          const select = actions.createEl("select");
          for (const team of managedTeams) {
            const option = select.createEl("option", { text: team.name, value: team.id });
            option.selected = team.id === this.auditTeamId;
          }
          select.onchange = () => {
            this.auditTeamId = select.value;
            this.auditEvents = null;
            void this.loadAuditPage(0)
              .then(() => this.render())
              .catch((error) => new Notice(error instanceof Error ? error.message : "Failed to load audit log"));
          };
        }
      }
      this.addPanelButton(actions, this.auditEvents ? "Refresh" : "Load audit log", async () => {
        this.auditEvents = null;
        await this.loadAuditPage(0);
        this.render();
      });

      if (!this.auditEvents) {
        return;
      }
      const list = body.createDiv({ cls: "vault-rooms-team-list" });
      if (this.auditEvents.length === 0) {
        list.createDiv({ cls: "vault-rooms-empty", text: "No audit events yet." });
        return;
      }
      for (const event of this.auditEvents) {
        const row = list.createDiv({ cls: "vault-rooms-team" });
        const title = row.createDiv({ cls: "vault-rooms-team-title" });
        title.createEl("strong", { text: event.action });
        title.createSpan({ text: new Date(event.createdAt).toLocaleString() });
        row.createDiv({
          cls: "vault-rooms-room-meta",
          text: `${event.resourceType} ${event.resourceId} - by ${event.actorType} ${event.actorId}${event.ipAddress ? ` (${event.ipAddress})` : ""}`
        });
        const metadata = JSON.stringify(event.metadata);
        if (metadata && metadata !== "{}") {
          // Hover-only detail: metadata shape varies per action and is occasionally verbose;
          // a tooltip keeps the list scannable without dropping the information.
          row.setAttr("title", metadata);
        }
      }
      if (this.auditHasMore) {
        const moreActions = body.createDiv({ cls: "vault-rooms-actions" });
        this.addPanelButton(moreActions, "Load more", async () => {
          await this.loadAuditPage(this.auditEvents?.length ?? 0);
          this.render();
        });
      }
    });
  }

  private async loadAuditPage(offset: number): Promise<void> {
    const server = this.plugin.getActiveServer();
    const options: { teamId?: string; limit: number; offset: number } = {
      limit: VaultRoomsView.AUDIT_PAGE_SIZE,
      offset
    };
    if (server && !server.isServerOwner && this.auditTeamId !== undefined) {
      options.teamId = this.auditTeamId;
    }
    const page = await this.plugin.listAuditEvents(options);
    // Dedupe by id when appending: the log is append-only newest-first, so events written between
    // two "Load more" clicks shift offsets and re-serve rows the view already has. Re-showing is
    // harmless server-side (nothing is ever hidden), but the list shouldn't render duplicates.
    const existing = offset === 0 ? [] : (this.auditEvents ?? []);
    const seen = new Set(existing.map((event) => event.id));
    this.auditEvents = [...existing, ...page.events.filter((event) => !seen.has(event.id))];
    this.auditHasMore = page.events.length === VaultRoomsView.AUDIT_PAGE_SIZE;
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
