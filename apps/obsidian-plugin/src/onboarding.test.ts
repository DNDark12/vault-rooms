import { describe, expect, it } from "vitest";
import {
  CONNECTION_STATUS_COPY,
  HOSTING_STATUS_COPY,
  ONBOARDING_STEPS,
  completedOnboardingSteps,
  desktopPlatform,
  firstIncompleteOnboardingStep,
  hasDurableOnboardingConnection,
  inviteMessageFor,
  inviteTextForView,
  lanAddressHelp,
  onboardingCopyForStep,
  recommendedRoomInput,
  sanitizeRoomMountName,
  shouldExpandAddressHelp
} from "./onboarding.js";

describe("guided onboarding policy", () => {
  it("selects the first incomplete durable stage", () => {
    expect(firstIncompleteOnboardingStep({ connectionConfigured: false, ownerReady: false, roomReady: false })).toBe("connection");
    expect(firstIncompleteOnboardingStep({ connectionConfigured: true, ownerReady: false, roomReady: false })).toBe("profile");
    expect(firstIncompleteOnboardingStep({ connectionConfigured: true, ownerReady: true, roomReady: false })).toBe("room");
    expect(firstIncompleteOnboardingStep({ connectionConfigured: true, ownerReady: true, roomReady: true })).toBe("invite");
  });

  it("never rewinds an established owner when auto-start is intentionally off", () => {
    expect(firstIncompleteOnboardingStep({ connectionConfigured: false, ownerReady: true, roomReady: false })).toBe("room");
    expect(firstIncompleteOnboardingStep({ connectionConfigured: false, ownerReady: true, roomReady: true })).toBe("invite");
  });

  it("keeps recovery and invite-later distinct from full completion", () => {
    expect(completedOnboardingSteps({ step: "connection", terminalExit: "recovery" })).toEqual(["connection"]);
    expect(completedOnboardingSteps({ step: "invite", terminalExit: "invite-later" })).toEqual([
      "connection",
      "profile",
      "room"
    ]);
    expect(completedOnboardingSteps({ step: "invite", terminalExit: "invite-later" })).not.toContain("invite");
  });

  it("derives Connection completion only from durable settings", () => {
    expect(hasDurableOnboardingConnection({ publicUrlOverride: "192.168.1.49", autoStart: true })).toBe(true);
    expect(hasDurableOnboardingConnection({ publicUrlOverride: "192.168.1.49", autoStart: false })).toBe(false);
    expect(hasDurableOnboardingConnection({ publicUrlOverride: "   ", autoStart: true })).toBe(false);
  });

  it("expands the address help only before any address has been saved", () => {
    expect(shouldExpandAddressHelp({})).toBe(true);
    expect(shouldExpandAddressHelp({ publicUrlOverride: "   " })).toBe(true);
    expect(shouldExpandAddressHelp({ publicUrlOverride: "192.168.1.49" })).toBe(false);
  });

  it("does not reuse durable-connection state as the first-run test", () => {
    const savedButUnverified = { publicUrlOverride: "169.254.10.20", autoStart: false };
    expect(hasDurableOnboardingConnection(savedButUnverified)).toBe(false);
    expect(shouldExpandAddressHelp(savedButUnverified)).toBe(false);
  });

  it("shows platform-specific address instructions without inspecting interfaces", () => {
    expect(lanAddressHelp("macos")).toBe(
      "Open System Settings → Wi-Fi → Details → TCP/IP, then copy the IP address."
    );
    expect(lanAddressHelp("windows")).toBe(
      "Open Settings → Network & Internet → your active connection → Properties, then copy the IPv4 address."
    );
    expect(lanAddressHelp("other")).toBe(
      "Open the active connection in your system network settings, then copy its IPv4 address."
    );
  });

  it("builds the safe current room defaults from the selected folder", () => {
    expect(recommendedRoomInput("Projects/Alpha")).toEqual({
      name: "Alpha",
      type: "folder",
      sourcePath: "Projects/Alpha",
      mountName: "Alpha",
      conflictPolicy: "keep_both",
      capabilities: [
        { pluginId: "obsidian-tasks-plugin", displayName: "Tasks", mode: "recommended" },
        { pluginId: "obsidian-kanban", displayName: "Kanban", mode: "recommended" }
      ]
    });
    expect(recommendedRoomInput("Projects/Alpha")).not.toHaveProperty("crdtEnabled");
  });

  it("keeps a mount name to one safe path segment", () => {
    expect(sanitizeRoomMountName("Project/Alpha")).toBe("Project-Alpha");
    expect(sanitizeRoomMountName("..Alpha")).toBe("Alpha");
    expect(sanitizeRoomMountName("")).toBe("Room");
  });

  it("provides the complete fixed copy consumed by each screen", () => {
    expect(ONBOARDING_STEPS).toEqual(["Connection", "About you", "Shared folder", "Invite"]);
    expect(HOSTING_STATUS_COPY).toEqual({
      notSetUp: "Not sharing yet",
      inProgress: "Setup in progress",
      recovery: "Locked out on this computer",
      ready: "Ready to share",
      running: "Hosting",
      stopped: "Hosting paused"
    });
    expect(CONNECTION_STATUS_COPY).toEqual({
      syncing: "Syncing",
      connecting: "Connecting",
      notSyncing: "Not syncing",
      reconnecting: "Reconnecting",
      noAccess: "No access",
      notSetUp: "Not set up"
    });
    expect(onboardingCopyForStep("connection")).toEqual({
      title: "Connect this computer",
      fieldLabel: "This computer's address on your network",
      primaryAction: "Check connection",
      pendingAction: "Checking connection…",
      helpAction: "Where do I find this?",
      readyStatus: "Connection ready",
      continueAction: "Continue",
      cautiousContinueAction: "Continue with this address",
      errorFallback: "Connection check failed"
    });
    expect(onboardingCopyForStep("profile")).toEqual({
      title: "How teammates see you",
      fieldLabel: "Your name",
      deviceLabel: "This computer",
      primaryAction: "Create my account",
      pendingAction: "Creating your account…",
      errorFallback: "Could not create your account"
    });
    expect(onboardingCopyForStep("room")).toEqual({
      title: "Choose one folder to share",
      chooseFolderAction: "Choose folder",
      selectedFolderLabel: "Selected folder",
      fieldLabel: "Room name",
      primaryAction: "Create room",
      pendingAction: "Creating room…",
      errorFallback: "Could not create the room"
    });
    expect(onboardingCopyForStep("invite")).toEqual({
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
    });
  });

  it("wraps the relay-returned link in a message the sender can paste", () => {
    const joinUrl = "obsidian://vault-rooms/join?payload=relay-owned";
    const message = inviteMessageFor(joinUrl);

    expect(message).toBe(
      "I'm sharing some notes with you in Obsidian. Install the Vault Rooms plugin, " +
        `then open this link within the next hour: ${joinUrl}`
    );
    expect(message).toContain(joinUrl);
    expect(inviteMessageFor("")).toBe("");
  });

  it("drives displayed and copied invite text from the same view", () => {
    const joinUrl = "obsidian://vault-rooms/join?payload=relay-owned";
    expect(inviteTextForView(joinUrl, "message")).toBe(inviteMessageFor(joinUrl));
    expect(inviteTextForView(joinUrl, "link")).toBe(joinUrl);
  });

  it("maps the Obsidian platform to the matching help copy", () => {
    expect(desktopPlatform({ isMacOS: true, isWin: false })).toBe("macos");
    expect(desktopPlatform({ isMacOS: false, isWin: true })).toBe("windows");
    expect(desktopPlatform({ isMacOS: false, isWin: false })).toBe("other");
  });
});
