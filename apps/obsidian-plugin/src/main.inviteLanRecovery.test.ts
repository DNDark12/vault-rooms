import { beforeEach, describe, expect, it, vi } from "vitest";
import VaultRoomsPlugin from "./main.js";
import type { PinnedInviteInfo } from "./pinnedTransport.js";
import type { ServerConnection, VaultRoomsSettings } from "./settings.js";

const apiMocks = vi.hoisted(() => ({ join: vi.fn(), constructed: [] as string[] }));

vi.mock("obsidian", () => ({
  Notice: class Notice {
    constructor(public readonly message?: string) {}
  },
  Plugin: class Plugin {},
  normalizePath: (path: string) => path,
  requestUrl: vi.fn()
}));
vi.mock("./apiClient.js", () => ({
  RelayApiClient: class RelayApiClient {
    constructor(baseUrl: string) {
      apiMocks.constructed.push(baseUrl);
      this.baseUrl = baseUrl;
    }
    private readonly baseUrl: string;
    join(...args: unknown[]): Promise<unknown> {
      return apiMocks.join(this.baseUrl, ...args);
    }
  }
}));
vi.mock("./pinnedTransport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pinnedTransport.js")>()),
  assertPinMaterial: vi.fn()
}));
vi.mock("./controllers/ServerConnectionManager.js", () => ({
  ServerConnectionManager: class ServerConnectionManager {}
}));
vi.mock("./VaultRoomsSettingTab.js", () => ({ VaultRoomsSettingTab: class VaultRoomsSettingTab {} }));
vi.mock("./modals/ConfirmModal.js", () => ({ confirmModal: vi.fn() }));
vi.mock("./modals/CreateRoomModal.js", () => ({ CreateRoomModal: class CreateRoomModal {} }));
vi.mock("./modals/CreateInviteModal.js", () => ({ CreateInviteModal: class CreateInviteModal {} }));
vi.mock("./modals/GuidedOnboardingModal.js", () => ({ GuidedOnboardingModal: class GuidedOnboardingModal {} }));
vi.mock("./modals/InviteMemberModal.js", () => ({ InviteMemberModal: class InviteMemberModal {} }));
vi.mock("./modals/JoinTeamModal.js", () => ({ JoinTeamModal: class JoinTeamModal {} }));
vi.mock("./modals/RoomSettingsModal.js", () => ({ RoomSettingsModal: class RoomSettingsModal {} }));
vi.mock("./modals/SetupTeamModal.js", () => ({ SetupTeamModal: class SetupTeamModal {} }));
vi.mock("./views/VaultRoomsView.js", () => ({
  VAULT_ROOMS_VIEW_TYPE: "vault-rooms",
  VaultRoomsView: class VaultRoomsView {}
}));

const pin: PinnedInviteInfo = {
  serverId: "srv_1",
  tlsName: "srv-1.vault-rooms.internal",
  identityCertificateDer: "certificate",
  pinnedIdentitySpkiSha256: "fingerprint"
};

const joinResponse = {
  user: { id: "usr_1", displayName: "Guest" },
  device: { id: "dev_1", name: "Laptop" },
  deviceToken: "tok",
  inviteType: "team" as const,
  team: { id: "team_1", name: "Notes" }
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.constructed = [];
});

describe("pinned invite joins recover a moved endpoint without asking", () => {
  it("finds the server on the LAN and joins there when the advertised address is unreachable", async () => {
    apiMocks.join.mockImplementation((baseUrl: string) =>
      baseUrl === "https://sake.local:8788"
        ? Promise.reject(new Error("net::ERR_NAME_NOT_RESOLVED"))
        : Promise.resolve(joinResponse)
    );
    const { plugin, internals } = createPlugin();

    await plugin.joinServer("https://sake.local:8788", "tr_inv_secret", "Guest", "Laptop", pin);

    expect(internals.serverConnectionManager.findInviteServerOnLan).toHaveBeenCalledWith(
      pin,
      "https://sake.local:8788"
    );
    // The discovered address is what gets saved and connected to, not the one from the link.
    expect(apiMocks.constructed).toEqual(["https://sake.local:8788", "https://192.168.1.9:8788"]);
    expect(internals.upsertServer).toHaveBeenCalledWith("https://192.168.1.9:8788", joinResponse, pin);
    expect(internals.saveSettings).toHaveBeenCalledOnce();
    expect(internals.connectSyncSocket).toHaveBeenCalledOnce();
  });

  it("never scans when the advertised address answers", async () => {
    apiMocks.join.mockResolvedValue(joinResponse);
    const { plugin, internals } = createPlugin();

    await plugin.joinServer("https://sake.local:8788", "tr_inv_secret", "Guest", "Laptop", pin);

    expect(internals.serverConnectionManager.findInviteServerOnLan).not.toHaveBeenCalled();
    expect(internals.upsertServer).toHaveBeenCalledWith("https://sake.local:8788", joinResponse, pin);
  });

  it("never scans for a plain invite, which carries no verifiable identity", async () => {
    apiMocks.join.mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"));
    const { plugin, internals } = createPlugin();

    await expect(
      plugin.joinServer("http://192.168.1.9:8787", "tr_inv_secret", "Guest", "Laptop")
    ).rejects.toThrow("net::ERR_CONNECTION_REFUSED");

    expect(internals.serverConnectionManager.findInviteServerOnLan).not.toHaveBeenCalled();
    expect(internals.upsertServer).not.toHaveBeenCalled();
  });

  it("does not scan for a failure the relay itself answered", async () => {
    apiMocks.join.mockRejectedValue(Object.assign(new Error("Invite expired."), { code: "VALIDATION_ERROR" }));
    const { plugin, internals } = createPlugin();

    await expect(
      plugin.joinServer("https://sake.local:8788", "tr_inv_secret", "Guest", "Laptop", pin)
    ).rejects.toThrow("Invite expired.");

    expect(internals.serverConnectionManager.findInviteServerOnLan).not.toHaveBeenCalled();
  });

  it("reports the advertised address, not the discovery miss, when nothing responds", async () => {
    apiMocks.join.mockRejectedValue(new Error("net::ERR_NAME_NOT_RESOLVED"));
    const { plugin, internals } = createPlugin();
    internals.serverConnectionManager.findInviteServerOnLan.mockRejectedValue(
      new Error("No matching Vault Rooms server responded on this LAN.")
    );

    await expect(
      plugin.joinServer("https://sake.local:8788", "tr_inv_secret", "Guest", "Laptop", pin)
    ).rejects.toThrow("net::ERR_NAME_NOT_RESOLVED");

    expect(internals.upsertServer).not.toHaveBeenCalled();
  });

  it("recovers an already-saved identity's invite with no confirmation prompt", async () => {
    const saved = serverConnection();
    const { plugin, internals } = createPlugin([saved]);
    internals.serverConnectionManager.acceptInviteForServer.mockImplementation((_s, _t, baseUrl: string) =>
      baseUrl === "https://sake.local:8788"
        ? Promise.reject(Object.assign(new Error("Request timed out."), { code: "ETIMEDOUT" }))
        : Promise.resolve({ inviteType: "team" })
    );

    const recovery = (
      plugin as unknown as {
        withInviteLanRecovery: (
          pin: PinnedInviteInfo,
          baseUrl: string,
          attempt: (baseUrl: string) => Promise<unknown>
        ) => Promise<unknown>;
      }
    ).withInviteLanRecovery.bind(plugin);

    await recovery(pin, "https://sake.local:8788", (baseUrl) =>
      internals.serverConnectionManager.acceptInviteForServer(saved, "tr_inv_secret", baseUrl, pin)
    );

    const { confirmModal } = await import("./modals/ConfirmModal.js");
    expect(confirmModal).not.toHaveBeenCalled();
    expect(internals.serverConnectionManager.acceptInviteForServer).toHaveBeenLastCalledWith(
      saved,
      "tr_inv_secret",
      "https://192.168.1.9:8788",
      pin
    );
  });
});

function createPlugin(servers: ServerConnection[] = []) {
  const settings: VaultRoomsSettings = {
    servers,
    activeServerId: servers[0]?.id,
    mountRoot: "Vault Rooms",
    debounceMs: 300,
    mountedRooms: {},
    roomMountPaths: {},
    server: { maxFileBytes: 1024, autoStart: false }
  };
  const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
  plugin.settings = settings;
  const internals = {
    serverConnectionManager: {
      findInviteServerOnLan: vi.fn().mockResolvedValue("https://192.168.1.9:8788"),
      acceptInviteForServer: vi.fn()
    },
    upsertServer: vi.fn(),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    connectSyncSocket: vi.fn(),
    refreshTeams: vi.fn().mockResolvedValue(undefined),
    refreshRooms: vi.fn().mockResolvedValue(undefined),
    renderOpenRoomsViews: vi.fn()
  };
  Object.assign(plugin, internals);
  return { plugin, internals };
}

function serverConnection(): ServerConnection {
  return {
    id: "dev_1",
    baseUrl: "https://sake.local:8788",
    userId: "usr_1",
    userDisplayName: "Guest",
    deviceId: "dev_1",
    deviceName: "Laptop",
    deviceToken: "token",
    isServerOwner: false,
    status: "active",
    securityMode: "pinned-tls",
    serverId: "srv_1",
    appliedRotationIds: []
  };
}
