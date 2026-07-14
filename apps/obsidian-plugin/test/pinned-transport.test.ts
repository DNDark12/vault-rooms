import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  certPemToDerBase64Url,
  generateServerIdentity,
  tlsCertificateChainPem,
  type ServerIdentity
} from "vault-rooms-relay/embedded-core";
import {
  fetchRotationProbe,
  InvalidPinMaterialError,
  pinnedRequest,
  type PinnedServerInfo
} from "../src/pinnedTransport.js";
import { RelayApiClient } from "../src/apiClient.js";
import { openSyncSocket } from "../src/syncWsClient.js";
import type { ServerConnection } from "../src/settings.js";

(globalThis as unknown as { window: typeof globalThis }).window ??= globalThis;

const servers: Server[] = [];
const webSocketServers: WebSocketServer[] = [];

afterEach(async () => {
  for (const webSocketServer of webSocketServers.splice(0)) {
    for (const client of webSocketServer.clients) client.terminate();
    await new Promise<void>((resolve, reject) =>
      webSocketServer.close((error) => (error ? reject(error) : resolve()))
    );
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

describe("pinned REST transport", () => {
  it("reaches a server only when the saved identity certificate, pin, and remote chain agree", async () => {
    const identity = await generateServerIdentity("srv_pinned_transport");
    const remote = await startServer(identity, { ok: true });
    const info = pinnedInfo(identity);

    const response = await pinnedRequest(info, { url: `${remote.baseUrl}/health` });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({ ok: true });
    expect(remote.requests()).toBe(1);
  });

  it("routes RelayApiClient health checks through the pinned transport", async () => {
    const identity = await generateServerIdentity("srv_pinned_api_client");
    const remote = await startServer(identity, { name: "vault-rooms", version: "0.1.0" });

    await expect(new RelayApiClient(remote.baseUrl, undefined, undefined, pinnedInfo(identity)).testConnection()).resolves.toEqual({
      ok: true,
      version: "0.1.0"
    });
    expect(remote.requests()).toBe(1);
  });

  it("rejects tampered local pin material before opening a network request", async () => {
    const identity = await generateServerIdentity("srv_local_pin_validation");
    const remote = await startServer(identity, { ok: true });

    await expect(
      pinnedRequest({ ...pinnedInfo(identity), pinnedIdentitySpkiSha256: "tampered" }, { url: `${remote.baseUrl}/health` })
    ).rejects.toBeInstanceOf(InvalidPinMaterialError);
    expect(remote.requests()).toBe(0);
  });

  it("keeps a different remote identity as a normal TLS authorization failure and probes it without credentials", async () => {
    const savedIdentity = await generateServerIdentity("srv_saved_identity");
    const presentedIdentity = await generateServerIdentity("srv_presented_identity");
    const remote = await startServer(presentedIdentity, { rotations: [] });

    await expect(
      pinnedRequest(pinnedInfo(savedIdentity), { url: `${remote.baseUrl}/api/identity/rotations` })
    ).rejects.toThrow();
    expect(remote.requests()).toBe(0);

    const probe = await fetchRotationProbe(remote.baseUrl);
    expect(probe.body).toEqual({ rotations: [] });
    expect(probe.presentedSpkiSha256).toBe(presentedIdentity.identitySpkiSha256);
    expect(remote.requests()).toBe(1);
    expect(remote.authorizationHeaders()).toEqual([undefined]);
  });

  it("rejects URL credentials before networking and always probes the exact public rotation path", async () => {
    const identity = await generateServerIdentity("srv_probe_url");
    const remote = await startServer(identity, { rotations: [] });
    const credentialedUrl = remote.baseUrl.replace("https://", "https://alice:secret@");

    await expect(fetchRotationProbe(credentialedUrl)).rejects.toThrow("must not include credentials");
    expect(remote.requests()).toBe(0);

    await fetchRotationProbe(`${remote.baseUrl}/ignored/path?authorization=secret#fragment`);
    expect(remote.requestPaths()).toEqual(["/api/identity/rotations"]);
    expect(remote.authorizationHeaders()).toEqual([undefined]);
  });

  it("rejects an oversized credentialless rotation response", async () => {
    const identity = await generateServerIdentity("srv_probe_limit");
    const remote = await startServer(identity, { rotations: [], padding: "x".repeat(300 * 1024) });

    await expect(fetchRotationProbe(remote.baseUrl)).rejects.toThrow("response is too large");
  });

  it("reports the same identity pin when only the leaf is expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
    const identity = await generateServerIdentity("srv_expired_leaf");
    vi.useRealTimers();
    const remote = await startServer(identity, { rotations: [] });

    const probe = await fetchRotationProbe(remote.baseUrl);

    expect(probe.presentedSpkiSha256).toBe(identity.identitySpkiSha256);
  });
});

describe("pinned WSS transport", () => {
  it("opens pinned WSS and completes a hello exchange", async () => {
    const identity = await generateServerIdentity("srv_pinned_wss");
    const remote = await startServer(identity, { name: "vault-rooms", version: "0.1.0" }, true);
    const socket = openSyncSocket(serverConnection(remote.baseUrl, identity));

    await once(socket, "open");
    socket.send(JSON.stringify({ type: "hello", requestId: "req_1", token: "tr_device", client: { kind: "test" } }));
    const raw = await onceMessage(socket);

    expect(JSON.parse(raw)).toMatchObject({ type: "hello_ok", requestId: "req_1" });
    expect(remote.frames()).toHaveLength(1);
    socket.close();
    await once(socket, "close");
  });

  it("rejects invalid local material before constructing a socket", async () => {
    const identity = await generateServerIdentity("srv_invalid_wss_pin");
    const remote = await startServer(identity, { ok: true }, true);
    const server = serverConnection(remote.baseUrl, identity);
    server.pinnedIdentitySpkiSha256 = "tampered";

    expect(() => openSyncSocket(server)).toThrow(InvalidPinMaterialError);
    expect(remote.frames()).toHaveLength(0);
  });

  it("sends no hello frames to a server presenting a different identity", async () => {
    const savedIdentity = await generateServerIdentity("srv_saved_wss_identity");
    const remoteIdentity = await generateServerIdentity("srv_remote_wss_identity");
    const remote = await startServer(remoteIdentity, { ok: true }, true);
    const socket = openSyncSocket(serverConnection(remote.baseUrl, savedIdentity));

    await once(socket, "error");

    expect(remote.frames()).toHaveLength(0);
  });
});

function pinnedInfo(identity: ServerIdentity): PinnedServerInfo {
  return {
    tlsName: identity.tlsName,
    identityCertificateDer: certPemToDerBase64Url(identity.identityCertPem),
    pinnedIdentitySpkiSha256: identity.identitySpkiSha256
  };
}

async function startServer(identity: ServerIdentity, body: unknown, withWebSocket = false) {
  let requestCount = 0;
  const authorizationHeaders: Array<string | undefined> = [];
  const requestPaths: string[] = [];
  const frames: string[] = [];
  const server = createServer(
    { key: identity.leafKeyPem, cert: tlsCertificateChainPem(identity) },
    (request, response) => {
      requestCount += 1;
      authorizationHeaders.push(request.headers.authorization);
      requestPaths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    }
  );
  if (withWebSocket) {
    const webSocketServer = new WebSocketServer({ server });
    webSocketServers.push(webSocketServer);
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const raw = data.toString();
        frames.push(raw);
        const message = JSON.parse(raw) as { type?: string; requestId?: string };
        if (message.type === "hello") {
          socket.send(JSON.stringify({ type: "hello_ok", requestId: message.requestId, device: { id: "dev_1" } }));
        }
      });
    });
  }
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `https://127.0.0.1:${port}`,
    requests: () => requestCount,
    authorizationHeaders: () => authorizationHeaders,
    requestPaths: () => requestPaths,
    frames: () => frames
  };
}

function serverConnection(baseUrl: string, identity: ServerIdentity): ServerConnection {
  return {
    id: "dev_1",
    baseUrl,
    userId: "user_1",
    userDisplayName: "Test",
    deviceId: "dev_1",
    deviceName: "Test device",
    deviceToken: "tr_device",
    isServerOwner: false,
    status: "active",
    securityMode: "pinned-tls",
    tlsName: identity.tlsName,
    identityCertificateDer: certPemToDerBase64Url(identity.identityCertPem),
    pinnedIdentitySpkiSha256: identity.identitySpkiSha256,
    appliedRotationIds: []
  };
}

function once(socket: WebSocket, event: "open" | "close" | "error"): Promise<void> {
  return new Promise((resolve) => socket.addEventListener(event, () => resolve(), { once: true }));
}

function onceMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) =>
    socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true })
  );
}
