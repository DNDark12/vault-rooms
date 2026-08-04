import { beforeEach, describe, expect, it, vi } from "vitest";
import VaultRoomsPlugin from "./main.js";
import type { EmbeddedServerStatus } from "./serverManager.js";
import type { ServerConnection, VaultRoomsSettings } from "./settings.js";

const socketMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    deps: Record<string, unknown>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  }>
}));
const updateMocks = vi.hoisted(() => ({ notifyIfUpdateAvailable: vi.fn().mockResolvedValue(undefined) }));

vi.mock("obsidian", () => ({
  Notice: class Notice {},
  Plugin: class Plugin {},
  normalizePath: (path: string) => path,
  requestUrl: vi.fn()
}));
vi.mock("./syncWsClient.js", () => ({
  RoomSyncSocket: class RoomSyncSocket {
    readonly connect = vi.fn();
    readonly disconnect = vi.fn();
    readonly subscribe = vi.fn();
    readonly sendCrdtMessage = vi.fn();

    constructor(_server: unknown, readonly deps: Record<string, unknown>) {
      socketMocks.instances.push(this);
    }
  }
}));
vi.mock("./updateNotice.js", () => updateMocks);
vi.mock("./controllers/ServerConnectionManager.js", () => ({ ServerConnectionManager: class ServerConnectionManager {} }));
vi.mock("./VaultRoomsSettingTab.js", () => ({ VaultRoomsSettingTab: class VaultRoomsSettingTab {} }));
vi.mock("./modals/ConfirmModal.js", () => ({ confirmModal: vi.fn() }));
vi.mock("./modals/CreateRoomModal.js", () => ({ CreateRoomModal: class CreateRoomModal {} }));
vi.mock("./modals/CreateInviteModal.js", () => ({ CreateInviteModal: class CreateInviteModal {} }));
vi.mock("./modals/GuidedOnboardingModal.js", () => ({ GuidedOnboardingModal: class GuidedOnboardingModal {} }));
vi.mock("./modals/InviteMemberModal.js", () => ({ InviteMemberModal: class InviteMemberModal {} }));
vi.mock("./modals/JoinTeamModal.js", () => ({ JoinTeamModal: class JoinTeamModal {} }));
vi.mock("./modals/RoomSettingsModal.js", () => ({ RoomSettingsModal: class RoomSettingsModal {} }));
vi.mock("./modals/SetupTeamModal.js", () => ({ SetupTeamModal: class SetupTeamModal {} }));
vi.mock("./views/VaultRoomsView.js", () => ({ VAULT_ROOMS_VIEW_TYPE: "vault-rooms", VaultRoomsView: class VaultRoomsView {} }));

const server = (): ServerConnection => ({
  id: "dev_owner",
  baseUrl: "http://127.0.0.1:8787",
  userId: "usr_owner",
  userDisplayName: "Owner",
  deviceId: "dev_owner",
  deviceName: "Owner laptop",
  deviceToken: "token",
  isServerOwner: true,
  status: "active",
  securityMode: "plain",
  appliedRotationIds: []
});

const settings = (active: ServerConnection): VaultRoomsSettings => ({
  servers: [active],
  activeServerId: active.id,
  mountRoot: "Vault Rooms",
  debounceMs: 300,
  mountedRooms: {},
  roomMountPaths: {},
  server: { maxFileBytes: 1024, autoStart: false }
});

beforeEach(() => {
  vi.clearAllMocks();
  socketMocks.instances.length = 0;
});

describe("VaultRoomsPlugin embedded-server sync lifecycle", () => {
  it("initializes local sync lifecycle after layout ready even while the own relay is stopped", () => {
    const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
    const connectSyncSocket = vi.fn();
    const refreshRooms = vi.fn().mockResolvedValue(undefined);
    const internals = plugin as unknown as {
      connectSyncSocket: typeof connectSyncSocket;
      refreshRooms: typeof refreshRooms;
      initializeSyncAfterLayoutReady: () => void;
    };
    internals.connectSyncSocket = connectSyncSocket;
    internals.refreshRooms = refreshRooms;
    (plugin as unknown as { manifest: { version: string } }).manifest = { version: "0.2.5" };

    internals.initializeSyncAfterLayoutReady();

    expect(connectSyncSocket).toHaveBeenCalledOnce();
    expect(refreshRooms).toHaveBeenCalledWith({ notify: false });
    expect(updateMocks.notifyIfUpdateAvailable).toHaveBeenCalledOnce();
    expect(updateMocks.notifyIfUpdateAvailable).toHaveBeenCalledWith("0.2.5");
  });

  it("asks for a CRDT-preserving reconnect when the same embedded server starts again", async () => {
    const active = server();
    const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
    plugin.settings = settings(active);
    const connectSyncSocket = vi.fn();
    const internals = plugin as unknown as {
      serverConnectionManager: { startEmbeddedServer: () => Promise<EmbeddedServerStatus> };
      getActiveServer: () => ServerConnection;
      connectSyncSocket: (options?: { preserveCrdtSessions?: boolean }) => void;
      refreshTeams: () => Promise<void>;
      refreshRooms: () => Promise<void>;
      renderOpenRoomsViews: () => void;
    };
    internals.serverConnectionManager = {
      startEmbeddedServer: vi.fn(async () => ({ running: true, localUrl: active.baseUrl }) as EmbeddedServerStatus)
    };
    internals.getActiveServer = () => active;
    internals.connectSyncSocket = connectSyncSocket;
    internals.refreshTeams = vi.fn(async () => undefined);
    internals.refreshRooms = vi.fn(async () => undefined);
    internals.renderOpenRoomsViews = vi.fn();

    await plugin.startEmbeddedServer();

    expect(connectSyncSocket).toHaveBeenCalledWith({ preserveCrdtSessions: true });
  });

  it("moves a colliding committed receipt path before handing its content to CAS", async () => {
    const active = server();
    const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
    plugin.settings = settings(active);
    plugin.settings.mountedRooms.room_1 = {
      roomId: "room_1",
      serverId: active.id,
      mountPath: "Shared",
      files: {},
      crdtEnabled: false,
      canPushLocalEdits: true
    };
    const rename = vi.fn().mockResolvedValue(undefined);
    const handleLocalChange = vi.fn();
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const internals = plugin as unknown as {
      selfInflictedRenames: Set<string>;
      vaultAdapter: { rename: typeof rename };
      roomCoordinators: Map<string, { handleLocalChange: typeof handleLocalChange }>;
      getActiveServer: () => ServerConnection;
      apiFor: () => { readFile: () => Promise<{ version: number; sha256: string }> };
      saveSettings: typeof saveSettings;
      convertJournalOperationToCas: (
        roomId: string,
        operation: { operationId: string; kind: "create"; relativePath: string; queuedAt: string },
        outcome: { committed: boolean; relativePath: string }
      ) => Promise<void>;
    };
    internals.selfInflictedRenames = new Set();
    internals.vaultAdapter = { rename };
    internals.roomCoordinators = new Map([["room_1", { handleLocalChange }]]);
    internals.getActiveServer = () => active;
    internals.apiFor = () => ({ readFile: async () => ({ version: 4, sha256: "server-sha" }) });
    internals.saveSettings = saveSettings;

    await internals.convertJournalOperationToCas(
      "room_1",
      {
        operationId: "op_create",
        kind: "create",
        relativePath: "Note.md",
        queuedAt: "2026-08-03T00:00:00.000Z"
      },
      { committed: true, relativePath: "Note 1.md" }
    );

    expect(rename).toHaveBeenCalledWith("Shared/Note.md", "Shared/Note 1.md");
    expect(handleLocalChange).toHaveBeenCalledWith("modify", "Note 1.md");
    expect(plugin.settings.mountedRooms.room_1?.files["Note 1.md"]).toEqual(
      expect.objectContaining({ serverVersion: 4, serverSha256: "server-sha" })
    );
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it("converts an uncommitted offline rename into an ordered CAS delete and create", async () => {
    const active = server();
    const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
    plugin.settings = settings(active);
    plugin.settings.mountedRooms.room_1 = {
      roomId: "room_1",
      serverId: active.id,
      mountPath: "Shared",
      files: {},
      crdtEnabled: false,
      canPushLocalEdits: true
    };
    const changes: Array<[string, string]> = [];
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const internals = plugin as unknown as {
      roomCoordinators: Map<string, { handleLocalChange: (kind: string, path: string) => void }>;
      getActiveServer: () => ServerConnection;
      apiFor: () => { readFile: (_roomId: string, path: string) => Promise<{ version: number; sha256: string }> };
      saveSettings: typeof saveSettings;
      convertJournalOperationToCas: (
        roomId: string,
        operation: { operationId: string; kind: "rename"; oldRelativePath: string; relativePath: string; queuedAt: string },
        outcome: { committed: boolean; relativePath: string }
      ) => Promise<void>;
    };
    internals.roomCoordinators = new Map([["room_1", {
      handleLocalChange: (kind, path) => changes.push([kind, path])
    }]]);
    internals.getActiveServer = () => active;
    internals.apiFor = () => ({
      readFile: async (_roomId, path) => {
        if (path !== "Old.md") throw Object.assign(new Error("missing"), { code: "NOT_FOUND" });
        return { version: 3, sha256: "old-sha" };
      }
    });
    internals.saveSettings = saveSettings;

    await internals.convertJournalOperationToCas(
      "room_1",
      {
        operationId: "op_rename",
        kind: "rename",
        oldRelativePath: "Old.md",
        relativePath: "Final.md",
        queuedAt: "2026-08-03T00:00:00.000Z"
      },
      { committed: false, relativePath: "Final.md" }
    );

    expect(changes).toEqual([["delete", "Old.md"], ["create", "Final.md"]]);
    expect(plugin.settings.mountedRooms.room_1?.files["Old.md"]).toEqual(
      expect.objectContaining({ serverVersion: 3, serverSha256: "old-sha" })
    );
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it("replaces only the socket while retaining the live Y.Doc manager, editor bindings, and watchers", () => {
    const active = server();
    const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
    plugin.settings = settings(active);
    plugin.visibleRooms = [];

    const previousSocket = { disconnect: vi.fn() };
    const manager = { dispose: vi.fn() };
    const unbindAll = vi.fn();
    const unsubscribeWatcher = vi.fn();
    const existingSyncEngine = { marker: "same-server-engine" };
    const internals = plugin as unknown as {
      syncSocket: typeof previousSocket | null;
      syncState: string;
      syncEngine: unknown;
      crdtSessionManager: typeof manager | null;
      crdtEditorController: { unbindAll: () => void };
      roomWatchers: Map<string, () => void>;
      roomCoordinators: Map<string, unknown>;
      serverConnectionManager: { apiFor: () => Record<string, never> };
      getActiveServer: () => ServerConnection;
      activeServerIsOwnStoppedServer: () => boolean;
      handleActiveEditorChanged: () => void;
      renderOpenRoomsViews: () => void;
      connectSyncSocket: (options?: { preserveCrdtSessions?: boolean }) => void;
    };
    internals.syncSocket = previousSocket;
    internals.syncState = "offline";
    internals.syncEngine = existingSyncEngine;
    internals.crdtSessionManager = manager;
    internals.crdtEditorController = { unbindAll };
    internals.roomWatchers = new Map([["room_1", unsubscribeWatcher]]);
    internals.roomCoordinators = new Map();
    internals.serverConnectionManager = { apiFor: () => ({}) };
    internals.getActiveServer = () => active;
    internals.activeServerIsOwnStoppedServer = () => false;
    internals.handleActiveEditorChanged = vi.fn();
    internals.renderOpenRoomsViews = vi.fn();

    internals.connectSyncSocket({ preserveCrdtSessions: true });

    expect(previousSocket.disconnect).toHaveBeenCalledOnce();
    expect(manager.dispose).not.toHaveBeenCalled();
    expect(unbindAll).not.toHaveBeenCalled();
    expect(unsubscribeWatcher).not.toHaveBeenCalled();
    expect(internals.syncEngine).toBe(existingSyncEngine);
    expect(socketMocks.instances).toHaveLength(1);
    expect(socketMocks.instances[0]?.deps.crdt).toBe(manager);
    expect(socketMocks.instances[0]?.connect).toHaveBeenCalledOnce();
  });

  it("reports a dropped CRDT send when hosting is paused instead of leaving create requests pending", () => {
    const active = server();
    const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
    plugin.settings = settings(active);
    plugin.visibleRooms = [];
    const internals = plugin as unknown as {
      syncSocket: { disconnect: () => void } | null;
      syncState: string;
      syncEngine: unknown;
      crdtDocStore: unknown;
      crdtSessionManager: unknown;
      crdtEditorController: { unbindAll: () => void };
      roomWatchers: Map<string, () => void>;
      roomCoordinators: Map<string, unknown>;
      vaultAdapter: Record<string, never>;
      serverConnectionManager: { apiFor: () => Record<string, never> };
      getActiveServer: () => ServerConnection;
      activeServerIsOwnStoppedServer: () => boolean;
      handleActiveEditorChanged: () => void;
      renderOpenRoomsViews: () => void;
      disconnectSyncSocket: () => void;
      connectSyncSocket: () => void;
    };
    internals.syncSocket = null;
    internals.syncState = "offline";
    internals.syncEngine = {};
    internals.crdtDocStore = {};
    internals.crdtSessionManager = null;
    internals.crdtEditorController = { unbindAll: vi.fn() };
    internals.roomWatchers = new Map();
    internals.roomCoordinators = new Map();
    internals.vaultAdapter = {};
    internals.serverConnectionManager = { apiFor: () => ({}) };
    internals.getActiveServer = () => active;
    internals.activeServerIsOwnStoppedServer = () => false;
    internals.handleActiveEditorChanged = vi.fn();
    internals.renderOpenRoomsViews = vi.fn();

    internals.connectSyncSocket();
    const manager = socketMocks.instances[0]?.deps.crdt as {
      deps: { send: (message: Record<string, unknown>) => boolean | void };
    };
    internals.disconnectSyncSocket();

    expect(manager.deps.send({ type: "crdt_create" })).toBe(false);
  });
});
