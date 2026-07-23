# Security

Vault Rooms is pre-1.0 software. Versions through v0.1.6 use plaintext HTTP/WS. Version v0.2.1 introduces the pinned TLS/WSS model described below; verify the installed manifest version before relying on it. See the main [README](README.md) for the full security model, revocation model, and known limitations sections this file summarizes and points back to.

## Threat model

Vault Rooms is designed for **trusted people on a trusted local network** - a household, a small team's office LAN, a shared Wi-Fi you already trust everyone on. It is explicitly **not** designed for:

- Untrusted networks (coffee shop Wi-Fi, public networks, anything with a hostile party who can sniff or inject packets on the same LAN segment).
- Internet-facing use. Do not port-forward or expose any Vault Rooms listener directly to the Internet.
- Protecting data from other people who already have legitimate LAN access but aren't invited to a given room - the ACL model deny-by-defaults them from Vault Rooms' own rooms, but it cannot stop them from, say, port-scanning your machine.
- Protecting against a malicious or compromised member you've already invited and granted access to. Once someone has read access to a room, nothing prevents them from keeping a local copy of everything they could read before being revoked (see "Revocation limitations" below).

Within that scope, Vault Rooms enforces: per-path, deny-by-default access control (`file:read`/`file:write`/`file:create`/`file:delete`, individually grantable to a user or a whole team); per-server identity (a device only has power on the one server it registered with); and server-side enforcement of every permission check on both REST and WebSocket paths, so client-side UI state is never the actual gate. REST and WebSocket writes/deletes both require the shared `sync:push` permission as well as the file-specific permission.

## Transport security modes

Vault Rooms has three transport modes:

- **Pinned TLS** is the default for new embedded servers. The server creates a persistent ECDSA identity, uses it to sign its renewable TLS leaf certificate, and places the identity certificate, TLS name, server ID, and SHA-256 SPKI fingerprint in every invite. The client pins that identity before sending an invite token, device token, Authorization header, or sync data. Normal traffic uses HTTPS/WSS with certificate verification enabled; renewing the leaf certificate does not change the pin.
- **OS-trusted TLS** is available to the standalone relay when an operator supplies a certificate and key trusted by the client operating system, normally behind the team's existing certificate-management process. It uses ordinary HTTPS/WSS trust rather than Vault Rooms' self-managed identity pin.
- **Plaintext legacy mode** exists only so an existing HTTP/WS server can migrate. In this mode device tokens, invite tokens, file contents, filenames, and ACL rules are unencrypted and can be read or modified by an attacker able to observe or intercept LAN traffic. Do not create a new deployment in this mode or leave migration unfinished.

Pinned TLS is transport encryption and server authentication, not end-to-end encryption: the relay and each authorized client necessarily see plaintext content, the server database is not encrypted by this feature, and client device tokens remain subject to the storage limitation below. Vault Rooms is still LAN-only and is not designed to be exposed directly to the Internet.

### Migrating a legacy server

The v0.1-to-v0.2 data upgrade is non-destructive. The relay makes a one-time
byte-identical `relay.sqlite.bak-v1` copy and migrates the active database in place. Read-only schema
inspection does not flush either file. A corrupt or unrelated file at the canonical backup path is
quarantined without deletion before a create-only atomic backup is installed. This covers both the exact
schema shipped by 0.1.0-0.1.6 and the older team-scoped development shapes, including the earliest
`shares`/`share_id` layout; the structural conversion is transactional. The plugin converts its saved server entries without
discarding plaintext device tokens or mounted-room state.
Those historical tokens are classified as `plain` from server-side migration context. If a prior
development build already archived the database, automatic recovery is limited to an empty
replacement and retains an existing identity's server ID and pin. Restoring over a non-empty
replacement is an explicit owner action that first keeps a separate `.pre-v01-restore` copy.

An erased local owner credential is not a reason to reopen `POST /api/bootstrap`. The embedded
plugin can create a replacement device only for the already-recorded server owner through an
in-process lifecycle method. Credential creation and audit persistence complete durably before the
token is returned, token security comes from the actual running listener, and a plugin-settings
write failure revokes the temporary recovery device. There is no public recovery endpoint.

The embedded owner chooses one of two migration ceremonies:

- **Normal migration** keeps HTTP/WS and HTTPS/WSS available together. An already-authenticated legacy client may obtain the new server identity over its existing HTTP connection, pin it, complete migration over verified HTTPS, and receive a replacement device token. The old token is invalidated and every authenticated socket using it is closed. This is convenient, but it trusts one authenticated plaintext response: an active LAN attacker can replace that first pin. Use Strict for sensitive teams. Normal protects subsequent traffic only if that first response was not intercepted.
- **Strict migration** never delivers pin material over HTTP. Each client must use a fresh fingerprint-carrying invite from the owner, transferred through a channel the team trusts. This is the correct choice when the existing LAN may already be hostile or when the fingerprint needs independent verification.

The owner can see how many active devices were last observed on legacy HTTP before enforcing TLS. Enforcement disables the plaintext listener and closes every authenticated socket still using a legacy token, including one opened over WSS during migration; the same shared authentication check rejects that token on later REST and WebSocket attempts with `TLS_REQUIRED`. A device that did not migrate must rejoin using a fresh pinned invite.

WebSocket admission is bounded at both ends: the relay closes a connection that does not authenticate within 10 seconds, and the plugin closes/retries when `hello_ok` does not arrive within 10 seconds. On reconnect the plugin re-subscribes every desired room and processes messages in receive order; socket replacement invalidates stale callbacks from the old generation.

For the standalone runtime, dual-stack is an explicit operator transition: start an existing plaintext server with `TLS_MODE=pinned`, `TLS_DUAL_STACK=true`, and `TLS_MIGRATION_MODE=non_strict|strict`; after clients migrate, stop it and restart with `TLS_DUAL_STACK=false`. That restart durably advances `tls_migrating` to `tls_enforced` and starts only HTTPS/WSS. A fresh pinned server and an already pinned/enforced server reject dual-stack instead of exposing an unnecessary plaintext listener.

### Pin mismatch and planned identity rotation

Pinned REST and WSS fail before sending credentials if certificate verification fails. The client may then make one separate, credentialless probe to classify the failure. If the peer presents the same pinned identity, the original expiry, hostname, or network error remains the error. If it presents a different identity, the connection enters a blocking `pin_mismatch` state and no authenticated retry is made.

A deliberate owner rotation is the only automatic recovery path. Rotation records are signed by the previously pinned identity; the client verifies the complete oldest-to-newest chain and persists applied rotation IDs so replay protection survives a plugin restart. An unsigned, expired, replayed, incomplete, or wrong-server chain remains blocked. There is no **Trust anyway** button. If the old identity was lost through a reinstall or data reset, obtain a fresh invite from the owner and verify its fingerprint through a trusted channel.

## CRDT sync (opt-in, per room)

A room can opt into CRDT sync (Room Settings → "Live editing (CRDT sync)", default off) for real-time, character-level merging of its Markdown (`.md`) files, using Yjs. This adds no new network listener or transport mode: CRDT messages are JSON on the same authenticated `/sync` WebSocket connection every room already uses, protected by whatever transport mode the server is running (pinned TLS/WSS, OS-trusted TLS, or legacy plaintext - see "Transport security modes" above), and gated by the same per-path `file:read`/`file:write`/`file:create` ACL checks as every other sync message.

- **Bounded update-loss-on-crash, not corruption.** A CRDT edit is applied to the relay's in-memory document and appended to its update log on the ordinary (not `durable()`-committed) write path - the same accepted bounded-loss stance the whole-file sync lane already has for its own debounced push (README's "Sync latency"). A relay crash in the narrow window between accepting an edit and that log entry's background flush reaching disk can lose that specific edit; it cannot corrupt the document or resurrect deleted content, and the relay never reports an edit as accepted to other room members until it has actually landed in the log. Room/file lifecycle transitions that affect CRDT state (enabling CRDT for a room, deleting/recreating a file) do go through the stronger `durable()` commit path, matching every other lifecycle transition in this document.
- **Legacy-client compatibility is read-capable, not write-capable.** A Vault Rooms client that hasn't upgraded to advertise CRDT support can still read a CRDT-enabled room's Markdown files - the relay periodically writes the merged text back into the same whole-file storage regular REST/legacy reads use. It cannot write to a CRDT-enabled path directly: a whole-file REST or WebSocket write to that path is rejected with a specific error instructing the client to use CRDT sync (or upgrade), rather than silently corrupting the document or losing the legacy client's edit.

CRDT sync's own manual two-real-device verification is still pending (see ROADMAP.md) - treat it as a newer, less-tested surface than the rest of the sync engine.

## Token storage

- Invite tokens (`tr_inv_...`) and device tokens (`tr_dev_...`) are generated with a CSPRNG (`crypto.randomBytes`).
- The relay only ever stores a **SHA-256 hash** of each token, never the token itself - a stolen database dump cannot be used to reconstruct working tokens.
- The **client** side is weaker: the plugin stores its own device token in Obsidian's plugin data JSON (`data.json` under the plugin's folder in `.obsidian/plugins/vault-rooms/`), in plaintext, unencrypted at rest. This is standard practice for Obsidian plugin settings generally, but it means anyone with filesystem access to that device (or a backup of it) can read the token and use it to impersonate that device against the relay until it's revoked.
- A leaked/stolen device should be revoked individually (see "Revocation limitations" below and the README's "Deleting rooms/teams and removing access" section) - this invalidates the specific token immediately, without affecting the same user's other devices.

## Server identity-key storage

- Embedded hosting stores `identity.json` beside `relay.sqlite` under `.obsidian/plugins/vault-rooms/server-data/`. It contains the identity private key and active TLS leaf private key. Obsidian's `DataAdapter` does not expose a portable file-permission API, so Vault Rooms cannot enforce a Unix mode for this file.
- Embedded database and identity replacements do not depend on `DataAdapter.rename()` overwriting an existing path. The old complete file is moved to a sibling `.replace-backup`, restored if promotion fails, and recovered at startup if replacement was interrupted; users should not delete these recovery files while the relay is stopped after a failed write.
- Standalone hosting stores the same credential under `IDENTITY_DIR/identity.json`; atomic saves use a private temporary file and the final file is forced to mode `0600`.
- Do not share either file. Protect vault/plugin configuration backups and sync targets that include the embedded server-data directory. A stolen identity can impersonate the server; a lost identity cannot produce a valid signed continuity chain, so clients correctly block until they receive and independently verify a fresh invite.

## Revocation limitations

Revocation (removing a room-level ACL rule, removing someone from a team, revoking a user server-wide, or revoking a single device) reliably and immediately stops **future** access: the device's token stops authenticating on its next request, and any live WebSocket session for that device is closed at once.

What revocation does **not** do:

- **No guaranteed deletion of already-synced content.** If a device already downloaded a file before being revoked, that local copy is untouched - Vault Rooms has no remote-wipe capability. This applies uniformly to member revocation, team removal, and room/team deletion.
- **No retroactive protection against a copy already exfiltrated.** If a revoked member already copied files elsewhere (another disk, a screenshot, printed it) before revocation, nothing in this system can undo that - this is inherent to any access-control system without DRM, not specific to Vault Rooms.
- **No detection of a device that stays offline to avoid revocation taking effect.** Revocation is enforced on the device's *next request* to the relay - a device that never reconnects never "sees" the revocation, though it also can't push new changes or receive new content either.

Treat revocation as "stop this person's future access," not "erase what they already had."

## No plugin sandbox

Vault Rooms does not, and cannot, sandbox other Obsidian community plugins. If another locally-installed plugin (yours or a teammate's) can read a file in the vault, it can read a Vault Rooms-synced file exactly the same as any other vault file - Vault Rooms' ACLs govern what syncs *between devices*, not what other local software on a device that already has legitimate read access can do with the content once it's there. This is a fundamental Obsidian platform constraint, not something Vault Rooms could fix from a plugin sandbox.

## Bootstrap and other unauthenticated endpoints

The only endpoint that can provision privileged access with no pre-existing credential is the one-time server-owner **bootstrap**, and it is deliberately hardened: a per-process random PIN (never sent over the network unprompted - read in-process by the embedded plugin, printed to console for the standalone CLI) plus a `Host` header check, specifically to defend against a malicious web page attempting a DNS-rebinding attack against your loopback/LAN address. Once an owner exists, bootstrap is closed permanently. The other unauthenticated routes are `POST /api/join` (gated by a single-use invite token), `GET /health` (name/version only), and rate-limited `GET /api/identity/rotations` (public signed continuity records only). The rotation probe response contains no private key, device token, room data, or sync payload.

`POST /api/invites/accept` normally uses the same device bearer-token authentication as other REST and WebSocket traffic. The only alternate form is strict TLS migration: over the freshly pinned HTTPS connection, the client omits `Authorization` and sends an HMAC proof bound to the device ID, stable server ID, exact invite token, and presented identity SPKI. The relay verifies that proof against the stored hash of an active plaintext-era device token and immediately rotates the token on success. A copied public `serverId` or attacker-controlled invite therefore cannot make the client disclose a reusable bearer token, and the proof cannot be replayed against another invite or identity.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security vulnerability. Instead, use GitHub's private disclosure feature: open this repository's **Security** tab → **Report a vulnerability** (GitHub Security Advisories). This lets us discuss and fix the issue before it's publicly visible.

If you're unsure whether something qualifies (e.g. a "known limitation" documented above vs. a genuine bug), err on the side of reporting privately - worst case, we point you to the relevant section of this document.

## Supported versions

Vault Rooms is pre-1.0. Only the latest published release is supported; there is no backport/LTS policy at this stage. Always update to the latest version before reporting an issue.
