import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError, type TeamRole } from "@vault-rooms/protocol";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import { canManageTeam } from "../db/repositories/relayRepository.js";
import type { TeamRow } from "../db/schema.js";
import { getActivePrincipal } from "../services/authService.js";
import { revalidateRoomAccess } from "../services/policyService.js";
import type { ConnectionRegistry } from "../sync/connectionRegistry.js";
import { toInviteResponse } from "./inviteResponse.js";

export type TeamRoutesOptions = {
  publicUrl: string;
  allowRemoteBootstrap: boolean;
  /** Unguessable per-process PIN required by POST /api/bootstrap - see security/bootstrapPin.ts. */
  bootstrapPin: string;
  connectionRegistry?: ConnectionRegistry;
};

export function registerTeamRoutes(app: FastifyInstance, repo: RelayRepository, options: TeamRoutesOptions): void {
  const expectedBootstrapHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  try {
    expectedBootstrapHosts.add(new URL(options.publicUrl).hostname);
  } catch {
    // Ignore an unparsable publicUrl - the loopback aliases above still apply.
  }

  app.post("/api/bootstrap", async (request) => {
    // DNS-rebinding defense: a malicious web page can point an attacker-controlled DNS name at
    // 127.0.0.1/a LAN IP so the request satisfies isLocalAddress() below while still originating
    // from a browser tab on the attacker's real domain. The browser's Host header reflects the
    // domain name it actually navigated to, not the resolved IP, so it will never match this
    // server's own loopback/publicUrl hostnames - reject it before it can reach any side effect.
    if (!expectedBootstrapHosts.has(request.hostname)) {
      throw new AppError("VALIDATION_ERROR", "Bootstrap request Host header does not match this server.", 400);
    }
    if (!options.allowRemoteBootstrap && !isLocalAddress(request.ip)) {
      throw new AppError("PERMISSION_DENIED", "Bootstrap is only allowed from localhost by default.", 403);
    }

    const body = request.body as Partial<{ displayName: string; deviceName: string; teamName: string; pin: string }>;
    // Required even when allowRemoteBootstrap is true - that flag only relaxes the localhost
    // check above, it is not a PIN bypass. The PIN is the primary defense against drive-by/
    // DNS-rebinding bootstrap: without it, satisfying isLocalAddress() alone would be enough.
    if (!body.pin || body.pin !== options.bootstrapPin) {
      throw new AppError("PERMISSION_DENIED", "Missing or incorrect bootstrap PIN.", 403);
    }
    if (repo.getServerOwnerId()) {
      throw new AppError("PERMISSION_DENIED", "Bootstrap has already been completed.", 403);
    }

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
    const principal = getActivePrincipal(repo, request);
    if (principal.isServerOwner) {
      return { teams: repo.listTeams().map(toTeamResponse) };
    }
    const myTeamIds = new Set(repo.listUserTeams(principal.userId).map((team) => team.teamId));
    return { teams: repo.listTeams().filter((team) => myTeamIds.has(team.id)).map(toTeamResponse) };
  });

  // Deliberately a separate top-level path (not /api/teams/directory) so it can never be mistaken
  // for a /api/teams/:teamId/* route. Minimal directory of every team on the server - id/name/slug
  // only, no ownerUserId or membership - so any active principal can populate UI like the room ACL
  // "grant access to a team" picker without regressing the GET /api/teams membership-scoping fix.
  app.get("/api/team-directory", async (request) => {
    getActivePrincipal(repo, request);
    return { teams: repo.listTeamsDirectory() };
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
    return toInviteResponse(invite, options.publicUrl);
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
