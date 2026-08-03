# Roadmap

What's next, by priority. Nothing here is a product claim until it ships. See [README](README.md) for what the
plugin does today and [SECURITY.md](SECURITY.md) for the threat model.

## Shipped in 0.2.4

- **Live cursors / note presence v1.** Authorized teammates who open the same CRDT Markdown note now see each
  other's caret, selection, authenticated display name, and a relay-assigned color, unique among live users in
  that room session and tuned to your theme. Assigning colors on the relay rather than hashing them per client
  is what makes every receiver agree on who is which color. Presence is ephemeral and note-scoped: it
  disappears on editor/session cleanup, is never persisted, and deliberately has no participant bar. It remains
  separate from chat's future server-wide online/offline presence.

## Shipped in 0.2.5

- **Guided onboarding.** A fresh host now follows one four-step path to verify its LAN address, create the
  owner account, create the first room with safe defaults, and issue a room invite. Loopback and unspecified
  addresses are rejected before mutation; link-local addresses require explicit acknowledgement; automatic
  startup is enabled only after the host-side reachability check passes. Existing owners, saved rooms, owner
  recovery, room defaults, and the per-room live-editing setting remain intact.
- **Rooms-first panel UX.** The full panel now uses one active-sync status, a separate contextual hosting line,
  and Rooms / People / Activity tabs for every role and server state. Room and team management is
  permission-driven, technical details are progressively disclosed, stale data is marked, and routine actions
  use plain file-oriented language. People is grouped by effective room access, and Room Manage translates
  exact permission presets into human language while keeping custom/raw rules under disclosure.
- **Live editing default for new rooms.** New rooms start with Markdown live editing enabled. Existing rooms
  keep their persisted choice; there is no silent migration. The toggle shares the room's explicit
  **Save changes** path.

## Next up

- **Continue CRDT soak.** Live editing is now the default for new rooms and remains the newest, most
  integrity-sensitive part of the plugin. Continue broadening the real-machine and mixed-version soak beyond
  the 0.2.5 release checks. Two of the three known gaps are now closed (an edit typed inside the rename
  acknowledgement window is re-offered immediately, and an in-flight
  request is failed rather than stranded when the socket drops). The remaining one is a coexistence trade-off
  needing a decision: a peer on a build older than the rename protocol applies a rename only after reconnecting.
  Closing it means also broadcasting the rename as a delete+create to non-CRDT peers, which is more traffic and
  more edge cases for a case that already self-heals.
- **Chat v1, after live cursors.** The existing design remains viable: direct, team, and room threads; immutable
  Markdown messages; unread state; realtime delivery over the authenticated `/sync` socket; history isolated in
  a separately-pruned `chat.db`; and a docked desktop UI. Refresh the protocol and threat-model sections before
  implementation because TLS pinning and CRDT traffic have shipped since the design was written. Do not bundle
  chat with cursors: they can share connection lifecycle and identity, but not authorization or presence state.
- **Binary transport instead of base64.** Images and PDFs currently travel base64-encoded, costing ~33% overhead
  and lowering the practical size ceiling. Independent of everything else.

## Bigger efforts - each needs its own design pass

- **Selective sync / partial mounts.** Mounting a room is all-or-nothing per folder today.
- **Conflict resolution UI beyond keep-both.** A real diff/merge view for the whole-file lane.
- **Multi-server rooms.** A room lives on exactly one relay; there is no federation.
