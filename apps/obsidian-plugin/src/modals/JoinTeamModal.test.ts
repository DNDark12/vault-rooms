import { beforeEach, describe, expect, it, vi } from "vitest";
import { JoinTeamModal } from "./JoinTeamModal.js";

const ui = vi.hoisted(() => ({ buttons: [] as Array<{ text: string; click?: () => Promise<void> | void }> }));

vi.mock("obsidian", () => {
  class Modal {
    app: unknown;
    contentEl = {
      empty: () => {
        ui.buttons = [];
      },
      createEl: () => ({})
    };
    constructor(app: unknown) {
      this.app = app;
    }
    setTitle(): void {}
    close(): void {}
  }
  class Setting {
    constructor(_el: unknown) {}
    setName(): this { return this; }
    setDesc(): this { return this; }
    addText(callback: (text: unknown) => void): this {
      callback({
        inputEl: { focus: vi.fn() },
        setValue: () => ({ onChange: () => undefined }),
        setPlaceholder: () => ({ setValue: () => ({ onChange: () => undefined }) })
      });
      return this;
    }
    addButton(callback: (button: unknown) => void): this {
      const state = { text: "", click: undefined as (() => Promise<void> | void) | undefined };
      const button = {
        setCta: () => button,
        setButtonText: (text: string) => { state.text = text; return button; },
        setDisabled: () => button,
        onClick: (click: () => Promise<void> | void) => { state.click = click; return button; }
      };
      callback(button);
      ui.buttons.push(state);
      return this;
    }
  }
  return { Modal, Notice: class Notice {}, Platform: { isMacOS: true, isWin: false, isLinux: false }, Setting };
});

const pin = {
  serverId: "srv_1",
  tlsName: "srv-1.vault-rooms.internal",
  identityCertificateDer: "certificate",
  pinnedIdentitySpkiSha256: "fingerprint"
};

beforeEach(() => {
  ui.buttons = [];
  vi.stubGlobal("window", { setTimeout: (callback: () => void) => callback() });
});

describe("JoinTeamModal LAN recovery", () => {
  it("never renders a manual discovery button - joinServer owns the recovery", async () => {
    const plugin = {
      app: {},
      joinServer: vi.fn().mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"))
    };
    const modal = new JoinTeamModal(plugin as never, "join", "https://old.local:8788", "tr_inv_secret", pin);

    modal.onOpen();
    expect(ui.buttons.map((button) => button.text)).not.toContain("Find server on LAN");

    // A failed join must not grow a second affordance: `joinServer` already searched the LAN itself,
    // so a button here could only repeat the search that just failed.
    await ui.buttons.find((button) => button.text === "Join")!.click!();
    expect(ui.buttons.map((button) => button.text)).not.toContain("Find server on LAN");
    expect(plugin.joinServer).toHaveBeenCalledOnce();
  });

  it("submits the invite exactly as the link supplied it, pin included", async () => {
    const plugin = { app: {}, joinServer: vi.fn().mockResolvedValue(undefined) };
    const modal = new JoinTeamModal(plugin as never, "join", "https://old.local:8788", "tr_inv_secret", pin);

    modal.onOpen();
    await ui.buttons.find((button) => button.text === "Join")!.click!();

    expect(plugin.joinServer).toHaveBeenCalledWith(
      "https://old.local:8788",
      "tr_inv_secret",
      "",
      "Obsidian desktop",
      pin
    );
  });
});
