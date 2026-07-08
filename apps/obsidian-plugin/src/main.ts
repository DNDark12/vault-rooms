import { FileSystemAdapter, Notice, Plugin, type ObsidianProtocolData } from "obsidian";
import { join } from "node:path";
import { isEligiblePath } from "@vault-rooms/protocol";
import {
  RelayApiClient,
  type AclRuleSummary,
  type FriendSummary,
  type MyTeamSummary,
  type RoomSummary,
  type TeamDirectoryEntry,
  type TeamMemberSummary,
  type TeamSummary
} from "./apiClient.js";
import { registerMountedRoomWatcher } from "./fileWatcher.js";
import { activeServer, DEFAULT_SERVER_SETTINGS, DEFAULT_SETTINGS, type ServerConnection, type VaultRoomsSettings } from "./settings.js";
import { EmbeddedRelayServer, type EmbeddedServerStatus } from "./serverManager.js";
import { VaultRoomsSettingTab } from "./VaultRoomsSettingTab.js";
import { CreateRoomModal } from "./modals/CreateRoomModal.js";
import { InviteMemberModal } from "./modals/InviteMemberModal.js";
import { JoinTeamModal } from "./modals/JoinTeamModal.js";
import { RoomSettingsModal } from "./modals/RoomSettingsModal.js";
import { SetupTeamModal } from "./modals/SetupTeamModal.js";
import { canonicalPathForConflictCopy, isConflictCopyPath, resolveRoomMountPath, type MountedRoomState, VaultSyncEngine } from "./syncClient.js";
import { RoomPushCoordinator } from "./pushCoordinator.js";
import { RoomSyncSocket, type SyncConnectionState } from "./syncWsClient.js";
import { ObsidianVaultAdapter } from "./vaultAdapter.js";
import { VAULT_ROOMS_VIEW_TYPE, VaultRoomsView } from "./views/VaultRoomsView.js";
import { withInstalledCapabilities } from "./pluginCapabilities.js";

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
  private embeddedServer: EmbeddedRelayServer | null = null;
  private syncSocket: RoomSyncSocket | null = null;
  private syncState: SyncConnectionState = "offline";

  async onload(): Promise<void> {
    await this.loadSettings();
    this.vaultAdapter = new ObsidianVaultAdapter(this);
    this.syncEngine = new VaultSyncEngine(this.vaultAdapter, new RelayApiClient("http://127.0.0.1:8787"));
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
        this.syncSocket?.disconnect();
        this.syncSocket = null;
        this.settings.activeServerId = undefined;
        await this.saveSettings();
        this.renderOpenRoomsViews();
        new Notice("Disconnected from active Vault Rooms server.");
      }
    });

    const handleJoinLink = (params: ObsidianProtocolData) => {
      const mode = params.mode ?? params.op ?? "join";
      if (mode !== "join" || !params.server || !params.token) {
        new Notice("Vault Rooms invite link is missing server/token parameters.");
        return;
      }
      // If we already have an active identity on this exact server, this is a "join another
      // team" invite for someone who already has an account there - accept it directly onto the
      // caller's existing user/device instead of running through the (new account) join modal.
      const existing = this.settings.servers.find(
        (server) => server.status === "active" && normalizeBaseUrl(server.baseUrl) === normalizeBaseUrl(params.server as string)
      );
      if (existing) {
        this.acceptInviteForServer(existing, params.token as string).catch((error) => {
          new Notice(error instanceof Error ? error.message : "Failed to accept invite");
        });
        return;
      }
      new JoinTeamModal(this, "join", params.server, params.token).open();
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
      this.connectSyncSocket();
    });
  }

  async onunload(): Promise<void> {
    // Obsidian's public Plugin.onunload()/Component.unload() lifecycle does not await this
    // promise (and register() callbacks are fire-and-forget too), so a fast plugin reload may
    // start a new autoStart server before this embedded server has fully released its port. The
    // mitigation for that race is the port-pinning fallback + health-probe detection in
    // serverManager.ts/config.ts, not this best-effort teardown method itself.
    // registerEvent()-based vault listeners are torn down automatically by Obsidian, but the
    // per-room debounce timers in roomWatchers are plain window.setTimeout() calls - left running,
    // they'd fire after unload and try to push through an already-disconnected socket/stopped
    // server. Tear every mounted room's watcher down explicitly, same as unmountRoom() does.
    for (const unsubscribe of this.roomWatchers.values()) {
      unsubscribe();
    }
    this.roomWatchers.clear();
    this.syncSocket?.disconnect();
    await this.embeddedServer?.stop();
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
      servers: isLegacy ? [] : ((loaded?.servers as VaultRoomsSettings["servers"] | undefined) ?? DEFAULT_SETTINGS.servers),
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
    return this.embeddedServer?.getStatus() ?? { running: false };
  }

  /** Live-sync WebSocket state - separate from getServerStatus(), which is about *hosting* the embedded server. */
  getSyncState(): SyncConnectionState {
    return this.syncState;
  }

  async startEmbeddedServer(): Promise<EmbeddedServerStatus> {
    const server = this.getOrCreateEmbeddedServer();
    const previousPinnedPort = this.settings.server.pinnedPort;
    const status = await server.start(this.settings.server);
    this.renderOpenRoomsViews();
    if (status.running) {
      if (!this.settings.server.port && status.port !== this.settings.server.pinnedPort) {
        this.settings.server.pinnedPort = status.port;
        await this.saveSettings();
      }
      if (status.portPinChanged) {
        const reason =
          status.portPinFallbackReason === "zombie"
            ? "The old port still looks like a previous Vault Rooms server instance."
            : status.portPinFallbackReason === "occupied"
              ? "The old port is occupied by another app."
              : "The old port is occupied.";
        new Notice(
          `Vault Rooms server moved from port ${previousPinnedPort} to ${status.port}. ${reason} Invite links and saved logins that reference the old port may need regenerating.`,
          0
        );
      }
      new Notice(`Vault Rooms server running at ${status.localUrl}`);
    }
    return status;
  }

  async stopEmbeddedServer(): Promise<void> {
    await this.embeddedServer?.stop();
    this.renderOpenRoomsViews();
    new Notice("Vault Rooms server stopped.");
  }

  private getOrCreateEmbeddedServer(): EmbeddedRelayServer {
    if (!this.embeddedServer) {
      const adapter = this.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) {
        throw new Error("Vault Rooms requires the desktop app (filesystem access).");
      }
      const pluginDir = join(adapter.getBasePath(), this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`);
      const dataDir = join(pluginDir, "server-data");
      this.embeddedServer = new EmbeddedRelayServer(dataDir);
    }
    return this.embeddedServer;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getActiveServer(): ServerConnection | undefined {
    return activeServer(this.settings);
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
    return this.settings.servers.some((server) => server.isServerOwner);
  }

  async testConnection(baseUrl: string): Promise<void> {
    await new RelayApiClient(baseUrl).testConnection();
    new Notice(`Connected to Vault Rooms`);
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
    const bootstrapPin = this.getOrCreateEmbeddedServer().getBootstrapPin();
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
    new Notice(`Joined ${response.team.name}`);
  }

  /** Accepts an invite onto an already-connected server, adding the caller's existing account to that invite's team. */
  private async acceptInviteForServer(server: ServerConnection, inviteToken: string): Promise<void> {
    const result = await this.apiFor(server).acceptInvite(inviteToken);
    if (this.getActiveServer()?.id === server.id) {
      await Promise.all([this.refreshTeams({ notify: false }), this.refreshRooms({ notify: false })]).catch(() => undefined);
      this.renderOpenRoomsViews();
    }
    new Notice(`Joined team ${result.team.name}`);
  }

  async createInvite(teamId: string, role: "member" | "admin" = "member"): Promise<void> {
    const server = this.requireActiveServer();
    const status = this.getServerStatus();
    if (status.running && status.lanDetectionFailed) {
      new Notice(
        "Warning: could not auto-detect this device's LAN IP, so this invite link still points at 127.0.0.1 and will NOT work for teammates. Set a Public URL override in Settings → Vault Rooms → Relay server, then create a new invite.",
        12_000
      );
    }
    const invite = await this.apiFor(server).createInvite(teamId, role);
    new InviteMemberModal(this, `${invite.serverUrl}\n${invite.inviteToken}\n${invite.joinUrl}`, invite.joinUrl).open();
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
        if (window.confirm(`Team "${team.name}" now has no members left. Delete it too?`)) {
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
        this.roomWatchers.get(roomId)?.();
        this.roomWatchers.delete(roomId);
        delete this.settings.mountedRooms[roomId];
        delete this.settings.roomMountPaths[roomId];
      }
    }
    if (isActive) {
      this.syncSocket?.disconnect();
      this.syncSocket = null;
      this.visibleRooms = [];
      this.teams = [];
      this.teamDirectory = [];
      this.friends = [];
      this.myTeamRoles = {};
      this.teamMembersByTeam = {};
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
    this.visibleRooms = [];
    this.teams = [];
    this.teamDirectory = [];
    this.friends = [];
    this.myTeamRoles = {};
    this.teamMembersByTeam = {};
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
    const room = this.visibleRooms[0];
    if (!room) {
      new Notice("No visible rooms to mount.");
      return;
    }
    await this.mountRoom(room);
  }

  /**
   * (Re)mounts a room locally. The relay server's file listing is always treated as the
   * authoritative source of truth (the owner/host is where files actually live) - this matters
   * most when a member is removed from a room and later re-added: any files that were deleted on
   * the server in the meantime carry a tombstone (`deleted: true`) in the listing and must be
   * removed locally rather than left behind as stale copies. Files whose server version already
   * matches what we last synced are left untouched so we don't clobber unpushed local edits;
   * everything else is routed through VaultSyncEngine so dirty local edits get a conflict copy
   * instead of being silently overwritten.
   */
  async mountRoom(room: RoomSummary): Promise<void> {
    // Single-file rooms are no longer supported (see CreateRoomModal.ts) - their sync prefix logic
    // never actually worked (mountPath was always treated as a directory), so mounting one would
    // silently sync nothing at all with no indication why. Rooms created before this change can
    // still exist server-side (the server keeps accepting the stored `type` for back-compat); flag
    // it clearly instead of proceeding into a no-op mount.
    if (room.type === "file") {
      new Notice(`"${room.name}" is a single-file room, which is no longer supported - recreate it as a folder room.`);
      return;
    }
    const server = this.requireActiveServer();
    const mountPath = this.roomMountPathFor(room);
    const state = (this.settings.mountedRooms[room.id] = this.settings.mountedRooms[room.id] ?? {
      roomId: room.id,
      serverId: server.id,
      mountPath,
      files: {}
    });
    state.mountPath = mountPath;
    state.serverId = server.id;
    state.unmounted = false;
    // The watcher (which normally marks an edited file dirty - see pushCoordinator.ts) is off
    // while a room is unmounted, so an edit made during that window would otherwise be invisible
    // here: the listing loop below only compares against the server's version and would skip a
    // file whose server version hasn't changed, silently downloading over the local edit. Re-hash
    // every already-tracked file first so such edits are treated as dirty-equivalent and get a
    // conflict copy instead of being clobbered.
    await this.syncEngine.reconcileLocalEdits(state);
    const api = this.apiFor(server);
    const files = await api.listFiles(room.id);
    const knownRelativePaths = new Set(files.files.map((file) => file.relativePath));
    for (const file of files.files) {
      const tracked = state.files[file.relativePath];
      if (file.deleted) {
        if (tracked) {
          await this.syncEngine.applyRemoteDelete(state, { relativePath: file.relativePath, version: file.version }, server.deviceName);
        }
        continue;
      }
      if (tracked && !tracked.dirty && tracked.serverVersion === file.version) {
        continue;
      }
      const content = await api.readFile(room.id, file.relativePath);
      await this.syncEngine.applyRemoteChange(state, content, server.deviceName);
    }

    // The server's listing only covers what's already been synced. On the room owner's own
    // device, mountPath is the real sourcePath folder, which typically already has real content
    // before the room ever existed - without this, that pre-existing content would just sit there
    // forever, since the local file watcher only reacts to *future* edits. Push anything under
    // mountPath the server has never heard of (skips anything it already knows about, including
    // tombstoned/deleted paths - those are intentional server-side deletions, not "missing" files).
    const localPaths = await this.vaultAdapter.list(mountPath);
    for (const localPath of localPaths) {
      const relativePath = localPath.slice(mountPath.length + 1);
      if (!relativePath || knownRelativePaths.has(relativePath) || !isEligiblePath(relativePath)) {
        continue;
      }
      try {
        await this.syncEngine.pushLocalChange(state, relativePath, server.deviceName);
      } catch (error) {
        console.error(`Vault Rooms: failed to push existing file "${relativePath}" to room ${room.name}`, error);
      }
    }

    this.watchMountedRoom(room.id);
    this.syncSocket?.subscribe(room.id);
    await this.saveSettings();
    this.renderOpenRoomsViews();
    new Notice(`Mounted ${room.name}`);
  }

  /**
   * Non-destructively unmounts a room: stops the local watcher and live-sync subscription for it,
   * but leaves local files and tracking (settings.mountedRooms[roomId]) in place - see
   * MountedRoomState.unmounted. This matters most for re-mounting later: without kept tracking,
   * mountRoom() would see no tracked state for any file and download the server's copy over
   * whatever is on disk, with no conflict copy, silently discarding any local edits made in the
   * meantime. Use forgetRoom() for the old fully-destructive "drop everything" behavior.
   */
  async unmountRoom(roomId: string): Promise<void> {
    const room = this.visibleRooms.find((candidate) => candidate.id === roomId);
    const roomState = this.settings.mountedRooms[roomId];
    this.roomWatchers.get(roomId)?.();
    this.roomWatchers.delete(roomId);
    if (roomState) {
      roomState.unmounted = true;
    }
    await this.saveSettings();
    this.renderOpenRoomsViews();
    new Notice(`Unmounted ${room?.name ?? "room"}`);
  }

  /** Destructively forgets a room's local tracking (the old unmountRoom() behavior) - local files
   *  on disk are left alone (same as unmountRoom), but this device's sync tracking for the room is
   *  dropped entirely, so a later mount starts over as if the room were never mounted here. */
  async forgetRoom(roomId: string): Promise<void> {
    const room = this.visibleRooms.find((candidate) => candidate.id === roomId);
    this.roomWatchers.get(roomId)?.();
    this.roomWatchers.delete(roomId);
    delete this.settings.mountedRooms[roomId];
    delete this.settings.roomMountPaths[roomId];
    await this.saveSettings();
    this.renderOpenRoomsViews();
    new Notice(`Forgot ${room?.name ?? "room"} on this device`);
  }

  isRoomMounted(roomId: string): boolean {
    const state = this.settings.mountedRooms[roomId];
    return Boolean(state) && !state?.unmounted;
  }

  mountedPathFor(roomId: string): string | undefined {
    return this.settings.mountedRooms[roomId]?.mountPath;
  }

  /** Which server (settings.servers[].id) a mounted room belongs to - see the serverId note on
   *  MountedRoomState. Used by the panel to tell whether a mounted room is under the currently
   *  active server (syncing) or a different, currently-inactive one (paused). */
  mountedRoomServerId(roomId: string): string | undefined {
    return this.settings.mountedRooms[roomId]?.serverId;
  }

  /**
   * Conflict copies are local-only files (see isConflictCopyPath - they're never pushed or
   * synced), so finding them is a plain local file-listing scan, not a server call. Used to
   * render a "Resolve" list per mounted room instead of leaving people to sort them out by hand
   * in the file explorer.
   */
  listRoomConflicts(roomId: string): Array<{ relativePath: string; conflictRelativePath: string }> {
    const mountPath = this.mountedPathFor(roomId);
    if (!mountPath) {
      return [];
    }
    const prefix = mountPath.replace(/\/+$/, "");
    const conflicts: Array<{ relativePath: string; conflictRelativePath: string }> = [];
    for (const file of this.app.vault.getFiles()) {
      const path = file.path;
      if (path !== prefix && !path.startsWith(`${prefix}/`)) {
        continue;
      }
      if (!isConflictCopyPath(path)) {
        continue;
      }
      const canonical = canonicalPathForConflictCopy(path);
      if (!canonical) {
        continue;
      }
      conflicts.push({
        relativePath: canonical.slice(prefix.length + 1),
        conflictRelativePath: path.slice(prefix.length + 1)
      });
    }
    return conflicts;
  }

  async resolveRoomConflict(roomId: string, relativePath: string, conflictRelativePath: string, keep: "mine" | "theirs"): Promise<void> {
    const server = this.requireActiveServer();
    const roomState = this.settings.mountedRooms[roomId];
    if (!roomState) {
      throw new Error("Room is not mounted.");
    }
    await this.syncEngine.resolveConflict(roomState, relativePath, conflictRelativePath, keep, server.deviceName);
    await this.saveSettings();
    this.renderOpenRoomsViews();
    new Notice(keep === "mine" ? "Kept your version and re-synced it." : "Kept the synced version and removed your local copy.");
  }

  /**
   * The room owner's device mounts in place at the room's real `sourcePath` (their existing vault
   * folder) - there's nothing to "download," their files already live there, so a separate copy
   * would just be an empty shadow folder that never gets used. Everyone else mounts into a fresh
   * folder under the configured mount root, since they have no pre-existing copy of the room.
   */
  roomMountPathFor(room: RoomSummary): string {
    const server = this.requireActiveServer();
    const isOwner = room.ownerUserId === server.userId;
    return resolveRoomMountPath({
      owner: isOwner,
      configuredOverride: this.settings.roomMountPaths[room.id],
      mountRoot: this.settings.mountRoot,
      mountName: room.mountName,
      sourcePath: room.sourcePath
    });
  }

  openSetupServerModal(): void {
    new SetupTeamModal(this).open();
  }

  openCreateRoomModal(): void {
    new CreateRoomModal(this).open();
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
    if (roomState.serverId !== server.id) {
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
    const unsubscribe = registerMountedRoomWatcher(this.vaultAdapter, roomState, (event, relativePath) => {
      if (this.settings.mountedRooms[roomId] !== roomState) {
        return;
      }
      // registerMountedRoomWatcher already translates "rename" into a synthetic delete-old +
      // create-new pair (see classifyRenameEvent), so event.type here is always "create" |
      // "modify" | "delete".
      coordinator.handleLocalChange(event.type as "create" | "modify" | "delete", relativePath);
    });
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
    this.syncSocket?.disconnect();
    this.syncSocket = null;
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
        delete this.settings.mountedRooms[roomId];
        delete this.settings.roomMountPaths[roomId];
        void this.saveSettings();
        this.renderOpenRoomsViews();
        new Notice(`${room?.name ?? "A room"} was deleted by the owner/admin.`);
      },
      onAccessRevoked: (roomId) => {
        const room = this.visibleRooms.find((candidate) => candidate.id === roomId);
        this.visibleRooms = this.visibleRooms.filter((candidate) => candidate.id !== roomId);
        delete this.settings.mountedRooms[roomId];
        delete this.settings.roomMountPaths[roomId];
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
      if (roomState.serverId === server.id) {
        socket.subscribe(roomId);
      }
    }
    this.syncSocket = socket;
  }

  private async openRoomsPanel(): Promise<void> {
    await this.app.workspace.getLeaf(true).setViewState({ type: VAULT_ROOMS_VIEW_TYPE, active: true });
  }

  private apiFor(server: ServerConnection): RelayApiClient {
    return new RelayApiClient(server.baseUrl, server.deviceToken, () => this.markServerRevoked(server));
  }

  /**
   * A 401 from a server means the saved device token no longer resolves to anything there - most
   * commonly because that server's data was reset/recreated since the token was issued (fresh
   * install, wiped data dir, or switching between embedded/standalone with different data files).
   * Reflect that in the UI (Settings → Vault Rooms → Servers already shows `status`) instead of
   * leaving it as a one-off error toast with no lasting trace, so it's clear this server needs to
   * be removed and set up/joined again rather than retried.
   */
  private markServerRevoked(server: ServerConnection): void {
    if (server.status === "revoked") {
      return;
    }
    server.status = "revoked";
    void this.saveSettings();
    this.renderOpenRoomsViews();
    new Notice(`"${server.baseUrl}" - saved login is no longer valid on this server. Remove it and set up/join again from Settings → Vault Rooms → Servers.`);
  }

  private requireActiveServer(): ServerConnection {
    const server = this.getActiveServer();
    if (!server) {
      throw new Error("No active Vault Rooms server.");
    }
    return server;
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
    const config: ServerConnection = {
      id: response.device.id,
      baseUrl,
      userId: response.user.id,
      userDisplayName: response.user.displayName,
      deviceId: response.device.id,
      deviceName: response.device.displayName,
      deviceToken: response.deviceToken,
      isServerOwner: response.isServerOwner,
      status: "active"
    };
    this.settings.servers = [...this.settings.servers.filter((server) => server.id !== config.id), config];
    this.settings.activeServerId = config.id;
  }
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}
