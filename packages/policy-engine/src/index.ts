import type { AclRule, Permission, TeamRole } from "@vault-rooms/protocol";

export const READER_PERMISSIONS: Permission[] = ["room:read", "file:read", "sync:subscribe"];
export const EDITOR_PERMISSIONS: Permission[] = [
  ...READER_PERMISSIONS,
  "file:write",
  "file:create",
  "file:delete",
  "sync:push"
];

export type PermissionPreset = "reader" | "editor";

export function expandPreset(preset: PermissionPreset): Permission[] {
  return preset === "reader" ? [...READER_PERMISSIONS] : [...EDITOR_PERMISSIONS];
}

export type PolicyInput = {
  teamId: string;
  subject: {
    type: "user" | "device" | "agent" | "role";
    id: string;
    role?: TeamRole;
    userId?: string;
  };
  resource: {
    type: "room" | "file" | "tool";
    roomId?: string;
    roomOwnerUserId?: string;
    relativePath?: string;
    toolName?: string;
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
    return { allowed: true, reason: "implicit owner/admin allow", matchedRuleIds: [] };
  }

  const allowRules = relevantRules.filter((rule) => rule.effect === "allow" && rule.permissions.includes(input.permission));
  if (allowRules.length > 0) {
    return { allowed: true, reason: "explicit allow", matchedRuleIds: allowRules.map((rule) => rule.id) };
  }

  return deny("no matching allow");
}

export function requireToolAndFilePermissions(decisions: PolicyDecision[]): PolicyDecision {
  const denied = decisions.find((decision) => !decision.allowed);
  if (denied) {
    return denied;
  }
  return { allowed: true, reason: "all required permissions allowed", matchedRuleIds: decisions.flatMap((d) => d.matchedRuleIds) };
}

function deny(reason: string): PolicyDecision {
  return { allowed: false, reason, matchedRuleIds: [] };
}

function hasImplicitAllow(input: PolicyInput): boolean {
  if (input.subject.role === "owner") {
    return true;
  }
  if (input.subject.role === "admin" && input.permission.startsWith("room:")) {
    return true;
  }
  const subjectUserId = input.subject.type === "user" ? input.subject.id : input.subject.userId;
  return Boolean(input.resource.roomOwnerUserId && subjectUserId === input.resource.roomOwnerUserId);
}

function ruleApplies(rule: AclRule, input: PolicyInput): boolean {
  if (rule.teamId !== input.teamId) {
    return false;
  }
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
  return rule.subjectType === "role" && input.subject.role === rule.subjectId;
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
