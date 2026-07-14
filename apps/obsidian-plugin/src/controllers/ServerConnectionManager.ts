import { Notice } from "obsidian";
import { createInviteAcceptanceProof, type IdentityRotationRecord, type MigrationMode } from "@vault-rooms/protocol";
import { verifyRotationRecord } from "vault-rooms-relay/embedded-core";
import { RelayApiClient } from "../apiClient.js";
import {
  assertPinMaterial,
  fetchRotationProbe,
  InvalidPinMaterialError,
  type PinnedInviteInfo,
  type PinnedServerInfo
} from "../pinnedTransport.js";
import { activeServer, type ServerConnection } from "../settings.js";
import { EmbeddedRelayServer, type EmbeddedServerStatus } from "../serverManager.js";
import type { PluginContext } from "./PluginContext.js";

type ServerConnectionManagerContext = Pick<
  PluginContext,
  "app" | "manifest" | "settings" | "saveSettings" | "renderOpenRoomsViews" | "openJoinServer" | "removeSavedConnection"
> & {
  showPinMismatch?: (server: ServerConnection, presentedSpkiSha256: string) => void;
};

/** Owns the embedded relay server lifecycle and per-server RelayApiClient construction/revocation. */
export class ServerConnectionManager {
  private embeddedServer: EmbeddedRelayServer | null = null;

  constructor(private readonly ctx: ServerConnectionManagerContext) {}

  getServerStatus(): EmbeddedServerStatus {
    return this.embeddedServer?.getStatus() ?? { running: false };
  }

  async startEmbeddedServer(): Promise<EmbeddedServerStatus> {
    const server = this.getOrCreateEmbeddedServer();
    const previousPinnedPort = this.ctx.settings.server.pinnedPort;
    const previousTlsPort = this.ctx.settings.server.tlsPort;
    const status = await server.start(this.ctx.settings.server);
    this.ctx.renderOpenRoomsViews();
    if (status.running) {
      const pinnedPortChanged = !this.ctx.settings.server.port && status.port !== this.ctx.settings.server.pinnedPort;
      if (pinnedPortChanged) {
        this.ctx.settings.server.pinnedPort = status.port;
      }
      if (pinnedPortChanged || previousTlsPort !== this.ctx.settings.server.tlsPort) {
        await this.ctx.saveSettings();
      }
      if (status.portPinChanged) {
        const reason =
          status.portPinFallbackReason === "zombie"
            ? "The old port still looks like a previous Vault Rooms server instance."
            : status.portPinFallbackReason === "occupied"
              ? "The old port is occupied by another app."
              : "The old port is occupied.";
        new Notice(
          `Vault Rooms server moved from port ${previousPinnedPort} to ${status.port}. ${reason} Invite links and saved logins that reference the old port may need regenerating.`,
          0
        );
      }
      new Notice(`Vault Rooms server running at ${status.localUrl}`);
    }
    return status;
  }

  async stopEmbeddedServer(): Promise<void> {
    await this.embeddedServer?.stop();
    this.ctx.renderOpenRoomsViews();
    new Notice("Vault Rooms server stopped.");
  }

  /** Best-effort teardown for plugin unload - unlike stopEmbeddedServer(), does not render views or show a Notice (see VaultRoomsPlugin.onunload's doc comment). */
  async stopSilently(): Promise<void> {
    await this.embeddedServer?.stop();
  }

  async enableTlsMigration(mode: MigrationMode): Promise<EmbeddedServerStatus> {
    const status = await this.getOrCreateEmbeddedServer().enableTlsMigration(mode);
    await this.ctx.saveSettings();
    this.ctx.renderOpenRoomsViews();
    return status;
  }

  async enforceTls(): Promise<EmbeddedServerStatus> {
    const status = await this.getOrCreateEmbeddedServer().enforceTls();
    this.ctx.renderOpenRoomsViews();
    return status;
  }

  async rotateIdentity(): Promise<EmbeddedServerStatus> {
    const status = await this.getOrCreateEmbeddedServer().rotateIdentity();
    this.ctx.renderOpenRoomsViews();
    return status;
  }

  private getOrCreateEmbeddedServer(): EmbeddedRelayServer {
    if (!this.embeddedServer) {
      const pluginDir = this.ctx.manifest.dir ?? `${this.ctx.app.vault.configDir}/plugins/${this.ctx.manifest.id}`;
      this.embeddedServer = new EmbeddedRelayServer(this.ctx.app.vault.adapter, `${pluginDir}/server-data/relay.sqlite`);
    }
    return this.embeddedServer;
  }

  getActiveServer(): ServerConnection | undefined {
    return activeServer(this.ctx.settings);
  }

  findInviteServer(baseUrl: string, serverId?: string): ServerConnection | undefined {
    const activeServers = this.ctx.settings.servers.filter((server) => server.status === "active");
    if (serverId) {
      return activeServers.find((server) => server.serverId === serverId);
    }
    return activeServers.find((server) => normalizeBaseUrl(server.baseUrl) === normalizeBaseUrl(baseUrl));
  }

  async resolveInviteServer(baseUrl: string, serverId?: string): Promise<ServerConnection | undefined> {
    const direct = this.findInviteServer(baseUrl, serverId);
    if (direct || !serverId) {
      return direct;
    }

    const legacyCandidates = this.ctx.settings.servers.filter((server) => server.status === "active" && !server.serverId);
    for (const server of legacyCandidates) {
      let identity: Awaited<ReturnType<RelayApiClient["me"]>>;
      try {
        identity = await new RelayApiClient(server.baseUrl, server.deviceToken).me();
      } catch {
        // A legacy saved server is queried only at its own URL. A failed identity lookup means it
        // is not safe to send that token to the pinned invite endpoint.
        continue;
      }
      if (identity.serverId !== serverId) {
        continue;
      }
      const candidate = { ...server, serverId };
      await this.persistConnectionReplacement(server, candidate);
      Object.assign(server, candidate);
      return server;
    }
    return undefined;
  }

  async acceptInviteForServer(
    server: ServerConnection,
    inviteToken: string,
    baseUrl = server.baseUrl,
    pin?: PinnedInviteInfo
  ) {
    if (pin) {
      assertPinMaterial(pin);
    }
    const candidate: ServerConnection = pin
      ? {
          ...server,
          baseUrl,
          securityMode: "pinned-tls",
          serverId: pin.serverId,
          tlsName: pin.tlsName,
          identityCertificateDer: pin.identityCertificateDer,
          pinnedIdentitySpkiSha256: pin.pinnedIdentitySpkiSha256,
          appliedRotationIds: server.serverId === pin.serverId ? (server.appliedRotationIds ?? []) : [],
          securityState: "ok"
        }
      : { ...server, baseUrl };
    const savedPin = pinnedInfoForServer(server);
    const inviteMatchesSavedPin =
      pin !== undefined &&
      savedPin !== undefined &&
      savedPin.tlsName === pin.tlsName &&
      savedPin.identityCertificateDer === pin.identityCertificateDer &&
      savedPin.pinnedIdentitySpkiSha256 === pin.pinnedIdentitySpkiSha256;
    const result =
      pin && !inviteMatchesSavedPin
        ? await new RelayApiClient(candidate.baseUrl, undefined, undefined, pinnedInfoForServer(candidate)).acceptInviteWithProof({
            inviteToken,
            deviceId: server.deviceId,
            deviceProof: createInviteAcceptanceProof(server.deviceToken, {
              deviceId: server.deviceId,
              serverId: pin.serverId,
              inviteToken,
              identitySpkiSha256: pin.pinnedIdentitySpkiSha256
            })
          })
        : await new RelayApiClient(
            candidate.baseUrl,
            candidate.deviceToken,
            undefined,
            pinnedInfoForServer(candidate)
          ).acceptInvite(inviteToken);
    if (!pin && !result.deviceToken && candidate.baseUrl === server.baseUrl) {
      return result;
    }
    if (result.deviceToken) {
      candidate.deviceToken = result.deviceToken;
    }
    await this.persistConnectionReplacement(server, candidate);
    return result;
  }

  async migrateConnection(server: ServerConnection): Promise<ServerConnection> {
    const info = await new RelayApiClient(server.baseUrl, server.deviceToken).securityUpgradeInfo();
    if (server.serverId && server.serverId !== info.serverId) {
      throw new Error("TLS upgrade belongs to a different server identity.");
    }
    const pin: PinnedInviteInfo = {
      serverId: info.serverId,
      tlsName: info.tlsName,
      identityCertificateDer: info.identityCertificateDer,
      pinnedIdentitySpkiSha256: info.identitySpkiSha256
    };
    assertPinMaterial(pin);
    const candidate: ServerConnection = {
      ...server,
      baseUrl: info.httpsUrl,
      securityMode: "pinned-tls",
      serverId: info.serverId,
      tlsName: info.tlsName,
      identityCertificateDer: info.identityCertificateDer,
      pinnedIdentitySpkiSha256: info.identitySpkiSha256,
      appliedRotationIds: server.serverId === info.serverId ? (server.appliedRotationIds ?? []) : [],
      securityState: "migrating"
    };
    const completed = await new RelayApiClient(candidate.baseUrl, candidate.deviceToken, undefined, pin).completeTlsMigration();
    candidate.deviceToken = completed.deviceToken;
    candidate.securityState = "ok";
    candidate.lastSuccessfulConnectionAt = new Date().toISOString();
    await this.persistConnectionReplacement(server, candidate);
    return candidate;
  }

  async handlePinnedConnectionFailure(server: ServerConnection, originalError: Error): Promise<ServerConnection | null> {
    let probe: Awaited<ReturnType<typeof fetchRotationProbe>>;
    try {
      probe = await fetchRotationProbe(server.baseUrl);
    } catch {
      throw originalError;
    }
    if (probe.presentedSpkiSha256 === server.pinnedIdentitySpkiSha256) {
      throw originalError;
    }

    try {
      if (!server.serverId || !server.pinnedIdentitySpkiSha256 || !server.identityCertificateDer) {
        throw new Error("Saved pinned server identity is incomplete.");
      }
      const body = probe.body as { serverId?: unknown; rotations?: unknown };
      if (body.serverId !== server.serverId || !Array.isArray(body.rotations)) {
        throw new Error("Rotation response belongs to a different server.");
      }
      let workingPin = server.pinnedIdentitySpkiSha256;
      let workingCertificate = server.identityCertificateDer;
      const applied = new Set(server.appliedRotationIds ?? []);
      const responseIds = new Set<string>();
      const rotations = body.rotations.map((value) => {
        const record = value as IdentityRotationRecord;
        if (!record?.rotationId || record.serverId !== server.serverId || responseIds.has(record.rotationId)) {
          throw new Error("Identity rotation replay detected.");
        }
        responseIds.add(record.rotationId);
        return record;
      });
      let rotationIndex = 0;
      let appliedPrefixNewPin: string | undefined;
      while (rotationIndex < rotations.length && applied.has(rotations[rotationIndex]!.rotationId)) {
        const historical = rotations[rotationIndex]!;
        if (appliedPrefixNewPin !== undefined && historical.oldIdentitySpkiSha256 !== appliedPrefixNewPin) {
          throw new Error("Identity rotation replay detected.");
        }
        appliedPrefixNewPin = historical.newIdentitySpkiSha256;
        rotationIndex += 1;
      }
      if (appliedPrefixNewPin !== undefined && appliedPrefixNewPin !== workingPin) {
        throw new Error("Applied identity rotation history does not reach the saved pin.");
      }
      for (; rotationIndex < rotations.length; rotationIndex += 1) {
        const record = rotations[rotationIndex]!;
        if (applied.has(record.rotationId)) {
          throw new Error("Identity rotation replay detected.");
        }
        if (record.oldIdentitySpkiSha256 !== workingPin) {
          throw new Error("Identity rotation chain is incomplete or out of order.");
        }
        await verifyRotationRecord(record, workingPin, workingCertificate, applied);
        applied.add(record.rotationId);
        workingPin = record.newIdentitySpkiSha256;
        workingCertificate = record.newIdentityCertificateDer;
      }
      if (workingPin !== probe.presentedSpkiSha256) {
        throw new Error("No valid signed rotation reaches the presented server identity.");
      }
      const candidate: ServerConnection = {
        ...server,
        pinnedIdentitySpkiSha256: workingPin,
        identityCertificateDer: workingCertificate,
        appliedRotationIds: [...applied],
        securityState: "ok"
      };
      await this.persistConnectionReplacement(server, candidate);
      Object.assign(server, candidate);
      return candidate;
    } catch {
      const candidate: ServerConnection = { ...server, securityState: "pin_mismatch" };
      await this.persistConnectionReplacement(server, candidate);
      Object.assign(server, candidate);
      if (this.ctx.showPinMismatch) {
        this.ctx.showPinMismatch(server, probe.presentedSpkiSha256);
      } else {
        const { PinMismatchModal } = await import("../modals/PinMismatchModal.js");
        new PinMismatchModal(this.ctx.app, server, probe.presentedSpkiSha256, {
          onJoinWithNewInvite: this.ctx.openJoinServer,
          onRemoveSavedConnection: this.ctx.removeSavedConnection
            ? () => this.ctx.removeSavedConnection!(server)
            : undefined
        }).open();
      }
      return null;
    }
  }

  private async persistConnectionReplacement(original: ServerConnection, candidate: ServerConnection): Promise<void> {
    const previous = this.ctx.settings.servers;
    this.ctx.settings.servers = previous.map((saved) => (saved.id === original.id ? candidate : saved));
    try {
      await this.ctx.saveSettings();
    } catch (error) {
      this.ctx.settings.servers = previous;
      throw error;
    }
  }

  /** Same-process read, no network round-trip - see EmbeddedRelayServer.getBootstrapPin(). */
  getBootstrapPin(): string | null {
    return this.getOrCreateEmbeddedServer().getBootstrapPin();
  }

  recoverEmbeddedOwnerDevice(deviceName: string) {
    return this.getOrCreateEmbeddedServer().recoverOwnerDevice(deviceName);
  }

  revokeRecoveredEmbeddedOwnerDevice(deviceId: string): Promise<void> {
    return this.getOrCreateEmbeddedServer().revokeRecoveredOwnerDevice(deviceId);
  }

  async restoreEmbeddedLegacyV01Backup(): Promise<EmbeddedServerStatus> {
    const status = await this.getOrCreateEmbeddedServer().restoreLegacyV01Backup();
    this.ctx.renderOpenRoomsViews();
    return status;
  }

  /**
   * Whether this device has already bootstrapped its own hosted server. Bootstrap is a one-time
   * action per device install (the embedded server is a singleton - one process, one database, one
   * owner identity - so there is no such thing as "another" server to set up on top of it), and the
   * created owner identity is permanent: the underlying database keeps its owner forever, even
   * across Stop/Start, so re-running setup against it always fails ("Bootstrap has already been
   * completed"). The panel uses this to stop offering "Set up server" once it would only ever fail.
   */
  hasOwnServer(): boolean {
    return this.ctx.settings.servers.some((server) => server.isServerOwner);
  }

  async testConnection(baseUrl: string, pin?: PinnedServerInfo): Promise<void> {
    if (pin) assertPinMaterial(pin);
    await new RelayApiClient(baseUrl, undefined, undefined, pin).testConnection();
    new Notice(`Connected to Vault Rooms`);
  }

  apiFor(server: ServerConnection): RelayApiClient {
    const pinned = pinnedInfoForServer(server);
    return new RelayApiClient(
      server.baseUrl,
      server.deviceToken,
      () => this.markServerRevoked(server),
      pinned,
      server.securityMode === "pinned-tls" ? () => this.markSuccessfulPinnedConnection(server) : undefined,
      server.securityMode === "pinned-tls"
        ? async (error) => {
            const decision = await this.recoverPinnedTransport(server, error);
            if (decision === "retry" && pinned) {
              const updatedPin = pinnedInfoForServer(server);
              if (updatedPin) Object.assign(pinned, updatedPin);
            }
            return decision;
          }
        : undefined
    );
  }

  markSuccessfulPinnedConnection(server: ServerConnection): void {
    if (server.securityMode !== "pinned-tls") return;
    server.lastSuccessfulConnectionAt = new Date().toISOString();
    server.securityState = "ok";
    void this.ctx.saveSettings();
  }

  private async recoverPinnedTransport(server: ServerConnection, originalError: Error): Promise<"retry" | "normal" | "stop"> {
    if (originalError instanceof InvalidPinMaterialError) {
      return "stop";
    }
    try {
      const updated = await this.handlePinnedConnectionFailure(server, originalError);
      this.ctx.renderOpenRoomsViews();
      return updated ? "retry" : "stop";
    } catch (error) {
      if (error === originalError) {
        return "normal";
      }
      new Notice(error instanceof Error ? error.message : "Could not verify the server identity rotation.");
      return "stop";
    }
  }

  /**
   * A 401 from a server means the saved device token no longer resolves to anything there - most
   * commonly because that server's data was reset/recreated since the token was issued (fresh
   * install, wiped data dir, or switching between embedded/standalone with different data files).
   * Reflect that in the UI (Settings → Vault Rooms → Servers already shows `status`) instead of
   * leaving it as a one-off error toast with no lasting trace, so it's clear this server needs to
   * be removed and set up/joined again rather than retried.
   */
  private markServerRevoked(server: ServerConnection): void {
    if (server.status === "revoked") {
      return;
    }
    server.status = "revoked";
    void this.ctx.saveSettings();
    this.ctx.renderOpenRoomsViews();
    new Notice(`"${server.baseUrl}" - saved login is no longer valid on this server. Remove it and set up/join again from Settings → Vault Rooms → Servers.`);
  }

  requireActiveServer(): ServerConnection {
    const server = this.getActiveServer();
    if (!server) {
      throw new Error("No active Vault Rooms server.");
    }
    return server;
  }

  upsertServer(
    baseUrl: string,
    response: {
      user: { id: string; displayName: string };
      device: { id: string; displayName: string };
      deviceToken: string;
      isServerOwner: boolean;
    },
    pin?: PinnedInviteInfo
  ): void {
    if (pin) assertPinMaterial(pin);
    const config: ServerConnection = {
      id: response.device.id,
      baseUrl,
      userId: response.user.id,
      userDisplayName: response.user.displayName,
      deviceId: response.device.id,
      deviceName: response.device.displayName,
      deviceToken: response.deviceToken,
      isServerOwner: response.isServerOwner,
      status: "active",
      securityMode: pin ? "pinned-tls" : baseUrl.startsWith("https://") ? "os-trusted-tls" : "plain",
      appliedRotationIds: [],
      ...(pin
        ? {
            serverId: pin.serverId,
            tlsName: pin.tlsName,
            identityCertificateDer: pin.identityCertificateDer,
            pinnedIdentitySpkiSha256: pin.pinnedIdentitySpkiSha256,
            securityState: "ok" as const
          }
        : {})
    };
    this.ctx.settings.servers = [...this.ctx.settings.servers.filter((server) => server.id !== config.id), config];
    this.ctx.settings.activeServerId = config.id;
  }
}

export function pinnedInfoForServer(server: ServerConnection): PinnedServerInfo | undefined {
  if (server.securityMode !== "pinned-tls") {
    return undefined;
  }
  return {
    tlsName: server.tlsName ?? "",
    identityCertificateDer: server.identityCertificateDer ?? "",
    pinnedIdentitySpkiSha256: server.pinnedIdentitySpkiSha256 ?? ""
  };
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}
