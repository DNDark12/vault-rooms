import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanBundle } from "../../../scripts/scan-bundle.mjs";

// Keeps bundle-policy checks in the regular test suite.
describe("CRDT bundle guard", () => {
  it("keeps the shipped main.js within the approved four-tier bundle policy", () => {
    const root = resolve(import.meta.dirname, "..", "..", "..");
    const bundle = readFileSync(resolve(root, "main.js"), "utf8");

    const { failed, lines } = scanBundle(bundle);

    expect(failed, lines.join("\n")).toBe(false);
  });
});
