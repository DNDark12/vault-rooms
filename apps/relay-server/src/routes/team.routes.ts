import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError, type TeamRole } from "@vault-rooms/protocol";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import { canManageTeam } from "../db/repositories/relayRepository.js";
import type { TeamRow } from "../db/schema.js";
import { getActivePrincipal } from "../services/authService.js";
import { revalidateRoomAccess } from "../services/policyService.js";
import type { ConnectionRegistry } from "../sync/connectionRegistry.js";

export type TeamRoutesOptions = {
  publicUrl: string;
  allowRemoteBootstrap: boolean;
  connectionRegistry?: ConnectionRegistry;
};

export function registerTeamRoutes(app: FastifyInstance, repo: RelayRepository, options: TeamRoutesOptions): void {
  app.post("/api/bootstrap", async (request) => {
    if (!options.allowRemoteBootstrap && !isLocalAddress(request.ip)) {
      throw new AppError("PERMISSION_DENIED", "Bootstrap is only allowed from localhost by default.", 403);
    }
    if (repo.getServerOwnerId()) {
      throw new AppError("PERMISSION_DENIED", "Bootstrap has already been completed.", 403);
    }

    const body = request.body as Partial<{ displayName: string; deviceName: string; teamName: string }>;
    if (!body.displayName || !body.deviceName) {
      throw new AppError("VALIDATION_ERROR", "displayName and deviceName are required.", 422);
    }

    return repo.bootstrapServer({
      displayName: body.displayName,
      deviceName: body.deviceName,
      teamName: body.teamName
    });
  });

  app.post("/api/teams", async (request) => {
    const principal = getActivePrincipal(repo, request);
    if (!principal.isServerOwner) {
      throw new AppError("PERMISSION_DENIED", "Only the server owner can create teams.", 403);
    }
    const body = request.body as Partial<{ name: string }>;
    if (!body.name) {
      throw new AppError("VALIDATION_ERROR", "name is required.", 422);
    }
    return { team: toTeamResponse(repo.createTeam({ name: body.name, ownerUserId: principal.userId })) };
  });

  app.get("/api/teams", async (request) => {
    getActivePrincipal(repo, request);
    return { teams: repo.listTeams().map(toTeamResponse) };
  });

  app.post("/api/teams/:teamId/invites", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { teamId } = request.params as { teamId: string };
    if (!repo.getTeam(teamId)) {
      throw new AppError("NOT_FOUND", "Team not found.", 404);
    }
    if (!canManageTeam(repo, principal, teamId)) {
      throw new AppError("PERMISSION_DENIED", "Only owners and admins can create invites.", 403);
    }

    const body = request.body as Partial<{ role: TeamRole; expiresInMinutes: number; maxUses: number }>;
    const role = body.role ?? "member";
    if (!isTeamRole(role)) {
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

  app.get("/api/teams/:teamId/members", async (request: FastifyRequest) => {
    const principal = getActivePrincipal(repo, request);
    const { teamId } = request.params as { teamId: string };
    const team = repo.getTeam(teamId);
    if (!team) {
      throw new AppError("NOT_FOUND", "Team not found.", 404);
    }
    const membership = repo.getTeamMembership(teamId, principal.userId);
    if (!principal.isServerOwner && team.owner_user_id !== principal.userId && (!membership || membership.revoked_at)) {
      throw new AppError("PERMISSION_DENIED", "You are not a member of this team.", 403);
    }

    const includeRevoked = canManageTeam(repo, principal, teamId);
    const members = repo.listMembers(teamId, includeRevoked).map((member) => ({
      userId: member.user_id,
      displayName: member.display_name,
      role: member.role,
      revokedAt: member.revoked_at
    }));
    const serverOwnerId = repo.getServerOwnerId();
    const serverOwner = serverOwnerId && !members.some((member) => member.userId === serverOwnerId) ? repo.getUser(serverOwnerId) : null;
    return {
      members,
      ...(serverOwner ? { serverOwner: { userId: serverOwner.id, displayName: serverOwner.display_name, revokedAt: serverOwner.revoked_at } } : {})
    };
  });

  app.post("/api/teams/:teamId/members", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { teamId } = request.params as { teamId: string };
    if (!repo.getTeam(teamId)) {
      throw new AppError("NOT_FOUND", "Team not found.", 404);
    }
    if (!canManageTeam(repo, principal, teamId)) {
      throw new AppError("PERMISSION_DENIED", "Only owners and admins can add members.", 403);
    }
    const body = request.body as Partial<{ userId: string; role: TeamRole }>;
    const role = body.role ?? "member";
    if (!body.userId || !isTeamRole(role)) {
      throw new AppError("VALIDATION_ERROR", "userId is required and role must be member or admin.", 422);
    }
    repo.addTeamMember({ teamId, userId: body.userId, role, actorUserId: principal.userId });
    return { ok: true };
  });

  app.post("/api/teams/:teamId/members/:userId/revoke", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { teamId, userId } = request.params as { teamId: string; userId: string };
    if (!repo.getTeam(teamId)) {
      throw new AppError("NOT_FOUND", "Team not found.", 404);
    }
    if (!canManageTeam(repo, principal, teamId)) {
      throw new AppError("PERMISSION_DENIED", "Only owners and admins can revoke members.", 403);
    }
    const body = request.body as Partial<{ reason: string }> | undefined;
    repo.revokeMember({ teamId, userId, actorUserId: principal.userId, reason: body?.reason });
    revalidateRoomAccess(repo, options.connectionRegistry);
    return { ok: true };
  });

  app.delete("/api/teams/:teamId", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { teamId } = request.params as { teamId: string };
    const team = repo.getTeam(teamId);
    if (!team) {
      throw new AppError("NOT_FOUND", "Team not found.", 404);
    }
    if (!principal.isServerOwner && team.owner_user_id !== principal.userId) {
      throw new AppError("PERMISSION_DENIED", "Only the server owner or team owner can delete the team.", 403);
    }
    repo.deleteTeam({ teamId, actorUserId: principal.userId });
    revalidateRoomAccess(repo, options.connectionRegistry);
    return { ok: true };
  });
}

function toTeamResponse(team: TeamRow) {
  return {
    id: team.id,
    slug: team.slug,
    name: team.name,
    ownerUserId: team.owner_user_id
  };
}

function isTeamRole(role: string): role is TeamRole {
  return role === "member" || role === "admin";
}

function isLocalAddress(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
