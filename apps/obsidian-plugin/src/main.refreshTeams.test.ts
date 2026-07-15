import { describe, expect, it, vi } from "vitest";
import VaultRoomsPlugin from "./main.js";
import type { RelayApiClient } from "./apiClient.js";
import type { ServerConnection, VaultRoomsSettings } from "./settings.js";

vi.mock("obsidian", () => ({
  Notice: class Notice {},
  Plugin: class Plugin {},
  normalizePath: (path: string) => path,
  requestUrl: vi.fn()
}));
vi.mock("./controllers/ServerConnectionManager.js", () => ({
  ServerConnectionManager: class ServerConnectionManager {}
}));
vi.mock("./VaultRoomsSettingTab.js", () => ({ VaultRoomsSettingTab: class VaultRoomsSettingTab {} }));
vi.mock("./modals/ConfirmModal.js", () => ({ confirmModal: vi.fn() }));
vi.mock("./modals/CreateRoomModal.js", () => ({ CreateRoomModal: class CreateRoomModal {} }));
vi.mock("./modals/CreateInviteModal.js", () => ({ CreateInviteModal: class CreateInviteModal {} }));
vi.mock("./modals/InviteMemberModal.js", () => ({ InviteMemberModal: class InviteMemberModal {} }));
vi.mock("./modals/JoinTeamModal.js", () => ({ JoinTeamModal: class JoinTeamModal {} }));
vi.mock("./modals/RoomSettingsModal.js", () => ({ RoomSettingsModal: class RoomSettingsModal {} }));
vi.mock("./modals/SetupTeamModal.js", () => ({ SetupTeamModal: class SetupTeamModal {} }));
vi.mock("./views/VaultRoomsView.js", () => ({
  VAULT_ROOMS_VIEW_TYPE: "vault-rooms",
  VaultRoomsView: class VaultRoomsView {}
}));

describe("VaultRoomsPlugin.refreshTeams", () => {
  it("persists authoritative serverId and owner status returned by /api/me", async () => {
    const server: ServerConnection = {
      id: "dev_1",
      baseUrl: "http://127.0.0.1:8787",
      userId: "usr_1",
      userDisplayName: "Owner",
      deviceId: "dev_1",
      deviceName: "Laptop",
      deviceToken: "token",
      isServerOwner: false,
      status: "active",
      securityMode: "plain",
      serverId: "srv_stale"
    };
    const settings: VaultRoomsSettings = {
      servers: [server],
      activeServerId: server.id,
      mountRoot: "Vault Rooms",
      debounceMs: 300,
      mountedRooms: {},
      roomMountPaths: {},
      server: { maxFileBytes: 1024, autoStart: false }
    };
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const api = {
      me: vi.fn().mockResolvedValue({
        serverId: "srv_authoritative",
        user: { id: "usr_1", displayName: "Owner" },
        device: { id: "dev_1", displayName: "Laptop" },
        isServerOwner: true,
        teams: []
      }),
      listTeams: vi.fn().mockResolvedValue({ teams: [] }),
      listTeamDirectory: vi.fn().mockResolvedValue({ teams: [] }),
      listFriends: vi.fn().mockResolvedValue({ friends: [] }),
      listMembers: vi.fn()
    } as unknown as RelayApiClient;
    const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
    plugin.settings = settings;
    plugin.teams = [];
    plugin.teamDirectory = [];
    plugin.friends = [];
    plugin.myTeamRoles = {};
    plugin.teamMembersByTeam = {};
    const internals = plugin as unknown as {
      requireActiveServer: () => ServerConnection;
      apiFor: () => RelayApiClient;
      saveSettings: () => Promise<void>;
      renderOpenRoomsViews: () => void;
    };
    internals.requireActiveServer = () => server;
    internals.apiFor = () => api;
    internals.saveSettings = saveSettings;
    internals.renderOpenRoomsViews = vi.fn();

    await plugin.refreshTeams({ notify: false });

    expect(server).toEqual(expect.objectContaining({
      serverId: "srv_authoritative",
      isServerOwner: true
    }));
    expect(saveSettings).toHaveBeenCalledOnce();
  });
});
