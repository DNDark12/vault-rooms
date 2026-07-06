import type { FastifyInstance } from "fastify";
import { AppError } from "@vault-rooms/protocol";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import { canManageTeam } from "../db/repositories/relayRepository.js";
import { getActivePrincipal } from "../services/authService.js";

export function registerAgentRoutes(app: FastifyInstance, repo: RelayRepository): void {
  app.post("/api/teams/:teamId/agents", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { teamId } = request.params as { teamId: string };
    if (!canManageTeam(principal, teamId)) {
      throw new AppError("PERMISSION_DENIED", "Only owners and admins can create agent tokens.", 403);
    }
    const body = request.body as Partial<{ displayName: string }>;
    if (!body.displayName) {
      throw new AppError("VALIDATION_ERROR", "displayName is required.", 422);
    }
    return repo.createAgentToken({ teamId, userId: principal.userId, displayName: body.displayName });
  });

  app.post("/api/teams/:teamId/agents/:agentId/revoke", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { teamId, agentId } = request.params as { teamId: string; agentId: string };
    if (!canManageTeam(principal, teamId)) {
      throw new AppError("PERMISSION_DENIED", "Only owners and admins can revoke agent tokens.", 403);
    }
    repo.revokeAgent({ teamId, agentId, actorUserId: principal.userId });
    return { ok: true };
  });
}
