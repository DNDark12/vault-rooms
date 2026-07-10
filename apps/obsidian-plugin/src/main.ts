import { Notice, Plugin, type ObsidianProtocolData } from "obsidian";
import {
  RelayApiClient,
  type AclRuleSummary,
  type FriendSummary,
  type RoomSummary,
  type TeamDirectoryEntry,
  type TeamMemberSummary,
  type TeamSummary
} from "./apiClient.js";
import { registerMountedRoomWatcher } from "./fileWatcher.js";
import { confirmModal } from "./modals/ConfirmModal.js";
import { DEFAULT_SERVER_SETTINGS, DEFAULT_SETTINGS, type ServerConnection, type VaultRoomsSettings } from "./settings.js";
import type { EmbeddedServerStatus } from "./serverManager.js";
import { VaultRoomsSettingTab } from "./VaultRoomsSettingTab.js";
import { CreateRoomModal } from "./modals/CreateRoomModal.js";
import { CreateInviteModal } from "./modals/CreateInviteModal.js";
import { InviteMemberModal } from "./modals/InviteMemberModal.js";
import { JoinTeamModal } from "./modals/JoinTeamModal.js";
import { RoomSettingsModal } from "./modals/RoomSettingsModal.js";
import { SetupTeamModal } from "./modals/SetupTeamModal.js";
import { VaultSyncEngine, type MountedRoomState } from "./syncClient.js";
import { RoomPushCoordinator } from "./pushCoordinator.js";
import { RoomSyncSocket, type SyncConnectionState } from "./syncWsClient.js";
import { ObsidianVaultAdapter } from "./vaultAdapter.js";
import { VAULT_ROOMS_VIEW_TYPE, VaultRoomsView } from "./views/VaultRoomsView.js";
import { withInstalledCapabilities } from "./pluginCapabilities.js";
import { inviteAcceptanceNotice, inviteJoinNotice } from "./inviteNotices.js";
import type { PluginContext } from "./controllers/PluginContext.js";
import { ServerConnectionManager } from "./controllers/ServerConnectionManager.js";
import { RoomMountController, type RoomMountControllerDeps } from "./controllers/RoomMountController.js";

export default class VaultRoomsPlugin extends Plugin {
  settings: VaultRoomsSettings = DEFAULT_SETTINGS;
  visibleRooms: RoomSummary[] = [];
  /** This device's own teams (with ownerUserId) - scoped to the caller's memberships by the server
   *  (server owner sees all). Used for team-management UI (Invite link/Delete team/members), which
   *  needs ownerUserId/role - never use this for the room ACL "Team" picker. */
  teams: TeamSummary[] = [];
  /** Every team on the server, id/name/slug only - used solely for the room ACL "grant access to a
   *  Team" picker, so a room owner can grant access to a team they aren't a member of without
   *  exposing ownerUserId or membership for teams outside their own. */
  teamDirectory: TeamDirectoryEntry[] = [];
  /** This device's own team memberships/roles, keyed by team id - used to decide what this user can manage. */
  myTeamRoles: Record<string, "admin" | "member"> = {};
  friends: FriendSummary[] = [];
  /** Populated only for teams this device can actually list members of (its own teams, or all teams if server owner). */
  teamMembersByTeam: Record<string, TeamMemberSummary[]> = {};
  private vaultAdapter!: ObsidianVaultAdapter;
  private syncEngine!: VaultSyncEngine;
  /** Unsubscribe function per mounted room's vault-change watcher, so unmounting actually removes
   *  its listeners instead of leaving them registered (and silently no-op'ing) for the rest of
   *  the session - see watchMountedRoom()/unmountRoom(). */
  private roomWatchers = new Map<string, () => void>();
  /** One RoomPushCoordinator per currently-watched mounted room - used by connectSyncSocket()'s
   *  onStateChange to retry any dirty/pending-delete files once the live-sync socket reconnects. */
  private roomCoordinators = new Map<string, RoomPushCoordinator>();
  private syncSocket: RoomSyncSocket | null = null;
  private syncState: SyncConnectionState = "offline";
  private roomMountController!: RoomMountController;
  /** Getter-backed facade passed to controllers so state reads stay live without exposing the plugin's full surface. */
  private readonly ctx: PluginContext & RoomMountControllerDeps = ((self: VaultRoomsPlugin): PluginContext & RoomMountControllerDeps => ({
    app: self.app,
    manifest: self.manifest,
    get settings(): VaultRoomsSettings {
      return self.settings;
    },
    get visibleRooms(): RoomSummary[] {
      return self.visibleRooms;
    },
    apiFor: (server) => self.apiFor(server),
    requireActiveServer: () => self.requireActiveServer(),
    saveSettings: () => self.saveSettings(),
    renderOpenRoomsViews: () => self.renderOpenRoomsViews(),
    get vaultAdapter(): ObsidianVaultAdapter {
      return self.vaultAdapter;
    },
    getSyncEngine: () => self.syncEngine,
    stopWatchingRoom: (roomId) => self.stopWatchingRoom(roomId),
    watchMountedRoom: (roomId) => self.watchMountedRoom(roomId),
    subscribeRoom: (roomId) => {
      self.syncSocket?.subscribe(roomId);
    }
  }))(this);
  private readonly serverConnectionManager: ServerConnectionManager = new ServerConnectionManager(this.ctx);

  async onload(): Promise<void> {
    await this.loadSettings();
    this.vaultAdapter = new ObsidianVaultAdapter(this);
    this.syncEngine = new VaultSyncEngine(this.vaultAdapter, new RelayApiClient("http://127.0.0.1:8787"));
    this.roomMountController = new RoomMountController(this.ctx);
    this.addSettingTab(new VaultRoomsSettingTab(this));
    this.registerView(VAULT_ROOMS_VIEW_TYPE, (leaf) => new VaultRoomsView(leaf, this));
    this.addRibbonIcon("box", "Vault Rooms", () => this.openRoomsPanel());

    this.addCommand({
      id: "start-server",
      name: "Start server",
      callback: () => this.startEmbeddedServer()
    });
    this.addCommand({
      id: "stop-server",
      name: "Stop server",
      callback: () => this.stopEmbeddedServer()
    });

    if (this.settings.server.autoStart) {
      this.startEmbeddedServer().catch((error) => {
        new Notice(error instanceof Error ? `Vault Rooms server failed to start: ${error.message}` : "Vault Rooms server failed to start.");
      });
    }

    this.addCommand({
      id: "open-rooms-panel",
      name: "Open rooms panel",
      callback: () => this.openRoomsPanel()
    });
    this.addCommand({
      id: "setup-server",
      name: "Set up server",
      callback: () => this.openSetupServerModal()
    });
    this.addCommand({
      id: "create-room",
      name: "Create room",
      callback: () => this.openCreateRoomModal()
    });
    this.addCommand({
      id: "join-team",
      name: "Join team",
      callback: () => this.openJoinTeamModal()
    });
    this.addCommand({
      id: "rejoin-team",
      name: "Rejoin team",
      callback: () => new JoinTeamModal(this, "rejoin", this.getActiveServer()?.baseUrl ?? "").open()
    });
    this.addCommand({
      id: "refresh-rooms",
      name: "Refresh rooms",
      callback: () => this.refreshRooms()
    });
    this.addCommand({
      id: "mount-room",
      name: "Mount room",
      callback: () => this.mountFirstVisibleRoom()
    });
    this.addCommand({
      id: "unmount-room",
      name: "Unmount room",
      callback: async () => {
        const room = this.visibleRooms[0];
        if (room) {
          await this.unmountRoom(room.id);
        }
      }
    });
    this.addCommand({
      id: "forget-room",
      name: "Forget room (remove local sync tracking)",
      callback: async () => {
        const room = this.visibleRooms[0];
        if (room) {
          await this.forgetRoom(room.id);
        }
      }
    });
    this.addCommand({
      id: "disconnect",
      name: "Disconnect",
      callback: async () => {
        this.disconnectSyncSocket();
        this.settings.activeServerId = undefined;
        await this.saveSettings();
        this.renderOpenRoomsViews();
        new Notice("Disconnected from active Vault Rooms server.");
      }
    });

    const handleJoinLink = (params: ObsidianProtocolData) => {
      const mode = params.mode ?? params.op ?? "join";
      const inviteServer = params.server;
      const inviteToken = params.token;
      if (mode !== "join" || !inviteServer || !inviteToken) {
        new Notice("Vault Rooms invite link is missing server/token parameters.");
        return;
      }
      // If this device already has an active identity on the exact server, accept the Team/Room/
      // Friend invite against that existing user instead of trying to create a second identity.
      const existing = this.settings.servers.find(
        (server) => server.status === "active" && normalizeBaseUrl(server.baseUrl) === normalizeBaseUrl(inviteServer)
      );
      if (existing) {
        this.acceptInviteForServer(existing, inviteToken).catch((error) => {
          new Notice(error instanceof Error ? error.message : "Failed to accept invite");
        });
        return;
      }
      new JoinTeamModal(this, "join", inviteServer, inviteToken).open();
    };
    // Accept both obsidian://vault-rooms?mode=join&... and obsidian://vault-rooms/join?... link shapes.
    this.registerObsidianProtocolHandler("vault-rooms", handleJoinLink);
    this.registerObsidianProtocolHandler("vault-rooms/join", (params) => handleJoinLink({ ...params, mode: "join" }));

    // Registers watchers (for the active server's mounted rooms only) and connects the WS - see
    // connectSyncSocket()'s doc comment. Deferred until the workspace layout is ready: Obsidian
    // fires a "create" vault event for every file during initial vault indexing at startup, and
    // connectSyncSocket() is what wires up the per-room vault watchers (via watchMountedRoom()) -
    // registering them any earlier would treat that entire indexing storm as real local edits to
    // push. onLayoutReady() fires once, immediately if layout is already ready (e.g. plugin enabled
    // after startup) - it never blocks or double-registers, so this doesn't affect any of
    // connectSyncSocket()'s other call sites (setupServer/joinServer/activateServer/etc.), which
    // already only ever run well after startup in response to user actions.
    this.app.workspace.onLayoutReady(() => {
      // If the active connection is this device's own stopped embedded server, there is nothing
      // listening yet; Start server calls connectSyncSocket() again after the relay is running.
      if (this.activeServerIsOwnStoppedServer()) {
        return;
      }
      this.connectSyncSocket();
    });
  }

  onunload(): void {
    // Obsidian's public Plugin.onunload()/Component.unload() lifecycle does not await this
    // promise (and register() callbacks are fire-and-forget too), so a fast plugin reload may
    // start a new autoStart server before this embedded server has fully released its port. The
    // mitigation for that race is the port-pinning fallback + health-probe detection in
    // serverManager.ts/config.ts, not this best-effort teardown method itself.
    // registerEvent()-based vault listeners are torn down automatically by Obsidian, but the
    // per-room debounce timers in roomWatchers are plain window.setTimeout() calls - left running,
    // they'd fire after unload and try to push through an already-disconnected socket/stopped
    // server. Tear every mounted room's watcher down explicitly, same as unmountRoom() does.
    for (const roomId of Array.from(this.roomWatchers.keys())) {
      this.stopWatchingRoom(roomId);
    }
    this.syncSocket?.disconnect();
    void this.serverConnectionManager.stopSilently();
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as (Partial<VaultRoomsSettings> & { servers?: Array<Record<string, unknown>> }) | null;
    // v0.1 saved one server entry per TEAM (with a teamId/teamName/teamSlug/role). The redesign
    // makes rooms/teams independent of the server connection, so any entry shaped like that is
    // from before the upgrade and can't be reused - drop it and have the user set up/join again.
    const isLegacy = loaded?.servers?.some((server) => "teamId" in server) ?? false;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      servers: isLegacy ? [] : (loaded?.servers ?? DEFAULT_SETTINGS.servers),
      activeServerId: isLegacy ? undefined : loaded?.activeServerId,
      mountedRooms: isLegacy ? {} : (loaded?.mountedRooms ?? DEFAULT_SETTINGS.mountedRooms),
      roomMountPaths: isLegacy ? {} : (loaded?.roomMountPaths ?? DEFAULT_SETTINGS.roomMountPaths),
      server: { ...DEFAULT_SERVER_SETTINGS, ...(loaded?.server ?? {}) }
    };
    if (isLegacy) {
      await this.saveSettings();
      new Notice("Vault Rooms was upgraded — set up or join your server again.");
    }
  }

  getServerStatus(): EmbeddedServerStatus {
    return this.serverConnectionManager.getServerStatus();
  }

  /** Live-sync WebSocket state - separate from getServerStatus(), which is about *hosting* the embedded server. */
  getSyncState(): SyncConnectionState {
    return this.syncState;
  }

  async startEmbeddedServer(): Promise<EmbeddedServerStatus> {
    const status = await this.serverConnectionManager.startEmbeddedServer();
    const server = this.getActiveServer();
    if (status.running && server && this.isOwnEmbeddedServerConnection(server)) {
      this.connectSyncSocket();
      await Promise.all([this.refreshTeams({ notify: false }), this.refreshRooms({ notify: false })]).catch(() => undefined);
      this.renderOpenRoomsViews();
    }
    return status;
  }

  /** Disconnects live sync when this device's own server is intentionally stopped, so the socket
   *  cannot fall into reconnect backoff against a relay we just shut down on purpose. */
  async stopEmbeddedServer(): Promise<void> {
    const server = this.getActiveServer();
    const wasOwnEmbeddedServerConnection = Boolean(server && this.isOwnEmbeddedServerConnection(server));
    await this.serverConnectionManager.stopEmbeddedServer();
    if (wasOwnEmbeddedServerConnection) {
      this.disconnectSyncSocket();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getActiveServer(): ServerConnection | undefined {
    return this.serverConnectionManager.getActiveServer();
  }

  /** True only for this plugin's own embedded relay connection. isServerOwner alone is too broad:
   *  this account can own a standalone vault-rooms-relay deployment running elsewhere. Bootstrap
   *  through this plugin's UI always stores the embedded server's loopback localUrl (see
   *  setupServer() and serverManager.ts), so pairing owner identity with a loopback baseUrl pins it
   *  to this device's embedded server. */
  private isOwnEmbeddedServerConnection(server: ServerConnection): boolean {
    return server.isServerOwner && isLoopbackUrl(server.baseUrl);
  }

  /** Used to skip live-sync WebSocket creation and REST refreshes when there is genuinely nothing
   *  listening yet. This is never true for a remote server, even one this account owns. */
  activeServerIsOwnStoppedServer(): boolean {
    const server = this.getActiveServer();
    return Boolean(server && this.isOwnEmbeddedServerConnection(server) && !this.getServerStatus().running);
  }

  /**
   * Whether this device has already bootstrapped its own hosted server. Bootstrap is a one-time
   * action per device install (the embedded server is a singleton - one process, one database, one
   * owner identity - so there is no such thing as "another" server to set up on top of it), and the
   * created owner identity is permanent: the underlying database keeps its owner forever, even
   * across Stop/Start, so re-running setup against it always fails ("Bootstrap has already been
   * completed"). The panel uses this to stop offering "Set up server" once it would only ever fail.
   */
  hasOwnServer(): boolean {
    return this.serverConnectionManager.hasOwnServer();
  }

  async testConnection(baseUrl: string): Promise<void> {
    return this.serverConnectionManager.testConnection(baseUrl);
  }

  async setupServer(displayName: string, deviceName: string, teamName?: string): Promise<void> {
    // Setting up always means "make this device the server," so there is no useful case for
    // asking the user to separately click Start first - do it for them if it isn't running yet.
    // The target address is always this freshly-(re)started embedded server's own detected local
    // URL, never something the user types in: bootstrap only ever succeeds against localhost with
    // no existing owner (see team.routes.ts), so a hand-entered/stale URL could only fail loudly
    // (pointing elsewhere) or, worse, silently mismatch a port auto-picked because the default was
    // taken - there is no legitimate case where it should be anything other than this value.
    if (!this.getServerStatus().running) {
      await this.startEmbeddedServer();
    }
    const status = this.getServerStatus();
    if (!status.running) {
      throw new Error(status.error ?? "Could not start the relay server.");
    }
    const baseUrl = status.localUrl;
    // Same-process read, no network round-trip - see EmbeddedRelayServer.getBootstrapPin(). This
    // device is always the legitimate bootstrap caller (only the owner ever bootstraps; teammates
    // join via invite token instead), so supplying the PIN here is transparent to the user.
    const bootstrapPin = this.serverConnectionManager.getBootstrapPin();
    if (!bootstrapPin) {
      throw new Error("Could not read the relay server's bootstrap PIN.");
    }
    const response = await new RelayApiClient(baseUrl).bootstrapServer({ displayName, deviceName, teamName, pin: bootstrapPin });
    this.upsertServer(baseUrl, response);
    await this.saveSettings();
    this.connectSyncSocket();
    await Promise.all([this.refreshTeams({ notify: false }), this.refreshRooms({ notify: false })]).catch(() => undefined);
    await this.openRoomsPanel();
    this.renderOpenRoomsViews();
    new Notice(response.team ? `Set up server and team ${response.team.name}` : "Set up server");
  }

  async joinServer(baseUrl: string, inviteToken: string, displayName: string, deviceName: string): Promise<void> {
    const response = await new RelayApiClient(baseUrl).join(inviteToken, displayName, deviceName);
    this.upsertServer(baseUrl, response);
    await this.saveSettings();
    this.connectSyncSocket();
    await Promise.all([this.refreshTeams({ notify: false }), this.refreshRooms({ notify: false })]).catch(() => undefined);
    this.renderOpenRoomsViews();
    new Notice(inviteJoinNotice(response, baseUrl));
  }

  /** Accepts a Team/Room/Friend invite for an identity already active on this exact server. */
  private async acceptInviteForServer(server: ServerConnection, inviteToken: string): Promise<void> {
    const result = await this.apiFor(server).acceptInvite(inviteToken);
    if (result.inviteType !== "friend" && this.getActiveServer()?.id === server.id) {
      await Promise.all([this.refreshTeams({ notify: false }), this.refreshRooms({ notify: false })]).catch(() => undefined);
      this.renderOpenRoomsViews();
    }
    new Notice(inviteAcceptanceNotice(result));
  }

  async createInvite(teamId: string, role: "member" | "admin" = "member"): Promise<void> {
    const server = this.requireActiveServer();
    this.warnIfInviteIsLoopback();
    const invite = await this.apiFor(server).createInvite(teamId, role);
    new InviteMemberModal(this, invite.joinUrl).open();
  }

  async createRoomInvite(roomId: string, preset: "reader" | "editor"): Promise<void> {
    const server = this.requireActiveServer();
    this.warnIfInviteIsLoopback();
    const invite = await this.apiFor(server).createRoomInvite(roomId, preset);
    new InviteMemberModal(this, invite.joinUrl).open();
  }

  async createFriendInvite(): Promise<void> {
    const server = this.requireActiveServer();
    this.warnIfInviteIsLoopback();
    const invite = await this.apiFor(server).createFriendInvite();
    new InviteMemberModal(this, invite.joinUrl).open();
  }

  private warnIfInviteIsLoopback(): void {
    const status = this.getServerStatus();
    if (status.running && status.lanDetectionFailed) {
      new Notice(
        "Warning: this invite link still points at 127.0.0.1 and will NOT work for teammates. Set a Public URL override in Settings → Vault Rooms → Relay server, restart the server, then create a new invite.",
        12_000
      );
    }
  }

  /**
   * Refreshes this device's own teams (for team-management UI), the full team directory (for the
   * room ACL "Team" picker), friends, this device's own team memberships/roles, and - for teams
   * this device is actually allowed to list members of (its own teams, or every team if it is the
   * server owner) - each team's members.
   */
  async refreshTeams(options: { notify?: boolean } = {}): Promise<void> {
    const server = this.requireActiveServer();
    const api = this.apiFor(server);
    const [me, teamsResult, directoryResult, friendsResult] = await Promise.all([
      api.me(),
      api.listTeams(),
      api.listTeamDirectory(),
      api.listFriends()
    ]);
    this.myTeamRoles = Object.fromEntries(me.teams.map((team) => [team.id, team.role]));
    this.teams = teamsResult.teams;
    this.teamDirectory = directoryResult.teams;
    this.friends = friendsResult.friends;

    const memberVisibleTeamIds = server.isServerOwner ? this.teams.map((team) => team.id) : me.teams.map((team) => team.id);
    const memberEntries = await Promise.all(
      memberVisibleTeamIds.map(async (teamId): Promise<[string, TeamMemberSummary[]]> => [teamId, (await api.listMembers(teamId)).members])
    );
    this.teamMembersByTeam = Object.fromEntries(memberEntries);

    if (options.notify ?? true) {
      new Notice(`Loaded ${this.teams.length} team(s).`);
    }
    this.renderOpenRoomsViews();
  }

  /** True if this device can manage (add/remove members, create invites for) the given team. */
  canManageTeam(team: TeamSummary): boolean {
    const server = this.getActiveServer();
    if (!server) {
      return false;
    }
    return server.isServerOwner || team.ownerUserId === server.userId || this.myTeamRoles[team.id] === "admin";
  }

  canManageRoom(room: RoomSummary): boolean {
    const server = this.getActiveServer();
    return Boolean(server && (server.isServerOwner || room.ownerUserId === server.userId));
  }

  canCreateAnyInvite(): boolean {
    const server = this.getActiveServer();
    return Boolean(
      server &&
        (server.isServerOwner || this.visibleRooms.some((room) => this.canManageRoom(room)) || this.teams.some((team) => this.canManageTeam(team)))
    );
  }

  /** Only the server owner or the team's creator can delete it (stricter than canManageTeam). */
  canDeleteTeam(team: TeamSummary): boolean {
    const server = this.getActiveServer();
    if (!server) {
      return false;
    }
    return server.isServerOwner || team.ownerUserId === server.userId;
  }

  /** Server owner only. Creates a new permission-group team on the active server. */
  async createTeam(name: string): Promise<void> {
    const server = this.requireActiveServer();
    const result = await this.apiFor(server).createTeam(name);
    await this.refreshTeams({ notify: false });
    new Notice(`Created team ${result.team.name}`);
  }

  /** Owner/team-admin only. Adds an existing friend to a team directly - no invite link needed. */
  async addFriendToTeam(teamId: string, userId: string, role: "member" | "admin" = "member"): Promise<void> {
    const server = this.requireActiveServer();
    await this.apiFor(server).addTeamMember(teamId, userId, role);
    await this.refreshTeams({ notify: false });
    new Notice("Added to team.");
  }

  /** Owner/team-admin only. Removes a member from a team (their user account and other teams are untouched). */
  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    const server = this.requireActiveServer();
    await this.apiFor(server).revokeMember(teamId, userId);
    await this.refreshTeams({ notify: false });
    new Notice("Removed from team.");
    await this.offerToDeleteEmptyTeams([teamId]);
  }

  /** Server owner only. Revokes a friend's user account and all of their devices on this server. */
  async revokeFriend(userId: string): Promise<void> {
    const server = this.requireActiveServer();
    const affectedTeamIds = Object.entries(this.teamMembersByTeam)
      .filter(([, members]) => members.some((member) => member.userId === userId && !member.revokedAt))
      .map(([teamId]) => teamId);
    await this.apiFor(server).revokeFriend(userId);
    await this.refreshTeams({ notify: false });
    new Notice("Friend revoked.");
    await this.offerToDeleteEmptyTeams(affectedTeamIds);
  }

  /** After removing someone from a team (or revoking them entirely), offer to clean up any team that's now left with no active members. */
  private async offerToDeleteEmptyTeams(teamIds: string[]): Promise<void> {
    for (const teamId of teamIds) {
      const team = this.teams.find((candidate) => candidate.id === teamId);
      const activeMembers = this.teamMembersByTeam[teamId]?.filter((member) => !member.revokedAt) ?? [];
      if (team && activeMembers.length === 0 && this.canDeleteTeam(team)) {
        if (await confirmModal(this.app, "Delete team", `Team "${team.name}" now has no members left. Delete it too?`, "Delete team")) {
          await this.deleteTeam(teamId);
        }
      }
    }
  }

  async createRoom(input: {
    name: string;
    type: "file" | "folder";
    sourcePath: string;
    mountName: string;
    conflictPolicy?: "keep_both" | "owner_wins";
    capabilities: Array<{ pluginId: string; displayName: string; mode: string; minVersion?: string }>;
  }): Promise<void> {
    const server = this.requireActiveServer();
    await this.apiFor(server).createRoom(input);
    await this.refreshRooms();
    new Notice(`Created room ${input.name}`);
  }

  async updateRoomSettings(
    roomId: string,
    input: {
      name: string;
      type: "file" | "folder";
      sourcePath: string;
      mountName: string;
      conflictPolicy?: "keep_both" | "owner_wins";
      capabilities: Array<{ pluginId: string; displayName: string; mode: string; minVersion?: string }>;
    },
    localMountPath: string
  ): Promise<void> {
    const server = this.requireActiveServer();
    await this.apiFor(server).updateRoom(roomId, input);
    // "Local mount path" is not a supported concept for the room owner (their device always mounts
    // in place at sourcePath, see roomMountPathFor) - never persist an override for it here, so
    // re-opening the modal doesn't show stale data from before this field was hidden for owners.
    const room = this.visibleRooms.find((candidate) => candidate.id === roomId);
    const isOwner = room?.ownerUserId === server.userId;
    if (!isOwner && localMountPath.trim()) {
      this.settings.roomMountPaths[roomId] = localMountPath.trim();
    } else {
      delete this.settings.roomMountPaths[roomId];
    }
    await this.saveSettings();
    await this.refreshRooms({ notify: false });
    new Notice(`Updated room ${input.name}`);
  }

  async grantRoomAccess(
    roomId: string,
    input: {
      subjectType: "user" | "team";
      subjectId: string;
      effect: "allow" | "deny";
      preset?: "reader" | "editor";
      permissions?: string[];
      pathPattern: string;
    }
  ): Promise<void> {
    const server = this.requireActiveServer();
    await this.apiFor(server).grantAcl(roomId, input);
    await this.refreshRooms({ notify: false });
    new Notice("Room access updated.");
  }

  async listRoomAcl(roomId: string): Promise<AclRuleSummary[]> {
    const server = this.requireActiveServer();
    return (await this.apiFor(server).listRoomAcl(roomId)).aclRules;
  }

  /** Owners/admins only (enforced server-side). Removes a single access grant from a room. */
  async removeRoomAccess(roomId: string, aclId: string): Promise<void> {
    const server = this.requireActiveServer();
    await this.apiFor(server).removeAcl(roomId, aclId);
    new Notice("Access removed.");
  }

  /** Owners/admins only (enforced server-side). Deletes the room and all of its files/history on the server. */
  async deleteRoom(room: RoomSummary): Promise<void> {
    const server = this.requireActiveServer();
    await this.apiFor(server).deleteRoom(room.id);
    this.visibleRooms = this.visibleRooms.filter((candidate) => candidate.id !== room.id);
    delete this.settings.mountedRooms[room.id];
    delete this.settings.roomMountPaths[room.id];
    await this.saveSettings();
    this.renderOpenRoomsViews();
    new Notice(`Deleted room ${room.name}`);
  }

  /** Server owner or team creator only (enforced server-side). Deletes the team's memberships, invites, and ACL grants - NOT rooms, which are independently owned and outlive the team. */
  async deleteTeam(teamId: string): Promise<void> {
    const server = this.requireActiveServer();
    const team = this.teams.find((candidate) => candidate.id === teamId);
    await this.apiFor(server).deleteTeam(teamId);
    await Promise.all([this.refreshTeams({ notify: false }), this.refreshRooms({ notify: false })]);
    new Notice(`Deleted team ${team?.name ?? teamId}`);
  }

  /**
   * Purely local cleanup - removes a saved server entry without calling the server at all. This
   * is the recovery path for a server whose saved device token no longer works there (see
   * `markServerRevoked`): the server can't be reached to undo anything, so just drop the stale
   * local entry, then set up or join that server again to get a fresh, working identity.
   */
  async forgetServer(serverId: string): Promise<void> {
    const server = this.settings.servers.find((candidate) => candidate.id === serverId);
    if (!server) {
      return;
    }
    const isActive = this.getActiveServer()?.id === server.id;
    this.settings.servers = this.settings.servers.filter((candidate) => candidate.id !== server.id);
    if (this.settings.activeServerId === server.id) {
      this.settings.activeServerId = undefined;
    }
    // Otherwise these mountedRooms/roomMountPaths entries would sit around forever, tagged to a
    // serverId that no longer matches anything in settings.servers - permanently un-syncable and
    // never surfaced anywhere. Local files are left alone (same as unmounting); only the tracking
    // entries are removed.
    for (const [roomId, roomState] of Object.entries(this.settings.mountedRooms)) {
      if (roomState.serverId === server.id) {
        this.stopWatchingRoom(roomId);
        delete this.settings.mountedRooms[roomId];
        delete this.settings.roomMountPaths[roomId];
      }
    }
    if (isActive) {
      this.disconnectSyncSocket();
      this.resetSessionState();
    }
    await this.saveSettings();
    if (isActive) {
      this.connectSyncSocket();
    }
    this.renderOpenRoomsViews();
    new Notice(`Removed ${server.baseUrl} from this device.`);
  }

  async activateServer(serverId: string): Promise<void> {
    const server = this.settings.servers.find((candidate) => candidate.id === serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    this.settings.activeServerId = serverId;
    this.resetSessionState();
    await this.saveSettings();
    this.connectSyncSocket();
    await Promise.all([this.refreshRooms({ notify: false }), this.refreshTeams({ notify: false })]).catch((error) => {
      new Notice(error instanceof Error ? error.message : "Failed to load server");
    });
    this.renderOpenRoomsViews();
    new Notice(`Using ${server.baseUrl}`);
  }

  async refreshRooms(options: { notify?: boolean } = {}): Promise<void> {
    const server = this.requireActiveServer();
    const result = await this.apiFor(server).listRooms();
    this.visibleRooms = result.rooms.map((room) => withInstalledCapabilities(this.app, room));
    if (options.notify ?? true) {
      new Notice(`Loaded ${this.visibleRooms.length} room(s).`);
    }
    this.renderOpenRoomsViews();
  }

  async mountFirstVisibleRoom(): Promise<void> {
    if (this.visibleRooms.length === 0) {
      await this.refreshRooms();
    }
    await this.roomMountController.mountFirstVisibleRoom();
  }

  async mountRoom(room: RoomSummary): Promise<void> {
    await this.roomMountController.mountRoom(room);
  }

  async unmountRoom(roomId: string): Promise<void> {
    await this.roomMountController.unmountRoom(roomId);
  }

  async forgetRoom(roomId: string): Promise<void> {
    await this.roomMountController.forgetRoom(roomId);
  }

  isRoomMounted(roomId: string): boolean {
    return this.roomMountController.isRoomMounted(roomId);
  }

  mountedPathFor(roomId: string): string | undefined {
    return this.roomMountController.mountedPathFor(roomId);
  }

  mountedRoomServerId(roomId: string): string | undefined {
    return this.roomMountController.mountedRoomServerId(roomId);
  }

  listRoomConflicts(roomId: string): Array<{ relativePath: string; conflictRelativePath: string }> {
    return this.roomMountController.listRoomConflicts(roomId);
  }

  async resolveRoomConflict(roomId: string, relativePath: string, conflictRelativePath: string, keep: "mine" | "theirs"): Promise<void> {
    await this.roomMountController.resolveRoomConflict(roomId, relativePath, conflictRelativePath, keep);
  }

  roomMountPathFor(room: RoomSummary): string {
    return this.roomMountController.roomMountPathFor(room);
  }

  openSetupServerModal(): void {
    new SetupTeamModal(this).open();
  }

  openCreateRoomModal(): void {
    new CreateRoomModal(this).open();
  }

  openCreateInviteModal(): void {
    new CreateInviteModal(this).open();
  }

  openJoinTeamModal(): void {
    new JoinTeamModal(this).open();
  }

  openRoomSettingsModal(room: RoomSummary): void {
    new RoomSettingsModal(this, room).open();
  }

  private renderOpenRoomsViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VAULT_ROOMS_VIEW_TYPE)) {
      if (leaf.view instanceof VaultRoomsView) {
        leaf.view.render();
      }
    }
  }

  private stopWatchingRoom(roomId: string): void {
    this.roomWatchers.get(roomId)?.();
    this.roomWatchers.delete(roomId);
  }

  private disconnectSyncSocket(): void {
    this.syncSocket?.disconnect();
    this.syncSocket = null;
  }

  private resetSessionState(): void {
    this.visibleRooms = [];
    this.teams = [];
    this.teamDirectory = [];
    this.friends = [];
    this.myTeamRoles = {};
    this.teamMembersByTeam = {};
  }

  private roomIsLiveUnder(serverId: string, roomState: MountedRoomState): boolean {
    return roomState.serverId === serverId;
  }

  private watchMountedRoom(roomId: string): void {
    const roomState = this.settings.mountedRooms[roomId];
    const server = this.getActiveServer();
    if (!roomState || roomState.unmounted || !server) {
      return;
    }
    // A room mounted while a *different* server was active must not be watched now: pushLocalChange
    // below always goes through the currently-active server's API client, so watching it here would
    // silently try to push this room's edits to the wrong server (guaranteed to fail - that server
    // has never heard of this roomId). It stays un-watched (edits queue up unsynced on disk, same as
    // if Obsidian were closed) until its own server is reactivated and it's re-mounted/reconnected.
    if (!this.roomIsLiveUnder(server.id, roomState)) {
      return;
    }
    if (this.roomWatchers.has(roomId)) {
      return;
    }
    // Debounces rapid edits per path and serializes pushes per path (chains onto any push still in
    // flight), so a fast-autosaving file doesn't fire overlapping pushes that spuriously
    // version-conflict with themselves - see RoomPushCoordinator's doc comment. It also marks
    // files dirty/pending-delete synchronously (before the debounce timer starts) so a mid-debounce
    // restart doesn't lose track of unsynced local work, and exposes retryPending() for
    // connectSyncSocket()'s onStateChange to re-drive anything still unsynced once reconnected.
    const coordinator = new RoomPushCoordinator({
      room: roomState,
      syncEngine: this.syncEngine,
      deviceName: server.deviceName,
      onPersist: () => {
        void this.saveSettings();
      },
      onError: (relativePath, error) => {
        // Without this, a rejected push (unsupported file type, size limit, stale permissions,
        // etc.) vanished silently - the file just never showed up for teammates with no
        // indication anything went wrong.
        console.error(`Vault Rooms: failed to sync "${relativePath}"`, error);
        new Notice(`Vault Rooms: couldn't sync "${relativePath}" - ${error instanceof Error ? error.message : String(error)}`);
      },
      debounceMs: this.settings.debounceMs,
      isStillMounted: () => this.settings.mountedRooms[roomId] === roomState && !roomState.unmounted
    });
    const unsubscribe = registerMountedRoomWatcher(
      this.vaultAdapter,
      roomState,
      (event, relativePath) => {
        if (this.settings.mountedRooms[roomId] !== roomState) {
          return;
        }
        // registerMountedRoomWatcher already translates "rename" into a synthetic delete-old +
        // create-new pair (see classifyRenameEvent), so event.type here is always "create" |
        // "modify" | "delete".
        coordinator.handleLocalChange(event.type as "create" | "modify" | "delete", relativePath);
      },
      this.app.vault.configDir
    );
    this.roomCoordinators.set(roomId, coordinator);
    this.roomWatchers.set(roomId, () => {
      unsubscribe();
      coordinator.dispose();
      this.roomCoordinators.delete(roomId);
    });
  }

  /**
   * Rebinds the sync engine's API client to the active server and (re)connects the live
   * WebSocket sync subscription, so remote edits from teammates apply locally without waiting
   * for a manual re-mount. Call this any time the active server changes (setup, join, switch
   * team) - `syncEngine` is otherwise only bound once at onload and would keep pushing to a
   * stale/unauthenticated client. Safe to call repeatedly; it tears down any previous connection.
   *
   * Only one server is ever "active" (connected/syncing) at a time - `syncEngine` and the live
   * WebSocket both point at it exclusively. Rooms mounted under a *different* saved server are
   * left un-watched and unsubscribed (see watchMountedRoom()'s serverId guard) rather than routed
   * through the now-wrong client, so switching servers can never push one server's edits to
   * another. This also means: mounted rooms only actually sync while their own server is active -
   * switch back to a server to resume syncing whatever's mounted under it.
   */
  private connectSyncSocket(): void {
    this.disconnectSyncSocket();
    this.syncState = "offline";
    // Every watcher was registered against whichever server was active when it was set up; that
    // binding is about to go stale (syncEngine below is being replaced), so every watcher must be
    // torn down and, for the new active server's own rooms, re-registered below - otherwise a
    // leftover watcher from the old server would push through the new server's client.
    for (const unsubscribe of this.roomWatchers.values()) {
      unsubscribe();
    }
    this.roomWatchers.clear();
    const server = this.getActiveServer();
    this.syncEngine = new VaultSyncEngine(this.vaultAdapter, server ? this.apiFor(server) : new RelayApiClient("http://127.0.0.1:8787"));
    if (!server) {
      this.renderOpenRoomsViews();
      return;
    }
    for (const roomId of Object.keys(this.settings.mountedRooms)) {
      this.watchMountedRoom(roomId);
    }
    // Opening a WebSocket here would only retry the handshake forever against a closed local port
    // (console spam, panel stuck on "reconnecting"). Keeping this guard inside connectSyncSocket()
    // protects setup/join/activate/forget call sites too, and it never affects remote servers
    // because activeServerIsOwnStoppedServer() only matches this device's own embedded server.
    if (this.activeServerIsOwnStoppedServer()) {
      this.renderOpenRoomsViews();
      return;
    }
    const socket = new RoomSyncSocket(server, {
      // Unmounted rooms (see unmountRoom()/MountedRoomState.unmounted) keep their tracking so a
      // later remount can detect local edits made in the meantime, but must not receive live
      // remote changes/deletes while unmounted - returning undefined here reuses this class's
      // existing "room not found" no-op handling for every message type instead of needing a
      // separate unmounted check per message.
      getMountedRoom: (roomId) => {
        const state = this.settings.mountedRooms[roomId];
        return state && !state.unmounted ? state : undefined;
      },
      getApi: () => this.apiFor(server),
      syncEngine: this.syncEngine,
      onStateChange: (state) => {
        this.syncState = state;
        // A reconnect is exactly when previously-failed/offline pushes are worth retrying - see
        // RoomPushCoordinator.retryPending(). This reuses each room's existing debounce/serialize
        // machinery rather than a second queue, and each coordinator's own isStillMounted guard
        // covers a room being unmounted while offline.
        if (state === "connected") {
          for (const coordinator of this.roomCoordinators.values()) {
            coordinator.retryPending();
          }
        }
        this.renderOpenRoomsViews();
      },
      onApplied: () => {
        void this.saveSettings();
        this.renderOpenRoomsViews();
      },
      onRevoked: () => {
        new Notice(`Your access to ${server.baseUrl} was revoked.`);
        if (this.settings.activeServerId === server.id) {
          this.settings.activeServerId = undefined;
        }
        void this.saveSettings();
        this.renderOpenRoomsViews();
      },
      onRoomDeleted: (roomId) => {
        const room = this.visibleRooms.find((candidate) => candidate.id === roomId);
        this.visibleRooms = this.visibleRooms.filter((candidate) => candidate.id !== roomId);
        this.roomMountController.dropRoomTracking(roomId);
        void this.saveSettings();
        this.renderOpenRoomsViews();
        new Notice(`${room?.name ?? "A room"} was deleted by the owner/admin.`);
      },
      onAccessRevoked: (roomId) => {
        const room = this.visibleRooms.find((candidate) => candidate.id === roomId);
        this.visibleRooms = this.visibleRooms.filter((candidate) => candidate.id !== roomId);
        this.roomMountController.dropRoomTracking(roomId);
        void this.saveSettings();
        this.renderOpenRoomsViews();
        new Notice(`Your access to ${room?.name ?? "a room"} was revoked.`);
      }
    });
    socket.connect();
    // Only subscribe rooms that actually belong to this server - see the serverId note on
    // MountedRoomState. Subscribing a foreign room here would ask this server about a roomId it
    // has never issued, which the relay would just reject.
    for (const [roomId, roomState] of Object.entries(this.settings.mountedRooms)) {
      if (this.roomIsLiveUnder(server.id, roomState)) {
        socket.subscribe(roomId);
      }
    }
    this.syncSocket = socket;
  }

  private async openRoomsPanel(): Promise<void> {
    await this.app.workspace.getLeaf(true).setViewState({ type: VAULT_ROOMS_VIEW_TYPE, active: true });
  }

  private apiFor(server: ServerConnection): RelayApiClient {
    return this.serverConnectionManager.apiFor(server);
  }

  private requireActiveServer(): ServerConnection {
    return this.serverConnectionManager.requireActiveServer();
  }

  private upsertServer(
    baseUrl: string,
    response: {
      user: { id: string; displayName: string };
      device: { id: string; displayName: string };
      deviceToken: string;
      isServerOwner: boolean;
    }
  ): void {
    this.serverConnectionManager.upsertServer(baseUrl, response);
  }
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
  } catch {
    return false;
  }
}
