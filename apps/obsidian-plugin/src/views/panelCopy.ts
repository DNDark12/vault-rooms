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
  activity: {
    heading: "Most recent first",
    connections: "Connections",
    switch: "Switch",
    test: "Test connection",
    join: "Join another server",
    details: "Connection details"
  }
} as const;
