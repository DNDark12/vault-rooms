import type { AuditEventSummary } from "../apiClient.js";

export type ActivityPresentation = {
  summary: string;
  technicalDetails: string;
};

export function activityPresentation(event: AuditEventSummary): ActivityPresentation {
  const actor = event.actorDisplayName ?? (event.actorType === "system" ? "This server" : "Someone");
  const resource = event.resourceDisplayName ?? resourceNoun(event.resourceType);
  const summary = activitySummary(event, actor, resource);
  return {
    summary,
    technicalDetails: JSON.stringify({
      action: event.action,
      actor: { type: event.actorType, id: event.actorId },
      resource: { type: event.resourceType, id: event.resourceId },
      ipAddress: event.ipAddress,
      metadata: event.metadata
    }, null, 2)
  };
}

function activitySummary(event: AuditEventSummary, actor: string, resource: string): string {
  switch (event.action) {
    case "room.created":
      return `${actor} created ${resource}`;
    case "room.updated":
      return `${actor} updated ${resource}`;
    case "room.deleted":
      return `${actor} deleted ${resource}`;
    case "room.crdt_enabled":
      return `${actor} turned on Live editing for ${resource}`;
    case "room.crdt_disabled":
      return `${actor} turned off Live editing for ${resource}`;
    case "file.created":
    case "file.crdt_created":
      return `${actor} created ${resource}`;
    case "file.updated":
    case "file.crdt_materialized":
      return `${actor} updated ${resource}`;
    case "file.renamed":
      return `${actor} renamed a note to ${resource}`;
    case "file.deleted":
      return `${actor} deleted ${resource}`;
    case "team.created":
      return `${actor} created team ${resource}`;
    case "team.deleted":
      return `${actor} deleted team ${resource}`;
    case "invite.created":
      return resource === "an invitation"
        ? `${actor} created an invitation`
        : `${actor} created an invitation for ${resource}`;
    case "invite.used":
      return `${actor} used an invitation`;
    case "member.joined":
      return `${resource} joined a team`;
    case "member.revoked":
      return `${actor} removed ${resource} from a team`;
    case "user.revoked":
      return `${actor} removed ${resource}'s server access`;
    case "device.revoked":
      return `${actor} removed device ${resource}`;
    case "device.token_rotated":
      return `${actor} refreshed access for device ${resource}`;
    case "acl.granted":
      return `${actor} gave access to ${resource}`;
    case "acl.removed":
      return `${actor} removed access from ${resource}`;
    case "acl.deny_superseded":
      return `${actor} replaced a blocked-access rule for ${resource}`;
    case "acl.denied":
      return `Access to ${resource} was blocked`;
    case "sync.connected":
      return event.actorDeviceDisplayName
        ? `${actor} connected from ${event.actorDeviceDisplayName}`
        : `${actor} connected`;
    case "sync.disconnected":
      return event.actorDeviceDisplayName
        ? `${actor} disconnected from ${event.actorDeviceDisplayName}`
        : `${actor} disconnected`;
    case "sync.denied":
      return `A sync action was blocked for ${resource}`;
    case "owner.device_recovered":
      return `Server owner access was recovered on ${resource}`;
    case "owner.device_recovery_rolled_back":
      return `A recovered owner device was removed`;
    case "tls_migration_completed":
      return `Secure LAN connections were enabled`;
    case "identity.rotations_served":
      return `A server identity update was shared`;
    case "security_upgrade_info_served":
      return `Secure-connection setup information was shared`;
    case "security.migration_enabled":
      return `Secure LAN migration was enabled`;
    case "security.tls_enforced":
      return `Secure LAN connections are now required`;
    case "identity.rotated":
      return `This server refreshed its secure identity`;
    default:
      return "A server activity event occurred";
  }
}

function resourceNoun(type: string): string {
  if (type === "room") return "a room";
  if (type === "team") return "a team";
  if (type === "user") return "a person";
  if (type === "device") return "a computer";
  if (type === "invite") return "an invitation";
  if (type === "file") return "a note";
  if (type === "server" || type === "security") return "this server";
  return "an item";
}
