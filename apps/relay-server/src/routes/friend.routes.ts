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
    getActivePrincipal(repo, request);
    return { friends: repo.listFriends() };
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
}
