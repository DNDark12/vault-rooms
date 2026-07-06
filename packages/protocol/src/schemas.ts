import { z } from "zod";

export const capabilitySchema = z.object({
  pluginId: z.string().min(1),
  displayName: z.string().min(1),
  mode: z.enum(["required", "recommended", "optional"]),
  minVersion: z.string().optional()
});

export const permissionSchema = z.enum([
  "room:read",
  "room:write",
  "room:delete",
  "file:read",
  "file:write",
  "file:create",
  "file:delete",
  "sync:subscribe",
  "sync:push",
  "mcp:use",
  "tool:list_files",
  "tool:read_file",
  "tool:write_file",
  "tool:list_tasks",
  "tool:create_task",
  "tool:update_task_status",
  "tool:create_kanban_card",
  "tool:move_kanban_card"
]);
