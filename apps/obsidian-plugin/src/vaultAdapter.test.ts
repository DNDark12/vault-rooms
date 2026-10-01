import { describe, expect, it } from "vitest";
import type { Plugin } from "obsidian";
import { ObsidianVaultAdapter } from "./vaultAdapter.js";

function adapterOver(bytes: Uint8Array, decoded: string): ObsidianVaultAdapter {
  const file = { path: "Room/export.csv", extension: "csv" };
  const vault = {
    getAbstractFileByPath: (path: string) => (path === file.path ? file : null),
    readBinary: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    read: async () => decoded
  };
  return new ObsidianVaultAdapter({ app: { vault } } as unknown as Plugin);
}

describe("ObsidianVaultAdapter.readStrictUtf8", () => {
  it("returns UTF-8 text unchanged", async () => {
    const adapter = adapterOver(new TextEncoder().encode("name\ncafé"), "name\ncafé");

    await expect(adapter.readStrictUtf8("Room/export.csv")).resolves.toBe("name\ncafé");
  });

  it("refuses a file in another encoding rather than returning replacement characters", async () => {
    // "café" saved as Windows-1252.
    const adapter = adapterOver(new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x63, 0x61, 0x66, 0xe9]), "name\ncaf�");

    await expect(adapter.readStrictUtf8("Room/export.csv")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
