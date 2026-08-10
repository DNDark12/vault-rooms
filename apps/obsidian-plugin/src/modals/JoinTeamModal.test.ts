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
  it("offers manual discovery only after a pinned invite endpoint fails", async () => {
    const plugin = {
      app: {},
      joinServer: vi.fn().mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED")),
      findInviteServerOnLan: vi.fn().mockResolvedValue("https://192.168.1.40:8788")
    };
    const modal = new JoinTeamModal(plugin as never, "join", "https://old.local:8788", "tr_inv_secret", pin);

    modal.onOpen();
    expect(ui.buttons.map((button) => button.text)).not.toContain("Find server on LAN");

    await ui.buttons.find((button) => button.text === "Join")!.click!();
    expect(ui.buttons.map((button) => button.text)).toContain("Find server on LAN");
    expect(plugin.findInviteServerOnLan).not.toHaveBeenCalled();

    await ui.buttons.find((button) => button.text === "Find server on LAN")!.click!();
    expect(plugin.findInviteServerOnLan).toHaveBeenCalledWith(pin, "https://old.local:8788");
    expect(plugin.joinServer).toHaveBeenCalledOnce();
  });

  it("never offers discovery for a plain invite", async () => {
    const plugin = {
      app: {},
      joinServer: vi.fn().mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED")),
      findInviteServerOnLan: vi.fn()
    };
    const modal = new JoinTeamModal(plugin as never, "join", "http://192.168.1.2:8787", "tr_inv_secret");

    modal.onOpen();
    await ui.buttons.find((button) => button.text === "Join")!.click!();

    expect(ui.buttons.map((button) => button.text)).not.toContain("Find server on LAN");
    expect(plugin.findInviteServerOnLan).not.toHaveBeenCalled();
  });
});
