export function fileContentByteLength(content: string, encoding: "utf8" | "base64"): number {
  return encoding === "base64" ? Buffer.from(content, "base64").byteLength : Buffer.byteLength(content, "utf8");
}
