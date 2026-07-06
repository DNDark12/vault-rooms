import { AppError } from "@vault-rooms/protocol";
import { findFrontmatterEnd, joinMarkdown, sha256, splitMarkdown } from "./markdown.js";

export type KanbanBoard = { lanes: KanbanLane[] };
export type KanbanLane = { title: string; headingLine: number; cards: KanbanCard[] };
export type KanbanCard = {
  id: string;
  laneTitle: string;
  lineNumber: number;
  lineHash: string;
  title: string;
  rawLine: string;
};

export function parseKanban(content: string): KanbanBoard {
  const { lines } = splitMarkdown(content);
  const lanes: KanbanLane[] = [];
  let current: KanbanLane | null = null;
  for (let index = findFrontmatterEnd(lines); index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const heading = /^##\s+(.+)$/.exec(rawLine);
    if (heading) {
      current = { title: heading[1] ?? "", headingLine: index + 1, cards: [] };
      lanes.push(current);
      continue;
    }
    const card = /^- (.+)$/.exec(rawLine);
    if (card && current) {
      current.cards.push({
        id: `card_${sha256(`${current.title}:${index + 1}:${rawLine}`)}`,
        laneTitle: current.title,
        lineNumber: index + 1,
        lineHash: sha256(rawLine),
        title: card[1] ?? "",
        rawLine
      });
    }
  }
  return { lanes };
}

export function createKanbanCard(input: { content: string; laneTitle: string; title: string }): string {
  const { lines, eol } = splitMarkdown(input.content);
  const headingIndex = findLaneHeading(lines, input.laneTitle);
  if (headingIndex < 0) {
    throw new AppError("ADAPTER_CONFLICT", `Lane not found: ${input.laneTitle}`, 409);
  }
  const insertAt = trimTrailingBlankBeforeInsert(lines, findLaneEnd(lines, headingIndex));
  lines.splice(insertAt, 0, `- ${input.title}`);
  return joinMarkdown(lines, eol);
}

export function moveKanbanCard(input: {
  content: string;
  cardId: string;
  expectedLineHash: string;
  targetLaneTitle: string;
  position?: "top" | "bottom";
}): string {
  const parsed = parseKanban(input.content);
  const card = parsed.lanes.flatMap((lane) => lane.cards).find((candidate) => candidate.id === input.cardId);
  if (!card) {
    throw new AppError("ADAPTER_CONFLICT", "Card not found.", 409);
  }
  if (card.lineHash !== input.expectedLineHash) {
    throw new AppError("ADAPTER_CONFLICT", "Card line changed before it could be moved.", 409);
  }

  const { lines, eol } = splitMarkdown(input.content);
  lines.splice(card.lineNumber - 1, 1);
  const targetHeading = findLaneHeading(lines, input.targetLaneTitle);
  if (targetHeading < 0) {
    throw new AppError("ADAPTER_CONFLICT", `Lane not found: ${input.targetLaneTitle}`, 409);
  }
  const insertAt = input.position === "top" ? firstCardPosition(lines, targetHeading) : trimTrailingBlankBeforeInsert(lines, findLaneEnd(lines, targetHeading));
  lines.splice(insertAt, 0, card.rawLine);
  return joinMarkdown(lines, eol);
}

function findLaneHeading(lines: string[], laneTitle: string): number {
  return lines.findIndex((line) => /^##\s+(.+)$/.exec(line)?.[1] === laneTitle);
}

function findLaneEnd(lines: string[], headingIndex: number): number {
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index] ?? "")) {
      return index;
    }
  }
  return lines.length;
}

function firstCardPosition(lines: string[], headingIndex: number): number {
  let index = headingIndex + 1;
  while (lines[index] === "") {
    index += 1;
  }
  return index;
}

function trimTrailingBlankBeforeInsert(lines: string[], insertAt: number): number {
  let target = insertAt;
  if (target === lines.length && lines[target - 1] === "") {
    target -= 1;
  }
  return target;
}
