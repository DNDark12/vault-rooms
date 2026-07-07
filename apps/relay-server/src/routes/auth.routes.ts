import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "@vault-rooms/protocol";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import { getActivePrincipal } from "../services/authService.js";

export function registerAuthRoutes(app: FastifyInstance, repo: RelayRepository): void {
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

  app.post("/api/invites/accept", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const body = request.body as Partial<{ inviteToken: string }>;
    if (!body.inviteToken) {
      throw new AppError("VALIDATION_ERROR", "inviteToken is required.", 422);
    }
    try {
      return repo.acceptInvite({ inviteToken: body.inviteToken, userId: principal.userId });
    } catch {
      throw new AppError("UNAUTHORIZED", "Invalid or expired invite.", 401);
    }
  });

  app.get("/api/me", async (request: FastifyRequest) => {
    const principal = getActivePrincipal(repo, request);
    return {
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
