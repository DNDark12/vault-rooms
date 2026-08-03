import { CONNECTION_STATUS_COPY } from "../onboarding.js";
import type { PanelState, PanelTab } from "./panelModel.js";

type Scenario = {
  id: string;
  state: PanelState;
  expectedConnection: string;
  expectedRoomAttention: number;
  expectedPeopleAttention: number;
  expectedActivityAttention: number;
  expectedVisibleTabs: readonly PanelTab[];
};

const server = {
  id: "local",
  name: "Mai's server",
  status: "active" as const,
  securityState: "ok" as const,
  isOwnEmbedded: true
};
const host = { hasOwnerCredential: true, running: true, bootstrapped: true, localRoomCount: 1 };
const room = { id: "daily", name: "Daily Report", mounted: true, mountedPath: "Vault Rooms/Daily Report", mountedServerId: "local", conflictCount: 0, canManage: true };
const state = (overrides: Partial<PanelState> = {}): PanelState => ({
  activeServer: server,
  syncState: "connected",
  hasConnectedThisSession: true,
  dataState: "current",
  host,
  rooms: [room],
  peopleAttentionItems: [],
  activityAttentionItems: [],
  activityAccess: "allowed",
  canCreateRoom: true,
  ...overrides
});

const ALL_TABS: readonly PanelTab[] = ["rooms", "people", "activity"];
const WITHOUT_ACTIVITY: readonly PanelTab[] = ["rooms", "people"];

export const panelScenarios: readonly Scenario[] = [
  { id: "fresh-install", state: state({ activeServer: undefined, syncState: "offline", host: { hasOwnerCredential: false, running: false, bootstrapped: false, localRoomCount: 0 }, rooms: [], canCreateRoom: false }), expectedConnection: CONNECTION_STATUS_COPY.notSetUp, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0, expectedVisibleTabs: ALL_TABS },
  { id: "onboarding-partial", state: state({ activeServer: undefined, syncState: "offline", host: { hasOwnerCredential: false, running: true, bootstrapped: false, localRoomCount: 0 }, rooms: [], canCreateRoom: false }), expectedConnection: CONNECTION_STATUS_COPY.notSetUp, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0, expectedVisibleTabs: ALL_TABS },
  { id: "local-owner-running", state: state(), expectedConnection: CONNECTION_STATUS_COPY.syncing, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0, expectedVisibleTabs: ALL_TABS },
  { id: "local-owner-stopped", state: state({ syncState: "offline", host: { ...host, running: false }, activityAttentionItems: ["Sharing from this computer stopped"] }), expectedConnection: CONNECTION_STATUS_COPY.notSyncing, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 1, expectedVisibleTabs: ALL_TABS },
  { id: "remote-active-local-host-running", state: state({ activeServer: { ...server, id: "remote", name: "Research server", isOwnEmbedded: false }, rooms: [{ ...room, mountedServerId: "remote" }] }), expectedConnection: CONNECTION_STATUS_COPY.syncing, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0, expectedVisibleTabs: ALL_TABS },
  { id: "remote-member-no-host", state: state({ activeServer: { ...server, id: "remote", isOwnEmbedded: false }, host: { hasOwnerCredential: false, running: false, bootstrapped: false, localRoomCount: 0 }, rooms: [{ ...room, mountedServerId: "remote", canManage: false }], activityAccess: "denied", activityAttentionItems: ["ignored while the tab is hidden"], canCreateRoom: false }), expectedConnection: CONNECTION_STATUS_COPY.syncing, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0, expectedVisibleTabs: WITHOUT_ACTIVITY },
  { id: "remote-initial-connecting", state: state({ activeServer: { ...server, id: "remote", isOwnEmbedded: false }, syncState: "connecting", hasConnectedThisSession: false, rooms: [] }), expectedConnection: CONNECTION_STATUS_COPY.connecting, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0, expectedVisibleTabs: ALL_TABS },
  { id: "remote-reconnecting", state: state({ activeServer: { ...server, id: "remote", isOwnEmbedded: false }, syncState: "connecting", rooms: [] }), expectedConnection: CONNECTION_STATUS_COPY.reconnecting, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0, expectedVisibleTabs: ALL_TABS },
  { id: "revoked", state: state({ activeServer: { ...server, status: "revoked", isOwnEmbedded: false }, syncState: "offline", rooms: [], peopleAttentionItems: [] }), expectedConnection: CONNECTION_STATUS_COPY.noAccess, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0, expectedVisibleTabs: ALL_TABS },
  { id: "owner-recovery", state: state({ activeServer: undefined, syncState: "offline", host: { hasOwnerCredential: false, running: true, bootstrapped: true, localRoomCount: 0 }, rooms: [], canCreateRoom: false }), expectedConnection: CONNECTION_STATUS_COPY.notSetUp, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0, expectedVisibleTabs: ALL_TABS },
  { id: "owner-no-rooms", state: state({ rooms: [] }), expectedConnection: CONNECTION_STATUS_COPY.syncing, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0, expectedVisibleTabs: ALL_TABS },
  { id: "owner-many-rooms", state: state({ rooms: [room, { ...room, id: "research", name: "Research", mounted: false }, { ...room, id: "choice", name: "Choice", conflictCount: 2 }] }), expectedConnection: CONNECTION_STATUS_COPY.syncing, expectedRoomAttention: 2, expectedPeopleAttention: 0, expectedActivityAttention: 0, expectedVisibleTabs: ALL_TABS },
  { id: "team-admin", state: state({ activeServer: { ...server, id: "remote", name: "Research server", isOwnEmbedded: false }, rooms: [{ ...room, mountedServerId: "remote", canManage: true }], peopleAttentionItems: ["Hung's access was revoked"], canCreateRoom: false }), expectedConnection: CONNECTION_STATUS_COPY.syncing, expectedRoomAttention: 0, expectedPeopleAttention: 1, expectedActivityAttention: 0, expectedVisibleTabs: ALL_TABS },
  { id: "remote-member-activity-unknown", state: state({ activeServer: { ...server, id: "remote", isOwnEmbedded: false }, dataState: "stale-error", rooms: [{ ...room, mountedServerId: "remote", canManage: false }], activityAccess: "unknown", canCreateRoom: false }), expectedConnection: CONNECTION_STATUS_COPY.syncing, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0, expectedVisibleTabs: ALL_TABS },
  { id: "security-pin-mismatch", state: state({ activeServer: { ...server, id: "remote", isOwnEmbedded: false, securityState: "pin_mismatch" }, syncState: "offline", rooms: [], activityAttentionItems: ["Server identity could not be verified"] }), expectedConnection: CONNECTION_STATUS_COPY.noAccess, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 1, expectedVisibleTabs: ALL_TABS }
] as const;
