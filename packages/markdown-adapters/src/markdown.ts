import { createHash } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function splitMarkdown(content: string): { lines: string[]; eol: "\r\n" | "\n" } {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  return { lines: content.split(/\r?\n/), eol };
}

export function joinMarkdown(lines: string[], eol: "\r\n" | "\n"): string {
  return lines.join(eol);
}

export function findFrontmatterEnd(lines: string[]): number {
  if (lines[0] !== "---") {
    return 0;
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      return index + 1;
    }
  }
  return 0;
}
