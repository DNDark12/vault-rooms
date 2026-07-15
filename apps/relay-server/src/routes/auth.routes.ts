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
  options: { connectionRegistry?: ConnectionRegistry; inviteSecurity?: () => InviteSecurityContext | undefined } = {}
): void {
  app.post("/api/join", async (request) => {
    const body = request.body as Partial<{ inviteToken: string; displayName: string; deviceName: string }>;
    if (!body.inviteToken || !body.displayName || !body.deviceName) {
      const missing = [
        !body.inviteToken && "inviteToken",
        !body.displayName && "displayName",
        !body.deviceName && "deviceName"
      ].filter((field): field is string => Boolean(field));
      throw new AppError("VALIDATION_ERROR", `Missing required field(s): ${missing.join(", ")}.`, 422);
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
      throw new AppError("VALIDATION_ERROR", "inviteToken is required.", 422);
    }
    const usesProof = body.deviceId !== undefined || body.deviceProof !== undefined;
    let principal;
    if (usesProof) {
      if (!body.deviceId || !body.deviceProof) {
        throw new AppError("VALIDATION_ERROR", "deviceId and deviceProof are required together.", 422);
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
    return {
      serverId: repo.getOrCreateServerId(),
      user: { id: principal.userId, displayName: principal.userDisplayName },
      device: { id: principal.deviceId, displayName: principal.deviceDisplayName },
      isServerOwner: principal.isServerOwner,
      teams: repo.listUserTeams(principal.userId).map((team) => ({
        id: team.teamId,
        name: team.name,
        slug: team.slug,
        role: team.role
      }))
    };
  });
}
