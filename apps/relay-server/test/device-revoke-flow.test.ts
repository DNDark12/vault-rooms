import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../src/app.js";
import type { RelayRepository } from "../src/db/repositories/relayRepository.js";
import { injectBootstrap } from "./bootstrapHelper.js";

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  for (const app of apps.splice(0)) {
    await app.close();
  }
});

describe("per-device revoke", () => {
  it("revokes a single device's token and force-closes only that device's WS session, leaving the user's other device untouched", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    apps.push(app);

    const owner = (await injectBootstrap(app, { displayName: "Owner", deviceName: "Owner laptop", teamName: "Demo" })).json();

    const invite = (
      await app.inject({
        method: "POST",
        url: `/api/teams/${owner.team.id}/invites`,
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { role: "member", expiresInMinutes: 60, maxUses: 1 }
      })
    ).json();
    // `deviceA` is this user's first device, created by /api/join (deviceA.device.id/.deviceToken).
    const deviceA = (
      await app.inject({
        method: "POST",
        url: "/api/join",
        payload: { inviteToken: invite.inviteToken, displayName: "U", deviceName: "Device A" }
      })
    ).json();

    // There is no REST route yet for enrolling a second device on an existing account, so this
    // fixture reaches into the repository (exposed only for tests via app.decorate("testRepo")).
    const repo = (app as unknown as { testRepo: RelayRepository }).testRepo;
    const deviceB = repo.addDevice({ userId: deviceA.user.id, deviceName: "Device B" });

    // Both devices are live: authenticated REST + an open WS subscription each.
    const meA = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${deviceA.deviceToken}` } });
    expect(meA.statusCode).toBe(200);
    const meB = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${deviceB.deviceToken}` } });
    expect(meB.statusCode).toBe(200);

    const socketA = await connect(app);
    socketA.sendJson({ type: "hello", requestId: "hello-a", token: deviceA.deviceToken, client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "Device A" } });
    expect(await nextMessage(socketA, "hello_ok")).toMatchObject({ requestId: "hello-a" });

    const socketB = await connect(app);
    socketB.sendJson({ type: "hello", requestId: "hello-b", token: deviceB.deviceToken, client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "Device B" } });
    expect(await nextMessage(socketB, "hello_ok")).toMatchObject({ requestId: "hello-b" });

    // Server owner revokes device A only.
    const revokedMessage = nextMessage(socketA, "revoked");
    const closeA = waitForClose(socketA);
    const revoke = await app.inject({
      method: "POST",
      url: `/api/friends/${deviceA.user.id}/devices/${deviceA.device.id}/revoke`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(revoke.statusCode).toBe(200);
    expect(await revokedMessage).toMatchObject({ message: "Your access to this server has been revoked." });
    await closeA;

    // Device A's token now fails auth on a subsequent REST call.
    const meAAfterRevoke = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${deviceA.deviceToken}` } });
    expect(meAAfterRevoke.statusCode).toBe(401);

    // Device B's token + open WS session remain fully functional - the whole user was not nuked.
    const meBAfterRevoke = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${deviceB.deviceToken}` } });
    expect(meBAfterRevoke.statusCode).toBe(200);
    expect(socketB.readyState).toBe(WebSocket.OPEN);
    socketB.sendJson({ type: "hello", requestId: "hello-b-again", token: deviceB.deviceToken, client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "Device B" } });
    expect(await nextMessage(socketB, "hello_ok")).toMatchObject({ requestId: "hello-b-again" });
  });

  it("returns 403 for a non-server-owner caller and 404 for an unknown or mismatched device", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    apps.push(app);

    const owner = (await injectBootstrap(app, { displayName: "Owner", deviceName: "Owner laptop", teamName: "Demo" })).json();
    const invite = (
      await app.inject({
        method: "POST",
        url: `/api/teams/${owner.team.id}/invites`,
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { role: "member", expiresInMinutes: 60, maxUses: 1 }
      })
    ).json();
    const user = (
      await app.inject({
        method: "POST",
        url: "/api/join",
        payload: { inviteToken: invite.inviteToken, displayName: "U", deviceName: "Device A" }
      })
    ).json();
    const otherInvite = (
      await app.inject({
        method: "POST",
        url: `/api/teams/${owner.team.id}/invites`,
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { role: "member", expiresInMinutes: 60, maxUses: 1 }
      })
    ).json();
    const otherUser = (
      await app.inject({
        method: "POST",
        url: "/api/join",
        payload: { inviteToken: otherInvite.inviteToken, displayName: "Other", deviceName: "Other device" }
      })
    ).json();

    const asNonOwner = await app.inject({
      method: "POST",
      url: `/api/friends/${user.user.id}/devices/${user.device.id}/revoke`,
      headers: { authorization: `Bearer ${user.deviceToken}` }
    });
    expect(asNonOwner.statusCode).toBe(403);

    const unknownDevice = await app.inject({
      method: "POST",
      url: `/api/friends/${user.user.id}/devices/dev_does_not_exist/revoke`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(unknownDevice.statusCode).toBe(404);

    // user.device.id belongs to `user`, not `otherUser` - the userId/deviceId pair must be
    // validated together, not just that the device exists somewhere on the server.
    const mismatchedOwner = await app.inject({
      method: "POST",
      url: `/api/friends/${otherUser.user.id}/devices/${user.device.id}/revoke`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(mismatchedOwner.statusCode).toBe(404);
  });
});

type JsonSocket = WebSocket & { sendJson: (payload: unknown) => void };

const messageQueues = new WeakMap<WebSocket, unknown[]>();
const messageWaiters = new WeakMap<WebSocket, Array<() => void>>();
const closedSockets = new WeakSet<WebSocket>();

async function connect(app: Awaited<ReturnType<typeof createApp>>): Promise<JsonSocket> {
  await app.ready();
  const socket = (await app.injectWS("/sync")) as unknown as JsonSocket;
  socket.sendJson = (payload: unknown) => socket.send(JSON.stringify(payload));
  sockets.push(socket);
  messageQueues.set(socket, []);
  messageWaiters.set(socket, []);
  socket.on("message", (raw: WebSocket.RawData) => {
    messageQueues.get(socket)!.push(JSON.parse(raw.toString()));
    for (const wake of messageWaiters.get(socket)!.splice(0)) {
      wake();
    }
  });
  socket.on("close", () => {
    closedSockets.add(socket);
    for (const wake of messageWaiters.get(socket)!.splice(0)) {
      wake();
    }
  });
  return socket;
}

async function nextMessage(socket: WebSocket, type: string): Promise<any> {
  const deadline = Date.now() + 2_000;
  const queue = messageQueues.get(socket);
  if (!queue) {
    throw new Error("Socket was not created via connect()");
  }
  for (;;) {
    const index = queue.findIndex((message) => (message as { type?: string }).type === type);
    if (index !== -1) {
      return queue.splice(index, 1)[0];
    }
    if (closedSockets.has(socket)) {
      throw new Error(`Socket closed while waiting for ${type}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for ${type}`);
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, remaining);
      messageWaiters.get(socket)!.push(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

async function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}
