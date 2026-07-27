import { describe, expect, it, vi } from "vitest";
import VaultRoomsPlugin from "./main.js";
import { CrdtRejectedError, type CrdtSessionManager } from "./crdtSession.js";
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
  /** Normally a class field initializer; these tests build the plugin via Object.create, so field
   *  initializers never run and it has to be supplied explicitly (see setUp). */
  selfInflictedRenames: Set<string>;
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
  function setUp(options: {
    visibleRoomCrdtEnabled?: boolean;
    persistedCrdtEnabled: boolean;
    renameSession?: ReturnType<typeof vi.fn>;
    // Fifth hardware-testing round (2026-07-24): lets a test simulate the startup window where this
    // device can't (yet) push - visibleRooms empty, so canPushLocalEdits falls back to this persisted
    // value. Defaults true so every pre-existing test keeps its can-push behavior unchanged.
    persistedCanPush?: boolean;
  }) {
    const server = serverConnection();
    const roomState: MountedRoomState = {
      roomId: "room_1",
      serverId: server.id,
      mountPath: "Vault Rooms/demo/Projects Demo",
      files: {},
      crdtEnabled: options.persistedCrdtEnabled,
      // Persisted fallback for canPushLocalEdits (third-hardware-testing-round item 1) - true so
      // these CRDT-lane-routing tests (including the rename short-circuit) aren't incidentally
      // gated by it when visibleRooms is still empty, matching the "sync:push" included in the
      // visibleRooms fixture below for the same reason.
      canPushLocalEdits: options.persistedCanPush ?? true
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
    const renameSession = options.renameSession ?? vi.fn().mockResolvedValue(undefined);
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
    internals.selfInflictedRenames = new Set<string>();
    internals.vaultAdapter = vaultAdapter;
    internals.syncEngine = new VaultSyncEngine(vaultAdapter, api);
    internals.crdtSessionManager = { ensureSession, forgetLocalDelete, renameSession } as unknown as CrdtSessionManager;
    internals.roomWatchers = new Map();
    internals.roomCoordinators = new Map();
    internals.saveSettings = vi.fn().mockResolvedValue(undefined);
    internals.getActiveServer = () => server;

    return { plugin, internals, roomState, vaultAdapter, ensureSession, forgetLocalDelete, renameSession };
  }

  it("routes a local .md modify to the CRDT lane using the persisted crdtEnabled flag when visibleRooms is still empty at startup", () => {
    const { internals, roomState, vaultAdapter, ensureSession } = setUp({ persistedCrdtEnabled: true });

    internals.watchMountedRoom("room_1");
    vaultAdapter.emit({ type: "modify", path: "Vault Rooms/demo/Projects Demo/Board.md" });

    // The third argument marks whether this is a note that did not exist a moment ago. A "modify" never
    // is, so it must adopt whatever document already holds the path rather than risk forking a renamed
    // duplicate (fifteenth hardware-testing round).
    expect(ensureSession).toHaveBeenCalledWith("room_1", "Board.md", { brandNewNote: false });
    // The legacy CAS-lane coordinator must never have marked this path dirty - that's exactly the
    // state that later causes VaultSyncEngine.applyRemoteChange to fabricate a conflict copy.
    expect(roomState.files["Board.md"]).toBeUndefined();
  });

  it("still routes to the CRDT lane once visibleRooms is populated and agrees with the persisted flag", () => {
    const { internals, roomState, vaultAdapter, ensureSession } = setUp({ visibleRoomCrdtEnabled: true, persistedCrdtEnabled: true });

    internals.watchMountedRoom("room_1");
    vaultAdapter.emit({ type: "modify", path: "Vault Rooms/demo/Projects Demo/Board.md" });

    // The third argument marks whether this is a note that did not exist a moment ago. A "modify" never
    // is, so it must adopt whatever document already holds the path rather than risk forking a renamed
    // duplicate (fifteenth hardware-testing round).
    expect(ensureSession).toHaveBeenCalledWith("room_1", "Board.md", { brandNewNote: false });
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

  describe("[fourth hardware-testing round] rename short-circuit", () => {
    it("routes an in-room rename to renameSession instead of forgetLocalDelete+ensureSession, and no-ops the paired create", () => {
      const { internals, ensureSession, forgetLocalDelete, renameSession } = setUp({ persistedCrdtEnabled: true });

      internals.watchMountedRoom("room_1");
      // FakeVaultAdapter's emit() drives the real (unmocked) fileWatcher.ts, which for an in-room
      // rename fires the synthetic delete-then-create pair with a RenameHint on each.
      (internals.vaultAdapter as unknown as { emit: (event: unknown) => void }).emit({
        type: "rename",
        path: "Vault Rooms/demo/Projects Demo/New.md",
        oldPath: "Vault Rooms/demo/Projects Demo/Old.md"
      });

      expect(renameSession).toHaveBeenCalledWith("room_1", "Old.md", "New.md");
      expect(forgetLocalDelete).not.toHaveBeenCalled();
      expect(ensureSession).not.toHaveBeenCalled();
    });

    // Superseded by the sixth-round behavior below: a rejection with no server error code (a transport
    // error, a dropped socket, anything unclassified) is now treated as non-recoverable rather than as
    // license to create a second document at the new path. Forking on *any* failure was the bug - the
    // original document is still alive at the old path, so creating another one duplicates the note.
    it("does not fork a second document when renameSession rejects with no server error code", async () => {
      const rejectingRenameSession = vi.fn().mockRejectedValue(new Error("socket closed"));
      const { internals, ensureSession, forgetLocalDelete, renameSession } = setUp({
        persistedCrdtEnabled: true,
        renameSession: rejectingRenameSession
      });

      internals.watchMountedRoom("room_1");
      (internals.vaultAdapter as unknown as { emit: (event: unknown) => void }).emit({
        type: "rename",
        path: "Vault Rooms/demo/Projects Demo/New.md",
        oldPath: "Vault Rooms/demo/Projects Demo/Old.md"
      });

      await vi.waitFor(() => expect(renameSession).toHaveBeenCalledWith("room_1", "Old.md", "New.md"));
      expect(ensureSession).not.toHaveBeenCalled();
      expect(forgetLocalDelete).not.toHaveBeenCalled();
    });
  });

  // Fifth hardware-testing round (2026-07-24): "A renames a note -> B (and the renamer) get a
  // brand-new file, the old one never goes away". Root cause: in the brief startup window before
  // refreshRooms() resolves, visibleRooms is empty so canPushLocalEdits falls back to false while
  // crdtEnabled falls back to a persisted true. The rename short-circuit used to require
  // canPushLocalEdits, so it was skipped - and the create half then fell through into the ungated
  // isCrdtManagedLocalChange path, firing ensureSession() -> crdt_create at the NEW path while the
  // old file still existed on the server. The fix: recognize BOTH halves of a CRDT rename regardless
  // of canPushLocalEdits (no-op when it can't push), and gate the create/modify ensureSession path by
  // canPushLocalEdits so it can never fork.
  describe("[fifth hardware-testing round] rename must never fork a new file when this device can't push", () => {
    it("does NOT fork via ensureSession when a CRDT rename happens while canPushLocalEdits is false (startup window)", () => {
      const { internals, ensureSession, forgetLocalDelete, renameSession } = setUp({
        persistedCrdtEnabled: true,
        persistedCanPush: false
      });

      internals.watchMountedRoom("room_1");
      (internals.vaultAdapter as unknown as { emit: (event: unknown) => void }).emit({
        type: "rename",
        path: "Vault Rooms/demo/Projects Demo/New.md",
        oldPath: "Vault Rooms/demo/Projects Demo/Old.md"
      });

      // The whole rename is a complete no-op: no crdt_rename is sent (can't push), and crucially the
      // create half never falls through to ensureSession (which would crdt_create a duplicate at the
      // new path). Nothing is pushed on the CAS lane either.
      expect(renameSession).not.toHaveBeenCalled();
      expect(ensureSession).not.toHaveBeenCalled();
      expect(forgetLocalDelete).not.toHaveBeenCalled();
    });

    // Sixth hardware-testing round (2026-07-24): "crdt_rename failed ... A file already exists at the
    // new path" for a name that never existed locally. The fallback used to call ensureSession(newPath)
    // on ANY rejection, which crdt_creates a second document while the original is still alive at the
    // old path - forking the note in two (and, once a stray sat at the target name, making every later
    // rename to it fail FILE_EXISTS forever). Creating is now only correct when the old path genuinely
    // wasn't on the server.
    it("does NOT fork a second document when the rename is rejected FILE_EXISTS", async () => {
      const rejecting = vi.fn().mockRejectedValue(new CrdtRejectedError("FILE_EXISTS", "A file already exists at the new path."));
      const { internals, ensureSession, forgetLocalDelete, renameSession } = setUp({ persistedCrdtEnabled: true, renameSession: rejecting });

      internals.watchMountedRoom("room_1");
      (internals.vaultAdapter as unknown as { emit: (event: unknown) => void }).emit({
        type: "rename",
        path: "Vault Rooms/demo/Projects Demo/New.md",
        oldPath: "Vault Rooms/demo/Projects Demo/Old.md"
      });

      await vi.waitFor(() => expect(renameSession).toHaveBeenCalledWith("room_1", "Old.md", "New.md"));
      // Nothing is created at the new path, and the old session is left intact - the note stays a
      // single document; the next reconnect snapshot reconciles this device.
      expect(ensureSession).not.toHaveBeenCalled();
      expect(forgetLocalDelete).not.toHaveBeenCalled();
    });

    it("DOES create at the new path when the old path genuinely wasn't on the server (NOT_FOUND)", async () => {
      const rejecting = vi.fn().mockRejectedValue(new CrdtRejectedError("NOT_FOUND", "File not found."));
      const { internals, ensureSession, forgetLocalDelete } = setUp({ persistedCrdtEnabled: true, renameSession: rejecting });

      internals.watchMountedRoom("room_1");
      (internals.vaultAdapter as unknown as { emit: (event: unknown) => void }).emit({
        type: "rename",
        path: "Vault Rooms/demo/Projects Demo/New.md",
        oldPath: "Vault Rooms/demo/Projects Demo/Old.md"
      });

      // There was nothing to rename, so this really is a first create - the note must still sync.
      await vi.waitFor(() => expect(ensureSession).toHaveBeenCalledWith("room_1", "New.md"));
      expect(forgetLocalDelete).toHaveBeenCalledWith("room_1", "Old.md");
    });

    // Ninth hardware-testing round (2026-07-24): a rename the *plugin itself* performed (applying a
    // peer's rename, or adopting a server-assigned name for a colliding new note) fires an ordinary
    // Obsidian vault rename event. Treating it as a user rename pushed a crdt_rename the server could
    // only reject ("A file already exists at the new path"), and that echo is what let a single name
    // collision escalate without bound into `Untitled (a) (b) (a) (b)…` across two devices.
    it("ignores a rename this plugin performed itself, pushing no crdt_rename and forking nothing", () => {
      const { plugin, internals, ensureSession, forgetLocalDelete, renameSession } = setUp({ persistedCrdtEnabled: true });
      (plugin as unknown as { selfInflictedRenames: Set<string> }).selfInflictedRenames.add("room_1 Old.md New.md");

      internals.watchMountedRoom("room_1");
      (internals.vaultAdapter as unknown as { emit: (event: unknown) => void }).emit({
        type: "rename",
        path: "Vault Rooms/demo/Projects Demo/New.md",
        oldPath: "Vault Rooms/demo/Projects Demo/Old.md"
      });

      expect(renameSession).not.toHaveBeenCalled();
      expect(ensureSession).not.toHaveBeenCalled();
      expect(forgetLocalDelete).not.toHaveBeenCalled();
      // Consumed, so a later genuine user rename of the same pair is still honored.
      expect((plugin as unknown as { selfInflictedRenames: Set<string> }).selfInflictedRenames.size).toBe(0);
    });

    it("still honors a genuine user rename of the same pair after the self-inflicted one was consumed", () => {
      const { plugin, internals, renameSession } = setUp({ persistedCrdtEnabled: true });
      (plugin as unknown as { selfInflictedRenames: Set<string> }).selfInflictedRenames.add("room_1 Old.md New.md");
      internals.watchMountedRoom("room_1");
      const emit = (internals.vaultAdapter as unknown as { emit: (event: unknown) => void }).emit.bind(internals.vaultAdapter);

      const event = { type: "rename", path: "Vault Rooms/demo/Projects Demo/New.md", oldPath: "Vault Rooms/demo/Projects Demo/Old.md" };
      emit(event);
      expect(renameSession).not.toHaveBeenCalled();

      emit(event);
      expect(renameSession).toHaveBeenCalledWith("room_1", "Old.md", "New.md");
    });

    it("does NOT fork via ensureSession for a plain .md create/modify while canPushLocalEdits is false", () => {
      const { internals, ensureSession } = setUp({ persistedCrdtEnabled: true, persistedCanPush: false });

      internals.watchMountedRoom("room_1");
      (internals.vaultAdapter as unknown as { emit: (event: unknown) => void }).emit({
        type: "create",
        path: "Vault Rooms/demo/Projects Demo/Fresh.md"
      });

      // ensureSession allocates an epoch via crdt_create - a server-side write - so it must never run
      // for a room this device can't (yet) push to. It opens later, once canPushLocalEdits resolves.
      expect(ensureSession).not.toHaveBeenCalled();
    });
  });
});
