import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import * as Y from "yjs";
import { createApp } from "../src/app.js";
import { CRDT_TEXT_KEY } from "../src/sync/crdtDocManager.js";
import type { SyncTimerHost } from "../src/sync/syncServer.js";
import { injectBootstrap } from "./bootstrapHelper.js";

// Phase 4 of docs/superpowers/plans/2026-07-20-crdt-sync.md: CrdtDocManager wiring through the
// WS layer - ACL parity, the bidirectional handshake, epoch/capability gating, fanout partitioning
// (CRDT-capable vs legacy), lifecycle (delete/recreate), and the materialization SLA. Pure
// manager-internals coverage (compaction, resource limits, persistence-failure invariant, cache
// eviction) lives in crdtDocManager.test.ts instead - this file only covers behavior that requires
// the full ACL/policy/registry stack around the manager.

type JsonSocket = WebSocket & { sendJson: (payload: unknown) => void };

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
const sockets: WebSocket[] = [];
const messageQueues = new WeakMap<WebSocket, unknown[]>();

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  for (const app of apps.splice(0)) {
    await app.close();
  }
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

async function helloAndSubscribe(
  socket: JsonSocket,
  token: string,
  roomId: string,
  options: { crdt: boolean } = { crdt: true }
): Promise<void> {
  socket.sendJson({
    type: "hello",
    requestId: "h",
    token,
    client: { kind: "obsidian-plugin", version: "0.3.0", deviceName: "device" },
    capabilities: { crdt: options.crdt }
  });
  await nextMessage(socket, "hello_ok");
  socket.sendJson({ type: "subscribe_room", requestId: "s", roomId });
  await nextMessage(socket, "room_snapshot");
}

class FakeCrdtTimerHost implements SyncTimerHost {
  private nextHandle = 1;
  private readonly timeouts = new Map<number, () => void>();

  setInterval(): unknown {
    return "interval";
  }

  clearInterval(): void {}

  setTimeout(callback: () => void): unknown {
    const handle = this.nextHandle++;
    this.timeouts.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }

  runAllTimeouts(): void {
    const entries = [...this.timeouts.values()];
    this.timeouts.clear();
    for (const callback of entries) callback();
  }
}

async function setupCrdtRoom(options: { crdtTimerHost?: SyncTimerHost } = {}) {
  const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787", crdtTimerHost: options.crdtTimerHost });
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
  await app.inject({
    method: "POST",
    url: `/api/rooms/${room.id}/acl`,
    headers: { authorization: `Bearer ${owner.deviceToken}` },
    payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", preset, pathPattern }
  });
  // sync:subscribe is granted broadly regardless of the path-scoped preset above, matching
  // sync-flow.test.ts's fixture pattern - only file:read/write should be path-scoped in these tests.
  await app.inject({
    method: "POST",
    url: `/api/rooms/${room.id}/acl`,
    headers: { authorization: `Bearer ${owner.deviceToken}` },
    payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", permissions: ["sync:subscribe"], pathPattern: "**/*" }
  });
  return member;
}

function base64OfUpdate(update: Uint8Array): string {
  return Buffer.from(update).toString("base64");
}

function emptyStateVectorBase64(): string {
  return base64OfUpdate(Y.encodeStateVector(new Y.Doc()));
}

describe("CRDT sync flow (Phase 4)", () => {
  it("crdt_create allocates epoch 0 and acks with the file's id as documentId", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);

    socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    const created = await nextMessage(socket, "crdt_created");

    expect(created).toMatchObject({ requestId: "c1", roomId: room.id, relativePath: "note.md", epoch: 0 });
    expect(typeof created.documentId).toBe("string");
  });

  it("crdt_create on an existing (non-deleted) file is rejected with FILE_EXISTS", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);
    socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    await nextMessage(socket, "crdt_created");

    socket.sendJson({ type: "crdt_create", requestId: "c2", roomId: room.id, relativePath: "note.md" });
    expect(await nextMessage(socket, "crdt_rejected")).toMatchObject({ requestId: "c2", code: "FILE_EXISTS" });
  });

  it("rejects every CRDT message type on a room that has not enabled CRDT", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    apps.push(app);
    const owner = (await injectBootstrap(app, { displayName: "Owner", deviceName: "Owner laptop" })).json();
    const room = (
      await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { name: "Room", type: "folder", sourcePath: "Room", mountName: "Room", capabilities: [] }
      })
    ).json().room;
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);

    socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    expect(await nextMessage(socket, "crdt_rejected")).toMatchObject({ requestId: "c1", code: "CRDT_DISABLED" });
  });

  it("rejects crdt_create for a non-.md path even in a CRDT-enabled room", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);

    socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "image.png" });
    expect(await nextMessage(socket, "crdt_rejected")).toMatchObject({ requestId: "c1", code: "INVALID_PATH" });
  });

  it("rejects any CRDT message from a connection that did not advertise capabilities.crdt on hello", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id, { crdt: false });

    socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    expect(await nextMessage(socket, "crdt_rejected")).toMatchObject({ requestId: "c1", code: "CRDT_CAPABILITY_REQUIRED" });
  });

  it("[ACL parity] crdt_update requires sync:push and file:write - a reader gets rejected, nothing is persisted or fanned out", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const ownerSocket = await connect(app);
    await helloAndSubscribe(ownerSocket, owner.deviceToken, room.id);
    ownerSocket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    const created = await nextMessage(ownerSocket, "crdt_created");

    const reader = await addMember(app, owner, room, "reader");
    const readerSocket = await connect(app);
    await helloAndSubscribe(readerSocket, reader.deviceToken, room.id);

    readerSocket.sendJson({
      type: "crdt_update",
      requestId: "u1",
      roomId: room.id,
      relativePath: "note.md",
      epoch: created.epoch,
      update: base64OfUpdate(Y.encodeStateAsUpdate((() => {
        const doc = new Y.Doc();
        doc.getText(CRDT_TEXT_KEY).insert(0, "should not land");
        return doc;
      })()))
    });

    expect(await nextMessage(readerSocket, "crdt_rejected")).toMatchObject({ requestId: "u1", code: "PERMISSION_DENIED" });
    // Nothing persisted: a fresh handshake from the owner still sees an empty document.
    ownerSocket.sendJson({
      type: "crdt_sync_step1",
      requestId: "h1",
      roomId: room.id,
      relativePath: "note.md",
      epoch: created.epoch,
      stateVector: emptyStateVectorBase64()
    });
    const step2 = await nextMessage(ownerSocket, "crdt_sync_step2");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(step2.update, "base64")));
    expect(doc.getText(CRDT_TEXT_KEY).toString()).toBe("");
  });

  it("[ACL parity] crdt_sync_step2 (client answering the server's handshake) gets the same write checks as crdt_update", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const ownerSocket = await connect(app);
    await helloAndSubscribe(ownerSocket, owner.deviceToken, room.id);
    ownerSocket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    const created = await nextMessage(ownerSocket, "crdt_created");

    const reader = await addMember(app, owner, room, "reader");
    const readerSocket = await connect(app);
    await helloAndSubscribe(readerSocket, reader.deviceToken, room.id);

    readerSocket.sendJson({
      type: "crdt_sync_step2",
      requestId: "s2",
      roomId: room.id,
      relativePath: "note.md",
      epoch: created.epoch,
      update: base64OfUpdate(Y.encodeStateAsUpdate((() => {
        const doc = new Y.Doc();
        doc.getText(CRDT_TEXT_KEY).insert(0, "should not land either");
        return doc;
      })()))
    });

    expect(await nextMessage(readerSocket, "crdt_rejected")).toMatchObject({ requestId: "s2", code: "PERMISSION_DENIED" });
  });

  it("[handshake read auth] crdt_sync_step1 requires file:read - denied without leaking any content", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const ownerSocket = await connect(app);
    await helloAndSubscribe(ownerSocket, owner.deviceToken, room.id);
    ownerSocket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "secret/note.md" });
    const created = await nextMessage(ownerSocket, "crdt_created");
    ownerSocket.sendJson({
      type: "crdt_update",
      requestId: "u1",
      roomId: room.id,
      relativePath: "secret/note.md",
      epoch: created.epoch,
      update: base64OfUpdate(Y.encodeStateAsUpdate((() => {
        const doc = new Y.Doc();
        doc.getText(CRDT_TEXT_KEY).insert(0, "top secret content");
        return doc;
      })()))
    });

    // Member's reader grant is scoped to public/** only - "secret/note.md" is outside it.
    const member = await addMember(app, owner, room, "reader", "public/**/*");
    const memberSocket = await connect(app);
    await helloAndSubscribe(memberSocket, member.deviceToken, room.id);

    memberSocket.sendJson({
      type: "crdt_sync_step1",
      requestId: "h1",
      roomId: room.id,
      relativePath: "secret/note.md",
      epoch: created.epoch,
      stateVector: emptyStateVectorBase64()
    });
    const rejection = await nextMessage(memberSocket, "crdt_rejected");
    expect(rejection).toMatchObject({ requestId: "h1", code: "PERMISSION_DENIED" });
    expect(rejection.update).toBeUndefined();
    expect(JSON.stringify(rejection)).not.toContain("top secret content");
  });

  it("[bidirectional handshake] a local edit made before a disconnect is recovered from the client's step2 after reconnect", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const firstConnection = await connect(app);
    await helloAndSubscribe(firstConnection, owner.deviceToken, room.id);
    firstConnection.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    const created = await nextMessage(firstConnection, "crdt_created");

    // The "client's own Y.Doc" - the same CRDT identity throughout this test, not re-derived from
    // scratch at each step. Using a *different* freshly-constructed Y.Doc to represent "what the
    // client already has" would be the classic seed-then-merge trap (Phase 0.3 spike): two
    // independently created docs that happen to contain the same literal text are still two
    // causally-unrelated sets of ops, so merging them concatenates instead of deduplicating.
    const clientDoc = new Y.Doc();
    clientDoc.getText(CRDT_TEXT_KEY).insert(0, "shared start");
    firstConnection.sendJson({
      type: "crdt_update",
      requestId: "u1",
      roomId: room.id,
      relativePath: "note.md",
      epoch: created.epoch,
      update: base64OfUpdate(Y.encodeStateAsUpdate(clientDoc))
    });
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the append land before disconnecting.

    // While offline, the client makes a further local edit the server never saw - on the same doc
    // identity it already sent "shared start" from.
    clientDoc.getText(CRDT_TEXT_KEY).insert("shared start".length, " + offline edit");

    // Reconnect (new WS connection, simulating "the app was relaunched") and run the handshake.
    const reconnected = await connect(app);
    await helloAndSubscribe(reconnected, owner.deviceToken, room.id);
    reconnected.sendJson({
      type: "crdt_sync_step1",
      requestId: "h1",
      roomId: room.id,
      relativePath: "note.md",
      epoch: created.epoch,
      stateVector: base64OfUpdate(Y.encodeStateVector(clientDoc))
    });
    await nextMessage(reconnected, "crdt_sync_step2"); // server's answer to the client's step1 (ignored here).
    const serverStep1 = await nextMessage(reconnected, "crdt_sync_step1"); // server-initiated - no requestId.
    expect(serverStep1.requestId).toBeUndefined();

    // The client answers the server's step1 with whatever the server's reported SV shows missing.
    const serverStateVector = new Uint8Array(Buffer.from(serverStep1.stateVector, "base64"));
    const clientAnswerUpdate = Y.encodeStateAsUpdate(clientDoc, serverStateVector);
    reconnected.sendJson({
      type: "crdt_sync_step2",
      requestId: "answer",
      roomId: room.id,
      relativePath: "note.md",
      epoch: created.epoch,
      update: base64OfUpdate(clientAnswerUpdate)
    });
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the append land.

    // A brand-new cold connection now sees the merged content - the server durably holds the edit
    // the client made before it ever got a chance to send it the first time around.
    const verifier = await connect(app);
    await helloAndSubscribe(verifier, owner.deviceToken, room.id);
    verifier.sendJson({
      type: "crdt_sync_step1",
      requestId: "v1",
      roomId: room.id,
      relativePath: "note.md",
      epoch: created.epoch,
      stateVector: emptyStateVectorBase64()
    });
    const verifyStep2 = await nextMessage(verifier, "crdt_sync_step2");
    const verifyDoc = new Y.Doc();
    Y.applyUpdate(verifyDoc, new Uint8Array(Buffer.from(verifyStep2.update, "base64")));
    expect(verifyDoc.getText(CRDT_TEXT_KEY).toString()).toBe("shared start + offline edit");
  });

  it("[stale epoch] an update at a superseded epoch is rejected and reports the current epoch", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);
    socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    const created = await nextMessage(socket, "crdt_created");

    // Delete and recreate at the same path - contract 1.5 bumps the epoch immediately.
    socket.sendJson({ type: "file_delete", requestId: "d1", roomId: room.id, relativePath: "note.md", baseVersion: 1 });
    await nextMessage(socket, "file_delete_ack");
    socket.sendJson({ type: "crdt_create", requestId: "c2", roomId: room.id, relativePath: "note.md" });
    const recreated = await nextMessage(socket, "crdt_created");
    expect(recreated.epoch).toBe(created.epoch + 1);

    socket.sendJson({
      type: "crdt_update",
      requestId: "stale",
      roomId: room.id,
      relativePath: "note.md",
      epoch: created.epoch, // the old, now-superseded epoch.
      update: base64OfUpdate(Y.encodeStateAsUpdate(new Y.Doc()))
    });
    const rejection = await nextMessage(socket, "crdt_rejected");
    expect(rejection).toMatchObject({ requestId: "stale", code: "CRDT_STALE_EPOCH", currentEpoch: recreated.epoch });
  });

  it("[fanout partitioning] remote_crdt_update reaches only CRDT-capable, file:read-authorized peers - not a legacy peer", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const author = await connect(app);
    await helloAndSubscribe(author, owner.deviceToken, room.id, { crdt: true });
    author.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    const created = await nextMessage(author, "crdt_created");

    const crdtPeer = await connect(app);
    await helloAndSubscribe(crdtPeer, owner.deviceToken, room.id, { crdt: true });
    const legacyPeer = await connect(app);
    await helloAndSubscribe(legacyPeer, owner.deviceToken, room.id, { crdt: false });

    author.sendJson({
      type: "crdt_update",
      requestId: "u1",
      roomId: room.id,
      relativePath: "note.md",
      epoch: created.epoch,
      update: base64OfUpdate(Y.encodeStateAsUpdate((() => {
        const doc = new Y.Doc();
        doc.getText(CRDT_TEXT_KEY).insert(0, "fan out me");
        return doc;
      })()))
    });

    expect(await nextMessage(crdtPeer, "remote_crdt_update")).toMatchObject({ roomId: room.id, relativePath: "note.md", epoch: created.epoch });
    await expect(nextMessage(legacyPeer, "remote_crdt_update")).rejects.toThrow(/Timed out/);
  });

  it("[materialization SLA] a REST GET is stale before the debounce deadline and fresh after it fires", async () => {
    const timers = new FakeCrdtTimerHost();
    const { app, owner, room } = await setupCrdtRoom({ crdtTimerHost: timers });
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);
    socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    const created = await nextMessage(socket, "crdt_created");

    socket.sendJson({
      type: "crdt_update",
      requestId: "u1",
      roomId: room.id,
      relativePath: "note.md",
      epoch: created.epoch,
      update: base64OfUpdate(Y.encodeStateAsUpdate((() => {
        const doc = new Y.Doc();
        doc.getText(CRDT_TEXT_KEY).insert(0, "fresh text");
        return doc;
      })()))
    });
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the WS message finish processing.

    const beforeDebounce = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files/content?path=note.md`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(beforeDebounce.json().content).toBe(""); // materialize hasn't fired yet.

    timers.runAllTimeouts(); // fast-forward the materialize debounce.

    const afterDebounce = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files/content?path=note.md`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(afterDebounce.json().content).toBe("fresh text");
  });

  it("[materialization SLA] legacy peers get the materialized remote_file_change once the debounce fires, not immediately", async () => {
    const timers = new FakeCrdtTimerHost();
    const { app, owner, room } = await setupCrdtRoom({ crdtTimerHost: timers });
    const author = await connect(app);
    await helloAndSubscribe(author, owner.deviceToken, room.id, { crdt: true });
    author.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    const created = await nextMessage(author, "crdt_created");

    const legacyPeer = await connect(app);
    await helloAndSubscribe(legacyPeer, owner.deviceToken, room.id, { crdt: false });

    author.sendJson({
      type: "crdt_update",
      requestId: "u1",
      roomId: room.id,
      relativePath: "note.md",
      epoch: created.epoch,
      update: base64OfUpdate(Y.encodeStateAsUpdate((() => {
        const doc = new Y.Doc();
        doc.getText(CRDT_TEXT_KEY).insert(0, "materialized for legacy");
        return doc;
      })()))
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    timers.runAllTimeouts();

    expect(await nextMessage(legacyPeer, "remote_file_change")).toMatchObject({
      roomId: room.id,
      relativePath: "note.md",
      content: "materialized for legacy"
    });
  });

  it("[materialization SLA / second-hardware-round item 1] a CRDT-capable reader who never opened this file still receives the materialized remote_file_change, not just legacy peers", async () => {
    // Regression test for: room owner grants a teammate reader permission on a CRDT room, edits a
    // file, the reader never sees the change land. Root cause: createCrdtMaterializedHandler
    // (relayCore.ts) used to exclude every CRDT-capable connection from this broadcast on the
    // assumption "the CRDT-capable half already learned about this via remote_crdt_update" - which
    // only holds if the receiving device has an *open session* for that exact path. A device that
    // is CRDT-capable (every current build - syncWsClient.ts always advertises capabilities.crdt:
    // true) but never opened this file client-side has no session, so remote_crdt_update is silently
    // dropped there too (crdtSession.ts's handleServerMessage bails when `!session`) - the
    // materialized fallback must reach it instead. The server has no notion of "client session," so
    // this connection is indistinguishable, server-side, from any other CRDT-capable subscriber.
    const timers = new FakeCrdtTimerHost();
    const { app, owner, room } = await setupCrdtRoom({ crdtTimerHost: timers });
    const reader = await addMember(app, owner, room, "reader");

    const author = await connect(app);
    await helloAndSubscribe(author, owner.deviceToken, room.id, { crdt: true });
    author.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    const created = await nextMessage(author, "crdt_created");

    // The reader connects and subscribes but never sends crdt_create/crdt_sync_step1 for this path -
    // modeling "never opened this file's editor," exactly as the bug report describes.
    const readerSocket = await connect(app);
    await helloAndSubscribe(readerSocket, reader.deviceToken, room.id, { crdt: true });

    author.sendJson({
      type: "crdt_update",
      requestId: "u1",
      roomId: room.id,
      relativePath: "note.md",
      epoch: created.epoch,
      update: base64OfUpdate(Y.encodeStateAsUpdate((() => {
        const doc = new Y.Doc();
        doc.getText(CRDT_TEXT_KEY).insert(0, "owner's edit the reader must eventually see");
        return doc;
      })()))
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    timers.runAllTimeouts();

    expect(await nextMessage(readerSocket, "remote_file_change")).toMatchObject({
      roomId: room.id,
      relativePath: "note.md",
      content: "owner's edit the reader must eventually see"
    });
  });

  describe("[fourth hardware-testing round] crdt_rename - atomic rename replacing delete-old+create-new", () => {
    it("renames in place, preserving the file's epoch/identity and content (no re-seed, no data loss)", async () => {
      const { app, owner, room } = await setupCrdtRoom();
      const socket = await connect(app);
      await helloAndSubscribe(socket, owner.deviceToken, room.id);
      socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "old-title.md" });
      const created = await nextMessage(socket, "crdt_created");
      socket.sendJson({
        type: "crdt_update",
        requestId: "u1",
        roomId: room.id,
        relativePath: "old-title.md",
        epoch: created.epoch,
        update: base64OfUpdate(Y.encodeStateAsUpdate((() => {
          const doc = new Y.Doc();
          doc.getText(CRDT_TEXT_KEY).insert(0, "content that must survive the rename");
          return doc;
        })()))
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      socket.sendJson({ type: "crdt_rename", requestId: "r1", roomId: room.id, oldRelativePath: "old-title.md", relativePath: "new-title.md" });
      const renamed = await nextMessage(socket, "crdt_renamed");
      expect(renamed).toMatchObject({ requestId: "r1", roomId: room.id, oldRelativePath: "old-title.md", relativePath: "new-title.md", epoch: created.epoch });

      // Same epoch, same document identity - a handshake at the new path against the same epoch
      // returns the content untouched, proving this was not a delete+recreate under the hood.
      socket.sendJson({
        type: "crdt_sync_step1",
        requestId: "h1",
        roomId: room.id,
        relativePath: "new-title.md",
        epoch: created.epoch,
        stateVector: emptyStateVectorBase64()
      });
      const step2 = await nextMessage(socket, "crdt_sync_step2");
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(Buffer.from(step2.update, "base64")));
      expect(doc.getText(CRDT_TEXT_KEY).toString()).toBe("content that must survive the rename");
    });

    it("broadcasts remote_crdt_rename to other subscribers, who never see a delete/create pair for it", async () => {
      const { app, owner, room } = await setupCrdtRoom();
      const renamer = await connect(app);
      await helloAndSubscribe(renamer, owner.deviceToken, room.id);
      renamer.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "old-title.md" });
      const created = await nextMessage(renamer, "crdt_created");

      const peer = await connect(app);
      await helloAndSubscribe(peer, owner.deviceToken, room.id);

      renamer.sendJson({ type: "crdt_rename", requestId: "r1", roomId: room.id, oldRelativePath: "old-title.md", relativePath: "new-title.md" });
      await nextMessage(renamer, "crdt_renamed");

      const remoteRename = await nextMessage(peer, "remote_crdt_rename");
      expect(remoteRename).toMatchObject({ roomId: room.id, oldRelativePath: "old-title.md", relativePath: "new-title.md", epoch: created.epoch });
      // The renamer itself is excluded from its own broadcast (matches remote_file_delete/
      // remote_crdt_update's existing `exclude: connection` convention).
      await expect(nextMessage(renamer, "remote_crdt_rename")).rejects.toThrow(/Timed out/);
    });

    it("rejects with FILE_EXISTS when the new path is already taken by another live file", async () => {
      const { app, owner, room } = await setupCrdtRoom();
      const socket = await connect(app);
      await helloAndSubscribe(socket, owner.deviceToken, room.id);
      socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "a.md" });
      await nextMessage(socket, "crdt_created");
      socket.sendJson({ type: "crdt_create", requestId: "c2", roomId: room.id, relativePath: "b.md" });
      await nextMessage(socket, "crdt_created");

      socket.sendJson({ type: "crdt_rename", requestId: "r1", roomId: room.id, oldRelativePath: "a.md", relativePath: "b.md" });
      expect(await nextMessage(socket, "crdt_rejected")).toMatchObject({ requestId: "r1", code: "FILE_EXISTS" });
    });

    it("rejects with NOT_FOUND when the source path does not exist", async () => {
      const { app, owner, room } = await setupCrdtRoom();
      const socket = await connect(app);
      await helloAndSubscribe(socket, owner.deviceToken, room.id);

      socket.sendJson({ type: "crdt_rename", requestId: "r1", roomId: room.id, oldRelativePath: "missing.md", relativePath: "new.md" });
      expect(await nextMessage(socket, "crdt_rejected")).toMatchObject({ requestId: "r1", code: "NOT_FOUND" });
    });

    it("[ACL parity] requires file:delete on the old path and file:create on the new path - a reader is rejected and nothing changes", async () => {
      const { app, owner, room } = await setupCrdtRoom();
      const ownerSocket = await connect(app);
      await helloAndSubscribe(ownerSocket, owner.deviceToken, room.id);
      ownerSocket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
      const created = await nextMessage(ownerSocket, "crdt_created");

      const reader = await addMember(app, owner, room, "reader");
      const readerSocket = await connect(app);
      await helloAndSubscribe(readerSocket, reader.deviceToken, room.id);

      readerSocket.sendJson({ type: "crdt_rename", requestId: "r1", roomId: room.id, oldRelativePath: "note.md", relativePath: "renamed.md" });
      expect(await nextMessage(readerSocket, "crdt_rejected")).toMatchObject({ requestId: "r1", code: "PERMISSION_DENIED" });

      // Confirm nothing actually moved - the original path still answers under its original epoch.
      ownerSocket.sendJson({
        type: "crdt_sync_step1",
        requestId: "h1",
        roomId: room.id,
        relativePath: "note.md",
        epoch: created.epoch,
        stateVector: emptyStateVectorBase64()
      });
      await nextMessage(ownerSocket, "crdt_sync_step2");
    });
  });
});
