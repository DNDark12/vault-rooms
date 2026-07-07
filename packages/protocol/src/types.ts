export type TeamRole = "admin" | "member";
export type RoomType = "file" | "folder";
// "device" and "agent" subject types existed in an earlier design but were never wired up to any
// evaluatePolicy() call site (every request is authorized as the underlying user, never a specific
// device) - see the removal note in policy-engine's evaluatePolicy(). "agent" was the MCP gateway's
// subject type, removed along with that feature.
export type SubjectType = "user" | "team";
export type AclEffect = "allow" | "deny";
export type CapabilityMode = "required" | "recommended" | "optional";
export type FileKind = "file" | "folder";
export type ContentType = "markdown" | "text" | "binary";
/**
 * How a room resolves a write that lands on a stale version:
 * - "keep_both" (default): reject the stale write (VERSION_CONFLICT) - the pusher's device forks
 *   it into a local-only conflict copy instead of losing it. Safe for anything, but a file that
 *   autosaves very frequently (e.g. a drawing) can fork often if two devices edit it around the
 *   same time.
 * - "owner_wins": the room owner's writes are always accepted, even against a stale baseVersion -
 *   good for frequently-autosaving files owned by one person, where forking on every save is more
 *   annoying than useful. Non-owner writes still follow "keep_both" against each other.
 */
export type ConflictPolicy = "keep_both" | "owner_wins";

export type Permission =
  | "room:read"
  | "room:write"
  | "room:delete"
  | "file:read"
  | "file:write"
  | "file:create"
  | "file:delete"
  | "sync:subscribe"
  | "sync:push";

export type AclRule = {
  id: string;
  roomId: string;
  subjectType: SubjectType;
  subjectId: string;
  effect: AclEffect;
  permissions: Permission[];
  pathPattern: string;
  createdAt: string;
};

export type RoomCapability = {
  id: string;
  roomId: string;
  pluginId: string;
  displayName: string;
  mode: CapabilityMode;
  minVersion?: string;
};
