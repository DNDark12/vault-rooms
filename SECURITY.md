# Security

Vault Rooms is v0.1, pre-1.0 software. This document describes the current threat model and known limitations honestly, rather than overstating what v0.1 protects against. See the main [README](README.md) for the full security model, revocation model, and known limitations sections this file summarizes and points back to.

## Threat model

Vault Rooms is designed for **trusted people on a trusted local network** - a household, a small team's office LAN, a shared Wi-Fi you already trust everyone on. It is explicitly **not** designed for:

- Untrusted networks (coffee shop Wi-Fi, public networks, anything with a hostile party who can sniff or inject packets on the same LAN segment).
- Internet-facing use. Nothing about v0.1 is safe to port-forward or expose beyond your LAN.
- Protecting data from other people who already have legitimate LAN access but aren't invited to a given room - the ACL model deny-by-defaults them from Vault Rooms' own rooms, but it cannot stop them from, say, port-scanning your machine.
- Protecting against a malicious or compromised member you've already invited and granted access to. Once someone has read access to a room, nothing prevents them from keeping a local copy of everything they could read before being revoked (see "Revocation limitations" below).

Within that scope, Vault Rooms enforces: per-path, deny-by-default access control (`file:read`/`file:write`/`file:create`/`file:delete`, individually grantable to a user or a whole team); per-server identity (a device only has power on the one server it registered with); and server-side enforcement of every permission check on both REST and WebSocket paths, so client-side UI state is never the actual gate.

## Plaintext LAN - no TLS in v0.1

**Nothing is encrypted in transit.** Device tokens, invite tokens, file contents, filenames, ACL rules - all of it travels as plaintext HTTP/WebSocket over your LAN. Anyone who can observe traffic on the same network segment (a compromised router, a malicious device on the same Wi-Fi with the ability to sniff, an unswitched hub-like network) can read everything a Vault Rooms client sends or receives, including bearer tokens they could then replay.

This is a deliberate v0.1 scope decision, not an oversight - TLS/end-to-end encryption is tracked for a future release (see README roadmap). Until then: only run Vault Rooms on a network where you trust every device that can observe traffic, the same way you'd trust an unencrypted local file share.

## Token storage

- Invite tokens (`tr_inv_...`) and device tokens (`tr_dev_...`) are generated with a CSPRNG (`crypto.randomBytes`).
- The relay only ever stores a **SHA-256 hash** of each token, never the token itself - a stolen database dump cannot be used to reconstruct working tokens.
- The **client** side is weaker: the plugin stores its own device token in Obsidian's plugin data JSON (`data.json` under the plugin's folder in `.obsidian/plugins/vault-rooms/`), in plaintext, unencrypted at rest. This is standard practice for Obsidian plugin settings generally, but it means anyone with filesystem access to that device (or a backup of it) can read the token and use it to impersonate that device against the relay until it's revoked.
- A leaked/stolen device should be revoked individually (see "Revocation limitations" below and the README's "Deleting rooms/teams and removing access" section) - this invalidates the specific token immediately, without affecting the same user's other devices.

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

The only endpoint that can provision privileged access with no pre-existing credential is the one-time server-owner **bootstrap**, and it is deliberately hardened: a per-process random PIN (never sent over the network unprompted - read in-process by the embedded plugin, printed to console for the standalone CLI) plus a `Host` header check, specifically to defend against a malicious web page attempting a DNS-rebinding attack against your loopback/LAN address. Once an owner exists, bootstrap is closed permanently. `POST /api/join` (accepting an invite) and `GET /health` are the only other unauthenticated routes, gated by a single-use invite token and returning nothing but a name/version string, respectively.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security vulnerability. Instead, use GitHub's private disclosure feature: open this repository's **Security** tab → **Report a vulnerability** (GitHub Security Advisories). This lets us discuss and fix the issue before it's publicly visible.

If you're unsure whether something qualifies (e.g. a "known limitation" documented above vs. a genuine bug), err on the side of reporting privately - worst case, we point you to the relevant section of this document.

## Supported versions

Vault Rooms is pre-1.0. Only the latest published release is supported; there is no backport/LTS policy at this stage. Always update to the latest version before reporting an issue.
