import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { RoomSummary } from "../apiClient.js";
import { VaultSyncEngine, type MountedRoomState, type RelayFileApi, type VaultAdapter } from "../syncClient.js";
import { RoomMountController, type RoomMountControllerDeps } from "./RoomMountController.js";

/** Full VaultAdapter fake (unlike the Pick<> stub above) - the CRDT re-mount test below exercises
 *  the real VaultSyncEngine end-to-end, which needs every method on the interface. */
class FakeVaultAdapter implements VaultAdapter {
  files = new Map<string, string>();

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`Missing file: ${path}`);
    }
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async readBinary(): Promise<ArrayBuffer> {
    throw new Error("not used in this test");
  }

  async writeBinary(): Promise<void> {
    throw new Error("not used in this test");
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = this.files.get(oldPath);
    if (content === undefined) return;
    this.files.delete(oldPath);
    this.files.set(newPath, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix));
  }

  onChange(): () => void {
    return () => undefined;
  }
}

describe("RoomMountController", () => {
  it("keeps root-mounted relative paths intact and skips the Obsidian config folder", async () => {
    const pushes: string[] = [];
    const settings = {
      mountedRooms: {},
      roomMountPaths: {},
      mountRoot: "Vault Rooms"
    };
    const room: RoomSummary = {
      id: "room_1",
      name: "Root room",
      type: "folder",
      sourcePath: "",
      mountName: "Root room",
      ownerUserId: "user_1",
      conflictPolicy: "keep_both",
      permissions: ["sync:push"],
      capabilities: [],
      crdtEnabled: false
    };
    const vaultAdapter: Pick<VaultAdapter, "list"> = {
      async list(prefix: string): Promise<string[]> {
        expect(prefix).toBe("");
        return ["Notes/A.md", ".obsidian/plugins/vault-rooms/data.json"];
      }
    };
    const syncEngine: Pick<VaultSyncEngine, "reconcileLocalEdits" | "pushLocalChange"> = {
      async reconcileLocalEdits(): Promise<void> {},
      async pushLocalChange(_room: MountedRoomState, relativePath: string): Promise<void> {
        pushes.push(relativePath);
      }
    };
    const deps: RoomMountControllerDeps = {
      app: { vault: { configDir: ".obsidian" } } as App,
      settings: settings as RoomMountControllerDeps["settings"],
      visibleRooms: [room],
      vaultAdapter: vaultAdapter as VaultAdapter,
      getSyncEngine: () => syncEngine as VaultSyncEngine,
      apiFor: () =>
        ({
          async listFiles() {
            return { files: [] };
          },
          async readFile() {
            throw new Error("readFile should not be called");
          }
        }) as unknown as ReturnType<RoomMountControllerDeps["apiFor"]>,
      requireActiveServer: () => ({ id: "server_1", userId: "user_1", deviceName: "Owner" }) as ReturnType<RoomMountControllerDeps["requireActiveServer"]>,
      saveSettings: vi.fn(async () => undefined),
      renderOpenRoomsViews: vi.fn(),
      stopWatchingRoom: vi.fn(),
      watchMountedRoom: vi.fn(),
      subscribeRoom: vi.fn()
    };

    await new RoomMountController(deps).mountRoom(room);

    expect(pushes).toEqual(["Notes/A.md"]);
  });

  it("[third-hardware-testing-round item 1] does not attempt pushLocalChange for an untracked pre-existing local file when the room can't push (no sync:push permission)", async () => {
    const pushes: string[] = [];
    const settings: { mountedRooms: Record<string, MountedRoomState>; roomMountPaths: Record<string, string>; mountRoot: string } = {
      mountedRooms: {},
      roomMountPaths: {},
      mountRoot: "Vault Rooms"
    };
    const room: RoomSummary = {
      id: "room_1",
      name: "Reader room",
      type: "folder",
      sourcePath: "",
      mountName: "Reader room",
      ownerUserId: "user_owner",
      conflictPolicy: "keep_both",
      permissions: ["room:read", "file:read", "sync:subscribe"],
      capabilities: [],
      crdtEnabled: false
    };
    let listCalled = false;
    const vaultAdapter: Pick<VaultAdapter, "list"> = {
      async list(prefix: string): Promise<string[]> {
        listCalled = true;
        expect(prefix).toBe("");
        return ["Notes/A.md"];
      }
    };
    const syncEngine: Pick<VaultSyncEngine, "reconcileLocalEdits" | "pushLocalChange"> = {
      async reconcileLocalEdits(): Promise<void> {},
      async pushLocalChange(_room: MountedRoomState, relativePath: string): Promise<void> {
        pushes.push(relativePath);
      }
    };
    const deps: RoomMountControllerDeps = {
      app: { vault: { configDir: ".obsidian" } } as App,
      settings: settings as RoomMountControllerDeps["settings"],
      visibleRooms: [room],
      vaultAdapter: vaultAdapter as VaultAdapter,
      getSyncEngine: () => syncEngine as VaultSyncEngine,
      apiFor: () =>
        ({
          async listFiles() {
            return { files: [] };
          },
          async readFile() {
            throw new Error("readFile should not be called");
          }
        }) as unknown as ReturnType<RoomMountControllerDeps["apiFor"]>,
      requireActiveServer: () => ({ id: "server_1", userId: "user_2", deviceName: "Reader laptop" }) as ReturnType<RoomMountControllerDeps["requireActiveServer"]>,
      saveSettings: vi.fn(async () => undefined),
      renderOpenRoomsViews: vi.fn(),
      stopWatchingRoom: vi.fn(),
      watchMountedRoom: vi.fn(),
      subscribeRoom: vi.fn()
    };

    await new RoomMountController(deps).mountRoom(room);

    expect(listCalled).toBe(false);
    expect(pushes).toEqual([]);
    expect(settings.mountedRooms["room_1"]?.canPushLocalEdits).toBe(false);
  });

  it("[second-hardware-testing-round item 2] re-mounting an already-mounted CRDT room whose on-disk content has legitimately diverged (simulating live CRDT activity) does not fork a conflict copy or populate listRoomConflicts()", async () => {
    // Regression test for: reconcileLocalEdits (called at the top of every mountRoom()) used to have
    // no CRDT-awareness, so it saw the CRDT-managed file's on-disk hash differ from the CAS lane's
    // stale tracked hash (never updated by CRDT edits, which bypass this bookkeeping by design) and
    // wrongly marked the file dirty - the next VaultSyncEngine.applyRemoteChange call in this same
    // mountRoom() then forked a spurious "(conflict ...)" copy purely from that artifact.
    // The room is owned by this device (ownerUserId === the acting server's userId below), so
    // roomMountPathFor()/mountRoom() will recompute mountPath as the room's real sourcePath ("demo")
    // regardless of whatever mountPath happens to already be on the pre-seeded roomState - matching
    // production's "the owner's device always mounts in place at sourcePath" rule (mountPathForRoom's
    // doc comment in syncClient.ts). Every path below must agree with that recomputed value.
    const mountPath = "demo";
    const boardPath = `${mountPath}/Board.md`;
    const vaultAdapter = new FakeVaultAdapter();
    // Current on-disk content already diverges from the last CAS-lane-tracked hash below - standing
    // in for content the CRDT lane (yCollab edits / CrdtSessionManager's materialize write-back)
    // legitimately wrote here since the last time this bookkeeping was updated.
    await vaultAdapter.write(boardPath, "# live-edited via the CRDT lane\n");
    const api: RelayFileApi = {
      // The server reports a newer version than the last-tracked one (contract 1.6: materialization
      // bumps files.version/sha256) - realistic for a room with ongoing CRDT activity - and its
      // content already matches what's on disk (the materialize write-back already wrote it there),
      // so applying it is an idempotent overwrite, not a real conflict.
      async readFile() {
        return { relativePath: "Board.md", version: 3, sha256: "server-3", content: "# live-edited via the CRDT lane\n" };
      },
      async writeFile() {
        throw new Error("not used in this test");
      },
      async deleteFile() {
        throw new Error("not used in this test");
      }
    };
    const syncEngine = new VaultSyncEngine(vaultAdapter, api, () => new Date("2026-07-21T12:00:00Z"));
    const roomState: MountedRoomState = {
      roomId: "room_1",
      serverId: "server_1",
      mountPath,
      crdtEnabled: true,
      files: {
        "Board.md": {
          serverVersion: 2,
          serverSha256: "server-2",
          localSha256: await VaultSyncEngine.sha256("# synced\n"),
          dirty: false
        }
      }
    };
    const settings = {
      mountedRooms: { room_1: roomState },
      roomMountPaths: {},
      mountRoot: "Vault Rooms"
    };
    const room: RoomSummary = {
      id: "room_1",
      name: "Demo",
      type: "folder",
      sourcePath: "demo",
      mountName: "Projects Demo",
      ownerUserId: "user_owner",
      conflictPolicy: "keep_both",
      permissions: ["file:read", "file:write"],
      capabilities: [],
      crdtEnabled: true
    };
    // Minimal duck-typed vault tree for listRoomConflicts()'s traversal (vaultTraversal.ts's
    // isFile/isFolder only check for "extension"/"children" - no real obsidian TFile/TFolder needed).
    const boardFile = { path: boardPath, extension: "md" };
    const mountFolder = { path: mountPath, children: [boardFile] };
    const app = {
      vault: {
        configDir: ".obsidian",
        getAbstractFileByPath: (path: string) => (path === mountPath ? mountFolder : undefined)
      }
    } as unknown as App;
    const deps: RoomMountControllerDeps = {
      app,
      settings: settings as unknown as RoomMountControllerDeps["settings"],
      visibleRooms: [room],
      vaultAdapter,
      getSyncEngine: () => syncEngine,
      apiFor: () => ({ listFiles: async () => ({ files: [{ relativePath: "Board.md", version: 3, sha256: "server-3", deleted: false }] }), ...api }) as unknown as ReturnType<RoomMountControllerDeps["apiFor"]>,
      requireActiveServer: () => ({ id: "server_1", userId: "user_owner", deviceName: "Owner" }) as ReturnType<RoomMountControllerDeps["requireActiveServer"]>,
      saveSettings: vi.fn(async () => undefined),
      renderOpenRoomsViews: vi.fn(),
      stopWatchingRoom: vi.fn(),
      watchMountedRoom: vi.fn(),
      subscribeRoom: vi.fn()
    };
    const controller = new RoomMountController(deps);

    await controller.mountRoom(room);

    expect(controller.listRoomConflicts("room_1")).toEqual([]);
    expect([...vaultAdapter.files.keys()].some((path) => path.includes("(conflict "))).toBe(false);
    expect(roomState.files["Board.md"]).toMatchObject({ serverVersion: 3, serverSha256: "server-3", dirty: false });
  });
});
