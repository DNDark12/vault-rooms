// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import type VaultRoomsPlugin from "../main.js";
import { PANEL_COPY } from "../views/panelCopy.js";
import type { PausedPathGroup } from "../views/pausedPathModel.js";
import { PausedPathsModal } from "./PausedPathsModal.js";
import { confirmModal } from "./ConfirmModal.js";

vi.mock("./ConfirmModal.js", () => ({ confirmModal: vi.fn().mockResolvedValue(true) }));

vi.mock("obsidian", () => {
  class Modal {
    readonly contentEl = document.createElement("div");
    constructor(readonly app: unknown) {}
    setTitle(): void {}
    open(): void {}
  }
  class Setting {
    readonly settingEl = document.createElement("div");
    constructor(parent: HTMLElement) { parent.append(this.settingEl); }
    setName(text: string): this { this.settingEl.append(document.createTextNode(text)); return this; }
    setDesc(text: string): this { this.settingEl.append(document.createTextNode(text)); return this; }
    addText(cb: (text: unknown) => void): this {
      const inputEl = document.createElement("input"); this.settingEl.append(inputEl);
      const text = { inputEl, setValue(value: string) { inputEl.value = value; return this; },
        setPlaceholder(value: string) { inputEl.placeholder = value; return this; },
        onChange(change: (value: string) => void) { inputEl.addEventListener("input", () => change(inputEl.value)); return this; } };
      cb(text); return this;
    }
    addButton(cb: (button: unknown) => void): this {
      const buttonEl = document.createElement("button"); this.settingEl.append(buttonEl);
      const button = { buttonEl, setButtonText(text: string) { buttonEl.textContent = text; return this; },
        onClick(click: () => unknown) { buttonEl.addEventListener("click", () => void click()); return this; } };
      cb(button); return this;
    }
  }
  return { Modal, Setting, Notice: vi.fn() };
});

beforeAll(() => {
  HTMLElement.prototype.empty = function (): void { this.replaceChildren(); };
  HTMLElement.prototype.createDiv = function (options = {}): HTMLDivElement { return this.createEl("div", options); };
  HTMLElement.prototype.createEl = function <K extends keyof HTMLElementTagNameMap>(tag: K, options: { text?: string; cls?: string } = {}): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    if (options.text) element.textContent = options.text;
    if (options.cls) element.className = options.cls;
    this.append(element); return element;
  };
});

function harness(groups: PausedPathGroup[], owner = false) {
  const plugin = {
    app: {}, visibleRooms: [{ id: "daily", ownerUserId: "owner" }],
    getActiveServer: () => ({ userId: owner ? "owner" : "member" }),
    listRoomPausedPaths: () => groups,
    refreshRoomPausedPaths: vi.fn().mockResolvedValue(undefined),
    repairLocalRoomPath: vi.fn().mockResolvedValue(undefined),
    retryRoomPathRecovery: vi.fn().mockResolvedValue(undefined),
    abandonRoomPathIntents: vi.fn().mockResolvedValue(undefined),
    openRoomSettingsModal: vi.fn()
  };
  const modal = new PausedPathsModal(plugin as unknown as VaultRoomsPlugin, "daily");
  return { modal, plugin };
}

describe("paused path recovery", () => {
  it("offers explicit preservation and reload even when a tracked alias has no disk file to rename", async () => {
    const { modal, plugin } = harness([{ key: "board.md", paths: ["Board.md", "board.md"], reason: "local-collision", pendingIntentCount: 0 }]);
    await modal.onOpen();
    const preserve = Array.from(modal.contentEl.querySelectorAll("button"))
      .find((button) => button.textContent === PANEL_COPY.pausedPaths.preserveReload);
    expect(preserve).toBeDefined();
    preserve!.click();
    await vi.waitFor(() => expect(plugin.abandonRoomPathIntents).toHaveBeenCalledWith("daily", "board.md"));
    expect(confirmModal).toHaveBeenCalled();
  });

  it("lets a member repair an exact local alias without offering server ownership actions", async () => {
    const { modal, plugin } = harness([{ key: "board.md", paths: ["Board.md", "board.md"], reason: "local-collision", pendingIntentCount: 0 }]);
    await modal.onOpen();
    expect(modal.contentEl.textContent).toContain(PANEL_COPY.pausedPaths.localCollision);
    expect(modal.contentEl.textContent).not.toContain(PANEL_COPY.pausedPaths.ownerRepair);
    const input = modal.contentEl.querySelector("input")!;
    input.value = "Local Board.md"; input.dispatchEvent(new Event("input"));
    Array.from(modal.contentEl.querySelectorAll("button"))
      .find((button) => button.textContent === PANEL_COPY.pausedPaths.localRename)!.click();
    await vi.waitFor(() => expect(plugin.repairLocalRoomPath).toHaveBeenCalledWith("daily", "Board.md", "Local Board.md"));
  });

  it("routes only the actual room owner to server collision repair", async () => {
    const groups: PausedPathGroup[] = [{ key: "board.md", paths: ["Board.md", "board.md"], reason: "server-collision", pendingIntentCount: 0 }];
    const member = harness(groups);
    await member.modal.onOpen();
    expect(member.modal.contentEl.textContent).toContain(PANEL_COPY.pausedPaths.askOwner);
    expect(member.modal.contentEl.textContent).not.toContain(PANEL_COPY.pausedPaths.ownerRepair);
    const owner = harness(groups, true);
    await owner.modal.onOpen();
    Array.from(owner.modal.contentEl.querySelectorAll("button"))
      .find((button) => button.textContent === PANEL_COPY.pausedPaths.ownerRepair)!.click();
    expect(owner.plugin.openRoomSettingsModal).toHaveBeenCalledWith(owner.plugin.visibleRooms[0]);
  });

  it("retains the draft and offers retry after local preservation fails", async () => {
    const { modal, plugin } = harness([{ key: "board.md", paths: ["Board.md", "board.md"], reason: "local-collision", pendingIntentCount: 0 }]);
    plugin.repairLocalRoomPath.mockRejectedValueOnce(new Error("Disk write failed"));
    await modal.onOpen();
    const input = modal.contentEl.querySelector("input")!;
    input.value = "Saved Board.md"; input.dispatchEvent(new Event("input"));
    Array.from(modal.contentEl.querySelectorAll("button"))
      .find((button) => button.textContent === PANEL_COPY.pausedPaths.localRename)!.click();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain("Disk write failed"));
    expect(modal.contentEl.querySelector("input")?.value).toBe("Saved Board.md");
    expect(modal.contentEl.querySelector("button")?.disabled).toBe(false);
  });

  it("shows persisted recovery failures and retries authoritative recovery", async () => {
    const { modal, plugin } = harness([{ key: "board.md", paths: ["Board.md"], reason: "recovery-pending", error: "Disk is full", pendingIntentCount: 0 }]);
    await modal.onOpen();
    expect(modal.contentEl.textContent).toContain("Disk is full");
    Array.from(modal.contentEl.querySelectorAll("button"))
      .find((button) => button.textContent === PANEL_COPY.pausedPaths.retry)!.click();
    await vi.waitFor(() => expect(plugin.retryRoomPathRecovery).toHaveBeenCalledWith("daily"));
  });
});
