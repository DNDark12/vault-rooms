import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "@vault-rooms/protocol";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import { getActivePrincipal } from "../services/authService.js";

export function registerAuthRoutes(app: FastifyInstance, repo: RelayRepository): void {
  app.post("/api/join", async (request, reply) => {
    const body = request.body as Partial<{ inviteToken: string; displayName: string; deviceName: string }>;
    if (!body.inviteToken || !body.displayName || !body.deviceName) {
      throw new AppError("VALIDATION_ERROR", "inviteToken, displayName, and deviceName are required.", 422);
    }
    try {
      return repo.joinInvite({
        inviteToken: body.inviteToken,
        displayName: body.displayName,
        deviceName: body.deviceName
      });
    } catch {
      throw new AppError("UNAUTHORIZED", "Invalid or expired credentials.", 401);
    }
  });

  app.get("/api/me", async (request: FastifyRequest) => {
    const principal = getActivePrincipal(repo, request);
    return {
      team: { id: principal.teamId, name: principal.teamName },
      user: { id: principal.userId, displayName: principal.userDisplayName, role: principal.role },
      device: { id: principal.deviceId, displayName: principal.deviceDisplayName }
    };
  });
}
