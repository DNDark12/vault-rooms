import { ItemView, Notice, Setting, WorkspaceLeaf, type TFolder } from "obsidian";
import type { AclRuleSummary, AuditEventSummary, RoomSummary, TeamSummary } from "../apiClient.js";
import { pinnedInfoForServer } from "../controllers/ServerConnectionManager.js";
import { userFacingError } from "../errorMessages.js";
import { advertisedAddressDrift } from "../lanAddress.js";
import { lanSharePresentation } from "../lanShareReachability.js";
import type VaultRoomsPlugin from "../main.js";
import { confirmModal } from "../modals/ConfirmModal.js";
import { ConnectionDiagnosticsModal } from "../modals/ConnectionDiagnosticsModal.js";
import { CONNECTION_STATUS_COPY, HOSTING_STATUS_COPY } from "../onboarding.js";
import { activityPresentation } from "./activityPresentation.js";
import { PANEL_COPY } from "./panelCopy.js";
import {
  countPausedLocalRooms,
  panelModel,
  visiblePanelTabs,
  type ActivityAccess,
  type PanelDataState,
  type PanelDescriptor,
  type PanelRoomAction,
  type PanelState,
  type PanelTab
} from "./panelModel.js";
import { peopleModel, type PersonAccessPresentation, type TeamAccessPresentation } from "./peopleModel.js";

export const VAULT_ROOMS_VIEW_TYPE = "vault-rooms-view";


/** Port only - never the host, which is deliberately hidden from members. */
function portOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).port;
  } catch {
    return "";
  }
}

type FileExplorerView = {
  revealInFolder(file: TFolder): Promise<void> | void;
};

export class VaultRoomsView extends ItemView {
  private activeTab: PanelTab = "rooms";
  private dataState: PanelDataState = "current";
  private expandedTeams = new Set<string>();
  private expandedPeople = new Set<string>();
  private teamToolsExpanded = false;
  private roomAclByRoom = new Map<string, AclRuleSummary[]>();
  private connectionDetailsExpanded = false;
  private auditEvents: AuditEventSummary[] | null = null;
  private auditHasMore = false;
  private auditTeamId: string | undefined;
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
    const active = this.plugin.getActiveServer();
    if (!active || this.plugin.activeServerIsOwnStoppedServer()) {
      this.render();
      return;
    }
    this.dataState = "refreshing";
    this.render();
    try {
      await Promise.all([
        this.plugin.refreshRooms({ notify: false }),
        this.plugin.refreshTeams({ notify: false })
      ]);
      await this.loadPeopleAccessData();
      this.dataState = "current";
    } catch (error) {
      this.dataState = "stale-error";
      new Notice(userFacingError(error, "Failed to load Vault Rooms"));
    }
    this.render();
  }

  render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("vault-rooms-view", "vault-rooms-panel-b");

    const descriptor = panelModel(this.buildPanelState());
    const tabs = visiblePanelTabs(descriptor);
    // Switching to a server without audit access while Activity is open would otherwise render a tab
    // that is no longer in the tablist.
    if (!tabs.includes(this.activeTab)) this.activeTab = tabs[0] ?? "rooms";
    this.renderHeader(container, descriptor);
    this.renderTabs(container, descriptor, tabs);

    for (const tab of tabs) {
      const panel = container.createDiv({
        cls: "vault-rooms-tab-panel",
        attr: {
          id: `vault-rooms-panel-${tab}`,
          role: "tabpanel",
          "aria-labelledby": `vault-rooms-tab-${tab}`
        }
      });
      panel.hidden = tab !== this.activeTab;
      if (tab !== this.activeTab) continue;
      if (tab === "rooms") {
        this.renderRooms(panel, descriptor);
      } else if (tab === "people") {
        this.renderPeople(panel);
      } else {
        this.renderActivity(panel);
      }
    }
  }

  private buildPanelState(): PanelState {
    const active = this.plugin.getActiveServer();
    const status = this.plugin.getServerStatus();
    const activeIsOwnEmbedded = this.plugin.activeServerIsOwnEmbeddedServer();
    const roomStates = this.plugin.visibleRooms.map((room) => ({
      id: room.id,
      name: room.name,
      mounted: this.plugin.isRoomMounted(room.id),
      mountedPath: this.plugin.mountedPathFor(room.id),
      mountedServerId: this.plugin.mountedRoomServerId(room.id),
      conflictCount: this.plugin.listRoomConflicts(room.id).length,
      canManage: this.plugin.canManageRoom(room)
    }));
    // Revoked friends/members are history, not work the user can resolve. Keep the tab badge for
    // future actionable items (for example, a pending access request) instead of alarming on records.
    const peopleAttentionItems: string[] = [];
    // Connection and local-host health are rendered in the status disclosure, not Activity.
    // Activity attention must come from visible activity items; none currently require action.
    const activityAttentionItems: string[] = [];
    const localRoomCount = active && !this.plugin.activeServerIsOwnEmbeddedServer()
      ? countPausedLocalRooms(this.plugin.settings.mountedRooms, this.plugin.ownEmbeddedServerId())
      : roomStates.filter((room) => room.mounted).length;

    return {
      activeServer: active
        ? {
            id: active.id,
            name: this.connectionLabel(active),
            status: active.status,
            securityState: active.securityState ?? "ok",
            isOwnEmbedded: activeIsOwnEmbedded
          }
        : undefined,
      syncState: this.plugin.getSyncState(),
      hasConnectedThisSession: this.plugin.hasConnectedActiveServerThisSession(),
      dataState: this.dataState,
      host: {
        hasOwnerCredential: this.plugin.hasOwnServer(),
        running: status.running,
        bootstrapped: status.running ? status.bootstrapped : this.plugin.hasOwnServer(),
        localRoomCount,
        error: status.running ? undefined : status.error
      },
      rooms: roomStates,
      peopleAttentionItems,
      activityAttentionItems,
      activityAccess: this.activityAccess(),
      canCreateRoom: Boolean(active?.isServerOwner)
    };
  }

  /**
   * Names a saved connection so two of them can be told apart. "Someone else's server" alone collapsed
   * every remote entry into one label, which defeated the point.
   *
   * Preference order: this computer, then the owner's cached name, then the port. Port is the weaker
   * discriminator - two teammates hosting on separate machines usually share the default port - so it is
   * only the fallback for entries saved before the owner name was cached.
   */
  private connectionLabel(server: {
    id: string;
    isServerOwner: boolean;
    baseUrl: string;
    serverOwnerDisplayName?: string;
  }): string {
    if (server.id === this.plugin.ownEmbeddedServerId()) return PANEL_COPY.connection.thisComputer;
    if (server.isServerOwner) return PANEL_COPY.connection.yourServer;
    if (server.serverOwnerDisplayName) {
      return PANEL_COPY.connection.ownedBy(server.serverOwnerDisplayName);
    }
    const port = portOf(server.baseUrl);
    return port ? PANEL_COPY.connection.unnamedOnPort(port) : PANEL_COPY.connection.someoneElse;
  }

  /**
   * Mirrors renderAudit's own gate: the server owner always qualifies, otherwise it takes managing at
   * least one team. Team membership loads asynchronously, so an empty team list while data is still
   * arriving or after a failed refresh is reported as `unknown` rather than `denied` - hiding the tab on
   * missing data would take it away from a team admin with no route back to it.
   */
  private activityAccess(): ActivityAccess {
    const active = this.plugin.getActiveServer();
    if (!active) return "denied";
    if (active.isServerOwner) return "allowed";
    if (this.plugin.teams.some((team) => this.plugin.canManageTeam(team))) return "allowed";
    // Only a load still in flight counts as "not known yet". A failed refresh is different: the audit
    // log cannot be fetched either, so the tab would be an empty dead end rather than a feature the
    // user is being denied - and it returns as soon as a refresh succeeds.
    return this.plugin.teams.length === 0 && this.dataState === "refreshing" ? "unknown" : "denied";
  }

  private renderHeader(parent: HTMLElement, descriptor: PanelDescriptor): void {
    const header = parent.createDiv({ cls: "vault-rooms-header vault-rooms-panel-header" });
    const heading = new Setting(header).setName("Vault Rooms").setHeading();
    if (this.plugin.canCreateAnyInvite()) {
      heading.addButton((button) =>
        button.setCta().setButtonText("Invite").onClick(() => this.plugin.openCreateInviteModal())
      );
    }

    const statusCard = parent.createDiv({
      cls: "vault-rooms-status-card"
    });
    const liveStatus = statusCard.createDiv({
      cls: "vault-rooms-live-status",
      attr: { "aria-live": "polite", "aria-atomic": "true" }
    });
    liveStatus.createSpan({
      cls: `vault-rooms-connection-chip is-${descriptor.connection.tone}`,
      text: descriptor.connection.label
    });
    liveStatus.createDiv({ cls: "vault-rooms-status-summary", text: descriptor.connection.summary });

    if (descriptor.hostLine) {
      const hostLine = statusCard.createDiv({ cls: "vault-rooms-host-line" });
      const copy = hostLine.createDiv({ cls: "vault-rooms-host-copy" });
      copy.createSpan({ cls: "vault-rooms-host-status", text: descriptor.hostLine.status });
      copy.createSpan({ text: descriptor.hostLine.text });
      if (descriptor.hostLine.action) {
        this.addPanelButton(hostLine, this.hostActionLabel(descriptor.hostLine.action), () =>
          this.runHostAction(descriptor.hostLine?.action)
        );
      }
    }

    const detailsToggle = statusCard.createDiv({ cls: "vault-rooms-status-actions" });
    const detailsButton = this.addPanelButton(
      detailsToggle,
      this.connectionDetailsExpanded ? "Hide connection details" : PANEL_COPY.activity.details,
      () => {
        this.connectionDetailsExpanded = !this.connectionDetailsExpanded;
        this.render();
      }
    );
    detailsButton.setAttr("aria-expanded", String(this.connectionDetailsExpanded));
    detailsButton.setAttr("aria-controls", "vault-rooms-connection-details");
    const details = statusCard.createDiv({
      cls: "vault-rooms-connection-details",
      attr: { id: "vault-rooms-connection-details" }
    });
    details.hidden = !this.connectionDetailsExpanded;
    if (this.connectionDetailsExpanded) {
      this.renderConnections(details);
    }

    if (descriptor.alert) {
      parent.createDiv({ cls: "vault-rooms-alert is-error", text: descriptor.alert });
    }
    if (descriptor.dataNotice) {
      const notice = parent.createDiv({
        cls: `vault-rooms-alert ${this.dataState === "stale-error" ? "is-warning" : "is-muted"}`
      });
      notice.createSpan({ text: descriptor.dataNotice.text });
      if (descriptor.dataNotice.action === "retry") {
        this.addPanelButton(notice, PANEL_COPY.data.retry, () => this.refreshData());
      }
    }
  }

  private renderTabs(
    parent: HTMLElement,
    descriptor: PanelDescriptor,
    tabs: readonly PanelTab[]
  ): void {
    const tablist = parent.createDiv({
      cls: "vault-rooms-tabs",
      attr: { role: "tablist", "aria-label": "Vault Rooms sections" }
    });
    for (const tab of tabs) {
      const tabDescriptor = descriptor.tabs[tab];
      const label = tabDescriptor.attentionCount > 0
        ? `${tabDescriptor.label}, ${tabDescriptor.attentionCount} needs attention`
        : tabDescriptor.label;
      const button = tablist.createEl("button", {
        cls: `vault-rooms-tab${this.activeTab === tab ? " is-active" : ""}`,
        text: tabDescriptor.label,
        attr: {
          id: `vault-rooms-tab-${tab}`,
          role: "tab",
          "aria-selected": String(this.activeTab === tab),
          "aria-controls": `vault-rooms-panel-${tab}`,
          "aria-label": label,
          tabindex: this.activeTab === tab ? "0" : "-1"
        }
      });
      if (tabDescriptor.attentionCount > 0) {
        button.createSpan({
          cls: "vault-rooms-tab-attention",
          text: String(tabDescriptor.attentionCount),
          attr: { "aria-hidden": "true" }
        });
      }
      button.onClickEvent(() => {
        this.activateTab(tab);
      });
      button.onkeydown = (event) => this.handleTabKey(event, tab, tabs);
    }
  }

  private handleTabKey(event: KeyboardEvent, current: PanelTab, tabs: readonly PanelTab[]): void {
    const currentIndex = tabs.indexOf(current);
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    this.activateTab(tabs[nextIndex] ?? "rooms");
    this.containerEl.querySelector<HTMLElement>(`#vault-rooms-tab-${this.activeTab}`)?.focus();
  }

  private activateTab(tab: PanelTab): void {
    this.activeTab = tab;
    this.render();
    if (tab === "people") {
      void this.refreshData();
    }
  }

  private renderRooms(parent: HTMLElement, descriptor: PanelDescriptor): void {
    const toolbar = parent.createDiv({ cls: "vault-rooms-toolbar" });
    if (this.plugin.getActiveServer()?.isServerOwner) {
      this.addPanelButton(toolbar, PANEL_COPY.room.create, () => this.plugin.openCreateRoomModal(), true);
    }
    const refresh = this.addPanelButton(toolbar, PANEL_COPY.room.refresh, () => this.refreshData());
    refresh.disabled = this.dataState === "refreshing";

    if (descriptor.rooms.length === 0) {
      const empty = parent.createDiv({ cls: "vault-rooms-empty-state" });
      empty.createDiv({ text: descriptor.emptyRoomMessage ?? PANEL_COPY.room.noRoomsMember });
      if (!this.plugin.getActiveServer()) {
        this.addPanelButton(empty, "Join server", () => this.plugin.openJoinTeamModal());
      }
      return;
    }

    const roomById = new Map(this.plugin.visibleRooms.map((room) => [room.id, room]));
    const list = parent.createDiv({ cls: "vault-rooms-primary-list" });
    for (const presentation of descriptor.rooms) {
      const room = roomById.get(presentation.id);
      if (!room) continue;
      const card = list.createDiv({
        cls: `vault-rooms-room-card${presentation.attention ? " needs-attention" : ""}`
      });
      const title = card.createDiv({ cls: "vault-rooms-card-title" });
      title.createEl("strong", { text: presentation.name });
      if (presentation.conflictCount > 0) {
        title.createSpan({ cls: "vault-rooms-attention-label", text: PANEL_COPY.room.attentionLabel });
      }
      card.createDiv({ cls: "vault-rooms-card-status", text: presentation.status });
      const actions = card.createDiv({ cls: "vault-rooms-card-actions" });
      for (const action of presentation.actions) {
        this.renderRoomAction(actions, room, presentation.mountedServerId, action);
      }
      if (presentation.conflictCount > 0) {
        this.renderRoomChoices(card, room.id);
      }
    }
  }

  private renderRoomAction(
    parent: HTMLElement,
    room: RoomSummary,
    mountedServerId: string | undefined,
    action: PanelRoomAction
  ): void {
    if (action === "open") {
      this.addPanelButton(parent, PANEL_COPY.room.open, () => this.openRoomLocation(room), true);
    } else if (action === "add") {
      this.addPanelButton(parent, PANEL_COPY.room.add, async () => {
        await this.plugin.mountRoom(room);
        this.render();
      }, true);
    } else if (action === "remove") {
      this.addPanelButton(parent, PANEL_COPY.room.remove, async () => {
        await this.plugin.unmountRoom(room.id);
        this.render();
      });
    } else if (action === "switch" && mountedServerId) {
      this.addPanelButton(parent, PANEL_COPY.room.switch, () => this.plugin.activateServer(mountedServerId), true);
    } else if (action === "manage") {
      this.addPanelButton(parent, PANEL_COPY.room.manage, () => this.plugin.openRoomSettingsModal(room));
    }
  }

  private async openRoomLocation(room: RoomSummary): Promise<void> {
    const path = this.plugin.mountedPathFor(room.id);
    if (!path) {
      new Notice("This room is not on this computer.");
      return;
    }
    if (room.type === "file") {
      await this.plugin.app.workspace.openLinkText(path, "", false);
      return;
    }

    const folder = this.plugin.app.vault.getFolderByPath(path);
    if (!folder) {
      new Notice(`Folder not found at ${path}.`);
      return;
    }
    const workspace = this.plugin.app.workspace;
    const leaf = workspace.getLeavesOfType("file-explorer")[0] ??
      await workspace.ensureSideLeaf("file-explorer", "left", { reveal: true });
    await workspace.revealLeaf(leaf);
    const explorer = leaf.view as unknown as Partial<FileExplorerView>;
    if (typeof explorer.revealInFolder !== "function") {
      new Notice(`Open File Explorer and select ${path}.`);
      return;
    }
    await explorer.revealInFolder(folder);
  }

  private renderRoomChoices(parent: HTMLElement, roomId: string): void {
    const conflicts = this.plugin.listRoomConflicts(roomId);
    const list = parent.createDiv({ cls: "vault-rooms-choice-list" });
    for (const conflict of conflicts) {
      const row = list.createDiv({ cls: "vault-rooms-choice-row" });
      row.createDiv({ cls: "vault-rooms-card-status", text: conflict.relativePath });
      const actions = row.createDiv({ cls: "vault-rooms-card-actions" });
      this.addPanelButton(actions, "Keep mine", async () => {
        await this.plugin.resolveRoomConflict(roomId, conflict.relativePath, conflict.conflictRelativePath, "mine");
        this.render();
      });
      this.addPanelButton(actions, "Keep teammate's version", async () => {
        await this.plugin.resolveRoomConflict(roomId, conflict.relativePath, conflict.conflictRelativePath, "theirs");
        this.render();
      });
    }
  }

  private renderPeople(parent: HTMLElement): void {
    const active = this.plugin.getActiveServer();
    if (!active) {
      parent.createDiv({ cls: "vault-rooms-empty-state", text: PANEL_COPY.empty.peopleNoServer });
      return;
    }
    const descriptor = peopleModel({
      currentUser: { id: active.userId, displayName: active.userDisplayName },
      serverOwner: this.plugin.getServerOwnerIdentity(),
      isServerOwner: active.isServerOwner,
      rooms: this.plugin.visibleRooms,
      friends: this.plugin.friends,
      teams: this.plugin.teams,
      teamMembersByTeam: this.plugin.teamMembersByTeam,
      myTeamRoles: this.plugin.myTeamRoles,
      roomAclByRoom: this.roomAclByRoom,
      canManageRoom: (room) => this.plugin.canManageRoom(room),
      canManageTeam: (team) => this.plugin.canManageTeam(team)
    });

    this.renderPeopleGroup(
      parent,
      "People with access",
      descriptor.withAccess,
      active.isServerOwner
        ? PANEL_COPY.empty.peopleWithAccessOwner
        : PANEL_COPY.empty.peopleWithAccessMember
    );
    if (descriptor.withoutAccess.length > 0) {
      this.renderPeopleGroup(
        parent,
        "No access yet",
        descriptor.withoutAccess,
        PANEL_COPY.empty.peopleWithoutAccess
      );
    }

    const teamsHeader = parent.createDiv({ cls: "vault-rooms-section-heading-row" });
    this.renderCountHeading(teamsHeader, "Teams", descriptor.teams.length);
    if (active.isServerOwner) {
      this.addPanelButton(teamsHeader, this.teamToolsExpanded ? "Close Manage teams" : "Manage teams", () => {
        this.teamToolsExpanded = !this.teamToolsExpanded;
        this.render();
      });
    }
    if (this.teamToolsExpanded && active.isServerOwner) {
      this.renderCreateTeam(parent);
    }
    const teamList = parent.createDiv({ cls: "vault-rooms-primary-list vault-rooms-access-list" });
    if (descriptor.teams.length === 0) {
      teamList.createDiv({
        cls: "vault-rooms-empty-state",
        text: active.isServerOwner ? PANEL_COPY.empty.teamsOwner : PANEL_COPY.empty.teamsMember
      });
    }
    for (const presentation of descriptor.teams) {
      const team = this.plugin.teams.find((candidate) => candidate.id === presentation.id);
      if (team) this.renderTeam(teamList, team, presentation);
    }
    if (descriptor.readOnlyNote) {
      parent.createDiv({ cls: "vault-rooms-access-note", text: descriptor.readOnlyNote });
    }
  }

  private renderPeopleGroup(
    parent: HTMLElement,
    title: string,
    people: PersonAccessPresentation[],
    emptyText: string
  ): void {
    const heading = parent.createDiv({ cls: "vault-rooms-section-heading-row" });
    this.renderCountHeading(heading, title, people.length);
    const list = parent.createDiv({ cls: "vault-rooms-primary-list vault-rooms-access-list" });
    if (people.length === 0) {
      list.createDiv({ cls: "vault-rooms-empty-state", text: emptyText });
      return;
    }
    for (const person of people) {
      const card = list.createDiv({ cls: "vault-rooms-access-card" });
      const row = card.createDiv({ cls: "vault-rooms-access-row" });
      row.createDiv({ cls: "vault-rooms-person-avatar", text: initials(person.name) });
      const copy = row.createDiv({ cls: "vault-rooms-access-copy" });
      copy.createEl("strong", { text: person.name });
      copy.createDiv({ cls: "vault-rooms-card-status", text: person.subtitle });
      if (person.canManage) {
        this.addPanelButton(row, this.expandedPeople.has(person.id) ? `Close ${PANEL_COPY.room.manage}` : PANEL_COPY.room.manage, () => {
          if (this.expandedPeople.has(person.id)) this.expandedPeople.delete(person.id);
          else this.expandedPeople.add(person.id);
          this.render();
        });
      }
      if (this.expandedPeople.has(person.id) && person.canManage) {
        this.renderPersonManagement(card, person);
      }
    }
  }

  private renderPersonManagement(parent: HTMLElement, person: PersonAccessPresentation): void {
    const management = parent.createDiv({ cls: "vault-rooms-management-surface" });
    management.createEl("strong", { text: "Remove server access" });
    management.createDiv({
      cls: "vault-rooms-card-status",
      text: `${person.name} will lose every room and device connection on this server.`
    });
    const remove = this.addPanelButton(management, "Remove server access", async () => {
      const confirmed = await confirmModal(
        this.app,
        "Remove server access",
        `Remove ${person.name}'s access to this server? They will lose every room and device connection.`,
        "Remove access"
      );
      if (!confirmed) return;
      await this.plugin.revokeFriend(person.id);
      await this.loadPeopleAccessData();
      this.expandedPeople.delete(person.id);
      this.render();
    });
    remove.addClass("mod-warning");
  }

  private renderCreateTeam(parent: HTMLElement): void {
    let name = "";
    const create = parent.createDiv({ cls: "vault-rooms-management-surface vault-rooms-inline-create" });
    const input = create.createEl("input", { type: "text", attr: { placeholder: "New team name" } });
    input.oninput = () => (name = input.value.trim());
    this.addPanelButton(create, "Create team", async () => {
      if (!name) {
        new Notice("Team name is required.");
        return;
      }
      await this.plugin.createTeam(name);
      await this.loadPeopleAccessData();
      this.render();
    }, true);
  }

  private renderTeam(
    parent: HTMLElement,
    team: TeamSummary,
    presentation: TeamAccessPresentation
  ): void {
    const card = parent.createDiv({ cls: "vault-rooms-team-card vault-rooms-access-card" });
    const title = card.createDiv({ cls: "vault-rooms-card-title" });
    title.createEl("strong", { text: team.name });
    if (presentation.badge) {
      title.createSpan({ cls: "vault-rooms-role-label", text: presentation.badge });
    }
    card.createDiv({ cls: "vault-rooms-card-status", text: presentation.subtitle });
    if (!presentation.canManage) return;

    this.addPanelButton(card, this.expandedTeams.has(team.id) ? `Close ${PANEL_COPY.room.manage}` : PANEL_COPY.room.manage, () => {
      if (this.expandedTeams.has(team.id)) this.expandedTeams.delete(team.id);
      else this.expandedTeams.add(team.id);
      this.render();
    });
    if (!this.expandedTeams.has(team.id)) return;

    const management = card.createDiv({ cls: "vault-rooms-management-surface" });
    const members = this.plugin.teamMembersByTeam[team.id];
    for (const member of members ?? []) {
      const row = management.createDiv({
        cls: `vault-rooms-compact-row${member.revokedAt ? " is-revoked" : ""}`
      });
      row.createSpan({ text: `${member.displayName} — ${member.role}${member.revokedAt ? " — no access" : ""}` });
      if (!member.revokedAt) {
        this.addPanelButton(row, "Remove", () => this.removeTeamMemberWithConfirm(team, member.userId, member.displayName));
      }
    }
    const candidates = this.plugin.friends.filter(
      (friend) => !friend.revokedAt && !members?.some((member) => member.userId === friend.id && !member.revokedAt)
    );
    if (candidates.length > 0) {
      const add = management.createDiv({ cls: "vault-rooms-inline-create" });
      const select = add.createEl("select");
      for (const friend of candidates) {
        select.createEl("option", { text: friend.displayName, value: friend.id });
      }
      this.addPanelButton(add, "Add friend", () => this.plugin.addFriendToTeam(team.id, select.value));
    }
    if (this.plugin.canDeleteTeam(team)) {
      const danger = management.createDiv({ cls: "vault-rooms-danger-zone" });
      danger.createEl("strong", { text: "Delete team" });
      danger.createDiv({ cls: "vault-rooms-card-status", text: "Removes memberships and room access. Rooms stay available." });
      const button = this.addPanelButton(danger, "Delete team", () => this.deleteTeamWithConfirm(team));
      // Same class setDestructiveCompat falls back to, so Delete team, Delete room, and Remove access
      // share one destructive treatment. Its size and alignment come from .vault-rooms-danger-zone.
      button.addClass("mod-warning");
    }
  }

  private async removeTeamMemberWithConfirm(
    team: TeamSummary,
    userId: string,
    displayName: string
  ): Promise<void> {
    const confirmed = await confirmModal(
      this.app,
      "Remove from team",
      `Remove ${displayName} from "${team.name}"? Access they receive through this team will stop.`,
      "Remove from team"
    );
    if (!confirmed) return;
    await this.plugin.removeTeamMember(team.id, userId);
    await this.loadPeopleAccessData();
    this.render();
  }

  private async deleteTeamWithConfirm(team: TeamSummary): Promise<void> {
    const confirmed = await confirmModal(
      this.app,
      "Delete team",
      `Delete team "${team.name}"? This removes its members, invites, and room access. Rooms are not deleted. This cannot be undone.`,
      "Delete team"
    );
    if (!confirmed) return;
    await this.plugin.deleteTeam(team.id);
    this.render();
  }

  private renderActivity(parent: HTMLElement): void {
    if (!this.renderAudit(parent)) {
      parent.createDiv({
        cls: "vault-rooms-empty-state",
        text: PANEL_COPY.empty.activityNoPermission
      });
    }
  }

  private renderConnections(parent: HTMLElement): void {
    this.renderSectionHeading(parent, "Selected server");
    const active = this.plugin.getActiveServer();
    const list = parent.createDiv({ cls: "vault-rooms-primary-list vault-rooms-connection-list" });
    if (active) {
      const card = list.createDiv({ cls: "vault-rooms-connection-card is-active" });
      const title = card.createDiv({ cls: "vault-rooms-card-title" });
      title.createEl("strong", { text: this.connectionLabel(active) });
      title.createSpan({ cls: "vault-rooms-role-label", text: "Selected" });
      if (!this.plugin.activeServerIsOwnEmbeddedServer()) {
        card.createDiv({ cls: "vault-rooms-card-status", text: `Signed in as ${active.userDisplayName}` });
        // The host's address is deliberately not shown: a member connects by invite and never types it,
        // and the one warning that depends on it (advertised-vs-observed drift) is host-side only. It
        // stays available in Test connection, which is the surface for "I can't connect".
      }
      this.renderActiveConnectionDetails(card);
    } else {
      list.createDiv({ cls: "vault-rooms-empty-state", text: PANEL_COPY.empty.connectionNone });
    }

    const savedServers = this.plugin.settings.servers.filter((server) => server.id !== active?.id);
    if (savedServers.length > 0) {
      list.createDiv({
        cls: "vault-rooms-card-status",
        text: "Only one server syncs at a time. Switching pauses rooms from the current server and resumes rooms from the selected server."
      });
      list.createEl("strong", { text: "Other saved servers" });
    }
    for (const saved of savedServers) {
      const card = list.createDiv({ cls: "vault-rooms-connection-card" });
      const title = card.createDiv({ cls: "vault-rooms-card-title" });
      title.createEl("strong", { text: this.connectionLabel(saved) });
      if (saved.status === "revoked") title.createSpan({ cls: "vault-rooms-attention-label", text: CONNECTION_STATUS_COPY.noAccess });
      card.createDiv({ cls: "vault-rooms-card-status", text: `Signed in as ${saved.userDisplayName}` });
      const actions = card.createDiv({ cls: "vault-rooms-card-actions" });
      this.addPanelButton(actions, PANEL_COPY.activity.switch, () => this.plugin.activateServer(saved.id), true);
      this.addPanelButton(actions, PANEL_COPY.activity.test, () => {
        new ConnectionDiagnosticsModal(this.plugin, saved.baseUrl, () =>
          this.plugin.diagnoseConnection(saved.baseUrl, pinnedInfoForServer(saved), saved.deviceToken)
        ).open();
      });
    }
    if (!this.plugin.activeServerIsOwnEmbeddedServer()) {
      this.renderLocalSharingCard(list);
    }
    const actions = parent.createDiv({ cls: "vault-rooms-toolbar" });
    this.addPanelButton(actions, PANEL_COPY.activity.join, () => this.plugin.openJoinTeamModal());
  }

  private renderActiveConnectionDetails(parent: HTMLElement): void {
    const active = this.plugin.getActiveServer();
    if (!active) return;
    if (this.plugin.activeServerIsOwnEmbeddedServer()) {
      this.renderLocalSharingDetails(parent);
      return;
    }

    const details = parent.createDiv({ cls: "vault-rooms-management-surface" });
    details.createDiv({
      cls: "vault-rooms-card-status",
      text: this.plugin.getSyncState() === "connected"
        ? "This computer is connected to this server."
        : "This connection is not syncing right now."
    });
    this.addPanelButton(details, PANEL_COPY.activity.test, () => {
      new ConnectionDiagnosticsModal(this.plugin, active.baseUrl, () =>
        this.plugin.diagnoseConnection(active.baseUrl, pinnedInfoForServer(active), active.deviceToken)
      ).open();
    });
    if (this.plugin.canCreateAnyInvite()) {
      this.addPanelButton(details, "Invite", () => this.plugin.openCreateInviteModal(), true);
    }
  }

  private renderLocalSharingCard(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "vault-rooms-connection-card vault-rooms-local-sharing-card" });
    card.createEl("strong", { text: "Sharing from this computer" });
    this.renderLocalSharingDetails(card);
  }

  private renderLocalSharingDetails(parent: HTMLElement): void {
    const status = this.plugin.getServerStatus();
    const details = parent.createDiv({ cls: "vault-rooms-management-surface" });
    if (!this.plugin.hasOwnServer() && status.running && status.bootstrapped) {
      details.createDiv({ cls: "vault-rooms-card-status", text: HOSTING_STATUS_COPY.recovery });
      details.createDiv({
        cls: "vault-rooms-card-status",
        text: PANEL_COPY.hosting.recovery
      });
      this.addPanelButton(details, PANEL_COPY.hosting.recover, () => this.plugin.openOwnerRecoveryModal(), true);
      return;
    }
    if (status.running) {
      if (!status.lanUrl) {
        details.createDiv({
          cls: "vault-rooms-alert is-warning",
          text: "No LAN address is set. Open Settings → Vault Rooms → Relay server so teammates can connect."
        });
        this.addPanelButton(details, PANEL_COPY.hosting.stop, () => this.plugin.stopEmbeddedServer());
        return;
      }
      details.createDiv({ cls: "vault-rooms-card-status", text: `Sharing from this device: ${status.lanUrl}` });
      const reachability = this.plugin.getLanShareReachability();
      const reachabilityCopy = lanSharePresentation(reachability);
      if (reachabilityCopy) {
        details.createDiv({ cls: "vault-rooms-card-status", text: reachabilityCopy.label });
      }
      if (reachability.status === "unreachable" || reachability.status === "not-a-lan-address") {
        details.createDiv({ cls: "vault-rooms-alert is-error", text: reachability.error });
      }
      const drift = status.lanUrl
        ? advertisedAddressDrift(status.lanUrl, this.plugin.getObservedClientHost())
        : null;
      if (drift) details.createDiv({ cls: "vault-rooms-alert is-warning", text: drift });
      details.createDiv({
        cls: "vault-rooms-card-status",
        text: "This check cannot confirm a teammate's firewall or Wi-Fi access."
      });
      this.addPanelButton(details, PANEL_COPY.hosting.stop, () => this.plugin.stopEmbeddedServer());
      if (status.legacyV01BackupAvailable) {
        this.addPanelButton(details, "Restore v0.1 data", () => this.plugin.restoreLegacyV01Data());
      }
    } else if (this.plugin.hasOwnServer()) {
      this.addPanelButton(details, PANEL_COPY.hosting.start, async () => {
        await this.plugin.startEmbeddedServer();
      }, true);
      if (status.error) details.createDiv({ cls: "vault-rooms-alert is-error", text: status.error });
    } else {
      details.createDiv({ cls: "vault-rooms-card-status", text: "Set up a separate server on this computer." });
      if (status.error) details.createDiv({ cls: "vault-rooms-alert is-error", text: status.error });
      this.addPanelButton(details, PANEL_COPY.hosting.setup, () => this.plugin.openSetupServerModal(), true);
    }
  }

  private renderAudit(parent: HTMLElement): boolean {
    const active = this.plugin.getActiveServer();
    if (!active) return false;
    const managedTeams = this.plugin.teams.filter((team) => this.plugin.canManageTeam(team));
    if (!active.isServerOwner && managedTeams.length === 0) return false;
    if (this.auditServerId !== active.id) {
      this.auditServerId = active.id;
      this.auditEvents = null;
      this.auditHasMore = false;
      this.auditTeamId = undefined;
    }

    const heading = parent.createDiv({ cls: "vault-rooms-section-heading-row" });
    this.renderSectionHeading(heading, "Activity log");
    heading.createSpan({ cls: "vault-rooms-card-status", text: PANEL_COPY.activity.heading });
    const tools = parent.createDiv({ cls: "vault-rooms-toolbar" });
    if (!active.isServerOwner) {
      if (!this.auditTeamId || !managedTeams.some((team) => team.id === this.auditTeamId)) {
        this.auditTeamId = managedTeams[0]?.id;
      }
      if (managedTeams.length > 1) {
        const select = tools.createEl("select");
        for (const team of managedTeams) {
          const option = select.createEl("option", { text: team.name, value: team.id });
          option.selected = team.id === this.auditTeamId;
        }
        select.onchange = () => {
          this.auditTeamId = select.value;
          this.auditEvents = null;
          void this.loadAuditPage(0).then(() => this.render()).catch((error) => {
            new Notice(userFacingError(error, "Failed to load activity"));
          });
        };
      }
    }
    this.addPanelButton(tools, this.auditEvents ? "Refresh activity" : "Load activity", async () => {
      this.auditEvents = null;
      await this.loadAuditPage(0);
      this.render();
    });

    if (!this.auditEvents) return true;
    const list = parent.createDiv({ cls: "vault-rooms-compact-list" });
    if (this.auditEvents.length === 0) {
      list.createDiv({ cls: "vault-rooms-empty-state", text: PANEL_COPY.empty.activityNone });
    }
    for (const event of this.auditEvents) {
      const presentation = activityPresentation(event);
      const row = list.createDiv({ cls: "vault-rooms-activity-row" });
      const title = row.createDiv({ cls: "vault-rooms-card-title" });
      title.createEl("strong", {
        cls: "vault-rooms-activity-summary",
        text: presentation.summary
      });
      title.createSpan({ cls: "vault-rooms-card-status", text: new Date(event.createdAt).toLocaleString() });
      const technical = row.createEl("details", { cls: "vault-rooms-activity-technical" });
      technical.createEl("summary", { text: PANEL_COPY.diagnostics.technical });
      technical.createEl("pre", { text: presentation.technicalDetails });
    }
    if (this.auditHasMore) {
      this.addPanelButton(parent, "Load more", async () => {
        await this.loadAuditPage(this.auditEvents?.length ?? 0);
        this.render();
      });
    }
    return true;
  }

  private static readonly AUDIT_PAGE_SIZE = 50;

  private async loadAuditPage(offset: number): Promise<void> {
    const active = this.plugin.getActiveServer();
    const options: { teamId?: string; limit: number; offset: number } = {
      limit: VaultRoomsView.AUDIT_PAGE_SIZE,
      offset
    };
    if (active && !active.isServerOwner && this.auditTeamId) options.teamId = this.auditTeamId;
    const page = await this.plugin.listAuditEvents(options);
    const existing = offset === 0 ? [] : (this.auditEvents ?? []);
    const seen = new Set(existing.map((event) => event.id));
    this.auditEvents = [...existing, ...page.events.filter((event) => !seen.has(event.id))];
    this.auditHasMore = page.events.length === VaultRoomsView.AUDIT_PAGE_SIZE;
  }

  private async loadPeopleAccessData(): Promise<void> {
    const manageableRooms = this.plugin.visibleRooms.filter((room) => this.plugin.canManageRoom(room));
    const entries = await Promise.all(
      manageableRooms.map(async (room): Promise<[string, AclRuleSummary[]]> => [
        room.id,
        await this.plugin.listRoomAcl(room.id)
      ])
    );
    this.roomAclByRoom = new Map(entries);
  }

  private async refreshData(): Promise<void> {
    if (!this.plugin.getActiveServer() || this.plugin.activeServerIsOwnStoppedServer()) {
      this.render();
      return;
    }
    this.dataState = "refreshing";
    this.render();
    try {
      await Promise.all([
        this.plugin.refreshRooms({ notify: false }),
        this.plugin.refreshTeams({ notify: false })
      ]);
      await this.loadPeopleAccessData();
      this.dataState = "current";
    } catch (error) {
      this.dataState = "stale-error";
      new Notice(userFacingError(error, "Failed to refresh Vault Rooms"));
    }
    this.render();
  }

  private hostActionLabel(action: NonNullable<PanelDescriptor["hostLine"]>["action"]): string {
    if (action === "setup") return PANEL_COPY.hosting.setup;
    if (action === "recover") return PANEL_COPY.hosting.recover;
    if (action === "stop") return PANEL_COPY.hosting.stop;
    return PANEL_COPY.hosting.start;
  }

  private async runHostAction(
    action: NonNullable<PanelDescriptor["hostLine"]>["action"] | undefined
  ): Promise<void> {
    if (action === "setup") this.plugin.openSetupServerModal();
    else if (action === "recover") this.plugin.openOwnerRecoveryModal();
    else if (action === "stop") await this.plugin.stopEmbeddedServer();
    else if (action === "start") {
      await this.plugin.startEmbeddedServer();
      await this.refreshData();
    }
  }

  private renderSectionHeading(parent: HTMLElement, text: string): void {
    parent.createEl("h3", { cls: "vault-rooms-section-heading", text });
  }

  private renderCountHeading(parent: HTMLElement, text: string, count: number): void {
    this.renderSectionHeading(parent, text);
    parent.createSpan({ cls: "vault-rooms-card-status", text: String(count) });
  }

  private addPanelButton(
    parent: HTMLElement,
    label: string,
    action: () => Promise<void> | void,
    cta = false
  ): HTMLButtonElement {
    const button = parent.createEl("button", { text: label });
    if (cta) button.addClass("mod-cta");
    button.onClickEvent(async () => {
      button.disabled = true;
      try {
        await action();
      } catch (error) {
        new Notice(userFacingError(error, "Vault Rooms action failed"));
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
