import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { createApp } from "../src/app.js";
import { injectBootstrap } from "./bootstrapHelper.js";

// Phase 3 of docs/superpowers/plans/2026-07-20-crdt-sync.md: room-mode + document-metadata
// delivery (contract 1.11). Capability negotiation (contract 1.2) is plumbed here too, but its
// first *observable* behavior difference (fanout branching on capabilities.crdt) lands in Phase 4
// alongside CrdtDocManager - there's nothing for a Phase-3-only test to observe there yet beyond
// "hello with a capabilities field doesn't get rejected", which packages/protocol/src/
// crdtProtocol.test.ts already covers at the type/round-trip level.

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

async function setup() {
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
  return { app, owner, room };
}

describe("CRDT room mode (Phase 3)", () => {
  it("a freshly created room has crdtEnabled: false by default", async () => {
    const { room } = await setup();
    expect(room.crdtEnabled).toBe(false);
  });

  it("PATCH /api/rooms/:roomId accepts crdtEnabled, gated the same way as other room settings (canManageRoom)", async () => {
    const { app, owner, room } = await setup();

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/rooms/${room.id}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: {
        name: room.name,
        type: room.type,
        sourcePath: room.sourcePath,
        mountName: room.mountName,
        crdtEnabled: true
      }
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json().room.crdtEnabled).toBe(true);
  });

  it("a non-owner cannot toggle crdtEnabled (same PERMISSION_DENIED as other room settings)", async () => {
    const { app, owner, room } = await setup();
    const invite = (
      await app.inject({
        method: "POST",
        url: `/api/rooms/${room.id}/invites`,
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { preset: "editor" }
      })
    ).json();
    const member = (
      await app.inject({
        method: "POST",
        url: "/api/join",
        payload: { inviteToken: invite.inviteToken, displayName: "Member", deviceName: "Member laptop" }
      })
    ).json();

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/rooms/${room.id}`,
      headers: { authorization: `Bearer ${member.deviceToken}` },
      payload: { name: room.name, type: room.type, sourcePath: room.sourcePath, mountName: room.mountName, crdtEnabled: true }
    });

    expect(patched.statusCode).toBe(403);
  });

  it("toggling crdtEnabled broadcasts room_mode_changed to a subscribed connection", async () => {
    const { app, owner, room } = await setup();
    const socket = await connect(app);
    socket.sendJson({
      type: "hello",
      requestId: "h1",
      token: owner.deviceToken,
      client: { kind: "obsidian-plugin", version: "0.3.0", deviceName: "Owner laptop" }
    });
    await nextMessage(socket, "hello_ok");
    socket.sendJson({ type: "subscribe_room", requestId: "s1", roomId: room.id });
    await nextMessage(socket, "room_snapshot");

    await app.inject({
      method: "PATCH",
      url: `/api/rooms/${room.id}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: room.name, type: room.type, sourcePath: room.sourcePath, mountName: room.mountName, crdtEnabled: true }
    });

    const modeChanged = await nextMessage(socket, "room_mode_changed");
    expect(modeChanged).toMatchObject({ roomId: room.id, crdtEnabled: true });
  });

  it("room_snapshot carries crdtEpoch for .md files in a CRDT-enabled room, and omits it otherwise", async () => {
    const { app, owner, room } = await setup();
    await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.id}/files/content`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { relativePath: "note.md", baseVersion: 0, content: "hello" }
    });

    const socket = await connect(app);
    socket.sendJson({
      type: "hello",
      requestId: "h1",
      token: owner.deviceToken,
      client: { kind: "obsidian-plugin", version: "0.3.0", deviceName: "Owner laptop" }
    });
    await nextMessage(socket, "hello_ok");
    socket.sendJson({ type: "subscribe_room", requestId: "s1", roomId: room.id });
    const snapshotBeforeCrdt = await nextMessage(socket, "room_snapshot");
    expect(snapshotBeforeCrdt.files.find((f: any) => f.relativePath === "note.md").crdtEpoch).toBeUndefined();

    await app.inject({
      method: "PATCH",
      url: `/api/rooms/${room.id}`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: room.name, type: room.type, sourcePath: room.sourcePath, mountName: room.mountName, crdtEnabled: true }
    });
    socket.sendJson({ type: "subscribe_room", requestId: "s2", roomId: room.id });
    const snapshotAfterCrdt = await nextMessage(socket, "room_snapshot");
    // Phase 6: toggling CRDT on for a room with a pre-existing "note.md" now converts it - seeding
    // a fresh Y.Doc from its current text at a newly bumped epoch (contract 1.4/1.5), rather than
    // leaving it at epoch 0 as Phase 3 did before conversion existed. See crdt-coexistence.test.ts
    // for the dedicated seeding/content-preservation coverage this correction motivated.
    expect(snapshotAfterCrdt.files.find((f: any) => f.relativePath === "note.md").crdtEpoch).toBe(1);
  });
});
