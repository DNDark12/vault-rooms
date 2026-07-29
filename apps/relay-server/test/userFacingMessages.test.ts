import { describe, expect, it } from "vitest";
import type { Permission } from "@vault-rooms/protocol";
import { describePermission, formatFileLimit } from "../src/services/userFacingMessages.js";

// User-facing error messages (docs/superpowers/plans/2026-07-29-user-facing-error-messages.md).
// The relay owns the *specific* wording for a failure, so these helpers exist to keep wire
// identifiers out of it: a permission code and a byte constant are the two things that leaked into
// prose the most ("You do not have file:read permission", "The file exceeds MAX_FILE_BYTES").
describe("user-facing relay message helpers", () => {
  it("describes every permission without exposing the wire code", () => {
    const permissions: Permission[] = [
      "room:read",
      "room:write",
      "room:delete",
      "file:read",
      "file:write",
      "file:create",
      "file:delete",
      "sync:subscribe",
      "sync:push"
    ];
    for (const permission of permissions) {
      const description = describePermission(permission);
      expect(description, `${permission} still reads as a wire code`).not.toContain(":");
      expect(description.length).toBeGreaterThan(3);
    }
    // Distinct phrasing per permission, or a denial can't tell the user what they were actually
    // stopped from doing.
    expect(new Set(permissions.map(describePermission)).size).toBe(permissions.length);
  });

  it("stays exhaustive as the Permission union grows", async () => {
    // The switch has no `default` returning a string, so a new Permission is a compile error. This
    // asserts the union in the protocol package hasn't outgrown the table without anyone noticing.
    const fs = await import("node:fs");
    const types = fs.readFileSync(new URL("../../../packages/protocol/src/types.ts", import.meta.url), "utf8");
    const union = /export type Permission =([\s\S]*?);/.exec(types)?.[1] ?? "";
    const declared = [...union.matchAll(/"([a-z]+:[a-z]+)"/g)].map((match) => match[1]!);

    expect(declared.length).toBeGreaterThan(0);
    for (const permission of declared) {
      expect(() => describePermission(permission as Permission)).not.toThrow();
    }
  });

  it("formats byte limits as readable values", () => {
    expect(formatFileLimit(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatFileLimit(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatFileLimit(10 * 1024 * 1024)).toBe("10 MB");
  });

  it("steps the unit down so a small operator-set limit stays meaningful", () => {
    // MAX_FILE_BYTES is operator-set and can legitimately be tiny (this suite runs relays at 32 and
    // 1024 bytes). Always rendering megabytes would print "limit 0 MB", which reads as "uploads are
    // impossible" rather than "your file is too big".
    expect(formatFileLimit(512 * 1024)).toBe("512 KB");
    expect(formatFileLimit(1024)).toBe("1 KB");
    expect(formatFileLimit(1536)).toBe("1.5 KB");
    expect(formatFileLimit(32)).toBe("32 bytes");
    expect(formatFileLimit(32)).not.toContain("0 MB");
  });
});
