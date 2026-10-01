import type { AclRule, Permission } from "@vault-rooms/protocol";

export const READER_PERMISSIONS: Permission[] = ["room:read", "file:read", "sync:subscribe"];
export const EDITOR_PERMISSIONS: Permission[] = [
  ...READER_PERMISSIONS,
  "file:write",
  "file:create",
  "file:delete",
  "sync:push"
];

/** "Blocked": every data permission a grant can give, denied together across the rule's scope. */
export const BLOCKED_PERMISSIONS: Permission[] = [...EDITOR_PERMISSIONS];

export type PermissionPreset = "reader" | "editor" | "blocked";

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return value === "reader" || value === "editor" || value === "blocked";
}

export function expandPreset(preset: PermissionPreset): Permission[] {
  switch (preset) {
    case "reader":
      return [...READER_PERMISSIONS];
    case "editor":
      return [...EDITOR_PERMISSIONS];
    case "blocked":
      return [...BLOCKED_PERMISSIONS];
  }
}

/** Whether `permissions` is exactly `expected`, ignoring order and repeats. */
export function isExactPermissionSet(permissions: readonly Permission[], expected: readonly Permission[]): boolean {
  const actual = new Set(permissions);
  return actual.size === new Set(expected).size && expected.every((permission) => actual.has(permission));
}

export type PolicyInput = {
  subject: {
    type: "user";
    id: string;
    userId?: string;
    teamIds?: string[];
  };
  resource: {
    type: "room" | "file";
    roomId?: string;
    roomOwnerUserId?: string;
    relativePath?: string;
  };
  permission: Permission;
  aclRules: AclRule[];
  membershipRevokedAt?: string | null;
  deviceRevokedAt?: string | null;
};

export type PolicyDecision = {
  allowed: boolean;
  reason: string;
  matchedRuleIds: string[];
};

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  if (input.membershipRevokedAt) {
    return deny("membership revoked");
  }
  if (input.deviceRevokedAt) {
    return deny("device revoked");
  }

  const relevantRules = sortBySpecificity(input.aclRules.filter((rule) => ruleApplies(rule, input)));
  const denyRules = relevantRules.filter((rule) => rule.effect === "deny" && rule.permissions.includes(input.permission));
  if (denyRules.length > 0) {
    return { allowed: false, reason: "explicit deny", matchedRuleIds: denyRules.map((rule) => rule.id) };
  }

  if (hasImplicitAllow(input)) {
    return { allowed: true, reason: "implicit room owner allow", matchedRuleIds: [] };
  }

  const allowRules = relevantRules.filter((rule) => rule.effect === "allow" && rule.permissions.includes(input.permission));
  if (allowRules.length > 0) {
    return { allowed: true, reason: "explicit allow", matchedRuleIds: allowRules.map((rule) => rule.id) };
  }

  return deny("no matching allow");
}

function deny(reason: string): PolicyDecision {
  return { allowed: false, reason, matchedRuleIds: [] };
}

function hasImplicitAllow(input: PolicyInput): boolean {
  const subjectUserId = input.subject.type === "user" ? input.subject.id : input.subject.userId;
  return Boolean(input.resource.roomOwnerUserId && subjectUserId === input.resource.roomOwnerUserId);
}

function ruleApplies(rule: AclRule, input: PolicyInput): boolean {
  if (input.resource.roomId && rule.roomId !== input.resource.roomId) {
    return false;
  }
  if (!subjectMatches(rule, input)) {
    return false;
  }
  return pathMatches(rule.pathPattern, input.resource.relativePath ?? "");
}

function subjectMatches(rule: AclRule, input: PolicyInput): boolean {
  if (rule.subjectType === input.subject.type && rule.subjectId === input.subject.id) {
    return true;
  }
  return rule.subjectType === "team" && Boolean(input.subject.teamIds?.includes(rule.subjectId));
}

function sortBySpecificity(rules: AclRule[]): AclRule[] {
  return [...rules].sort((a, b) => specificity(b.pathPattern) - specificity(a.pathPattern));
}

function specificity(pattern: string): number {
  return pattern.replaceAll("*", "").length;
}

export function pathMatches(pattern: string, relativePath: string): boolean {
  if (pattern === "**/*" || pattern === "**" || pattern === "") {
    return true;
  }
  if (pattern.endsWith("/**/*")) {
    const prefix = pattern.slice(0, -"**/*".length);
    return relativePath.startsWith(prefix);
  }
  if (pattern.includes("*")) {
    const escaped = pattern
      .split("**")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(relativePath);
  }
  return pattern === relativePath;
}
