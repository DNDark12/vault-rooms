export const PANEL_COPY = {
  tabs: {
    rooms: "Rooms",
    people: "People",
    activity: "Activity"
  },
  room: {
    open: "Open",
    add: "Add to this computer",
    remove: "Remove from this computer",
    switch: "Switch",
    manage: "Manage",
    create: "Create room",
    refresh: "Refresh",
    retry: "Try again",
    location: (path: string) => `In your vault at ${path}`,
    notOnDevice: "Not on this computer",
    paused: "Local files are paused while another server is active",
    needsChoice: (count: number) =>
      count === 1 ? "1 file needs a choice" : `${count} files need a choice`,
    noRoomsOwner: "No rooms yet. Create one to start sharing.",
    noRoomsMember: "No rooms are available yet. Ask the room owner to invite you.",
    attentionLabel: "Needs a choice"
  },
  pausedPaths: {
    review: "Review paused files",
    heading: "Paused files",
    count: (count: number) => count === 1 ? "1 file name is paused" : `${count} file names are paused`,
    serverCollision: "These names overlap on the server. The room owner must rename the server files to distinct names. Other files in this room continue syncing.",
    localCollision: "These names overlap on this computer. Rename each exact local file to a distinct name. All local content and saved recovery copies are preserved; no file is chosen as the winner.",
    recoveryPending: "The server names are repaired. Local recovery must preserve saved edits and pull the authoritative files before these names resume syncing.",
    ambiguousJournal: "A saved file operation has an ambiguous name. Its original intent is retained. Review the operation before retrying; no server file will be deleted automatically.",
    preserveReload: "Preserve local work and reload server state",
    preserveReloadConfirm: "Save all local edits and the original file operations in recovery copies and history, then stop replaying these ambiguous operations and reload the server files. Server files are preserved. You can rename the saved local copies afterward.",
    ownerRepair: "Repair server names",
    askOwner: "Ask the room owner to repair the server names, then try again.",
    retry: "Retry recovery",
    retrying: "Recovering…",
    localRename: "Rename exact local file",
    localRenaming: "Preserving and renaming…",
    exactPath: "Exact local file",
    newPath: "New distinct path inside this room",
    localRenamed: "Local file preserved and renamed. Recovery will resume after the remaining names are distinct.",
    renameFailed: "Local recovery failed. All pending state remains available; try again.",
    recoveryFailed: "Recovery failed. The file remains paused; try again.",
    none: "No file names are paused. Close this dialog to return to your rooms.",
    editNotice: (path: string, reason: string) => `Vault Rooms: sync is paused for "${path}". ${reason} Open Rooms → Review paused files.`
  },
  /**
   * Every empty state names an action or says who can act. A bare "None yet." leaves a user unable to
   * tell a missing permission from a missing feature.
   */
  empty: {
    peopleNoServer: "Join a server to see who you share with.",
    peopleWithAccessOwner: "No one else can reach these rooms yet. Use Invite to add someone.",
    peopleWithAccessMember: "No one else has access yet. Only the server owner can invite people.",
    peopleWithoutAccess: "Everyone listed here already has access to a room.",
    teamsOwner: "No teams yet. Create one to give several people the same access at once.",
    teamsMember: "No teams yet. Only the server owner can create one.",
    activityNoPermission: "Activity is available to server owners and team managers.",
    activityNone: "No activity yet. Actions on this server will appear here.",
    connectionNone:
      "No connection selected. Set up sharing on this computer, or join someone else's server."
  },
  hosting: {
    stopped: "Sharing from this device is stopped",
    remoteContinues: "Sharing from this device is stopped; remote rooms continue syncing",
    pausedHere: (count: number) =>
      `${count} local room${count === 1 ? "" : "s"} paused here — Hosting continues for teammates; local files resume when you switch back.`,
    recovery: "Recover access without resetting the rooms already stored here.",
    start: "Start sharing",
    stop: "Pause sharing",
    setup: "Set up and share",
    recover: "Recover server access"
  },
  data: {
    refreshing: "Refreshing…",
    stale: "The last update failed. Showing the most recent information saved on this screen.",
    retry: "Try again"
  },
  /** Storage warnings shown near or over the configured limit. */
  storage: {
    nearLimit: "This server's storage is nearly full. Delete files you don't need, or ask whoever hosts it to free up space.",
    overLimit: "This server's storage is full. New files and edits are rejected until whoever hosts it frees up space."
  },
  /**
   * Which machine a connection is, in the user's terms. Two saved remote servers must not read the same,
   * so the owner's cached name is preferred and the port is the fallback; `someoneElse` remains only for
   * a connection with neither.
   */
  connection: {
    thisComputer: "This computer",
    yourServer: "Your server",
    ownedBy: (owner: string) => `${owner}'s server`,
    // Port, not the full address: it distinguishes relays co-hosted on one machine without putting an
    // IP back on screen. Used only until the owner's name has been cached.
    unnamedOnPort: (port: string) => `Someone else's server · port ${port}`,
    someoneElse: "Someone else's server"
  },
  diagnostics: {
    /** Shared by the panel's own disclosure and Test connection's raw-evidence disclosure. */
    technical: "Technical details"
  },
  pathCollisions: {
    heading: "File names need a choice",
    description: "Windows and macOS treat these file names as the same. Rename files in each group until their names are distinct to resume syncing. Each file keeps its content and history.",
    newPath: "New path inside this room",
    rename: "Rename file",
    renaming: "Renaming…",
    loading: "Checking file names…",
    retry: "Try again",
    unavailable: "File name recovery is unavailable. Try again, or ask whoever hosts this server to update it.",
    renameFailed: "Failed to rename this file. Choose another name and try again.",
    renamed: "File renamed. Its content and history are preserved."
  },
  activity: {
    heading: "Most recent first",
    connections: "Connections",
    switch: "Switch",
    test: "Test connection",
    join: "Join another server",
    details: "Connection details"
  }
} as const;
