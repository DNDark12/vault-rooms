import { describe, expect, it } from "vitest";
import type { AclRule, Permission } from "@vault-rooms/protocol";
import { EDITOR_PERMISSIONS, evaluatePolicy, expandPreset, requireToolAndFilePermissions } from "./index.js";

const baseRule = {
  id: "acl_1",
  roomId: "room_1",
  subjectType: "user",
  subjectId: "usr_b",
  effect: "allow",
  permissions: ["file:read"],
  pathPattern: "**/*",
  createdAt: "2026-07-06T00:00:00.000Z"
} satisfies AclRule;

function decide(permission: Permission, rules: AclRule[] = [], overrides = {}) {
  return evaluatePolicy({
    subject: { type: "user", id: "usr_b", userId: "usr_b" },
    resource: { type: "file", roomId: "room_1", roomOwnerUserId: "usr_a", relativePath: "Board.md" },
    permission,
    aclRules: rules,
    ...overrides
  });
}

describe("policy engine", () => {
  it("denies members without ACL", () => {
    expect(decide("file:read").allowed).toBe(false);
  });

  it("allow read grants read but not write", () => {
    expect(decide("file:read", [baseRule]).allowed).toBe(true);
    expect(decide("file:write", [baseRule]).allowed).toBe(false);
  });

  it("deny path overrides allow folder", () => {
    const rules: AclRule[] = [
      { ...baseRule, id: "allow", permissions: ["file:write"], pathPattern: "docs/**/*" },
      { ...baseRule, id: "deny", effect: "deny", permissions: ["file:write"], pathPattern: "docs/private/**/*" }
    ];
    const decision = decide("file:write", rules, {
      resource: { type: "file", roomId: "room_1", roomOwnerUserId: "usr_a", relativePath: "docs/private/Plan.md" }
    });

    expect(decision.allowed).toBe(false);
    expect(decision.matchedRuleIds).toEqual(["deny"]);
  });

  it("denies revoked members and revoked devices", () => {
    expect(decide("file:read", [baseRule], { membershipRevokedAt: "2026-07-06T00:00:00.000Z" }).allowed).toBe(false);
    expect(decide("file:read", [baseRule], { deviceRevokedAt: "2026-07-06T00:00:00.000Z" }).allowed).toBe(false);
  });

  it("allows room owners implicitly unless explicitly denied", () => {
    const ownerInput = {
      subject: { type: "user" as const, id: "usr_a", userId: "usr_a" },
      resource: { type: "file" as const, roomId: "room_1", roomOwnerUserId: "usr_a", relativePath: "Board.md" },
      permission: "file:write" as const,
      aclRules: []
    };
    expect(evaluatePolicy(ownerInput).allowed).toBe(true);
    expect(evaluatePolicy({ ...ownerInput, aclRules: [{ ...baseRule, subjectId: "usr_a", effect: "deny", permissions: ["file:write"] }] }).allowed).toBe(false);
  });

  it("matches team subject rules against active team ids", () => {
    const teamRule = { ...baseRule, subjectType: "team" as const, subjectId: "team_2", permissions: ["room:read"] } satisfies AclRule;

    expect(
      decide("room:read", [teamRule], {
        subject: { type: "user", id: "usr_b", userId: "usr_b", teamIds: ["team_1", "team_2"] },
        resource: { type: "room", roomId: "room_1", roomOwnerUserId: "usr_a" }
      }).allowed
    ).toBe(true);
    expect(
      decide("room:read", [teamRule], {
        subject: { type: "user", id: "usr_b", userId: "usr_b", teamIds: ["team_1"] },
        resource: { type: "room", roomId: "room_1", roomOwnerUserId: "usr_a" }
      }).allowed
    ).toBe(false);
  });

  it("does not filter matching rules by a separate team context", () => {
    const teamRule = { ...baseRule, subjectType: "team" as const, subjectId: "team_2", permissions: ["file:read"] } satisfies AclRule;

    expect(
      evaluatePolicy({
        subject: { type: "user", id: "usr_b", userId: "usr_b", teamIds: ["team_2"] },
        resource: { type: "file", roomId: "room_1", roomOwnerUserId: "usr_a", relativePath: "Board.md" },
        permission: "file:read",
        aclRules: [teamRule]
      }).allowed
    ).toBe(true);
  });

  it("requires tool permission and underlying file permission", () => {
    const toolOnly = { ...baseRule, permissions: ["tool:list_tasks"] } satisfies AclRule;
    const fileOnly = { ...baseRule, permissions: ["file:read"] } satisfies AclRule;
    const toolDecision = decide("tool:list_tasks", [toolOnly], {
      subject: { type: "agent", id: "agt_1" },
      resource: { type: "tool", roomId: "room_1", relativePath: "Tasks.md", toolName: "list_tasks" }
    });
    const fileDecision = decide("file:read", [toolOnly], {
      subject: { type: "agent", id: "agt_1" },
      resource: { type: "file", roomId: "room_1", relativePath: "Tasks.md" }
    });
    expect(requireToolAndFilePermissions([toolDecision, fileDecision]).allowed).toBe(false);

    const allowedTool = { ...toolOnly, subjectType: "agent" as const, subjectId: "agt_1" };
    const allowedFile = { ...fileOnly, subjectType: "agent" as const, subjectId: "agt_1" };
    const both = requireToolAndFilePermissions([
      decide("tool:list_tasks", [allowedTool, allowedFile], {
        subject: { type: "agent", id: "agt_1" },
        resource: { type: "tool", roomId: "room_1", relativePath: "Tasks.md", toolName: "list_tasks" }
      }),
      decide("file:read", [allowedTool, allowedFile], {
        subject: { type: "agent", id: "agt_1" },
        resource: { type: "file", roomId: "room_1", relativePath: "Tasks.md" }
      })
    ]);
    expect(both.allowed).toBe(true);
  });

  it("denies writes outside allowed subpath and does not let write imply delete", () => {
    const allowDocsWrite = { ...baseRule, permissions: ["file:write"], pathPattern: "docs/**/*" } satisfies AclRule;
    expect(
      decide("file:write", [allowDocsWrite], {
        resource: { type: "file", roomId: "room_1", roomOwnerUserId: "usr_a", relativePath: "other/Plan.md" }
      }).allowed
    ).toBe(false);
    expect(
      decide("file:delete", [allowDocsWrite], {
        resource: { type: "file", roomId: "room_1", roomOwnerUserId: "usr_a", relativePath: "docs/Plan.md" }
      }).allowed
    ).toBe(false);
  });

  it("expands editor preset exactly", () => {
    expect(expandPreset("editor")).toEqual(EDITOR_PERMISSIONS);
  });
});
