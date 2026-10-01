import { describe, expect, it } from "vitest";
import {
  BLOCKED_PERMISSIONS,
  EDITOR_PERMISSIONS,
  READER_PERMISSIONS
} from "../../../packages/policy-engine/src/index.js";
import type { AclRuleSummary } from "./apiClient.js";
import {
  BLOCKED_PERMISSION_SET,
  EDITOR_PERMISSION_SET,
  READER_PERMISSION_SET,
  accessRulePresentation
} from "./accessPresentation.js";

const rule = (overrides: Partial<AclRuleSummary> = {}): AclRuleSummary => ({
  id: "acl_1",
  roomId: "room_1",
  subjectType: "team",
  subjectId: "team_1",
  effect: "allow",
  permissions: [...EDITOR_PERMISSION_SET],
  pathPattern: "**/*",
  createdAt: "2026-07-30T00:00:00.000Z",
  ...overrides
});

describe("access rule presentation", () => {
  it("stays byte-for-byte aligned with policy presets", () => {
    expect(EDITOR_PERMISSION_SET).toEqual(EDITOR_PERMISSIONS);
    expect(READER_PERMISSION_SET).toEqual(READER_PERMISSIONS);
    expect(BLOCKED_PERMISSION_SET).toEqual(BLOCKED_PERMISSIONS);
  });

  it("translates only exact presets", () => {
    expect(accessRulePresentation(rule()).summary).toBe("Can edit · everything here");
    expect(accessRulePresentation(rule({ permissions: [...READER_PERMISSION_SET] })).summary)
      .toBe("Can view · everything here");
    expect(accessRulePresentation(rule({ permissions: EDITOR_PERMISSION_SET.slice(0, -1) }))).toEqual({
      kind: "custom",
      summary: "Custom · everything here",
      rawPermissions: EDITOR_PERMISSION_SET.slice(0, -1).join(", ")
    });
  });

  it("calls only a full block Blocked, and makes folder scope readable", () => {
    expect(accessRulePresentation(rule({
      effect: "deny",
      permissions: [...BLOCKED_PERMISSION_SET],
      pathPattern: "Meetings/**/*"
    }))).toEqual({
      kind: "deny",
      summary: "Blocked from Meetings"
    });
  });

  it("describes a custom deny by exactly what it blocks", () => {
    expect(accessRulePresentation(rule({
      effect: "deny",
      permissions: ["file:read"],
      pathPattern: "Meetings/**/*"
    }))).toEqual({
      kind: "deny",
      summary: "Partly blocked · only Meetings",
      rawPermissions: "file:read"
    });
  });
});
