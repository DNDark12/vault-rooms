import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "@vault-rooms/protocol";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import { canManageTeam } from "../db/repositories/relayRepository.js";
import { getActivePrincipal } from "../services/authService.js";
import type { ConnectionRegistry } from "../sync/connectionRegistry.js";

export type TeamRoutesOptions = {
  publicUrl: string;
  allowRemoteBootstrap: boolean;
  connectionRegistry?: ConnectionRegistry;
};

export function registerTeamRoutes(app: FastifyInstance, repo: RelayRepository, options: TeamRoutesOptions): void {
  app.post("/api/teams/bootstrap", async (request) => {
    if (!options.allowRemoteBootstrap && !isLocalAddress(request.ip)) {
      throw new AppError("PERMISSION_DENIED", "Bootstrap is only allowed from localhost by default.", 403);
    }

    const body = request.body as Partial<{ teamName: string; ownerDisplayName: string; ownerDeviceName: string }>;
    if (!body.teamName || !body.ownerDisplayName || !body.ownerDeviceName) {
      throw new AppError("VALIDATION_ERROR", "teamName, ownerDisplayName, and ownerDeviceName are required.", 422);
    }

    return repo.bootstrapTeam({
      teamName: body.teamName,
      ownerDisplayName: body.ownerDisplayName,
      ownerDeviceName: body.ownerDeviceName
    });
  });

  app.post("/api/teams/:teamId/invites", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { teamId } = request.params as { teamId: string };
    if (!canManageTeam(principal, teamId)) {
      throw new AppError("PERMISSION_DENIED", "Only owners and admins can create invites.", 403);
    }

    const body = request.body as Partial<{ role: "member" | "admin"; expiresInMinutes: number; maxUses: number }>;
    const role = body.role ?? "member";
    if (role !== "member" && role !== "admin") {
      throw new AppError("VALIDATION_ERROR", "role must be member or admin.", 422);
    }

    const invite = repo.createInvite({
      teamId,
      createdByUserId: principal.userId,
      role,
      expiresInMinutes: body.expiresInMinutes ?? 60,
      maxUses: body.maxUses ?? 1
    });
    const joinUrl = `obsidian://vault-rooms?mode=join&server=${encodeURIComponent(options.publicUrl)}&token=${encodeURIComponent(invite.inviteToken)}`;

    return {
      inviteId: invite.inviteId,
      inviteToken: invite.inviteToken,
      serverUrl: options.publicUrl,
      joinUrl
    };
  });

  app.get("/api/teams/:teamId/members", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { teamId } = request.params as { teamId: string };
    if (principal.teamId !== teamId) {
      throw new AppError("PERMISSION_DENIED", "You are not a member of this team.", 403);
    }

    const includeRevoked = principal.role === "owner" || principal.role === "admin";
    return {
      members: repo.listMembers(teamId, includeRevoked).map((member) => ({
        userId: member.user_id,
        displayName: member.display_name,
        role: member.role,
        revokedAt: member.revoked_at
      }))
    };
  });

  app.post("/api/teams/:teamId/members/:userId/revoke", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { teamId, userId } = request.params as { teamId: string; userId: string };
    if (!canManageTeam(principal, teamId)) {
      throw new AppError("PERMISSION_DENIED", "Only owners and admins can revoke members.", 403);
    }
    const body = request.body as Partial<{ reason: string }>;
    repo.revokeMember({ teamId, userId, actorUserId: principal.userId, reason: body.reason });
    options.connectionRegistry?.closeRevokedUser(teamId, userId);
    return { ok: true };
  });

  app.delete("/api/teams/:teamId", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { teamId } = request.params as { teamId: string };
    if (principal.teamId !== teamId || principal.role !== "owner") {
      throw new AppError("PERMISSION_DENIED", "Only the team owner can delete the team.", 403);
    }
    options.connectionRegistry?.closeTeam(teamId);
    repo.deleteTeam({ teamId, actorUserId: principal.userId });
    return { ok: true };
  });
}

function isLocalAddress(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
