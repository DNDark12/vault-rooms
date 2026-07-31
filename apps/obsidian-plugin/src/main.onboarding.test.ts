import { beforeEach, describe, expect, it, vi } from "vitest";
import VaultRoomsPlugin from "./main.js";
import type { InviteLinkResponse, RelayApiClient, RoomSummary } from "./apiClient.js";
import { recommendedRoomInput } from "./onboarding.js";
import type { EmbeddedServerStatus } from "./serverManager.js";
import type { ServerConnection, VaultRoomsSettings } from "./settings.js";

const modalMocks = vi.hoisted(() => ({
  open: vi.fn(),
  guidedOpen: vi.fn(),
  recoveryOpen: vi.fn()
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
vi.mock("./modals/GuidedOnboardingModal.js", () => ({
  GuidedOnboardingModal: class GuidedOnboardingModal {
    open(): void {
      modalMocks.guidedOpen();
    }
  }
}));
vi.mock("./modals/InviteMemberModal.js", () => ({
  InviteMemberModal: class InviteMemberModal {
    open(): void {
      modalMocks.open();
    }
  }
}));
vi.mock("./modals/JoinTeamModal.js", () => ({ JoinTeamModal: class JoinTeamModal {} }));
vi.mock("./modals/RoomSettingsModal.js", () => ({ RoomSettingsModal: class RoomSettingsModal {} }));
vi.mock("./modals/SetupTeamModal.js", () => ({
  SetupTeamModal: class SetupTeamModal {
    open(): void {
      modalMocks.recoveryOpen();
    }
  }
}));
vi.mock("./views/VaultRoomsView.js", () => ({
  VAULT_ROOMS_VIEW_TYPE: "vault-rooms",
  VaultRoomsView: class VaultRoomsView {}
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VaultRoomsPlugin guided onboarding orchestration", () => {
  it("rejects loopback before settings or server side effects", async () => {
    const harness = onboardingPlugin({ running: false });

    await expect(harness.plugin.configureOnboardingConnection("127.0.0.1")).rejects.toThrow(/teammate/i);

    expect(harness.saveSettings).not.toHaveBeenCalled();
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.assertReachable).not.toHaveBeenCalled();
  });

  it("persists the address, verifies it, then enables automatic startup", async () => {
    const harness = onboardingPlugin({ running: true });

    await harness.plugin.configureOnboardingConnection("192.168.1.49");

    expect(harness.events).toEqual([
      "save:192.168.1.49:false",
      "stop:false",
      "start:false",
      "assert-reachable",
      "save:192.168.1.49:true"
    ]);
    expect(harness.plugin.settings.server.autoStart).toBe(true);
  });

  it("keeps automatic startup off when the fresh LAN requirement fails", async () => {
    const harness = onboardingPlugin({
      running: false,
      reachabilityError: new Error("LAN share URL is unreachable")
    });

    await expect(harness.plugin.configureOnboardingConnection("192.168.1.49")).rejects.toThrow(
      "LAN share URL is unreachable"
    );

    expect(harness.plugin.settings.server.publicUrlOverride).toBe("192.168.1.49");
    expect(harness.plugin.settings.server.autoStart).toBe(false);
  });

  it("requires explicit acknowledgement before enabling a link-local address", async () => {
    const harness = onboardingPlugin({ running: false });

    await expect(harness.plugin.configureOnboardingConnection("169.254.10.20")).resolves.toMatchObject({
      class: "link-local",
      warning: expect.any(String)
    });

    expect(harness.plugin.settings.server.publicUrlOverride).toBe("169.254.10.20");
    expect(harness.plugin.settings.server.autoStart).toBe(false);
    expect(harness.events).toEqual([
      "save:169.254.10.20:false",
      "start:false",
      "assert-reachable"
    ]);

    await harness.plugin.confirmOnboardingConnection();

    expect(harness.plugin.settings.server.autoStart).toBe(true);
    expect(harness.events.at(-1)).toBe("save:169.254.10.20:true");
  });

  it("returns the created room after refreshing visible rooms", async () => {
    const room = roomSummary({ id: "room_1", name: "Alpha" });
    const harness = roomAndInvitePlugin({
      createRoomResult: { room },
      createInviteResult: inviteResponse()
    });

    await expect(harness.plugin.createRoom(recommendedRoomInput("Projects/Alpha"))).resolves.toMatchObject(room);
    expect(harness.refreshRooms).toHaveBeenCalledOnce();
  });

  it("does not make a committed room creation look retryable when the list refresh fails", async () => {
    const room = roomSummary({ id: "room_1", name: "Alpha" });
    const harness = roomAndInvitePlugin({
      createRoomResult: { room },
      createInviteResult: inviteResponse(),
      refreshError: new Error("offline during refresh")
    });

    await expect(
      harness.plugin.createRoom(recommendedRoomInput("Projects/Alpha"))
    ).resolves.toEqual(room);
    expect(harness.plugin.visibleRooms).toContainEqual(room);
  });

  it("recovers a room committed before an ambiguous create response failed", async () => {
    const input = recommendedRoomInput("Projects/Alpha");
    const room = roomSummary({
      id: "room_1",
      name: "Alpha",
      capabilities: input.capabilities.map((capability) => ({
        ...capability,
        installed: null
      }))
    });
    const harness = roomAndInvitePlugin({
      createRoomError: new Error("connection closed before the response"),
      createInviteResult: inviteResponse(),
      roomsAfterRefresh: [room]
    });

    await expect(harness.plugin.createRoom(input)).resolves.toEqual(room);
    expect(harness.createRoom).toHaveBeenCalledOnce();
    expect(harness.refreshRooms).toHaveBeenCalledOnce();
  });

  it("returns an invite URL only after the own-server LAN gate", async () => {
    const invite = inviteResponse();
    const harness = roomAndInvitePlugin({ createInviteResult: invite });

    await expect(harness.plugin.issueRoomInvite("room_1", "editor")).resolves.toEqual(invite);
    expect(harness.events).toEqual(["assert-reachable", "create-room-invite"]);
    expect(modalMocks.open).not.toHaveBeenCalled();
  });

  it("opens guided setup for a fresh embedded host", () => {
    const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
    const internals = plugin as unknown as {
      getServerStatus: () => EmbeddedServerStatus;
      hasOwnServer: () => boolean;
    };
    internals.getServerStatus = () => ({ running: false });
    internals.hasOwnServer = () => false;

    plugin.openSetupServerModal();

    expect(modalMocks.guidedOpen).toHaveBeenCalledOnce();
    expect(modalMocks.recoveryOpen).not.toHaveBeenCalled();
  });

  it("routes a bootstrapped host with no local owner credential to recovery", () => {
    const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
    const internals = plugin as unknown as {
      getServerStatus: () => EmbeddedServerStatus;
      hasOwnServer: () => boolean;
    };
    internals.getServerStatus = () => runningStatus({ bootstrapped: true });
    internals.hasOwnServer = () => false;

    plugin.openSetupServerModal();

    expect(modalMocks.recoveryOpen).toHaveBeenCalledOnce();
    expect(modalMocks.guidedOpen).not.toHaveBeenCalled();
  });
});

function onboardingPlugin(input: {
  running: boolean;
  reachabilityError?: Error;
}): {
  plugin: VaultRoomsPlugin;
  events: string[];
  saveSettings: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  assertReachable: ReturnType<typeof vi.fn>;
} {
  const events: string[] = [];
  const settings: VaultRoomsSettings = {
    servers: [],
    mountRoot: "Vault Rooms",
    debounceMs: 300,
    mountedRooms: {},
    roomMountPaths: {},
    server: { maxFileBytes: 1024, autoStart: false }
  };
  const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
  plugin.settings = settings;

  const saveSettings = vi.fn(async () => {
    events.push(`save:${settings.server.publicUrlOverride ?? ""}:${settings.server.autoStart}`);
  });
  let running = input.running;
  const start = vi.fn(async (options?: { notify?: boolean }) => {
    events.push(`start:${String(options?.notify)}`);
    running = true;
    return { running: true, localUrl: "http://127.0.0.1:8787" } as EmbeddedServerStatus;
  });
  const stop = vi.fn(async (options?: { notify?: boolean }) => {
    events.push(`stop:${String(options?.notify)}`);
    running = false;
  });
  const assertReachable = vi.fn(async () => {
    events.push("assert-reachable");
    if (input.reachabilityError) {
      throw input.reachabilityError;
    }
  });

  const internals = plugin as unknown as {
    saveSettings: () => Promise<void>;
    getServerStatus: () => EmbeddedServerStatus;
    startEmbeddedServer: (options?: { notify?: boolean }) => Promise<EmbeddedServerStatus>;
    stopEmbeddedServer: (options?: { notify?: boolean }) => Promise<void>;
    serverConnectionManager: { assertLanShareReachable: () => Promise<void> };
  };
  internals.saveSettings = saveSettings;
  internals.getServerStatus = () =>
    running
      ? ({
          running: true,
          host: "127.0.0.1",
          port: 8787,
          localUrl: "http://127.0.0.1:8787",
          securityMode: "plain",
          bootstrapped: false,
          serverId: "srv_1",
          legacyV01BackupAvailable: false,
          securityState: "plain_legacy"
        })
      : { running: false };
  internals.startEmbeddedServer = start;
  internals.stopEmbeddedServer = stop;
  internals.serverConnectionManager = { assertLanShareReachable: assertReachable };

  return { plugin, events, saveSettings, start, assertReachable };
}

function roomAndInvitePlugin(input: {
  createRoomResult?: { room: RoomSummary };
  createRoomError?: Error;
  createInviteResult: InviteLinkResponse;
  refreshError?: Error;
  roomsAfterRefresh?: RoomSummary[];
}): {
  plugin: VaultRoomsPlugin;
  events: string[];
  createRoom: ReturnType<typeof vi.fn>;
  refreshRooms: ReturnType<typeof vi.fn>;
} {
  const events: string[] = [];
  const server = serverConnection();
  const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
  plugin.visibleRooms = [];
  plugin.settings = {
    servers: [server],
    activeServerId: server.id,
    mountRoot: "Vault Rooms",
    debounceMs: 300,
    mountedRooms: {},
    roomMountPaths: {},
    server: { maxFileBytes: 1024, autoStart: true, publicUrlOverride: "192.168.1.49" }
  };
  const refreshRooms = input.refreshError
    ? vi.fn().mockRejectedValue(input.refreshError)
    : vi.fn(async () => {
        if (input.roomsAfterRefresh) {
          plugin.visibleRooms = input.roomsAfterRefresh;
        }
      });
  const createRoom = input.createRoomError
    ? vi.fn().mockRejectedValue(input.createRoomError)
    : vi.fn().mockResolvedValue(input.createRoomResult);
  const api = {
    createRoom,
    createRoomInvite: vi.fn(async () => {
      events.push("create-room-invite");
      return input.createInviteResult;
    })
  };
  const internals = plugin as unknown as {
    requireActiveServer: () => ServerConnection;
    apiFor: () => RelayApiClient;
    refreshRooms: () => Promise<void>;
    renderOpenRoomsViews: () => void;
    assertInviteServerReachable: (server: ServerConnection) => Promise<void>;
  };
  internals.requireActiveServer = () => server;
  internals.apiFor = () => api as unknown as RelayApiClient;
  internals.refreshRooms = refreshRooms;
  internals.renderOpenRoomsViews = vi.fn();
  internals.assertInviteServerReachable = vi.fn(async () => {
    events.push("assert-reachable");
  });
  return { plugin, events, createRoom, refreshRooms };
}

function serverConnection(): ServerConnection {
  return {
    id: "dev_1",
    baseUrl: "http://127.0.0.1:8787",
    userId: "usr_1",
    userDisplayName: "Owner",
    deviceId: "dev_1",
    deviceName: "Laptop",
    deviceToken: "token",
    isServerOwner: true,
    status: "active",
    securityMode: "plain",
    appliedRotationIds: []
  };
}

function roomSummary(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: "room_1",
    name: "Alpha",
    type: "folder",
    sourcePath: "Projects/Alpha",
    mountName: "Alpha",
    ownerUserId: "usr_1",
    conflictPolicy: "keep_both",
    permissions: ["room:read", "room:write", "file:read", "file:write", "sync:subscribe", "sync:push"],
    capabilities: [],
    crdtEnabled: false,
    ...overrides
  };
}

function inviteResponse(): InviteLinkResponse {
  return {
    inviteId: "inv_1",
    inviteToken: "opaque-token",
    serverUrl: "https://192.168.1.49:8788",
    joinUrl: "obsidian://vault-rooms/join?payload=relay-owned"
  };
}

function runningStatus(
  overrides: Partial<Extract<EmbeddedServerStatus, { running: true }>> = {}
): Extract<EmbeddedServerStatus, { running: true }> {
  return {
    running: true,
    host: "127.0.0.1",
    port: 8787,
    localUrl: "http://127.0.0.1:8787",
    securityMode: "plain",
    bootstrapped: false,
    serverId: "srv_1",
    legacyV01BackupAvailable: false,
    securityState: "plain_legacy",
    ...overrides
  };
}
