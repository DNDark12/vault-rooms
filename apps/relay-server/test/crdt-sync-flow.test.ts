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
  it("advertises durable structural-operation receipts in hello_ok", async () => {
    const { app, owner } = await setupCrdtRoom();
    const socket = await connect(app);
    socket.sendJson({
      type: "hello",
      requestId: "h-capabilities",
      token: owner.deviceToken,
      client: { kind: "obsidian-plugin", version: "0.3.0", deviceName: "device" },
      capabilities: { crdt: true }
    });

    expect(await nextMessage(socket, "hello_ok")).toMatchObject({
      requestId: "h-capabilities",
      capabilities: { crdtOperationReceipts: true }
    });

    socket.sendJson({
      type: "hello",
      requestId: "h-capabilities-again",
      token: owner.deviceToken,
      client: { kind: "obsidian-plugin", version: "0.3.0", deviceName: "device" },
      capabilities: { crdt: true }
    });
    expect(await nextMessage(socket, "hello_ok")).toMatchObject({
      requestId: "h-capabilities-again",
      capabilities: { crdtOperationReceipts: true }
    });
  });

  it("crdt_create allocates epoch 0 and acks with the file's id as documentId", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);

    socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    const created = await nextMessage(socket, "crdt_created");

    expect(created).toMatchObject({ requestId: "c1", roomId: room.id, relativePath: "note.md", epoch: 0 });
    expect(typeof created.documentId).toBe("string");
  });

  it("replays a journal-backed crdt_create receipt without creating or broadcasting twice", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const creator = await connect(app);
    const peer = await connect(app);
    await helloAndSubscribe(creator, owner.deviceToken, room.id);
    await helloAndSubscribe(peer, owner.deviceToken, room.id);

    creator.sendJson({
      type: "crdt_create",
      requestId: "create-first-attempt",
      operationId: "op-create-once",
      roomId: room.id,
      relativePath: "offline-note.md"
    });
    const firstAck = await nextMessage(creator, "crdt_created");
    await nextMessage(peer, "remote_file_change");

    creator.sendJson({
      type: "crdt_create",
      requestId: "create-retry",
      operationId: "op-create-once",
      roomId: room.id,
      relativePath: "offline-note.md"
    });
    const retryAck = await nextMessage(creator, "crdt_created");

    expect(retryAck).toMatchObject({
      requestId: "create-retry",
      roomId: firstAck.roomId,
      relativePath: firstAck.relativePath,
      documentId: firstAck.documentId,
      epoch: firstAck.epoch,
      adopted: firstAck.adopted
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messageQueues.get(peer)?.filter((message) => (message as { type?: string }).type === "remote_file_change")).toHaveLength(0);
  });

  it("resolves an existing structural receipt after live editing is disabled", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);

    socket.sendJson({
      type: "crdt_create",
      requestId: "create-before-disable",
      operationId: "op-before-disable",
      roomId: room.id,
      relativePath: "offline.md"
    });
    const first = await nextMessage(socket, "crdt_created");
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

    socket.sendJson({
      type: "crdt_create",
      requestId: "resolve-after-disable",
      operationId: "op-before-disable",
      roomId: room.id,
      relativePath: "offline.md"
    });
    expect(await nextMessage(socket, "crdt_created")).toMatchObject({
      requestId: "resolve-after-disable",
      documentId: first.documentId,
      relativePath: "offline.md"
    });

    socket.sendJson({
      type: "crdt_create",
      requestId: "missing-after-disable",
      operationId: "op-never-committed",
      roomId: room.id,
      relativePath: "missing.md"
    });
    expect(await nextMessage(socket, "crdt_rejected")).toMatchObject({
      requestId: "missing-after-disable",
      code: "CRDT_DISABLED"
    });
  });

  it("rejects an operationId reused with a different normalized create payload", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);

    socket.sendJson({
      type: "crdt_create",
      requestId: "create-first",
      operationId: "op-create-payload",
      roomId: room.id,
      relativePath: "first.md"
    });
    await nextMessage(socket, "crdt_created");
    socket.sendJson({
      type: "crdt_create",
      requestId: "create-invalid-reuse",
      operationId: "op-create-payload",
      roomId: room.id,
      relativePath: "different.md"
    });

    expect(await nextMessage(socket, "crdt_rejected")).toMatchObject({
      requestId: "create-invalid-reuse",
      code: "VALIDATION_ERROR"
    });
  });

  it("rejects an operationId reused by the same device in a different room", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const secondRoom = (
      await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { name: "Second", type: "folder", sourcePath: "Second", mountName: "Second", capabilities: [] }
      })
    ).json().room;
    await app.inject({
      method: "PATCH",
      url: `/api/rooms/${secondRoom.id}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: {
        name: secondRoom.name,
        type: secondRoom.type,
        sourcePath: secondRoom.sourcePath,
        mountName: secondRoom.mountName,
        crdtEnabled: true
      }
    });
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);

    socket.sendJson({
      type: "crdt_create",
      requestId: "room-one-create",
      operationId: "op-global-identity",
      roomId: room.id,
      relativePath: "First.md"
    });
    await nextMessage(socket, "crdt_created");
    socket.sendJson({ type: "subscribe_room", requestId: "subscribe-second", roomId: secondRoom.id });
    await nextMessage(socket, "room_snapshot");
    socket.sendJson({
      type: "crdt_create",
      requestId: "room-two-reuse",
      operationId: "op-global-identity",
      roomId: secondRoom.id,
      relativePath: "Second.md"
    });

    expect(await nextMessage(socket, "crdt_rejected")).toMatchObject({
      requestId: "room-two-reuse",
      code: "VALIDATION_ERROR"
    });
  });

  it("rejects another device replaying a structural operation receipt", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const member = await addMember(app, owner, room, "editor");
    const ownerSocket = await connect(app);
    const memberSocket = await connect(app);
    await helloAndSubscribe(ownerSocket, owner.deviceToken, room.id);
    await helloAndSubscribe(memberSocket, member.deviceToken, room.id);

    ownerSocket.sendJson({
      type: "crdt_create",
      requestId: "owner-create",
      operationId: "op-owned-by-device",
      roomId: room.id,
      relativePath: "owned-operation.md"
    });
    await nextMessage(ownerSocket, "crdt_created");
    await nextMessage(memberSocket, "remote_file_change");

    memberSocket.sendJson({
      type: "crdt_create",
      requestId: "member-replay",
      operationId: "op-owned-by-device",
      roomId: room.id,
      relativePath: "owned-operation.md"
    });
    expect(await nextMessage(memberSocket, "crdt_rejected")).toMatchObject({
      requestId: "member-replay",
      code: "CRDT_OPERATION_DEVICE_MISMATCH"
    });
  });

  // Seventh hardware-testing round (2026-07-24): two devices creating a note at the same path are
  // creating two *different* notes, and every new Obsidian note starts with the same default name
  // ("Untitled"/"Chưa đặt tên.md"), so this collides constantly. It used to be rejected with
  // FILE_EXISTS - an unrecoverable dead end where the client's session never opened, so that note
  // never synced at all. Now the first creator keeps the name and the second gets its own
  // disambiguated path, which the ack reports back so the client can rename its local file to match.
  it("crdt_create on a path another live file already holds assigns a distinct path instead of rejecting", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);
    socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    const first = await nextMessage(socket, "crdt_created");
    expect(first).toMatchObject({ relativePath: "note.md" });

    // Content on the first note, so a second create that wrongly merged/re-seeded would be obvious.
    const doc = new Y.Doc();
    doc.getText(CRDT_TEXT_KEY).insert(0, "the first note's own content");
    socket.sendJson({
      type: "crdt_update",
      requestId: "u1",
      roomId: room.id,
      relativePath: "note.md",
      epoch: 0,
      update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")
    });

    socket.sendJson({ type: "crdt_create", requestId: "c2", roomId: room.id, relativePath: "note.md" });
    const second = await nextMessage(socket, "crdt_created");

    // A separate document at a separate, creator-disambiguated path - never a rejection, never the
    // same document, and the first creator's path is untouched.
    expect(second.requestId).toBe("c2");
    expect(second.relativePath).not.toBe("note.md");
    expect(second.relativePath).toMatch(/^note \(.+\)\.md$/);
    expect(second.documentId).not.toBe(first.documentId);

    // The first note still holds its own content - the second create neither merged into nor reset it.
    socket.sendJson({
      type: "crdt_sync_step1",
      requestId: "h1",
      roomId: room.id,
      relativePath: "note.md",
      epoch: 0,
      stateVector: Buffer.from(Y.encodeStateVector(new Y.Doc())).toString("base64")
    });
    const step2 = await nextMessage(socket, "crdt_sync_step2");
    const merged = new Y.Doc();
    Y.applyUpdate(merged, new Uint8Array(Buffer.from(step2.update, "base64")));
    expect(merged.getText(CRDT_TEXT_KEY).toString()).toBe("the first note's own content");
  });

  // Eighth hardware-testing round (2026-07-24): "A creates a new note, B never receives it".
  // crdt_create had no broadcast at all, and the materialized remote_file_change substitute is driven
  // by CrdtDocManager's *update* debounce - so a note created but not yet typed into produced no
  // update, never materialized, and stayed invisible to every other device until their next
  // subscribe_room.
  it("announces a newly created CRDT document to other subscribers immediately, before anything is typed", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const creator = await connect(app);
    await helloAndSubscribe(creator, owner.deviceToken, room.id);
    const peer = await connect(app);
    await helloAndSubscribe(peer, owner.deviceToken, room.id);

    creator.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "brand-new.md" });
    await nextMessage(creator, "crdt_created");

    // The peer learns about it right away - no typing, no materialize debounce, no re-subscribe.
    const announced = await nextMessage(peer, "remote_file_change");
    expect(announced).toMatchObject({ roomId: room.id, relativePath: "brand-new.md", content: "" });
    // Carries the epoch so the peer records it and its own vault-watcher "create" (caused by writing
    // this file to disk) adopts the document instead of issuing a colliding crdt_create - the loop
    // that produced `Untitled (a) (b) (a) (b)…` on real hardware (ninth hardware-testing round).
    expect(announced.crdtEpoch).toBe(0);
  });

  // Twelfth hardware-testing round (2026-07-24): "after restarting the server the two vaults have
  // different file counts, and the other side only syncs a file once I open it". A CRDT document's
  // authoritative text lives in crdt_updates and only reaches files/file_versions on the materialize
  // debounce, so a subscribing device reconciled against stale (often empty) whole-file content and
  // downloaded nothing - until somebody opened the note and the handshake triggered a materialize.
  it("serves current CRDT text in the snapshot's whole-file content without waiting for anyone to open the note", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const writer = await connect(app);
    await helloAndSubscribe(writer, owner.deviceToken, room.id);
    writer.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    await nextMessage(writer, "crdt_created");

    const doc = new Y.Doc();
    doc.getText(CRDT_TEXT_KEY).insert(0, "content that only exists in the CRDT lane so far");
    writer.sendJson({
      type: "crdt_update",
      requestId: "u1",
      roomId: room.id,
      relativePath: "note.md",
      epoch: 0,
      update: base64OfUpdate(Y.encodeStateAsUpdate(doc))
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Deliberately do NOT fire the materialize debounce - this is the state a relay is in when it
    // restarts, or when nobody has typed since the last flush.

    // A second device subscribes. Its snapshot must already reflect the real text.
    const joiner = await connect(app);
    await helloAndSubscribe(joiner, owner.deviceToken, room.id);
    const readBack = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files/content?path=note.md`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(readBack.statusCode).toBe(200);
    expect(readBack.json().content).toBe("content that only exists in the CRDT lane so far");
  });

  // Fifteenth hardware-testing round (2026-07-24): unmount then remount duplicated every note as
  // "… (A)" / "… (B)". Unmounting clears the client's known epochs, so remounting re-sent
  // crdt_create for files it already had; each collided and was handed a disambiguated name, and the
  // client renamed its local file to match. Reopening an existing note must adopt, not fork.
  it("adopts the existing document when crdt_create sets adoptIfExists, preserving its content", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);
    socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    const first = await nextMessage(socket, "crdt_created");

    const doc = new Y.Doc();
    doc.getText(CRDT_TEXT_KEY).insert(0, "content that must survive a remount");
    socket.sendJson({
      type: "crdt_update",
      requestId: "u1",
      roomId: room.id,
      relativePath: "note.md",
      epoch: 0,
      update: base64OfUpdate(Y.encodeStateAsUpdate(doc))
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Exactly what a remount now sends: same path, adoptIfExists.
    socket.sendJson({ type: "crdt_create", requestId: "c2", roomId: room.id, relativePath: "note.md", adoptIfExists: true });
    const adopted = await nextMessage(socket, "crdt_created");
    expect(adopted).toMatchObject({ requestId: "c2", relativePath: "note.md", epoch: first.epoch });
    expect(adopted.documentId).toBe(first.documentId);

    // Adoption must not re-seed the document - the note's content is still there.
    socket.sendJson({
      type: "crdt_sync_step1",
      requestId: "h1",
      roomId: room.id,
      relativePath: "note.md",
      epoch: 0,
      stateVector: base64OfUpdate(Y.encodeStateVector(new Y.Doc()))
    });
    const step2 = await nextMessage(socket, "crdt_sync_step2");
    const merged = new Y.Doc();
    Y.applyUpdate(merged, new Uint8Array(Buffer.from(step2.update, "base64")));
    expect(merged.getText(CRDT_TEXT_KEY).toString()).toBe("content that must survive a remount");
  });

  it("disambiguates repeated creates of the same name by numbering, preserving the user's stem", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);

    socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    expect(await nextMessage(socket, "crdt_created")).toMatchObject({ relativePath: "note.md" });
    socket.sendJson({ type: "crdt_create", requestId: "c2", roomId: room.id, relativePath: "note.md" });
    const second = await nextMessage(socket, "crdt_created");
    socket.sendJson({ type: "crdt_create", requestId: "c3", roomId: room.id, relativePath: "note.md" });
    const third = await nextMessage(socket, "crdt_created");

    // Each collision on the *same requested* name gets its own path, and the requested stem is always
    // preserved verbatim - a name the user typed is never rewritten back to some other stem, which is
    // what made renames swap names chaotically and loop on real hardware.
    expect(second.relativePath).not.toBe("note.md");
    expect(third.relativePath).not.toBe(second.relativePath);
    for (const path of [second.relativePath, third.relativePath]) {
      expect(path.startsWith("note (")).toBe(true);
      expect(path.endsWith(".md")).toBe(true);
    }
  });

  // Same round: materializeCrdtContent bumps files.version on its own debounce and nothing carries
  // that new version back to a client's per-file tracking, so a CRDT file's tracked serverVersion is
  // stale by design the moment anyone types - and every delete the client attempted failed
  // VERSION_CONFLICT forever, making the file permanently undeletable ("The file changed on the server
  // before your edit was applied", repeatedly, on real hardware).
  it("deletes a CRDT-owned file even when the client's baseVersion is stale", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);
    socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    await nextMessage(socket, "crdt_created");

    // A deliberately stale baseVersion, exactly like a client whose tracking predates a materialize.
    socket.sendJson({ type: "file_delete", requestId: "d1", roomId: room.id, relativePath: "note.md", baseVersion: 0 });
    expect(await nextMessage(socket, "file_delete_ack")).toMatchObject({ requestId: "d1", relativePath: "note.md" });
  });

  it("still enforces the compare-and-swap version gate for a non-CRDT-eligible path in a CRDT room", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);
    // .canvas stays on the whole-file CAS lane even in a CRDT room, so its version gate must survive.
    socket.sendJson({ type: "file_change", requestId: "w1", roomId: room.id, relativePath: "board.canvas", baseVersion: 0, content: "{}" });
    await nextMessage(socket, "file_change_ack");

    socket.sendJson({ type: "file_delete", requestId: "d1", roomId: room.id, relativePath: "board.canvas", baseVersion: 0 });
    expect(await nextMessage(socket, "file_change_rejected")).toMatchObject({ requestId: "d1", code: "VERSION_CONFLICT" });
  });

  it("keeps disambiguating when the suffixed path is also taken, and still revives a tombstoned path in place", async () => {
    const { app, owner, room } = await setupCrdtRoom();
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);

    socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    await nextMessage(socket, "crdt_created");
    socket.sendJson({ type: "crdt_create", requestId: "c2", roomId: room.id, relativePath: "note.md" });
    const second = await nextMessage(socket, "crdt_created");
    socket.sendJson({ type: "crdt_create", requestId: "c3", roomId: room.id, relativePath: "note.md" });
    const third = await nextMessage(socket, "crdt_created");
    expect(third.relativePath).not.toBe("note.md");
    expect(third.relativePath).not.toBe(second.relativePath);

    // A *tombstoned* path is not a collision - delete-then-recreate must still reuse the same path
    // (contract 1.5/1.9), not start suffixing.
    socket.sendJson({ type: "file_delete", requestId: "d1", roomId: room.id, relativePath: "note.md", baseVersion: 1 });
    await nextMessage(socket, "file_delete_ack");
    socket.sendJson({ type: "crdt_create", requestId: "c4", roomId: room.id, relativePath: "note.md" });
    expect(await nextMessage(socket, "crdt_created")).toMatchObject({ requestId: "c4", relativePath: "note.md" });
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
        payload: { name: "Room", type: "folder", sourcePath: "Room", mountName: "Room", capabilities: [], crdtEnabled: false }
      })
    ).json().room;
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);

    socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" });
    const rejected = await nextMessage(socket, "crdt_rejected");
    expect(rejected).toMatchObject({ requestId: "c1", code: "CRDT_DISABLED" });
    // One code, one sentence: the CRDT handshake lane and the presence lane both raise CRDT_DISABLED,
    // and they must not word it differently - a user hitting the same wall twice would otherwise be
    // told two different things.
    expect(rejected.message).toBe("Live editing is turned off for this room.");
    expect(rejected.message).not.toContain("CRDT sync");
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
    it("replays a journal-backed crdt_rename receipt without renaming or broadcasting twice", async () => {
      const { app, owner, room } = await setupCrdtRoom();
      const renamer = await connect(app);
      const peer = await connect(app);
      await helloAndSubscribe(renamer, owner.deviceToken, room.id);
      await helloAndSubscribe(peer, owner.deviceToken, room.id);
      renamer.sendJson({ type: "crdt_create", requestId: "create", roomId: room.id, relativePath: "before.md" });
      await nextMessage(renamer, "crdt_created");
      await nextMessage(peer, "remote_file_change");

      renamer.sendJson({
        type: "crdt_rename",
        requestId: "rename-first-attempt",
        operationId: "op-rename-once",
        roomId: room.id,
        oldRelativePath: "before.md",
        relativePath: "after.md"
      });
      const firstAck = await nextMessage(renamer, "crdt_renamed");
      await nextMessage(peer, "remote_crdt_rename");

      renamer.sendJson({
        type: "crdt_rename",
        requestId: "rename-retry",
        operationId: "op-rename-once",
        roomId: room.id,
        oldRelativePath: "before.md",
        relativePath: "after.md"
      });
      const retryAck = await nextMessage(renamer, "crdt_renamed");

      expect(retryAck).toMatchObject({
        requestId: "rename-retry",
        roomId: firstAck.roomId,
        oldRelativePath: firstAck.oldRelativePath,
        relativePath: firstAck.relativePath,
        epoch: firstAck.epoch
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(messageQueues.get(peer)?.filter((message) => (message as { type?: string }).type === "remote_crdt_rename")).toHaveLength(0);
    });

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

    // Eleventh hardware-testing round (2026-07-24): a rename whose target is held by another live
    // document is now disambiguated rather than rejected - the same first-come-first-served policy a
    // colliding create already used. Rejecting was a dead end: the note stayed unsynced under a name
    // the server would never accept, and it happens routinely (two devices renaming toward the same
    // title, or renaming to a name this device doesn't hold locally but another already published).
    it("disambiguates instead of rejecting when the new path is already taken by another live file", async () => {
      const { app, owner, room } = await setupCrdtRoom();
      const socket = await connect(app);
      await helloAndSubscribe(socket, owner.deviceToken, room.id);
      socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "a.md" });
      await nextMessage(socket, "crdt_created");
      socket.sendJson({ type: "crdt_create", requestId: "c2", roomId: room.id, relativePath: "b.md" });
      await nextMessage(socket, "crdt_created");

      socket.sendJson({ type: "crdt_rename", requestId: "r1", roomId: room.id, oldRelativePath: "a.md", relativePath: "b.md" });

      // A rename is NEVER auto-disambiguated: the name a user typed is authoritative, so a genuine
      // conflict is reported rather than silently filed under a machine-picked name. (An earlier round
      // did disambiguate here and it was wrong - each rewritten name collided again and drove an
      // unbounded rename loop on real hardware. The client's handling of this rejection is
      // non-destructive: it creates nothing and leaves both documents alone.)
      expect(await nextMessage(socket, "crdt_rejected")).toMatchObject({ requestId: "r1", code: "FILE_EXISTS" });
    });

    // Tenth hardware-testing round (2026-07-24): renaming onto a name that had merely been *deleted*
    // failed with the useless generic "CRDT message could not be applied." A tombstoned row is not a
    // logical conflict, but it still occupies the unique(room_id, relative_path) slot, so the update
    // threw a raw SQLite constraint error that could only be reported generically.
    it("renames onto a previously-deleted path instead of failing with a constraint error", async () => {
      const { app, owner, room } = await setupCrdtRoom();
      const socket = await connect(app);
      await helloAndSubscribe(socket, owner.deviceToken, room.id);

      // Create and delete "taken.md", leaving a tombstone holding that path.
      socket.sendJson({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "taken.md" });
      await nextMessage(socket, "crdt_created");
      socket.sendJson({ type: "file_delete", requestId: "d1", roomId: room.id, relativePath: "taken.md", baseVersion: 1 });
      await nextMessage(socket, "file_delete_ack");

      socket.sendJson({ type: "crdt_create", requestId: "c2", roomId: room.id, relativePath: "source.md" });
      const created = await nextMessage(socket, "crdt_created");
      socket.sendJson({ type: "crdt_rename", requestId: "r1", roomId: room.id, oldRelativePath: "source.md", relativePath: "taken.md" });

      // Succeeds, keeping the renamed document's identity/epoch - no constraint error, no generic
      // rejection.
      expect(await nextMessage(socket, "crdt_renamed")).toMatchObject({
        requestId: "r1",
        oldRelativePath: "source.md",
        relativePath: "taken.md",
        epoch: created.epoch
      });
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
