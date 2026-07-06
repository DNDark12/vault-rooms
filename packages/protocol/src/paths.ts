import { AppError } from "./errors.js";

const DRIVE_LETTER = /^[a-zA-Z]:[\\/]/;
const ELIGIBLE_EXTENSIONS = new Set([".md", ".txt", ".canvas", ".json", ".csv"]);

export function normalizeRelativePath(input: string): string {
  if (!input || input.includes("\0") || input.startsWith("/") || input.startsWith("\\") || DRIVE_LETTER.test(input)) {
    throw new AppError("INVALID_PATH", "Path must be a safe relative path.", 422);
  }
  const normalized = input.replaceAll("\\", "/").replace(/\/+/g, "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new AppError("INVALID_PATH", "Path must not contain empty, hidden, current, or parent segments.", 422);
  }
  return segments.join("/");
}

export function contentTypeForPath(path: string): "markdown" | "text" {
  return path.toLowerCase().endsWith(".md") ? "markdown" : "text";
}

export function isEligibleTextPath(path: string): boolean {
  const lastDot = path.lastIndexOf(".");
  return lastDot >= 0 && ELIGIBLE_EXTENSIONS.has(path.slice(lastDot).toLowerCase());
}
