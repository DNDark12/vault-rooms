import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import * as Y from "yjs";
import { createApp } from "../src/app.js";
import type { CrdtDocManager } from "../src/sync/crdtDocManager.js";
import type { SyncTimerHost } from "../src/sync/syncServer.js";
import { injectBootstrap } from "./bootstrapHelper.js";

// Phase 6 of docs/superpowers/plans/2026-07-20-crdt-sync.md: coexistence between the CRDT lane and
// the legacy whole-file CAS lane. Covers contract 1.4 (legacy write policy, decided as "reject")
// and the room-toggle conversion (turning CRDT on for a room that already has existing .md files
// must seed each one from its current text at a fresh epoch, never discarding content) plus the
// explicit coexistence proof that a legacy/non-CRDT-capable subscriber only ever sees materialized
// remote_file_change fanout for a CRDT-enabled room, never remote_crdt_update - Phase 4 already
// built the mechanism (CrdtDocManager's onMaterialized callback + ConnectionRegistry.
// broadcastToRoom's connectionFilter); this file is the dedicated test proving it, specifically for
// the toggle-ON-with-existing-files case (Phase 3/4's own tests only covered a freshly-created CRDT
// file, never a pre-existing one converted mid-flight).

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

async function assertNoMessage(socket: WebSocket, type: string, withinMs: number): Promise<void> {
  await expect(nextMessageWithDeadline(socket, type, withinMs)).rejects.toThrow(/Timed out/);
}

async function nextMessageWithDeadline(socket: WebSocket, type: string, withinMs: number): Promise<any> {
  const deadline = Date.now() + withinMs;
  const queue = messageQueues.get(socket)!;
  for (;;) {
    const index = queue.findIndex((message) => (message as { type?: string }).type === type);
    if (index !== -1) return queue.splice(index, 1)[0];
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${type}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function helloAndSubscribe(socket: JsonSocket, token: string, roomId: string, options: { crdt: boolean } = { crdt: true }): Promise<void> {
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

function base64OfUpdate(update: Uint8Array): string {
  return Buffer.from(update).toString("base64");
}

function emptyStateVectorBase64(): string {
  return base64OfUpdate(Y.encodeStateVector(new Y.Doc()));
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

async function setupRoom(options: { crdtTimerHost?: SyncTimerHost } = {}) {
  const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787", crdtTimerHost: options.crdtTimerHost });
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
  return { app, owner, room };
}

async function toggleCrdt(app: Awaited<ReturnType<typeof createApp>>, owner: { deviceToken: string }, room: any, enabled: boolean) {
  return app.inject({
    method: "PATCH",
    url: `/api/rooms/${room.id}`,
    headers: { authorization: `Bearer ${owner.deviceToken}` },
    payload: { name: room.name, type: room.type, sourcePath: room.sourcePath, mountName: room.mountName, crdtEnabled: enabled }
  });
}

describe("CRDT coexistence (Phase 6)", () => {
  it("[contract 1.4] a REST PUT to a CRDT-enabled .md path is rejected with CRDT_WRITE_UNSUPPORTED, not silently applied", async () => {
    const { app, owner, room } = await setupRoom();
    await toggleCrdt(app, owner, room, true);

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "note.md", baseVersion: 0, content: "should be rejected" }
    });

    expect(putResponse.statusCode).toBe(409);
    expect(putResponse.json().error.code).toBe("CRDT_WRITE_UNSUPPORTED");
  });

  it("[contract 1.4] a REST PUT to a non-.md path in a CRDT-enabled room is unaffected - only .md is CRDT-eligible", async () => {
    const { app, owner, room } = await setupRoom();
    await toggleCrdt(app, owner, room, true);

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "notes.txt", baseVersion: 0, content: "plain text still works" }
    });

    expect(putResponse.statusCode).toBe(200);
  });

  it("[contract 1.4] a WS file_change to a CRDT-enabled .md path is rejected the same way as the REST PUT", async () => {
    const { app, owner, room } = await setupRoom();
    await toggleCrdt(app, owner, room, true);
    const socket = await connect(app);
    // A legacy build wouldn't send capabilities at all; a CRDT-capable build attempting a legacy
    // whole-file write to a CRDT path should be rejected identically - the policy is per-path/
    // per-room, not per-connection-capability.
    await helloAndSubscribe(socket, owner.deviceToken, room.id, { crdt: false });

    socket.sendJson({ type: "file_change", requestId: "fc1", roomId: room.id, relativePath: "note.md", baseVersion: 0, content: "should be rejected" });
    const rejection = await nextMessage(socket, "file_change_rejected");
    expect(rejection).toMatchObject({ requestId: "fc1", code: "CRDT_WRITE_UNSUPPORTED" });
  });

  it("[contract 1.6] GET files/content on a CRDT-enabled file still returns the materialized latest text", async () => {
    const timers = new FakeCrdtTimerHost();
    const { app, owner, room } = await setupRoom({ crdtTimerHost: timers });
    await toggleCrdt(app, owner, room, true);
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
      update: base64OfUpdate(
        Y.encodeStateAsUpdate(
          (() => {
            const doc = new Y.Doc();
            doc.getText("content").insert(0, "materialized content");
            return doc;
          })()
        )
      )
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    timers.runAllTimeouts();

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files/content?path=note.md`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(getResponse.json().content).toBe("materialized content");
  });

  it("[toggle-ON conversion] turning CRDT on for a room with existing .md files seeds each from its current text at a fresh (bumped) epoch, never discarding content", async () => {
    const { app, owner, room } = await setupRoom();
    // Two pre-existing Markdown files, written through the ordinary (pre-CRDT) whole-file lane.
    await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "note.md", baseVersion: 0, content: "pre-existing note content" }
    });
    await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "second.md", baseVersion: 0, content: "second file content" }
    });
    // A non-.md file must be left alone by the conversion entirely (still CAS-only, no epoch).
    await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "asset.txt", baseVersion: 0, content: "not markdown" }
    });

    const toggled = await toggleCrdt(app, owner, room, true);
    expect(toggled.statusCode).toBe(200);

    // GET must still return the exact pre-existing content - the REST/legacy read path never
    // regresses, whether or not it happens to be served via materialized CRDT content underneath.
    const getNote = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files/content?path=note.md`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(getNote.json().content).toBe("pre-existing note content");
    const getSecond = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files/content?path=second.md`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(getSecond.json().content).toBe("second file content");
    const getAsset = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files/content?path=asset.txt`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(getAsset.json().content).toBe("not markdown");

    // Prove the seeding actually went through the CRDT lane (a real Y.Doc, not just an untouched
    // files/file_versions row) by running the handshake cold, from an empty client state vector,
    // and decoding the resulting Yjs update - this is what a fresh client mounting the room after
    // conversion would do to hydrate its own copy.
    const socket = await connect(app);
    await helloAndSubscribe(socket, owner.deviceToken, room.id);
    socket.sendJson({
      type: "crdt_sync_step1",
      requestId: "h1",
      roomId: room.id,
      relativePath: "note.md",
      epoch: 1, // bumped from 0 by the conversion (contract 1.5's epoch-bump semantics apply).
      stateVector: emptyStateVectorBase64()
    });
    const step2 = await nextMessage(socket, "crdt_sync_step2");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(step2.update, "base64")));
    expect(doc.getText("content").toString()).toBe("pre-existing note content");

    // room_snapshot confirms the bumped epoch for both converted files and omits crdtEpoch for the
    // untouched non-.md file.
    socket.sendJson({ type: "subscribe_room", requestId: "s2", roomId: room.id });
    const snapshot = await nextMessage(socket, "room_snapshot");
    expect(snapshot.files.find((f: any) => f.relativePath === "note.md").crdtEpoch).toBe(1);
    expect(snapshot.files.find((f: any) => f.relativePath === "second.md").crdtEpoch).toBe(1);
    expect(snapshot.files.find((f: any) => f.relativePath === "asset.txt").crdtEpoch).toBeUndefined();
  });

  it("[toggle-ON conversion] a legacy (non-CRDT-capable) subscriber only ever sees room_snapshot + materialized remote_file_change for a converted file, never remote_crdt_update", async () => {
    const timers = new FakeCrdtTimerHost();
    const { app, owner, room } = await setupRoom({ crdtTimerHost: timers });
    await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "note.md", baseVersion: 0, content: "before conversion" }
    });

    const legacyPeer = await connect(app);
    await helloAndSubscribe(legacyPeer, owner.deviceToken, room.id, { crdt: false });

    await toggleCrdt(app, owner, room, true);
    // The legacy peer stays subscribed through the toggle (room_mode_changed doesn't force a
    // disconnect) - it still only ever receives materialized fanout, never remote_crdt_update, for
    // a converted file.
    expect(await nextMessage(legacyPeer, "room_mode_changed")).toMatchObject({ roomId: room.id, crdtEnabled: true });

    const author = await connect(app);
    await helloAndSubscribe(author, owner.deviceToken, room.id, { crdt: true });
    author.sendJson({
      type: "crdt_update",
      requestId: "u1",
      roomId: room.id,
      relativePath: "note.md",
      epoch: 1,
      update: base64OfUpdate(
        Y.encodeStateAsUpdate(
          (() => {
            const doc = new Y.Doc();
            doc.getText("content").insert("before conversion".length, " + live edit");
            return doc;
          })()
        )
      )
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Immediately after the update (before the materialize debounce fires), the legacy peer must
    // not have received remote_crdt_update at all - it isn't CRDT-capable.
    await assertNoMessage(legacyPeer, "remote_crdt_update", 50);

    timers.runAllTimeouts(); // fire the materialize debounce.
    const materialized = await nextMessage(legacyPeer, "remote_file_change");
    expect(materialized).toMatchObject({ roomId: room.id, relativePath: "note.md" });
    // Never remote_crdt_update, even after the debounce fires and fanout has fully settled.
    await assertNoMessage(legacyPeer, "remote_crdt_update", 50);
  });

  it("[toggle-OFF] disabling CRDT after conversion is non-destructive and cleanly reverts to the CAS lane", async () => {
    const { app, owner, room } = await setupRoom();
    await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "note.md", baseVersion: 0, content: "will survive the round trip" }
    });
    await toggleCrdt(app, owner, room, true);
    const toggledOff = await toggleCrdt(app, owner, room, false);
    expect(toggledOff.statusCode).toBe(200);
    expect(toggledOff.json().room.crdtEnabled).toBe(false);

    // Content survives the ON-then-OFF round trip untouched.
    const getResponse = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files/content?path=note.md`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(getResponse.json().content).toBe("will survive the round trip");

    // A legacy whole-file write is accepted again now that the room is back on the CAS lane -
    // baseVersion must be the file's current version (bumped once by the initial PUT, once more by
    // the durable conversion's materialize-independent seeding does NOT bump files.version, so this
    // is still version 1 from the original PUT).
    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "note.md", baseVersion: 1, content: "edited after reverting to CAS" }
    });
    expect(putResponse.statusCode).toBe(200);
  });

  it("[memory hygiene] a REST delete of a CRDT-enabled file evicts its cached Y.Doc, closing the Phase 4 gap for this route", async () => {
    const { app, owner, room } = await setupRoom();
    await toggleCrdt(app, owner, room, true);
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
      update: base64OfUpdate(
        Y.encodeStateAsUpdate(
          (() => {
            const doc = new Y.Doc();
            doc.getText("content").insert(0, "cache me");
            return doc;
          })()
        )
      )
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const crdtDocManager = (app as unknown as { testCrdtDocManager: CrdtDocManager }).testCrdtDocManager;
    expect(crdtDocManager.isCached(created.documentId, created.epoch)).toBe(true);

    const deleteResponse = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/files/delete`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "note.md", baseVersion: 1 }
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(crdtDocManager.isCached(created.documentId, created.epoch)).toBe(false);
  });
});
