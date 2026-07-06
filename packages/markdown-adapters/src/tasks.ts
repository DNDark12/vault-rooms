import { AppError } from "@vault-rooms/protocol";
import type { MarkdownFile } from "./index.js";
import { joinMarkdown, sha256, splitMarkdown } from "./markdown.js";

export type ParsedTask = {
  id: string;
  filePath: string;
  lineNumber: number;
  lineHash: string;
  status: string;
  title: string;
  rawLine: string;
};

const TASK_RE = /^(\s*)- \[([^\]])\] (.*)$/;

export function listTasks(files: MarkdownFile[]): ParsedTask[] {
  return files.flatMap((file) => {
    const { lines } = splitMarkdown(file.content);
    return lines.flatMap((rawLine, index) => {
      const match = TASK_RE.exec(rawLine);
      if (!match) {
        return [];
      }
      const lineNumber = index + 1;
      return {
        id: `task_${sha256(`${file.filePath}:${lineNumber}:${rawLine}`)}`,
        filePath: file.filePath,
        lineNumber,
        lineHash: sha256(rawLine),
        status: match[2] ?? " ",
        title: match[3] ?? "",
        rawLine
      };
    });
  });
}

export function createTask(input: {
  content: string;
  filePath: string;
  heading?: string;
  title: string;
  status?: " " | "x";
  metadata?: { due?: string; scheduled?: string; priority?: string };
}): string {
  const { lines, eol } = splitMarkdown(input.content);
  const status = input.status ?? " ";
  const metadata = [
    input.metadata?.due ? `due:: ${input.metadata.due}` : null,
    input.metadata?.scheduled ? `scheduled:: ${input.metadata.scheduled}` : null,
    input.metadata?.priority ? `priority:: ${input.metadata.priority}` : null
  ].filter(Boolean);
  const line = `- [${status}] ${input.title}${metadata.length ? ` ${metadata.join(" ")}` : ""}`;
  let insertAt = lines.length;
  if (lines.at(-1) === "") {
    insertAt -= 1;
  }

  if (input.heading) {
    const headingIndex = lines.findIndex((candidate) => /^#{1,6}\s+(.+)$/.exec(candidate)?.[1] === input.heading);
    if (headingIndex < 0) {
      throw new AppError("ADAPTER_CONFLICT", `Heading not found: ${input.heading}`, 409);
    }
    insertAt = findSectionEnd(lines, headingIndex);
    if (lines[insertAt - 1] === "") {
      insertAt -= 1;
    }
  }

  lines.splice(insertAt, 0, line);
  return joinMarkdown(lines, eol);
}

export function updateTaskStatus(input: { content: string; lineNumber: number; expectedLineHash: string; newStatus: string }): string {
  const { lines, eol } = splitMarkdown(input.content);
  const index = input.lineNumber - 1;
  const rawLine = lines[index];
  if (!rawLine || sha256(rawLine) !== input.expectedLineHash) {
    throw new AppError("ADAPTER_CONFLICT", "Task line changed before it could be updated.", 409);
  }
  if (!TASK_RE.test(rawLine)) {
    throw new AppError("ADAPTER_CONFLICT", "Target line is no longer a Markdown task.", 409);
  }
  lines[index] = rawLine.replace(/^(\s*)- \[[^\]]\]/, `$1- [${input.newStatus}]`);
  return joinMarkdown(lines, eol);
}

function findSectionEnd(lines: string[], headingIndex: number): number {
  const level = /^#+/.exec(lines[headingIndex] ?? "")?.[0].length ?? 6;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+/.exec(lines[index] ?? "");
    if (match && (match[1]?.length ?? 7) <= level) {
      return index;
    }
  }
  return lines.length;
}
