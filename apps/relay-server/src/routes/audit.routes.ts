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
  actorDisplayName: string | null;
  actorDeviceDisplayName: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  resourceDisplayName: string | null;
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
    return { events: events.map((event) => toAuditEventResponse(repo, event)), limit, offset };
  });
}

function toAuditEventResponse(repo: RelayRepository, row: AuditEventRow): AuditEventResponse {
  const metadata = parseMetadata(row.metadata_json);
  const actor = resolveActorDisplay(repo, row);
  return {
    id: row.id,
    teamId: row.team_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorDisplayName: actor.name,
    actorDeviceDisplayName: actor.deviceName,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    resourceDisplayName: resolveResourceDisplay(repo, row, metadata),
    metadata,
    ipAddress: row.ip_address,
    createdAt: row.created_at
  };
}

function resolveActorDisplay(
  repo: RelayRepository,
  row: AuditEventRow
): { name: string | null; deviceName: string | null } {
  if (row.actor_type === "system") {
    return { name: "This server", deviceName: null };
  }
  if (row.actor_type === "user") {
    return { name: repo.getUser(row.actor_id)?.display_name ?? null, deviceName: null };
  }
  const device = repo.getDevice(row.actor_id);
  return {
    name: device ? repo.getUser(device.user_id)?.display_name ?? null : null,
    deviceName: device?.display_name ?? null
  };
}

function resolveResourceDisplay(
  repo: RelayRepository,
  row: AuditEventRow,
  metadata: unknown
): string | null {
  if (row.resource_type === "room") return repo.getRoom(row.resource_id)?.name ?? null;
  if (row.resource_type === "team") return repo.getTeam(row.resource_id)?.name ?? null;
  if (row.resource_type === "user") return repo.getUser(row.resource_id)?.display_name ?? null;
  if (row.resource_type === "device") return repo.getDevice(row.resource_id)?.display_name ?? null;
  if (row.resource_type === "file") return metadataValue(metadata, "relativePath");
  if (row.resource_type === "invite") {
    if (row.team_id) return repo.getTeam(row.team_id)?.name ?? "Invitation";
    const roomId = metadataValue(metadata, "roomId");
    return roomId ? repo.getRoom(roomId)?.name ?? "Invitation" : "Invitation";
  }
  if (row.resource_type === "server" || row.resource_type === "security") return "This server";
  return null;
}

function metadataValue(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
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
