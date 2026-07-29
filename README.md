# Vault Rooms

![Status: Beta](https://img.shields.io/badge/status-beta-orange) ![Platform: Desktop only](https://img.shields.io/badge/platform-desktop--only-blue) ![Network: Trusted LAN only](https://img.shields.io/badge/network-trusted%20LAN%20only-critical)

## What it is

Vault Rooms shares selected folders of your Obsidian vault ("rooms") with trusted people on the same local
network. One device hosts a small relay server; everyone else joins it from the plugin.

Create a room, invite members, grant per-path permissions, and collaborate on Markdown-backed workflows like
Kanban boards and Tasks. It is LAN-first, deny-by-default, and never exposes your whole vault.

Identity is per-server: each device gets one token for the server it joined. **Teams** are named permission
groups you can grant to a room at once; **rooms** are the shared folder boundary and are owned independently of
any team. A room's access list grants or denies a user or a team, per path pattern.

## What it is not

Not cloud sync, not NAT traversal, not mobile, and not a sandbox for other Obsidian plugins. It syncs Markdown
plus a limited set of common file types (see "Known limitations"). Character-level co-editing exists only as a
per-room opt-in for Markdown notes (see "CRDT sync") and is off unless an owner turns it on.

## Quick start

**On the hosting device:**

1. Command palette → **Vault Rooms: Start server**.
2. Settings → Vault Rooms → Relay server → **Public URL override** → enter this machine's LAN address (e.g.
   `192.168.1.100`), then stop and start the server. Confirm the panel shows **LAN share: reachable from this
   device**. This step is required - the host never guesses its own address.
3. Panel → **Set up server** (makes you the owner, and optionally creates your first team).
4. Panel → **Rooms** → **Create room**, and pick a folder to share.
5. In the room's Settings, grant access to a user or team.
6. Panel → **Invite** → choose what it grants → **Create invite** → **Copy**. Send the whole link: it carries
   the server's identity and fingerprint, not just an address.

**On the teammate's device:** click the link, add a display name, join, then **mount** the room that appears
under **Rooms**.

A green reachability badge only proves the host can reach its own address. It cannot prove the teammate's
firewall or Wi-Fi client isolation will allow the connection - if they can't connect, use **Test connection**
and see "Troubleshooting".

## Architecture

One device runs the relay; every other device is a client that only makes outbound connections to it. Nothing
leaves your local network: there is no cloud service, no third-party server, and no telemetry of any kind.

The relay can run two ways, speaking the same protocol either way:

- **Embedded** (recommended) - the plugin runs it in-process. Click **Start server**; no terminal, no config
  file.
- **Standalone** - a separate process, for development or for hosting on an always-on machine or NAS instead of
  someone's laptop.

The relay owns all permission enforcement and keeps each room's file history in a local database. Clients hold a
working copy of the rooms they mount.

## Security model

See [SECURITY.md](SECURITY.md) for the threat model, token handling, and revocation limits. In short:

- **The relay enforces every permission**, per path, on both its request and live-sync channels. The plugin UI is
  convenience only. A member never receives content - or even filenames - for paths they cannot read.
- **New servers use pinned TLS.** The server has a persistent identity whose fingerprint travels in every invite,
  and clients pin it before sending any credential. This authenticates the server and encrypts LAN traffic; it is
  **not** end-to-end encryption - the relay handles plaintext.
- **Creating the first owner is the only unauthenticated privileged action**, and it is gated twice so a
  malicious web page cannot claim your server. It closes permanently once an owner exists.
- **Built for a LAN you already trust.** Don't port-forward it or expose it to the Internet, and don't rely on it
  to keep data from people you've already invited.
- A server created before pinned TLS stays on plaintext until its owner runs the migration in Settings.
- Vault Rooms cannot sandbox other Obsidian plugins: a local plugin that can read a synced file can read it.

## Rooms, mounting, and access

**Source path** is the folder in the *owner's* vault that the room shares - the one real copy everyone else
reconciles against. **Local mount path** is where a given device keeps its working copy: the owner mounts in
place (no second copy), while everyone else downloads the room into a folder under their mount root. Either can
be overridden per room in its Settings.

Access can be withdrawn at four granularities, all enforced by the relay:

- **One rule in one room** - the person keeps whatever else they were granted.
- **A team membership** - they keep access granted directly or via another team.
- **A whole user** - revokes their account and all their device tokens, closing their live sessions.
- **A single device** - for a lost or compromised machine, without touching that person's other devices.

Deleting a **room** removes it and its history from the server; files already downloaded to someone's vault stay
on their disk, only the sync tracking is dropped. Deleting a **team** removes its memberships and grants, not the
rooms themselves.

Revocation stops future access. It cannot delete copies that were already synced to someone's device.

**Rejoining** creates a fresh identity, and the relay's file list is always the source of truth: files it has
newer versions of are downloaded, files it has deleted are removed locally, files already in sync are left alone,
and local edits you never pushed are preserved as a timestamped conflict copy rather than discarded. The same
reconciliation runs on first mount, re-mount, and reconnect.

## How edits sync

By default, concurrent edits to the same file are **first save wins**: the device that saves second keeps its
version as a **local-only conflict copy** rather than losing it. The Rooms panel lists any conflict copy with
**Keep mine** / **Keep synced version** so you don't have to sort it out by hand.

Two things soften that for files which autosave constantly (a drawing plugin can save on every stroke): rapid
edits to one file are coalesced into a single push, and a room can be set to **Owner's version always wins**
instead of keeping both.

Latency: after you stop typing your edit is pushed within a fraction of a second, and the relay broadcasts it to
every mounted device immediately - there is no polling. A device that was offline reconnects on its own,
re-subscribes, and reconciles; you never need to remount manually. The panel's connection badge tells you whether
you're actually live.

## CRDT sync (opt-in live editing for Markdown notes)

Per room, an owner can turn on **Room Settings → "Live editing (CRDT sync)"** (default off) to get real-time,
character-level merging for that room's Markdown notes. Two people typing in the same note merge deterministically
instead of one edit becoming a conflict copy.

- **Markdown only.** Every other file type in the room keeps using normal whole-file sync.
- **Turning it on or off is non-destructive.** Existing notes are seeded from their current content; disabling
  just returns to whole-file sync.
- **Renames move the note**, keeping its content and history - even with the note open on both devices.
- **Two people creating a note at once get two notes.** Every new Obsidian note starts with the same default
  name, so the first to reach the relay keeps it and the other is filed under a name including its creator, with
  a notice explaining why. Their text is never merged together.
- **A name you type is never rewritten.** Renaming onto a name a teammate already used is refused with a notice
  so you can choose another.
- **Per-keystroke merging needs the note open in your editor.** A device with the room merely mounted still
  receives every change, just on the ordinary latency budget above.
- **Open notes show live cursors.** When authorized teammates have the same CRDT Markdown note open, each sees
  the other's caret and selection with their authenticated display name and a stable, theme-aware color.
  Presence disappears when the editor or session closes; it is note-scoped, not a room-wide online status.
  V1 deliberately has no participant bar.
- **Older plugin versions can read but not write** a note in this mode; they get a clear rejection rather than a
  silent conflict.
- **No new network surface** - it rides the same authenticated connection.

This is the newest part of the plugin. Enable it per room, on content you have a backup of. See
[SECURITY.md](SECURITY.md) for its durability characteristics.

## Plugin capability model

A room can *recommend* companion plugins (Kanban, Tasks) and the panel shows whether they're enabled locally.
Vault Rooms never grants permission to run someone else's plugin code.

## Known limitations

- No end-to-end encryption and no encrypted-at-rest database. The relay and authorized clients see plaintext.
- No cloud relay, NAT traversal, or mobile support. Desktop, one LAN.
- Synced file types: Markdown, `.txt`, `.canvas`, `.json`, `.csv`, `.excalidraw`, common images, and `.pdf`.
  Other binaries (audio, video, Office documents) are not synced. Images and PDFs count against the size limit at
  roughly 1.33x their real size.
- Revoking access, or deleting a room or team, cannot delete copies already synced to someone's device.
- Character-level co-editing and cursor presence only exist via a room's CRDT opt-in, and only for Markdown.
  Cursor presence is ephemeral: it appears only for authorized teammates who currently have the same note open,
  is not persisted, and does not provide a room-wide participant or online list.
- CRDT caveats: per-keystroke merging applies only to a note open in your editor; renaming a note that's open on
  another device makes that device lose editor focus, which Obsidian controls; and disabling CRDT for a room stops
  using its history without deleting it.
- Renames are a real move only for CRDT-enabled Markdown notes. Every other file type re-uploads on rename.
- Device tokens are stored unencrypted in Obsidian's plugin data. A lost device can be revoked on its own.
- Single-host topology: whoever hosts must stay running. If their machine sleeps, sync stops for everyone.
- No clustering, and not built for load-balancing - one process, one database. Fine for a small team editing
  occasionally, not for a write-heavy workload.
- If the host's LAN address changes, previously issued invite links go stale and the host must update its Public
  URL override and restart.

## Troubleshooting

Start with the **Test** button (Settings → Vault Rooms → Servers, or beside a saved server in the panel). It
checks the address, whether anything answers, whether it's a Vault Rooms server with the expected identity, and
whether this device's login still works - then names the step that failed.

- **A teammate can't reach the server:** on the host, confirm the LAN share badge is green. If it says **not a
  LAN address**, the address can't work for anyone else no matter what your own machine says - a loopback
  address like `127.0.0.1` always means "the computer that's asking", so it sends every teammate back to their
  own machine. Use this device's LAN address instead. A browser can't validate a pinned server, so it isn't a
  useful check either.
- **The invite link does nothing:** the plugin must already be installed and enabled on that device - the link
  can't install it.
- **Live editing isn't merging, or changes take seconds:** open the note and run **"Vault Rooms: Diagnose live
  editing (CRDT) for the active note"**. It names the missing content-sync link and also reports whether cursor
  transport is ready, whether this device published its cursor, and which remote names are visible. Most often
  live editing is simply off - it's per room and default-off, so a room created after you last enabled it starts
  without it.
- **A teammate's cursor isn't visible:** both devices need Vault Rooms 0.2.4 or newer, the same CRDT Markdown note
  open, the room mounted with live editing enabled, a live connection, and `file:read` access to that exact path.
  Cursor presence is intentionally absent when a note is only synced in the background.
- **A teammate's edits aren't showing up:** confirm both devices show the room as **mounted**, not just visible.
  Only mounted rooms hold a live subscription.
- **Server identity mismatch:** the peer presented a different identity, so Vault Rooms stopped before sending
  credentials. Confirm the address; after a reinstall, get a fresh invite and verify its fingerprint with the
  owner through a channel you trust. There is deliberately no trust-anyway override.
- **"Invalid or expired credentials" on one server only:** that server's data was reset after your token was
  issued. Forget the stale entry in Settings → Vault Rooms → Servers, then join again.
- **Writes are denied:** check the access rules for that user or team and path pattern.

## License

MIT - see [LICENSE](./LICENSE).
