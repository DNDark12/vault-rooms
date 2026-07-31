import { CONNECTION_STATUS_COPY, HOSTING_STATUS_COPY } from "../onboarding.js";
import { PANEL_COPY } from "./panelCopy.js";

export type PanelTab = "rooms" | "people" | "activity";
export type PanelDataState = "current" | "refreshing" | "stale-error";
export type PanelRoomAction = "open" | "add" | "remove" | "switch" | "manage";

export type PanelState = {
  activeServer?: {
    id: string;
    name: string;
    status: "active" | "revoked";
    securityState: "ok" | "pin_mismatch" | "migrating";
    isOwnEmbedded: boolean;
  };
  syncState: "connected" | "connecting" | "offline";
  hasConnectedThisSession: boolean;
  dataState: PanelDataState;
  host: {
    hasOwnerCredential: boolean;
    running: boolean;
    bootstrapped: boolean;
    localRoomCount: number;
    error?: string;
  };
  rooms: PanelRoomState[];
  peopleAttentionItems: readonly string[];
  activityAttentionItems: readonly string[];
  canCreateRoom: boolean;
};

export type PanelRoomState = {
  id: string;
  name: string;
  mounted: boolean;
  mountedPath?: string;
  mountedServerId?: string;
  conflictCount: number;
  canManage: boolean;
};

export type PanelDescriptor = {
  connection: {
    key: keyof typeof CONNECTION_STATUS_COPY;
    label: string;
    tone: "positive" | "neutral" | "warning" | "negative";
    summary: string;
  };
  hostLine?: { status: string; text: string; action?: "setup" | "recover" | "start" | "stop" };
  alert?: string;
  dataNotice?: { text: string; action?: "retry" };
  tabs: Record<PanelTab, { label: string; attentionCount: number }>;
  rooms: RoomPresentation[];
  emptyRoomMessage?: string;
};

export type RoomPresentation = PanelRoomState & {
  status: string;
  attention: boolean;
  actions: PanelRoomAction[];
};

export function countPausedLocalRooms(
  mountedRooms: Record<string, { serverId?: string; unmounted?: boolean }>,
  ownEmbeddedServerId: string | undefined
): number {
  if (!ownEmbeddedServerId) return 0;
  return Object.values(mountedRooms).filter(
    (room) => room.serverId === ownEmbeddedServerId && !room.unmounted
  ).length;
}

export function panelModel(state: PanelState): PanelDescriptor {
  const connection = connectionPresentation(state);
  const rooms = state.rooms.map((room) => roomPresentation(room, state.activeServer?.id));
  const roomAttention = rooms.filter((room) => room.attention).length;
  const activityAttention = state.activityAttentionItems.length;

  return {
    connection,
    hostLine: hostPresentation(state),
    alert: connectionAlert(state),
    dataNotice:
      state.dataState === "refreshing"
        ? { text: PANEL_COPY.data.refreshing }
        : state.dataState === "stale-error"
          ? { text: PANEL_COPY.data.stale, action: "retry" }
          : undefined,
    tabs: {
      rooms: { label: PANEL_COPY.tabs.rooms, attentionCount: roomAttention },
      people: { label: PANEL_COPY.tabs.people, attentionCount: state.peopleAttentionItems.length },
      activity: { label: PANEL_COPY.tabs.activity, attentionCount: activityAttention }
    },
    rooms,
    emptyRoomMessage:
      rooms.length === 0
        ? state.canCreateRoom
          ? PANEL_COPY.room.noRoomsOwner
          : PANEL_COPY.room.noRoomsMember
        : undefined
  };
}

function connectionPresentation(state: PanelState): PanelDescriptor["connection"] {
  const server = state.activeServer;
  if (!server) {
    return {
      key: "notSetUp",
      label: CONNECTION_STATUS_COPY.notSetUp,
      tone: "neutral",
      summary: "Choose how this computer should connect."
    };
  }
  if (server.status === "revoked" || server.securityState === "pin_mismatch") {
    return {
      key: "noAccess",
      label: CONNECTION_STATUS_COPY.noAccess,
      tone: "negative",
      summary: `${server.name} needs attention before files can sync.`
    };
  }
  if (state.syncState === "connecting") {
    if (!state.hasConnectedThisSession) {
      return {
        key: "connecting",
        label: CONNECTION_STATUS_COPY.connecting,
        tone: "warning",
        summary: "Connecting to selected server."
      };
    }
    return {
      key: "reconnecting",
      label: CONNECTION_STATUS_COPY.reconnecting,
      tone: "warning",
      summary: "Connection lost. Reconnecting to selected server."
    };
  }
  if (state.syncState !== "connected") {
    return {
      key: "notSyncing",
      label: CONNECTION_STATUS_COPY.notSyncing,
      tone: "negative",
      summary: `${server.name} is not syncing right now.`
    };
  }
  const syncingRooms = state.rooms.filter(
    (room) => room.mounted && (!room.mountedServerId || room.mountedServerId === server.id)
  );
  const summary =
    state.rooms.length === 0
      ? "No shared rooms yet"
      : syncingRooms.length === 1
        ? `${syncingRooms[0]?.name ?? "This room"} is syncing`
        : syncingRooms.length > 1
          ? `${syncingRooms.length} rooms are syncing`
          : `Connected to ${server.name}`;
  return { key: "syncing", label: CONNECTION_STATUS_COPY.syncing, tone: "positive", summary };
}

function hostPresentation(state: PanelState): PanelDescriptor["hostLine"] {
  const host = state.host;
  if (!host.hasOwnerCredential && host.running && host.bootstrapped) {
    return {
      status: HOSTING_STATUS_COPY.recovery,
      text: PANEL_COPY.hosting.recovery,
      action: "recover"
    };
  }
  if (host.error) {
    return {
      status: HOSTING_STATUS_COPY.stopped,
      text: host.error,
      action: host.hasOwnerCredential ? "start" : "setup"
    };
  }
  if (!host.hasOwnerCredential && state.activeServer && !state.activeServer.isOwnEmbedded) {
    return undefined;
  }
  if (!host.hasOwnerCredential && !host.bootstrapped) {
    return {
      status: HOSTING_STATUS_COPY.notSetUp,
      text: "This computer is not sharing rooms yet.",
      action: "setup"
    };
  }
  if (state.activeServer?.isOwnEmbedded) {
    return host.running
      ? undefined
      : { status: HOSTING_STATUS_COPY.stopped, text: PANEL_COPY.hosting.stopped, action: "start" };
  }
  if (host.running) {
    return {
      status: HOSTING_STATUS_COPY.running,
      text: PANEL_COPY.hosting.pausedHere(host.localRoomCount)
    };
  }
  if (host.hasOwnerCredential && host.bootstrapped) {
    return {
      status: HOSTING_STATUS_COPY.stopped,
      text: state.activeServer && state.syncState === "connected"
        ? PANEL_COPY.hosting.remoteContinues
        : PANEL_COPY.hosting.stopped,
      action: "start"
    };
  }
  return undefined;
}

function connectionAlert(state: PanelState): string | undefined {
  const server = state.activeServer;
  if (server?.securityState === "pin_mismatch") {
    return "Sync is blocked because this server presented an unverified identity. Compare its saved and presented fingerprints with the owner.";
  }
  if (server?.status === "revoked") {
    return "This computer no longer has access. Join again with a new invite.";
  }
  return undefined;
}

function roomPresentation(room: PanelRoomState, activeServerId: string | undefined): RoomPresentation {
  const paused = room.mounted && Boolean(room.mountedServerId && room.mountedServerId !== activeServerId);
  const attention = paused || room.conflictCount > 0 || !room.mounted;
  const actions: PanelRoomAction[] = paused
    ? ["switch"]
    : room.mounted
      ? ["open", "remove"]
      : ["add"];
  if (room.canManage) actions.push("manage");
  const status = paused
    ? PANEL_COPY.room.paused
    : room.conflictCount > 0
      ? PANEL_COPY.room.needsChoice(room.conflictCount)
      : room.mounted
        ? PANEL_COPY.room.location(room.mountedPath ?? room.name)
        : PANEL_COPY.room.notOnDevice;
  return { ...room, status, attention, actions };
}
