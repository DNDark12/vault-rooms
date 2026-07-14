import { AppError, type SecurityUpgradeInfo } from "@vault-rooms/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import { certPemToDerBase64Url } from "../security/identity.js";
import type { PersistedIdentity } from "../security/identityStore.js";
import { getActivePrincipal } from "../services/authService.js";
import type { ConnectionRegistry } from "../sync/connectionRegistry.js";

export type RequestTransport = "http" | "https";

export type SecurityRuntime = {
  getIdentity: () => PersistedIdentity | null;
  httpsUrl: () => string | null;
};

export type SecurityRoutesOptions = {
  runtime: SecurityRuntime;
  connectionRegistry: ConnectionRegistry;
  rotationProbeRateLimiter: { consume(key: string): boolean };
};

type RequestWithTransport = FastifyRequest & { transport: RequestTransport };

export function requestTransport(request: FastifyRequest): RequestTransport {
  return (request as RequestWithTransport).transport;
}

export function assertTransportAllowed(repo: RelayRepository, transport: RequestTransport, _url: string): void {
  if (repo.getSecurityState() === "tls_enforced" && transport === "http") {
    throw new AppError("TLS_REQUIRED", "This server requires HTTPS/WSS.", 426);
  }
}

export function registerSecurityRoutes(
  app: FastifyInstance,
  repo: RelayRepository,
  options: SecurityRoutesOptions
): void {
  app.get("/api/security/upgrade-info", async (request) => {
    const transport = requestTransport(request);
    const principal = getActivePrincipal(repo, request);
    if (repo.getMigrationMode() === "strict" && transport === "http") {
      throw new AppError("PERMISSION_DENIED", "TLS migration is strict; get a fresh invite link.", 403);
    }
    const persisted = options.runtime.getIdentity();
    const httpsUrl = options.runtime.httpsUrl();
    if (!persisted || !httpsUrl) {
      throw new AppError("NOT_FOUND", "TLS identity is not available.", 404);
    }

    repo.markDeviceTransport(principal.deviceId, transport);
    repo.audit({
      teamId: null,
      actorType: "device",
      actorId: principal.deviceId,
      action: "security_upgrade_info_served",
      resourceType: "server",
      resourceId: persisted.serverId,
      metadata: { transport }
    });

    const response: SecurityUpgradeInfo = {
      httpsUrl,
      wssUrl: toWssUrl(httpsUrl),
      serverId: persisted.serverId,
      tlsName: persisted.identity.tlsName,
      identitySpkiSha256: persisted.identity.identitySpkiSha256,
      identityCertificateDer: certPemToDerBase64Url(persisted.identity.identityCertPem),
      migrationMode: repo.getMigrationMode(),
      ...(principal.isServerOwner ? { plainDeviceCount: repo.countActiveDevicesOnPlainTransport() } : {})
    };
    return response;
  });

  app.post("/api/security/complete-tls-migration", async (request) => {
    if (requestTransport(request) !== "https") {
      throw new AppError("TLS_REQUIRED", "TLS migration must be completed over HTTPS.", 426);
    }
    const principal = getActivePrincipal(repo, request);
    const result = await repo.durable(() => {
      const rotated = repo.rotateDeviceToken(principal.deviceId);
      repo.audit({
        teamId: null,
        actorType: "device",
        actorId: principal.deviceId,
        action: "tls_migration_completed",
        resourceType: "device",
        resourceId: principal.deviceId,
        metadata: {}
      });
      return rotated;
    });
    options.connectionRegistry.closeDeviceConnections(principal.deviceId, "credentials_rotated");
    return result;
  });

  app.get("/api/identity/rotations", async (request) => {
    if (!options.rotationProbeRateLimiter.consume(request.ip)) {
      throw new AppError("RATE_LIMITED", "Too many identity rotation probes. Try again later.", 429);
    }
    const persisted = options.runtime.getIdentity();
    const serverId = persisted?.serverId ?? repo.getOrCreateServerId();
    repo.audit({
      teamId: null,
      actorType: "system",
      actorId: serverId,
      action: "identity.rotations_served",
      resourceType: "server",
      resourceId: serverId,
      metadata: {}
    });
    return { serverId, rotations: persisted?.rotations ?? [] };
  });
}

function toWssUrl(httpsUrl: string): string {
  const url = new URL(httpsUrl);
  url.protocol = "wss:";
  url.pathname = "/sync";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
