import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { RoomSummary } from "../apiClient.js";
import type { MountedRoomState, VaultAdapter, VaultSyncEngine } from "../syncClient.js";
import { RoomMountController, type RoomMountControllerDeps } from "./RoomMountController.js";

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
      permissions: [],
      capabilities: []
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
});
