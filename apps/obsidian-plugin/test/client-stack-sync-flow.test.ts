import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "vault-rooms-relay/app";
import { RelayApiClient, type RoomSummary } from "../src/apiClient.js";
import { mountPathForRoom, VaultSyncEngine, type MountedRoomState, type VaultAdapter, type VaultChangeEvent } from "../src/syncClient.js";
import { registerMountedRoomWatcher } from "../src/fileWatcher.js";
import { RoomPushCoordinator } from "../src/pushCoordinator.js";
import { RoomSyncSocket, type SyncConnectionState } from "../src/syncWsClient.js";
import type { ServerConnection } from "../src/settings.js";
import { withInstalledCapabilities } from "../src/pluginCapabilities.js";

/**
 * Local copy of relay-server's test/bootstrapHelper.ts injectBootstrap - the obsidian-plugin
 * package depends on vault-rooms-relay (never the reverse, see tsconfig references), so this test
 * cannot import relay-server's test-only helper module directly; it's a few lines, duplicated here
 * rather than introducing a cross-package test-utility dependency for one helper.
 */
async function injectBootstrap(app: Awaited<ReturnType<typeof createApp>>, payload: { displayName: string; deviceName: string; teamName?: string }) {
  const bootstrapPin = (app as unknown as { bootstrapPin: string }).bootstrapPin;
  return app.inject({
    method: "POST",
    url: "/api/bootstrap",
    remoteAddress: "127.0.0.1",
    payload: { ...payload, pin: bootstrapPin }
  });
}

// RoomSyncSocket (browser/Obsidian runtime code) calls window.setTimeout/window.clearTimeout for
// its reconnect backoff. Node has no `window` global - stub it to the real global timer functions
// so the *actual* client class can run unmodified in this Node-based integration test.
(globalThis as unknown as { window: typeof globalThis }).window ??= globalThis;

/**
 * This suite drives the REAL client stack (VaultSyncEngine, RoomPushCoordinator,
 * registerMountedRoomWatcher, RoomSyncSocket, RelayApiClient) against a REAL listening relay
 * server over a real WebSocket - the same objects main.ts's connectSyncSocket()/watchMountedRoom()
 * wire together - instead of driving the relay with raw WS messages/REST injects the way
 * sync-flow.test.ts does. That existing suite exercises the relay in isolation; it never catches a
 * bug in how the plugin's own classes are wired to each other or to a real transport.
 */

type Client = {
  vault: FakeVaultAdapter;
  server: ServerConnection;
  api: RelayApiClient;
  syncEngine: VaultSyncEngine;
  room: MountedRoomState;
  socket: RoomSyncSocket;
  coordinator: RoomPushCoordinator;
  states: SyncConnectionState[];
  appliedCount: number;
  unsubscribeWatcher: () => void;
};

class FakeVaultAdapter implements VaultAdapter {
  files = new Map<string, string>();
  private listener: ((event: VaultChangeEvent) => void) | null = null;

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

  async readBinary(path: string): Promise<ArrayBuffer> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`Missing file: ${path}`);
    }
    const buffer = Buffer.from(content, "base64");
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, Buffer.from(data).toString("base64"));
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix));
  }

  onChange(cb: (event: VaultChangeEvent) => void): () => void {
    this.listener = cb;
    return () => {
      if (this.listener === cb) {
        this.listener = null;
      }
    };
  }

  /** Test-only helper simulating a local file-system event (Obsidian's real vault.on("create"/...) firing). */
  fire(event: VaultChangeEvent): void {
    this.listener?.(event);
  }
}

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.socket.disconnect();
    client.coordinator.dispose();
    client.unsubscribeWatcher();
  }
  for (const app of apps.splice(0)) {
    await app.close();
  }
});

async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Starts a real listening relay and returns its http base URL (used both for RelayApiClient's
 *  REST calls and, after RoomSyncSocket's http->ws rewrite, the live WebSocket connection). */
async function startRelay(): Promise<{ app: Awaited<ReturnType<typeof createApp>>; baseUrl: string }> {
  const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:0" });
  apps.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a real listening TCP address");
  }
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

function buildClient(input: {
  baseUrl: string;
  deviceToken: string;
  deviceName: string;
  roomId: string;
  mountPath: string;
  preExistingFiles?: MountedRoomState["files"];
}): Client {
  const vault = new FakeVaultAdapter();
  const server: ServerConnection = {
    id: "server_1",
    baseUrl: input.baseUrl,
    userId: "user",
    userDisplayName: input.deviceName,
    deviceId: "device",
    deviceName: input.deviceName,
    deviceToken: input.deviceToken,
    isServerOwner: false,
    status: "active",
    securityMode: "plain"
  };
  const api = new RelayApiClient(input.baseUrl, input.deviceToken);
  const syncEngine = new VaultSyncEngine(vault, api);
  const room: MountedRoomState = {
    roomId: input.roomId,
    mountPath: input.mountPath,
    files: input.preExistingFiles ?? {}
  };
  const states: SyncConnectionState[] = [];
  let appliedCount = 0;
  const socket = new RoomSyncSocket(server, {
    getMountedRoom: (roomId) => (roomId === room.roomId ? room : undefined),
    getApi: () => api,
    syncEngine,
    onApplied: () => {
      appliedCount += 1;
    },
    onRevoked: () => undefined,
    onRoomDeleted: () => undefined,
    onAccessRevoked: () => undefined,
    onStateChange: (state) => {
      states.push(state);
    }
  });
  const coordinator = new RoomPushCoordinator({
    room,
    syncEngine,
    deviceName: input.deviceName,
    onPersist: () => undefined,
    onError: (relativePath, error) => {
      throw new Error(`Unexpected sync error for "${relativePath}": ${error instanceof Error ? error.message : String(error)}`);
    },
    debounceMs: 20,
    isStillMounted: () => true
  });
  const unsubscribeWatcher = registerMountedRoomWatcher(
    vault,
    room,
    (event, relativePath) => {
      coordinator.handleLocalChange(event.type as "create" | "modify" | "delete", relativePath);
    },
    ".obsidian"
  );
  const client: Client = { vault, server, api, syncEngine, room, socket, coordinator, states, appliedCount: 0, unsubscribeWatcher };
  Object.defineProperty(client, "appliedCount", { get: () => appliedCount });
  clients.push(client);
  return client;
}

async function connectAndSubscribe(client: Client): Promise<void> {
  client.socket.connect();
  client.socket.subscribe(client.room.roomId);
  await waitFor(() => client.socket.getState() === "connected", `${client.server.deviceName} to connect`);
}

/** Sets up a room owned by A with B invited as an editor (pathPattern "**\/*"), following the same
 *  bootstrap -> invite -> join -> room create -> ACL grant flow as sync-flow.test.ts's setupSyncFlow. */
async function setupRoomWithTwoMembers(app: Awaited<ReturnType<typeof createApp>>) {
  const owner = (await injectBootstrap(app, { displayName: "A", deviceName: "A laptop", teamName: "Demo" })).json();
  const invite = (
    await app.inject({
      method: "POST",
      url: `/api/teams/${owner.team.id}/invites`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { role: "member", expiresInMinutes: 60, maxUses: 1 }
    })
  ).json();
  const member = (
    await app.inject({
      method: "POST",
      url: "/api/join",
      payload: { inviteToken: invite.inviteToken, displayName: "B", deviceName: "B laptop" }
    })
  ).json();
  const room = (
    await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Projects Demo", type: "folder", sourcePath: "Projects/Demo", mountName: "Projects Demo", capabilities: [] }
    })
  ).json().room;
  await app.inject({
    method: "POST",
    url: `/api/rooms/${room.id}/acl`,
    headers: { authorization: `Bearer ${owner.deviceToken}` },
    payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "editor", pathPattern: "**/*" }
  });
  return { owner, member, room };
}

/** Sets up a room owned by A with a team T (member B) granted access via a TEAM-subject ACL rule
 *  (subjectType:"team"), following the exact RoomSettingsModal.grantAccess -> apiClient.grantAcl
 *  request shape - unlike setupRoomWithTwoMembers, which grants a USER-subject rule directly to B. */
async function setupRoomWithTeamGrant(app: Awaited<ReturnType<typeof createApp>>) {
  const owner = (await injectBootstrap(app, { displayName: "A", deviceName: "A laptop", teamName: "ekyo" })).json();
  const teamId = owner.team.id;
  const invite = (
    await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/invites`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { role: "member", expiresInMinutes: 60, maxUses: 1 }
    })
  ).json();
  const member = (
    await app.inject({
      method: "POST",
      url: "/api/join",
      payload: { inviteToken: invite.inviteToken, displayName: "B", deviceName: "B laptop" }
    })
  ).json();
  const room = (
    await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Team Room", type: "folder", sourcePath: "Team/Room", mountName: "Team Room", capabilities: [] }
    })
  ).json().room;

  // Exactly RoomSettingsModal.grantAccess({ subjectType: "team", ... }) -> apiClient.grantAcl ->
  // POST /api/rooms/:roomId/acl.
  const grantResponse = await app.inject({
    method: "POST",
    url: `/api/rooms/${room.id}/acl`,
    headers: { authorization: `Bearer ${owner.deviceToken}` },
    payload: { subjectType: "team", subjectId: teamId, effect: "allow", preset: "editor", pathPattern: "**/*" }
  });

  return { owner, member, room, teamId, grantResponse };
}

describe("TEAM-subject ACL grant: full end-to-end sync between two members of the granted team", () => {
  it("persists the team grant, and lets a team member read/write/delete synced files via team membership alone", async () => {
    const { app, baseUrl } = await startRelay();
    const { owner, member, room, teamId, grantResponse } = await setupRoomWithTeamGrant(app);

    // The grant call itself must succeed and be persisted (GET reflects it back).
    expect(grantResponse.statusCode).toBe(200);
    const aclAfterGrant = (
      await app.inject({
        method: "GET",
        url: `/api/rooms/${room.id}/acl`,
        headers: { authorization: `Bearer ${owner.deviceToken}` }
      })
    ).json().aclRules;
    expect(aclAfterGrant).toContainEqual(
      expect.objectContaining({ subjectType: "team", subjectId: teamId, effect: "allow", pathPattern: "**/*" })
    );

    const a = buildClient({ baseUrl, deviceToken: owner.deviceToken, deviceName: "A laptop", roomId: room.id, mountPath: mountPathForRoom({ owner: true, mountRoot: "Vault Rooms", mountName: room.mountName, sourcePath: room.sourcePath }) });
    const b = buildClient({ baseUrl, deviceToken: member.deviceToken, deviceName: "B laptop", roomId: room.id, mountPath: mountPathForRoom({ owner: false, mountRoot: "Vault Rooms", mountName: room.mountName, sourcePath: room.sourcePath }) });

    // B connecting and subscribing at all proves the broadcast/subscribe canReceive gate resolves
    // file:read/sync:subscribe for B purely through team membership (repo.listUserTeams(B) includes
    // T), since B has no USER-subject ACL rule on this room.
    await connectAndSubscribe(a);
    await connectAndSubscribe(b);

    // A creates a file -> B (team member, no direct user ACL) must receive it.
    const aPath = `${a.room.mountPath}/Board.md`;
    await a.vault.write(aPath, "# Board\nhello team\n");
    a.vault.fire({ type: "create", path: aPath });
    await waitFor(async () => (await b.vault.exists(`${b.room.mountPath}/Board.md`)) && (await b.vault.read(`${b.room.mountPath}/Board.md`)) === "# Board\nhello team\n", "B (team member) to receive A's new file");

    // B edits the file -> must be accepted (sync:push + file:write via team ACL) and A must receive it.
    const bPath = `${b.room.mountPath}/Board.md`;
    await b.vault.write(bPath, "# Board\nedited by B\n");
    b.vault.fire({ type: "modify", path: bPath });
    await waitFor(async () => (await a.vault.exists(`${a.room.mountPath}/Board.md`)) && (await a.vault.read(`${a.room.mountPath}/Board.md`)) === "# Board\nedited by B\n", "A to receive B's team-ACL edit");

    // B deletes the file -> A's copy must be removed.
    await b.vault.delete(bPath);
    b.vault.fire({ type: "delete", path: bPath });
    await waitFor(async () => !(await a.vault.exists(`${a.room.mountPath}/Board.md`)), "A to see B's team-ACL delete applied");
    expect(a.room.files["Board.md"]).toMatchObject({ serverSha256: null });
  });

  it("saves room settings (name/sourcePath/mountName/conflictPolicy/capabilities) and round-trips ACL grant/list/remove, on a room with a team grant present", async () => {
    const { app, baseUrl } = await startRelay();
    const { owner, room } = await setupRoomWithTeamGrant(app);
    void baseUrl;

    // Exactly RoomSettingsModal's "Save room settings" button -> plugin.updateRoomSettings ->
    // apiClient.updateRoom -> PATCH /api/rooms/:roomId (the plugin's apiClient.updateRoom() issues
    // a PATCH, not a PUT - see apps/obsidian-plugin/src/apiClient.ts).
    const updatePayload = {
      name: "Team Room Renamed",
      type: "folder" as const,
      sourcePath: "Team/Room",
      mountName: "Team Room V2",
      conflictPolicy: "owner_wins" as const,
      capabilities: [{ pluginId: "com.example.plugin", displayName: "Example Plugin", mode: "optional" }]
    };
    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/rooms/${room.id}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: updatePayload
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().room).toMatchObject({
      name: "Team Room Renamed",
      sourcePath: "Team/Room",
      mountName: "Team Room V2",
      conflictPolicy: "owner_wins"
    });

    // Persists: a later GET /api/rooms reflects the saved settings.
    const listResponse = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().rooms).toContainEqual(
      expect.objectContaining({ id: room.id, name: "Team Room Renamed", mountName: "Team Room V2", conflictPolicy: "owner_wins" })
    );

    // grantAcl -> listRoomAcl shows it -> removeAcl -> gone, exactly as RoomSettingsModal's ACL
    // rule list/remove controls call plugin.grantRoomAccess/listRoomAcl/removeAcl.
    const secondGrant = (
      await app.inject({
        method: "POST",
        url: `/api/rooms/${room.id}/acl`,
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { subjectType: "user", subjectId: owner.user.id, effect: "allow", preset: "reader", pathPattern: "Notes/**/*" }
      })
    ).json().aclRule;

    const aclAfterSecondGrant = (
      await app.inject({
        method: "GET",
        url: `/api/rooms/${room.id}/acl`,
        headers: { authorization: `Bearer ${owner.deviceToken}` }
      })
    ).json().aclRules;
    expect(aclAfterSecondGrant.map((rule: { id: string }) => rule.id)).toContain(secondGrant.id);

    const removeResponse = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${room.id}/acl/${secondGrant.id}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(removeResponse.statusCode).toBe(200);

    const aclAfterRemove = (
      await app.inject({
        method: "GET",
        url: `/api/rooms/${room.id}/acl`,
        headers: { authorization: `Bearer ${owner.deviceToken}` }
      })
    ).json().aclRules;
    expect(aclAfterRemove.map((rule: { id: string }) => rule.id)).not.toContain(secondGrant.id);
  });
});

describe("real client stack against a real listening relay (no Obsidian)", () => {
  it("propagates A's new file to B through push -> REST -> broadcast -> RoomSyncSocket -> vault write", async () => {
    const { app, baseUrl } = await startRelay();
    const { owner, member, room } = await setupRoomWithTwoMembers(app);
    const a = buildClient({ baseUrl, deviceToken: owner.deviceToken, deviceName: "A laptop", roomId: room.id, mountPath: mountPathForRoom({ owner: true, mountRoot: "Vault Rooms", mountName: room.mountName, sourcePath: room.sourcePath }) });
    const b = buildClient({ baseUrl, deviceToken: member.deviceToken, deviceName: "B laptop", roomId: room.id, mountPath: mountPathForRoom({ owner: false, mountRoot: "Vault Rooms", mountName: room.mountName, sourcePath: room.sourcePath }) });
    await connectAndSubscribe(a);
    await connectAndSubscribe(b);

    const aPath = `${a.room.mountPath}/Board.md`;
    await a.vault.write(aPath, "# Board\nhello\n");
    a.vault.fire({ type: "create", path: aPath });

    await waitFor(async () => (await b.vault.exists(`${b.room.mountPath}/Board.md`)) && (await b.vault.read(`${b.room.mountPath}/Board.md`)) === "# Board\nhello\n", "B to receive A's new file");
    expect(b.room.files["Board.md"]).toMatchObject({ dirty: false });
  });

  it("propagates B's edit to A", async () => {
    const { app, baseUrl } = await startRelay();
    const { owner, member, room } = await setupRoomWithTwoMembers(app);
    const a = buildClient({ baseUrl, deviceToken: owner.deviceToken, deviceName: "A laptop", roomId: room.id, mountPath: mountPathForRoom({ owner: true, mountRoot: "Vault Rooms", mountName: room.mountName, sourcePath: room.sourcePath }) });
    const b = buildClient({ baseUrl, deviceToken: member.deviceToken, deviceName: "B laptop", roomId: room.id, mountPath: mountPathForRoom({ owner: false, mountRoot: "Vault Rooms", mountName: room.mountName, sourcePath: room.sourcePath }) });
    await connectAndSubscribe(a);
    await connectAndSubscribe(b);

    const bPath = `${b.room.mountPath}/Board.md`;
    await b.vault.write(bPath, "# Board\nfrom B\n");
    b.vault.fire({ type: "create", path: bPath });
    await waitFor(async () => (await a.vault.exists(`${a.room.mountPath}/Board.md`)), "A to see B's created file");

    await b.vault.write(bPath, "# Board\nfrom B, edited\n");
    b.vault.fire({ type: "modify", path: bPath });

    await waitFor(async () => (await a.vault.exists(`${a.room.mountPath}/Board.md`)) && (await a.vault.read(`${a.room.mountPath}/Board.md`)) === "# Board\nfrom B, edited\n", "A to receive B's edit");
  });

  it("propagates B's delete to A", async () => {
    const { app, baseUrl } = await startRelay();
    const { owner, member, room } = await setupRoomWithTwoMembers(app);
    const a = buildClient({ baseUrl, deviceToken: owner.deviceToken, deviceName: "A laptop", roomId: room.id, mountPath: mountPathForRoom({ owner: true, mountRoot: "Vault Rooms", mountName: room.mountName, sourcePath: room.sourcePath }) });
    const b = buildClient({ baseUrl, deviceToken: member.deviceToken, deviceName: "B laptop", roomId: room.id, mountPath: mountPathForRoom({ owner: false, mountRoot: "Vault Rooms", mountName: room.mountName, sourcePath: room.sourcePath }) });
    await connectAndSubscribe(a);
    await connectAndSubscribe(b);

    const bPath = `${b.room.mountPath}/Board.md`;
    await b.vault.write(bPath, "# Board\n");
    b.vault.fire({ type: "create", path: bPath });
    await waitFor(async () => (await a.vault.exists(`${a.room.mountPath}/Board.md`)), "A to see B's created file");

    await b.vault.delete(bPath);
    b.vault.fire({ type: "delete", path: bPath });

    await waitFor(async () => !(await a.vault.exists(`${a.room.mountPath}/Board.md`)), "A to see the file removed");
    expect(a.room.files["Board.md"]).toMatchObject({ serverSha256: null });
  });

  it("propagates A's rename (within the room) to B as delete-old + create-new", async () => {
    const { app, baseUrl } = await startRelay();
    const { owner, member, room } = await setupRoomWithTwoMembers(app);
    const a = buildClient({ baseUrl, deviceToken: owner.deviceToken, deviceName: "A laptop", roomId: room.id, mountPath: mountPathForRoom({ owner: true, mountRoot: "Vault Rooms", mountName: room.mountName, sourcePath: room.sourcePath }) });
    const b = buildClient({ baseUrl, deviceToken: member.deviceToken, deviceName: "B laptop", roomId: room.id, mountPath: mountPathForRoom({ owner: false, mountRoot: "Vault Rooms", mountName: room.mountName, sourcePath: room.sourcePath }) });
    await connectAndSubscribe(a);
    await connectAndSubscribe(b);

    const oldPath = `${a.room.mountPath}/Old.md`;
    await a.vault.write(oldPath, "# Old\n");
    a.vault.fire({ type: "create", path: oldPath });
    await waitFor(async () => (await b.vault.exists(`${b.room.mountPath}/Old.md`)), "B to see A's original file");

    const newPath = `${a.room.mountPath}/New.md`;
    await a.vault.delete(oldPath);
    await a.vault.write(newPath, "# Old\n");
    a.vault.fire({ type: "rename", path: newPath, oldPath });

    await waitFor(async () => (await b.vault.exists(`${b.room.mountPath}/New.md`)) && !(await b.vault.exists(`${b.room.mountPath}/Old.md`)), "B to see the rename applied (new path present, old path gone)");
  });

  it("reconciles B's missed changes via room_snapshot after reconnecting", async () => {
    const { app, baseUrl } = await startRelay();
    const { owner, member, room } = await setupRoomWithTwoMembers(app);
    const a = buildClient({ baseUrl, deviceToken: owner.deviceToken, deviceName: "A laptop", roomId: room.id, mountPath: mountPathForRoom({ owner: true, mountRoot: "Vault Rooms", mountName: room.mountName, sourcePath: room.sourcePath }) });
    const b = buildClient({ baseUrl, deviceToken: member.deviceToken, deviceName: "B laptop", roomId: room.id, mountPath: mountPathForRoom({ owner: false, mountRoot: "Vault Rooms", mountName: room.mountName, sourcePath: room.sourcePath }) });
    await connectAndSubscribe(a);
    await connectAndSubscribe(b);

    // B goes offline.
    b.socket.disconnect();
    await waitFor(() => b.socket.getState() === "offline", "B to be offline");

    // While B is offline, A creates a file and edits another.
    const newWhileOffline = `${a.room.mountPath}/Offline.md`;
    await a.vault.write(newWhileOffline, "created while B offline");
    a.vault.fire({ type: "create", path: newWhileOffline });
    await waitFor(() => a.room.files["Offline.md"]?.dirty === false, "A's offline-created file to finish pushing");

    // B reconnects - room_snapshot reconcile must bring it current without needing a live broadcast.
    await connectAndSubscribe(b);
    await waitFor(async () => (await b.vault.exists(`${b.room.mountPath}/Offline.md`)) && (await b.vault.read(`${b.room.mountPath}/Offline.md`)) === "created while B offline", "B to catch up via room_snapshot reconcile");
  });

  it("syncs correctly on an established room with pre-existing files and pre-populated tracking state, without resurrecting or overwriting anything", async () => {
    const { app, baseUrl } = await startRelay();
    const { owner, member, room } = await setupRoomWithTwoMembers(app);

    // Pre-seed the relay with several files, as if this room has accumulated history before either
    // client in this test ever connects (the "old/established server" case).
    const seeded: Record<string, { version: number; content: string }> = {};
    for (const [path, content] of [
      ["Notes/One.md", "seeded one"],
      ["Notes/Two.md", "seeded two"],
      ["Board.md", "seeded board"]
    ] as const) {
      const write = await app.inject({
        method: "PUT",
        url: `/api/rooms/${room.id}/files/content`,
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { relativePath: path, baseVersion: 0, content }
      });
      expect(write.statusCode).toBe(200);
      seeded[path] = { version: write.json().version, content };
    }

    const aMountPath = mountPathForRoom({ owner: true, mountRoot: "Vault Rooms", mountName: room.mountName, sourcePath: room.sourcePath });
    const bMountPath = mountPathForRoom({ owner: false, mountRoot: "Vault Rooms", mountName: room.mountName, sourcePath: room.sourcePath });

    // Pre-populate each client's local vault AND MountedRoomState.files tracking as if a previous
    // session already synced these files - this is the "server cu" / established-room scenario.
    async function preSyncedFiles(mountPath: string, vault: FakeVaultAdapter): Promise<MountedRoomState["files"]> {
      const files: MountedRoomState["files"] = {};
      for (const [path, { version, content }] of Object.entries(seeded)) {
        await vault.write(`${mountPath}/${path}`, content);
        files[path] = { serverVersion: version, serverSha256: await VaultSyncEngine.sha256(content), localSha256: await VaultSyncEngine.sha256(content), dirty: false };
      }
      return files;
    }

    const aVaultForSeed = new FakeVaultAdapter();
    const aPreFiles = await preSyncedFiles(aMountPath, aVaultForSeed);
    const bVaultForSeed = new FakeVaultAdapter();
    const bPreFiles = await preSyncedFiles(bMountPath, bVaultForSeed);

    const a = buildClient({ baseUrl, deviceToken: owner.deviceToken, deviceName: "A laptop", roomId: room.id, mountPath: aMountPath, preExistingFiles: aPreFiles });
    const b = buildClient({ baseUrl, deviceToken: member.deviceToken, deviceName: "B laptop", roomId: room.id, mountPath: bMountPath, preExistingFiles: bPreFiles });
    // Copy the seeded on-disk state into the real per-client vaults built by buildClient.
    for (const [path] of Object.entries(seeded)) {
      a.vault.files.set(`${aMountPath}/${path}`, await aVaultForSeed.read(`${aMountPath}/${path}`));
      b.vault.files.set(`${bMountPath}/${path}`, await bVaultForSeed.read(`${bMountPath}/${path}`));
    }

    await connectAndSubscribe(a);
    await connectAndSubscribe(b);

    // Give reconcileSnapshot a moment to run (it runs synchronously off room_snapshot, already
    // awaited by the "connected" state above only up to hello_ok, not the snapshot itself - poll).
    const seededBoardVersion = seeded["Board.md"]!.version;
    await waitFor(() => a.room.files["Board.md"]?.serverVersion === seededBoardVersion, "A's snapshot reconcile to settle");
    await waitFor(() => b.room.files["Board.md"]?.serverVersion === seededBoardVersion, "B's snapshot reconcile to settle");

    // Nothing pre-existing should have been resurrected/overwritten: content matches what was
    // seeded, not some stale or blank value.
    for (const [path, { content }] of Object.entries(seeded)) {
      expect(await a.vault.read(`${aMountPath}/${path}`)).toBe(content);
      expect(await b.vault.read(`${bMountPath}/${path}`)).toBe(content);
    }

    // Scenario 1-3 on top of the established room: create, edit, delete still work correctly.
    const createdPath = `${aMountPath}/Notes/Three.md`;
    await a.vault.write(createdPath, "new note");
    a.vault.fire({ type: "create", path: createdPath });
    await waitFor(async () => (await b.vault.exists(`${bMountPath}/Notes/Three.md`)) && (await b.vault.read(`${bMountPath}/Notes/Three.md`)) === "new note", "B to receive the newly created file");

    const editPath = `${bMountPath}/Notes/One.md`;
    await b.vault.write(editPath, "seeded one, edited");
    b.vault.fire({ type: "modify", path: editPath });
    await waitFor(async () => (await a.vault.read(`${aMountPath}/Notes/One.md`)) === "seeded one, edited", "A to receive B's edit of a pre-existing file");

    const deletePath = `${bMountPath}/Notes/Two.md`;
    await b.vault.delete(deletePath);
    b.vault.fire({ type: "delete", path: deletePath });
    await waitFor(async () => !(await a.vault.exists(`${aMountPath}/Notes/Two.md`)), "A to see the pre-existing file deleted");

    // The untouched seeded file must remain exactly as-is throughout - no spurious resurrection.
    expect(await a.vault.read(`${aMountPath}/Board.md`)).toBe("seeded board");
    expect(await b.vault.read(`${bMountPath}/Board.md`)).toBe("seeded board");
  });
});

describe("Room Settings save -> Vault Rooms panel refresh (main.ts's updateRoomSettings/refreshRooms glue)", () => {
  /**
   * Regression coverage for a reported bug: after saving Room Settings with a changed "Source
   * path", the Vault Rooms panel behind the modal kept showing the OLD source path. The existing
   * "saves room settings" test above only drives the server via raw app.inject/REST - it never
   * exercises main.ts's own updateRoomSettings() -> refreshRooms() -> renderOpenRoomsViews() chain,
   * nor withInstalledCapabilities() (the .map() wrapper every room passes through on its way into
   * `visibleRooms`, which VaultRoomsView.render() reads live to print "Source: <path>").
   *
   * Obsidian's own `Plugin`/`ItemView`/`Modal` classes ship as type-only declarations (see
   * node_modules obsidian package.json: "main": "") - there is no real runtime implementation to
   * construct VaultRoomsPlugin/VaultRoomsView against in Node, so this test instead drives the
   * exact reproducible unit: RelayApiClient.updateRoom() (the real HTTP client
   * apiFor(server).updateRoom() resolves to) followed by RelayApiClient.listRooms(), through the
   * real withInstalledCapabilities() mapper - i.e. line-for-line what refreshRooms() does - and
   * then a render step that reads the resulting array LIVE the way VaultRoomsView.render() does
   * (no local caching of individual room fields).
   */
  it("reflects a changed sourcePath after PATCH -> refreshRooms, with no stale field retained by withInstalledCapabilities", async () => {
    const { app, baseUrl } = await startRelay();
    const { owner, room } = await setupRoomWithTeamGrant(app);
    const api = new RelayApiClient(baseUrl, owner.deviceToken);

    // Minimal fake App surface withInstalledCapabilities() actually touches (app.plugins.enabledPlugins).
    const fakeApp = { plugins: { enabledPlugins: new Set<string>(["com.example.plugin"]) } } as unknown as import("obsidian").App;

    // Exactly refreshRooms()'s own body, called once before the save to capture the "before" render.
    async function refreshRooms(): Promise<RoomSummary[]> {
      const result = await api.listRooms();
      return result.rooms.map((r) => withInstalledCapabilities(fakeApp, r));
    }

    // Exactly VaultRoomsView's "Source: ${room.sourcePath}" line - reads the passed-in array LIVE,
    // no caching/memoization of prior renders.
    function renderSourceLines(visibleRooms: RoomSummary[]): string[] {
      return visibleRooms.map((r) => `Source: ${r.sourcePath}`);
    }

    const before = await refreshRooms();
    expect(renderSourceLines(before)).toContainEqual(`Source: ${room.sourcePath}`);
    expect(room.sourcePath).not.toBe("Team/Room/Renamed");

    // Exactly updateRoomSettings()'s call sequence: apiFor(server).updateRoom(roomId, input) then
    // refreshRooms() (the PATCH response body itself is intentionally ignored by updateRoomSettings,
    // same as production code - only the follow-up listRooms() result feeds visibleRooms).
    await api.updateRoom(room.id, {
      name: "Team Room",
      type: "folder",
      sourcePath: "Team/Room/Renamed",
      mountName: room.mountName,
      conflictPolicy: "keep_both",
      capabilities: [{ pluginId: "com.example.plugin", displayName: "Example Plugin", mode: "optional" }]
    });

    const after = await refreshRooms();
    const afterRoom = after.find((r) => r.id === room.id);
    expect(afterRoom?.sourcePath).toBe("Team/Room/Renamed");
    expect(renderSourceLines(after)).toContainEqual("Source: Team/Room/Renamed");
    expect(renderSourceLines(after)).not.toContainEqual(`Source: ${room.sourcePath}`);

    // withInstalledCapabilities() must derive purely from the fresh server row, not merge/retain
    // anything from the "before" object it produced for the same room id on the previous call.
    expect(afterRoom).not.toBe(before.find((r) => r.id === room.id));
    expect(afterRoom?.capabilities).toEqual([{ pluginId: "com.example.plugin", displayName: "Example Plugin", mode: "optional", minVersion: undefined, installed: true }]);
  });
});
