import type { FastifyInstance } from "fastify";
import { AppError } from "@vault-rooms/protocol";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import { getActivePrincipal } from "../services/authService.js";

export function registerAgentRoutes(app: FastifyInstance, repo: RelayRepository): void {
  app.post("/api/agents", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const body = request.body as Partial<{ displayName: string }>;
    if (!body.displayName) {
      throw new AppError("VALIDATION_ERROR", "displayName is required.", 422);
    }
    return repo.createAgentToken({ userId: principal.userId, displayName: body.displayName });
  });

  app.post("/api/agents/:agentId/revoke", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { agentId } = request.params as { agentId: string };
    const agent = repo.getAgentById(agentId);
    if (!agent) {
      throw new AppError("NOT_FOUND", "Agent not found.", 404);
    }
    if (agent.userId !== principal.userId) {
      throw new AppError("PERMISSION_DENIED", "Only the agent owner can revoke this token.", 403);
    }
    repo.revokeAgent({ agentId, actorUserId: principal.userId });
    return { ok: true };
  });
}
