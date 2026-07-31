import { CONNECTION_STATUS_COPY } from "../onboarding.js";
import type { PanelState } from "./panelModel.js";

type Scenario = {
  id: string;
  state: PanelState;
  expectedConnection: string;
  expectedRoomAttention: number;
  expectedPeopleAttention: number;
  expectedActivityAttention: number;
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
  canCreateRoom: true,
  ...overrides
});

export const panelScenarios: readonly Scenario[] = [
  { id: "fresh-install", state: state({ activeServer: undefined, syncState: "offline", host: { hasOwnerCredential: false, running: false, bootstrapped: false, localRoomCount: 0 }, rooms: [], canCreateRoom: false }), expectedConnection: CONNECTION_STATUS_COPY.notSetUp, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0 },
  { id: "onboarding-partial", state: state({ activeServer: undefined, syncState: "offline", host: { hasOwnerCredential: false, running: true, bootstrapped: false, localRoomCount: 0 }, rooms: [], canCreateRoom: false }), expectedConnection: CONNECTION_STATUS_COPY.notSetUp, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0 },
  { id: "local-owner-running", state: state(), expectedConnection: CONNECTION_STATUS_COPY.syncing, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0 },
  { id: "local-owner-stopped", state: state({ syncState: "offline", host: { ...host, running: false }, activityAttentionItems: ["Sharing from this computer stopped"] }), expectedConnection: CONNECTION_STATUS_COPY.notSyncing, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 1 },
  { id: "remote-active-local-host-running", state: state({ activeServer: { ...server, id: "remote", name: "Research server", isOwnEmbedded: false }, rooms: [{ ...room, mountedServerId: "remote" }] }), expectedConnection: CONNECTION_STATUS_COPY.syncing, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0 },
  { id: "remote-member-no-host", state: state({ activeServer: { ...server, id: "remote", isOwnEmbedded: false }, host: { hasOwnerCredential: false, running: false, bootstrapped: false, localRoomCount: 0 }, rooms: [{ ...room, mountedServerId: "remote", canManage: false }], canCreateRoom: false }), expectedConnection: CONNECTION_STATUS_COPY.syncing, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0 },
  { id: "remote-initial-connecting", state: state({ activeServer: { ...server, id: "remote", isOwnEmbedded: false }, syncState: "connecting", hasConnectedThisSession: false, rooms: [] }), expectedConnection: CONNECTION_STATUS_COPY.connecting, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0 },
  { id: "remote-reconnecting", state: state({ activeServer: { ...server, id: "remote", isOwnEmbedded: false }, syncState: "connecting", rooms: [] }), expectedConnection: CONNECTION_STATUS_COPY.reconnecting, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0 },
  { id: "revoked", state: state({ activeServer: { ...server, status: "revoked", isOwnEmbedded: false }, syncState: "offline", rooms: [], peopleAttentionItems: [] }), expectedConnection: CONNECTION_STATUS_COPY.noAccess, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0 },
  { id: "owner-recovery", state: state({ activeServer: undefined, syncState: "offline", host: { hasOwnerCredential: false, running: true, bootstrapped: true, localRoomCount: 0 }, rooms: [], canCreateRoom: false }), expectedConnection: CONNECTION_STATUS_COPY.notSetUp, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0 },
  { id: "owner-no-rooms", state: state({ rooms: [] }), expectedConnection: CONNECTION_STATUS_COPY.syncing, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 0 },
  { id: "owner-many-rooms", state: state({ rooms: [room, { ...room, id: "research", name: "Research", mounted: false }, { ...room, id: "choice", name: "Choice", conflictCount: 2 }] }), expectedConnection: CONNECTION_STATUS_COPY.syncing, expectedRoomAttention: 2, expectedPeopleAttention: 0, expectedActivityAttention: 0 },
  { id: "team-admin", state: state({ activeServer: { ...server, id: "remote", name: "Research server", isOwnEmbedded: false }, rooms: [{ ...room, mountedServerId: "remote", canManage: true }], peopleAttentionItems: ["Hung's access was revoked"], canCreateRoom: false }), expectedConnection: CONNECTION_STATUS_COPY.syncing, expectedRoomAttention: 0, expectedPeopleAttention: 1, expectedActivityAttention: 0 },
  { id: "security-pin-mismatch", state: state({ activeServer: { ...server, id: "remote", isOwnEmbedded: false, securityState: "pin_mismatch" }, syncState: "offline", rooms: [], activityAttentionItems: ["Server identity could not be verified"] }), expectedConnection: CONNECTION_STATUS_COPY.noAccess, expectedRoomAttention: 0, expectedPeopleAttention: 0, expectedActivityAttention: 1 }
] as const;
