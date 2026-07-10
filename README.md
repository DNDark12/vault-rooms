# Vault Rooms

![Status: Beta](https://img.shields.io/badge/status-beta-orange) ![Platform: Desktop only](https://img.shields.io/badge/platform-desktop--only-blue) ![Network: Trusted LAN only](https://img.shields.io/badge/network-trusted%20LAN%20only-critical)

## What it is

Vault Rooms lets you create local rooms for selected folders in your vault with trusted people on the same local network.

Create a room, invite members, grant fine-grained file permissions, and collaborate on Markdown-backed workflows such as Kanban boards and Tasks. Vault Rooms includes a local relay server and an Obsidian client plugin.

Vault Rooms is LAN-first, deny-by-default, and designed to avoid exposing raw vault access.

Identity is per-server: each device you join gets one device token for that server (its friends list, teams, and rooms). Teams are named permission groups you can grant to a room as a whole; rooms are the shared folder/file boundary and are owned independently of any team. A room's access list (ACL) grants or denies access to a **user** or a whole **team** per path pattern; team roles (`admin`/`member`) only govern who can manage the team, not room access.

## What it is not

This is not cloud sync, NAT traversal, mobile sync, character-level co-editing, or a sandbox for arbitrary Obsidian community plugins. v0.1 syncs Markdown/text and a limited set of common file types (see "Known limitations" below for the exact list), up to the configured size limit.

## Quick start

The full walkthrough, one device at a time. Every step names the exact command/button so you can follow along in the plugin.

**On the hosting device ("A"):**

1. Install the plugin (see "Installing the Obsidian plugin manually" below).
2. Command palette → **Vault Rooms: Start server** (or Settings → Vault Rooms → Relay server → **Start**). No terminal, no config file.
3. Find this device's LAN IP - `ipconfig getifaddr en0` (macOS), `hostname -I` (Linux), or `ipconfig` (Windows, look for the active adapter's IPv4 address), typically something like `192.168.x.x` or `10.x.x.x`.
4. Settings → Vault Rooms → Relay server → **Public URL override** → enter `<that-LAN-IP>` (just the address, e.g. `192.168.1.100` - no `http://` or port needed; both are filled in automatically with the server's real ones, and a port typed here is ignored rather than trusted, so there's no way for this field to disagree with what the server actually bound to), then **Stop**/**Start** the server again so it takes effect. This step is mandatory for the embedded server - see "Security model" below for why it doesn't detect this automatically.
5. Vault Rooms panel → **Set up server** - this makes you the server owner (creates your account/device identity) and optionally creates your first team in the same step.
6. Vault Rooms panel → **Rooms** section → **Create room** - pick a folder from your vault to share.
7. Open the room's Settings → grant access to a user or a team (a permission preset like reader/editor, or a custom path pattern and permission set).
8. Vault Rooms panel → **Teams** section → your team's card → **Invite link** - this opens a modal with the link (click **Select invite link** to copy it), the full invite details, and a QR code encoding the same link for a nearby teammate to scan with their phone and forward to their own computer.

**On the teammate's device ("B"):**

9. Install the plugin.
10. Before doing anything else, open `http://<A's-LAN-IP>:<port>/health` in a browser. If that doesn't load, the invite link won't work either - see "Troubleshooting" below before going further.
11. Click the invite link A sent (it opens Obsidian and pre-fills the join form), or Vault Rooms panel → **Join server** to enter the server URL and invite token by hand. Add a display name and join.
12. The shared room now appears under **Rooms** in B's panel - mount it to start syncing.

That's the whole loop. Team size, ACL granularity, and revocation are their own sections below - read those before inviting more than a couple of people.

## Network use

Vault Rooms makes network connections, but only ever between devices on your own local network (LAN) that are running this same plugin - there is no cloud service, third-party server, telemetry, analytics, or update-check call of any kind:

- The device hosting a room (the "server") listens on your local network - by default port `8787`, or the next free port up to `8797` - so that teammates' Obsidian clients can reach it over plain HTTP and WebSocket.
- Every other device's plugin only ever makes outbound HTTP/WebSocket requests to that one host, to authenticate, sync files, fetch room/team/friend metadata, and receive live updates.

v0.1 has no TLS (see "Security model" below) - tokens and file contents travel in plaintext over your LAN, so only use this on a network you trust.

## Architecture

The repo is a pnpm TypeScript monorepo:

- `apps/relay-server`: relay business logic (repositories, route handlers, sync message handling), SQLite storage (via `sql.js`, pure JS/WASM - no native build step), REST API, WebSocket sync (`vault-rooms-relay`). The standalone runtime here is Fastify-based; see below.
- `apps/obsidian-plugin`: Obsidian plugin shell, settings, setup/join/room commands, mount/download behavior, sync core behind `VaultAdapter`, and an **embedded relay** that runs inside the plugin process (`@vault-rooms/obsidian-plugin`) - a lightweight `node:http` router plus the `ws` library, not Fastify (Obsidian's community-plugin review flags Fastify/AJV as unwanted bundle weight and "dynamic code execution"); it reuses the same route-handler/repository logic from `apps/relay-server`, just behind a different, much smaller HTTP/WebSocket layer.
- `packages/protocol`: protocol, types, errors, token/path helpers (`@vault-rooms/protocol`).
- `packages/policy-engine`: pure ACL evaluator used by both REST and sync (`@vault-rooms/policy`).

There are two ways to run the relay, and both speak the exact same protocol:

1. **Embedded (recommended for most teams).** The Obsidian plugin runs its own lightweight relay in-process (see above) - install the plugin, click **Start server** in the Vault Rooms panel (or Settings → Vault Rooms), and it's listening - no terminal, no separate install, no `.env` file. Config lives in the plugin's Settings tab and is stored the same way as any other Obsidian plugin setting. Unlike the standalone runtime, the embedded server does **not** auto-detect your LAN IP (see "Security model" below) - set a Public URL override before creating invites.
2. **Standalone (`pnpm dev:server`).** The original CLI process, configured via `.env`/environment variables. Useful for development, for running the relay on a dedicated always-on machine instead of someone's laptop, or for team sizes where a personal-laptop-as-server model doesn't fit (see "Team size and scaling" below).

Whoever's device is running the relay (embedded or standalone) is "the server." Everyone else's Obsidian plugin is a client that only ever makes outbound HTTP/WebSocket calls to that one server - they never bind a port or run their own relay for the same team (see "Do other members need to run their own server?" below).

## Security model

See [SECURITY.md](SECURITY.md) for the full threat model, token storage, revocation limitations, and how to report a vulnerability. Summary below.

Permissions are enforced by the relay server over synced rooms. Client-side UI is convenience only. Tokens use `tr_inv_` and `tr_dev_` prefixes, are generated with a CSPRNG (`crypto.randomBytes`), and only SHA-256 token hashes are stored in SQLite. Per-path `file:read` is enforced on every channel that carries file content - the REST download endpoint, live WebSocket broadcasts, **and** the initial room snapshot a device gets on subscribe/reconnect - so a member whose access list only grants some paths never receives the content (or even the filenames/hashes) of the paths they can't read.

Access can be withdrawn at three granularities: remove a single ACL rule from a room, remove a user from a team, or revoke a user server-wide. A single lost/compromised device can also be revoked on its own (server owner → `POST /api/friends/:userId/devices/:deviceId/revoke`) without kicking that user's other devices - the revoked device's token stops working on its next request and its live WebSocket session is closed immediately.

This project does not sandbox arbitrary Obsidian community plugins. If a local plugin can read a synced Markdown file in B's vault, Vault Rooms cannot prevent that local plugin from reading it.

v0.1 has no TLS: use only on trusted networks. Tokens and content travel in plaintext over LAN. The embedded server always binds every network interface (`0.0.0.0`) so teammates can reach it - there is no "this device only" mode, since a server nobody else can reach isn't useful.

The only endpoint that can provision privileged access with no pre-existing credential at all is the one-time **bootstrap** that creates the very first owner. It is protected on two independent axes so a malicious web page can't provision itself as owner via a DNS-rebinding request to your loopback/LAN address: (1) a random **bootstrap PIN** is generated per server process and required in the bootstrap request - the embedded plugin reads it in-process (transparent to you) and the standalone CLI prints it to the console; (2) the request's `Host` header must match the server's own address, which a rebinding attacker's domain never will. Once the owner exists, bootstrap is closed entirely. The standalone CLI still binds via `HOST`/`PORT` if you need a different setup.

Two other endpoints don't require a device bearer token, by design: joining via an invite link (`POST /api/join`) is gated by its own credential - a single-use, expiring invite token, not device auth - and `/health` is intentionally public (it only returns the plugin name/version, used by clients to sanity-check they've reached a Vault Rooms server before authenticating).

CORS is intentionally permissive (`*`): the client talks to the relay from Obsidian's Electron process (not a browser page origin) and auth is Bearer-token, not cookie-based, so wildcard CORS carries little risk once bootstrap is PIN+Host gated. This will be revisited if the client ever moves to a real browser origin.

**`127.0.0.1` never means "the other machine."** It always resolves to whichever computer is asking, so an invite link embedding `127.0.0.1` only ever points teammates back at their own machine, and editing `/etc/hosts` cannot change that (it's not a name-resolution problem). The **standalone** relay (`pnpm dev:server`) auto-detects its real LAN IP (a private address like `192.168.x.x` or `10.x.x.x` - specific to your own network, never shown here) and uses that - not `127.0.0.1` - in the printed URL and in every invite link it generates; if auto-detection fails there (multiple network adapters, VPNs, some Wi-Fi drivers), set a **Public URL override** in Settings → Vault Rooms → Relay server. The **embedded** relay (running inside Obsidian) does not attempt LAN IP auto-detection at all - reading network interfaces is flagged by Obsidian's plugin review as machine fingerprinting - so it always requires a Public URL override to be set before invites will work for anyone but you; without one, invite links default to `127.0.0.1` and will only ever work on your own machine.

## Revocation and rejoin model

Revocation stops future access. It revokes the member record, device tokens, active WebSocket sessions, and future fetch/push attempts. If a file has already been synced to a collaborator's device, revocation prevents future access and writes but cannot guarantee deletion of that old local copy.

Rejoin uses a new invite and creates a new user/device identity. **The relay's file listing is always the source of truth - the owner/host's copy wins, never the rejoining device's stale local copy.** Concretely, (re)mounting a room compares every file the server knows about against what was last synced locally:

- A file the server has never seen locally, or has a newer version of, is downloaded and written.
- A file whose server version already matches what was last synced is left untouched, so it doesn't clobber edits you haven't pushed yet.
- A file the server has tombstoned (deleted) since you last synced - including everything that was deleted on the server *while you were removed from the room* - is deleted from your local mount on (re)join, not left behind as a stale copy.
- If a file you'd edited locally without pushing (`dirty`) conflicts with an incoming server change or delete, your local copy is preserved as a timestamped conflict copy instead of being silently discarded.

This is the same reconciliation path used for the initial mount, a manual re-mount, and the live snapshot a device gets when it reconnects its WebSocket subscription - so "first join" and "rejoin after being removed" behave identically: whatever the owner's room currently contains is what you end up with locally.

One caveat: this reconciliation runs when you mount/re-mount a room or reconnect. If a room is deleted entirely (see below) while your device is offline, your local mount tracking for it is not cleaned up until Obsidian is running and either reconnects or you manually unmount - the files themselves are only ever removed by this reconciliation step, never by a background process.

## Concurrency model

Concurrent edits to the same file are "first save wins"; the losing device gets a **local-only** conflict copy (never pushed or synced - it only exists on the device that lost the race) instead of losing the edit outright. Character-level co-editing arrives with CRDT in v0.2.

The server uses compare-and-swap file versions: every write must include the version it was based on, and a write based on a stale version is rejected (see the conflict policy above for what happens next).

Two things soften "first save wins" for files that autosave very frequently (a drawing plugin can resave on every stroke), where forking on every near-simultaneous save is more annoying than useful:

- **Debounce coalescing.** Rapid successive local edits to the same file are coalesced into a single push per `debounceMs` window instead of firing one independent push per change - this also serializes overlapping pushes for the same file so a fast-autosaving file can't race against and version-conflict with its own earlier, still-in-flight push.
- **Per-room conflict policy** (Room Settings → "When edits conflict"): the default, **Keep both**, is what's described above. **Owner's version always wins** makes the room owner's writes always become canonical, even if they land a moment behind someone else's edit - non-owner writes still follow "Keep both" against each other.

Whenever a local conflict copy does exist, the Rooms panel lists it under the mounted room with **Keep mine** (push your version as the new canonical one) and **Keep synced version** (discard your local copy) - no need to sort it out by hand in the file explorer.

## Sync latency: how fast does a teammate's edit show up?

This is not character-level realtime (no shared cursor, no live keystrokes) - that's the CRDT work planned for v0.2. What v0.1 guarantees:

- **Push side (debounced, not per-keystroke).** When you edit a mounted file, the plugin waits for `debounceMs` (Settings → Vault Rooms → Sync, default **300ms**) of no further local writes to that file before pushing it to the relay. This avoids pushing a partial file on every keystroke while still keeping the delay small and predictable - not "no delay," but not "wait for a manual sync" either.
- **Pull side (live, not polled).** Every mounted room keeps an open WebSocket subscription to the relay. The moment the relay accepts a write (from REST push or another device's WebSocket push), it broadcasts the change to every other subscribed device immediately - there is no polling interval on this side. Combined with the push-side debounce, a teammate's edit typically lands on your machine well under a second after they stop typing.
- **Reconnect catch-up.** If your Obsidian was closed, the connection dropped, or the host restarted its server, the plugin automatically reconnects (with backoff) and re-subscribes to every previously-mounted room, then reconciles against a fresh snapshot from the server - you don't need to manually remount or reload Obsidian to start receiving live updates again. The Rooms panel's "Connection" section shows a live badge (connected / reconnecting / offline) so you can tell at a glance whether you're actually getting real-time updates right now.
- **No ping-pong.** Applying a remote change updates the local file's known server version/hash, so the local file watcher recognizes the resulting "modify" event as already-in-sync and does not push it back.

## Plugin capability model

Room capabilities are metadata. A room can recommend Kanban or Tasks, and the plugin checks whether those plugins are enabled locally. Vault Rooms does not grant permission to run another user's plugin runtime.

## Source path vs. local mount path

When creating a room, **source path** is the folder in the *owner's* vault that the room shares - this is the one and only real copy that other members' edits ultimately reconcile against. (Rooms are always folder-scoped; the earlier single-file room option was removed because the sync engine is folder/prefix based.)

**Local mount path** is where a given *device* keeps its working copy of that room, and it means something different depending on who you are:

- **On the room owner's own device**, mounting defaults to the source path itself - there is no separate copy. The owner's existing files stay exactly where they are; mounting just starts watching and syncing them in place. The first time the owner mounts a room, any pre-existing files under the source path that the relay hasn't seen yet are pushed up automatically, so teammates who join afterward see real content immediately instead of an empty room.
- **On every other member's device**, mounting downloads the room into a fresh folder - by default `<Mount root>/<mount name>` (Mount root is set in Settings → Vault Rooms → Sync) - since they have no pre-existing copy to reuse.

You can override the computed default for any room/device via the "Local mount path" field in that room's Settings modal, e.g. to point a member's copy somewhere other than the default mount-root location.

## Running the relay server (ports, config)

Default port is `8787`. If a port is unset and the default is busy, the server tries `8788` through `8797`. If a port is explicitly set, only that port is attempted and a busy port exits with a clear error.

Because invite links and saved logins embed a concrete port, the embedded server **pins** the port it successfully binds (stored separately from any explicit user-set port, so an explicit choice is never overridden). Subsequent starts reuse that pinned port first; only if it is genuinely unavailable does it fall back to scanning again, and when that happens you get a persistent notice that previously issued invite links may need regenerating. A busy port that turns out to be a leftover instance of Vault Rooms itself (detected via a `/health` name probe) is called out distinctly from one held by an unrelated app.

- **Embedded (in Obsidian):** configure the relay in Settings → Vault Rooms → Relay server (Public URL override, Port, Max synced file size, Start automatically), then use the Start/Stop button. There is no Host setting - the embedded server always binds every LAN interface (`0.0.0.0`). Bootstrap (becoming server owner) always happens over loopback regardless of network settings, so there's no remote-bootstrap toggle here - that's a standalone-only option (`ALLOW_REMOTE_BOOTSTRAP`, see below) for the case where you want to bootstrap a relay running on a different machine than the one you're bootstrapping from. Nothing is read from `.env` in this mode.
- **Standalone (`pnpm dev:server`):** configured via environment variables - see `.env.example`. Useful for development or for hosting the relay on a dedicated always-on machine rather than a personal laptop.

## Installing the Obsidian plugin manually

1. Run `pnpm build:plugin`.
2. Copy root `manifest.json`, `main.js`, and `styles.css` into `<vault>/.obsidian/plugins/vault-rooms/`. All three files are required - the embedded relay's SQLite engine (`sql.js`'s WASM binary) is bundled directly into `main.js`, so no extra file is needed.
3. Enable community plugins in Obsidian and enable "Vault Rooms".
4. Use commands prefixed with `Vault Rooms:`, or open the ribbon icon.

## Invite links

Creating an invite (Vault Rooms panel → **Teams** section → a team card → **Invite link**) generates a link like:

```
obsidian://vault-rooms?mode=join&server=http%3A%2F%2F<host-LAN-IP>%3A8787&token=tr_inv_...
```

(`<host-LAN-IP>` is a placeholder - the plugin fills in the host's actual detected LAN address, e.g. something in the `192.168.x.x` or `10.x.x.x` range.)

Clicking it opens Obsidian, and if the Vault Rooms plugin is installed there, it pre-fills the Join form with the server URL and token - the recipient only has to add a display name and click Join. The plugin also accepts the older `obsidian://vault-rooms/join?...` path-style link for compatibility.

The invite modal also shows a QR code encoding the same link - useful for a teammate sitting nearby: they scan it with their phone, then forward the link to their own computer (Obsidian is desktop-only, so the phone itself can't join). This is generated entirely client-side and encodes nothing beyond the plaintext link already shown as text above it.

The link only works if:

1. The recipient already has the Vault Rooms plugin installed (the link cannot install it).
2. The `server` value is a LAN IP the recipient's machine can actually reach - never `127.0.0.1` (see the security model section above). The host's server always binds every interface, but only the **standalone** runtime fills in the real LAN IP automatically; the **embedded** runtime needs a Public URL override set first (see the Public URL override note above) or every invite link will embed `127.0.0.1` and only work on the host's own machine.
3. Both machines are actually on the same LAN. If in doubt, have the recipient open `http://<host-LAN-IP>:<port>/health` in a browser first; if that doesn't load, the invite link won't work either. Common culprits: different subnets, a firewall blocking the port, or Wi-Fi "client/AP isolation" on a guest network (isolation prevents devices on the same Wi-Fi from reaching each other at all).

## Do other members need to run their own server?

No. One device hosts the relay (start it, then **Set up server**); everyone else just installs the plugin and uses **Join server** (or clicks an invite link) pointed at the host's URL. Joining members never start a server of their own, so the auto-port-selection (8787-8797) and any port-conflict handling only matters on the hosting device - it is irrelevant to everyone who only joins.

If a member also wants to host their *own* separate server (e.g. for a different project), that's independent: they'd click **Start server** on their own machine, which picks whatever port is free there.

## Deleting rooms/teams and removing access

All of the following are enforced server-side (the UI just calls the same protected endpoints), so a client can't bypass them by editing local settings:

- **Remove a member's access to one room** (owner/admin): open the room's Settings modal → Room access, and click **Remove** next to the access rule. This deletes a single ACL grant/deny rule; it does not touch team membership.
- **Remove a member from a team** (server owner or team creator): Vault Rooms panel → **Teams** section → the team card → the member row → **Remove**. This removes only that team membership; the user's account and device tokens are untouched, and they keep access to any room granted to them directly or via another team.
- **Revoke a user from the whole server** (server owner only): Vault Rooms panel → **Friends** section → **Revoke**. This revokes the user account and *all* of their device tokens, closing their active WebSocket sessions and blocking future fetch/push. This is the server-wide revocation described above.
- **Revoke a single device** (server owner only): `POST /api/friends/:userId/devices/:deviceId/revoke`. Kills one lost/compromised device without touching the user's other devices - the token fails on its next request and its live WebSocket is closed at once.
- **Delete a room** (room owner or server owner): open the room's Settings modal → Danger zone → **Delete room**. This permanently deletes the room and all of its files/version history on the server. A device that currently has it mounted forgets its local mount tracking for that room the next time it reconciles (reconnect or manual unmount). Deleting a room does **not** delete files that were already downloaded to a member's vault - only their sync tracking for that room is removed, consistent with how unmounting a room already works.
- **Delete a team** (server owner or team creator): Vault Rooms panel → **Teams** section → the team card → **Delete team**. This deletes the team's memberships, invites, and ACL grants. It does **not** delete rooms or files - rooms are independently owned and outlive the team, so any room that was shared with the team stays intact for whoever still has direct access. Members lose access that came *only* from this team's grants.

## Team size and scaling

This is a star topology: one relay, many clients over REST + WebSocket. For a small team (roughly up to a few dozen people editing occasionally) this works fine on ordinary hardware - both the standalone (Fastify) and embedded (lightweight `node:http` + `ws`) runtimes comfortably handle tens of concurrent WebSocket connections, and file writes are small, infrequent, human-speed edits, not a write-heavy workload.

What doesn't scale, and matters more as the team grows toward 20-50 people:

- **The host's laptop is a single point of failure.** If whoever is hosting closes Obsidian, sleeps their laptop, or goes offline, sync stops for the whole team until they're back. For a team that size, prefer running the relay as a **standalone** process (`pnpm dev:server`, or a small always-on machine/NAS on the LAN) rather than embedded in one person's personal Obsidian - the protocol is identical either way, so this is purely a deployment choice, not a code change.
- **No horizontal scaling / no clustering.** There's one process, one SQLite file (via `sql.js`). This is fine for the write volume a few dozen humans generate, but it's not designed to be load-balanced across multiple relay instances.
- **No TLS yet (v0.1).** At 20-50 people, "trusted LAN" is a bigger assumption to lean on than for a pair. Treat this as an internal-network tool until TLS/WSS lands (see [ROADMAP.md](ROADMAP.md)), and don't run it on a network you don't trust.
- **ACLs are per-room, not automatic.** Every room's access still has to be granted (to the whole team or specific members/roles) after creation - there's no team size at which this becomes automatic, so plan for a bit of upfront admin work rounding up 50 people into the right room grants.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build:plugin
```

Run a single test file, e.g.:

```bash
pnpm test apps/relay-server/test/sync-flow.test.ts
```

Then load the plugin in a real vault (see "Installing the Obsidian plugin manually" below) and use the panel - there is no `pnpm dev:server` step needed for normal use; that script exists only for development and for standalone hosting (see "Running the relay server" above).

## Release checklist

One-time repository setup (already done for this repo, but required again for a fork): on GitHub, go to **Settings → Actions → General → Workflow permissions** and select **Read and write permissions**, so `.github/workflows/release.yml` is allowed to create releases.

To cut a release:

1. Confirm root `manifest.json`, `main.js`, `styles.css`, `README.md`, and `LICENSE` exist, and that `manifest.json`'s `version` has been bumped.
2. Run `pnpm typecheck`, `pnpm test`, and `pnpm build:plugin` locally, and commit the resulting root `manifest.json`/`main.js`/`styles.css`.
3. Push a tag that matches `manifest.json`'s `version` exactly (no `v` prefix), e.g. `git tag -a 0.1.0 -m "0.1.0" && git push origin 0.1.0`.
4. GitHub Actions (`.github/workflows/release.yml`) builds the plugin fresh, verifies the tag matches `manifest.json`, and creates a **draft** GitHub release with `main.js`, `manifest.json`, and `styles.css` attached. `sql-wasm.wasm` is not a separate release asset - it's bundled directly into `main.js` at build time, so the plugin works from just those three files.
5. Open the draft release on GitHub, add release notes, and publish it.
6. First release only: submit the plugin to the community directory (see [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)) by opening a pull request against `obsidianmd/obsidian-releases` adding an entry to `community-plugins.json`.

## Known limitations

- No TLS; trusted LAN only.
- No cloud relay, NAT traversal, or mobile support.
- Synced file types: Markdown, `.txt`, `.canvas`, `.json`, `.csv`, `.excalidraw` (legacy Excalidraw format - newer `.excalidraw.md` files are already covered by Markdown), plus common images (`.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`/`.bmp`/`.svg`) and `.pdf`. Other binary formats (audio, video, Office docs, etc.) aren't synced yet - edits to those files won't reach teammates. Images/PDFs are base64-encoded for transport, so they count against the max file size at roughly 1.33x their real size on disk.
- No guaranteed deletion of already-synced collaborator copies (this applies to member revocation and room/team deletion alike - see "Deleting rooms/teams and removing access").
- No character-level co-editing (edits sync as whole-file pushes, debounced - see "Sync latency" above).
- Renames and moves within a room sync, but as a delete of the old path plus a create at the new path - there is no dedicated move operation, so renaming a large file re-uploads its contents.
- Plugin settings store the device token in Obsidian plugin data JSON; this is acceptable for v0.1 but not hardened. A leaked device can be revoked individually (see "Deleting rooms/teams and removing access").
- No rate-limit tuning UI: the relay applies a strict per-IP limit on the unauthenticated bootstrap endpoint and a WebSocket connection cap to protect the host (the server runs inside Obsidian's process). There is intentionally no general per-request limiter on authenticated traffic - it legitimately scales with vault size (mounting/reconciling an existing room can fire well over a hundred requests in a burst), and an earlier general limiter was removed after it broke sync on established rooms.
- Single-host star topology: whoever hosts the relay (embedded or standalone) must stay running for the team to sync; see "Team size and scaling."
- If the host's LAN IP changes (e.g. DHCP reassigns it), previously issued invite links go stale; generate a new one - the invite modal's QR code (see "Invite links" below) makes resending less error-prone than retyping the URL. Automatic mDNS-based discovery to avoid regenerating entirely is a research item, not a scheduled feature - see [ROADMAP.md](ROADMAP.md).
- The **embedded** relay never auto-detects your LAN IP (see "Security model" above) - you must set a Public URL override before creating an invite, every time your LAN IP changes. The standalone relay still auto-detects.

## Troubleshooting

- `Test connection` says wrong service: another process is answering on that port.
- A teammate can't reach the server at all: confirm the invite/server URL uses the host's actual LAN IP, not `127.0.0.1` - see "Invite links" above. Have them test `http://<host-LAN-IP>:<port>/health` in a browser first.
- B cannot join: confirm the invite server URL embeds the actual bound port and A's real LAN IP, not `127.0.0.1`. If A is hosting the **embedded** server, this is expected until A sets a Public URL override (embedded never auto-detects); if A is hosting **standalone** and LAN IP auto-detection failed, set a Public URL override in Settings → Vault Rooms → Relay server (or `PUBLIC_URL` for standalone) and restart the server.
- B can reach `/health` but the invite link does nothing when clicked: confirm the Vault Rooms plugin is installed and enabled on B's machine - the link only opens the Join form, it can't install the plugin.
- Writes are denied: inspect ACL grants for the user/team and path pattern.
- Conflicts are expected when two actors edit the same file version.
- A teammate's edits aren't showing up: confirm both devices show the room as mounted (not just visible) - only mounted rooms hold a live sync subscription.
- "Invalid or expired credentials" on one team/server but not another: that team's saved device token no longer matches anything in that server's data (most often because the server's data was reset/recreated after the token was issued - e.g. a fresh reinstall, a wiped `server-data` folder, or switching between embedded and standalone mode with different data files). The plugin marks the server entry `revoked` in Settings → Vault Rooms → **Servers** when this happens; use **Forget** there to remove the stale entry (this only forgets it locally, it does not touch the server), then set up or join that server again to get a working identity. This is unrelated to which *room* you have open - a device token is per-server, not per-room.

## License

MIT - see [LICENSE](./LICENSE).
