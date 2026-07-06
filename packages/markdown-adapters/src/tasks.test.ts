import { describe, expect, it } from "vitest";
import { AppError } from "@vault-rooms/protocol";
import { createTask, listTasks, updateTaskStatus } from "./tasks.js";

describe("tasks adapter", () => {
  it("lists Markdown tasks with snapshot-scoped ids and line hashes", () => {
    const tasks = listTasks([{ filePath: "Tasks.md", content: "# Tasks\n\n- [ ] Prepare demo\n- [x] Done\n- [/] In progress\n" }]);

    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({ filePath: "Tasks.md", lineNumber: 3, status: " ", title: "Prepare demo", rawLine: "- [ ] Prepare demo" });
    expect(tasks[0]?.id).toMatch(/^task_/);
    expect(tasks[0]?.lineHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates a task under an existing heading with metadata", () => {
    const content = "# Tasks\n\n## Todo\n\nExisting\n";
    expect(createTask({ content, filePath: "Tasks.md", heading: "Todo", title: "Prepare launch", status: " ", metadata: { due: "2026-07-10", priority: "high" } })).toBe(
      "# Tasks\n\n## Todo\n\nExisting\n- [ ] Prepare launch due:: 2026-07-10 priority:: high\n"
    );
  });

  it("updates task status only when the expected line hash matches", () => {
    const content = "- [ ] Prepare demo\nUnrelated\n";
    const [task] = listTasks([{ filePath: "Tasks.md", content }]);
    const updated = updateTaskStatus({ content, lineNumber: task!.lineNumber, expectedLineHash: task!.lineHash, newStatus: "x" });

    expect(updated).toBe("- [x] Prepare demo\nUnrelated\n");
    expect(() => updateTaskStatus({ content, lineNumber: task!.lineNumber, expectedLineHash: "bad", newStatus: "x" })).toThrow(AppError);
    try {
      updateTaskStatus({ content, lineNumber: task!.lineNumber, expectedLineHash: "bad", newStatus: "x" });
    } catch (error) {
      expect((error as AppError).code).toBe("ADAPTER_CONFLICT");
    }
  });
});
