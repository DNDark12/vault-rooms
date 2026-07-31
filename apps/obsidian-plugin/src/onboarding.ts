import type { CreateRoomInput } from "./apiClient.js";

export type OnboardingStep = "connection" | "profile" | "room" | "invite";
export type OnboardingTerminalExit = "recovery" | "invite-later";
export type DesktopPlatform = "macos" | "windows" | "other";
export type InviteView = "message" | "link";

const ONBOARDING_STEP_ORDER: readonly OnboardingStep[] = ["connection", "profile", "room", "invite"];

export const ONBOARDING_STEPS = ["Connection", "About you", "Shared folder", "Invite"] as const;

export const HOSTING_STATUS_COPY = {
  notSetUp: "Not sharing yet",
  inProgress: "Setup in progress",
  recovery: "Locked out on this computer",
  ready: "Ready to share",
  running: "Hosting",
  stopped: "Hosting paused"
} as const;

export const CONNECTION_STATUS_COPY = {
  syncing: "Syncing",
  connecting: "Connecting",
  notSyncing: "Not syncing",
  reconnecting: "Reconnecting",
  noAccess: "No access",
  notSetUp: "Not set up"
} as const;

export const ONBOARDING_COPY = {
  connection: {
    title: "Connect this computer",
    fieldLabel: "This computer's address on your network",
    primaryAction: "Check connection",
    pendingAction: "Checking connection…",
    helpAction: "Where do I find this?",
    readyStatus: "Connection ready",
    continueAction: "Continue",
    cautiousContinueAction: "Continue with this address",
    errorFallback: "Connection check failed"
  },
  profile: {
    title: "How teammates see you",
    fieldLabel: "Your name",
    deviceLabel: "This computer",
    primaryAction: "Create my account",
    pendingAction: "Creating your account…",
    errorFallback: "Could not create your account"
  },
  room: {
    title: "Choose one folder to share",
    chooseFolderAction: "Choose folder",
    selectedFolderLabel: "Selected folder",
    fieldLabel: "Room name",
    primaryAction: "Create room",
    pendingAction: "Creating room…",
    errorFallback: "Could not create the room"
  },
  invite: {
    title: "Invite your first teammate",
    fieldLabel: "This teammate can",
    accessLabels: { editor: "View and edit", reader: "View only" },
    primaryAction: "Create invite link",
    pendingAction: "Creating invite link…",
    copyMessageAction: "Copy message",
    copyLinkAction: "Copy link only",
    selectAction: "Select",
    newLinkAction: "Create another link",
    laterAction: "I'll invite someone later",
    inviteNote:
      "This link works once, expires in 60 minutes, and needs Vault Rooms installed on your teammate's computer.",
    doneNote: "Nothing else to do here — your teammate appears in the room once they join.",
    errorFallback: "Could not create the invite link",
    summaryLabels: ["Connection", "Your name", "Room"]
  }
} as const;

export const INVITE_MESSAGE_PREFIX =
  "I'm sharing some notes with you in Obsidian. Install the Vault Rooms plugin, " +
  "then open this link within the next hour: ";

/**
 * Wraps a relay-returned joinUrl in a message the sender can paste into any chat
 * app. The URL is an input and is never constructed here.
 */
export function inviteMessageFor(joinUrl: string): string {
  return joinUrl ? `${INVITE_MESSAGE_PREFIX}${joinUrl}` : "";
}

export function inviteTextForView(joinUrl: string, view: InviteView): string {
  return view === "message" ? inviteMessageFor(joinUrl) : joinUrl;
}

export function onboardingCopyForStep<T extends OnboardingStep>(
  step: T
): (typeof ONBOARDING_COPY)[T] {
  return ONBOARDING_COPY[step];
}

export function desktopPlatform(platform: { isMacOS: boolean; isWin: boolean }): DesktopPlatform {
  return platform.isMacOS ? "macos" : platform.isWin ? "windows" : "other";
}

export function completedOnboardingSteps(input: {
  step: OnboardingStep;
  terminalExit?: OnboardingTerminalExit;
}): readonly OnboardingStep[] {
  if (input.terminalExit === "recovery") return ["connection"];
  if (input.terminalExit === "invite-later") return ["connection", "profile", "room"];
  return ONBOARDING_STEP_ORDER.slice(0, ONBOARDING_STEP_ORDER.indexOf(input.step));
}

export function firstIncompleteOnboardingStep(input: {
  connectionConfigured: boolean;
  ownerReady: boolean;
  roomReady: boolean;
}): OnboardingStep {
  if (input.ownerReady) return input.roomReady ? "invite" : "room";
  return input.connectionConfigured ? "profile" : "connection";
}

export function hasDurableOnboardingConnection(input: {
  publicUrlOverride?: string;
  autoStart: boolean;
}): boolean {
  return input.autoStart && Boolean(input.publicUrlOverride?.trim());
}

/**
 * First-run test for the address help disclosure. Deliberately NOT
 * hasDurableOnboardingConnection(): a saved address whose probe failed, or a
 * link-local check closed before acknowledgement, leaves autoStart false while
 * the user already knows their address and does not need the instructions again.
 */
export function shouldExpandAddressHelp(input: { publicUrlOverride?: string }): boolean {
  return !input.publicUrlOverride?.trim();
}

export function lanAddressHelp(platform: DesktopPlatform): string {
  if (platform === "macos") {
    return "Open System Settings → Wi-Fi → Details → TCP/IP, then copy the IP address.";
  }
  if (platform === "windows") {
    return "Open Settings → Network & Internet → your active connection → Properties, then copy the IPv4 address.";
  }
  return "Open the active connection in your system network settings, then copy its IPv4 address.";
}

export function recommendedRoomInput(sourcePath: string, requestedName?: string): CreateRoomInput {
  const fallbackName = sourcePath.split("/").filter(Boolean).pop() ?? "Room";
  const name = requestedName?.trim() || fallbackName;
  return {
    name,
    type: "folder",
    sourcePath,
    mountName: sanitizeRoomMountName(name),
    conflictPolicy: "keep_both",
    capabilities: [
      { pluginId: "obsidian-tasks-plugin", displayName: "Tasks", mode: "recommended" },
      { pluginId: "obsidian-kanban", displayName: "Kanban", mode: "recommended" }
    ]
  };
}

export function sanitizeRoomMountName(name: string): string {
  const cleaned = name.trim().replace(/[/\\]+/g, "-").replace(/^\.+/, "");
  return cleaned || "Room";
}
