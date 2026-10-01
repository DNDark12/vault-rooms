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

  it("rejects the os module however it is required, without flagging words that merely contain it", () => {
    // Otherwise-compliant bundle text, so only the os reference decides the outcome.
    const bundle = (code: string) => `new WebSocketServer({noServer:true,maxPayload:1});${code}`;

    expect(scanBundle(bundle('const photos="chaos";')).failed).toBe(false);
    expect(scanBundle(bundle('const a=require("os");')).failed).toBe(true);
    expect(scanBundle(bundle("const a=require('node:os');")).failed).toBe(true);
    expect(scanBundle(bundle('import { networkInterfaces } from "os";')).failed).toBe(true);
  });
});
