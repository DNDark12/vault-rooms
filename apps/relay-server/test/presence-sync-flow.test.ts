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
  pathPattern = "**/*",
  displayName = "Member"
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
      payload: { inviteToken: invite.inviteToken, displayName, deviceName: `${displayName} laptop` }
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

    // Identity and colour both come from the relay, never the payload - the client never sent a
    // userId, a display name, or a hue at all.
    expect(fanout.state.user.userId).toBe(owner.user.id);
    expect(fanout.state.user.displayName).toBe("Owner");
    expect(fanout.state.user.hue).toBeGreaterThanOrEqual(0);
    expect(fanout.state.user.hue).toBeLessThan(360);
    expect(fanout.state.clientId).toBe(11);
    expect(fanout.state.cursor).toEqual(cursor());

    // First non-null state for B earns B a snapshot of the peers already present.
    b.sendJson({ type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch, clientId: 22, cursor: cursor(9) });
    const snapshot = await nextMessage(b, "presence_snapshot");
    expect(snapshot.states).toHaveLength(1);
    expect(snapshot.states[0].clientId).toBe(11);
    // A and B are the same authenticated user on two connections - one human, one colour. The hue
    // must also be identical in the snapshot and the fanout, or the two delivery paths disagree.
    expect(snapshot.states[0].user.hue).toBe(fanout.state.user.hue);
    const ownSecondDevice = await nextMessage(a, "remote_presence");
    expect(ownSecondDevice.state.user.hue).toBe(fanout.state.user.hue);
    drain(a, "remote_presence");

    // A second update from the same connection is a plain move: fanout only, no fresh snapshot.
    b.sendJson({ type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch, clientId: 22, cursor: cursor(12) });
    await nextMessage(a, "remote_presence");
    await settle();
    expect(seen(b, "presence_snapshot")).toHaveLength(0);
  });

  // The bug this reproduces at the serialized relay boundary: with client-side hashing, "one receiver
  // shows two identical carets while the other looks fine" was possible, because each client derived
  // colour independently. Three distinct users is the smallest case where a receiver sees two remote
  // peers at once and can therefore observe a collision.
  it("gives three distinct users three distinct hues that every receiver agrees on", async () => {
    const { app, owner, room } = await setupRoom();
    const alice = await addMember(app, owner, room, "editor", "**/*", "Alice");
    const bob = await addMember(app, owner, room, "editor", "**/*", "Bob");

    const ownerSocket = await connect(app);
    await helloAndSubscribe(ownerSocket, owner.deviceToken, room.id);
    const epoch = await createDocument(ownerSocket, room.id, "Board.md");

    const aliceSocket = await connect(app);
    await helloAndSubscribe(aliceSocket, alice.member.deviceToken, room.id);
    const bobSocket = await connect(app);
    await helloAndSubscribe(bobSocket, bob.member.deviceToken, room.id);

    const base = { type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch };
    ownerSocket.sendJson({ ...base, clientId: 11, cursor: cursor(1) });
    aliceSocket.sendJson({ ...base, clientId: 22, cursor: cursor(2) });
    bobSocket.sendJson({ ...base, clientId: 33, cursor: cursor(3) });

    // `seen` is non-destructive but `nextMessage` splices, so this deliberately settles instead of
    // awaiting a specific frame - consuming one here would hide it from the collection below.
    await settle(250);

    const statesFor = (socket: JsonSocket) => {
      const byClientId = new Map<number, { user: { displayName: string; hue?: number } }>();
      for (const message of [...seen(socket, "presence_snapshot"), ...seen(socket, "remote_presence")]) {
        const typed = message as { states?: Array<{ clientId: number }>; state?: { clientId: number } };
        for (const state of typed.states ?? (typed.state ? [typed.state] : [])) {
          byClientId.set(state.clientId, state as unknown as { user: { displayName: string; hue?: number } });
        }
      }
      return [...byClientId.values()];
    };

    const ownerRemoteStates = statesFor(ownerSocket);
    const aliceRemoteStates = statesFor(aliceSocket);

    expect(ownerRemoteStates.map((state) => state.user.displayName).sort()).toEqual(["Alice", "Bob"]);
    expect(aliceRemoteStates.map((state) => state.user.displayName).sort()).toEqual(["Bob", "Owner"]);
    expect(new Set(ownerRemoteStates.map((state) => state.user.hue)).size).toBe(2);
    expect(new Set(aliceRemoteStates.map((state) => state.user.hue)).size).toBe(2);

    // Across both receivers the three humans must resolve to three distinct hues, and each human must
    // look the same colour to everyone - that agreement is the whole point of moving assignment to
    // the relay.
    const huesByName = new Map(
      [...ownerRemoteStates, ...aliceRemoteStates].map((state) => [state.user.displayName, state.user.hue])
    );
    expect([...huesByName.keys()].sort()).toEqual(["Alice", "Bob", "Owner"]);
    expect(new Set(huesByName.values()).size).toBe(3);

    const bobAtOwner = ownerRemoteStates.find((state) => state.user.displayName === "Bob");
    const bobAtAlice = aliceRemoteStates.find((state) => state.user.displayName === "Bob");
    expect(bobAtOwner?.user.hue).toBe(bobAtAlice?.user.hue);
  });

  // Two wiring points that no observable frame can prove, verified the same way presenceRegistry's
  // "never writes through SQLite" guard is - by reading the source. Both are one-line calls that a
  // refactor can silently drop, and both fail in ways that only show up after minutes of real use:
  // a lease outliving revoked room access, or hues no longer following join order.
  it("wires hue preallocation to subscribe_room and lease cleanup to revalidation", async () => {
    const fs = await import("node:fs");
    const syncServer = fs.readFileSync(new URL("../src/sync/syncServer.ts", import.meta.url), "utf8");
    const presenceService = fs.readFileSync(new URL("../src/sync/presenceService.ts", import.meta.url), "utf8");

    // Guarded by room.crdt_enabled: a non-CRDT room has no cursors, so it must not lease a colour.
    expect(syncServer).toMatch(/if \(room\.crdt_enabled\) \{\s*options\.presenceService\.joinRoom\(connection, room\.id\);/);
    expect(presenceService).toMatch(/joinRoom\(connection: SyncConnection, roomId: string\): void/);
    expect(presenceService).toMatch(/removeUnsubscribedRoomHues\(\)/);
  });

  // Hue leases are keyed by (roomId, userId) and assume a connection's identity never changes. A second
  // `hello` used to replace `connection.principal` in place while leaving this connection's
  // subscriptions, presence states, and hue membership bound to the previous user - so one socket
  // alternating identities re-leased a colour on every publish (0 -> 137.508 -> 0). Rejecting the
  // identity *change* is what makes the allocator's assumption true rather than merely hoped for.
  //
  // Re-hello as the same device stays allowed on purpose: device-revoke-flow.test.ts uses it as a
  // liveness probe, and it needs no rekeying because nothing about the identity moved.
  it("rejects a hello that would change a live connection's identity, but allows a same-device re-hello", async () => {
    const { app, owner, room } = await setupRoom();
    const alice = await addMember(app, owner, room, "editor", "**/*", "Alice");

    const a = await connect(app);
    await helloAndSubscribe(a, owner.deviceToken, room.id);
    const epoch = await createDocument(a, room.id, "Board.md");

    const observer = await connect(app);
    await helloAndSubscribe(observer, owner.deviceToken, room.id);

    const base = { type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch };
    a.sendJson({ ...base, clientId: 11, cursor: cursor(1) });
    const before = await nextMessage(observer, "remote_presence");
    const hello = { client: { kind: "obsidian-plugin", version: "0.3.0", deviceName: "device" }, capabilities: { crdt: true, presence: true } };

    // Same device: a harmless re-ack, and the published hue must not move.
    a.sendJson({ type: "hello", requestId: "same", token: owner.deviceToken, ...hello });
    expect(await nextMessage(a, "hello_ok")).toMatchObject({ requestId: "same" });
    a.sendJson({ ...base, clientId: 11, cursor: cursor(2) });
    expect((await nextMessage(observer, "remote_presence")).state.user.hue).toBe(before.state.user.hue);

    // Different identity on the same socket: refused and closed, so the allocator never sees a
    // connection whose user changed underneath it.
    a.sendJson({ type: "hello", requestId: "swap", token: alice.member.deviceToken, ...hello });
    const rejected = await nextMessage(a, "hello_error");
    expect(rejected).toMatchObject({ requestId: "swap", code: "UNAUTHORIZED" });
    expect(rejected.message).toContain("already signed in as someone else");

    // The same-identity ack must not become an auth bypass: the token is authenticated *before* the
    // ack short-circuits, so a garbage token on an established connection is still refused rather than
    // acked on the strength of the connection already holding a principal.
    const b = await connect(app);
    await helloAndSubscribe(b, owner.deviceToken, room.id);
    b.sendJson({ type: "hello", requestId: "junk", token: "tr_not_a_real_token", ...hello });
    const junk = await nextMessage(b, "hello_error");
    expect(junk).toMatchObject({ requestId: "junk", code: "UNAUTHORIZED" });
    expect(junk.message).not.toContain("already signed in");

    await settle();
    for (const fanout of seen(observer, "remote_presence")) {
      expect((fanout as { state: { user: { hue?: number } } }).state.user.hue).toBe(before.state.user.hue);
    }
  });

  // A same-device re-hello is allowed, so it must not be able to *degrade* the connection either. It
  // used to reassign `connection.capabilities` from the new frame, so a re-hello that simply omitted
  // `capabilities` silently set crdt/presence to false while this connection's subscriptions and
  // already-published presence stayed in place: peers kept a ghost cursor, and the connection stopped
  // being able to use the CRDT or presence lanes at all despite a live socket. Nothing legitimately
  // re-negotiates capabilities mid-socket, so the re-hello is a pure ack.
  it("does not let a capability-less re-hello degrade a live CRDT/presence connection", async () => {
    const { app, owner, room } = await setupRoom();
    const a = await connect(app);
    await helloAndSubscribe(a, owner.deviceToken, room.id);
    const epoch = await createDocument(a, room.id, "Board.md");

    const observer = await connect(app);
    await helloAndSubscribe(observer, owner.deviceToken, room.id);

    const base = { type: "presence_set", roomId: room.id, relativePath: "Board.md", epoch };
    a.sendJson({ ...base, clientId: 11, cursor: cursor(1) });
    const before = await nextMessage(observer, "remote_presence");
    drain(observer, "remote_presence");

    // Deliberately no `capabilities` key at all - the shape a pre-CRDT client would send.
    a.sendJson({
      type: "hello",
      requestId: "bare",
      token: owner.deviceToken,
      client: { kind: "obsidian-plugin", version: "0.3.0", deviceName: "device" }
    });
    expect(await nextMessage(a, "hello_ok")).toMatchObject({ requestId: "bare" });

    // Presence lane still live: a further cursor reaches the peer, and the sender is not told it lacks
    // presence support.
    a.sendJson({ ...base, clientId: 11, cursor: cursor(5) });
    expect((await nextMessage(observer, "remote_presence")).state.user.hue).toBe(before.state.user.hue);
    await settle();
    expect(seen(a, "presence_rejected")).toHaveLength(0);

    // CRDT lane still live: a create is answered, not rejected as CRDT_CAPABILITY_REQUIRED.
    a.sendJson({ type: "crdt_create", requestId: "after", roomId: room.id, relativePath: "Second.md" });
    expect(await nextMessage(a, "crdt_created")).toMatchObject({ requestId: "after" });
    expect(seen(a, "crdt_rejected")).toHaveLength(0);
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
    const live = await nextMessage(b, "remote_presence");

    // A null from an already-retired renderer key must not remove the live state.
    a.sendJson({ ...base, clientId: 99, cursor: null });
    await settle();
    expect(seen(b, "remote_presence")).toHaveLength(0);

    a.sendJson({ ...base, clientId: 11, cursor: null });
    const removal = await nextMessage(b, "remote_presence");
    expect(removal.state).toMatchObject({ clientId: 11, cursor: null });
    // A removal keeps the full `user` block, hue included. Stripping it would make a receiver
    // reconcile a retirement against a peer it can no longer identify by colour.
    expect(removal.state.user).toEqual(live.state.user);

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
