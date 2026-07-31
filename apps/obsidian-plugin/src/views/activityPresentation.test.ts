import { describe, expect, it } from "vitest";
import type { AuditEventSummary } from "../apiClient.js";
import { activityPresentation } from "./activityPresentation.js";

function event(overrides: Partial<AuditEventSummary>): AuditEventSummary {
  return {
    id: "audit-1",
    teamId: null,
    actorType: "user",
    actorId: "usr_owner",
    actorDisplayName: "DNDark",
    actorDeviceDisplayName: null,
    action: "room.updated",
    resourceType: "room",
    resourceId: "room_daily",
    resourceDisplayName: "Daily Report",
    metadata: {},
    ipAddress: null,
    createdAt: "2026-07-31T02:00:00.000Z",
    ...overrides
  };
}

describe("activityPresentation", () => {
  it("turns room lifecycle events into plain-language summaries", () => {
    expect(activityPresentation(event({ action: "room.crdt_enabled" })).summary)
      .toBe("DNDark turned on Live editing for Daily Report");
    expect(activityPresentation(event({ action: "room.updated" })).summary)
      .toBe("DNDark updated Daily Report");
  });

  it("names the person and computer for connection events", () => {
    const result = activityPresentation(event({
      actorType: "device",
      actorId: "dev_member",
      actorDisplayName: "huynd2",
      actorDeviceDisplayName: "My Documents",
      action: "sync.connected",
      resourceType: "device",
      resourceId: "dev_member",
      resourceDisplayName: "My Documents"
    }));

    expect(result.summary).toBe("huynd2 connected from My Documents");
    expect(result.summary).not.toMatch(/dev_|usr_|room_/);
  });

  it("turns whole-file and Live editing saves into the same plain-language note activity", () => {
    for (const action of ["file.created", "file.updated", "file.crdt_created", "file.crdt_materialized"]) {
      expect(activityPresentation(event({
        action,
        resourceType: "file",
        resourceId: "fil_note",
        resourceDisplayName: "Notes/Planning.md"
      })).summary).toBe(action === "file.created" || action === "file.crdt_created"
        ? "DNDark created Notes/Planning.md"
        : "DNDark updated Notes/Planning.md");
    }

    expect(activityPresentation(event({
      action: "file.renamed",
      resourceType: "file",
      resourceId: "fil_note",
      resourceDisplayName: "Notes/Plan.md"
    })).summary).toBe("DNDark renamed a note to Notes/Plan.md");

    expect(activityPresentation(event({
      action: "file.deleted",
      resourceType: "file",
      resourceId: "fil_note",
      resourceDisplayName: "Notes/Plan.md"
    })).summary).toBe("DNDark deleted Notes/Plan.md");
  });

  it("explains embedded-server security lifecycle events", () => {
    expect(activityPresentation(event({ action: "security.migration_enabled" })).summary)
      .toBe("Secure LAN migration was enabled");
    expect(activityPresentation(event({ action: "security.tls_enforced" })).summary)
      .toBe("Secure LAN connections are now required");
    expect(activityPresentation(event({ action: "identity.rotated" })).summary)
      .toBe("This server refreshed its secure identity");
  });

  it("keeps unknown codes and IDs out of the default summary", () => {
    const result = activityPresentation(event({
      actorDisplayName: null,
      resourceDisplayName: null,
      action: "future.internal_event"
    }));

    expect(result.summary).toBe("A server activity event occurred");
    expect(result.summary).not.toContain("future.internal_event");
    expect(result.technicalDetails).toContain("future.internal_event");
    expect(result.technicalDetails).toContain("usr_owner");
    expect(result.technicalDetails).toContain("room_daily");
  });
});
