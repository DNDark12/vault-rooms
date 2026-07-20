import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "@vault-rooms/protocol";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import { canManageTeam } from "../db/repositories/relayRepository.js";
import type { AuditEventRow } from "../db/schema.js";
import { getActivePrincipal } from "../services/authService.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export type AuditEventResponse = {
  id: string;
  teamId: string | null;
  actorType: "user" | "device" | "system";
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: string;
};

export function registerAuditRoutes(app: FastifyInstance, repo: RelayRepository): void {
  // Read-only viewer over the audit rows repo.audit(...) has been writing all along.
  // The server owner sees everything; a team owner/admin sees only rows tagged with a team they
  // manage. Server-level rows (team_id null: security state changes, identity rotation, device
  // revocations, ...) are owner-only by construction - they never match a teamId filter.
  app.get("/api/audit", async (request: FastifyRequest) => {
    const principal = getActivePrincipal(repo, request);
    const query = request.query as Partial<{ teamId: string; limit: string; offset: string }>;
    const limit = parsePageParam(query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = parsePageParam(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    if (!principal.isServerOwner) {
      if (!query.teamId) {
        throw new AppError("PERMISSION_DENIED", "Only the server owner can read the server-wide audit log.", 403);
      }
      if (!canManageTeam(repo, principal, query.teamId)) {
        throw new AppError("PERMISSION_DENIED", "Only a team owner or admin can read this team's audit log.", 403);
      }
    }

    const events = repo.listAuditEvents({
      ...(query.teamId === undefined ? {} : { teamId: query.teamId }),
      limit,
      offset
    });
    return { events: events.map(toAuditEventResponse), limit, offset };
  });
}

function toAuditEventResponse(row: AuditEventRow): AuditEventResponse {
  return {
    id: row.id,
    teamId: row.team_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: parseMetadata(row.metadata_json),
    ipAddress: row.ip_address,
    createdAt: row.created_at
  };
}

function parseMetadata(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    // A malformed row should degrade to visible-but-raw, not break the whole page.
    return { raw: json };
  }
}

function parsePageParam(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError("VALIDATION_ERROR", `Expected an integer between ${min} and ${max}.`, 422);
  }
  return parsed;
}
