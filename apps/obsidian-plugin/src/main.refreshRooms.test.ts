import { describe, expect, it, vi } from "vitest";
import VaultRoomsPlugin from "./main.js";
import type { RelayApiClient, RoomSummary } from "./apiClient.js";
import type { ServerConnection, VaultRoomsSettings } from "./settings.js";
import type { MountedRoomState } from "./syncClient.js";

vi.mock("obsidian", () => ({
  Notice: class Notice {},
  Plugin: class Plugin {},
  normalizePath: (path: string) => path,
  requestUrl: vi.fn()
}));
vi.mock("./controllers/ServerConnectionManager.js", () => ({ ServerConnectionManager: class ServerConnectionManager {} }));
vi.mock("./VaultRoomsSettingTab.js", () => ({ VaultRoomsSettingTab: class VaultRoomsSettingTab {} }));
vi.mock("./modals/ConfirmModal.js", () => ({ confirmModal: vi.fn() }));
vi.mock("./modals/CreateRoomModal.js", () => ({ CreateRoomModal: class CreateRoomModal {} }));
vi.mock("./modals/CreateInviteModal.js", () => ({ CreateInviteModal: class CreateInviteModal {} }));
vi.mock("./modals/InviteMemberModal.js", () => ({ InviteMemberModal: class InviteMemberModal {} }));
vi.mock("./modals/JoinTeamModal.js", () => ({ JoinTeamModal: class JoinTeamModal {} }));
vi.mock("./modals/RoomSettingsModal.js", () => ({ RoomSettingsModal: class RoomSettingsModal {} }));
vi.mock("./modals/SetupTeamModal.js", () => ({ SetupTeamModal: class SetupTeamModal {} }));
vi.mock("./views/VaultRoomsView.js", () => ({ VAULT_ROOMS_VIEW_TYPE: "vault-rooms", VaultRoomsView: class VaultRoomsView {} }));

function serverConnection(): ServerConnection {
  return {
    id: "dev_1",
    baseUrl: "http://127.0.0.1:8787",
    userId: "usr_1",
    userDisplayName: "B laptop",
    deviceId: "dev_1",
    deviceName: "B laptop",
    deviceToken: "token",
    isServerOwner: false,
    status: "active",
    securityMode: "plain"
  };
}

function roomSummary(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: "room_1",
    name: "Demo",
    type: "folder",
    sourcePath: "demo",
    mountName: "Projects Demo",
    ownerUserId: "usr_owner",
    conflictPolicy: "keep_both",
    permissions: ["file:read", "file:write"],
    capabilities: [],
    crdtEnabled: true,
    ...overrides
  };
}

describe("VaultRoomsPlugin.refreshRooms", () => {
  it("mirrors each visible room's crdtEnabled flag onto its persisted MountedRoomState and saves settings", async () => {
    const server = serverConnection();
    const roomState: MountedRoomState = {
      roomId: "room_1",
      serverId: server.id,
      mountPath: "Vault Rooms/demo/Projects Demo",
      files: {},
      crdtEnabled: false
    };
    const settings: VaultRoomsSettings = {
      servers: [server],
      activeServerId: server.id,
      mountRoot: "Vault Rooms",
      debounceMs: 300,
      mountedRooms: { room_1: roomState },
      roomMountPaths: {},
      server: { maxFileBytes: 1024, autoStart: false }
    };
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const api = {
      listRooms: vi.fn().mockResolvedValue({ rooms: [roomSummary({ crdtEnabled: true })] })
    };
    const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
    plugin.settings = settings;
    plugin.visibleRooms = [];
    const internals = plugin as unknown as {
      app: unknown;
      requireActiveServer: () => ServerConnection;
      apiFor: () => RelayApiClient;
      saveSettings: () => Promise<void>;
      renderOpenRoomsViews: () => void;
    };
    internals.app = { workspace: { getLeavesOfType: () => [] } };
    (plugin as unknown as { crdtEditorController: { syncOpenViews: () => void } }).crdtEditorController = { syncOpenViews: vi.fn() };
    internals.requireActiveServer = () => server;
    internals.apiFor = () => api as unknown as RelayApiClient;
    internals.saveSettings = saveSettings;
    internals.renderOpenRoomsViews = vi.fn();

    await plugin.refreshRooms({ notify: false });

    expect(settings.mountedRooms.room_1?.crdtEnabled).toBe(true);
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it("[third-hardware-testing-round item 1] mirrors each visible room's sync:push-derived canPushLocalEdits flag onto its persisted MountedRoomState and saves settings", async () => {
    const server = serverConnection();
    const roomState: MountedRoomState = {
      roomId: "room_1",
      serverId: server.id,
      mountPath: "Vault Rooms/demo/Projects Demo",
      files: {},
      crdtEnabled: true,
      canPushLocalEdits: false
    };
    const settings: VaultRoomsSettings = {
      servers: [server],
      activeServerId: server.id,
      mountRoot: "Vault Rooms",
      debounceMs: 300,
      mountedRooms: { room_1: roomState },
      roomMountPaths: {},
      server: { maxFileBytes: 1024, autoStart: false }
    };
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const api = {
      listRooms: vi.fn().mockResolvedValue({ rooms: [roomSummary({ crdtEnabled: true, permissions: ["room:read", "file:read", "sync:subscribe", "sync:push"] })] })
    };
    const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
    plugin.settings = settings;
    plugin.visibleRooms = [];
    const internals = plugin as unknown as {
      app: unknown;
      requireActiveServer: () => ServerConnection;
      apiFor: () => RelayApiClient;
      saveSettings: () => Promise<void>;
      renderOpenRoomsViews: () => void;
    };
    internals.app = { workspace: { getLeavesOfType: () => [] } };
    (plugin as unknown as { crdtEditorController: { syncOpenViews: () => void } }).crdtEditorController = { syncOpenViews: vi.fn() };
    internals.requireActiveServer = () => server;
    internals.apiFor = () => api as unknown as RelayApiClient;
    internals.saveSettings = saveSettings;
    internals.renderOpenRoomsViews = vi.fn();

    await plugin.refreshRooms({ notify: false });

    expect(settings.mountedRooms.room_1?.canPushLocalEdits).toBe(true);
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it("does not call saveSettings again when the persisted crdtEnabled/canPushLocalEdits flags already match", async () => {
    const server = serverConnection();
    const roomState: MountedRoomState = {
      roomId: "room_1",
      serverId: server.id,
      mountPath: "Vault Rooms/demo/Projects Demo",
      files: {},
      crdtEnabled: true,
      // roomSummary()'s default permissions (["file:read", "file:write"]) have no "sync:push", so
      // the resolved value already matches this persisted "false" - keeps this test's "nothing
      // changed" premise true for both mirrored flags, not just crdtEnabled.
      canPushLocalEdits: false
    };
    const settings: VaultRoomsSettings = {
      servers: [server],
      activeServerId: server.id,
      mountRoot: "Vault Rooms",
      debounceMs: 300,
      mountedRooms: { room_1: roomState },
      roomMountPaths: {},
      server: { maxFileBytes: 1024, autoStart: false }
    };
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const api = {
      listRooms: vi.fn().mockResolvedValue({ rooms: [roomSummary({ crdtEnabled: true })] })
    };
    const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
    plugin.settings = settings;
    plugin.visibleRooms = [];
    const internals = plugin as unknown as {
      app: unknown;
      requireActiveServer: () => ServerConnection;
      apiFor: () => RelayApiClient;
      saveSettings: () => Promise<void>;
      renderOpenRoomsViews: () => void;
    };
    internals.app = { workspace: { getLeavesOfType: () => [] } };
    (plugin as unknown as { crdtEditorController: { syncOpenViews: () => void } }).crdtEditorController = { syncOpenViews: vi.fn() };
    internals.requireActiveServer = () => server;
    internals.apiFor = () => api as unknown as RelayApiClient;
    internals.saveSettings = saveSettings;
    internals.renderOpenRoomsViews = vi.fn();

    await plugin.refreshRooms({ notify: false });

    expect(saveSettings).not.toHaveBeenCalled();
  });

  // Fifth hardware-testing round (2026-07-24): after a restart, an already-open CRDT note stayed an
  // unbound plain editor - live keystrokes went to disk (lossy reconcile), never to the shared Y.Doc,
  // so two people typing on the same line didn't merge. connectSyncSocket() binds panes once, while
  // visibleRooms is still empty (refreshRooms is fire-and-forget), and nothing re-ran the bind pass
  // after the room list loaded. refreshRooms() now re-runs the open-pane bind pass so panes bind once
  // their room resolves CRDT-enabled.
  it("[fifth hardware-testing round] re-runs the open-pane CRDT bind pass after the room list loads", async () => {
    const server = serverConnection();
    const settings: VaultRoomsSettings = {
      servers: [server],
      activeServerId: server.id,
      mountRoot: "Vault Rooms",
      debounceMs: 300,
      mountedRooms: {},
      roomMountPaths: {},
      server: { maxFileBytes: 1024, autoStart: false }
    };
    const api = { listRooms: vi.fn().mockResolvedValue({ rooms: [roomSummary({ crdtEnabled: true })] }) };
    const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
    plugin.settings = settings;
    plugin.visibleRooms = [];
    const syncOpenViews = vi.fn();
    const internals = plugin as unknown as {
      app: unknown;
      requireActiveServer: () => ServerConnection;
      apiFor: () => RelayApiClient;
      saveSettings: () => Promise<void>;
      renderOpenRoomsViews: () => void;
    };
    internals.app = { workspace: { getLeavesOfType: () => [] } };
    (plugin as unknown as { crdtEditorController: { syncOpenViews: () => void } }).crdtEditorController = { syncOpenViews };
    internals.requireActiveServer = () => server;
    internals.apiFor = () => api as unknown as RelayApiClient;
    internals.saveSettings = vi.fn().mockResolvedValue(undefined);
    internals.renderOpenRoomsViews = vi.fn();

    await plugin.refreshRooms({ notify: false });

    expect(syncOpenViews).toHaveBeenCalled();
  });
});
