import type { FastifyInstance } from "fastify";
import { createKanbanCard, createTask, listTasks, moveKanbanCard, updateTaskStatus } from "@vault-rooms/markdown-adapters";
import { isMcpToolName, type McpToolName, requiredPermissionsForTool } from "vault-rooms-mcp";
import { AppError, normalizeRelativePath, type Permission } from "@vault-rooms/protocol";
import { evaluatePolicy } from "@vault-rooms/policy";
import type { AgentPrincipal, RelayRepository } from "../db/repositories/relayRepository.js";
import type { RoomRow } from "../db/schema.js";

export function registerMcpRoutes(app: FastifyInstance, repo: RelayRepository): void {
  app.post("/mcp", async (request) => {
    const agent = authenticateAgent(repo, request.headers.authorization);
    const body = request.body as Partial<{ tool: string; input: Record<string, unknown>; method: string; params: { name?: string; arguments?: Record<string, unknown> } }>;
    const tool = body.tool ?? body.params?.name;
    const input = body.input ?? body.params?.arguments ?? {};
    if (!tool || !isMcpToolName(tool)) {
      throw new AppError("VALIDATION_ERROR", "Unknown MCP tool.", 422);
    }

    repo.audit({
      teamId: agent.teamId,
      actorType: "agent",
      actorId: agent.agentId,
      action: "mcp.tool.called",
      resourceType: "tool",
      resourceId: tool,
      metadata: { toolName: tool, input: redactInput(input) }
    });

    try {
      const result = handleTool(repo, agent, tool, input);
      repo.audit({
        teamId: agent.teamId,
        actorType: "agent",
        actorId: agent.agentId,
        action: "mcp.tool.succeeded",
        resourceType: "tool",
        resourceId: tool,
        metadata: { toolName: tool }
      });
      return { result };
    } catch (error) {
      repo.audit({
        teamId: agent.teamId,
        actorType: "agent",
        actorId: agent.agentId,
        action: error instanceof AppError && error.code === "PERMISSION_DENIED" ? "mcp.tool.denied" : "mcp.tool.failed",
        resourceType: "tool",
        resourceId: tool,
        metadata: { toolName: tool, message: error instanceof Error ? error.message : "unknown" }
      });
      throw error;
    }
  });
}

function handleTool(repo: RelayRepository, agent: AgentPrincipal, tool: McpToolName, input: Record<string, unknown>): unknown {
  switch (tool) {
    case "list_rooms":
      return {
        rooms: repo
          .listTeamRooms(agent.teamId)
          .filter((room) => canAgent(repo, agent, room, "room:read"))
          .map((room) => ({
            id: room.id,
            name: room.name,
            type: room.type,
            permissions: ["file:read", "file:write"].filter((permission) => canAgent(repo, agent, room, permission as Permission)),
            capabilities: repo.listCapabilities(room.id).map((capability) => capability.plugin_id)
          }))
      };
    case "list_files": {
      const room = requireRoom(repo, String(input.roomId));
      assertToolPermissions(repo, agent, room, tool, String(input.path ?? ""));
      return {
        files: repo
          .listFiles(room.id)
          .filter((file) => !file.deleted_at && canAgent(repo, agent, room, "file:read", file.relative_path))
          .map((file) => ({ relativePath: file.relative_path, version: file.version, sha256: file.sha256 }))
      };
    }
    case "read_file": {
      const room = requireRoom(repo, String(input.roomId));
      const relativePath = normalizeRelativePath(String(input.relativePath));
      assertToolPermissions(repo, agent, room, tool, relativePath);
      const { file, content } = repo.readFileContent(room.id, relativePath);
      return { relativePath, version: file.version, sha256: file.sha256, content };
    }
    case "write_file": {
      const room = requireRoom(repo, String(input.roomId));
      const relativePath = normalizeRelativePath(String(input.relativePath));
      assertToolPermissions(repo, agent, room, tool, relativePath);
      return repo.writeFile({
        roomId: room.id,
        relativePath,
        baseVersion: Number(input.baseVersion ?? 0),
        content: String(input.content ?? ""),
        actorUserId: agent.userId
      });
    }
    case "list_tasks": {
      const room = requireRoom(repo, String(input.roomId));
      assertToolPermissions(repo, agent, room, tool);
      const files = repo
        .listFiles(room.id)
        .filter((file) => !file.deleted_at && file.relative_path.endsWith(".md") && canAgent(repo, agent, room, "file:read", file.relative_path))
        .map((file) => ({ filePath: file.relative_path, content: repo.readFileContent(room.id, file.relative_path).content }));
      return { tasks: listTasks(files) };
    }
    case "create_task": {
      const room = requireRoom(repo, String(input.roomId));
      const relativePath = normalizeRelativePath(String(input.relativePath));
      assertToolPermissions(repo, agent, room, tool, relativePath);
      return semanticWrite(repo, agent, room, relativePath, (content) =>
        createTask({
          content,
          filePath: relativePath,
          heading: input.heading ? String(input.heading) : undefined,
          title: String(input.title),
          status: " ",
          metadata: { due: input.due ? String(input.due) : undefined }
        })
      );
    }
    case "update_task_status": {
      const room = requireRoom(repo, String(input.roomId));
      const relativePath = normalizeRelativePath(String(input.relativePath));
      assertToolPermissions(repo, agent, room, tool, relativePath);
      return semanticWrite(repo, agent, room, relativePath, (content) =>
        updateTaskStatus({
          content,
          lineNumber: Number(input.lineNumber),
          expectedLineHash: String(input.expectedLineHash),
          newStatus: String(input.newStatus)
        })
      );
    }
    case "create_kanban_card": {
      const room = requireRoom(repo, String(input.roomId));
      const relativePath = normalizeRelativePath(String(input.relativePath));
      assertToolPermissions(repo, agent, room, tool, relativePath);
      return semanticWrite(repo, agent, room, relativePath, (content) =>
        createKanbanCard({ content, laneTitle: String(input.laneTitle), title: String(input.title) })
      );
    }
    case "move_kanban_card": {
      const room = requireRoom(repo, String(input.roomId));
      const relativePath = normalizeRelativePath(String(input.relativePath));
      assertToolPermissions(repo, agent, room, tool, relativePath);
      return semanticWrite(repo, agent, room, relativePath, (content) =>
        moveKanbanCard({
          content,
          cardId: String(input.cardId),
          expectedLineHash: String(input.expectedLineHash),
          targetLaneTitle: String(input.targetLaneTitle),
          position: input.position === "top" ? "top" : "bottom"
        })
      );
    }
  }
}

function semanticWrite(repo: RelayRepository, agent: AgentPrincipal, room: RoomRow, relativePath: string, transform: (content: string) => string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { file, content } = repo.readFileContent(room.id, relativePath);
    try {
      return repo.writeFile({
        roomId: room.id,
        relativePath,
        baseVersion: file.version,
        content: transform(content),
        actorUserId: agent.userId
      });
    } catch (error) {
      lastError = error;
      if (!(error instanceof AppError) || error.code !== "VERSION_CONFLICT") {
        throw error;
      }
    }
  }
  throw lastError;
}

function authenticateAgent(repo: RelayRepository, authorization: string | undefined): AgentPrincipal {
  if (!authorization?.startsWith("Bearer ")) {
    throw new AppError("UNAUTHORIZED", "Invalid or expired credentials.", 401);
  }
  const agent = repo.authenticateAgentToken(authorization.slice("Bearer ".length));
  if (!agent || agent.revokedAt) {
    throw new AppError("UNAUTHORIZED", "Invalid or expired credentials.", 401);
  }
  return agent;
}

function assertToolPermissions(repo: RelayRepository, agent: AgentPrincipal, room: RoomRow, tool: McpToolName, relativePath = ""): void {
  for (const permission of requiredPermissionsForTool(tool)) {
    if (!canAgent(repo, agent, room, permission, relativePath)) {
      throw new AppError("PERMISSION_DENIED", `Agent does not have ${permission} permission.`, 403);
    }
  }
}

function canAgent(repo: RelayRepository, agent: AgentPrincipal, room: RoomRow, permission: Permission, relativePath = ""): boolean {
  return evaluatePolicy({
    teamId: room.team_id,
    subject: { type: "agent", id: agent.agentId },
    resource: permission.startsWith("room:")
      ? { type: "room", roomId: room.id, roomOwnerUserId: room.owner_user_id }
      : permission.startsWith("tool:")
        ? { type: "tool", roomId: room.id, relativePath, toolName: permission.slice("tool:".length) }
        : { type: "file", roomId: room.id, roomOwnerUserId: room.owner_user_id, relativePath },
    permission,
    aclRules: repo.listAclRulesForTeam(room.team_id)
  }).allowed;
}

function requireRoom(repo: RelayRepository, roomId: string): RoomRow {
  const room = repo.getRoom(roomId);
  if (!room) {
    throw new AppError("NOT_FOUND", "Room not found.", 404);
  }
  return room;
}

function redactInput(input: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...input };
  if ("content" in copy) {
    copy.content = "[redacted]";
  }
  return copy;
}
