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
  attachments. File sync itself still uses base64-over-JSON; raw framing is the next transport milestone.
- **DHCP-safe connection recovery.** Hosts are guided toward stable `.local` names. A teammate can verify and
  replace a stale saved endpoint through a bounded, user-triggered LAN multicast/broadcast search, without changing device identity,
  credentials, rooms, mounts, teams, friendships, or access. Discovery is bounded, user-triggered, and available
  only when pinned TLS can authenticate the result before credentials are sent. Existing IP/hostname settings
  remain unchanged; legacy HTTP and older clients keep manual address replacement. Invite links include the
  stable `serverId`, so a fresh link updates an existing connection instead of creating a duplicate identity.
- **Obsidian 1.13 settings compatibility.** Vault Rooms settings render as a normal vertical list instead of one
  overflowing horizontal row.

## Shipped in 0.2.8

- **Pinned-TLS identity changes no longer strand a live client.** A client that outlives one request now reads
  the saved connection's pinned certificate per request instead of snapshotting it, so an applied identity
  rotation reaches every client. Previously the sync engine's client kept presenting a superseded certificate
  and every file push failed the TLS handshake with `certificate signature failure` - unrecoverably, because by
  then the server's presented identity already matched the saved pin.
- **One object per saved connection.** Replacements (rotation recovery, TLS migration, invite acceptance) now
  update that object in place rather than swapping a new one into settings, so recovery, revocation, and
  success state can no longer be derived from - or written back onto - a superseded copy. The worst case this
  removes is a stale holder restoring the device token the relay invalidated during migration.
- **A terminal identity failure stops once.** Mounting a room with pre-existing files no longer logs one TLS
  error and raises one pin-mismatch prompt per file: the push loop stops when the connection itself becomes
  unusable, reports how many files went unsynced, and the prompt is raised once per connection even when
  requests fail concurrently.

## Prepared for 0.2.9 — release gates pending

- **Portable names and recovery.** Shared path identity across the relay, ACLs and clients; legacy collisions
  remain paused until the owner and affected devices preserve their work and repair names. The panel exposes
  paused files and recovery actions. Case-only editor renames preserve the intended spelling.
- **Sync integrity fixes.** Blob deletion follows durable metadata, Live editing mode changes coordinate CRDT
  saves, and recovery/reload retain local edits and pending intentions. Blocked denies all data permissions.
- **Transport and validation fixes.** Pinned raw uploads, request authentication/CORS, observable embedded DB
  flush failures, LAN discovery without interface inventory, and invalid UTF-8 rejection.
- Local automated checks and a native two-vault macOS smoke pass. Windows and two physical machines remain
  required before a release tag. See [0.2.9 release notes and evidence](docs/superpowers/specs/2026-10-02-release-0.2.9.md).

## Next up

- **Raw binary sync framing (Phase C).** Replace base64-over-JSON for capable peers with raw WebSocket frames and
  the existing authenticated raw HTTP seam. Base64 remains the tested fallback for older peers. Hash versions
  stay explicit so an upgrade produces no conflict copies, re-pushes, or re-downloads. The first release keeps
  the current whole-payload model; chunking, resume, and backpressure remain deferred until the per-file ceiling
  is raised.
- **Phase C mixed-version soak.** Test Phase B and Phase C clients and relays in both directions on real hardware.
  Release only after every combination converges with no conflict copies and the base64 fallback remains live.
- **Chat v1 core.** Direct, ad-hoc group (1-n), team, and room threads share the authenticated `/sync` connection
  but keep separate authorization and presence state. Text/Markdown, emoji reactions, unread state, presence,
  sender deletion, and the built-in sticker catalog ship before attachments. Message metadata stays in a
  separately-pruned `chat.db`.
- **Chat attachments.** Image messages reference either an existing authorized room file or an external chat
  blob. Blob bytes reuse the external store and raw HTTP seam. No chat attachment folder is created in any Vault.
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

- **Selective sync / partial mounts.** Mounting a room is all-or-nothing per folder today.
- **Conflict resolution UI beyond keep-both.** A real diff/merge view for the whole-file lane.
- **Multi-server rooms.** A room lives on exactly one relay; there is no federation.
