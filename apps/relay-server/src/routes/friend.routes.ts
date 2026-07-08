import type { FastifyInstance } from "fastify";
import { AppError } from "@vault-rooms/protocol";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import { getActivePrincipal } from "../services/authService.js";
import type { ConnectionRegistry } from "../sync/connectionRegistry.js";

export type FriendRoutesOptions = {
  connectionRegistry?: ConnectionRegistry;
};

export function registerFriendRoutes(app: FastifyInstance, repo: RelayRepository, options: FriendRoutesOptions = {}): void {
  app.get("/api/friends", async (request) => {
    const principal = getActivePrincipal(repo, request);
    if (principal.isServerOwner) {
      return { friends: repo.listFriends() };
    }
    const myTeamIds = new Set(repo.listUserTeams(principal.userId).map((team) => team.teamId));
    const friends = repo.listFriends().map((friend) => ({
      ...friend,
      teams: friend.teams.filter((team) => myTeamIds.has(team.id))
    }));
    return { friends };
  });

  app.post("/api/friends/:userId/revoke", async (request) => {
    const principal = getActivePrincipal(repo, request);
    if (!principal.isServerOwner) {
      throw new AppError("PERMISSION_DENIED", "Only the server owner can revoke users.", 403);
    }
    const { userId } = request.params as { userId: string };
    if (!repo.getUser(userId)) {
      throw new AppError("NOT_FOUND", "User not found.", 404);
    }
    if (repo.getServerOwnerId() === userId) {
      throw new AppError("VALIDATION_ERROR", "The server owner cannot be revoked.", 400);
    }
    repo.revokeUser({ userId, actorUserId: principal.userId });
    options.connectionRegistry?.closeRevokedUser(userId);
    return { ok: true };
  });

  app.post("/api/friends/:userId/devices/:deviceId/revoke", async (request) => {
    const principal = getActivePrincipal(repo, request);
    if (!principal.isServerOwner) {
      throw new AppError("PERMISSION_DENIED", "Only the server owner can revoke devices.", 403);
    }
    const { userId, deviceId } = request.params as { userId: string; deviceId: string };
    if (!repo.getUser(userId)) {
      throw new AppError("NOT_FOUND", "User not found.", 404);
    }
    const device = repo.getDevice(deviceId);
    if (!device || device.user_id !== userId) {
      throw new AppError("NOT_FOUND", "Device not found.", 404);
    }
    repo.revokeDevice({ deviceId, actorUserId: principal.userId });
    options.connectionRegistry?.closeRevokedDevice(deviceId);
    return { ok: true };
  });
}
