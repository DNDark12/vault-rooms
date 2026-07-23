import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanBundle } from "../../../scripts/scan-bundle.mjs";

// Guards the committed root main.js against the four-tier bundle policy from
// docs/superpowers/plans/2026-07-20-crdt-sync.md Phase 0.1 (contract P1-g). `pnpm build:plugin`
// already fails closed on this via scripts/scan-bundle.mjs; this test gives the same signal under
// `pnpm test` (e.g. in CI runs that don't invoke the build script) so a regression can't land
// without a red test, not just a red build step someone might not run locally.
describe("CRDT bundle guard", () => {
  it("keeps the shipped main.js within the approved four-tier bundle policy", () => {
    const root = resolve(import.meta.dirname, "..", "..", "..");
    const bundle = readFileSync(resolve(root, "main.js"), "utf8");

    const { failed, lines } = scanBundle(bundle);

    expect(failed, lines.join("\n")).toBe(false);
  });
});
