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
    needsChoice: (count: number) => `${count} file${count === 1 ? "" : "s"} need a choice`,
    noRoomsOwner: "No rooms yet. Create one to start sharing.",
    noRoomsMember: "No rooms are available yet. Ask the room owner to invite you."
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
  activity: {
    heading: "Most recent first",
    connections: "Connections",
    switch: "Switch",
    test: "Test connection",
    join: "Join another server",
    details: "Connection details"
  }
} as const;
