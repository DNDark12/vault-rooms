import { describe, expect, it } from "vitest";
import { CONNECTION_STATUS_COPY } from "../onboarding.js";
import { panelScenarios } from "./panelScenarios.js";
import { countPausedLocalRooms, panelModel, type PanelState } from "./panelModel.js";

const baseState = (): PanelState => ({
  activeServer: {
    id: "server_active",
    name: "Home server",
    status: "active",
    securityState: "ok",
    isOwnEmbedded: false
  },
  syncState: "connected",
  hasConnectedThisSession: true,
  dataState: "current",
  host: {
    hasOwnerCredential: false,
    running: false,
    bootstrapped: false,
    localRoomCount: 0
  },
  rooms: [],
  peopleAttentionItems: [],
  activityAttentionItems: [],
  canCreateRoom: false
});

describe("panelModel", () => {
  it("counts only active mounts belonging to this computer's embedded server", () => {
    expect(countPausedLocalRooms({
      local: { serverId: "embedded", unmounted: false },
      removed: { serverId: "embedded", unmounted: true },
      remote: { serverId: "remote", unmounted: false },
      legacy: { serverId: undefined, unmounted: false }
    }, "embedded")).toBe(1);
    expect(countPausedLocalRooms({}, undefined)).toBe(0);
  });

  it("uses the shared six-state connection vocabulary", () => {
    expect(panelModel({ ...baseState(), activeServer: undefined }).connection.label).toBe(CONNECTION_STATUS_COPY.notSetUp);
    expect(panelModel(baseState()).connection.label).toBe(CONNECTION_STATUS_COPY.syncing);
    expect(panelModel({
      ...baseState(),
      syncState: "connecting",
      hasConnectedThisSession: false
    }).connection).toMatchObject({
      label: CONNECTION_STATUS_COPY.connecting,
      summary: "Connecting to selected server."
    });
    expect(panelModel({
      ...baseState(),
      syncState: "connecting",
      hasConnectedThisSession: true
    }).connection).toMatchObject({
      label: CONNECTION_STATUS_COPY.reconnecting,
      summary: "Connection lost. Reconnecting to selected server."
    });
    expect(panelModel({ ...baseState(), syncState: "offline" }).connection.label).toBe(CONNECTION_STATUS_COPY.notSyncing);
    expect(panelModel({
      ...baseState(),
      activeServer: { ...baseState().activeServer!, status: "revoked" }
    }).connection.label).toBe(CONNECTION_STATUS_COPY.noAccess);
  });

  it("lets active sync and local hosting disagree in all four required ways", () => {
    const localStopped = panelModel({
      ...baseState(),
      activeServer: { ...baseState().activeServer!, isOwnEmbedded: true },
      syncState: "offline",
      host: { hasOwnerCredential: true, running: false, bootstrapped: true, localRoomCount: 1 }
    });
    expect(localStopped.hostLine).toMatchObject({ action: "start", text: "Sharing from this device is stopped" });

    const remoteWithHost = panelModel({
      ...baseState(),
      host: { hasOwnerCredential: true, running: true, bootstrapped: true, localRoomCount: 2 }
    });
    expect(remoteWithHost.connection.label).toBe("Syncing");
    expect(remoteWithHost.hostLine?.text).toContain("2 local rooms paused here");

    const remoteWithStoppedHost = panelModel({
      ...baseState(),
      host: { hasOwnerCredential: true, running: false, bootstrapped: true, localRoomCount: 2 }
    });
    expect(remoteWithStoppedHost.hostLine).toMatchObject({ action: "start" });
    expect(remoteWithStoppedHost.hostLine?.text).toContain("remote rooms continue syncing");

    const recovery = panelModel({
      ...baseState(),
      host: { hasOwnerCredential: false, running: true, bootstrapped: true, localRoomCount: 0 }
    });
    expect(recovery.connection.label).toBe("Syncing");
    expect(recovery.hostLine).toMatchObject({ action: "recover" });
  });

  it("never asks a remote member with no local host to start sharing", () => {
    const descriptor = panelModel({
      ...baseState(),
      host: {
        hasOwnerCredential: false,
        running: false,
        bootstrapped: false,
        localRoomCount: 0
      }
    });
    expect(descriptor.connection.label).toBe("Syncing");
    expect(descriptor.hostLine).toBeUndefined();
  });

  it("surfaces a failed local-host setup even while a remote server is active", () => {
    const descriptor = panelModel({
      ...baseState(),
      host: {
        hasOwnerCredential: false,
        running: false,
        bootstrapped: false,
        localRoomCount: 0,
        error: "Port 8787 is unavailable."
      }
    });
    expect(descriptor.hostLine).toMatchObject({
      text: "Port 8787 is unavailable.",
      action: "setup"
    });
  });

  it("derives room actions and Manage only from supplied permission", () => {
    const descriptor = panelModel({
      ...baseState(),
      rooms: [
        { id: "active", name: "Daily", mounted: true, mountedPath: "Shared/Daily", mountedServerId: "server_active", conflictCount: 0, canManage: true },
        { id: "new", name: "Research", mounted: false, conflictCount: 0, canManage: false },
        { id: "paused", name: "Archive", mounted: true, mountedServerId: "server_other", conflictCount: 1, canManage: false }
      ]
    });
    expect(descriptor.rooms[0]?.actions).toEqual(["open", "remove", "manage"]);
    expect(descriptor.rooms[1]?.actions).toEqual(["add"]);
    expect(descriptor.rooms[2]?.actions).toEqual(["switch"]);
    expect(descriptor.rooms[2]?.attention).toBe(true);
  });

  it("derives attention counts from rendered items", () => {
    const descriptor = panelModel({
      ...baseState(),
      rooms: [
        { id: "choice", name: "Choice", mounted: true, mountedServerId: "server_active", conflictCount: 2, canManage: false },
        { id: "quiet", name: "Quiet", mounted: true, mountedServerId: "server_active", conflictCount: 0, canManage: false }
      ],
      peopleAttentionItems: ["revoked member"],
      activityAttentionItems: ["stale data", "pin mismatch"]
    });
    expect(descriptor.tabs.rooms.attentionCount).toBe(1);
    expect(descriptor.tabs.people.attentionCount).toBe(1);
    expect(descriptor.tabs.activity.attentionCount).toBe(2);
  });

  it("keeps stale rows visible and marks them non-authoritative", () => {
    const descriptor = panelModel({
      ...baseState(),
      dataState: "stale-error",
      rooms: [{ id: "r", name: "Daily", mounted: true, mountedServerId: "server_active", conflictCount: 0, canManage: false }]
    });
    expect(descriptor.rooms).toHaveLength(1);
    expect(descriptor.dataNotice).toMatchObject({ action: "retry" });
  });

  it("covers the approved fourteen-scenario matrix", () => {
    expect(panelScenarios).toHaveLength(14);
    for (const scenario of panelScenarios) {
      const descriptor = panelModel(scenario.state);
      expect(descriptor.connection.label, scenario.id).toBe(scenario.expectedConnection);
      expect(descriptor.tabs.rooms.attentionCount, scenario.id).toBe(scenario.expectedRoomAttention);
      expect(descriptor.tabs.people.attentionCount, scenario.id).toBe(scenario.expectedPeopleAttention);
      expect(descriptor.tabs.activity.attentionCount, scenario.id).toBe(
        scenario.expectedActivityAttention
      );
    }
  });

  it("has no two scenarios describing the same state", () => {
    const seen = new Map<string, string>();
    for (const scenario of panelScenarios) {
      const key = JSON.stringify(scenario.state);
      const previous = seen.get(key);
      expect(previous, `${scenario.id} duplicates ${previous ?? ""}`).toBeUndefined();
      seen.set(key, scenario.id);
    }
    expect(seen.size).toBe(panelScenarios.length);
  });

  it("exercises each tab's attention indicator with a non-zero count", () => {
    const nonZero = (pick: (s: (typeof panelScenarios)[number]) => number) =>
      panelScenarios.some((scenario) => pick(scenario) > 0);
    expect(nonZero((s) => s.expectedRoomAttention), "rooms").toBe(true);
    expect(nonZero((s) => s.expectedPeopleAttention), "people").toBe(true);
    expect(nonZero((s) => s.expectedActivityAttention), "activity").toBe(true);
  });
});
