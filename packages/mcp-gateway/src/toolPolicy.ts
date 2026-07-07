import type { Permission } from "@vault-rooms/protocol";
import type { McpToolName } from "./index.js";

export function requiredPermissionsForTool(tool: McpToolName): Permission[] {
  switch (tool) {
    case "list_rooms":
      return ["room:read"];
    case "list_files":
    case "read_file":
      return ["file:read"];
    case "write_file":
      // file:create vs file:write depends on whether this call creates a brand-new file
      // (baseVersion 0) or updates an existing one - same distinction file.routes.ts's REST PUT
      // makes. That's checked separately in mcp.routes.ts's write_file handler, since it can't be
      // expressed as a single static permission list the way every other tool's requirement can.
      return ["tool:write_file"];
    case "list_tasks":
      return ["file:read", "tool:list_tasks"];
    case "create_task":
      return ["file:read", "file:write", "tool:create_task"];
    case "update_task_status":
      return ["file:read", "file:write", "tool:update_task_status"];
    case "create_kanban_card":
      return ["file:read", "file:write", "tool:create_kanban_card"];
    case "move_kanban_card":
      return ["file:read", "file:write", "tool:move_kanban_card"];
  }
}

export function isMcpToolName(value: string): value is McpToolName {
  return [
    "list_rooms",
    "list_files",
    "read_file",
    "write_file",
    "list_tasks",
    "create_task",
    "update_task_status",
    "create_kanban_card",
    "move_kanban_card"
  ].includes(value);
}
