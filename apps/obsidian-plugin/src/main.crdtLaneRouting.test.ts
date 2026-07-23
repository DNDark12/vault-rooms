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
 * Reproduces bug #3 from the real 2-machine LAN test (cold restart of Obsidian on the joining
 * device produced "(conflict ...)" copy files for CRDT-managed notes): `visibleRooms` (the
 * network-confirmed room list) is empty/stale immediately after plugin startup, before
 * `refreshRooms()`'s REST round trip resolves. `watchMountedRoom`'s vault-watcher callback used to
 * look up CRDT mode via `this.visibleRooms.find(...)` alone - if that lookup misses, a CRDT-managed
 * `.md` file's local edit silently falls through to the legacy whole-file CAS-lane
 * (`RoomPushCoordinator`) instead of the CRDT lane (`CrdtSessionManager.ensureSession`), marking it
 * "dirty" in the old per-file tracked state. A later remote CRDT-lane update landing on that same
 * path then sees `dirty: true` and creates a spurious conflict copy before applying - see
 * VaultSyncEngine.applyRemoteChange.
 */
describe("VaultRoomsPlugin.watchMountedRoom CRDT-lane routing", () => {
  function setUp(options: { visibleRoomCrdtEnabled?: boolean; persistedCrdtEnabled: boolean }) {
    const server = serverConnection();
    const roomState: MountedRoomState = {
      roomId: "room_1",
      serverId: server.id,
      mountPath: "Vault Rooms/demo/Projects Demo",
      files: {},
      crdtEnabled: options.persistedCrdtEnabled
    };
    const settings = settingsWithRoom(server, roomState);
    const vaultAdapter = new FakeVaultAdapter();
    const plugin = Object.create(VaultRoomsPlugin.prototype) as VaultRoomsPlugin;
    plugin.settings = settings;
    plugin.visibleRooms =
      options.visibleRoomCrdtEnabled === undefined
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
              // Includes "sync:push" so these CRDT-lane-routing tests aren't incidentally gated by
              // the third-hardware-testing-round item 1 canPushLocalEdits check (which is exercised
              // separately in main.canPushLocalEdits.test.ts) - this file is only about which lane a
              // local change routes to, not about push permission.
              permissions: ["file:read", "file:write", "sync:push"],
              capabilities: [],
              crdtEnabled: options.visibleRoomCrdtEnabled
            }
          ];
    const ensureSession = vi.fn().mockResolvedValue({ roomId: "room_1", relativePath: "Board.md", epoch: 0, boundToEditor: false });
    const forgetLocalDelete = vi.fn().mockResolvedValue(undefined);
    // A rejecting writeFile makes it loudly obvious (unhandled rejection / thrown assertion) if the
    // legacy CAS lane's debounced push were ever to actually run - though the primary assertions
    // below are synchronous and don't require the debounce timer to fire at all.
    const api: RelayFileApi = {
      readFile: vi.fn(),
      writeFile: vi.fn().mockRejectedValue(new Error("must not push a CRDT-managed file through the legacy CAS lane")),
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

    return { plugin, internals, roomState, vaultAdapter, ensureSession, forgetLocalDelete };
  }

  it("routes a local .md modify to the CRDT lane using the persisted crdtEnabled flag when visibleRooms is still empty at startup", () => {
    const { internals, roomState, vaultAdapter, ensureSession } = setUp({ persistedCrdtEnabled: true });

    internals.watchMountedRoom("room_1");
    vaultAdapter.emit({ type: "modify", path: "Vault Rooms/demo/Projects Demo/Board.md" });

    expect(ensureSession).toHaveBeenCalledWith("room_1", "Board.md");
    // The legacy CAS-lane coordinator must never have marked this path dirty - that's exactly the
    // state that later causes VaultSyncEngine.applyRemoteChange to fabricate a conflict copy.
    expect(roomState.files["Board.md"]).toBeUndefined();
  });

  it("still routes to the CRDT lane once visibleRooms is populated and agrees with the persisted flag", () => {
    const { internals, roomState, vaultAdapter, ensureSession } = setUp({ visibleRoomCrdtEnabled: true, persistedCrdtEnabled: true });

    internals.watchMountedRoom("room_1");
    vaultAdapter.emit({ type: "modify", path: "Vault Rooms/demo/Projects Demo/Board.md" });

    expect(ensureSession).toHaveBeenCalledWith("room_1", "Board.md");
    expect(roomState.files["Board.md"]).toBeUndefined();
  });

  it("routes to the legacy CAS lane for a non-CRDT room (visibleRooms confirms crdtEnabled: false even though a stale persisted flag says true)", () => {
    const { internals, roomState, vaultAdapter, ensureSession } = setUp({ visibleRoomCrdtEnabled: false, persistedCrdtEnabled: true });

    internals.watchMountedRoom("room_1");
    vaultAdapter.emit({ type: "modify", path: "Vault Rooms/demo/Projects Demo/Board.md" });

    expect(ensureSession).not.toHaveBeenCalled();
    // The freshest network-confirmed visibleRooms entry (crdtEnabled: false) wins over the stale
    // persisted fallback - this file is correctly tracked by the legacy CAS lane instead.
    expect(roomState.files["Board.md"]?.dirty).toBe(true);
  });
});
