import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { createApp } from "../src/app.js";
import type { FileRoutesOptions } from "../src/routes/file.routes.js";
import type { RoomRoutesOptions } from "../src/routes/room.routes.js";
import type { TeamRoutesOptions } from "../src/routes/team.routes.js";
import { ConnectionRegistry } from "../src/sync/connectionRegistry.js";
import { handleSyncSocket, type SyncTimerHost } from "../src/sync/syncServer.js";
import { injectBootstrap } from "./bootstrapHelper.js";

// Live cursors / note presence v1 (docs/superpowers/specs/2026-07-28-live-cursors-design.md).
// Real Fastify app, real WebSockets, real ACL/policy stack - the whole point is that presence is
// gated by exactly the same per-path authorization as content, over a transport that actually
// serializes. Pure ownership/replacement semantics live in presenceRegistry.test.ts.

type JsonSocket = WebSocket & { sendJson: (payload: unknown) => void };

function assertPresenceServiceIsRequiredByEveryLifecycleRoute(): void {
  // @ts-expect-error Presence cleanup must not be silently omitted from REST file deletion.
  const fileOptions: FileRoutesOptions = { maxFileBytes: 1 };
  // @ts-expect-error Presence cleanup must not be silently omitted from room lifecycle/ACL routes.
  const roomOptions: RoomRoutesOptions = { publicUrl: "http://127.0.0.1" };
  // @ts-expect-error Presence revalidation must not be silently omitted from team membership routes.
  const teamOptions: TeamRoutesOptions = {
    publicUrl: "http://127.0.0.1",
    allowRemoteBootstrap: false,
    bootstrapPin: "test"
  };
  void [fileOptions, roomOptions, teamOptions];
}

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
const sockets: WebSocket[] = [];
const messageQueues = new WeakMap<WebSocket, unknown[]>();

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of apps.splice(0)) await app.close();
});

async function connect(app: Awaited<ReturnType<typeof createApp>>): Promise<JsonSocket> {
  await app.ready();
  const socket = (await app.injectWS("/sync")) as unknown as JsonSocket;
  socket.sendJson = (payload: unknown) => socket.send(JSON.stringify(payload));
  sockets.push(socket);
  messageQueues.set(socket, []);
  socket.on("message", (raw: WebSocket.RawData) => {
    messageQueues.get(socket)!.push(JSON.parse(raw.toString()));
  });
  return socket;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function nextMessage(socket: WebSocket, type: string): Promise<any> {
  const deadline = Date.now() + 2_000;
  const queue = messageQueues.get(socket)!;
  for (;;) {
    const index = queue.findIndex((message) => (message as { type?: string }).type === type);
    if (index !== -1) return queue.splice(index, 1)[0];
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${type}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function seen(socket: WebSocket, type: string): unknown[] {
  return messageQueues.get(socket)!.filter((message) => (message as { type?: string }).type === type);
}

/** Presence is fire-and-forget, so "nothing arrived" needs a real settle window rather than an
 *  immediate assertion - otherwise the test passes for the wrong reason. */
async function settle(ms = 120): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** `seen` is non-destructive, so a test that asserts on a batch and then waits for the *next* message
 *  of the same type has to clear the batch first - otherwise nextMessage returns a stale one. */
function drain(socket: WebSocket, type: string): unknown[] {
  const queue = messageQueues.get(socket)!;
  const matched = queue.filter((message) => (message as { type?: string }).type === type);
  for (const message of matched) queue.splice(queue.indexOf(message), 1);
  return matched;
}

async function helloAndSubscribe(
  socket: JsonSocket,
  token: string,
  roomId: string,
  capabilities: { crdt?: boolean; presence?: boolean } = { crdt: true, presence: true }
): Promise<void> {
  socket.sendJson({
    type: "hello",
    requestId: "h",
    token,
    client: { kind: "obsidian-plugin", version: "0.3.0", deviceName: "device" },
    capabilities
  });
  await nextMessage(socket, "hello_ok");
  socket.sendJson({ type: "subscribe_room", requestId: "s", roomId });
  await nextMessage(socket, "room_snapshot");
}

function cursor(clock = 1) {
  return {
    yanchor: { tname: "content", assoc: 0, item: { client: 7, clock } },
    yhead: { tname: "content", assoc: 0, item: { client: 7, clock: clock + 3 } }
  };
}

async function setupRoom(options: { presenceNow?: () => number; presenceMax?: number } = {}) {
  const app = await createApp({
    dbPath: ":memory:",
    publicUrl: "http://127.0.0.1:8787",
    ...(options.presenceNow || options.presenceMax !== undefined
      ? { rateLimit: { presenceNow: options.presenceNow, presenceMax: options.presenceMax } }
      : {})
  });
  apps.push(app);
  const owner = (await injectBootstrap(app, { displayName: "Owner", deviceName: "Owner laptop", teamName: "Demo" })).json();
  const room = (
    await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Room", type: "folder", sourcePath: "Room", mountName: "Room", capabilities: [] }
    })
  ).json().room;
  await app.inject({
    method: "PATCH",
    url: `/api/rooms/${room.id}`,
    headers: { authorization: `Bearer ${owner.deviceToken}` },
    payload: { name: room.name, type: room.type, sourcePath: room.sourcePath, mountName: room.mountName, crdtEnabled: true }
  });
  return { app, owner, room };
}

async function addMember(
  app: Awaited<ReturnType<typeof createApp>>,
  owner: { deviceToken: string; team: { id: string } },
  room: { id: string },
  preset: "editor" | "reader",
  pathPattern = "**/*"
) {
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
      payload: { inviteToken: invite.inviteToken, displayName: "Member", deviceName: "Member laptop" }
    })
  ).json();
  const acl = (
    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", preset, pathPattern }
    })
  ).json();
  // sync:subscribe granted broadly regardless of the path-scoped preset above (same fixture pattern
  // as crdt-sync-flow.test.ts) - only file:read/write should be path-scoped here, so that revoking a
  // path grant leaves the room subscription intact. That combination is exactly what the room-level
  // revalidation cannot see, and what the presence sweep exists for.
  await app.inject({
    method: "POST",
    url: `/api/rooms/${room.id}/acl`,
    headers: { authorization: `Bearer ${owner.deviceToken}` },
    payload: {
      subjectType: "user",
      subjectId: member.user.id,
      effect: "allow",
      permissions: ["sync:subscribe"],
      pathPattern: "**/*"
    }
  });
  return { member, aclId: acl.aclRule.id as string };
}

async function createDocument(socket: JsonSocket, roomId: string, relativePath: string): Promise<number> {
  socket.sendJson({ type: "crdt_create", requestId: `c_${relativePath}`, roomId, relativePath });
  const created = await nextMessage(socket, "crdt_created");
  return created.epoch as number;
}

describe("presence over the sync socket", () => {
  it("server-stamps user identity and sends one first-state snapshot", async () => {
    const { app, owner, room } = await setupRoom();
    const a = await connect(app);
    await helloAndSubscribe(a, owner.deviceToken, room.id);
    const epoch = await createDocument(a, room.id, "Board.md");

    const b = await connect(app);
    await helloAndSubscribe(b, owner.deviceToken, room.id);

    a.sendJson({ type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch, clientId: 11, cursor: cursor() });
    const fanout = await nextMessage(b, "remote_presence");

    // Identity comes from the authenticated principal, never the payload - the client never sent a
    // userId or display name at all.
    expect(fanout.state.user).toEqual({ userId: owner.user.id, displayName: "Owner" });
    expect(fanout.state.clientId).toBe(11);
    expect(fanout.state.cursor).toEqual(cursor());

    // First non-null state for B earns B a snapshot of the peers already present.
    b.sendJson({ type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch, clientId: 22, cursor: cursor(9) });
    const snapshot = await nextMessage(b, "presence_snapshot");
    expect(snapshot.states).toHaveLength(1);
    expect(snapshot.states[0].clientId).toBe(11);

    // A second update from the same connection is a plain move: fanout only, no fresh snapshot.
    b.sendJson({ type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch, clientId: 22, cursor: cursor(12) });
    await nextMessage(a, "remote_presence");
    await settle();
    expect(seen(b, "presence_snapshot")).toHaveLength(0);
  });

  it("never sends presence to a legacy or crdt-only connection", async () => {
    const { app, owner, room } = await setupRoom();
    const a = await connect(app);
    await helloAndSubscribe(a, owner.deviceToken, room.id);
    const epoch = await createDocument(a, room.id, "Board.md");

    const crdtOnly = await connect(app);
    await helloAndSubscribe(crdtOnly, owner.deviceToken, room.id, { crdt: true });
    const legacy = await connect(app);
    await helloAndSubscribe(legacy, owner.deviceToken, room.id, {});

    a.sendJson({ type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch, clientId: 11, cursor: cursor() });
    await settle();

    expect(seen(crdtOnly, "remote_presence")).toHaveLength(0);
    expect(seen(legacy, "remote_presence")).toHaveLength(0);
  });

  it("rejects a presence_set from a connection that never advertised presence", async () => {
    const { app, owner, room } = await setupRoom();
    const a = await connect(app);
    await helloAndSubscribe(a, owner.deviceToken, room.id);
    const epoch = await createDocument(a, room.id, "Board.md");

    const crdtOnly = await connect(app);
    await helloAndSubscribe(crdtOnly, owner.deviceToken, room.id, { crdt: true });
    crdtOnly.sendJson({
      type: "presence_set",
      roomId: room.id,
      relativePath: "Board.md",
      epoch,
      clientId: 33,
      cursor: cursor()
    });

    const rejected = await nextMessage(crdtOnly, "presence_rejected");
    expect(rejected.code).toBe("CRDT_CAPABILITY_REQUIRED");
    // Rejection must never be fatal - cursor noise cannot cost someone their editing session.
    expect(crdtOnly.readyState).toBe(crdtOnly.OPEN);
  });

  it("gates sender, snapshot, and every recipient on exact-path file:read", async () => {
    const { app, owner, room } = await setupRoom();
    const a = await connect(app);
    await helloAndSubscribe(a, owner.deviceToken, room.id);
    const visibleEpoch = await createDocument(a, room.id, "Visible.md");
    const secretEpoch = await createDocument(a, room.id, "Secret.md");

    // Member may only read Visible.md, but is subscribed to the whole room.
    const { member } = await addMember(app, owner, room, "editor", "Visible.md");
    const b = await connect(app);
    await helloAndSubscribe(b, member.deviceToken, room.id);

    a.sendJson({
      type: "presence_set",
      roomId: room.id,
      relativePath: "Secret.md",
      epoch: secretEpoch,
      clientId: 11,
      cursor: cursor()
    });
    await settle();
    // A path the member cannot read never reveals that someone is editing it.
    expect(seen(b, "remote_presence")).toHaveLength(0);

    a.sendJson({
      type: "presence_set",
      roomId: room.id,
      relativePath: "Visible.md",
      epoch: visibleEpoch,
      clientId: 12,
      cursor: cursor()
    });
    expect((await nextMessage(b, "remote_presence")).relativePath).toBe("Visible.md");

    // And the sender is gated too: the member cannot announce on a path it cannot read.
    b.sendJson({
      type: "presence_set",
      roomId: room.id,
      relativePath: "Secret.md",
      epoch: secretEpoch,
      clientId: 21,
      cursor: cursor()
    });
    expect((await nextMessage(b, "presence_rejected")).code).toBe("PERMISSION_DENIED");
  });

  it("rejects malformed renderer keys, cursors, and stale epochs without closing the socket", async () => {
    const { app, owner, room } = await setupRoom();
    const a = await connect(app);
    await helloAndSubscribe(a, owner.deviceToken, room.id);
    const epoch = await createDocument(a, room.id, "Board.md");
    const base = { type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch };

    for (const clientId of [-1, 1.5, 0x1_0000_0000, Number.NaN, "7"]) {
      a.sendJson({ ...base, clientId, cursor: cursor() });
      const rejected = await nextMessage(a, "presence_rejected");
      expect(rejected.code).toBe("VALIDATION_ERROR");
    }

    for (const bad of [{}, { yanchor: cursor().yanchor }, { yanchor: 1, yhead: 2 }, { yanchor: [], yhead: [] }]) {
      a.sendJson({ ...base, clientId: 11, cursor: bad });
      expect((await nextMessage(a, "presence_rejected")).code).toBe("VALIDATION_ERROR");
    }

    a.sendJson({ ...base, epoch: epoch + 5, clientId: 11, cursor: cursor() });
    const stale = await nextMessage(a, "presence_rejected");
    expect(stale.code).toBe("CRDT_STALE_EPOCH");
    expect(stale.currentEpoch).toBe(epoch);

    expect(a.readyState).toBe(a.OPEN);
  });

  it("rejects an oversized presence payload", async () => {
    const { app, owner, room } = await setupRoom();
    const a = await connect(app);
    await helloAndSubscribe(a, owner.deviceToken, room.id);
    const epoch = await createDocument(a, room.id, "Board.md");

    a.sendJson({
      type: "presence_set",
      roomId: room.id,
      relativePath: "Board.md",
      epoch,
      clientId: 11,
      cursor: { yanchor: { tname: "x".repeat(9_000), assoc: 0 }, yhead: cursor().yhead }
    });

    expect((await nextMessage(a, "presence_rejected")).code).toBe("VALIDATION_ERROR");
    expect(a.readyState).toBe(a.OPEN);
  });

  it("keeps colliding renderer keys isolated and rejects the later claimant", async () => {
    const { app, owner, room } = await setupRoom();
    const a = await connect(app);
    await helloAndSubscribe(a, owner.deviceToken, room.id);
    const epoch = await createDocument(a, room.id, "Board.md");
    const b = await connect(app);
    await helloAndSubscribe(b, owner.deviceToken, room.id);

    const message = { type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch, cursor: cursor() };
    a.sendJson({ ...message, clientId: 77 });
    await nextMessage(b, "remote_presence");

    b.sendJson({ ...message, clientId: 77 });
    expect((await nextMessage(b, "presence_rejected")).code).toBe("VALIDATION_ERROR");

    // A's state survives untouched - a rejected claim must leave the registry alone.
    b.sendJson({ ...message, clientId: 78 });
    const snapshot = await nextMessage(b, "presence_snapshot");
    expect(snapshot.states.map((state: { clientId: number }) => state.clientId)).toEqual([77]);
  });

  it("replaces a changed renderer key with remove-old then add-new", async () => {
    const { app, owner, room } = await setupRoom();
    const a = await connect(app);
    await helloAndSubscribe(a, owner.deviceToken, room.id);
    const epoch = await createDocument(a, room.id, "Board.md");
    const b = await connect(app);
    await helloAndSubscribe(b, owner.deviceToken, room.id);

    const message = { type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch, cursor: cursor() };
    a.sendJson({ ...message, clientId: 11 });
    await nextMessage(b, "remote_presence");

    // This is the epoch-bump/recovery shape: same human, same connection, brand-new Y.Doc clientID.
    a.sendJson({ ...message, clientId: 12 });
    await settle();

    const fanouts = seen(b, "remote_presence") as Array<{ state: { clientId: number; cursor: unknown } }>;
    expect(fanouts.map((message) => [message.state.clientId, message.state.cursor === null])).toEqual([
      [11, true],
      [12, false]
    ]);
  });

  it("removes state on a null cursor and stays idempotent for a stale renderer key", async () => {
    const { app, owner, room } = await setupRoom();
    const a = await connect(app);
    await helloAndSubscribe(a, owner.deviceToken, room.id);
    const epoch = await createDocument(a, room.id, "Board.md");
    const b = await connect(app);
    await helloAndSubscribe(b, owner.deviceToken, room.id);

    const base = { type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch };
    a.sendJson({ ...base, clientId: 11, cursor: cursor() });
    await nextMessage(b, "remote_presence");

    // A null from an already-retired renderer key must not remove the live state.
    a.sendJson({ ...base, clientId: 99, cursor: null });
    await settle();
    expect(seen(b, "remote_presence")).toHaveLength(0);

    a.sendJson({ ...base, clientId: 11, cursor: null });
    const removal = await nextMessage(b, "remote_presence");
    expect(removal.state).toMatchObject({ clientId: 11, cursor: null });

    // Repeat removals are inert.
    a.sendJson({ ...base, clientId: 11, cursor: null });
    await settle();
    expect(seen(b, "remote_presence")).toHaveLength(0);
  });

  it("drops updates past the window budget but never a removal, and recovers next window", async () => {
    let now = 1_000;
    const { app, owner, room } = await setupRoom({ presenceNow: () => now, presenceMax: 3 });
    const a = await connect(app);
    await helloAndSubscribe(a, owner.deviceToken, room.id);
    const epoch = await createDocument(a, room.id, "Board.md");
    const b = await connect(app);
    await helloAndSubscribe(b, owner.deviceToken, room.id);

    const base = { type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch, clientId: 11 };
    for (let i = 0; i < 5; i += 1) {
      a.sendJson({ ...base, cursor: cursor(i + 1) });
    }
    await settle(200);
    // Exactly the budget lands; the excess is silently shed rather than rejected or fatal.
    expect(drain(b, "remote_presence")).toHaveLength(3);
    expect(a.readyState).toBe(a.OPEN);

    // A retraction is cleanup, not noise: it must go through even while throttled, or a throttled
    // client strands a ghost cursor on every peer.
    a.sendJson({ ...base, cursor: null });
    const removal = await nextMessage(b, "remote_presence");
    expect(removal.state.cursor).toBeNull();

    now += 1_001;
    a.sendJson({ ...base, cursor: cursor(50) });
    expect((await nextMessage(b, "remote_presence")).state.cursor).toEqual(cursor(50));
  });

  it("clears presence when the sender unsubscribes", async () => {
    const { app, owner, room } = await setupRoom();
    const a = await connect(app);
    await helloAndSubscribe(a, owner.deviceToken, room.id);
    const epoch = await createDocument(a, room.id, "Board.md");
    const b = await connect(app);
    await helloAndSubscribe(b, owner.deviceToken, room.id);

    a.sendJson({ type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch, clientId: 11, cursor: cursor() });
    await nextMessage(b, "remote_presence");

    a.sendJson({ type: "unsubscribe_room", requestId: "u", roomId: room.id });
    expect((await nextMessage(b, "remote_presence")).state).toMatchObject({ clientId: 11, cursor: null });
  });

  // The socket-close path cannot be covered through `injectWS`: closing the client end of an injected
  // WebSocket never fires the server's "close" event, which is why no test in this repo asserts the
  // `sync.disconnected` audit either. Verified empirically before writing it this way. So the close
  // *wiring* is asserted at the handleSyncSocket boundary with a fake socket, and what
  // removeConnection actually removes is covered by presenceRegistry.test.ts.
  it("clears presence from the socket-close handler", () => {
    const registry = new ConnectionRegistry();
    const socket = new FakeSyncSocket();
    const cleared: unknown[] = [];

    handleSyncSocket(socket, {} as never, registry, {
      maxFileBytes: 1024,
      maxConnections: 5,
      transport: "http",
      timerHost: new NoopTimerHost(),
      crdtDocManager: {} as never,
      presenceService: {
        removeConnection: (connection: unknown) => {
          cleared.push(connection);
        }
      } as never
    });

    socket.emitClose();

    expect(cleared).toHaveLength(1);
    expect(registry.size()).toBe(0);
  });

  it("survives a presence cleanup failure during socket close", () => {
    const registry = new ConnectionRegistry();
    const socket = new FakeSyncSocket();

    handleSyncSocket(socket, {} as never, registry, {
      maxFileBytes: 1024,
      maxConnections: 5,
      transport: "http",
      timerHost: new NoopTimerHost(),
      crdtDocManager: {} as never,
      presenceService: {
        // The server may already be tearing down when this runs, so a throw here must not prevent
        // the rest of the close handler (audit write, registry removal) from completing.
        removeConnection: () => {
          throw new Error("db closed");
        }
      } as never
    });

    expect(() => socket.emitClose()).not.toThrow();
    expect(registry.size()).toBe(0);
  });

  it("clears presence when the document is deleted over either transport", async () => {
    for (const transport of ["ws", "rest"] as const) {
      const { app, owner, room } = await setupRoom();
      const a = await connect(app);
      await helloAndSubscribe(a, owner.deviceToken, room.id);
      const epoch = await createDocument(a, room.id, "Board.md");
      const b = await connect(app);
      await helloAndSubscribe(b, owner.deviceToken, room.id);

      a.sendJson({ type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch, clientId: 11, cursor: cursor() });
      await nextMessage(b, "remote_presence");

      if (transport === "ws") {
        a.sendJson({ type: "file_delete", requestId: "d", roomId: room.id, relativePath: "Board.md", baseVersion: 0 });
      } else {
        await app.inject({
          method: "POST",
          url: `/api/rooms/${room.id}/files/delete`,
          headers: { authorization: `Bearer ${owner.deviceToken}` },
          payload: { relativePath: "Board.md", baseVersion: 0 }
        });
      }

      const removal = await nextMessage(b, "remote_presence");
      expect(removal.state, `${transport} delete should clear presence`).toMatchObject({ clientId: 11, cursor: null });
    }
  });

  it("clears presence on rename before the rename fans out", async () => {
    const { app, owner, room } = await setupRoom();
    const a = await connect(app);
    await helloAndSubscribe(a, owner.deviceToken, room.id);
    const epoch = await createDocument(a, room.id, "Board.md");
    const b = await connect(app);
    await helloAndSubscribe(b, owner.deviceToken, room.id);

    a.sendJson({ type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch, clientId: 11, cursor: cursor() });
    await nextMessage(b, "remote_presence");

    a.sendJson({ type: "crdt_rename", requestId: "r", roomId: room.id, oldRelativePath: "Board.md", relativePath: "Renamed.md" });
    await nextMessage(a, "crdt_renamed");

    // A rename keeps the epoch, so the old-path entry would otherwise orphan and show a duplicate
    // caret alongside the new path's.
    const removal = await nextMessage(b, "remote_presence");
    expect(removal.relativePath).toBe("Board.md");
    expect(removal.state.cursor).toBeNull();
  });

  it("clears presence when the room is deleted or leaves the CRDT lane", async () => {
    for (const action of ["delete", "disable"] as const) {
      const { app, owner, room } = await setupRoom();
      const a = await connect(app);
      await helloAndSubscribe(a, owner.deviceToken, room.id);
      const epoch = await createDocument(a, room.id, "Board.md");
      const b = await connect(app);
      await helloAndSubscribe(b, owner.deviceToken, room.id);

      a.sendJson({ type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch, clientId: 11, cursor: cursor() });
      await nextMessage(b, "remote_presence");

      if (action === "delete") {
        await app.inject({
          method: "DELETE",
          url: `/api/rooms/${room.id}`,
          headers: { authorization: `Bearer ${owner.deviceToken}` }
        });
      } else {
        await app.inject({
          method: "PATCH",
          url: `/api/rooms/${room.id}`,
          headers: { authorization: `Bearer ${owner.deviceToken}` },
          payload: {
            name: room.name,
            type: room.type,
            sourcePath: room.sourcePath,
            mountName: room.mountName,
            crdtEnabled: false
          }
        });
      }

      const removal = await nextMessage(b, "remote_presence");
      expect(removal.state, `room ${action} should clear presence`).toMatchObject({ clientId: 11, cursor: null });
    }
  });

  it("removes only the entries that lost path-scoped file:read on an ACL mutation", async () => {
    const { app, owner, room } = await setupRoom();
    const a = await connect(app);
    await helloAndSubscribe(a, owner.deviceToken, room.id);
    const keepEpoch = await createDocument(a, room.id, "Keep.md");
    const loseEpoch = await createDocument(a, room.id, "Lose.md");

    const { member, aclId } = await addMember(app, owner, room, "editor", "**/*");
    const b = await connect(app);
    await helloAndSubscribe(b, member.deviceToken, room.id);

    b.sendJson({ type: "presence_set", roomId: room.id, relativePath: "Keep.md", epoch: keepEpoch, clientId: 21, cursor: cursor() });
    await nextMessage(a, "remote_presence");
    b.sendJson({ type: "presence_set", roomId: room.id, relativePath: "Lose.md", epoch: loseEpoch, clientId: 22, cursor: cursor() });
    await nextMessage(a, "remote_presence");

    // Narrow the grant to Keep.md only. Order matters: add the replacement rule *first*, then revoke
    // the broad one - revoking first would briefly leave the member with no file:read at all, and the
    // sweep that DELETE triggers would then (correctly) clear both cursors, testing nothing.
    // Room-level sync:subscribe is untouched throughout, so the existing room-level revalidation sees
    // nothing at all here - this is exactly the gap the presence sweep closes.
    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "editor", pathPattern: "Keep.md" }
    });
    await app.inject({
      method: "DELETE",
      url: `/api/rooms/${room.id}/acl/${aclId}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    await settle(200);

    const rejections = seen(b, "presence_rejected") as Array<{ relativePath: string; code: string }>;
    expect(rejections.map((message) => message.relativePath)).toEqual(["Lose.md"]);
    expect(rejections[0]?.code).toBe("PERMISSION_DENIED");
    expect(b.readyState).toBe(b.OPEN);

    // Keep.md's cursor survives; only the revoked path's is retracted to peers.
    const removals = (seen(a, "remote_presence") as Array<{ relativePath: string; state: { cursor: unknown } }>).filter(
      (message) => message.state.cursor === null
    );
    expect(removals.map((message) => message.relativePath)).toEqual(["Lose.md"]);
  });

  it("writes nothing to SQLite for presence traffic", async () => {
    const { app, owner, room } = await setupRoom();
    const a = await connect(app);
    await helloAndSubscribe(a, owner.deviceToken, room.id);
    const epoch = await createDocument(a, room.id, "Board.md");

    const before = (
      await app.inject({ method: "GET", url: "/api/audit", headers: { authorization: `Bearer ${owner.deviceToken}` } })
    ).json();
    const versionBefore = (
      await app.inject({
        method: "GET",
        url: `/api/rooms/${room.id}/files`,
        headers: { authorization: `Bearer ${owner.deviceToken}` }
      })
    )
      .json()
      .files.find((file: { relativePath: string }) => file.relativePath === "Board.md")?.version;

    for (let i = 0; i < 5; i += 1) {
      a.sendJson({ type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch, clientId: 11, cursor: cursor(i + 1) });
    }
    a.sendJson({ type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch, clientId: 11, cursor: null });
    await settle(200);

    const after = (
      await app.inject({ method: "GET", url: "/api/audit", headers: { authorization: `Bearer ${owner.deviceToken}` } })
    ).json();
    // Presence is ephemeral by contract: no audit rows, no file versions, nothing durable at all.
    expect(after.events.length).toBe(before.events.length);

    const version = async (): Promise<number | undefined> =>
      (
        await app.inject({
          method: "GET",
          url: `/api/rooms/${room.id}/files`,
          headers: { authorization: `Bearer ${owner.deviceToken}` }
        })
      )
        .json()
        .files.find((file: { relativePath: string }) => file.relativePath === "Board.md")?.version;
    // Whatever crdt_create established, presence traffic must not have moved it.
    expect(await version()).toBe(versionBefore);
  });
});

/** Minimal socket double for the close-path tests - `injectWS` never fires a server-side close. */
class FakeSyncSocket {
  readonly OPEN = 1;
  readonly readyState = 1;
  readonly sent: string[] = [];
  private closeListener?: () => void;

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.emitClose();
  }

  ping(): void {}

  on(event: "message" | "close", listener: ((raw: { toString(): string }) => void) | (() => void)): void {
    if (event === "close") this.closeListener = listener as () => void;
  }

  emitClose(): void {
    this.closeListener?.();
  }
}

class NoopTimerHost implements SyncTimerHost {
  setInterval(): unknown {
    return "interval";
  }
  clearInterval(): void {}
  setTimeout(): unknown {
    return "timeout";
  }
  clearTimeout(): void {}
}
