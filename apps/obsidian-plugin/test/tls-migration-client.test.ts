import { request as httpsRequest } from "node:https";
import type { Server as NetServer } from "node:net";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { DetailedPeerCertificate, TLSSocket } from "node:tls";
import type { DataAdapter } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import initSqlJs from "sql.js/dist/sql-wasm-browser.js";
import {
  certDerBase64UrlToPem,
  certPemToDerBase64Url,
  createRelayCore,
  generateServerIdentity,
  spkiSha256FromCertDer,
  tlsCertificateChainPem,
  type IdentityStore
} from "vault-rooms-relay/embedded-core";
import { openRelayDb } from "../../relay-server/src/db/db.js";
import { LEGACY_V01_DATA, LEGACY_V01_SCHEMA } from "../../relay-server/test/fixtures/legacyV01.js";
import { createEmbeddedRelayApp, type EmbeddedRelayApp } from "../src/embeddedRelayApp.js";
import { openObsidianSqlJsDb } from "../src/obsidianSqlJsDb.js";
import { EmbeddedRelayServer } from "../src/serverManager.js";
import { migrateServerConnectionSettings, type EmbeddedServerSettings } from "../src/settings.js";
import { RelayApiClient } from "../src/apiClient.js";
import { ServerConnectionManager } from "../src/controllers/ServerConnectionManager.js";
import { openSyncSocket } from "../src/syncWsClient.js";
import type { ServerConnection, VaultRoomsSettings } from "../src/settings.js";
import sqlWasmBinary from "sql.js/dist/sql-wasm-browser.wasm";

vi.mock("sql.js/dist/sql-wasm-browser.wasm", async () => {
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const bytes = readFileSync(createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm-browser.wasm"));
  return { default: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
});

(globalThis as unknown as { window: typeof globalThis }).window ??= globalThis;

const apps: EmbeddedRelayApp[] = [];
const embeddedServers: EmbeddedRelayServer[] = [];
const blockers: NetServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const server of embeddedServers.splice(0)) {
    await server.stop();
  }
  for (const blocker of blockers.splice(0)) {
    await closeNetServer(blocker);
  }
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
});

describe("embedded TLS listeners", () => {
  it("serves HTTP and pinned HTTPS with the full identity chain", async () => {
    const { app, identity, httpPort, tlsPort } = await startDualStackEmbeddedApp();

    expect((await fetch(`http://127.0.0.1:${httpPort}/health`)).status).toBe(200);
    const pinned = await pinnedGet(tlsPort, identity.tlsName, identity.identityCertPem);
    expect(pinned.status).toBe(200);
    expect(
      spkiSha256FromCertDer(pinned.peer.issuerCertificate.raw.toString("base64url"))
    ).toBe(identity.identitySpkiSha256);
    await expect(pinnedGet(tlsPort, identity.tlsName, "wrong ca")).rejects.toThrow();
  });

  it("closes only the plain listener and keeps pinned HTTPS alive", async () => {
    const { app, identity, httpPort, tlsPort } = await startDualStackEmbeddedApp();

    await app.closePlainListener();

    await expect(fetch(`http://127.0.0.1:${httpPort}/health`)).rejects.toThrow();
    expect((await pinnedGet(tlsPort, identity.tlsName, identity.identityCertPem)).status).toBe(200);
  });

  it("restarts only TLS with a rotated identity", async () => {
    const { app, identity, serverId, httpPort, tlsPort } = await startDualStackEmbeddedApp();
    const rotated = await generateServerIdentity(serverId);

    await app.restartTls({
      host: "127.0.0.1",
      port: tlsPort,
      key: rotated.leafKeyPem,
      cert: tlsCertificateChainPem(rotated)
    });

    expect((await fetch(`http://127.0.0.1:${httpPort}/health`)).status).toBe(200);
    await expect(pinnedGet(tlsPort, identity.tlsName, identity.identityCertPem)).rejects.toThrow();
    expect((await pinnedGet(tlsPort, rotated.tlsName, rotated.identityCertPem)).status).toBe(200);
  });

  it("rejects plaintext WebSocket upgrades immediately once TLS is enforced", async () => {
    const { repo, httpPort } = await startDualStackEmbeddedApp();
    repo.setSecurityState("tls_enforced");

    await expectWebSocketRejected(`ws://127.0.0.1:${httpPort}/sync`);
  });
});

describe("embedded TLS startup state", () => {
  it("keeps the stored identity serverId when automatic v0.1 recovery replaces an empty database", async () => {
    const adapter = new FakeDataAdapter();
    const dbPath = "plugins/vault-rooms/server-data/relay.sqlite";
    const stableServerId = "srv_recovered_identity";
    const identity = await generateServerIdentity(stableServerId);
    const empty = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
    const emptyCore = createRelayCore(empty);
    emptyCore.repo.setServerIdIfMissing(stableServerId);
    await empty.close();
    await adapter.write(
      "plugins/vault-rooms/server-data/identity.json",
      `${JSON.stringify({ serverId: stableServerId, identity, rotations: [] })}\n`
    );

    const SQL = await initSqlJs({ wasmBinary: toArrayBuffer(sqlWasmBinary) });
    const legacy = new SQL.Database();
    legacy.exec(`${LEGACY_V01_SCHEMA}${LEGACY_V01_DATA}`);
    const legacyExport = legacy.export();
    legacy.close();
    await adapter.writeBinary(`${dbPath}.bak-v1`, toArrayBuffer(legacyExport));

    const settings: EmbeddedServerSettings = {
      port: await findAvailablePortBlock(),
      maxFileBytes: 1024,
      autoStart: false
    };
    const server = new EmbeddedRelayServer(asDataAdapter(adapter), dbPath);
    embeddedServers.push(server);
    const recovered = await server.start(settings);
    expect(recovered).toMatchObject({ running: true, serverId: stableServerId, bootstrapped: true });

    const migrating = await server.enableTlsMigration("non_strict");
    expect(migrating).toMatchObject({
      running: true,
      serverId: stableServerId,
      securityMode: "pinned-tls",
      pinnedInfo: { pinnedIdentitySpkiSha256: identity.identitySpkiSha256 }
    });
  });

  it("explicitly restores a non-empty reset database from v0.1 without losing either file", async () => {
    const adapter = new FakeDataAdapter();
    const dbPath = "plugins/vault-rooms/server-data/relay.sqlite";
    const port = await getFreePort();
    const active = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
    createRelayCore(active).repo.bootstrapServer({ displayName: "Replacement owner", deviceName: "Replacement Mac", tokenSecurity: "plain" });
    await active.close();

    const SQL = await initSqlJs({ wasmBinary: toArrayBuffer(sqlWasmBinary) });
    const legacy = new SQL.Database();
    legacy.exec(`${LEGACY_V01_SCHEMA}${LEGACY_V01_DATA}`);
    const legacyExport = legacy.export();
    legacy.close();
    await adapter.writeBinary(`${dbPath}.bak-v1`, toArrayBuffer(legacyExport));

    const server = new EmbeddedRelayServer(asDataAdapter(adapter), dbPath);
    embeddedServers.push(server);
    const before = await server.start({ port, maxFileBytes: 1024, autoStart: false });
    expect(before).toMatchObject({ running: true, bootstrapped: true, legacyV01BackupAvailable: true });
    if (!before.running) throw new Error("Expected reset database server");

    const restored = await server.restoreLegacyV01Backup();
    expect(restored).toMatchObject({
      running: true,
      bootstrapped: true,
      legacyV01BackupAvailable: false,
      serverId: before.serverId
    });
    expect(adapter.store.has(`${dbPath}.pre-v01-restore`)).toBe(true);
    expect(adapter.store.has(`${dbPath}.bak-v1`)).toBe(true);

    const recovered = await server.recoverOwnerDevice("Recovered legacy Mac");
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/api/me`, {
          headers: { authorization: `Bearer ${recovered.deviceToken}` }
        })
      ).status
    ).toBe(200);
    await server.stop();
    const migrated = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
    const migratedCore = createRelayCore(migrated);
    expect(migratedCore.repo.getServerOwnerId()).toBe("usr_owner");
    expect(migrated.prepare("select count(*) as count from files").get()).toEqual({ count: 1 });
    expect(migrated.prepare("select value from server_meta where key = 'legacy_v01_migrated'").get()).toEqual({ value: "1" });
    await migrated.close();
  });

  it("recovers an erased local owner credential through the running process without reopening bootstrap", async () => {
    const adapter = new FakeDataAdapter();
    const dbPath = "plugins/vault-rooms/server-data/relay.sqlite";
    const port = await getFreePort();
    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
    const core = createRelayCore(db);
    const original = core.repo.bootstrapServer({ displayName: "Owner", deviceName: "Original Mac", tokenSecurity: "plain" });
    await db.close();

    const server = new EmbeddedRelayServer(asDataAdapter(adapter), dbPath);
    embeddedServers.push(server);
    const status = await server.start({ port, maxFileBytes: 1024, autoStart: false });
    expect(status).toMatchObject({ running: true, bootstrapped: true, securityMode: "plain" });

    const recovered = await server.recoverOwnerDevice("Recovered Mac");
    expect(recovered).toMatchObject({
      user: original.user,
      device: { displayName: "Recovered Mac" },
      isServerOwner: true
    });
    expect(recovered.device.id).not.toBe(original.device.id);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/api/me`, {
          headers: { authorization: `Bearer ${recovered.deviceToken}` }
        })
      ).status
    ).toBe(200);

    await server.stop();
    await server.start({ port, maxFileBytes: 1024, autoStart: false });
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/api/me`, {
          headers: { authorization: `Bearer ${recovered.deviceToken}` }
        })
      ).status
    ).toBe(200);

    await server.revokeRecoveredOwnerDevice(recovered.device.id);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/api/me`, {
          headers: { authorization: `Bearer ${recovered.deviceToken}` }
        })
      ).status
    ).toBe(401);
  });

  it("derives a recovered owner's token security from the pinned listener", async () => {
    const adapter = new FakeDataAdapter();
    const dbPath = "plugins/vault-rooms/server-data/relay.sqlite";
    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
    const core = createRelayCore(db);
    core.repo.bootstrapServer({ displayName: "Owner", deviceName: "Original Mac", tokenSecurity: "plain" });
    core.repo.setSecurityState("pinned_tls");
    await db.close();

    const server = new EmbeddedRelayServer(asDataAdapter(adapter), dbPath);
    embeddedServers.push(server);
    const status = await server.start({ port: await getFreePort(), maxFileBytes: 1024, autoStart: false });
    expect(status).toMatchObject({ running: true, bootstrapped: true, securityMode: "pinned-tls" });
    const recovered = await server.recoverOwnerDevice("Recovered pinned Mac");
    await server.stop();

    const reopened = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
    expect(createRelayCore(reopened).repo.authenticateDeviceToken(recovered.deviceToken)?.tokenSecurity).toBe("tls");
    await reopened.close();
  });

  it("starts tls_migrating dual-stack, falls back from an occupied TLS port, and persists identity", async () => {
    const adapter = new FakeDataAdapter();
    const dbPath = "plugins/vault-rooms/server-data/relay.sqlite";
    const httpPort = await findAvailablePortBlock();
    const preferredTlsPort = httpPort + 1;
    const blocker = createServer();
    blockers.push(blocker);
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(preferredTlsPort, "0.0.0.0", resolve);
    });
    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
    const core = createRelayCore(db);
    core.repo.setSecurityState("tls_migrating");
    await db.close();

    const settings: EmbeddedServerSettings = { port: httpPort, tlsPort: preferredTlsPort, maxFileBytes: 1024, autoStart: false };
    const server = new EmbeddedRelayServer(asDataAdapter(adapter), dbPath);
    embeddedServers.push(server);
    const first = await server.start(settings);
    expect(first.running).toBe(true);
    if (!first.running) throw new Error("Expected the embedded server to run");
    expect(settings.tlsPort).toBe(httpPort + 2);
    expect(first.securityMode).toBe("pinned-tls");
    expect(first.pinnedInfo).toBeDefined();
    expect((await fetch(`http://127.0.0.1:${httpPort}/health`)).status).toBe(200);
    expect(
      (
        await pinnedGet(
          settings.tlsPort!,
          first.pinnedInfo!.tlsName,
          certDerBase64UrlToPem(first.pinnedInfo!.identityCertificateDer)
        )
      ).status
    ).toBe(200);
    const firstFingerprint = first.pinnedInfo!.pinnedIdentitySpkiSha256;

    await server.stop();
    const restarted = await server.start(settings);
    expect(restarted.running).toBe(true);
    if (!restarted.running) throw new Error("Expected the embedded server to restart");
    expect(restarted.pinnedInfo?.pinnedIdentitySpkiSha256).toBe(firstFingerprint);
  });

  it("starts a fresh database HTTPS-only, bootstraps through its same-process pin, and preserves the fingerprint", async () => {
    const adapter = new FakeDataAdapter();
    // Fresh pinned startup derives its preferred TLS port as port + 1. Reserving only one random
    // free port lets another parallel test claim the adjacent port between probe and bind.
    const httpPort = await findAvailablePortBlock();
    const settings: EmbeddedServerSettings = { port: httpPort, maxFileBytes: 1024, autoStart: false };
    const server = new EmbeddedRelayServer(asDataAdapter(adapter), "plugins/vault-rooms/server-data/relay.sqlite");
    embeddedServers.push(server);

    const status = await server.start(settings);
    expect(status.running).toBe(true);
    if (!status.running) throw new Error("Expected the embedded server to run");
    expect(status.securityMode).toBe("pinned-tls");
    expect(status.pinnedInfo).toBeDefined();
    expect(status.localUrl).toBe(`https://127.0.0.1:${settings.tlsPort}`);
    await expect(fetch(`http://127.0.0.1:${httpPort}/health`)).rejects.toThrow();
    const bootstrapPin = server.getBootstrapPin();
    expect(bootstrapPin).toBeTruthy();
    const api = new RelayApiClient(status.localUrl, undefined, undefined, status.pinnedInfo);
    const owner = await api.bootstrapServer({ displayName: "Owner", deviceName: "Owner laptop", pin: bootstrapPin! });
    await expect(new RelayApiClient(status.localUrl, owner.deviceToken, undefined, status.pinnedInfo).me()).resolves.toMatchObject({
      device: { id: owner.device.id },
      isServerOwner: true
    });
    const fingerprint = status.pinnedInfo!.pinnedIdentitySpkiSha256;

    await server.stop();
    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), "plugins/vault-rooms/server-data/relay.sqlite", {
      wasmBinary: toArrayBuffer(sqlWasmBinary)
    });
    expect(db.prepare("select token_security from devices where id = ?").get(owner.device.id)).toEqual({ token_security: "tls" });
    await db.close();
    const restarted = await server.start(settings);
    expect(restarted.running).toBe(true);
    if (!restarted.running) throw new Error("Expected the embedded server to restart");
    expect(restarted.pinnedInfo?.pinnedIdentitySpkiSha256).toBe(fingerprint);
  });
});

describe("same-process embedded TLS ownership lifecycle", () => {
  it("rolls back the newly-opened TLS listener and settings when migration state persistence fails", async () => {
    const adapter = new FakeDataAdapter();
    const dbPath = "plugins/vault-rooms/server-data/relay.sqlite";
    const httpPort = await findAvailablePortBlock();
    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
    createRelayCore(db).repo.bootstrapServer({ displayName: "Owner", deviceName: "Owner laptop", tokenSecurity: "plain" });
    await db.close();
    const settings: EmbeddedServerSettings = { port: httpPort, maxFileBytes: 1024, autoStart: false };
    const server = new EmbeddedRelayServer(asDataAdapter(adapter), dbPath);
    embeddedServers.push(server);
    await server.start(settings);
    const runningApp = (server as unknown as { app: EmbeddedRelayApp }).app;
    const persist = vi.spyOn(runningApp.securityAdmin, "enableTlsMigration").mockImplementationOnce(() => {
      throw new Error("migration persistence failed");
    });

    await expect(server.enableTlsMigration("non_strict")).rejects.toThrow("migration persistence failed");

    expect(settings.tlsPort).toBeUndefined();
    expect(await isPortFree(httpPort + 1)).toBe(true);
    expect(server.getStatus()).toMatchObject({ running: true, securityMode: "plain", securityState: "plain_legacy" });
    expect((await fetch(`http://127.0.0.1:${httpPort}/health`)).status).toBe(200);
    persist.mockRestore();

    const retried = await server.enableTlsMigration("non_strict");
    expect(retried.running && retried.securityState).toBe("tls_migrating");
  });

  it("migrates without dropping legacy sockets, enforces by disabling HTTP, and rotates the TLS identity", async () => {
    const adapter = new FakeDataAdapter();
    const dbPath = "plugins/vault-rooms/server-data/relay.sqlite";
    const httpPort = await findAvailablePortBlock();
    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
    const core = createRelayCore(db);
    const owner = core.repo.bootstrapServer({ displayName: "Owner", deviceName: "Owner laptop", tokenSecurity: "plain" });
    await db.close();
    const settings: EmbeddedServerSettings = { port: httpPort, maxFileBytes: 1024, autoStart: false };
    const server = new EmbeddedRelayServer(asDataAdapter(adapter), dbPath);
    embeddedServers.push(server);
    const initial = await server.start(settings);
    expect(initial.running && initial.securityMode).toBe("plain");

    const socket = new WebSocket(`ws://127.0.0.1:${httpPort}/sync`);
    sockets.push(socket);
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        type: "hello",
        requestId: "hello-owner",
        token: owner.deviceToken,
        client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "Owner laptop" }
      })
    );
    expect(await nextSocketMessage(socket)).toMatchObject({ type: "hello_ok" });

    const upgradeAvailable = nextSocketMessage(socket);
    await server.enableTlsMigration("non_strict");
    expect(await upgradeAvailable).toMatchObject({ type: "security_upgrade_available" });
    const migrating = server.getStatus();
    expect(migrating.running).toBe(true);
    if (!migrating.running) throw new Error("Expected migrating server to run");
    expect(migrating.securityState).toBe("tls_migrating");
    expect(migrating.plainDeviceCount).toBe(1);
    expect((await fetch(`http://127.0.0.1:${httpPort}/health`)).status).toBe(200);
    expect(
      (
        await pinnedGet(
          settings.tlsPort!,
          migrating.pinnedInfo!.tlsName,
          certDerBase64UrlToPem(migrating.pinnedInfo!.identityCertificateDer)
        )
      ).status
    ).toBe(200);
    const oldPin = migrating.pinnedInfo!.pinnedIdentitySpkiSha256;
    const oldCa = certDerBase64UrlToPem(migrating.pinnedInfo!.identityCertificateDer);
    const legacyTlsOptions: WebSocket.ClientOptions & { servername: string } = {
      ca: oldCa,
      servername: migrating.pinnedInfo!.tlsName,
      rejectUnauthorized: true
    };
    const legacyTlsSocket = new WebSocket(`wss://127.0.0.1:${settings.tlsPort}/sync`, legacyTlsOptions);
    sockets.push(legacyTlsSocket);
    await once(legacyTlsSocket, "open");
    legacyTlsSocket.send(
      JSON.stringify({
        type: "hello",
        requestId: "hello-owner-over-tls-before-enforcement",
        token: owner.deviceToken,
        client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "Owner laptop" }
      })
    );
    expect(await nextSocketMessage(legacyTlsSocket)).toMatchObject({ type: "hello_ok" });
    const plainSocketClosed = once(socket, "close");
    const legacyTlsSocketClosed = once(legacyTlsSocket, "close");

    await server.enforceTls();
    await Promise.all([plainSocketClosed, legacyTlsSocketClosed]);
    await expect(fetch(`http://127.0.0.1:${httpPort}/health`)).rejects.toThrow();
    const enforced = server.getStatus();
    expect(enforced.running && enforced.securityState).toBe("tls_enforced");

    await server.rotateIdentity();
    const rotated = server.getStatus();
    expect(rotated.running).toBe(true);
    if (!rotated.running) throw new Error("Expected rotated server to run");
    expect(rotated.pinnedInfo!.pinnedIdentitySpkiSha256).not.toBe(oldPin);
    await expect(pinnedGet(settings.tlsPort!, migrating.pinnedInfo!.tlsName, oldCa)).rejects.toThrow();
    expect(
      (
        await pinnedGet(
          settings.tlsPort!,
          rotated.pinnedInfo!.tlsName,
          certDerBase64UrlToPem(rotated.pinnedInfo!.identityCertificateDer)
        )
      ).status
    ).toBe(200);

    await server.stop();
    const reopened = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
    expect(createRelayCore(reopened).repo.getSecurityState()).toBe("tls_enforced");
    const actions = reopened.prepare("select action from audit_events order by created_at asc").all() as Array<{ action: string }>;
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining(["security.migration_enabled", "security.tls_enforced", "identity.rotated"])
    );
    await reopened.close();
  });

  it("stops honestly if enforcement commits but the legacy listener cannot be closed", async () => {
    const adapter = new FakeDataAdapter();
    const dbPath = "plugins/vault-rooms/server-data/relay.sqlite";
    const httpPort = await findAvailablePortBlock();
    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
    createRelayCore(db).repo.bootstrapServer({ displayName: "Owner", deviceName: "Owner laptop", tokenSecurity: "plain" });
    await db.close();
    const settings: EmbeddedServerSettings = { port: httpPort, maxFileBytes: 1024, autoStart: false };
    const server = new EmbeddedRelayServer(asDataAdapter(adapter), dbPath);
    embeddedServers.push(server);
    await server.start(settings);
    const migrating = await server.enableTlsMigration("non_strict");
    if (!migrating.running || !settings.tlsPort) throw new Error("Expected migrating embedded server");
    const runningApp = (server as unknown as { app: EmbeddedRelayApp }).app;
    vi.spyOn(runningApp, "closePlainListener").mockRejectedValueOnce(new Error("legacy close failed"));

    await expect(server.enforceTls()).rejects.toThrow("legacy listener shutdown failed");

    expect(server.getStatus()).toEqual({
      running: false,
      error: "TLS enforcement listener shutdown failed; embedded relay stopped."
    });
    await expect(fetch(`http://127.0.0.1:${httpPort}/health`)).rejects.toThrow();
    await expect(
      pinnedGet(
        settings.tlsPort,
        migrating.pinnedInfo!.tlsName,
        certDerBase64UrlToPem(migrating.pinnedInfo!.identityCertificateDer)
      )
    ).rejects.toThrow();
  });

  it("rolls back persisted identity state and audit when TLS listener replacement fails", async () => {
    const adapter = new FakeDataAdapter();
    const dbPath = "plugins/vault-rooms/server-data/relay.sqlite";
    const settings: EmbeddedServerSettings = { port: await getFreePort(), maxFileBytes: 1024, autoStart: false };
    const server = new EmbeddedRelayServer(asDataAdapter(adapter), dbPath);
    embeddedServers.push(server);
    const initial = await server.start(settings);
    if (!initial.running || !initial.pinnedInfo) throw new Error("Expected pinned embedded server");
    const initialPin = initial.pinnedInfo.pinnedIdentitySpkiSha256;
    const runningApp = (server as unknown as { app: EmbeddedRelayApp }).app;
    const restart = vi.spyOn(runningApp, "restartTls").mockRejectedValueOnce(new Error("replacement bind failed"));

    await expect(server.rotateIdentity()).rejects.toThrow("replacement bind failed");
    restart.mockRestore();
    await server.stop();

    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
    const rotationAudits = db.prepare("select count(*) as count from audit_events where action = 'identity.rotated'").get() as { count: number };
    expect(rotationAudits.count).toBe(0);
    await db.close();

    const restarted = await server.start(settings);
    expect(restarted.running && restarted.pinnedInfo?.pinnedIdentitySpkiSha256).toBe(initialPin);
  });

  it("publishes the rotated runtime identity before audit and restores every identity surface if audit fails", async () => {
    const adapter = new FakeDataAdapter();
    const dbPath = "plugins/vault-rooms/server-data/relay.sqlite";
    const settings: EmbeddedServerSettings = { port: await getFreePort(), maxFileBytes: 1024, autoStart: false };
    const server = new EmbeddedRelayServer(asDataAdapter(adapter), dbPath);
    embeddedServers.push(server);
    const initial = await server.start(settings);
    if (!initial.running || !initial.pinnedInfo || !settings.tlsPort) throw new Error("Expected pinned embedded server");
    const runningApp = (server as unknown as { app: EmbeddedRelayApp }).app;
    const store = (server as unknown as { identityStore: IdentityStore }).identityStore;
    const runtime = (server as unknown as {
      securityRuntimeState: { persisted: NonNullable<Awaited<ReturnType<IdentityStore["load"]>>> };
    }).securityRuntimeState;
    const previous = await store.load();
    if (!previous) throw new Error("Expected persisted embedded identity");
    let rejectAudit!: (error: Error) => void;
    const auditFailure = new Promise<void>((_resolve, reject) => {
      rejectAudit = reject;
    });
    const recordAudit = vi
      .spyOn(runningApp.securityAdmin, "recordIdentityRotation")
      .mockImplementationOnce(() => auditFailure);

    const rotation = server.rotateIdentity();
    await vi.waitFor(() => expect(recordAudit).toHaveBeenCalledTimes(1));

    let duringRotationError: unknown;
    const rotated = runtime.persisted;
    try {
      expect(rotated.identity.identitySpkiSha256).not.toBe(previous.identity.identitySpkiSha256);
      expect(
        (
          await pinnedGet(
            settings.tlsPort,
            rotated.identity.tlsName,
            rotated.identity.identityCertPem
          )
        ).status
      ).toBe(200);
    } catch (error) {
      duringRotationError = error;
    }

    rejectAudit(new Error("rotation audit failed"));
    await expect(rotation).rejects.toThrow("rotation audit failed");
    if (duringRotationError) throw duringRotationError;

    const restored = await store.load();
    expect(restored?.identity.identitySpkiSha256).toBe(previous.identity.identitySpkiSha256);
    expect(runtime.persisted.identity.identitySpkiSha256).toBe(previous.identity.identitySpkiSha256);
    expect(
      (
        await pinnedGet(
          settings.tlsPort,
          previous.identity.tlsName,
          previous.identity.identityCertPem
        )
      ).status
    ).toBe(200);
    await expect(
      pinnedGet(
        settings.tlsPort,
        rotated.identity.tlsName,
        rotated.identity.identityCertPem
      )
    ).rejects.toThrow();
  });

  it("stops honestly when replacement closes the old listener and durable rollback then fails", async () => {
    const adapter = new FakeDataAdapter();
    const dbPath = "plugins/vault-rooms/server-data/relay.sqlite";
    const settings: EmbeddedServerSettings = { port: await getFreePort(), maxFileBytes: 1024, autoStart: false };
    const server = new EmbeddedRelayServer(asDataAdapter(adapter), dbPath);
    embeddedServers.push(server);
    const initial = await server.start(settings);
    if (!initial.running || !initial.pinnedInfo || !settings.tlsPort) throw new Error("Expected pinned embedded server");
    const initialPin = initial.pinnedInfo.pinnedIdentitySpkiSha256;
    const runningApp = (server as unknown as { app: EmbeddedRelayApp }).app;
    const store = (server as unknown as { identityStore: IdentityStore }).identityStore;
    const originalRestart = runningApp.restartTls.bind(runningApp);
    const blockedPort = await getFreePort();
    const blocker = createServer();
    blockers.push(blocker);
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(blockedPort, "0.0.0.0", resolve);
    });
    vi.spyOn(runningApp, "restartTls").mockImplementationOnce((options) =>
      originalRestart({ ...options, port: blockedPort })
    );
    const originalSave = store.save.bind(store);
    vi.spyOn(store, "save")
      .mockImplementationOnce((persisted) => originalSave(persisted))
      .mockRejectedValueOnce(new Error("rollback save failed"));

    await expect(server.rotateIdentity()).rejects.toThrow(
      "Identity rotation failed and rollback was incomplete; the embedded relay was stopped."
    );

    expect(server.getStatus()).toEqual({
      running: false,
      error: "Identity rotation rollback failed; embedded relay stopped."
    });
    await expect(
      pinnedGet(settings.tlsPort, initial.pinnedInfo.tlsName, certDerBase64UrlToPem(initial.pinnedInfo.identityCertificateDer))
    ).rejects.toThrow();

    const restarted = await server.start(settings);
    expect(restarted.running).toBe(true);
    if (!restarted.running || !restarted.pinnedInfo) throw new Error("Expected restarted pinned server");
    expect(restarted.pinnedInfo.pinnedIdentitySpkiSha256).not.toBe(initialPin);
  });
});

describe("member TLS migration", () => {
  it("keeps the saved HTTP credential untouched until pinned completion returns a rotated token", async () => {
    const adapter = new FakeDataAdapter();
    const dbPath = "plugins/vault-rooms/server-data/relay.sqlite";
    const httpPort = await findAvailablePortBlock();
    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
    const core = createRelayCore(db);
    const owner = core.repo.bootstrapServer({ displayName: "Owner", deviceName: "Owner laptop", tokenSecurity: "plain" });
    await db.close();
    const hostSettings: EmbeddedServerSettings = { port: httpPort, maxFileBytes: 1024, autoStart: false };
    const host = new EmbeddedRelayServer(asDataAdapter(adapter), dbPath);
    embeddedServers.push(host);
    await host.start(hostSettings);
    await host.enableTlsMigration("non_strict");

    const oldSocket = new WebSocket(`ws://127.0.0.1:${httpPort}/sync`);
    sockets.push(oldSocket);
    await once(oldSocket, "open");
    oldSocket.send(
      JSON.stringify({
        type: "hello",
        requestId: "hello-before-migration",
        token: owner.deviceToken,
        client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "Owner laptop" }
      })
    );
    expect(await nextSocketMessage(oldSocket)).toMatchObject({ type: "hello_ok" });
    const oldSocketClosed = once(oldSocket, "close");
    const original = connection(`http://127.0.0.1:${httpPort}`, owner);
    const { manager, settings, saveSettings } = createConnectionManager(original);

    const migrated = await manager.migrateConnection(original);

    await oldSocketClosed;
    expect(original.baseUrl).toBe(`http://127.0.0.1:${httpPort}`);
    expect(settings.servers).toEqual([migrated]);
    expect(migrated).toMatchObject({
      baseUrl: `https://127.0.0.1:${hostSettings.tlsPort}`,
      securityMode: "pinned-tls",
      serverId: expect.stringMatching(/^srv_/),
      securityState: "ok",
      appliedRotationIds: []
    });
    expect(migrated.deviceToken).not.toBe(owner.deviceToken);
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(
      (
        await fetch(`http://127.0.0.1:${httpPort}/api/me`, {
          headers: { authorization: `Bearer ${owner.deviceToken}` }
        })
      ).status
    ).toBe(401);
    await expect(new RelayApiClient(migrated.baseUrl, migrated.deviceToken, undefined, pinnedInfo(migrated)).me()).resolves.toMatchObject({
      device: { id: owner.device.id }
    });
    const newSocket = openSyncSocket(migrated) as unknown as WebSocket;
    sockets.push(newSocket);
    await once(newSocket, "open");
    newSocket.send(
      JSON.stringify({
        type: "hello",
        requestId: "hello-after-migration",
        token: migrated.deviceToken,
        client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "Owner laptop" }
      })
    );
    expect(await nextSocketMessage(newSocket)).toMatchObject({ type: "hello_ok" });

    saveSettings.mockClear();
    const beforeRotationPin = migrated.pinnedIdentitySpkiSha256;
    await host.rotateIdentity();
    let tlsFailure: Error;
    try {
      await new RelayApiClient(migrated.baseUrl, migrated.deviceToken, undefined, pinnedInfo(migrated)).me();
      throw new Error("Expected the old identity pin to fail");
    } catch (error) {
      tlsFailure = error instanceof Error ? error : new Error(String(error));
    }
    const afterRotation = await manager.handlePinnedConnectionFailure(migrated, tlsFailure);

    expect(afterRotation).not.toBeNull();
    expect(afterRotation!.pinnedIdentitySpkiSha256).not.toBe(beforeRotationPin);
    expect(afterRotation!.appliedRotationIds).toHaveLength(1);
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(migrateServerConnectionSettings({ ...afterRotation! }).appliedRotationIds).toEqual(afterRotation!.appliedRotationIds);
    await expect(
      new RelayApiClient(afterRotation!.baseUrl, afterRotation!.deviceToken, undefined, pinnedInfo(afterRotation!)).me()
    ).resolves.toMatchObject({ device: { id: owner.device.id } });

    saveSettings.mockClear();
    await host.rotateIdentity();
    await expect(manager.apiFor(afterRotation!).me()).resolves.toMatchObject({ device: { id: owner.device.id } });
    expect(afterRotation!.appliedRotationIds).toHaveLength(2);
    expect(afterRotation!.lastSuccessfulConnectionAt).toBeTruthy();
    expect(saveSettings).toHaveBeenCalled();

    saveSettings.mockClear();
    await host.rotateIdentity();
    await expect(manager.apiFor(afterRotation!).me()).resolves.toMatchObject({ device: { id: owner.device.id } });
    expect(afterRotation!.appliedRotationIds).toHaveLength(3);
    expect(saveSettings).toHaveBeenCalled();
  });

  it("classifies an unrotated different identity with its concrete peer fingerprint and blocks the connection", async () => {
    const { app, identity: presentedIdentity, serverId, tlsPort } = await startDualStackEmbeddedApp();
    const savedIdentity = await generateServerIdentity(serverId);
    const saved: ServerConnection = {
      id: "dev_pin_mismatch",
      baseUrl: `https://127.0.0.1:${tlsPort}`,
      userId: "usr_1",
      userDisplayName: "Member",
      deviceId: "dev_pin_mismatch",
      deviceName: "Laptop",
      deviceToken: "tr_dev_never_sent",
      isServerOwner: false,
      status: "active",
      securityMode: "pinned-tls",
      serverId,
      tlsName: savedIdentity.tlsName,
      identityCertificateDer: certPemToDerBase64Url(savedIdentity.identityCertPem),
      pinnedIdentitySpkiSha256: savedIdentity.identitySpkiSha256,
      appliedRotationIds: [],
      securityState: "ok"
    };
    const showPinMismatch = vi.fn();
    const { manager, settings, saveSettings } = createConnectionManager(saved, showPinMismatch);
    let tlsFailure: Error;
    try {
      await new RelayApiClient(saved.baseUrl, saved.deviceToken, undefined, pinnedInfo(saved)).me();
      throw new Error("Expected the wrong server identity to fail");
    } catch (error) {
      tlsFailure = error instanceof Error ? error : new Error(String(error));
    }

    const result = await manager.handlePinnedConnectionFailure(saved, tlsFailure);

    expect(result).toBeNull();
    expect(settings.servers[0]?.securityState).toBe("pin_mismatch");
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(showPinMismatch).toHaveBeenCalledWith(saved, presentedIdentity.identitySpkiSha256);
    expect(app).toBeDefined();
  });

  it("preserves the original TLS error and retry policy when an expired leaf has the same identity pin", async () => {
    const remote = await startDualStackEmbeddedApp(async (serverId) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
      try {
        return await generateServerIdentity(serverId);
      } finally {
        vi.useRealTimers();
      }
    });
    const saved: ServerConnection = {
      id: "dev_expired_leaf",
      baseUrl: `https://127.0.0.1:${remote.tlsPort}`,
      userId: "usr_1",
      userDisplayName: "Member",
      deviceId: "dev_expired_leaf",
      deviceName: "Laptop",
      deviceToken: "tr_dev_never_sent",
      isServerOwner: false,
      status: "active",
      securityMode: "pinned-tls",
      serverId: remote.serverId,
      tlsName: remote.identity.tlsName,
      identityCertificateDer: certPemToDerBase64Url(remote.identity.identityCertPem),
      pinnedIdentitySpkiSha256: remote.identity.identitySpkiSha256,
      appliedRotationIds: [],
      securityState: "ok"
    };
    const showPinMismatch = vi.fn();
    const { manager, settings, saveSettings } = createConnectionManager(saved, showPinMismatch);
    let tlsFailure: Error;
    try {
      await new RelayApiClient(saved.baseUrl, saved.deviceToken, undefined, pinnedInfo(saved)).me();
      throw new Error("Expected the expired leaf to fail");
    } catch (error) {
      tlsFailure = error instanceof Error ? error : new Error(String(error));
    }

    await expect(manager.handlePinnedConnectionFailure(saved, tlsFailure)).rejects.toBe(tlsFailure);
    expect(settings.servers).toEqual([saved]);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(showPinMismatch).not.toHaveBeenCalled();
  });

  it("leaves settings and token unchanged when strict mode denies HTTP upgrade info", async () => {
    const adapter = new FakeDataAdapter();
    const dbPath = "plugins/vault-rooms/server-data/relay.sqlite";
    const httpPort = await findAvailablePortBlock();
    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
    const core = createRelayCore(db);
    const owner = core.repo.bootstrapServer({ displayName: "Owner", deviceName: "Owner laptop", tokenSecurity: "plain" });
    await db.close();
    const host = new EmbeddedRelayServer(asDataAdapter(adapter), dbPath);
    embeddedServers.push(host);
    await host.start({ port: httpPort, maxFileBytes: 1024, autoStart: false });
    await host.enableTlsMigration("strict");
    const original = connection(`http://127.0.0.1:${httpPort}`, owner);
    const { manager, settings, saveSettings } = createConnectionManager(original);

    await expect(manager.migrateConnection(original)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    expect(settings.servers).toEqual([original]);
    expect(original.deviceToken).toBe(owner.deviceToken);
    expect(saveSettings).not.toHaveBeenCalled();
  });
});

describe("server connection settings migration", () => {
  it("derives the transport mode from the URL and initializes durable rotation replay state", () => {
    expect(migrateServerConnectionSettings({ baseUrl: "http://relay.example", deviceToken: "plain" })).toMatchObject({
      securityMode: "plain",
      appliedRotationIds: []
    });
    expect(migrateServerConnectionSettings({ baseUrl: "https://relay.example", deviceToken: "tls" })).toMatchObject({
      securityMode: "os-trusted-tls",
      appliedRotationIds: []
    });
  });
});

async function startDualStackEmbeddedApp(
  identityFactory: (serverId: string) => ReturnType<typeof generateServerIdentity> = generateServerIdentity
) {
  const db = await openRelayDb(":memory:");
  const core = createRelayCore(db);
  const serverId = core.repo.getOrCreateServerId();
  const identity = await identityFactory(serverId);
  const persisted = { serverId, identity, rotations: [] };
  const httpPort = await getFreePort();
  const tlsPort = await getFreePort();
  const app = await createEmbeddedRelayApp(db, {
    core,
    publicUrl: `https://127.0.0.1:${tlsPort}`,
    security: {
      runtime: {
        getIdentity: () => persisted,
        httpsUrl: () => `https://127.0.0.1:${tlsPort}`
      }
    }
  });
  apps.push(app);
  await app.listen({ host: "127.0.0.1", port: httpPort });
  await app.listenTls({
    host: "127.0.0.1",
    port: tlsPort,
    key: identity.leafKeyPem,
    cert: tlsCertificateChainPem(identity)
  });
  return { app, identity, repo: core.repo, serverId, httpPort, tlsPort };
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function findAvailablePortBlock(): Promise<number> {
  for (let base = 24_000; base <= 34_000; base += 3) {
    if ((await isPortFree(base)) && (await isPortFree(base + 1)) && (await isPortFree(base + 2))) {
      return base;
    }
  }
  throw new Error("Could not find three adjacent free ports");
}

async function isPortFree(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "0.0.0.0", () => {
      server.close(() => resolve(true));
    });
  });
}

async function closeNetServer(server: NetServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function toArrayBuffer(buffer: Uint8Array): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

type AdapterValue = string | ArrayBuffer;

class FakeDataAdapter {
  readonly store = new Map<string, AdapterValue>();
  readonly folders = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.store.has(path) || this.folders.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.store.get(path);
    if (typeof value !== "string") throw new Error(`Missing text file: ${path}`);
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    this.store.set(path, data);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.store.get(path);
    if (!(value instanceof ArrayBuffer)) throw new Error(`Missing binary file: ${path}`);
    return value.slice(0);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.store.set(path, data.slice(0));
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async remove(path: string): Promise<void> {
    this.store.delete(path);
    this.folders.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const value = this.store.get(from);
    if (value === undefined) throw new Error(`Missing file: ${from}`);
    if (this.store.has(to)) throw new Error("Destination file already exists!");
    this.store.set(to, value);
    this.store.delete(from);
  }
}

function asDataAdapter(adapter: FakeDataAdapter): DataAdapter {
  return adapter as unknown as DataAdapter;
}

async function pinnedGet(
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
        ca,
        servername,
        rejectUnauthorized: true
      },
      (response) => {
        const peer = (response.socket as TLSSocket).getPeerCertificate(true);
        response.resume();
        response.once("end", () => resolve({ status: response.statusCode ?? 0, peer }));
      }
    );
    request.once("error", reject);
    request.end();
  });
}

function once(socket: WebSocket, event: "open" | "close" | "error"): Promise<void> {
  return new Promise((resolve) => socket.once(event, () => resolve()));
}

async function expectWebSocketRejected(url: string): Promise<void> {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Timed out waiting for WebSocket rejection")), 1_000);
    socket.once("open", () => {
      window.clearTimeout(timeout);
      reject(new Error("Plaintext WebSocket unexpectedly opened"));
    });
    socket.once("error", () => {
      window.clearTimeout(timeout);
      resolve();
    });
    socket.once("close", () => {
      window.clearTimeout(timeout);
      resolve();
    });
  });
}

function nextSocketMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>)));
}

function connection(
  baseUrl: string,
  owner: { user: { id: string; displayName: string }; device: { id: string; displayName: string }; deviceToken: string }
): ServerConnection {
  return {
    id: owner.device.id,
    baseUrl,
    userId: owner.user.id,
    userDisplayName: owner.user.displayName,
    deviceId: owner.device.id,
    deviceName: owner.device.displayName,
    deviceToken: owner.deviceToken,
    isServerOwner: true,
    status: "active",
    securityMode: "plain",
    appliedRotationIds: []
  };
}

function createConnectionManager(server: ServerConnection, showPinMismatch = vi.fn()) {
  const settings: VaultRoomsSettings = {
    servers: [server],
    activeServerId: server.id,
    mountRoot: "Vault Rooms",
    debounceMs: 300,
    mountedRooms: {},
    roomMountPaths: {},
    server: { maxFileBytes: 1024, autoStart: false }
  };
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const manager = new ServerConnectionManager({
    app: { vault: { adapter: {} } },
    manifest: { id: "vault-rooms", dir: ".obsidian/plugins/vault-rooms" },
    settings,
    saveSettings,
    renderOpenRoomsViews: vi.fn(),
    showPinMismatch
  } as never);
  return { manager, settings, saveSettings };
}

function pinnedInfo(server: ServerConnection) {
  if (!server.tlsName || !server.identityCertificateDer || !server.pinnedIdentitySpkiSha256) {
    throw new Error("Expected complete pinned server info");
  }
  return {
    tlsName: server.tlsName,
    identityCertificateDer: server.identityCertificateDer,
    pinnedIdentitySpkiSha256: server.pinnedIdentitySpkiSha256
  };
}
