import { describe, expect, it, vi } from "vitest";
import VaultRoomsPlugin from "./main.js";
import type { CrdtSessionManager } from "./crdtSession.js";
import type { ServerConnection, VaultRoomsSettings } from "./settings.js";
import { VaultSyncEngine, type MountedRoomState, type RelayFileApi, type VaultAdapter, type VaultChangeEvent } from "./syncClient.js";

// pushCoordinator's/RoomPushCoordinator's default timer fallback calls window.setTimeout/clearTimeout
// (see syncWsClient.test.ts/pushCoordinator.test.ts for the same shim) - vitest's "node" test
// environment has no window global otherwise.
(globalThis as unknown as { window: typeof globalThis }).window ??= globalThis;

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

/** Captures the callback registered via registerMountedRoomWatcher() (through the real
 *  fileWatcher.ts, unmocked) so the test can fire a raw vault event exactly like Obsidian would. */
class FakeVaultAdapter implements VaultAdapter {
  private listener: ((event: VaultChangeEvent) => void) | undefined;

  async read(): Promise<string> {
    return "";
  }
  async write(): Promise<void> {}
  async readBinary(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
  async writeBinary(): Promise<void> {}
  async delete(): Promise<void> {}
  async rename(): Promise<void> {}
  async exists(): Promise<boolean> {
    return true;
  }
  async list(): Promise<string[]> {
    return [];
  }
  onChange(cb: (event: VaultChangeEvent) => void): () => void {
    this.listener = cb;
    return () => {
      this.listener = undefined;
    };
  }
  emit(event: VaultChangeEvent): void {
    this.listener?.(event);
  }
}

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

function settingsWithRoom(server: ServerConnection, roomState: MountedRoomState): VaultRoomsSettings {
  return {
    servers: [server],
    activeServerId: server.id,
    mountRoot: "Vault Rooms",
    debounceMs: 300,
    mountedRooms: { [roomState.roomId]: roomState },
    roomMountPaths: {},
    server: { maxFileBytes: 1024, autoStart: false }
  };
}

type WatchMountedRoomInternals = {
  app: { vault: { configDir: string } };
  vaultAdapter: VaultAdapter;
  syncEngine: VaultSyncEngine;
  crdtSessionManager: CrdtSessionManager;
  roomWatchers: Map<string, () => void>;
  roomCoordinators: Map<string, unknown>;
  saveSettings: () => Promise<void>;
  getActiveServer: () => ServerConnection;
  watchMountedRoom: (roomId: string) => void;
};

/**
 * Third-hardware-testing-round item 1: a room member with no `sync:push` permission must have a
 * completely no-op local vault watcher for non-CRDT-managed changes - never dirty-mark, never
 * attempt a push. Reproduces the reported symptom: a reader saw "couldn't sync ... you do not have
 * sync:push permission for this path" and a spurious "unresolved conflict" entry purely from local
 * file-content divergence they never intentionally caused.
 */
describe("VaultRoomsPlugin.watchMountedRoom canPushLocalEdits gate", () => {
  function setUp(options: { visibleRoomPermissions?: string[]; persistedCanPushLocalEdits?: boolean }) {
    const server = serverConnection();
    const roomState: MountedRoomState = {
      roomId: "room_1",
      serverId: server.id,
      mountPath: "Vault Rooms/demo/Projects Demo",
      files: {},
      crdtEnabled: false,
      canPushLocalEdits: options.persistedCanPushLocalEdits
    };
    const settings = settingsWithRoom(server, roomState);
    const vaultAdapter = new FakeVaultAdapter();
    const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
    plugin.settings = settings;
    plugin.visibleRooms =
      options.visibleRoomPermissions === undefined
        ? []
        : [
            {
              id: "room_1",
              name: "Demo",
              type: "folder",
              sourcePath: "demo",
              mountName: "Projects Demo",
              ownerUserId: "usr_owner",
              conflictPolicy: "keep_both",
              permissions: options.visibleRoomPermissions,
              capabilities: [],
              crdtEnabled: false
            }
          ];
    const ensureSession = vi.fn().mockResolvedValue(undefined);
    const forgetLocalDelete = vi.fn().mockResolvedValue(undefined);
    const api: RelayFileApi = {
      readFile: vi.fn(),
      // A rejecting writeFile makes it loudly obvious (unhandled rejection / thrown assertion) if a
      // push were ever attempted for a room that can't push.
      writeFile: vi.fn().mockRejectedValue(new Error("must not push local edits for a room with no sync:push permission")),
      deleteFile: vi.fn()
    };
    const internals = plugin as unknown as WatchMountedRoomInternals;
    internals.app = { vault: { configDir: ".obsidian" } };
    internals.vaultAdapter = vaultAdapter;
    internals.syncEngine = new VaultSyncEngine(vaultAdapter, api);
    internals.crdtSessionManager = { ensureSession, forgetLocalDelete } as unknown as CrdtSessionManager;
    internals.roomWatchers = new Map();
    internals.roomCoordinators = new Map();
    internals.saveSettings = vi.fn().mockResolvedValue(undefined);
    internals.getActiveServer = () => server;

    return { plugin, internals, roomState, vaultAdapter, ensureSession };
  }

  it("does not mark a path dirty or attempt a push for a reader room (visibleRooms confirms no sync:push)", () => {
    const { internals, roomState, vaultAdapter, ensureSession } = setUp({ visibleRoomPermissions: ["room:read", "file:read", "sync:subscribe"] });

    internals.watchMountedRoom("room_1");
    vaultAdapter.emit({ type: "modify", path: "Vault Rooms/demo/Projects Demo/Board.md" });

    expect(ensureSession).not.toHaveBeenCalled();
    expect(roomState.files["Board.md"]).toBeUndefined();
  });

  it("falls back to the persisted canPushLocalEdits flag when visibleRooms is still empty at startup, and still gates it off", () => {
    const { internals, roomState, vaultAdapter } = setUp({ persistedCanPushLocalEdits: false });

    internals.watchMountedRoom("room_1");
    vaultAdapter.emit({ type: "modify", path: "Vault Rooms/demo/Projects Demo/Board.md" });

    expect(roomState.files["Board.md"]).toBeUndefined();
  });

  it("still marks a path dirty for an editor room (visibleRooms confirms sync:push) - regression guard", () => {
    const { internals, roomState, vaultAdapter } = setUp({ visibleRoomPermissions: ["room:read", "file:read", "file:write", "sync:subscribe", "sync:push"] });

    internals.watchMountedRoom("room_1");
    vaultAdapter.emit({ type: "modify", path: "Vault Rooms/demo/Projects Demo/Board.md" });

    expect(roomState.files["Board.md"]?.dirty).toBe(true);
  });
});
