// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomSummary } from "../apiClient.js";
import { classifyLanAddress } from "../lanAddress.js";
import { inviteMessageFor } from "../onboarding.js";
import { GuidedOnboardingModal } from "./GuidedOnboardingModal.js";

vi.mock("obsidian", () => {
  class MockTextComponent {
    constructor(readonly inputEl: HTMLInputElement) {}
    setPlaceholder(value: string): this {
      this.inputEl.placeholder = value;
      return this;
    }
    setValue(value: string): this {
      this.inputEl.value = value;
      return this;
    }
    setDisabled(value: boolean): this {
      this.inputEl.disabled = value;
      return this;
    }
    onChange(callback: (value: string) => void): this {
      this.inputEl.addEventListener("input", () => callback(this.inputEl.value));
      return this;
    }
  }

  class MockButtonComponent {
    constructor(readonly buttonEl: HTMLButtonElement) {}
    setCta(): this {
      this.buttonEl.classList.add("mod-cta");
      return this;
    }
    setButtonText(value: string): this {
      this.buttonEl.textContent = value;
      return this;
    }
    setDisabled(value: boolean): this {
      this.buttonEl.disabled = value;
      return this;
    }
    onClick(callback: () => void | Promise<void>): this {
      this.buttonEl.addEventListener("click", () => {
        void callback();
      });
      return this;
    }
  }

  class MockDropdownComponent {
    constructor(readonly selectEl: HTMLSelectElement) {}
    addOption(value: string, label: string): this {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      this.selectEl.append(option);
      return this;
    }
    setValue(value: string): this {
      this.selectEl.value = value;
      return this;
    }
    setDisabled(value: boolean): this {
      this.selectEl.disabled = value;
      return this;
    }
    onChange(callback: (value: string) => void): this {
      this.selectEl.addEventListener("change", () => callback(this.selectEl.value));
      return this;
    }
  }

  class Setting {
    private readonly settingEl: HTMLDivElement;
    constructor(container: HTMLElement) {
      this.settingEl = document.createElement("div");
      this.settingEl.className = "setting-item";
      container.append(this.settingEl);
    }
    setName(value: string): this {
      const name = document.createElement("div");
      name.className = "setting-item-name";
      name.textContent = value;
      this.settingEl.append(name);
      return this;
    }
    setDesc(value: string): this {
      const desc = document.createElement("div");
      desc.className = "setting-item-description";
      desc.textContent = value;
      this.settingEl.append(desc);
      return this;
    }
    addText(callback: (component: MockTextComponent) => unknown): this {
      const input = document.createElement("input");
      this.settingEl.append(input);
      callback(new MockTextComponent(input));
      return this;
    }
    addButton(callback: (component: MockButtonComponent) => unknown): this {
      const button = document.createElement("button");
      this.settingEl.append(button);
      callback(new MockButtonComponent(button));
      return this;
    }
    addDropdown(callback: (component: MockDropdownComponent) => unknown): this {
      const select = document.createElement("select");
      this.settingEl.append(select);
      callback(new MockDropdownComponent(select));
      return this;
    }
  }

  class Modal {
    readonly contentEl = document.createElement("div");
    readonly app: unknown;
    closed = false;
    contentBeforeClose = "";
    title = "";
    constructor(app: unknown) {
      this.app = app;
    }
    setTitle(value: string): void {
      this.title = value;
    }
    open(): void {
      (this as { onOpen?: () => void }).onOpen?.();
    }
    close(): void {
      this.closed = true;
      this.contentBeforeClose = this.contentEl.textContent ?? "";
      (this as { onClose?: () => void }).onClose?.();
    }
  }

  class SuggestModal<T> {
    readonly app: unknown;
    constructor(app: unknown) {
      this.app = app;
    }
    setPlaceholder(): void {}
    open(): void {}
  }

  return {
    Modal,
    Notice: class Notice {},
    Platform: { isMacOS: true, isWin: false, isLinux: false },
    Setting,
    SuggestModal
  };
});

beforeAll(() => {
  HTMLElement.prototype.empty = function empty(): void {
    this.replaceChildren();
  };
  HTMLElement.prototype.addClass = function addClass(...classes: string[]): void {
    this.classList.add(...classes);
  };
  HTMLElement.prototype.setAttr = function setAttr(name: string, value: string): void {
    this.setAttribute(name, value);
  };
  HTMLElement.prototype.onClickEvent = function onClickEvent(
    listener: (event: MouseEvent) => unknown
  ): void {
    this.addEventListener("click", listener as EventListener);
  };
  HTMLElement.prototype.createEl = function createEl(
    this: HTMLElement,
    tag: keyof HTMLElementTagNameMap,
    options: {
      cls?: string;
      text?: string;
      href?: string;
      attr?: Record<string, string>;
    } = {}
  ): HTMLElement {
    const element = document.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) {
      if (element instanceof HTMLTextAreaElement) {
        element.value = options.text;
      } else {
        element.textContent = options.text;
      }
    }
    if (options.href && element instanceof HTMLAnchorElement) {
      element.href = options.href;
    }
    for (const [name, value] of Object.entries(options.attr ?? {})) {
      element.setAttribute(name, value);
    }
    this.append(element);
    return element;
  } as typeof HTMLElement.prototype.createEl;
  HTMLElement.prototype.createDiv = function createDiv(
    this: HTMLElement,
    options = {}
  ): HTMLDivElement {
    return this.createEl("div", options) as HTMLDivElement;
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined
  });
});

describe("GuidedOnboardingModal", () => {
  it("shows Not sharing yet before the first durable onboarding action", () => {
    const modal = openModal(pluginHarness());

    expect(modal.contentEl.querySelector(".vault-rooms-status")?.textContent).toBe(
      "Not sharing yet"
    );
  });

  it("shows Setup in progress when an address was saved but setup is incomplete", () => {
    const modal = openModal(pluginHarness({
      serverSettings: {
        maxFileBytes: 1024,
        autoStart: false,
        publicUrlOverride: "192.168.1.49"
      }
    }));

    expect(modal.contentEl.querySelector(".vault-rooms-status")?.textContent).toBe(
      "Setup in progress"
    );
  });

  it("shows first-run help and rejects loopback beside the field before mutation", async () => {
    const plugin = pluginHarness();
    const modal = openModal(plugin);

    expect(modal.contentEl.textContent).toContain("Where do I find this?");
    expect(modal.contentEl.textContent).toContain("System Settings");
    setFirstInput(modal, "127.0.0.1");
    clickButton(modal, "Check connection");
    await flushUi();

    expect(modal.contentEl.querySelector(".vault-rooms-field-error")?.textContent).toBe(
      classifyLanAddress("127.0.0.1").problem
    );
    expect(plugin.configureOnboardingConnection).not.toHaveBeenCalled();
  });

  it("checks without auto-advancing and stays in progress until sharing is complete", async () => {
    const plugin = pluginHarness({
      configureVerdict: classifyLanAddress("192.168.1.49")
    });
    const modal = openModal(plugin);

    setFirstInput(modal, "192.168.1.49");
    clickButton(modal, "Check connection");
    await flushUi();

    expect(modalTitle(modal)).toBe("Connect this computer");
    expect(modal.contentEl.textContent).toContain("Connection ready");
    expect(modal.contentEl.textContent).toContain("Setup in progress");
    expect(modal.contentEl.textContent).not.toContain("Ready to share");
    expect(buttonLabels(modal)).toContain("Continue");

    clickButton(modal, "Continue");
    await flushUi();
    expect(modalTitle(modal)).toBe("How teammates see you");
    expect(buttonLabels(modal)).not.toContain("Back");
  });

  it("shows a saved link-local caveat but does not let reopening bypass the probe", async () => {
    const plugin = pluginHarness({
      serverSettings: {
        maxFileBytes: 1024,
        autoStart: false,
        publicUrlOverride: "169.254.10.20"
      },
      configureVerdict: classifyLanAddress("169.254.10.20")
    });
    const modal = openModal(plugin);

    expect(modal.contentEl.textContent).toContain("self-assigned address");
    expect(modal.contentEl.textContent).not.toContain("System Settings");
    expect(buttonLabels(modal)).toContain("Check connection");

    clickButton(modal, "Check connection");
    await flushUi();
    expect(buttonLabels(modal)).toContain("Continue with this address");
    clickButton(modal, "Continue with this address");
    await flushUi();
    expect(plugin.confirmOnboardingConnection).toHaveBeenCalledOnce();
  });

  it("hands a discovered existing owner to recovery instead of account creation", async () => {
    const plugin = pluginHarness({
      configureVerdict: classifyLanAddress("192.168.1.49"),
      status: runningStatus(true)
    });
    const modal = openModal(plugin);

    setFirstInput(modal, "192.168.1.49");
    clickButton(modal, "Check connection");
    await flushUi();
    clickButton(modal, "Continue");
    await flushUi();

    expect(plugin.openOwnerRecoveryModal).toHaveBeenCalledOnce();
    expect(modalClosed(modal)).toBe(true);
    expect(contentBeforeClose(modal)).toContain("Locked out on this computer");
    expect(modal.contentEl.childElementCount).toBe(0);
    expect(plugin.setupServer).not.toHaveBeenCalled();
  });

  it("rechecks owner state before account creation and hands a late bootstrap to recovery", async () => {
    const plugin = pluginHarness({
      configureVerdict: classifyLanAddress("192.168.1.49"),
      status: runningStatus(false)
    });
    const modal = openModal(plugin);

    setFirstInput(modal, "192.168.1.49");
    clickButton(modal, "Check connection");
    await flushUi();
    clickButton(modal, "Continue");
    await flushUi();

    plugin.getServerStatus.mockReturnValue(runningStatus(true));
    setFirstInput(modal, "Owner");
    clickButton(modal, "Create my account");
    await flushUi();

    expect(plugin.openOwnerRecoveryModal).toHaveBeenCalledOnce();
    expect(plugin.setupServer).not.toHaveBeenCalled();
    expect(contentBeforeClose(modal)).toContain("Locked out on this computer");
  });

  it("issues nothing when inviting later", () => {
    const plugin = pluginHarness({
      hasOwnServer: true,
      visibleRooms: [roomSummary()]
    });
    const modal = openModal(plugin);

    clickButton(modal, "I'll invite someone later");

    expect(plugin.issueRoomInvite).not.toHaveBeenCalled();
    expect(modalClosed(modal)).toBe(true);
  });

  it("selects the same full message or bare link that the user asked to copy", async () => {
    const joinUrl = "obsidian://vault-rooms/join?payload=relay-owned";
    const plugin = pluginHarness({
      hasOwnServer: true,
      visibleRooms: [roomSummary()],
      inviteJoinUrl: joinUrl
    });
    const select = vi.spyOn(HTMLTextAreaElement.prototype, "select");
    const modal = openModal(plugin);

    expect(plugin.issueRoomInvite).not.toHaveBeenCalled();
    clickButton(modal, "Create invite link");
    await flushUi();
    expect(textareaValue(modal)).toBe(inviteMessageFor(joinUrl));
    expect(modal.contentEl.querySelector("a")).toBeNull();
    expect(modal.contentEl.querySelector(".vault-rooms-status")?.textContent).toBe(
      "Ready to share"
    );

    clickButton(modal, "Copy message");
    await flushUi();
    expect(textareaValue(modal)).toBe(inviteMessageFor(joinUrl));
    expect(select).toHaveBeenCalledTimes(1);

    clickButton(modal, "Copy link only");
    await flushUi();
    expect(textareaValue(modal)).toBe(joinUrl);
    expect(select).toHaveBeenCalledTimes(2);
  });
});

function pluginHarness(input: {
  hasOwnServer?: boolean;
  visibleRooms?: RoomSummary[];
  serverSettings?: {
    maxFileBytes: number;
    autoStart: boolean;
    publicUrlOverride?: string;
  };
  configureVerdict?: ReturnType<typeof classifyLanAddress>;
  status?: ReturnType<typeof runningStatus> | { running: false };
  inviteJoinUrl?: string;
} = {}) {
  const serverSettings = input.serverSettings ?? {
    maxFileBytes: 1024,
    autoStart: false
  };
  const status = input.status ?? { running: false as const };
  return {
    app: {},
    settings: {
      servers: [],
      mountRoot: "Vault Rooms",
      debounceMs: 300,
      mountedRooms: {},
      roomMountPaths: {},
      server: serverSettings
    },
    visibleRooms: input.visibleRooms ?? [],
    canManageRoom: vi.fn(() => true),
    hasOwnServer: vi.fn(() => input.hasOwnServer ?? false),
    getActiveServer: vi.fn(() => ({
      id: "dev_1",
      userDisplayName: "Owner"
    })),
    getServerStatus: vi.fn(() => status),
    configureOnboardingConnection: vi.fn(async () =>
      input.configureVerdict ?? classifyLanAddress("192.168.1.49")
    ),
    confirmOnboardingConnection: vi.fn(async () => undefined),
    setupServer: vi.fn(async () => undefined),
    createRoom: vi.fn(async () => roomSummary()),
    issueRoomInvite: vi.fn(async () => ({
      inviteId: "inv_1",
      inviteToken: "secret",
      serverUrl: "https://192.168.1.49:8788",
      joinUrl: input.inviteJoinUrl ?? "obsidian://vault-rooms/join?payload=relay-owned"
    })),
    openOwnerRecoveryModal: vi.fn(),
    openCreateInviteModal: vi.fn()
  };
}

function roomSummary(): RoomSummary {
  return {
    id: "room_1",
    name: "Alpha",
    type: "folder",
    sourcePath: "Projects/Alpha",
    mountName: "Alpha",
    ownerUserId: "usr_1",
    conflictPolicy: "keep_both",
    permissions: ["room:read", "room:write", "file:read", "file:write", "sync:subscribe", "sync:push"],
    capabilities: [],
    crdtEnabled: false
  };
}

function runningStatus(bootstrapped: boolean) {
  return {
    running: true as const,
    host: "127.0.0.1",
    port: 8787,
    localUrl: "http://127.0.0.1:8787",
    securityMode: "plain" as const,
    bootstrapped,
    serverId: "srv_1",
    legacyV01BackupAvailable: false,
    securityState: "plain_legacy" as const
  };
}

function openModal(plugin: ReturnType<typeof pluginHarness>): GuidedOnboardingModal {
  const modal = new GuidedOnboardingModal(plugin as never);
  modal.onOpen();
  return modal;
}

function setFirstInput(modal: GuidedOnboardingModal, value: string): void {
  const input = modal.contentEl.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error("Expected an input");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function clickButton(modal: GuidedOnboardingModal, label: string): void {
  const button = Array.from(modal.contentEl.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  button.click();
}

function buttonLabels(modal: GuidedOnboardingModal): string[] {
  return Array.from(modal.contentEl.querySelectorAll("button")).map(
    (button) => button.textContent ?? ""
  );
}

function textareaValue(modal: GuidedOnboardingModal): string {
  const textarea = modal.contentEl.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("Expected a textarea");
  return textarea.value;
}

function modalTitle(modal: GuidedOnboardingModal): string {
  return (modal as unknown as { title: string }).title;
}

function modalClosed(modal: GuidedOnboardingModal): boolean {
  return (modal as unknown as { closed: boolean }).closed;
}

function contentBeforeClose(modal: GuidedOnboardingModal): string {
  return (modal as unknown as { contentBeforeClose: string }).contentBeforeClose;
}

async function flushUi(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}
