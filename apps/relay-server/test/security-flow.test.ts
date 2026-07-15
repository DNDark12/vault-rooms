import { createInviteAcceptanceProof, type IdentityRotationRecord } from "@vault-rooms/protocol";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import type { DetailedPeerCertificate, TLSSocket } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createAppWithDb } from "../src/appCore.js";
import { openRelayDb } from "../src/db/db.js";
import { RelayRepository } from "../src/db/repositories/relayRepository.js";
import type { RelayDb } from "../src/db/sqlJsAdapter.js";
import {
  generateServerIdentity,
  spkiSha256FromCertDer,
  tlsCertificateChainPem
} from "../src/security/identity.js";
import type { PersistedIdentity } from "../src/security/identityStore.js";
import { ConnectionRegistry } from "../src/sync/connectionRegistry.js";
import { injectBootstrap } from "./bootstrapHelper.js";

const databases: RelayDb[] = [];
const apps: Array<Awaited<ReturnType<typeof createAppWithDb>>> = [];
const sockets: WebSocket[] = [];

async function createRepository(): Promise<{ db: RelayDb; repo: RelayRepository }> {
  const db = await openRelayDb(":memory:");
  databases.push(db);
  return { db, repo: new RelayRepository(db) };
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  for (const app of apps.splice(0)) {
    await app.close();
  }
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

async function createSecurityApp(
  rotations: IdentityRotationRecord[] = [],
  rateLimit?: { rotationProbeMax?: number; rotationProbeWindowMs?: number },
  transportOverrideForTests: "http" | "https" = "https"
) {
  const db = await openRelayDb(":memory:");
  databases.push(db);
  const setupRepo = new RelayRepository(db);
  const serverId = setupRepo.getOrCreateServerId();
  const persisted: PersistedIdentity = {
    serverId,
    identity: await generateServerIdentity(serverId),
    rotations
  };
  const httpsUrl = "https://127.0.0.1:8788";
  const app = await createAppWithDb(db, {
    publicUrl: "http://127.0.0.1:8787",
    rateLimit,
    transportOverrideForTests,
    security: {
      runtime: {
        getIdentity: () => persisted,
        httpsUrl: () => httpsUrl
      }
    }
  });
  apps.push(app);
  return {
    app,
    db,
    repo: (app as unknown as { testRepo: RelayRepository }).testRepo,
    persisted,
    httpsUrl
  };
}

describe("relay transport security persistence", () => {
  it("enforces first-owner-wins inside the repository transaction", async () => {
    const { repo } = await createRepository();
    const first = repo.bootstrapServer({
      displayName: "First owner",
      deviceName: "First laptop",
      tokenSecurity: "tls"
    });

    expect(() =>
      repo.bootstrapServer({
        displayName: "Racing owner",
        deviceName: "Racing laptop",
        tokenSecurity: "tls"
      })
    ).toThrow("already been completed");
    expect(repo.getServerOwnerId()).toBe(first.user.id);
  });

  it("creates and can roll back an audited recovery device only for the existing server owner", async () => {
    const { db, repo } = await createRepository();
    const owner = repo.bootstrapServer({ displayName: "Owner", deviceName: "Original", tokenSecurity: "plain" });

    const recovered = repo.recoverServerOwnerDevice({ deviceName: "Recovered Mac", tokenSecurity: "tls" });

    expect(recovered).toMatchObject({
      user: owner.user,
      device: { id: expect.stringMatching(/^dev_/), displayName: "Recovered Mac" },
      isServerOwner: true
    });
    expect(recovered.device.id).not.toBe(owner.device.id);
    expect(repo.authenticateDeviceToken(owner.deviceToken)?.deviceId).toBe(owner.device.id);
    expect(repo.authenticateDeviceToken(recovered.deviceToken)).toMatchObject({
      userId: owner.user.id,
      deviceId: recovered.device.id,
      isServerOwner: true,
      tokenSecurity: "tls"
    });
    expect(db.prepare("select action from audit_events where resource_id = ?",).get(recovered.device.id)).toEqual({
      action: "owner.device_recovered"
    });

    repo.revokeRecoveredOwnerDevice(recovered.device.id);
    expect(repo.authenticateDeviceToken(recovered.deviceToken)?.deviceRevokedAt).not.toBeNull();
    expect(db.prepare("select action from audit_events where resource_id = ? and action = 'owner.device_recovery_rolled_back'").get(recovered.device.id)).toEqual({
      action: "owner.device_recovery_rolled_back"
    });
    expect(() => repo.revokeRecoveredOwnerDevice(owner.device.id)).toThrow("not a recovery device");
  });

  it("creates one stable server id and round-trips security settings", async () => {
    const { repo } = await createRepository();

    const firstServerId = repo.getOrCreateServerId();
    expect(firstServerId).toMatch(/^srv_/);
    expect(repo.getOrCreateServerId()).toBe(firstServerId);
    expect(repo.getSecurityState()).toBe("plain_legacy");
    expect(repo.getMigrationMode()).toBe("non_strict");

    repo.setSecurityState("tls_migrating");
    repo.setMigrationMode("strict");
    expect(repo.getSecurityState()).toBe("tls_migrating");
    expect(repo.getMigrationMode()).toBe("strict");
  });

  it("derives plain and TLS principals from bootstrap and join issuance", async () => {
    const plain = await createRepository();
    const plainOwner = plain.repo.bootstrapServer({
      displayName: "Plain owner",
      deviceName: "Plain laptop",
      tokenSecurity: "plain"
    });
    expect(plain.repo.authenticateDeviceToken(plainOwner.deviceToken)?.tokenSecurity).toBe("plain");

    const tls = await createRepository();
    const tlsOwner = tls.repo.bootstrapServer({
      displayName: "TLS owner",
      deviceName: "TLS laptop",
      tokenSecurity: "tls"
    });
    expect(tls.repo.authenticateDeviceToken(tlsOwner.deviceToken)?.tokenSecurity).toBe("tls");

    const plainInvite = tls.repo.createInvite({
      createdByUserId: tlsOwner.user.id,
      expiresInMinutes: 60,
      maxUses: 1
    });
    const plainJoin = tls.repo.joinInvite({
      inviteToken: plainInvite.inviteToken,
      displayName: "Plain join",
      deviceName: "Plain join laptop",
      tokenSecurity: "plain"
    });
    expect(tls.repo.authenticateDeviceToken(plainJoin.deviceToken)?.tokenSecurity).toBe("plain");

    const tlsInvite = tls.repo.createInvite({
      createdByUserId: tlsOwner.user.id,
      expiresInMinutes: 60,
      maxUses: 1
    });
    const tlsJoin = tls.repo.joinInvite({
      inviteToken: tlsInvite.inviteToken,
      displayName: "TLS join",
      deviceName: "TLS join laptop",
      tokenSecurity: "tls"
    });
    expect(tls.repo.authenticateDeviceToken(tlsJoin.deviceToken)?.tokenSecurity).toBe("tls");
  });

  it("rotates a device token to TLS and invalidates the old hash", async () => {
    const { db, repo } = await createRepository();
    const owner = repo.bootstrapServer({ displayName: "Owner", deviceName: "Laptop", tokenSecurity: "plain" });

    const rotated = repo.rotateDeviceToken(owner.device.id);

    expect(repo.authenticateDeviceToken(owner.deviceToken)).toBeNull();
    expect(repo.authenticateDeviceToken(rotated.deviceToken)?.tokenSecurity).toBe("tls");
    const audit = db
      .prepare("select metadata_json from audit_events where action = 'device.token_rotated' and resource_id = ?")
      .get(owner.device.id) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toEqual({ reason: "tls_migration" });
  });

  it("atomically accepts an invite and rotates only a plain token over HTTPS", async () => {
    const { repo } = await createRepository();
    const owner = repo.bootstrapServer({ displayName: "Owner", deviceName: "Laptop", tokenSecurity: "plain" });
    const invite = repo.createInvite({ createdByUserId: owner.user.id, expiresInMinutes: 60, maxUses: 1 });

    const accepted = repo.acceptInviteAndMaybeRotateDeviceToken({
      inviteToken: invite.inviteToken,
      userId: owner.user.id,
      deviceId: owner.device.id,
      transport: "https"
    });

    expect(accepted).toMatchObject({ inviteType: "friend", alreadyConnected: true });
    expect(accepted.deviceToken).toMatch(/^tr_dev_/);
    expect(repo.authenticateDeviceToken(owner.deviceToken)).toBeNull();
    expect(repo.authenticateDeviceToken(accepted.deviceToken!)?.tokenSecurity).toBe("tls");

    const tlsInvite = repo.createInvite({ createdByUserId: owner.user.id, expiresInMinutes: 60, maxUses: 1 });
    const alreadyTls = repo.acceptInviteAndMaybeRotateDeviceToken({
      inviteToken: tlsInvite.inviteToken,
      userId: owner.user.id,
      deviceId: owner.device.id,
      transport: "https"
    });
    expect(alreadyTls.deviceToken).toBeUndefined();
  });

  it("never rotates invite acceptance over HTTP and keeps failed acceptance unchanged", async () => {
    const { repo } = await createRepository();
    const owner = repo.bootstrapServer({ displayName: "Owner", deviceName: "Laptop", tokenSecurity: "plain" });
    const invite = repo.createInvite({ createdByUserId: owner.user.id, expiresInMinutes: 60, maxUses: 1 });

    const accepted = repo.acceptInviteAndMaybeRotateDeviceToken({
      inviteToken: invite.inviteToken,
      userId: owner.user.id,
      deviceId: owner.device.id,
      transport: "http"
    });
    expect(accepted.deviceToken).toBeUndefined();
    expect(repo.authenticateDeviceToken(owner.deviceToken)?.tokenSecurity).toBe("plain");

    expect(() =>
      repo.acceptInviteAndMaybeRotateDeviceToken({
        inviteToken: "tr_inv_invalid",
        userId: owner.user.id,
        deviceId: owner.device.id,
        transport: "https"
      })
    ).toThrow();
    expect(repo.authenticateDeviceToken(owner.deviceToken)?.tokenSecurity).toBe("plain");
  });

  it("counts only active devices last seen over HTTP", async () => {
    const { repo } = await createRepository();
    const owner = repo.bootstrapServer({ displayName: "Owner", deviceName: "Owner laptop", tokenSecurity: "plain" });
    const invite = repo.createInvite({ createdByUserId: owner.user.id, expiresInMinutes: 60, maxUses: 1 });
    const member = repo.joinInvite({
      inviteToken: invite.inviteToken,
      displayName: "Member",
      deviceName: "Member laptop",
      tokenSecurity: "tls"
    });

    repo.markDeviceTransport(owner.device.id, "http");
    repo.markDeviceTransport(member.device.id, "https");
    expect(repo.countActiveDevicesOnPlainTransport()).toBe(1);

    repo.markDeviceTransport(member.device.id, "http");
    expect(repo.countActiveDevicesOnPlainTransport()).toBe(2);

    repo.revokeDevice({ deviceId: member.device.id, actorUserId: owner.user.id });
    expect(repo.countActiveDevicesOnPlainTransport()).toBe(1);
  });
});

describe("shared REST and WebSocket transport enforcement", () => {
  it("broadcasts TLS upgrade availability only to authenticated open sockets", () => {
    const registry = new ConnectionRegistry();
    const authenticatedMessages: string[] = [];
    const unauthenticatedMessages: string[] = [];
    const socket = (messages: string[]) => ({
      OPEN: 1,
      readyState: 1,
      send: (payload: string) => messages.push(payload),
      close: () => undefined,
      ping: () => undefined
    });
    registry.add({
      id: "authenticated",
      socket: socket(authenticatedMessages),
      principal: {
        deviceId: "dev_1",
        deviceDisplayName: "Laptop",
        deviceRevokedAt: null,
        userId: "usr_1",
        userDisplayName: "Owner",
        userRevokedAt: null,
        isServerOwner: true,
        tokenSecurity: "plain"
      },
      subscriptions: new Set()
    });
    registry.add({ id: "unauthenticated", socket: socket(unauthenticatedMessages), principal: null, subscriptions: new Set() });

    registry.broadcastAuthenticated({
      type: "security_upgrade_available",
      httpsUrl: "https://relay.example",
      wssUrl: "wss://relay.example/sync"
    });

    expect(authenticatedMessages.map((payload) => JSON.parse(payload))).toEqual([
      { type: "security_upgrade_available", httpsUrl: "https://relay.example", wssUrl: "wss://relay.example/sync" }
    ]);
    expect(unauthenticatedMessages).toEqual([]);
  });

  it("serves authenticated upgrade info and blocks strict migration over HTTP", async () => {
    const { app, db, repo, persisted, httpsUrl } = await createSecurityApp([], undefined, "http");
    const owner = (await injectBootstrap(app, { displayName: "Owner", deviceName: "Laptop" })).json();

    const unauthenticated = await app.inject({ method: "GET", url: "/api/security/upgrade-info" });
    expect(unauthenticated.statusCode).toBe(401);

    const upgrade = await app.inject({
      method: "GET",
      url: "/api/security/upgrade-info",
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(upgrade.statusCode).toBe(200);
    expect(upgrade.json()).toMatchObject({
      httpsUrl,
      wssUrl: "wss://127.0.0.1:8788/sync",
      serverId: persisted.serverId,
      tlsName: persisted.identity.tlsName,
      identitySpkiSha256: persisted.identity.identitySpkiSha256,
      migrationMode: "non_strict",
      plainDeviceCount: 1
    });

    repo.setMigrationMode("strict");
    const strictUnauthenticated = await app.inject({ method: "GET", url: "/api/security/upgrade-info" });
    expect(strictUnauthenticated.statusCode).toBe(401);
    const strictHttp = await app.inject({
      method: "GET",
      url: "/api/security/upgrade-info",
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(strictHttp.statusCode).toBe(403);

    const httpsApp = await createAppWithDb(db, {
      publicUrl: "http://127.0.0.1:8787",
      ownsDb: false,
      transportOverrideForTests: "https",
      security: {
        runtime: {
          getIdentity: () => persisted,
          httpsUrl: () => httpsUrl
        }
      }
    });
    apps.push(httpsApp);
    const strictHttps = await httpsApp.inject({
      method: "GET",
      url: "/api/security/upgrade-info",
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(strictHttps.statusCode).toBe(200);
  });

  it("rotates a token over HTTPS and closes an already-authenticated socket", async () => {
    const { app, repo } = await createSecurityApp();
    const owner = (await injectBootstrap(app, { displayName: "Owner", deviceName: "Laptop" })).json();
    const socket = await connect(app);
    socket.send(
      JSON.stringify({
        type: "hello",
        requestId: "hello-owner",
        token: owner.deviceToken,
        client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "Laptop" }
      })
    );
    expect(await nextMessage(socket, "hello_ok")).toMatchObject({ requestId: "hello-owner" });
    const closed = waitForClose(socket);

    const completed = await app.inject({
      method: "POST",
      url: "/api/security/complete-tls-migration",
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().deviceToken).toMatch(/^tr_dev_/);
    await closed;

    expect(repo.authenticateDeviceToken(owner.deviceToken)).toBeNull();
    expect(repo.authenticateDeviceToken(completed.json().deviceToken)?.tokenSecurity).toBe("tls");
  });

  it("does not return a rotated credential or close its socket until the security mutation is durable", async () => {
    const { app, db } = await createSecurityApp();
    const owner = (await injectBootstrap(app, { displayName: "Owner", deviceName: "Laptop" })).json();
    const socket = await connect(app);
    socket.send(
      JSON.stringify({
        type: "hello",
        requestId: "hello-durable-owner",
        token: owner.deviceToken,
        client: { kind: "obsidian-plugin", version: "0.2.0", deviceName: "Laptop" }
      })
    );
    expect(await nextMessage(socket, "hello_ok")).toMatchObject({ requestId: "hello-durable-owner" });

    let releaseDurableWrite!: () => void;
    const durableWrite = new Promise<void>((resolve) => {
      releaseDurableWrite = resolve;
    });
    const originalDurable = db.durable.bind(db);
    const durable = vi.spyOn(db, "durable").mockImplementation(async (operation) => {
      const result = await originalDurable(operation);
      await durableWrite;
      return result;
    });
    let settled = false;
    const request = app
      .inject({
        method: "POST",
        url: "/api/security/complete-tls-migration",
        headers: { authorization: `Bearer ${owner.deviceToken}` }
      })
      .finally(() => {
        settled = true;
      });

    await vi.waitFor(() => expect(durable).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(socket.readyState).toBe(WebSocket.OPEN);

    releaseDurableWrite();
    const response = await request;
    expect(response.statusCode).toBe(200);
    await waitForClose(socket);
    durable.mockRestore();
  });

  it("rejects a legacy token through the same helper for REST and WSS once TLS is enforced", async () => {
    const { app, repo } = await createSecurityApp();
    const owner = repo.bootstrapServer({ displayName: "Owner", deviceName: "Laptop", tokenSecurity: "plain" });
    repo.setSecurityState("tls_enforced");

    const rest = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(rest.statusCode).toBe(426);

    const socket = await connect(app);
    socket.send(
      JSON.stringify({
        type: "hello",
        requestId: "legacy-hello",
        token: owner.deviceToken,
        client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "Laptop" }
      })
    );
    expect(await nextMessage(socket, "hello_error")).toMatchObject({ requestId: "legacy-hello", code: "UNAUTHORIZED" });
    await waitForClose(socket);
  });

  it("issues TLS tokens for HTTPS join and rotates plain invite acceptance", async () => {
    const { app, repo } = await createSecurityApp();
    const owner = (await injectBootstrap(app, { displayName: "Owner", deviceName: "Laptop" })).json();
    const friendInvite = repo.createInvite({ createdByUserId: owner.user.id, expiresInMinutes: 60, maxUses: 1 });
    const joined = await app.inject({
      method: "POST",
      url: "/api/join",
      payload: { inviteToken: friendInvite.inviteToken, displayName: "TLS member", deviceName: "TLS laptop" }
    });
    expect(repo.authenticateDeviceToken(joined.json().deviceToken)?.tokenSecurity).toBe("tls");

    const plainInvite = repo.createInvite({ createdByUserId: owner.user.id, expiresInMinutes: 60, maxUses: 1 });
    const plainMember = repo.joinInvite({
      inviteToken: plainInvite.inviteToken,
      displayName: "Plain member",
      deviceName: "Plain laptop",
      tokenSecurity: "plain"
    });
    const acceptInvite = repo.createInvite({ createdByUserId: owner.user.id, expiresInMinutes: 60, maxUses: 1 });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/invites/accept",
      headers: { authorization: `Bearer ${plainMember.deviceToken}` },
      payload: { inviteToken: acceptInvite.inviteToken }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().deviceToken).toMatch(/^tr_dev_/);
    expect(repo.authenticateDeviceToken(plainMember.deviceToken)).toBeNull();
  });

  it("accepts strict migration with an invite-bound proof and no bearer credential", async () => {
    const { app, repo, persisted } = await createSecurityApp();
    const owner = repo.bootstrapServer({ displayName: "Owner", deviceName: "Laptop", tokenSecurity: "plain" });
    repo.setSecurityState("tls_migrating");
    repo.setMigrationMode("strict");
    const invite = repo.createInvite({ createdByUserId: owner.user.id, expiresInMinutes: 60, maxUses: 1 });
    const binding = {
      deviceId: owner.device.id,
      serverId: persisted.serverId,
      inviteToken: invite.inviteToken,
      identitySpkiSha256: persisted.identity.identitySpkiSha256
    };

    const accepted = await app.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: {
        inviteToken: invite.inviteToken,
        deviceId: owner.device.id,
        deviceProof: createInviteAcceptanceProof(owner.deviceToken, binding)
      }
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().deviceToken).toMatch(/^tr_dev_/);
    expect(repo.authenticateDeviceToken(owner.deviceToken)).toBeNull();
    expect(repo.authenticateDeviceToken(accepted.json().deviceToken)?.tokenSecurity).toBe("tls");
  });

  it("rejects a strict proof copied from another pinned identity without consuming the invite", async () => {
    const { app, repo, persisted } = await createSecurityApp();
    const owner = repo.bootstrapServer({ displayName: "Owner", deviceName: "Laptop", tokenSecurity: "plain" });
    repo.setSecurityState("tls_migrating");
    repo.setMigrationMode("strict");
    const invite = repo.createInvite({ createdByUserId: owner.user.id, expiresInMinutes: 60, maxUses: 1 });
    const attackerBoundProof = createInviteAcceptanceProof(owner.deviceToken, {
      deviceId: owner.device.id,
      serverId: persisted.serverId,
      inviteToken: invite.inviteToken,
      identitySpkiSha256: "sha256:attacker-identity"
    });

    const rejected = await app.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: { inviteToken: invite.inviteToken, deviceId: owner.device.id, deviceProof: attackerBoundProof }
    });

    expect(rejected.statusCode).toBe(401);
    expect(repo.authenticateDeviceToken(owner.deviceToken)).not.toBeNull();
    const accepted = await app.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: {
        inviteToken: invite.inviteToken,
        deviceId: owner.device.id,
        deviceProof: createInviteAcceptanceProof(owner.deviceToken, {
          deviceId: owner.device.id,
          serverId: persisted.serverId,
          inviteToken: invite.inviteToken,
          identitySpkiSha256: persisted.identity.identitySpkiSha256
        })
      }
    });
    expect(accepted.statusCode).toBe(200);
  });

  it("does not enable proof authentication outside strict TLS migration", async () => {
    const { app, repo, persisted } = await createSecurityApp();
    const owner = (await injectBootstrap(app, { displayName: "Owner", deviceName: "Laptop" })).json();
    repo.setSecurityState("tls_migrating");
    repo.setMigrationMode("non_strict");
    const invite = repo.createInvite({ createdByUserId: owner.user.id, expiresInMinutes: 60, maxUses: 1 });

    const rejected = await app.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: {
        inviteToken: invite.inviteToken,
        deviceId: owner.device.id,
        deviceProof: createInviteAcceptanceProof(owner.deviceToken, {
          deviceId: owner.device.id,
          serverId: persisted.serverId,
          inviteToken: invite.inviteToken,
          identitySpkiSha256: persisted.identity.identitySpkiSha256
        })
      }
    });

    expect(rejected.statusCode).toBe(401);
    expect(repo.authenticateDeviceToken(owner.deviceToken)).not.toBeNull();
  });

  it("keeps identity rotations credentialless", async () => {
    const { app, persisted } = await createSecurityApp();
    const response = await app.inject({ method: "GET", url: "/api/identity/rotations" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ serverId: persisted.serverId, rotations: [] });
  });

  it("rate limits public rotation probes before writing their audit event", async () => {
    const { app, db } = await createSecurityApp([], { rotationProbeMax: 2, rotationProbeWindowMs: 60_000 });

    expect((await app.inject({ method: "GET", url: "/api/identity/rotations" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/identity/rotations" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/identity/rotations" })).statusCode).toBe(429);

    const audit = db.prepare("select count(*) as count from audit_events where action = 'identity.rotations_served'").get() as {
      count: number;
    };
    expect(audit.count).toBe(2);
  });

  it("ignores x-test-transport even in the test environment", async () => {
    const { app, repo } = await createSecurityApp([], undefined, "http");
    repo.setSecurityState("tls_enforced");
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-test-transport": "https" }
    });
    expect(response.statusCode).toBe(426);
  });
});

describe("standalone TLS listener", () => {
  it("serves a full pinned chain and rejects the wrong CA before HTTP bytes arrive", async () => {
    const db = await openRelayDb(":memory:");
    databases.push(db);
    const identity = await generateServerIdentity("srv_tls_socket");
    const app = await createAppWithDb(db, {
      https: { key: identity.leafKeyPem, cert: tlsCertificateChainPem(identity) }
    });
    apps.push(app);
    let requestCount = 0;
    app.addHook("onRequest", (_request, _reply, done) => {
      requestCount += 1;
      done();
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    await expect(
      pinnedHttpsGet(port, identity.tlsName, "not the identity certificate")
    ).rejects.toThrow();
    expect(requestCount).toBe(0);

    const response = await pinnedHttpsGet(port, identity.tlsName, identity.identityCertPem);
    expect(response.status).toBe(200);
    expect(requestCount).toBe(1);
    expect(response.peer.issuerCertificate).toBeDefined();
    expect(
      spkiSha256FromCertDer(response.peer.issuerCertificate!.raw.toString("base64url"))
    ).toBe(identity.identitySpkiSha256);
  });
});

const queues = new WeakMap<WebSocket, unknown[]>();
const waiters = new WeakMap<WebSocket, Array<() => void>>();
const closedSockets = new WeakSet<WebSocket>();

async function connect(
  app: Awaited<ReturnType<typeof createAppWithDb>>,
  headers: Record<string, string> = {}
): Promise<WebSocket> {
  await app.ready();
  const socket = (await app.injectWS("/sync", { headers })) as unknown as WebSocket;
  sockets.push(socket);
  queues.set(socket, []);
  waiters.set(socket, []);
  socket.on("message", (raw) => {
    queues.get(socket)!.push(JSON.parse(raw.toString()));
    for (const wake of waiters.get(socket)!.splice(0)) wake();
  });
  socket.on("close", () => {
    closedSockets.add(socket);
    for (const wake of waiters.get(socket)!.splice(0)) wake();
  });
  return socket;
}

async function nextMessage(socket: WebSocket, type: string): Promise<any> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const queue = queues.get(socket)!;
    const index = queue.findIndex((message) => (message as { type?: string }).type === type);
    if (index >= 0) return queue.splice(index, 1)[0];
    await new Promise<void>((resolve) => {
      waiters.get(socket)!.push(resolve);
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`Timed out waiting for ${type}`);
}

async function waitForClose(socket: WebSocket): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (closedSockets.has(socket) || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      waiters.get(socket)!.push(resolve);
      setTimeout(resolve, 20);
    });
  }
  throw new Error("Timed out waiting for socket close");
}

async function pinnedHttpsGet(
  port: number,
  servername: string,
  ca: string
): Promise<{ status: number; peer: DetailedPeerCertificate }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
        ca,
        servername,
        rejectUnauthorized: true
      },
      (response) => {
        const peer = (response.socket as TLSSocket).getPeerCertificate(true);
        response.resume();
        response.once("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            peer
          });
        });
      }
    );
    request.once("error", reject);
    request.end();
  });
}
