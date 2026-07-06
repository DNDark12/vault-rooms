import { describe, expect, it } from "vitest";
import { AppError } from "@vault-rooms/protocol";
import { createKanbanCard, moveKanbanCard, parseKanban } from "./kanban.js";

const board = `---
kanban-plugin: basic
---
# Board

## Todo

- Card A
- Card B

## Doing

- Card C
`;

describe("kanban adapter", () => {
  it("parses heading-lane boards without corrupting frontmatter", () => {
    const parsed = parseKanban(board);

    expect(parsed.lanes).toHaveLength(2);
    expect(parsed.lanes[0]).toMatchObject({ title: "Todo", headingLine: 6 });
    expect(parsed.lanes[0]?.cards[0]).toMatchObject({ title: "Card A", lineNumber: 8, rawLine: "- Card A" });
    expect(parsed.lanes[0]?.cards[0]?.id).toMatch(/^card_/);
  });

  it("creates cards in an existing lane and preserves unrelated content", () => {
    const updated = createKanbanCard({ content: board, laneTitle: "Doing", title: "Card D" });

    expect(updated).toContain("## Doing\n\n- Card C\n- Card D\n");
    expect(updated.startsWith("---\nkanban-plugin: basic\n---")).toBe(true);
  });

  it("moves cards by id and hash, and rejects stale hashes", () => {
    const card = parseKanban(board).lanes[0]!.cards[0]!;
    const moved = moveKanbanCard({ content: board, cardId: card.id, expectedLineHash: card.lineHash, targetLaneTitle: "Doing", position: "bottom" });

    expect(moved).toContain("## Todo\n\n- Card B\n");
    expect(moved).toContain("## Doing\n\n- Card C\n- Card A\n");
    expect(() => moveKanbanCard({ content: board, cardId: card.id, expectedLineHash: "bad", targetLaneTitle: "Doing" })).toThrow(AppError);
    try {
      moveKanbanCard({ content: board, cardId: card.id, expectedLineHash: "bad", targetLaneTitle: "Doing" });
    } catch (error) {
      expect((error as AppError).code).toBe("ADAPTER_CONFLICT");
    }
  });
});
