import { FileSystemAdapter, Notice, Plugin, type ObsidianProtocolData } from "obsidian";
import { join } from "node:path";
import { isEligibleTextPath } from "@vault-rooms/protocol";
import { RelayApiClient, type AclRuleSummary, type RoomSummary, type TeamMemberSummary } from "./apiClient.js";
import { registerMountedRoomWatcher } from "./fileWatcher.js";
import { activeServer, DEFAULT_SERVER_SETTINGS, DEFAULT_SETTINGS, type RelayServerConfig, type VaultRoomsSettings } from "./settings.js";
import { EmbeddedRelayServer, type EmbeddedServerStatus } from "./serverManager.js";
import { VaultRoomsSettingTab } from "./VaultRoomsSettingTab.js";
import { CreateRoomModal } from "./modals/CreateRoomModal.js";
import { InviteMemberModal } from "./modals/InviteMemberModal.js";
import { JoinTeamModal } from "./modals/JoinTeamModal.js";
import { RoomSettingsModal } from "./modals/RoomSettingsModal.js";
import { SetupTeamModal } from "./modals/SetupTeamModal.js";
import { mountPathForRoom, type MountedRoomState, VaultSyncEngine } from "./syncClient.js";
import { RoomSyncSocket } from "./syncWsClient.js";
import { ObsidianVaultAdapter } from "./vaultAdapter.js";
import { VAULT_ROOMS_VIEW_TYPE, VaultRoomsView } from "./views/VaultRoomsView.js";
import { withInstalledCapabilities } from "./pluginCapabilities.js";

export default class VaultRoomsPlugin extends Plugin {
  settings: VaultRoomsSettings = DEFAULT_SETTINGS;
  visibleRooms: RoomSummary[] = [];
  teamMembers: TeamMemberSummary[] = [];
  private vaultAdapter!: ObsidianVaultAdapter;
  private syncEngine!: VaultSyncEngine;
  private watchedRoomStates = new WeakSet<MountedRoomState>();
  private embeddedServer: EmbeddedRelayServer | null = null;
  private syncSocket: RoomSyncSocket | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.vaultAdapter = new ObsidianVaultAdapter(this);
    this.syncEngine = new VaultSyncEngine(this.vaultAdapter, new RelayApiClient("http://127.0.0.1:8787"));
    this.addSettingTab(new VaultRoomsSettingTab(this));
    this.registerView(VAULT_ROOMS_VIEW_TYPE, (leaf) => new VaultRoomsView(leaf, this));
    this.addRibbonIcon("box", "Vault Rooms", () => this.openRoomsPanel());

    this.addCommand({
      id: "start-server",
      name: "Start Server",
      callback: () => this.startEmbeddedServer()
    });
    this.addCommand({
      id: "stop-server",
      name: "Stop Server",
      callback: () => this.stopEmbeddedServer()
    });

    if (this.settings.server.autoStart) {
      this.startEmbeddedServer().catch((error) => {
        new Notice(error instanceof Error ? `Vault Rooms server failed to start: ${error.message}` : "Vault Rooms server failed to start.");
      });
    }

    this.addCommand({
      id: "open-rooms-panel",
      name: "Open Rooms Panel",
      callback: () => this.openRoomsPanel()
    });
    this.addCommand({
      id: "setup-team",
      name: "Set Up Team",
      callback: () => this.openSetupTeamModal()
    });
    this.addCommand({
      id: "create-invite",
      name: "Create Invite",
      callback: () => this.createInvite()
    });
    this.addCommand({
      id: "create-room",
      name: "Create Room",
      callback: () => this.openCreateRoomModal()
    });
    this.addCommand({
      id: "join-team",
      name: "Join Team",
      callback: () => this.openJoinTeamModal()
    });
    this.addCommand({
      id: "rejoin-team",
      name: "Rejoin Team",
      callback: () => new JoinTeamModal(this, "rejoin", this.getActiveServer()?.baseUrl ?? "").open()
    });
    this.addCommand({
      id: "refresh-rooms",
      name: "Refresh Rooms",
      callback: () => this.refreshRooms()
    });
    this.addCommand({
      id: "mount-room",
      name: "Mount Room",
      callback: () => this.mountFirstVisibleRoom()
    });
    this.addCommand({
      id: "unmount-room",
      name: "Unmount Room",
      callback: async () => {
        const room = this.visibleRooms[0];
        if (room) {
          await this.unmountRoom(room.id);
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
      if (mode === "join" && params.server && params.token) {
        new JoinTeamModal(this, "join", params.server, params.token).open();
      } else {
        new Notice("Vault Rooms invite link is missing server/token parameters.");
      }
    };
    // Accept both obsidian://vault-rooms?mode=join&... and obsidian://vault-rooms/join?... link shapes.
    this.registerObsidianProtocolHandler("vault-rooms", handleJoinLink);
    this.registerObsidianProtocolHandler("vault-rooms/join", (params) => handleJoinLink({ ...params, mode: "join" }));

    for (const room of Object.values(this.settings.mountedRooms)) {
      this.watchMountedRoom(room.roomId);
    }

    this.connectSyncSocket();
  }

  async onunload(): Promise<void> {
    this.syncSocket?.disconnect();
    await this.embeddedServer?.stop();
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<VaultRoomsSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      server: { ...DEFAULT_SERVER_SETTINGS, ...(loaded?.server ?? {}) }
    };
  }

  getServerStatus(): EmbeddedServerStatus {
    return this.embeddedServer?.getStatus() ?? { running: false };
  }

  async startEmbeddedServer(): Promise<EmbeddedServerStatus> {
    const server = this.getOrCreateEmbeddedServer();
    const status = await server.start(this.settings.server);
    this.renderOpenRoomsViews();
    if (status.running) {
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
      this.embeddedServer = new EmbeddedRelayServer(pluginDir, dataDir);
    }
    return this.embeddedServer;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getActiveServer(): RelayServerConfig | undefined {
    return activeServer(this.settings);
  }

  async testConnection(baseUrl: string): Promise<void> {
    const result = await new RelayApiClient(baseUrl).testConnection();
    new Notice(`Connected to Vault Rooms`);
  }

  async setupTeam(baseUrl: string, teamName: string, displayName: string, deviceName: string): Promise<void> {
    const response = await new RelayApiClient(baseUrl).bootstrap(teamName, displayName, deviceName);
    this.upsertServer(baseUrl, response);
    await this.saveSettings();
    this.connectSyncSocket();
    await this.refreshTeamMembers({ notify: false }).catch(() => undefined);
    await this.openRoomsPanel();
    this.renderOpenRoomsViews();
    new Notice(`Set up ${response.team.name}`);
  }

  async joinServer(baseUrl: string, inviteToken: string, displayName: string, deviceName: string): Promise<void> {
    const response = await new RelayApiClient(baseUrl).join(inviteToken, displayName, deviceName);
    this.upsertServer(baseUrl, response);
    await this.saveSettings();
    this.connectSyncSocket();
    await this.refreshTeamMembers({ notify: false }).catch(() => undefined);
    this.renderOpenRoomsViews();
    new Notice(`Joined ${response.team.name}`);
  }

  async createInvite(role: "member" | "admin" = "member"): Promise<void> {
    const server = this.requireActiveServer();
    const invite = await this.apiFor(server).createInvite(server.teamId, role);
    new InviteMemberModal(this, `${invite.serverUrl}\n${invite.inviteToken}\n${invite.joinUrl}`, invite.joinUrl).open();
  }

  async refreshTeamMembers(options: { notify?: boolean } = {}): Promise<void> {
    const server = this.requireActiveServer();
    const result = await this.apiFor(server).listMembers(server.teamId);
    this.teamMembers = result.members;
    if (options.notify ?? true) {
      new Notice(`Loaded ${this.teamMembers.length} member(s).`);
    }
    this.renderOpenRoomsViews();
  }

  async revokeTeamMember(userId: string): Promise<void> {
    const server = this.requireActiveServer();
    await this.apiFor(server).revokeMember(server.teamId, userId);
    await this.refreshTeamMembers({ notify: false });
    new Notice("Member revoked.");
  }

  async createRoom(input: {
    name: string;
    type: "file" | "folder";
    sourcePath: string;
    mountName: string;
    capabilities: Array<{ pluginId: string; displayName: string; mode: string; minVersion?: string }>;
  }): Promise<void> {
    const server = this.requireActiveServer();
    await this.apiFor(server).createRoom(server.teamId, input);
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
      capabilities: Array<{ pluginId: string; displayName: string; mode: string; minVersion?: string }>;
    },
    localMountPath: string
  ): Promise<void> {
    const server = this.requireActiveServer();
    await this.apiFor(server).updateRoom(roomId, input);
    if (localMountPath.trim()) {
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
      subjectType: "user" | "role" | "device" | "agent";
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

  /** Owner only (enforced server-side). Deletes the entire team - all rooms, members, and invites. */
  async deleteTeam(serverId: string): Promise<void> {
    const server = this.settings.servers.find((candidate) => candidate.id === serverId);
    if (!server) {
      throw new Error("Team not found.");
    }
    const isActive = this.getActiveServer()?.id === server.id;
    await this.apiFor(server).deleteTeam(server.teamId);
    this.settings.servers = this.settings.servers.filter((candidate) => candidate.id !== server.id);
    if (this.settings.activeServerId === server.id) {
      this.settings.activeServerId = undefined;
    }
    if (isActive) {
      this.syncSocket?.disconnect();
      this.syncSocket = null;
      // Only forget local mount state for rooms that belonged to this (active) team - other
      // teams' mounted rooms, if the vault is connected to more than one team, are untouched.
      for (const room of this.visibleRooms) {
        delete this.settings.mountedRooms[room.id];
        delete this.settings.roomMountPaths[room.id];
      }
      this.visibleRooms = [];
      this.teamMembers = [];
    }
    await this.saveSettings();
    if (isActive) {
      this.connectSyncSocket();
    }
    this.renderOpenRoomsViews();
    new Notice(`Deleted team ${server.teamName}`);
  }

  /**
   * Purely local cleanup - removes a saved team/server entry without calling the server at all.
   * This is the recovery path for a team whose saved device token no longer works there (see
   * `markServerRevoked`): `deleteTeam` can't help in that case since it also needs a valid,
   * working token to authenticate the delete request. Use this to drop the stale entry, then set
   * up or join that team again to get a fresh, working identity.
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
    if (isActive) {
      this.syncSocket?.disconnect();
      this.syncSocket = null;
      this.visibleRooms = [];
      this.teamMembers = [];
    }
    await this.saveSettings();
    if (isActive) {
      this.connectSyncSocket();
    }
    this.renderOpenRoomsViews();
    new Notice(`Removed ${server.teamName} from this device.`);
  }

  async activateServer(serverId: string): Promise<void> {
    const server = this.settings.servers.find((candidate) => candidate.id === serverId);
    if (!server) {
      throw new Error("Team not found.");
    }
    this.settings.activeServerId = serverId;
    this.visibleRooms = [];
    this.teamMembers = [];
    await this.saveSettings();
    this.connectSyncSocket();
    await Promise.all([this.refreshRooms({ notify: false }), this.refreshTeamMembers({ notify: false })]).catch((error) => {
      new Notice(error instanceof Error ? error.message : "Failed to load team");
    });
    this.renderOpenRoomsViews();
    new Notice(`Using ${server.teamName}`);
  }

  async refreshRooms(options: { notify?: boolean } = {}): Promise<void> {
    const server = this.requireActiveServer();
    const result = await this.apiFor(server).listRooms(server.teamId);
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
    const server = this.requireActiveServer();
    const mountPath = this.roomMountPathFor(room);
    const state = (this.settings.mountedRooms[room.id] = this.settings.mountedRooms[room.id] ?? {
      roomId: room.id,
      mountPath,
      files: {}
    });
    state.mountPath = mountPath;
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
      if (!relativePath || knownRelativePaths.has(relativePath) || !isEligibleTextPath(relativePath)) {
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

  async unmountRoom(roomId: string): Promise<void> {
    const room = this.visibleRooms.find((candidate) => candidate.id === roomId);
    delete this.settings.mountedRooms[roomId];
    await this.saveSettings();
    this.renderOpenRoomsViews();
    new Notice(`Unmounted ${room?.name ?? "room"}`);
  }

  isRoomMounted(roomId: string): boolean {
    return Boolean(this.settings.mountedRooms[roomId]);
  }

  mountedPathFor(roomId: string): string | undefined {
    return this.settings.mountedRooms[roomId]?.mountPath;
  }

  /**
   * The room owner's device mounts in place at the room's real `sourcePath` (their existing vault
   * folder) - there's nothing to "download," their files already live there, so a separate copy
   * would just be an empty shadow folder that never gets used. Everyone else mounts into a fresh
   * folder under the configured mount root, since they have no pre-existing copy of the room.
   */
  roomMountPathFor(room: RoomSummary): string {
    const configured = this.settings.roomMountPaths[room.id]?.trim();
    if (configured) {
      return configured;
    }
    const server = this.requireActiveServer();
    const isOwner = room.ownerUserId === server.userId;
    return mountPathForRoom({
      owner: isOwner,
      mountRoot: this.settings.mountRoot,
      teamSlug: server.teamSlug,
      mountName: room.mountName,
      sourcePath: room.sourcePath
    });
  }

  openSetupTeamModal(): void {
    const status = this.getServerStatus();
    new SetupTeamModal(this, status.running ? status.localUrl : undefined).open();
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
    if (!roomState || !server) {
      return;
    }
    if (this.watchedRoomStates.has(roomState)) {
      return;
    }
    this.watchedRoomStates.add(roomState);
    registerMountedRoomWatcher(this.vaultAdapter, roomState, (event, relativePath) => {
      if (this.settings.mountedRooms[roomId] !== roomState) {
        return;
      }
      window.setTimeout(() => {
        if (this.settings.mountedRooms[roomId] !== roomState) {
          return;
        }
        if (event.type === "delete") {
          return;
        }
        void this.syncEngine.pushLocalChange(roomState, relativePath, server.deviceName).then(() => this.saveSettings());
      }, this.settings.debounceMs);
    });
  }

  /**
   * Rebinds the sync engine's API client to the active server and (re)connects the live
   * WebSocket sync subscription, so remote edits from teammates apply locally without waiting
   * for a manual re-mount. Call this any time the active server changes (setup, join, switch
   * team) - `syncEngine` is otherwise only bound once at onload and would keep pushing to a
   * stale/unauthenticated client. Safe to call repeatedly; it tears down any previous connection.
   */
  private connectSyncSocket(): void {
    this.syncSocket?.disconnect();
    this.syncSocket = null;
    const server = this.getActiveServer();
    this.syncEngine = new VaultSyncEngine(this.vaultAdapter, server ? this.apiFor(server) : new RelayApiClient("http://127.0.0.1:8787"));
    if (!server) {
      return;
    }
    const socket = new RoomSyncSocket(server, {
      getMountedRoom: (roomId) => this.settings.mountedRooms[roomId],
      getApi: () => this.apiFor(server),
      syncEngine: this.syncEngine,
      onApplied: () => {
        void this.saveSettings();
        this.renderOpenRoomsViews();
      },
      onRevoked: () => {
        new Notice(`Your access to ${server.teamName} was revoked.`);
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
      }
    });
    socket.connect();
    for (const roomId of Object.keys(this.settings.mountedRooms)) {
      socket.subscribe(roomId);
    }
    this.syncSocket = socket;
  }

  private async openRoomsPanel(): Promise<void> {
    await this.app.workspace.getLeaf(true).setViewState({ type: VAULT_ROOMS_VIEW_TYPE, active: true });
  }

  private apiFor(server: RelayServerConfig): RelayApiClient {
    return new RelayApiClient(server.baseUrl, server.deviceToken, () => this.markServerRevoked(server));
  }

  /**
   * A 401 from a server means the saved device token no longer resolves to anything there - most
   * commonly because that server's data was reset/recreated since the token was issued (fresh
   * install, wiped data dir, or switching between embedded/standalone with different data files).
   * Reflect that in the UI (Settings → Vault Rooms → Teams already shows `status`) instead of
   * leaving it as a one-off error toast with no lasting trace, so it's clear this team needs to be
   * removed and set up/joined again rather than retried.
   */
  private markServerRevoked(server: RelayServerConfig): void {
    if (server.status === "revoked") {
      return;
    }
    server.status = "revoked";
    void this.saveSettings();
    this.renderOpenRoomsViews();
    new Notice(`"${server.teamName}" - saved login is no longer valid on this server. Remove it and set up/join the team again from Settings → Vault Rooms → Teams.`);
  }

  private requireActiveServer(): RelayServerConfig {
    const server = this.getActiveServer();
    if (!server) {
      throw new Error("No active Vault Rooms server.");
    }
    return server;
  }

  private upsertServer(baseUrl: string, response: any): void {
    const config: RelayServerConfig = {
      id: response.device.id,
      baseUrl,
      teamId: response.team.id,
      teamName: response.team.name,
      teamSlug: response.team.slug,
      userId: response.user.id,
      userDisplayName: response.user.displayName,
      deviceId: response.device.id,
      deviceName: response.device.displayName,
      deviceToken: response.deviceToken,
      status: "active",
      role: response.role
    };
    this.settings.servers = [...this.settings.servers.filter((server) => server.id !== config.id), config];
    this.settings.activeServerId = config.id;
  }
}
