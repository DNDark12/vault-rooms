export type McpToolName =
  | "list_rooms"
  | "list_files"
  | "read_file"
  | "write_file"
  | "list_tasks"
  | "create_task"
  | "update_task_status"
  | "create_kanban_card"
  | "move_kanban_card";

export const MCP_TOOL_NAMES: McpToolName[] = [
  "list_rooms",
  "list_files",
  "read_file",
  "write_file",
  "list_tasks",
  "create_task",
  "update_task_status",
  "create_kanban_card",
  "move_kanban_card"
];

export * from "./toolPolicy.js";
