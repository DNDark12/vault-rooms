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

## Shipped in 0.2.6

- **Every file in a room syncs.** The old extension allowlist is gone: known-text extensions travel as UTF-8 and
  everything else (audio, video, Office documents, extensionless and unrecognized files) as base64 binary, so no
  file type is silently skipped. Dotfiles and dotfolders remain excluded on purpose. Mixed-version safety is
  explicit rather than inferred - a peer that has not advertised `extendedBinarySync` never learns those paths
  exist, instead of receiving content an older build would write to disk incorrectly.
- **Offline Markdown create/rename survives a restart.** Structural intent is journaled to disk, coalesced to the
  user's final filesystem state, and replayed after the reconnect snapshot. The relay stores an idempotency
  receipt in the same transaction as the mutation, so a retry after a lost acknowledgement returns the recorded
  result instead of creating a duplicate note. Turning live editing off with pending intent converts it to the
  whole-file lane rather than stranding it.
- **Live editing skips `*.excalidraw.md`.** Character-level merging on structured JSON could produce a drawing
  that no longer loads, so that format stays on the whole-file lane like `.canvas` and `.excalidraw`.

## Shipped in 0.2.7

- **Binary storage and retention.** Whole-file content now lives as immutable, content-addressed blobs outside
  SQLite in both standalone and embedded relays. Writes retain only the latest version, collect unreferenced
  legacy and external blobs, enforce a projected 256 MiB stored-content ceiling, migrate old content resumably,
  expose storage usage and explicit SQLite compaction, and provide authenticated raw HTTP bytes for future chat
  attachments. File sync itself still uses base64-over-JSON; optional raw framing remains Phase C.
- **DHCP-safe connection recovery.** Hosts are guided toward stable `.local` names. A teammate can verify and
  replace a stale saved endpoint through a bounded, user-triggered LAN multicast/broadcast search, without changing device identity,
  credentials, rooms, mounts, teams, friendships, or access. Discovery is bounded, user-triggered, and available
  only when pinned TLS can authenticate the result before credentials are sent. Existing IP/hostname settings
  remain unchanged; legacy HTTP and older clients keep manual address replacement. Invite links include the
  stable `serverId`, so a fresh link updates an existing connection instead of creating a duplicate identity.
- **Obsidian 1.13 settings compatibility.** Vault Rooms settings render as a normal vertical list instead of one
  overflowing horizontal row.

## Next up

- **Chat v1.** Direct, ad-hoc group (1-n), team, and room threads share the authenticated
  `/sync` connection but keep their own authorization and presence state. The release is staged: text/Markdown,
  emoji reactions, unread state, presence, sender deletion, and a built-in sticker catalog form the chat core;
  image messages then reference either an existing authorized room file or an external chat blob. No chat
  attachment folder is created in any Vault. Message metadata stays in a separately-pruned `chat.db`; blob bytes
  reuse Phase B's external store and raw HTTP seam. General file-sync raw transport in Phase C does not block
  chat.
- **Continue CRDT soak.** Live editing is the default for new rooms and remains the newest, most
  integrity-sensitive part of the plugin. Continue broadening the real-machine and mixed-version soak beyond
  the 0.2.5 and 0.2.6 release checks; the two new surfaces are journal replay across a full restart and the
  binary/mixed-version visibility gate. All three of the originally known rename gaps are now closed (an edit
  typed inside the acknowledgement window is re-offered immediately, an in-flight request is failed rather than
  stranded when the socket drops, and offline structural intent is durable). The remaining coexistence trade-off
  still needs a decision: a peer on a build older than the rename protocol applies a rename only after
  reconnecting. Closing it means also broadcasting the rename as a delete+create to non-CRDT peers, which is more
  traffic and more edge cases for a case that already self-heals.

## Bigger efforts - each needs its own design pass

- **Raw binary sync framing (optional Phase C).** Remove base64's transient frame/RAM overhead without changing
  the hash domain for old peers or producing conflict-copy storms. Phase B already fixed persistent storage and
  flush amplification, so this does not block chat.
- **Selective sync / partial mounts.** Mounting a room is all-or-nothing per folder today.
- **Conflict resolution UI beyond keep-both.** A real diff/merge view for the whole-file lane.
- **Multi-server rooms.** A room lives on exactly one relay; there is no federation.
