// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
  AuditEventSummary,
  FriendSummary,
  RoomSummary,
  TeamMemberSummary,
  TeamSummary
} from "../apiClient.js";
import type { ServerConnection, VaultRoomsSettings } from "../settings.js";
import { VaultRoomsView } from "./VaultRoomsView.js";

vi.mock("obsidian", () => {
  class MockButton {
    constructor(readonly buttonEl: HTMLButtonElement) {}
    setCta(): this { this.buttonEl.classList.add("mod-cta"); return this; }
    setButtonText(text: string): this { this.buttonEl.textContent = text; return this; }
    onClick(callback: () => unknown): this { this.buttonEl.addEventListener("click", () => void callback()); return this; }
  }
  class Setting {
    readonly settingEl = document.createElement("div");
    constructor(container: HTMLElement) { container.append(this.settingEl); }
    setName(text: string): this {
      const name = document.createElement("div");
      name.textContent = text;
      this.settingEl.append(name);
      return this;
    }
    setHeading(): this { return this; }
    addButton(callback: (button: MockButton) => unknown): this {
      const button = document.createElement("button");
      this.settingEl.append(button);
      callback(new MockButton(button));
      return this;
    }
  }
  class ItemView {
    readonly containerEl = document.createElement("div");
    readonly app: unknown;
    constructor(readonly leaf: { app?: unknown }) {
      this.app = leaf.app ?? {};
      this.containerEl.append(document.createElement("div"), document.createElement("div"));
    }
  }
  return {
    ItemView,
    Notice: class Notice {},
    Setting,
    WorkspaceLeaf: class WorkspaceLeaf {}
  };
});

vi.mock("../modals/ConfirmModal.js", () => ({ confirmModal: vi.fn(async () => true) }));
vi.mock("../controllers/ServerConnectionManager.js", () => ({
  pinnedInfoForServer: vi.fn(() => undefined)
}));
vi.mock("../modals/ConnectionDiagnosticsModal.js", () => ({
  ConnectionDiagnosticsModal: class ConnectionDiagnosticsModal { open(): void {} }
}));

beforeAll(() => {
  HTMLElement.prototype.empty = function empty(): void { this.replaceChildren(); };
  HTMLElement.prototype.addClass = function addClass(...classes: string[]): void { this.classList.add(...classes); };
  HTMLElement.prototype.setAttr = function setAttr(name: string, value: string): void { this.setAttribute(name, value); };
  HTMLElement.prototype.onClickEvent = function onClickEvent(listener: (event: MouseEvent) => unknown): void {
    this.addEventListener("click", listener as EventListener);
  };
  HTMLElement.prototype.createDiv = function createDiv(options: { cls?: string; text?: string; attr?: Record<string, string> } = {}): HTMLDivElement {
    return this.createEl("div", options) as HTMLDivElement;
  };
  HTMLElement.prototype.createSpan = function createSpan(options: { cls?: string; text?: string; attr?: Record<string, string> } = {}): HTMLSpanElement {
    return this.createEl("span", options) as HTMLSpanElement;
  };
  HTMLElement.prototype.createEl = function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options: { cls?: string; text?: string; attr?: Record<string, string>; type?: string; value?: string } = {}
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.type && element instanceof HTMLInputElement) element.type = options.type;
    if (options.value !== undefined && "value" in element) (element as HTMLInputElement).value = options.value;
    for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
    this.append(element);
    return element;
  };
});

function server(overrides: Partial<ServerConnection> = {}): ServerConnection {
  return {
    id: "local",
    baseUrl: "http://127.0.0.1:8787",
    userId: "owner",
    userDisplayName: "Mai",
    deviceId: "device",
    deviceName: "Mac",
    deviceToken: "token",
    isServerOwner: true,
    status: "active",
    securityMode: "plain",
    securityState: "ok",
    ...overrides
  };
}

function room(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: "daily",
    name: "Daily Report",
    type: "folder",
    sourcePath: "Daily Report",
    mountName: "Daily Report",
    ownerUserId: "owner",
    conflictPolicy: "keep_both",
    permissions: ["room:read", "room:write"],
    capabilities: [],
    crdtEnabled: false,
    ...overrides
  };
}

type HarnessOptions = {
  canManageRoom?: boolean;
  active?: ServerConnection;
  hasOwnServer?: boolean;
  canCreateAnyInvite?: boolean;
  isOwnEmbedded?: boolean;
  friends?: FriendSummary[];
  teams?: TeamSummary[];
  teamMembersByTeam?: Record<string, TeamMemberSummary[]>;
  canManageTeam?: boolean;
  canDeleteTeam?: boolean;
  savedServers?: ServerConnection[];
  roomAcl?: Awaited<ReturnType<VaultRoomsViewTestPlugin["listRoomAcl"]>>;
  lanUrl?: string | null;
  serverRunning?: boolean;
  auditEvents?: AuditEventSummary[];
};

type VaultRoomsViewTestPlugin = {
  listRoomAcl: (roomId: string) => Promise<import("../apiClient.js").AclRuleSummary[]>;
};

function harness(options: HarnessOptions | boolean = {}) {
  const normalized = typeof options === "boolean" ? { canManageRoom: options } : options;
  const active = normalized.active ?? server();
  let serverRunning = normalized.serverRunning ?? true;
  const revealInFolder = vi.fn();
  const settings: VaultRoomsSettings = {
    servers: [active, ...(normalized.savedServers ?? [])],
    activeServerId: active.id,
    mountRoot: "Vault Rooms",
    debounceMs: 300,
    mountedRooms: {
      daily: { roomId: "daily", serverId: active.id, mountPath: "Vault Rooms/Daily Report", files: {} }
    },
    roomMountPaths: {},
    server: { maxFileBytes: 1024, autoStart: true, publicUrlOverride: "192.168.1.20" }
  };
  const plugin = {
    app: {
      vault: { getFolderByPath: vi.fn((path: string) => ({ path })) },
      workspace: {
        openLinkText: vi.fn(),
        getLeavesOfType: vi.fn((type: string) =>
          type === "file-explorer" ? [{ view: { revealInFolder } }] : []
        ),
        ensureSideLeaf: vi.fn(),
        revealLeaf: vi.fn()
      }
    },
    settings,
    visibleRooms: [room()],
    friends: normalized.friends ?? [],
    teams: normalized.teams ?? [],
    teamMembersByTeam: normalized.teamMembersByTeam ?? {},
    myTeamRoles: {},
    getActiveServer: () => active,
    getServerOwnerIdentity: () => ({ id: "owner", displayName: "DNDark" }),
    getServerStatus: () => ({
      running: serverRunning,
      bootstrapped: true,
      lanUrl: normalized.lanUrl === null ? undefined : normalized.lanUrl ?? "http://192.168.1.20:8787",
      localUrl: active.baseUrl,
      legacyV01BackupAvailable: false
    }),
    getSyncState: () => serverRunning ? "connected" : "disconnected",
    hasConnectedActiveServerThisSession: () => true,
    getLanShareReachability: () => ({ status: "reachable" }),
    getObservedClientHost: () => null,
    hasOwnServer: () => normalized.hasOwnServer ?? true,
    ownEmbeddedServerId: () => "local",
    activeServerIsOwnEmbeddedServer: () =>
      normalized.isOwnEmbedded ?? active.baseUrl.startsWith("http://127.0.0.1"),
    activeServerIsOwnStoppedServer: () =>
      !serverRunning &&
      (normalized.isOwnEmbedded ?? active.baseUrl.startsWith("http://127.0.0.1")),
    canCreateAnyInvite: () => normalized.canCreateAnyInvite ?? true,
    canManageRoom: () => normalized.canManageRoom ?? true,
    canManageTeam: () => normalized.canManageTeam ?? false,
    canDeleteTeam: () => normalized.canDeleteTeam ?? false,
    isRoomMounted: () => true,
    mountedPathFor: () => "Vault Rooms/Daily Report",
    mountedRoomServerId: () => active.id,
    listRoomConflicts: () => [],
    openCreateInviteModal: vi.fn(),
    openCreateRoomModal: vi.fn(),
    openRoomSettingsModal: vi.fn(),
    openJoinTeamModal: vi.fn(),
    openSetupServerModal: vi.fn(),
    openOwnerRecoveryModal: vi.fn(),
    startEmbeddedServer: vi.fn(async () => {
      serverRunning = true;
    }),
    stopEmbeddedServer: vi.fn(),
    restoreLegacyV01Data: vi.fn(),
    mountRoom: vi.fn(),
    unmountRoom: vi.fn(),
    activateServer: vi.fn(),
    refreshRooms: vi.fn(),
    refreshTeams: vi.fn(),
    listRoomAcl: vi.fn(async () => normalized.roomAcl ?? []),
    listAuditEvents: vi.fn(async () => ({
      events: normalized.auditEvents ?? [],
      limit: 50,
      offset: 0
    })),
    diagnoseConnection: vi.fn(),
    revokeFriend: vi.fn(),
    createTeam: vi.fn(),
    addFriendToTeam: vi.fn(),
    removeTeamMember: vi.fn(),
    deleteTeam: vi.fn(),
    resolveRoomConflict: vi.fn()
  };
  const view = new VaultRoomsView({ app: plugin.app } as never, plugin as never);
  return { view, plugin, revealInFolder };
}

describe("VaultRoomsView UX B", () => {
  it("renders one syncing chip and three accessible tabs", () => {
    const { view } = harness();
    view.render();
    expect(view.containerEl.querySelectorAll(".vault-rooms-connection-chip")).toHaveLength(1);
    expect(view.containerEl.querySelector(".vault-rooms-connection-chip")?.textContent).toContain("Syncing");
    expect(view.containerEl.querySelector("[role=tablist]")).not.toBeNull();
    expect(Array.from(view.containerEl.querySelectorAll("[role=tab]")).map((tab) => tab.textContent)).toEqual([
      "Rooms", "People", "Activity"
    ]);
    for (const tab of Array.from(view.containerEl.querySelectorAll<HTMLElement>("[role=tab]"))) {
      expect(view.containerEl.querySelector(`#${tab.getAttribute("aria-controls")}`)).not.toBeNull();
    }
    expect(view.containerEl.querySelectorAll("[role=tabpanel]")).toHaveLength(3);
    const liveStatus = view.containerEl.querySelector("[aria-live=polite]");
    expect(liveStatus).not.toBeNull();
    expect(liveStatus?.querySelector("button")).toBeNull();
    expect(view.containerEl.textContent).not.toContain("Currently syncing with");
    expect(view.containerEl.textContent).toContain("Connection details");
  });

  it("uses keyboard navigation and permission-driven room Manage", () => {
    const { view } = harness(false);
    view.render();
    expect(view.containerEl.textContent).toContain("Open");
    expect(view.containerEl.textContent).toContain("Remove from this computer");
    expect(view.containerEl.textContent).not.toContain("Manage");
    const roomsTab = view.containerEl.querySelector<HTMLButtonElement>("[role=tab]");
    roomsTab?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(view.containerEl.querySelector("[role=tab][aria-selected=true]")?.textContent).toBe("People");
  });

  it("shows Manage only when canManageRoom allows it", () => {
    const { view } = harness(true);
    view.render();
    expect(view.containerEl.textContent).toContain("Manage");
  });

  it("keeps room rows visible and labels them stale after refresh fails", async () => {
    const { view, plugin } = harness();
    plugin.refreshRooms.mockRejectedValueOnce(new Error("offline"));
    await view.onOpen();
    expect(view.containerEl.textContent).toContain("Daily Report");
    expect(view.containerEl.textContent).toContain("The last update failed");
    expect(view.containerEl.textContent).toContain("Try again");
  });

  it("reveals a folder room in File Explorer instead of opening it as a note", async () => {
    const { view, plugin, revealInFolder } = harness();
    view.render();

    const open = Array.from(view.containerEl.querySelectorAll("button"))
      .find((button) => button.textContent === "Open");
    open?.click();
    await Promise.resolve();

    expect(plugin.app.workspace.openLinkText).not.toHaveBeenCalled();
    expect(plugin.app.workspace.revealLeaf).toHaveBeenCalled();
    expect(revealInFolder).toHaveBeenCalledWith({ path: "Vault Rooms/Daily Report" });
  });

  it("does not place local-server setup inside the active remote connection card", () => {
    const { view } = harness({
      active: server({
        id: "remote",
        baseUrl: "http://192.168.1.20:8787",
        isServerOwner: false,
        userDisplayName: "huynd2"
      }),
      hasOwnServer: false,
      canCreateAnyInvite: false
    });
    view.render();

    const details = Array.from(view.containerEl.querySelectorAll("button"))
      .find((button) => button.textContent === "Connection details");
    details?.click();

    const currentConnection = view.containerEl.querySelector(".vault-rooms-connection-card.is-active");
    expect(currentConnection?.textContent).toContain("Remote server");
    expect(currentConnection?.textContent).toContain("Signed in as huynd2");
    expect(currentConnection?.textContent).not.toContain("Set up and share");
    expect(currentConnection?.textContent).not.toContain("Invite");
    expect(view.containerEl.textContent).toContain("Sharing from this computer");
  });

  it("offers an active-server Invite only when the current permissions allow it", () => {
    const { view, plugin } = harness({
      active: server({
        id: "remote",
        baseUrl: "http://192.168.1.20:8787",
        isServerOwner: false,
        userDisplayName: "huynd2"
      }),
      hasOwnServer: false,
      canCreateAnyInvite: true
    });
    view.render();
    Array.from(view.containerEl.querySelectorAll("button"))
      .find((button) => button.textContent === "Connection details")?.click();

    const currentConnection = view.containerEl.querySelector(".vault-rooms-connection-card.is-active");
    const invite = Array.from(currentConnection?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent === "Invite");
    expect(invite).toBeDefined();
    invite?.click();
    expect(plugin.openCreateInviteModal).toHaveBeenCalledOnce();
  });

  it("keeps connection management out of the Activity tab", () => {
    const { view } = harness();
    view.render();
    Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>("[role=tab]"))
      .find((tab) => tab.textContent === "Activity")?.click();

    const activityPanel = view.containerEl.querySelector("#vault-rooms-panel-activity");
    expect(activityPanel?.textContent).not.toContain("Connections");
    expect(activityPanel?.textContent).not.toContain("Join another server");
    expect(activityPanel?.textContent).toContain("Activity log");
    expect(activityPanel?.textContent).toContain("Most recent first");
  });

  it("shows the selected server and switchable saved servers in connection details", () => {
    const { view } = harness({
      savedServers: [server({
        id: "research",
        baseUrl: "http://192.168.1.30:8787",
        userDisplayName: "Research owner",
        isServerOwner: false
      })]
    });
    view.render();
    Array.from(view.containerEl.querySelectorAll("button"))
      .find((button) => button.textContent === "Connection details")?.click();

    const details = view.containerEl.querySelector(".vault-rooms-status-card");
    expect(details?.textContent).toContain("Selected server");
    expect(details?.textContent).toContain("Other saved servers");
    expect(details?.textContent).toContain("Only one server syncs at a time");
    expect(details?.textContent).toContain("Research owner");
    expect(details?.textContent).toContain("Switch");
  });

  it("hides the localhost address for this computer's server", () => {
    const { view } = harness();
    view.render();
    Array.from(view.containerEl.querySelectorAll("button"))
      .find((button) => button.textContent === "Connection details")?.click();

    const details = view.containerEl.querySelector(".vault-rooms-status-card");
    expect(details?.textContent).toContain("This computer's server");
    expect(details?.textContent).not.toContain("http://127.0.0.1:8787");
    expect(details?.textContent).toContain("http://192.168.1.20:8787");
  });

  it("never falls back to localhost when no LAN address is configured", () => {
    const { view } = harness({ lanUrl: null });
    view.render();
    Array.from(view.containerEl.querySelectorAll("button"))
      .find((button) => button.textContent === "Connection details")?.click();

    const details = view.containerEl.querySelector(".vault-rooms-status-card");
    expect(details?.textContent).not.toContain("127.0.0.1");
    expect(details?.textContent).toContain("No LAN address is set");
    expect(details?.textContent).toContain("Settings → Vault Rooms → Relay server");
  });

  it("drives team Manage and destructive actions from policy and listed members", () => {
    const research = { id: "research", slug: "research", name: "Research Team", ownerUserId: "owner" };
    const member = {
      userId: "mai",
      displayName: "Mai",
      role: "member" as const,
      revokedAt: null
    };
    const { view } = harness({
      teams: [research],
      teamMembersByTeam: { research: [member] },
      canManageTeam: true,
      canDeleteTeam: false
    });
    view.render();
    Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>("[role=tab]"))
      .find((tab) => tab.textContent === "People")?.click();
    expect(view.containerEl.querySelectorAll(".vault-rooms-people-column")).toHaveLength(0);
    expect(view.containerEl.textContent).toContain("People with access");
    expect(view.containerEl.textContent).toContain("Teams");
    Array.from(view.containerEl.querySelectorAll("button"))
      .find((button) => button.textContent === "Manage")?.click();

    expect(view.containerEl.textContent).toContain("Mai — member");
    expect(view.containerEl.textContent).not.toContain("Delete team");
  });

  it("reloads People data when the tab is activated after server start", async () => {
    const { view, plugin } = harness();
    view.render();

    Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>("[role=tab]"))
      .find((tab) => tab.textContent === "People")?.click();

    await vi.waitFor(() => {
      expect(plugin.refreshRooms).toHaveBeenCalledOnce();
      expect(plugin.refreshTeams).toHaveBeenCalledOnce();
      expect(plugin.listRoomAcl).toHaveBeenCalledWith("daily");
    });
  });

  it("renders freshly loaded direct and team room access after People activation", async () => {
    const editorPermissions = [
      "room:read",
      "file:read",
      "sync:subscribe",
      "file:write",
      "file:create",
      "file:delete",
      "sync:push"
    ];
    const { view } = harness({
      friends: [
        { id: "hung", displayName: "hung", revokedAt: null, teams: [] },
        {
          id: "huynd2",
          displayName: "huynd2",
          revokedAt: null,
          teams: [{ id: "research", role: "member" }]
        }
      ],
      teams: [{ id: "research", slug: "research", name: "Research Team", ownerUserId: "owner" }],
      roomAcl: [
        {
          id: "acl-team",
          roomId: "daily",
          subjectType: "team",
          subjectId: "research",
          effect: "allow",
          permissions: editorPermissions,
          pathPattern: "**/*",
          createdAt: "2026-07-31T00:00:00.000Z"
        },
        {
          id: "acl-user",
          roomId: "daily",
          subjectType: "user",
          subjectId: "hung",
          effect: "allow",
          permissions: editorPermissions,
          pathPattern: "**/*",
          createdAt: "2026-07-31T00:00:00.000Z"
        }
      ]
    });
    view.render();

    Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>("[role=tab]"))
      .find((tab) => tab.textContent === "People")?.click();

    await vi.waitFor(() => {
      expect(view.containerEl.textContent).toContain("Can edit · Daily Report");
      expect(view.containerEl.textContent).toContain("Can edit · through Research Team");
      expect(view.containerEl.textContent).toContain("can edit 1 room");
    });
  });

  it("refreshes People data after Start sharing succeeds while People is open", async () => {
    const { view, plugin } = harness({ serverRunning: false });
    view.render();
    Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>("[role=tab]"))
      .find((tab) => tab.textContent === "People")?.click();
    plugin.refreshRooms.mockClear();
    plugin.refreshTeams.mockClear();
    plugin.listRoomAcl.mockClear();

    Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Start sharing")?.click();

    await vi.waitFor(() => {
      expect(plugin.startEmbeddedServer).toHaveBeenCalledOnce();
      expect(plugin.refreshRooms).toHaveBeenCalledOnce();
      expect(plugin.refreshTeams).toHaveBeenCalledOnce();
      expect(plugin.listRoomAcl).toHaveBeenCalledWith("daily");
    });
  });

  it("renders human Activity copy and keeps raw IDs in Technical details", async () => {
    const { view } = harness({
      auditEvents: [{
        id: "audit-1",
        teamId: null,
        actorType: "user",
        actorId: "usr_owner",
        actorDisplayName: "DNDark",
        actorDeviceDisplayName: null,
        action: "room.crdt_enabled",
        resourceType: "room",
        resourceId: "room_daily",
        resourceDisplayName: "Daily Report",
        metadata: {},
        ipAddress: null,
        createdAt: "2026-07-31T02:00:00.000Z"
      }]
    });
    view.render();
    Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>("[role=tab]"))
      .find((tab) => tab.textContent === "Activity")?.click();
    Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Load activity")?.click();

    await vi.waitFor(() => {
      expect(view.containerEl.querySelector(".vault-rooms-activity-summary")?.textContent)
        .toBe("DNDark turned on Live editing for Daily Report");
    });
    const technical = view.containerEl.querySelector(".vault-rooms-activity-technical");
    expect(technical?.textContent).toContain("room.crdt_enabled");
    expect(technical?.textContent).toContain("usr_owner");
    expect(technical?.textContent).toContain("room_daily");
  });

  it("does not call revoked history an item that needs attention", () => {
    const { view } = harness({
      friends: [{
        id: "old-friend",
        displayName: "Old friend",
        revokedAt: "2026-07-30T00:00:00.000Z",
        teams: []
      }],
      teamMembersByTeam: {
        research: [{
          userId: "old-member",
          displayName: "Old member",
          role: "member",
          revokedAt: "2026-07-30T00:00:00.000Z"
        }]
      }
    });
    view.render();
    const peopleTab = Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>("[role=tab]"))
      .find((tab) => tab.getAttribute("aria-controls") === "vault-rooms-panel-people");
    expect(peopleTab?.textContent).toBe("People");
    expect(peopleTab?.getAttribute("aria-label")).toBe("People");
  });

  it("does not expose team Manage to an ordinary member", () => {
    const { view } = harness({
      active: server({
        id: "remote",
        baseUrl: "http://192.168.1.20:8787",
        userId: "hung",
        userDisplayName: "hung",
        isServerOwner: false
      }),
      hasOwnServer: false,
      teams: [{ id: "research", slug: "research", name: "Research Team", ownerUserId: "other" }],
      canManageTeam: false,
      canDeleteTeam: false,
      canManageRoom: false
    });
    view.render();
    Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>("[role=tab]"))
      .find((tab) => tab.textContent === "People")?.click();
    expect(view.containerEl.textContent).not.toContain("Manage");
    expect(view.containerEl.textContent).not.toContain("Delete team");
    expect(view.containerEl.textContent).toContain("Only DNDark or an authorized manager can change who has access here.");
  });

  it("keeps destructive friend removal behind Manage and confirmation", async () => {
    const { view, plugin } = harness({
      friends: [{
        id: "hung",
        displayName: "hung",
        revokedAt: null,
        teams: []
      }]
    });
    view.render();
    Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>("[role=tab]"))
      .find((tab) => tab.textContent === "People")?.click();

    expect(view.containerEl.textContent).not.toContain("Remove server access");
    Array.from(view.containerEl.querySelectorAll("button"))
      .find((button) => button.textContent === "Manage")?.click();
    expect(view.containerEl.textContent).toContain("Remove server access");

    Array.from(view.containerEl.querySelectorAll("button"))
      .find((button) => button.textContent === "Remove server access")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(plugin.revokeFriend).toHaveBeenCalledWith("hung");
  });

  it("disables only Refresh while list data is refreshing", async () => {
    const { view, plugin } = harness();
    let finishRooms!: () => void;
    plugin.refreshRooms.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishRooms = resolve;
    }));

    const opening = view.onOpen();
    await Promise.resolve();
    const buttons = Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.find((button) => button.textContent === "Refresh")?.disabled).toBe(true);
    expect(buttons.find((button) => button.textContent === "Open")?.disabled).toBe(false);

    finishRooms();
    await opening;
  });
});
