# Security

Vault Rooms is pre-1.0 software. This file is the authoritative description of its threat model, transport
security, and known limitations.

## Threat model

Vault Rooms is designed for **trusted people on a trusted local network** - a household, a small team's office LAN, a shared Wi-Fi you already trust everyone on. It is explicitly **not** designed for:

- Untrusted networks (coffee shop Wi-Fi, public networks, anything with a hostile party who can sniff or inject packets on the same LAN segment).
- Internet-facing use. Do not port-forward or expose any Vault Rooms listener directly to the Internet.
- Protecting data from other people who already have legitimate LAN access but aren't invited to a given room - the ACL model deny-by-defaults them from Vault Rooms' own rooms, but it cannot stop them from, say, port-scanning your machine.
- Protecting against a malicious or compromised member you've already invited and granted access to. Once someone has read access to a room, nothing prevents them from keeping a local copy of everything they could read before being revoked (see "Revocation limitations" below).

Within that scope, Vault Rooms enforces: per-path, deny-by-default access control (`file:read`/`file:write`/`file:create`/`file:delete`, individually grantable to a user or a whole team); per-server identity (a device only has power on the one server it registered with); and server-side enforcement of every permission check on both REST and WebSocket paths, so client-side UI state is never the actual gate. REST and WebSocket writes/deletes both require the shared `sync:push` permission as well as the file-specific permission.

## Transport security modes

- **Pinned TLS** - the default for new servers. The server holds a persistent identity, signs its own renewable
  certificate with it, and puts that identity's fingerprint in every invite. The client pins it *before* sending
  any token or data, and renewing the certificate doesn't change the pin.
- **OS-trusted TLS** - for a standalone relay where an operator supplies a certificate the client OS already
  trusts.
- **Plaintext legacy** - exists only so an older HTTP server can migrate. Tokens, file contents, filenames, and
  ACL rules are all readable and modifiable by anyone who can watch the LAN. Don't start a new deployment this
  way or leave a migration unfinished.

Pinned TLS is transport encryption and server authentication, **not** end-to-end encryption: the relay and every
authorized client see plaintext, and the database is not encrypted by this feature.

### Migrating a legacy server

The owner picks one of two ceremonies in Settings:

- **Normal** - a client already authenticated over HTTP can fetch the new identity, pin it, and finish over
  verified HTTPS, receiving a replacement token. Convenient, but it trusts that one plaintext response; an active
  LAN attacker could substitute the pin.
- **Strict** - pin material never travels over HTTP. Each member rejoins with a fresh fingerprint-carrying invite
  delivered through a channel you trust. Use this if the LAN may already be hostile.

Enforcing TLS afterwards closes the plaintext listener and every session still using a legacy token; those
devices must rejoin with a pinned invite. The owner can see how many devices are still on plaintext first.

Upgrading an older server's data is non-destructive: the relay keeps a one-time byte-identical backup, migrates
in place inside a transaction, and never silently overwrites a non-empty database. Saved credentials and
mounted-room state are preserved; tokens issued before pinned TLS are classified as plaintext, because that is
what they were.

### Pin mismatch and identity rotation

If certificate verification fails, pinned connections stop **before** sending credentials. A different identity
puts the connection into a blocking mismatch state with no authenticated retry and deliberately no
trust-anyway override. A planned rotation is accepted automatically only when the client can verify a signature
chain from the previously pinned identity; after a reinstall or a lost identity file, members need a fresh invite
whose fingerprint they verify with the owner out of band.

## CRDT sync (opt-in, per room)

A room can opt into character-level live editing for its Markdown notes (Room Settings → "Live editing (CRDT
sync)", default off). It adds no new listener or transport: the messages ride the same authenticated sync
connection every room already uses, under whatever transport mode the server is in, and are gated by the same
per-path ACL checks.

- **Live cursor presence is authenticated, ephemeral state.** The client sends only document-relative caret and
  selection data; the relay supplies the display identity from the authenticated principal and requires
  `file:read` for the exact path. Presence stays in memory only, is not written to SQLite, and is removed through
  editor, document, room, permission, and connection lifecycle cleanup. It inherits the active transport mode
  and, like document content, is not end-to-end encrypted.
- **Bounded update loss on a crash, never corruption.** An accepted edit is applied in memory and appended to a
  durable log on the ordinary write path - the same accepted trade-off the normal sync lane already makes for its
  debounced push. A crash in the narrow window before that entry reaches disk can lose that one edit; it cannot
  corrupt the note or resurrect deleted content, and no edit is reported to other members until it has landed.
  Lifecycle changes (enabling CRDT, deleting or recreating a file) use the stronger durable commit path.
- **Older clients can read but not write.** A build without CRDT support keeps seeing current content, because the
  relay periodically writes the merged text back into normal whole-file storage. A direct write from such a client
  is refused with a clear error rather than silently losing an edit. One gap: a *rename* is only delivered as a
  CRDT message such a client ignores, so it keeps the old filename until its next reconnect reconciles it.
- **An open editor owns its note, not the file on disk.** Obsidian's autosave may lag behind what you typed, so
  for a note bound to an editor the plugin never reconciles the older on-disk copy back into the shared document -
  doing so would turn "not saved yet" into a real deletion for everyone. Notes with no editor open are still
  reconciled, which is what recovers offline or external edits.
- **Unmounting a room is one atomic teardown**: inbound traffic gated, subscription dropped, that room's editors
  unbound, and its in-memory and persisted documents disposed before it returns.

This is the newest and least-proven surface in the sync engine, despite extended two-device testing on a real
LAN. Enable it per room, on content you have a backup of.

## Token storage

- Invite tokens (`tr_inv_...`) and device tokens (`tr_dev_...`) are generated with a CSPRNG (`crypto.randomBytes`).
- The relay only ever stores a **SHA-256 hash** of each token, never the token itself - a stolen database dump cannot be used to reconstruct working tokens.
- The **client** side is weaker: the plugin stores its own device token in Obsidian's plugin data JSON (`data.json` under the plugin's folder in `.obsidian/plugins/vault-rooms/`), in plaintext, unencrypted at rest. This is standard practice for Obsidian plugin settings generally, but it means anyone with filesystem access to that device (or a backup of it) can read the token and use it to impersonate that device against the relay until it's revoked.
- A leaked/stolen device should be revoked individually (see "Revocation limitations" below) - this invalidates the specific token immediately, without affecting the same user's other devices.

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
