// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AclRuleSummary, RoomSummary } from "../apiClient.js";
import { EDITOR_PERMISSION_SET } from "../accessPresentation.js";
import { RoomSettingsModal } from "./RoomSettingsModal.js";
import { confirmModal } from "./ConfirmModal.js";

vi.mock("obsidian", () => {
  class ButtonComponent {
    readonly buttonEl = document.createElement("button");
    // The real component appends itself when constructed with a container; Setting.addButton
    // constructs it without one and appends buttonEl itself.
    constructor(container?: HTMLElement) { container?.append(this.buttonEl); }
    setButtonText(text: string): this { this.buttonEl.textContent = text; return this; }
    setIcon(icon: string): this { this.buttonEl.dataset.icon = icon; return this; }
    setTooltip(text: string): this { this.buttonEl.title = text; return this; }
    setCta(): this { this.buttonEl.classList.add("mod-cta"); return this; }
    onClick(callback: () => unknown): this {
      this.buttonEl.addEventListener("click", () => void callback());
      return this;
    }
  }
  class TextComponent {
    readonly inputEl = document.createElement("input");
    setValue(value: string): this { this.inputEl.value = value; return this; }
    setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
    onChange(callback: (value: string) => unknown): this {
      this.inputEl.addEventListener("input", () => void callback(this.inputEl.value));
      return this;
    }
  }
  class DropdownComponent {
    readonly selectEl = document.createElement("select");
    addOption(value: string, label: string): this {
      this.selectEl.append(new Option(label, value));
      return this;
    }
    setValue(value: string): this { this.selectEl.value = value; return this; }
    onChange(callback: (value: string) => unknown): this {
      this.selectEl.addEventListener("change", () => void callback(this.selectEl.value));
      return this;
    }
  }
  class ToggleComponent {
    readonly toggleEl = document.createElement("input");
    constructor() { this.toggleEl.type = "checkbox"; }
    setValue(value: boolean): this { this.toggleEl.checked = value; return this; }
    onChange(callback: (value: boolean) => unknown): this {
      this.toggleEl.addEventListener("change", () => void callback(this.toggleEl.checked));
      return this;
    }
  }
  class Setting {
    readonly settingEl = document.createElement("div");
    private readonly infoEl = document.createElement("div");
    private readonly controlsEl = document.createElement("div");
    constructor(container: HTMLElement) {
      this.settingEl.className = "setting-item";
      this.settingEl.append(this.infoEl, this.controlsEl);
      container.append(this.settingEl);
    }
    setName(text: string): this {
      const name = document.createElement("div");
      name.className = "setting-item-name";
      name.textContent = text;
      this.infoEl.append(name);
      return this;
    }
    setDesc(text: string): this {
      const desc = document.createElement("div");
      desc.textContent = text;
      this.infoEl.append(desc);
      return this;
    }
    setHeading(): this { return this; }
    addButton(callback: (button: ButtonComponent) => unknown): this {
      const component = new ButtonComponent();
      this.controlsEl.append(component.buttonEl);
      callback(component);
      return this;
    }
    addText(callback: (text: TextComponent) => unknown): this {
      const component = new TextComponent();
      this.controlsEl.append(component.inputEl);
      callback(component);
      return this;
    }
    addDropdown(callback: (dropdown: DropdownComponent) => unknown): this {
      const component = new DropdownComponent();
      this.controlsEl.append(component.selectEl);
      callback(component);
      return this;
    }
    addToggle(callback: (toggle: ToggleComponent) => unknown): this {
      const component = new ToggleComponent();
      this.controlsEl.append(component.toggleEl);
      callback(component);
      return this;
    }
  }
  class Modal {
    readonly contentEl = document.createElement("div");
    readonly app: unknown;
    title = "";
    closed = false;
    constructor(app: unknown) { this.app = app; }
    setTitle(title: string): void { this.title = title; }
    close(): void { this.closed = true; }
  }
  return {
    ButtonComponent,
    Modal,
    Notice: class Notice {},
    Setting
  };
});

vi.mock("./ConfirmModal.js", () => ({
  confirmModal: vi.fn(async () => true)
}));
vi.mock("./pickers.js", () => ({
  pluginOptions: vi.fn(() => []),
  VaultPathSuggestModal: class VaultPathSuggestModal { open(): void {} }
}));

beforeAll(() => {
  HTMLElement.prototype.empty = function empty(): void { this.replaceChildren(); };
  HTMLElement.prototype.addClass = function addClass(...classes: string[]): void {
    this.classList.add(...classes);
  };
  HTMLElement.prototype.onClickEvent = function onClickEvent(listener: (event: MouseEvent) => unknown): void {
    this.addEventListener("click", listener as EventListener);
  };
  HTMLElement.prototype.createDiv = function createDiv(
    options: { cls?: string; text?: string } = {}
  ): HTMLDivElement {
    const element = document.createElement("div");
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) element.textContent = options.text;
    this.append(element);
    return element;
  };
  HTMLElement.prototype.createSpan = function createSpan(
    options: { cls?: string; text?: string } = {}
  ): HTMLSpanElement {
    const element = document.createElement("span");
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) element.textContent = options.text;
    this.append(element);
    return element;
  };
  HTMLElement.prototype.createEl = function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options: { cls?: string; text?: string; type?: string } = {}
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.type && element instanceof HTMLInputElement) element.type = options.type;
    this.append(element);
    return element;
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

const room = (overrides: Partial<RoomSummary> = {}): RoomSummary => ({
  id: "daily",
  name: "Daily Report",
  type: "folder",
  sourcePath: "Daily Report",
  mountName: "Daily Report",
  ownerUserId: "owner",
  conflictPolicy: "keep_both",
  permissions: ["room:read", "room:write", "room:delete"],
  capabilities: [],
  crdtEnabled: true,
  ...overrides
});

const acl = (overrides: Partial<AclRuleSummary> = {}): AclRuleSummary => ({
  id: "acl_1",
  roomId: "daily",
  subjectType: "team",
  subjectId: "ekyo",
  effect: "allow",
  permissions: [...EDITOR_PERMISSION_SET],
  pathPattern: "**/*",
  createdAt: "2026-07-30T00:00:00.000Z",
  ...overrides
});

function harness(
  rules: AclRuleSummary[] = [acl()],
  roomOverrides: Partial<RoomSummary> = {}
) {
  const targetRoom = room(roomOverrides);
  const updateRoomSettings = vi.fn(async () => undefined);
  const grantRoomAccess = vi.fn(async () => undefined);
  const removeRoomAccess = vi.fn(async () => undefined);
  const plugin = {
    app: {},
    settings: { roomMountPaths: {} },
    visibleRooms: [targetRoom],
    teamDirectory: [{ id: "ekyo", name: "ekyo" }],
    friends: [{ id: "hung", displayName: "hung", revokedAt: null, teams: [] }],
    refreshTeams: vi.fn(async () => undefined),
    listRoomAcl: vi.fn(async () => rules),
    roomMountPathFor: vi.fn(() => "Vault Rooms/Daily Report"),
    getActiveServer: vi.fn(() => ({ userId: "owner" })),
    canManageRoom: vi.fn(() => true),
    isRoomMounted: vi.fn(() => true),
    updateRoomSettings,
    grantRoomAccess,
    removeRoomAccess,
    deleteRoom: vi.fn(async () => undefined)
  };
  const modal = new RoomSettingsModal(plugin as never, targetRoom);
  return { modal, plugin, updateRoomSettings, grantRoomAccess, removeRoomAccess };
}

async function open(modal: RoomSettingsModal): Promise<void> {
  modal.onOpen();
  await Promise.resolve();
  await Promise.resolve();
}

function button(parent: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(parent.querySelectorAll("button"))
    .find((candidate) => candidate.textContent === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

describe("RoomSettingsModal low-tech access contract", () => {
  it("uses the exact editor preset label and keeps destructive access removal behind Manage", async () => {
    const { modal } = harness();
    await open(modal);

    expect(modal.contentEl.querySelector(":scope > .vault-rooms-settings-scroll")).not.toBeNull();
    expect(button(modal.contentEl, "Delete room").classList.contains("mod-warning")).toBe(true);
    expect(modal.contentEl.textContent).toContain("Can edit · everything here");
    expect(modal.contentEl.textContent).not.toContain("room:read");
    expect(modal.contentEl.textContent).not.toContain("**/*");
    expect(modal.contentEl.textContent).not.toContain("Remove access");

    button(modal.contentEl, "Manage").click();
    expect(modal.contentEl.textContent).toContain("Remove access");
    expect(modal.contentEl.textContent).not.toContain("room:read");
  });

  it("uses inset wrappers for the Advanced disclosure and every expanded settings card", async () => {
    const { modal } = harness();
    await open(modal);

    button(modal.contentEl, "Show").click();

    expect(modal.contentEl.querySelector(".vault-rooms-settings-disclosure")).not.toBeNull();
    expect(modal.contentEl.querySelector(".vault-rooms-advanced-settings.vault-rooms-settings-card")).not.toBeNull();
    expect(modal.contentEl.querySelector(".vault-rooms-room-danger-zone")).not.toBeNull();
  });

  it("renders plugin suggestions as responsive rows instead of one overflowing control strip", async () => {
    const { modal } = harness([acl()], {
      capabilities: [
        { pluginId: "obsidian-tasks-plugin", displayName: "Tasks", mode: "recommended", installed: true },
        { pluginId: "obsidian-kanban", displayName: "Kanban", mode: "recommended", installed: true }
      ]
    });
    await open(modal);

    button(modal.contentEl, "Show").click();

    const rows = Array.from(modal.contentEl.querySelectorAll(".vault-rooms-capability-row"));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.querySelectorAll("select")).toHaveLength(1);
      expect(row.querySelector("input")).toBeNull();
      expect(row.querySelector<HTMLButtonElement>("button")?.dataset.icon).toBe("trash-2");
      expect(row.querySelector<HTMLButtonElement>("button")?.title).toMatch(/^Remove /);
      expect(row.querySelector<HTMLButtonElement>("button")?.getAttribute("aria-label")).toMatch(/^Remove /);
    }
    expect(modal.contentEl.textContent).not.toContain("Recommended");
    expect(modal.contentEl.textContent).not.toContain("Optional");
  });

  it("shows raw permissions after disclosure when a rule is custom", async () => {
    const custom = acl({ permissions: EDITOR_PERMISSION_SET.slice(0, -1) });
    const { modal } = harness([custom]);
    await open(modal);

    expect(modal.contentEl.textContent).toContain("Custom · everything here");
    expect(modal.contentEl.textContent).not.toContain("room:read");
    button(modal.contentEl, "Manage").click();
    expect(modal.contentEl.textContent).toContain("Permissions: room:read");
    expect(modal.contentEl.textContent).toContain("Path: **/*");
  });

  it("saves live editing with the room form instead of applying the toggle immediately", async () => {
    const { modal, updateRoomSettings } = harness();
    await open(modal);
    const liveToggle = modal.contentEl.querySelector<HTMLInputElement>("input[type=checkbox]");
    expect(liveToggle?.checked).toBe(true);

    if (!liveToggle) throw new Error("Missing Live editing toggle");
    liveToggle.checked = false;
    liveToggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(updateRoomSettings).not.toHaveBeenCalled();

    button(modal.contentEl, "Save changes").click();
    await Promise.resolve();
    expect(updateRoomSettings).toHaveBeenCalledWith(
      "daily",
      expect.objectContaining({ crdtEnabled: false }),
      "Vault Rooms/Daily Report"
    );
  });

  it("gives exact editor access to everything through one confirmed action", async () => {
    const { modal, grantRoomAccess } = harness([]);
    await open(modal);
    button(modal.contentEl, "Give someone access").click();

    expect(modal.contentEl.textContent).toContain("Who");
    expect(modal.contentEl.textContent).toContain("They can");
    expect(modal.contentEl.textContent).toContain("Where");
    expect(modal.contentEl.textContent).not.toContain("**/*");
    button(modal.contentEl, "Give access").click();
    await Promise.resolve();
    await Promise.resolve();

    expect(confirmModal).toHaveBeenCalledOnce();
    expect(grantRoomAccess).toHaveBeenCalledWith("daily", {
      subjectType: "team",
      subjectId: "ekyo",
      effect: "allow",
      pathPattern: "**/*",
      preset: "editor"
    });
  });
});
