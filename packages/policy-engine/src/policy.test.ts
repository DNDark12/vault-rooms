import { describe, expect, it } from "vitest";
import type { AclRule, Permission } from "@vault-rooms/protocol";
import { BLOCKED_PERMISSIONS, EDITOR_PERMISSIONS, evaluatePolicy, expandPreset, isPermissionPreset, pathMatches } from "./index.js";

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

describe("portable ACL path matching", () => {
  it.each([
    ["Secret/Café.md", "secret/Cafe\u0301.MD"],
    ["SECRET/CAFE\u0301.MD", "Secret/Café.md"],
    ["Secret/Café/**/*", "secret/Cafe\u0301/Nội dung.md"],
    ["SECRET/CAFE\u0301/**/*", "Secret/Café/Nội dung.md"],
    ["Secret/Café/*.MD", "secret/Cafe\u0301/Plan.md"],
    ["SECRET/CAFE\u0301/*.md", "Secret/Café/Plan.MD"],
    ["Secret/**/Café.*", "secret/nested/Cafe\u0301.MD"],
    ["SECRET/**/CAFE\u0301.*", "Secret/nested/Café.md"]
  ])("matches %s against the case/Unicode alias %s", (pattern, path) => {
    expect(pathMatches(pattern, path)).toBe(true);
  });

  it("preserves folder boundaries and single-wildcard depth", () => {
    expect(pathMatches("Secret/Café/**/*", "secret/caféteria/Note.md")).toBe(false);
    expect(pathMatches("Secret/*.md", "secret/nested/Note.md")).toBe(false);
    expect(pathMatches("Secret/Note.md", "other/Note.md")).toBe(false);
  });

  it.each(["Secret/Café/Plan.md", "Secret/Café/**/*", "Secret/Café/*.md"])("preserves explicit deny for aliases under %s", (pathPattern) => {
    const rules: AclRule[] = [
      { ...baseRule, id: "allow", permissions: ["file:write"] },
      { ...baseRule, id: "deny", effect: "deny", permissions: ["file:write"], pathPattern }
    ];
    const decision = decide("file:write", rules, {
      resource: { type: "file", roomId: "room_1", roomOwnerUserId: "usr_a", relativePath: "SECRET/CAFE\u0301/PLAN.MD" }
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("explicit deny");
    expect(decision.matchedRuleIds).toEqual(["deny"]);
  });
});

describe("policy engine", () => {
  it("a blocked preset denies every data operation a grant can give", () => {
    expect(expandPreset("blocked")).toEqual(BLOCKED_PERMISSIONS);
    expect(new Set(BLOCKED_PERMISSIONS)).toEqual(new Set(EDITOR_PERMISSIONS));
    const rules: AclRule[] = [
      { ...baseRule, id: "edit", permissions: [...EDITOR_PERMISSIONS] },
      { ...baseRule, id: "block", effect: "deny", permissions: expandPreset("blocked") }
    ];
    for (const permission of EDITOR_PERMISSIONS) {
      expect(decide(permission, rules).allowed).toBe(false);
    }
  });

  it("recognizes only the known presets", () => {
    expect(["reader", "editor", "blocked"].every(isPermissionPreset)).toBe(true);
    expect(isPermissionPreset("admin")).toBe(false);
    expect(isPermissionPreset(undefined)).toBe(false);
  });

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
