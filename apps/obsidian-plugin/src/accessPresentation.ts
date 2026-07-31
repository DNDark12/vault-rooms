import type { AclRuleSummary } from "./apiClient.js";

export const READER_PERMISSION_SET = ["room:read", "file:read", "sync:subscribe"] as const;
export const EDITOR_PERMISSION_SET = [
  "room:read",
  "file:read",
  "sync:subscribe",
  "file:write",
  "file:create",
  "file:delete",
  "sync:push"
] as const;

export type AccessRulePresentation = {
  kind: "reader" | "editor" | "custom" | "deny";
  summary: string;
  rawPermissions?: string;
};

export function accessRulePresentation(rule: AclRuleSummary): AccessRulePresentation {
  const where = humanAccessScope(rule.pathPattern);
  if (rule.effect === "deny") {
    return {
      kind: "deny",
      summary: `Blocked from ${where.startsWith("only ") ? where.slice("only ".length) : where}`,
      rawPermissions: rule.permissions.join(", ")
    };
  }
  if (samePermissionSet(rule.permissions, EDITOR_PERMISSION_SET)) {
    return { kind: "editor", summary: `Can edit · ${where}` };
  }
  if (samePermissionSet(rule.permissions, READER_PERMISSION_SET)) {
    return { kind: "reader", summary: `Can view · ${where}` };
  }
  return {
    kind: "custom",
    summary: `Custom · ${where}`,
    rawPermissions: rule.permissions.join(", ")
  };
}

export function humanAccessScope(pathPattern: string): string {
  if (pathPattern === "**/*" || pathPattern === "**" || pathPattern === "") {
    return "everything here";
  }
  const folder = pathPattern.endsWith("/**/*")
    ? pathPattern.slice(0, -"/**/*".length)
    : pathPattern;
  return folder && !folder.includes("*") ? `only ${folder}` : "selected files";
}

export function samePermissionSet(
  actual: readonly string[],
  expected: readonly string[]
): boolean {
  if (actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  return expected.every((permission) => actualSet.has(permission));
}
