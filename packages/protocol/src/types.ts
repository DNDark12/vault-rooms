export type TeamRole = "admin" | "member";
export type RoomType = "file" | "folder";
export type SubjectType = "user" | "team" | "device" | "agent";
export type AclEffect = "allow" | "deny";
export type CapabilityMode = "required" | "recommended" | "optional";
export type FileKind = "file" | "folder";
export type ContentType = "markdown" | "text";

export type Permission =
  | "room:read"
  | "room:write"
  | "room:delete"
  | "file:read"
  | "file:write"
  | "file:create"
  | "file:delete"
  | "sync:subscribe"
  | "sync:push"
  | "mcp:use"
  | "tool:list_files"
  | "tool:read_file"
  | "tool:write_file"
  | "tool:list_tasks"
  | "tool:create_task"
  | "tool:update_task_status"
  | "tool:create_kanban_card"
  | "tool:move_kanban_card";

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
