import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "@vault-rooms/protocol";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import { getActivePrincipal } from "../services/authService.js";
import type { ConnectionRegistry } from "../sync/connectionRegistry.js";
import type { InviteSecurityContext } from "./inviteResponse.js";
import { requestTransport } from "./security.routes.js";

export function registerAuthRoutes(
  app: FastifyInstance,
  repo: RelayRepository,
  options: { connectionRegistry?: ConnectionRegistry; inviteSecurity?: () => InviteSecurityContext | undefined; publicUrl?: string } = {}
): void {
  // Route registration happens once per server start in both runtimes, which makes it the shared place to
  // notice that the advertised address changed since last time and drop observations made under the old one.
  if (options.publicUrl) {
    const advertised = hostnameFromHeader(options.publicUrl.replace(/^[a-z]+:\/\//i, ""));
    if (advertised) {
      try {
        repo.noteAdvertisedHost(advertised);
      } catch {
        // A blocked write here is harmless - the worst case is a stale hint, never a broken route.
      }
    }
  }
  app.post("/api/join", async (request) => {
    const body = request.body as Partial<{ inviteToken: string; displayName: string; deviceName: string }>;
    if (!body.inviteToken || !body.displayName || !body.deviceName) {
      const missing = [
        !body.inviteToken && "inviteToken",
        !body.displayName && "displayName",
        !body.deviceName && "deviceName"
      ].filter((field): field is string => Boolean(field));
      throw new AppError("VALIDATION_ERROR", "This setup request is missing required information.", 422);
    }
    let invalidCredentials = false;
    try {
      return await repo.durable(() => {
        try {
          return repo.joinInvite({
            inviteToken: body.inviteToken!,
            displayName: body.displayName!,
            deviceName: body.deviceName!,
            tokenSecurity: requestTransport(request) === "https" ? "tls" : "plain"
          });
        } catch (error) {
          invalidCredentials = true;
          throw error;
        }
      });
    } catch (error) {
      if (invalidCredentials) {
        throw new AppError("UNAUTHORIZED", "Invalid or expired credentials.", 401);
      }
      throw error;
    }
  });

  app.post("/api/invites/accept", async (request) => {
    const body = request.body as Partial<{ inviteToken: string; deviceId: string; deviceProof: string }>;
    if (!body.inviteToken) {
      throw new AppError("VALIDATION_ERROR", "This invite link is missing its token.", 422);
    }
    const usesProof = body.deviceId !== undefined || body.deviceProof !== undefined;
    let principal;
    if (usesProof) {
      if (!body.deviceId || !body.deviceProof) {
        throw new AppError("VALIDATION_ERROR", "This device's identity proof was incomplete.", 422);
      }
      if (requestTransport(request) !== "https") {
        throw new AppError("TLS_REQUIRED", "Strict invite acceptance proof requires HTTPS.", 426);
      }
      if (repo.getSecurityState() !== "tls_migrating" || repo.getMigrationMode() !== "strict") {
        throw new AppError("UNAUTHORIZED", "Device proof is available only during strict TLS migration.", 401);
      }
      const security = options.inviteSecurity?.();
      principal = security
        ? repo.authenticateDeviceInviteProof({
            deviceId: body.deviceId,
            deviceProof: body.deviceProof,
            serverId: security.serverId,
            inviteToken: body.inviteToken,
            identitySpkiSha256: security.identitySpkiSha256
          })
        : null;
      if (!principal) {
        throw new AppError("UNAUTHORIZED", "Invalid device proof.", 401);
      }
    } else {
      principal = getActivePrincipal(repo, request);
    }
    let invalidInvite = false;
    try {
      const accepted = await repo.durable(() => {
        try {
          return repo.acceptInviteAndMaybeRotateDeviceToken({
            inviteToken: body.inviteToken!,
            userId: principal.userId,
            deviceId: principal.deviceId,
            transport: requestTransport(request)
          });
        } catch (error) {
          invalidInvite = true;
          throw error;
        }
      });
      if (accepted.deviceToken) {
        options.connectionRegistry?.closeDeviceConnections(principal.deviceId, "credentials_rotated");
      }
      return accepted;
    } catch (error) {
      if (invalidInvite) {
        throw new AppError("UNAUTHORIZED", "Invalid or expired invite.", 401);
      }
      throw error;
    }
  });

  app.get("/api/me", async (request: FastifyRequest) => {
    const principal = getActivePrincipal(repo, request);
    // Every client calls this, which makes it the cheapest place to learn the address teammates actually
    // reach this server on - a legitimately available signal, unlike enumerating network interfaces. The
    // owner's own client connects over loopback, so that value is filtered out as useless.
    const observedHost = hostnameFromHeader(request.headers?.host);
    if (observedHost && !isLoopbackHostname(observedHost)) {
      // Never let this optional hint break the read. On the embedded runtime a write throws outright while a
      // `durable()` operation is in flight (invite issuance, join, token rotation), which would turn a
      // previously read-only endpoint into a 500 for a teammate - and `refreshTeams` batches four calls, so
      // one failure takes the whole refresh down. The recorder also skips rewriting an unchanged host, which
      // matters because every write re-exports the entire SQLite image to disk.
      try {
        repo.recordObservedClientHost(observedHost);
      } catch {
        // Ignored on purpose: the next request re-records it.
      }
    }
    return {
      serverId: repo.getOrCreateServerId(),
      user: { id: principal.userId, displayName: principal.userDisplayName },
      device: { id: principal.deviceId, displayName: principal.deviceDisplayName },
      isServerOwner: principal.isServerOwner,
      // Only the owner can act on this (it's their Public URL override that would be wrong), and only they
      // should see where other people are connecting from.
      ...(principal.isServerOwner ? { observedClientHost: repo.getObservedClientHost() } : {}),
      teams: repo.listUserTeams(principal.userId).map((team) => ({
        id: team.teamId,
        name: team.name,
        slug: team.slug,
        role: team.role
      }))
    };
  });
}

/** Strips the port from a `Host` header and lowercases it. Bracketed IPv6 keeps its brackets removed so it
 *  compares equal to what the plugin shows the user. */
function hostnameFromHeader(header: unknown): string | null {
  if (typeof header !== "string" || header.trim().length === 0) {
    return null;
  }
  const value = header.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) {
    return bracketed[1] ?? null;
  }
  const withoutPort = value.includes(":") && value.split(":").length === 2 ? value.split(":")[0]! : value;
  return withoutPort.length > 0 ? withoutPort : null;
}

/** The owner's own client always reaches the server over loopback, so recording that would overwrite the one
 *  value this is for: the address a *teammate* used. */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || hostname.startsWith("127.");
}
