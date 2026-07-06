import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

async function setupMcpFlow() {
  const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
  const owner = (
    await app.inject({
      method: "POST",
      url: "/api/teams/bootstrap",
      remoteAddress: "127.0.0.1",
      payload: { teamName: "Demo", ownerDisplayName: "A", ownerDeviceName: "A laptop" }
    })
  ).json();
  const room = (
    await app.inject({
      method: "POST",
      url: `/api/teams/${owner.team.id}/rooms`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Projects Demo", type: "folder", sourcePath: "Projects/Demo", mountName: "Projects Demo", capabilities: [] }
    })
  ).json().room;
  await app.inject({
    method: "PUT",
    url: `/api/rooms/${room.id}/files/content`,
    headers: { authorization: `Bearer ${owner.deviceToken}` },
    payload: { relativePath: "Tasks.md", baseVersion: 0, content: "# Tasks\n\n## Todo\n\n- [ ] Existing\n" }
  });
  await app.inject({
    method: "PUT",
    url: `/api/rooms/${room.id}/files/content`,
    headers: { authorization: `Bearer ${owner.deviceToken}` },
    payload: { relativePath: "Board.md", baseVersion: 0, content: "# Board\n\n## Todo\n\n- Card A\n\n## Doing\n\n" }
  });
  const agent = (
    await app.inject({
      method: "POST",
      url: `/api/teams/${owner.team.id}/agents`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { displayName: "Planning agent" }
    })
  ).json();

  return { app, owner, room, agent };
}

describe("MCP gateway", () => {
  it("scopes agent tools through ACL, runs semantic writes, and rejects revoked agents", async () => {
    const { app, owner, room, agent } = await setupMcpFlow();

    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: {
        subjectType: "agent",
        subjectId: agent.agent.id,
        effect: "allow",
        permissions: ["room:read", "file:read", "tool:list_tasks"],
        pathPattern: "**/*"
      }
    });

    const listRooms = await callTool(app, agent.agentToken, "list_rooms", {});
    expect(listRooms.statusCode).toBe(200);
    expect(listRooms.json().result.rooms).toEqual([expect.objectContaining({ id: room.id, name: "Projects Demo" })]);

    const readFile = await callTool(app, agent.agentToken, "read_file", { roomId: room.id, relativePath: "Tasks.md" });
    expect(readFile.statusCode).toBe(200);
    expect(readFile.json().result).toMatchObject({ relativePath: "Tasks.md", content: expect.stringContaining("Existing") });

    const deniedWrite = await callTool(app, agent.agentToken, "write_file", { roomId: room.id, relativePath: "Tasks.md", baseVersion: 1, content: "no" });
    expect(deniedWrite.statusCode).toBe(403);
    expect(deniedWrite.json().error.code).toBe("PERMISSION_DENIED");

    const listedTasks = await callTool(app, agent.agentToken, "list_tasks", { roomId: room.id, glob: "**/*.md" });
    expect(listedTasks.statusCode).toBe(200);
    expect(listedTasks.json().result.tasks[0]).toMatchObject({ title: "Existing", filePath: "Tasks.md" });

    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: {
        subjectType: "agent",
        subjectId: agent.agent.id,
        effect: "allow",
        permissions: ["file:write", "tool:create_task", "tool:create_kanban_card"],
        pathPattern: "**/*"
      }
    });

    const createTask = await callTool(app, agent.agentToken, "create_task", {
      roomId: room.id,
      relativePath: "Tasks.md",
      title: "Prepare launch checklist",
      heading: "Todo",
      due: "2026-07-10"
    });
    expect(createTask.statusCode).toBe(200);
    expect(createTask.json().result.version).toBe(2);

    const createCardA = await callTool(app, agent.agentToken, "create_kanban_card", {
      roomId: room.id,
      relativePath: "Board.md",
      laneTitle: "Todo",
      title: "Draft API contract"
    });
    expect(createCardA.statusCode).toBe(200);
    const createCardB = await callTool(app, agent.agentToken, "create_kanban_card", {
      roomId: room.id,
      relativePath: "Board.md",
      laneTitle: "Todo",
      title: "Review API contract"
    });
    expect(createCardB.statusCode).toBe(200);
    const board = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/files/content?path=Board.md`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(board.json().content).toContain("- Draft API contract");
    expect(board.json().content).toContain("- Review API contract");

    const limitedAgent = (
      await app.inject({
        method: "POST",
        url: `/api/teams/${owner.team.id}/agents`,
        headers: { authorization: `Bearer ${owner.deviceToken}` },
        payload: { displayName: "Limited agent" }
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/acl`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { subjectType: "agent", subjectId: limitedAgent.agent.id, effect: "allow", permissions: ["room:read", "file:read"], pathPattern: "allowed/**/*" }
    });
    const outside = await callTool(app, limitedAgent.agentToken, "read_file", { roomId: room.id, relativePath: "Tasks.md" });
    expect(outside.statusCode).toBe(403);

    const revoke = await app.inject({
      method: "POST",
      url: `/api/teams/${owner.team.id}/agents/${agent.agent.id}/revoke`,
      headers: { authorization: `Bearer ${owner.deviceToken}` }
    });
    expect(revoke.statusCode).toBe(200);
    const afterRevoke = await callTool(app, agent.agentToken, "list_rooms", {});
    expect(afterRevoke.statusCode).toBe(401);
  });
});

function callTool(app: Awaited<ReturnType<typeof createApp>>, token: string, tool: string, input: unknown) {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${token}` },
    payload: { tool, input }
  });
}
