export type MarkdownFile = {
  filePath: string;
  content: string;
};

export function detectLineEnding(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

export * from "./kanban.js";
export * from "./tasks.js";
