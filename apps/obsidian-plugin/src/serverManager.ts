import { createServer } from "node:net";
import type { MigrationMode, ServerSecurityState } from "@vault-rooms/protocol";
import type { DataAdapter } from "obsidian";
import {
  certPemToDerBase64Url,
  createRelayCore,
  ensureServerIdentity,
  resolveServerIdForIdentityStore,
  rotateServerIdentity,
  tlsCertificateChainPem,
  type IdentityStore,
  type PersistedIdentity,
  type RelayDb,
  type SecurityRuntime
} from "vault-rooms-relay/embedded-core";
import type { EmbeddedServerSettings } from "./settings.js";
import { requestUrlWithTimeout } from "./apiClient.js";
import { createEmbeddedRelayApp, type EmbeddedOwnerRecoveryResult, type EmbeddedRelayApp } from "./embeddedRelayApp.js";
import { createObsidianIdentityStore } from "./obsidianIdentityStore.js";
import { openObsidianSqlJsDb, restoreObsidianLegacyV01Backup } from "./obsidianSqlJsDb.js";
import { withPort } from "./publicUrl.js";
import { isRestrictedPort } from "./restrictedPorts.js";
// Bundled directly into main.js by esbuild's "binary" loader - see esbuild.config.mjs. This
// avoids depending on a separately-shipped sql-wasm.wasm file, which the community-plugin
// installer would never actually deliver (it only downloads main.js/manifest.json/styles.css).
import sqlWasmBinary from "sql.js/dist/sql-wasm-browser.wasm";

export type EmbeddedServerStatus =
  | { running: false; error?: string }
  | {
      running: true;
      host: string;
      port: number;
      localUrl: string;
      lanUrl?: string;
      lanDetectionFailed?: boolean;
      portPinChanged?: boolean;
      portPinFallbackReason?: "zombie" | "occupied";
      securityMode: "plain" | "pinned-tls";
      bootstrapped: boolean;
      serverId: string;
      legacyV01BackupAvailable: boolean;
      securityState: ServerSecurityState;
      migrationMode?: MigrationMode;
      plainDeviceCount?: number;
      httpsUrl?: string;
      pinnedInfo?: {
        tlsName: string;
        identityCertificateDer: string;
        pinnedIdentitySpkiSha256: string;
        serverId: string;
      };
    };

/**
 * Runs the Vault Rooms relay server (REST + WebSocket sync) directly inside the
 * Obsidian plugin process. No separate terminal/process is required: install the
 * plugin, click Start, and the server is listening.
 */
export class EmbeddedRelayServer {
  private app: EmbeddedRelayApp | null = null;
  private status: EmbeddedServerStatus = { running: false };
  private activeSettings: EmbeddedServerSettings | null = null;
  private identityStore: IdentityStore | null = null;
  private securityRuntimeState: { persisted: PersistedIdentity; httpsUrl: string | null } | null = null;

  constructor(
    private readonly adapter: DataAdapter,
    /** Vault-relative plugin data path where the SQLite file is stored through Obsidian's adapter. */
    private readonly dbPath: string
  ) {}

  getStatus(): EmbeddedServerStatus {
    return this.status.running && this.app
      ? { ...this.status, bootstrapped: this.app.ownerAdmin.isBootstrapped() }
      : this.status;
  }

  /**
   * Reads the running embedded server's bootstrap PIN directly off the in-process relay app
   * instance (see relay-server's security/bootstrapPin.ts and team.routes.ts) - no network call.
   * The plugin's own setup flow (main.ts's setupServer()) uses this to satisfy POST
   * /api/bootstrap's PIN requirement transparently, since it is the legitimate same-process
   * caller. Returns null if the server isn't running.
   */
  getBootstrapPin(): string | null {
    return this.app ? (this.app as unknown as { bootstrapPin: string }).bootstrapPin : null;
  }

  async start(settings: EmbeddedServerSettings): Promise<EmbeddedServerStatus> {
    if (this.status.running) {
      return this.status;
    }
    const explicitPort = settings.port;
    const preferredPort = explicitPort ? undefined : settings.pinnedPort;
    let db: RelayDb | null = null;
    let app: EmbeddedRelayApp | null = null;
    try {
      db = await openObsidianSqlJsDb(this.adapter, this.dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
      const core = createRelayCore(db, { maxFileBytes: settings.maxFileBytes });
      // A legacy schema migration is an integrity boundary: persist the fully migrated image
      // before deriving owner/security state or opening any listener against it.
      await db.flush();
      const serverOwnerId = core.repo.getServerOwnerId();
      const freshUnbootstrapped = serverOwnerId === null && !core.repo.hasExplicitSecurityState();
      const legacyV01BackupAvailable =
        (await this.adapter.exists(`${this.dbPath}.bak-v1`)) && !core.repo.wasMigratedFromLegacyV01();
      const identityStore = createObsidianIdentityStore(this.adapter, parentDirectory(this.dbPath));
      // If automatic v0.1 recovery replaced an empty current DB, bind the migrated image back to
      // its already-durable identity before any random ID can be generated.
      const serverId = await resolveServerIdForIdentityStore(core.repo, identityStore);
      const startup = await core.repo.durable(() => {
        let securityState = core.repo.getSecurityState();
        if (freshUnbootstrapped) {
          securityState = "pinned_tls";
          core.repo.setSecurityState(securityState);
        }
        return { securityState };
      });
      const { securityState } = startup;
      const plainListenerEnabled = securityState === "plain_legacy" || securityState === "tls_migrating";
      // The legacy port is checked only when an HTTP listener will actually use it. Once enforcement
      // disables that listener, an unrelated process occupying the old port must not prevent HTTPS
      // from starting.
      const port = plainListenerEnabled
        ? explicitPort
          ? await requireAvailablePort(explicitPort)
          : await chooseAvailablePort(preferredPort)
        : (explicitPort ?? preferredPort ?? 8787);
      const publicUrlOverride = settings.publicUrlOverride?.trim();
      let tlsPort: number | undefined;
      let pinnedInfo: Extract<EmbeddedServerStatus, { running: true }>["pinnedInfo"];
      let tlsKey: string | undefined;
      let tlsCert: string | undefined;
      let publicUrl: string;
      const persisted = await ensureServerIdentity({ serverId, store: identityStore });
      const runtimeState = { persisted, httpsUrl: null as string | null };
      const security: { runtime: SecurityRuntime } = {
        runtime: {
          getIdentity: () => runtimeState.persisted,
          httpsUrl: () => runtimeState.httpsUrl
        }
      };

      if (securityState === "plain_legacy") {
        publicUrl = publicUrlOverride ? withPort(publicUrlOverride, port) : `http://127.0.0.1:${port}`;
      } else {
        tlsPort = await chooseAvailableTlsPort(settings.tlsPort ?? port + 1, plainListenerEnabled ? port : undefined);
        settings.tlsPort = tlsPort;
        publicUrl = publicUrlOverride ? withHttpsPort(publicUrlOverride, tlsPort) : `https://127.0.0.1:${tlsPort}`;
        runtimeState.httpsUrl = publicUrl;
        tlsKey = persisted.identity.leafKeyPem;
        tlsCert = tlsCertificateChainPem(persisted.identity);
        pinnedInfo = toPinnedInfo(persisted);
      }

      app = await createEmbeddedRelayApp(db, {
        core,
        publicUrl,
        // Always false for the embedded runtime: bootstrap is a same-process owner action.
        allowRemoteBootstrap: false,
        maxFileBytes: settings.maxFileBytes,
        security
      });
      // Always bind every interface (0.0.0.0), not just 127.0.0.1: invite authorization and
      // localhost-only bootstrap remain the access boundary.
      if (plainListenerEnabled) {
        await app.listen({ host: "0.0.0.0", port });
      }
      if (tlsPort !== undefined && tlsKey && tlsCert) {
        await app.listenTls({ host: "0.0.0.0", port: tlsPort, key: tlsKey, cert: tlsCert });
      }
      this.app = app;
      this.activeSettings = settings;
      this.identityStore = identityStore;
      this.securityRuntimeState = runtimeState;
      // Do not auto-read network interfaces in the plugin: Obsidian's publish scanner treats that
      // as machine fingerprinting. Users who want LAN invites can set the explicit Public URL
      // override; otherwise the embedded owner connection stays pinned to loopback.
      const lanUrl = publicUrlOverride ? publicUrl : undefined;
      const portPinChanged = !explicitPort && preferredPort !== undefined && port !== preferredPort;
      const portPinFallbackReason = portPinChanged
        ? (await isVaultRoomsServerOnPort(preferredPort))
          ? "zombie"
          : "occupied"
        : undefined;
      this.status = {
        running: true,
        host: "0.0.0.0",
        port,
        localUrl: tlsPort === undefined ? `http://127.0.0.1:${port}` : `https://127.0.0.1:${tlsPort}`,
        lanUrl,
        lanDetectionFailed: !lanUrl,
        portPinChanged: portPinChanged || undefined,
        portPinFallbackReason,
        securityMode: tlsPort === undefined ? "plain" : "pinned-tls",
        bootstrapped: serverOwnerId !== null,
        serverId,
        legacyV01BackupAvailable,
        securityState,
        migrationMode: core.repo.getMigrationMode(),
        plainDeviceCount: core.repo.countActiveDevicesOnPlainTransport(),
        httpsUrl: runtimeState.httpsUrl ?? undefined,
        pinnedInfo
      };
      return this.status;
    } catch (error) {
      // A partial dual-stack start must close whichever listeners were opened and the shared DB.
      // Preserve the startup error if cleanup also fails.
      try {
        if (app) {
          await app.close();
        } else if (db) {
          await db.close();
        }
      } catch {
        // The original startup error is the actionable failure.
      }
      const finalError =
        explicitPort && isExplicitPortBusyError(error, explicitPort)
          ? new Error(await describeBusyPort(explicitPort))
          : error;
      this.status = { running: false, error: finalError instanceof Error ? finalError.message : String(finalError) };
      throw finalError;
    }
  }

  async stop(): Promise<void> {
    const app = this.app;
    this.app = null;
    if (app) {
      await app.close();
    }
    this.activeSettings = null;
    this.identityStore = null;
    this.securityRuntimeState = null;
    this.status = { running: false };
  }

  async recoverOwnerDevice(deviceName: string): Promise<EmbeddedOwnerRecoveryResult> {
    const running = this.requireRunningSecurityContext();
    const tokenSecurity = running.status.securityMode === "pinned-tls" ? "tls" : "plain";
    return running.app.ownerAdmin.recoverOwnerDevice(deviceName, tokenSecurity);
  }

  async revokeRecoveredOwnerDevice(deviceId: string): Promise<void> {
    const running = this.requireRunningSecurityContext();
    await running.app.ownerAdmin.revokeRecoveredOwnerDevice(deviceId);
  }

  async restoreLegacyV01Backup(): Promise<EmbeddedServerStatus> {
    const running = this.requireRunningSecurityContext();
    const settings = running.settings;
    const stableServerId = running.runtime.persisted.serverId;
    await this.stop();
    try {
      await restoreObsidianLegacyV01Backup(this.adapter, this.dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
      const db = await openObsidianSqlJsDb(this.adapter, this.dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
      try {
        const core = createRelayCore(db, { maxFileBytes: settings.maxFileBytes });
        await core.repo.durable(() => core.repo.setServerIdIfMissing(stableServerId));
      } finally {
        await db.close();
      }
      return await this.start(settings);
    } catch (error) {
      try {
        if (!this.status.running) {
          await this.start(settings);
        }
      } catch (restartError) {
        throw new AggregateError([error, restartError], "v0.1 restore failed and the embedded relay could not be restarted.");
      }
      throw error;
    }
  }

  async enableTlsMigration(mode: MigrationMode): Promise<EmbeddedServerStatus> {
    const running = this.requireRunningSecurityContext();
    if (running.status.securityState !== "plain_legacy") {
      return running.status;
    }
    const persisted = await ensureServerIdentity({
      serverId: running.runtime.persisted.serverId,
      store: running.store
    });
    running.runtime.persisted = persisted;
    const tlsPort = await chooseAvailableTlsPort(running.settings.tlsPort ?? running.status.port + 1, running.status.port);
    const publicUrlOverride = running.settings.publicUrlOverride?.trim();
    const httpsUrl = publicUrlOverride ? withHttpsPort(publicUrlOverride, tlsPort) : `https://127.0.0.1:${tlsPort}`;
    const previousHttpsUrl = running.runtime.httpsUrl;
    const previousPublicUrl = running.app.getPublicUrl();
    try {
      await running.app.listenTls({
        host: "0.0.0.0",
        port: tlsPort,
        key: persisted.identity.leafKeyPem,
        cert: tlsCertificateChainPem(persisted.identity)
      });
      running.runtime.httpsUrl = httpsUrl;
      running.app.setPublicUrl(httpsUrl);
      await running.app.securityAdmin.enableTlsMigration(mode, persisted.serverId);
    } catch (error) {
      running.runtime.httpsUrl = previousHttpsUrl;
      running.app.setPublicUrl(previousPublicUrl);
      try {
        await running.app.closeTlsListener();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "TLS migration failed and its listener could not be closed.");
      }
      throw error;
    }
    running.settings.tlsPort = tlsPort;
    const pinnedInfo = toPinnedInfo(persisted);
    const info = {
      httpsUrl,
      wssUrl: toWssUrl(httpsUrl),
      serverId: persisted.serverId,
      tlsName: persisted.identity.tlsName,
      identitySpkiSha256: persisted.identity.identitySpkiSha256,
      identityCertificateDer: pinnedInfo.identityCertificateDer,
      migrationMode: mode,
      plainDeviceCount: running.app.securityAdmin.plainDeviceCount()
    };
    running.app.securityAdmin.broadcastUpgrade(info);
    this.status = {
      ...running.status,
      localUrl: `https://127.0.0.1:${tlsPort}`,
      lanUrl: publicUrlOverride ? httpsUrl : undefined,
      securityMode: "pinned-tls",
      securityState: "tls_migrating",
      migrationMode: mode,
      plainDeviceCount: info.plainDeviceCount,
      httpsUrl,
      pinnedInfo
    };
    return this.status;
  }

  async enforceTls(): Promise<EmbeddedServerStatus> {
    const running = this.requireRunningSecurityContext();
    await running.app.securityAdmin.enforceTls(running.runtime.persisted.serverId);
    try {
      await running.app.closePlainListener();
    } catch (error) {
      const cleanup = await Promise.allSettled([running.app.close()]);
      this.app = null;
      this.activeSettings = null;
      this.identityStore = null;
      this.securityRuntimeState = null;
      this.status = { running: false, error: "TLS enforcement listener shutdown failed; embedded relay stopped." };
      const cleanupErrors = rejectionErrors(cleanup);
      throw new AggregateError(
        [error, ...cleanupErrors],
        "TLS enforcement committed but legacy listener shutdown failed; embedded relay stopped."
      );
    }
    this.status = {
      ...running.status,
      securityMode: "pinned-tls",
      securityState: "tls_enforced",
      plainDeviceCount: running.app.securityAdmin.plainDeviceCount()
    };
    return this.status;
  }

  async rotateIdentity(): Promise<EmbeddedServerStatus> {
    const running = this.requireRunningSecurityContext();
    const tlsPort = running.settings.tlsPort;
    if (!tlsPort || !running.runtime.httpsUrl) {
      throw new Error("TLS is not active.");
    }
    const previous = running.runtime.persisted;
    const rotated = await rotateServerIdentity({ persisted: previous, store: running.store });
    const record = rotated.rotations.at(-1);
    if (!record) {
      throw new Error("Identity rotation record was not created.");
    }
    try {
      await running.app.restartTls({
        host: "0.0.0.0",
        port: tlsPort,
        key: rotated.identity.leafKeyPem,
        cert: tlsCertificateChainPem(rotated.identity)
      });
      running.runtime.persisted = rotated;
      await running.app.securityAdmin.recordIdentityRotation(rotated.serverId, record);
    } catch (error) {
      const rollback = await Promise.allSettled([
        running.store.save(previous),
        running.app.restartTls({
          host: "0.0.0.0",
          port: tlsPort,
          key: previous.identity.leafKeyPem,
          cert: tlsCertificateChainPem(previous.identity)
        })
      ]);
      if (rollback.every((result) => result.status === "fulfilled")) {
        running.runtime.persisted = previous;
        throw error;
      }

      // A failed persistence/listener rollback leaves no identity that is simultaneously true on
      // disk and on the wire. Stop the whole embedded relay so status cannot claim a TLS listener
      // is running under stale pin material; the next explicit Start reloads the durable identity.
      const cleanup = await Promise.allSettled([running.app.close()]);
      this.app = null;
      this.activeSettings = null;
      this.identityStore = null;
      this.securityRuntimeState = null;
      this.status = { running: false, error: "Identity rotation rollback failed; embedded relay stopped." };
      const rollbackErrors = rejectionErrors(rollback);
      const cleanupErrors = rejectionErrors(cleanup);
      throw new AggregateError(
        [error, ...rollbackErrors, ...cleanupErrors],
        "Identity rotation failed and rollback was incomplete; the embedded relay was stopped."
      );
    }
    this.status = { ...running.status, pinnedInfo: toPinnedInfo(rotated) };
    return this.status;
  }

  private requireRunningSecurityContext(): {
    app: EmbeddedRelayApp;
    status: Extract<EmbeddedServerStatus, { running: true }>;
    settings: EmbeddedServerSettings;
    store: IdentityStore;
    runtime: { persisted: PersistedIdentity; httpsUrl: string | null };
  } {
    if (!this.app || !this.status.running || !this.activeSettings || !this.identityStore || !this.securityRuntimeState) {
      throw new Error("Embedded relay server is not running.");
    }
    return {
      app: this.app,
      status: this.status,
      settings: this.activeSettings,
      store: this.identityStore,
      runtime: this.securityRuntimeState
    };
  }
}

function toPinnedInfo(persisted: PersistedIdentity): NonNullable<Extract<EmbeddedServerStatus, { running: true }>["pinnedInfo"]> {
  return {
    tlsName: persisted.identity.tlsName,
    identityCertificateDer: certPemToDerBase64Url(persisted.identity.identityCertPem),
    pinnedIdentitySpkiSha256: persisted.identity.identitySpkiSha256,
    serverId: persisted.serverId
  };
}

function toWssUrl(httpsUrl: string): string {
  const url = new URL(httpsUrl);
  url.protocol = "wss:";
  url.pathname = "/sync";
  return url.toString().replace(/\/$/, "");
}

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "." : path.slice(0, slash);
}

function withHttpsPort(urlString: string, port: number): string {
  const withScheme = urlString.includes("://") ? urlString : `https://${urlString}`;
  try {
    const url = new URL(withScheme);
    url.protocol = "https:";
    url.port = String(port);
    return `${url.protocol}//${url.host}`;
  } catch {
    return urlString;
  }
}

function toArrayBuffer(buffer: Uint8Array): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function rejectionErrors(results: readonly PromiseSettledResult<unknown>[]): Error[] {
  const errors: Error[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      const reason: unknown = result.reason;
      errors.push(reason instanceof Error ? reason : new Error(String(reason)));
    }
  }
  return errors;
}

function isExplicitPortBusyError(error: unknown, port: number): boolean {
  return error instanceof Error && error.message === `PORT=${port} is already in use`;
}

async function describeBusyPort(port: number): Promise<string> {
  if (await isVaultRoomsServerOnPort(port)) {
    return `PORT=${port} is already in use by what looks like a previous Vault Rooms server instance. Stop the old instance or choose another port.`;
  }
  return `PORT=${port} is already in use by another app. Stop that app or choose another port.`;
}

async function requireAvailablePort(port: number): Promise<number> {
  // Binding a restricted port can succeed at the OS/Node level - the failure only shows up later,
  // as every client request to it (including the plugin's own requestUrl/WebSocket calls) getting
  // rejected with net::ERR_UNSAFE_PORT, with no indication of why. Reject it up front instead.
  if (isRestrictedPort(port)) {
    throw new Error(`PORT=${port} is blocked by Obsidian's Electron runtime (a Chromium-restricted port). Choose a different port.`);
  }
  if (!(await isPortAvailable(port))) {
    throw new Error(`PORT=${port} is already in use`);
  }
  return port;
}

async function chooseAvailablePort(preferredPort?: number): Promise<number> {
  // A previously-pinned port could itself be restricted if it was saved before this check
  // existed - fall through to the normal auto-pick range instead of trying to reuse it.
  if (preferredPort !== undefined && !isRestrictedPort(preferredPort) && (await isPortAvailable(preferredPort))) {
    return preferredPort;
  }
  for (let port = 8787; port <= 8797; port += 1) {
    if (port === preferredPort) {
      continue;
    }
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error("No free port found between 8787 and 8797");
}

async function chooseAvailableTlsPort(preferredPort: number, excludedPort?: number): Promise<number> {
  for (let port = preferredPort; port <= preferredPort + 10; port += 1) {
    if (port === excludedPort || isRestrictedPort(port)) {
      continue;
    }
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No free TLS port found between ${preferredPort} and ${preferredPort + 10}`);
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

async function isVaultRoomsServerOnPort(port: number): Promise<boolean> {
  try {
    const response = await requestUrlWithTimeout({ url: `http://127.0.0.1:${port}/health`, throw: false }, 800);
    const body = response.json as { name?: unknown };
    return body.name === "vault-rooms";
  } catch {
    return false;
  }
}
