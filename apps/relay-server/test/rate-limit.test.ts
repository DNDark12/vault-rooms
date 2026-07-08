import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { RelayRepository } from "../src/db/repositories/relayRepository.js";
import type { ConnectionRegistry } from "../src/sync/connectionRegistry.js";
import { createApp } from "../src/app.js";
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

describe("rate limiting and connection caps", () => {
  it("limits bootstrap attempts after business-rule rejections consume the bootstrap budget", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      publicUrl: "http://127.0.0.1:8787",
      rateLimit: { bootstrapMax: 3, bootstrapWindowMs: 60_000 }
    });
    apps.push(app);

    const payload = { displayName: "A", deviceName: "A laptop", teamName: "Demo" };
    const first = await injectBootstrap(app, payload);
    const owner = first.json();
    const second = await injectBootstrap(app, payload);
    const third = await injectBootstrap(app, payload);
    const fourth = await injectBootstrap(app, payload);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(403);
    expect(third.statusCode).toBe(403);
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json()).toEqual({ error: { code: "RATE_LIMITED", message: "Too many bootstrap attempts. Try again later." } });

    const repo = (app as unknown as { testRepo: RelayRepository }).testRepo;
    expect(repo.getServerOwnerId()).toBe(owner.user.id);
  });

  it("rejects WebSocket connections above the configured cap without affecting existing sockets", async () => {
    const { app, owner } = await bootstrapApp({ maxConnections: 2 });
    const registry = (app as unknown as { testConnectionRegistry: ConnectionRegistry }).testConnectionRegistry;

    const first = await connect(app);
    const second = await connect(app);
    const third = await connect(app);
    await waitForClose(third);

    expect(registry.size()).toBeLessThanOrEqual(2);
    expect(first.readyState).toBe(WebSocket.OPEN);
    expect(second.readyState).toBe(WebSocket.OPEN);

    first.sendJson({ type: "hello", requestId: "hello-a", token: owner.deviceToken, client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "A laptop" } });
    expect(await nextMessage(first, "hello_ok")).toMatchObject({ requestId: "hello-a", userId: owner.user.id });
    expect(registry.size()).toBe(2);
  });

  it("does not throttle a normal bootstrap, invite, and join flow with default HTTP limits", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    apps.push(app);

    const bootstrap = await injectBootstrap(app, { displayName: "A", deviceName: "A laptop", teamName: "Demo" });
    expect(bootstrap.statusCode).toBe(200);
    const owner = bootstrap.json();

    const invite = await app.inject({
      method: "POST",
      url: `/api/teams/${owner.team.id}/invites`,
      remoteAddress: "127.0.0.1",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { role: "member", expiresInMinutes: 60, maxUses: 1 }
    });
    expect(invite.statusCode).toBe(200);

    const joined = await app.inject({
      method: "POST",
      url: "/api/join",
      remoteAddress: "127.0.0.1",
      payload: { inviteToken: invite.json().inviteToken, displayName: "B", deviceName: "B laptop" }
    });
    expect(joined.statusCode).toBe(200);
    const member = joined.json();

    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      remoteAddress: "127.0.0.1",
      headers: { authorization: `Bearer ${member.deviceToken}` }
    });
    expect(me.statusCode).toBe(200);

    const members = await app.inject({
      method: "GET",
      url: `/api/teams/${owner.team.id}/members`,
      remoteAddress: "127.0.0.1",
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(members.statusCode).toBe(200);
  });

  it("allows normal-volume WebSocket connections under the default cap", async () => {
    const { app } = await bootstrapApp();
    const registry = (app as unknown as { testConnectionRegistry: ConnectionRegistry }).testConnectionRegistry;

    const first = await connect(app);
    const second = await connect(app);
    const third = await connect(app);

    expect(first.readyState).toBe(WebSocket.OPEN);
    expect(second.readyState).toBe(WebSocket.OPEN);
    expect(third.readyState).toBe(WebSocket.OPEN);
    expect(registry.size()).toBe(3);
  });
});

type JsonSocket = WebSocket & { sendJson: (payload: unknown) => void };

const messageQueues = new WeakMap<WebSocket, unknown[]>();
const messageWaiters = new WeakMap<WebSocket, Array<() => void>>();
const closedSockets = new WeakSet<WebSocket>();

async function bootstrapApp(options: { maxConnections?: number } = {}) {
  const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787", ...options });
  apps.push(app);
  const owner = (await injectBootstrap(app, { displayName: "A", deviceName: "A laptop", teamName: "Demo" })).json();
  return { app, owner };
}

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
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for socket close")), 2_000);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
