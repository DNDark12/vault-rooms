import { beforeEach, describe, expect, it, vi } from "vitest";
import VaultRoomsPlugin from "./main.js";
import type { RelayApiClient } from "./apiClient.js";
import type { ServerConnection, VaultRoomsSettings } from "./settings.js";

const modalMocks = vi.hoisted(() => ({
  open: vi.fn()
}));

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
vi.mock("./modals/InviteMemberModal.js", () => ({
  InviteMemberModal: class InviteMemberModal {
    open(): void {
      modalMocks.open();
    }
  }
}));
vi.mock("./modals/JoinTeamModal.js", () => ({ JoinTeamModal: class JoinTeamModal {} }));
vi.mock("./modals/RoomSettingsModal.js", () => ({ RoomSettingsModal: class RoomSettingsModal {} }));
vi.mock("./modals/SetupTeamModal.js", () => ({ SetupTeamModal: class SetupTeamModal {} }));
vi.mock("./views/VaultRoomsView.js", () => ({
  VAULT_ROOMS_VIEW_TYPE: "vault-rooms",
  VaultRoomsView: class VaultRoomsView {}
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VaultRoomsPlugin invite LAN reachability gate", () => {
  it.each([
    ["team", (plugin: VaultRoomsPlugin) => plugin.createInvite("team_1")],
    ["room", (plugin: VaultRoomsPlugin) => plugin.createRoomInvite("room_1", "reader")],
    ["friend", (plugin: VaultRoomsPlugin) => plugin.createFriendInvite()]
  ])("blocks an own-server %s invite before issuing a token", async (_kind, createInvite) => {
    const server = serverConnection("http://127.0.0.1:8787", true);
    const api = inviteApi();
    const assertLanShareReachable = vi.fn().mockRejectedValue(new Error("LAN share URL is unreachable"));
    const plugin = createPlugin(server, api, assertLanShareReachable);

    await expect(createInvite(plugin)).rejects.toThrow("LAN share URL is unreachable");

    expect(assertLanShareReachable).toHaveBeenCalledOnce();
    expect(api.createInvite).not.toHaveBeenCalled();
    expect(api.createRoomInvite).not.toHaveBeenCalled();
    expect(api.createFriendInvite).not.toHaveBeenCalled();
    expect(modalMocks.open).not.toHaveBeenCalled();
  });

  it("does not apply the same-process LAN gate to a remote active server", async () => {
    const server = serverConnection("https://relay.example", true);
    const api = inviteApi();
    const assertLanShareReachable = vi.fn();
    const plugin = createPlugin(server, api, assertLanShareReachable);

    await plugin.createFriendInvite();

    expect(assertLanShareReachable).not.toHaveBeenCalled();
    expect(api.createFriendInvite).toHaveBeenCalledOnce();
    expect(modalMocks.open).toHaveBeenCalledOnce();
  });

  it("issues an own-server invite after the fresh LAN assertion succeeds", async () => {
    const server = serverConnection("http://127.0.0.1:8787", true);
    const api = inviteApi();
    const assertLanShareReachable = vi.fn().mockResolvedValue(undefined);
    const plugin = createPlugin(server, api, assertLanShareReachable);

    await plugin.createFriendInvite();

    expect(assertLanShareReachable).toHaveBeenCalledOnce();
    expect(api.createFriendInvite).toHaveBeenCalledOnce();
    expect(modalMocks.open).toHaveBeenCalledOnce();
  });
});

function createPlugin(
  server: ServerConnection,
  api: ReturnType<typeof inviteApi>,
  assertLanShareReachable: () => Promise<void>
): VaultRoomsPlugin {
  const settings: VaultRoomsSettings = {
    servers: [server],
    activeServerId: server.id,
    mountRoot: "Vault Rooms",
    debounceMs: 300,
    mountedRooms: {},
    roomMountPaths: {},
    server: { maxFileBytes: 1024, autoStart: false }
  };
  const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
  plugin.settings = settings;
  const internals = plugin as unknown as {
    serverConnectionManager: {
      assertLanShareReachable: () => Promise<void>;
    };
    requireActiveServer: () => ServerConnection;
    apiFor: () => RelayApiClient;
  };
  internals.serverConnectionManager = { assertLanShareReachable };
  internals.requireActiveServer = () => server;
  internals.apiFor = () => api as unknown as RelayApiClient;
  return plugin;
}

function inviteApi() {
  const result = { inviteId: "inv_1", inviteToken: "secret", serverUrl: "http://lan", joinUrl: "obsidian://invite" };
  return {
    createInvite: vi.fn().mockResolvedValue(result),
    createRoomInvite: vi.fn().mockResolvedValue(result),
    createFriendInvite: vi.fn().mockResolvedValue(result)
  };
}

function serverConnection(baseUrl: string, isServerOwner: boolean): ServerConnection {
  return {
    id: "dev_1",
    baseUrl,
    userId: "usr_1",
    userDisplayName: "Owner",
    deviceId: "dev_1",
    deviceName: "Laptop",
    deviceToken: "token",
    isServerOwner,
    status: "active",
    securityMode: baseUrl.startsWith("https://") ? "os-trusted-tls" : "plain",
    appliedRotationIds: []
  };
}
