import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Room Manage style contract", () => {
  it("puts the horizontal inset on the card and clears child Setting padding", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(css).toMatch(
      /\.vault-rooms-settings-card\s*\{[^}]*padding-inline:\s*14px;[^}]*\}/s
    );
    expect(css).toMatch(
      /\.vault-rooms-settings-card\s*>\s*\.setting-item\s*\{[^}]*padding-left:\s*0;[^}]*padding-right:\s*0;[^}]*\}/s
    );
  });

  it("keeps the header outside a body-only scroll area without horizontal overflow", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(css).toMatch(
      /\.vault-rooms-settings-modal\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;[^}]*\}/s
    );
    expect(css).toMatch(
      /\.vault-rooms-settings-scroll\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;[^}]*\}/s
    );
  });

  it("applies the same inset to disclosure and danger sections without double-insetting hints", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(css).toMatch(
      /\.vault-rooms-settings-disclosure\s*\{[^}]*padding-left:\s*14px;[^}]*padding-right:\s*14px;[^}]*\}/s
    );
    expect(css).toMatch(
      /\.vault-rooms-room-danger-zone\s*\{[^}]*padding-left:\s*14px;[^}]*padding-right:\s*14px;[^}]*\}/s
    );
    expect(css).toMatch(
      /\.vault-rooms-room-danger-zone\s*>\s*\.setting-item\.vault-rooms-danger-action\s*\{[^}]*border-top:\s*0;[^}]*\}/s
    );
    expect(css).toMatch(
      /\.vault-rooms-advanced-settings\s*>\s*\.vault-rooms-setting-hint\s*\{[^}]*margin:\s*8px 0 10px;[^}]*\}/s
    );
  });

  it("uses a responsive grid for plugin suggestion controls", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(css).toMatch(
      /\.vault-rooms-capability-row\s+\.setting-item-control\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;[^}]*\}/s
    );
  });
});
