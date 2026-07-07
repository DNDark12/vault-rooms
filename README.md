# Vault Rooms

## What it is

Vault Rooms lets you create local rooms for selected folders in your vault with trusted people on the same local network.

Create a room, invite members, grant file and AI tool permissions, and collaborate on Markdown-backed workflows such as Kanban boards and Tasks. Vault Rooms includes a local relay server, an Obsidian client plugin, and a scoped MCP gateway for AI tools.

Vault Rooms is LAN-first, deny-by-default, and designed to avoid exposing raw vault access.

Teams are the identity and invite boundary. Rooms are the shared folder/file boundary. A whole team can be added to a room by granting access to the `member` and `admin` roles; individual members can also be granted or denied access per path pattern.

## What it is not

This is not cloud sync, NAT traversal, mobile sync, character-level co-editing, or a sandbox for arbitrary Obsidian community plugins. v0.1 syncs text files only, up to the configured size limit.

## Architecture

The repo is a pnpm TypeScript monorepo:

- `apps/relay-server`: Fastify relay, SQLite storage (via `sql.js`, pure JS/WASM - no native build step), REST API, WebSocket sync, scoped MCP endpoint (`vault-rooms-relay`).
- `apps/obsidian-plugin`: Obsidian plugin shell, settings, setup/join/room commands, mount/download behavior, sync core behind `VaultAdapter`, and an **embedded copy of the relay server** that runs inside the plugin process (`@vault-rooms/obsidian-plugin`).
- `packages/protocol`: protocol, types, errors, token/path helpers (`@vault-rooms/protocol`).
- `packages/policy-engine`: pure ACL evaluator used by REST, sync, and MCP (`@vault-rooms/policy`).
- `packages/markdown-adapters`: pure Tasks and Kanban Markdown operations (`@vault-rooms/markdown-adapters`).
- `packages/mcp-gateway`: MCP tool names and permission metadata (`vault-rooms-mcp`).

There are two ways to run the relay, and both speak the exact same protocol:

1. **Embedded (recommended for most teams).** The Obsidian plugin imports `vault-rooms-relay` directly and runs it in-process. Install the plugin, click **Start Server** in the Vault Rooms panel (or Settings → Vault Rooms), and it's listening - no terminal, no separate install, no `.env` file. Config lives in the plugin's Settings tab and is stored the same way as any other Obsidian plugin setting.
2. **Standalone (`pnpm dev:server`).** The original CLI process, configured via `.env`/environment variables. Useful for development, for running the relay on a dedicated always-on machine instead of someone's laptop, or for team sizes where a personal-laptop-as-server model doesn't fit (see "Team size and scaling" below).

Whoever's device is running the relay (embedded or standalone) is "the server." Everyone else's Obsidian plugin is a client that only ever makes outbound HTTP/WebSocket calls to that one server - they never bind a port or run their own relay for the same team (see "Do other members need to run their own server?" below).

## Security model

Permissions are enforced by the relay server over synced rooms and MCP tools. Client-side UI is convenience only. Tokens use `tr_inv_`, `tr_dev_`, and `tr_agt_` prefixes and only SHA-256 token hashes are stored in SQLite.

This project does not sandbox arbitrary Obsidian community plugins. If a local plugin can read a synced Markdown file in B's vault, Vault Rooms cannot prevent that local plugin from reading it.

v0.1 has no TLS: use only on trusted networks. Tokens and content travel in plaintext over LAN. The embedded server always binds every network interface (`0.0.0.0`) so teammates can reach it - there is no "this device only" mode, since a server nobody else can reach isn't useful, and the invite flow (plus localhost-only bootstrap by default) already gates what an unauthenticated request can do. The standalone CLI still binds via `HOST`/`PORT` if you need a different setup.

**`127.0.0.1` never means "the other machine."** It always resolves to whichever computer is asking, so an invite link embedding `127.0.0.1` only ever points teammates back at their own machine, and editing `/etc/hosts` cannot change that (it's not a name-resolution problem). The server auto-detects its real LAN IP (e.g. `192.168.1.42`) and uses that - not `127.0.0.1` - in the printed URL and in every invite link it generates. If auto-detection fails (multiple network adapters, VPNs, some Wi-Fi drivers), set a **Public URL override** in Settings → Vault Rooms → Relay server.

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

Concurrent edits to the same file are "first save wins"; the other editor gets a conflict copy. Character-level co-editing arrives with CRDT in v0.2.

The server uses compare-and-swap file versions. Semantic MCP tools read the latest file, apply a pure Markdown operation, and retry once on version conflict.

## Sync latency: how fast does a teammate's edit show up?

This is not character-level realtime (no shared cursor, no live keystrokes) - that's the CRDT work planned for v0.2. What v0.1 guarantees:

- **Push side (debounced, not per-keystroke).** When you edit a mounted file, the plugin waits for `debounceMs` (Settings → Vault Rooms → Sync, default **750ms**) of no further local writes to that file before pushing it to the relay. This avoids pushing a partial file on every keystroke while still keeping the delay small and predictable - not "no delay," but not "wait for a manual sync" either.
- **Pull side (live, not polled).** Every mounted room keeps an open WebSocket subscription to the relay. The moment the relay accepts a write (from REST push or another device's WebSocket push), it broadcasts the change to every other subscribed device immediately - there is no polling interval on this side. Combined with the push-side debounce, a teammate's edit typically lands on your machine well under a second after they stop typing.
- **Reconnect catch-up.** If your Obsidian was closed or the connection dropped, reconnecting re-subscribes to each mounted room and reconciles against a fresh snapshot from the server, so you don't miss changes made while you were offline.
- **No ping-pong.** Applying a remote change updates the local file's known server version/hash, so the local file watcher recognizes the resulting "modify" event as already-in-sync and does not push it back.

## Plugin capability model

Room capabilities are metadata. A room can recommend Kanban or Tasks, and the plugin checks whether those plugins are enabled locally. Vault Rooms does not grant permission to run another user's plugin runtime.

## Source path vs. local mount path

When creating a room, **source path** is the folder (or file) in the *owner's* vault that the room shares - this is the one and only real copy that other members' edits ultimately reconcile against.

**Local mount path** is where a given *device* keeps its working copy of that room, and it means something different depending on who you are:

- **On the room owner's own device**, mounting defaults to the source path itself - there is no separate copy. The owner's existing files stay exactly where they are; mounting just starts watching and syncing them in place. The first time the owner mounts a room, any pre-existing files under the source path that the relay hasn't seen yet are pushed up automatically, so teammates who join afterward see real content immediately instead of an empty room.
- **On every other member's device**, mounting downloads the room into a fresh folder - by default `<Mount root>/<team-slug>/<mount name>` (Mount root is set in Settings → Vault Rooms → Sync) - since they have no pre-existing copy to reuse.

You can override the computed default for any room/device via the "Local mount path" field in that room's Settings modal, e.g. to point a member's copy somewhere other than the default mount-root location.

## Quick start (development)

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build:plugin
```

Then load the plugin in a real vault (see "Installing the Obsidian plugin manually") and use the panel - there is no `pnpm dev:server` step needed for normal use anymore; that script still exists for development and for standalone hosting (see below).

## Development

```bash
pnpm typecheck
pnpm test
pnpm build:plugin
```

Targeted examples:

```bash
pnpm test apps/relay-server/test/sync-flow.test.ts
pnpm test packages/markdown-adapters/src/tasks.test.ts
```

## Running the relay server (ports, config)

Default port is `8787`. If a port is unset and the default is busy, the server tries `8788` through `8797`. If a port is explicitly set, only that port is attempted and a busy port exits with a clear error.

- **Embedded (in Obsidian):** configure Host/port/LAN access in Settings → Vault Rooms → Relay server, then use the Start/Stop button. Nothing is read from `.env` in this mode.
- **Standalone (`pnpm dev:server`):** configured via environment variables - see `.env.example`. Useful for development or for hosting the relay on a dedicated always-on machine rather than a personal laptop.

## Installing the Obsidian plugin manually

1. Run `pnpm build:plugin`.
2. Copy root `manifest.json`, `main.js`, `styles.css`, and `sql-wasm.wasm` into `<vault>/.obsidian/plugins/vault-rooms/`. All four files are required - `sql-wasm.wasm` is the embedded relay's SQLite engine and is loaded from disk at runtime.
3. Enable community plugins in Obsidian and enable "Vault Rooms".
4. Use commands prefixed with `Vault Rooms:`, or open the ribbon icon.

## Invite links

Creating an invite (Team Members → Invite Member/Admin) generates a link like:

```
obsidian://vault-rooms?mode=join&server=http%3A%2F%2F192.168.1.42%3A8787&token=tr_inv_...
```

Clicking it opens Obsidian, and if the Vault Rooms plugin is installed there, it pre-fills the Join form with the server URL and token - the recipient only has to add a display name and click Join. The plugin also accepts the older `obsidian://vault-rooms/join?...` path-style link for compatibility.

The link only works if:

1. The recipient already has the Vault Rooms plugin installed (the link cannot install it).
2. The `server` value is a LAN IP the recipient's machine can actually reach - never `127.0.0.1` (see the security model section above). The host's embedded server always binds LAN, so the printed/embedded URL uses the real LAN IP automatically unless auto-detection failed (see the Public URL override note above).
3. Both machines are actually on the same LAN. If in doubt, have the recipient open `http://<host-LAN-IP>:<port>/health` in a browser first; if that doesn't load, the invite link won't work either. Common culprits: different subnets, a firewall blocking the port, or Wi-Fi "client/AP isolation" on a guest network (isolation prevents devices on the same Wi-Fi from reaching each other at all).

## Do other members need to run their own server?

No. One device hosts the relay (start it, then "Set Up Team"); everyone else just installs the plugin and uses "Join Team" (or clicks an invite link) pointed at the host's URL. Joining members never start a server of their own for that team, so the auto-port-selection (8787-8797) and any port-conflict handling only matters on the hosting device - it is irrelevant to everyone who only joins.

If a member also wants to host their *own* separate team (e.g. they run a different project), that's independent: they'd click Start Server on their own machine, which picks whatever port is free there.

## Deleting rooms/teams and removing access

All of the following are enforced server-side (the UI just calls the same protected endpoints), so a client can't bypass them by editing local settings:

- **Remove a member's access to one room** (owner/admin): open the room's Settings modal → Room access, and click **Remove** next to the access rule. This deletes a single ACL grant/deny rule; it does not touch team membership.
- **Revoke a member from the whole team** (owner/admin): Vault Rooms panel → Team Members → **Revoke**. This is the existing member-level revocation described above.
- **Delete a room** (owner/admin): open the room's Settings modal → Danger zone → **Delete room**. This permanently deletes the room and all of its files/version history on the server. Any device currently subscribed to that room (i.e. has it mounted) is notified immediately over its live WebSocket connection and forgets its local mount tracking for that room; a device that was offline picks this up the next time it reconnects or tries to use that room. Deleting a room does **not** delete files that were already downloaded to a member's vault - only their sync tracking for that room is removed, consistent with how unmounting a room already works.
- **Delete a team** (owner only): Settings → Vault Rooms → Teams → **Delete team**, next to teams where your device is the owner. This permanently deletes the team, every room and file in it, all members, invites, and device tokens. Every connected member's WebSocket session is closed immediately with a "team deleted" notice.

## Team size and scaling

This is a star topology: one relay, many clients over REST + WebSocket. For a small team (roughly up to a few dozen people editing occasionally) this works fine on ordinary hardware - Fastify comfortably handles tens of concurrent WebSocket connections, and file writes are small, infrequent, human-speed edits, not a write-heavy workload.

What doesn't scale, and matters more as the team grows toward 20-50 people:

- **The host's laptop is a single point of failure.** If whoever is hosting closes Obsidian, sleeps their laptop, or goes offline, sync stops for the whole team until they're back. For a team that size, prefer running the relay as a **standalone** process (`pnpm dev:server`, or a small always-on machine/NAS on the LAN) rather than embedded in one person's personal Obsidian - the protocol is identical either way, so this is purely a deployment choice, not a code change.
- **No horizontal scaling / no clustering.** There's one process, one SQLite file (via `sql.js`). This is fine for the write volume a few dozen humans generate, but it's not designed to be load-balanced across multiple relay instances.
- **No TLS yet (v0.1).** At 20-50 people, "trusted LAN" is a bigger assumption to lean on than for a pair. Treat this as an internal-network tool until v0.3 TLS/e2e lands (see Roadmap), and don't run it on a network you don't trust.
- **ACLs are per-room, not automatic.** Every room's access still has to be granted (to the whole team or specific members/roles) after creation - there's no team size at which this becomes automatic, so plan for a bit of upfront admin work rounding up 50 people into the right room grants.

## MCP tools

The relay exposes `POST /mcp` with `Authorization: Bearer tr_agt_...`. v0.1 supports:

- `list_rooms`
- `list_files`
- `read_file`
- `write_file`
- `list_tasks`
- `create_task`
- `update_task_status`
- `create_kanban_card`
- `move_kanban_card`

Tool access uses the same ACL table as human/device access. Raw unrestricted vault access is not exposed.

## Release checklist

Before submitting to the Obsidian Community directory:

1. Confirm root `manifest.json`, `main.js`, `styles.css`, `sql-wasm.wasm`, `README.md`, and `LICENSE` exist.
2. Run `pnpm typecheck`, `pnpm test`, and `pnpm build:plugin`.
3. Commit root `manifest.json`.
4. Create a GitHub release whose tag matches `manifest.json` `version`.
5. Upload `main.js`, `manifest.json`, `styles.css`, and `sql-wasm.wasm` as release assets.

## Known limitations

- No TLS; trusted LAN only.
- No cloud relay, NAT traversal, or mobile support.
- No binary file sync.
- No guaranteed deletion of already-synced collaborator copies (this applies to member revocation and room/team deletion alike - see "Deleting rooms/teams and removing access").
- No character-level co-editing (edits sync as whole-file pushes, debounced - see "Sync latency" above).
- Rename is delete plus create.
- Plugin settings store the device token in Obsidian plugin data JSON; this is acceptable for v0.1 but not hardened.
- Single-host star topology: whoever hosts the relay (embedded or standalone) must stay running for the team to sync; see "Team size and scaling."
- If the host's LAN IP changes (e.g. DHCP reassigns it), previously issued invite links go stale; generate a new one. mDNS/QR discovery to avoid this is on the v0.2 roadmap.

## Troubleshooting

- `Test connection` says wrong service: another process is answering on that port.
- A teammate can't reach the server at all: confirm the invite/server URL uses the host's actual LAN IP, not `127.0.0.1` - see "Invite links" above. Have them test `http://<host-LAN-IP>:<port>/health` in a browser first.
- B cannot join: confirm the invite server URL embeds the actual bound port and A's real LAN IP, not `127.0.0.1`. If A's LAN IP auto-detection failed, set a Public URL override in Settings → Vault Rooms → Relay server and restart the server.
- B can reach `/health` but the invite link does nothing when clicked: confirm the Vault Rooms plugin is installed and enabled on B's machine - the link only opens the Join form, it can't install the plugin.
- Writes are denied: inspect ACL grants for the user/device/agent and path pattern.
- Conflicts are expected when two actors edit the same file version.
- A teammate's edits aren't showing up: confirm both devices show the room as mounted (not just visible) - only mounted rooms hold a live sync subscription.
- "Invalid or expired credentials" on one team/server but not another: that team's saved device token no longer matches anything in that server's data (most often because the server's data was reset/recreated after the token was issued - e.g. a fresh reinstall, a wiped `server-data` folder, or switching between embedded and standalone mode with different data files). The plugin marks the team `revoked` in Settings → Vault Rooms → Teams when this happens; use **Forget** there to remove the stale entry (this only forgets it locally, it does not touch the server), then set up or join that team again to get a working identity. This is unrelated to which *room* you have open - a device token is per-team, not per-room.

## Roadmap

Given what's now implemented (embedded server, in-app settings, live WebSocket push wired end-to-end, dual-format invite links), the original v0.2/v0.3 plan still holds up; feasibility notes below.

v0.2: CRDT, better conflict UI, binary support, multi-device enrollment, **QR/mDNS discovery**. The last item is now more valuable than originally scoped, since it would remove the one recurring rough edge in the invite-link flow (stale links after the host's LAN IP changes) - realistic to prioritize earlier than the rest of v0.2 given the mechanism (`detectLanIp`) already exists and mDNS/zeroconf would sit alongside it.

v0.3: TLS, end-to-end encryption, web admin, audit viewer, rollback. TLS is worth pulling forward for any team past pair-programming size (see "Team size and scaling") - plaintext HTTP/WS is a bigger exposure at 20-50 people than at 2.

v0.4: richer Kanban plugin format support, deeper Tasks metadata, Dataview read-only tools.

Not yet on the roadmap but worth adding given the embedded-server model: **standalone-hosting guidance/tooling** (a documented, maybe scripted, path to run `vault-rooms-relay` unattended on a NAS or always-on machine) for teams that outgrow "one teammate's laptop is the server."
