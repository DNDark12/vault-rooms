import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Vault Rooms settings layout", () => {
  it("stacks imperative settings inside the Obsidian 1.13 render wrapper", async () => {
    const [source, css] = await Promise.all([
      readFile(new URL("../src/VaultRoomsSettingTab.ts", import.meta.url), "utf8"),
      readFile(new URL("../styles.css", import.meta.url), "utf8")
    ]);

    expect(source).toContain('setting.settingEl.addClass("vault-rooms-settings-root")');
    expect(css).toMatch(/\.vault-rooms-settings-root\s*\{[^}]*display:\s*block;/s);
  });

  it("does not imply that entering a hostname creates one", async () => {
    const [settings, modal] = await Promise.all([
      readFile(new URL("../src/VaultRoomsSettingTab.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/modals/UpdateServerAddressModal.ts", import.meta.url), "utf8")
    ]);

    expect(settings).toMatch(/hostname must already exist/i);
    expect(modal).toMatch(/does not create/i);
  });
});
