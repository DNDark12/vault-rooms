# LAN Share Reachability Design

**Date:** 2026-07-15

**Status:** Implemented and locally verified on 2026-07-15. Release publication remains pending the post-merge verification and tag workflow.

## Problem

The embedded relay owner correctly connects to its own server through the loopback URL. The Vault Rooms panel currently presents that local live-sync connection next to the configured LAN share URL without independently checking the LAN URL. A stale or mistyped Public URL override can therefore produce a green `Live sync: connected` badge even though invite recipients cannot reach the advertised address.

## Goals

- Keep the owner's local REST/WSS connection on loopback.
- Probe the exact LAN URL placed in invite links.
- Show LAN reachability separately from local live-sync state.
- Block creation of local-server invites while the LAN URL is missing, being checked, or known unreachable.
- Support plaintext legacy migration and pinned HTTPS without sending device credentials in the health probe.

## Non-goals

- Automatic network-interface discovery.
- Proving that every remote network can reach the host through firewalls, VPNs, or access-point isolation.
- Replacing the owner's loopback connection with the LAN URL.
- Changing remote-server invite behavior.

## Design

### Probe

Add a credentialless LAN health probe that requests `<lanUrl>/health` with a three-second timeout and validates the existing Vault Rooms health response. Plain HTTP uses Obsidian `requestUrl`; pinned HTTPS uses the saved identity certificate, TLS name, and SPKI pin through the existing pinned transport. Neither path sends an authorization header, device token, invite token, request body, or rotation fallback request.

The panel keeps transient probe state keyed by the current LAN URL and pin material:

- `checking`
- `reachable`
- `unreachable` with a normalized diagnostic message

A generation/key check prevents a late response for an old URL from overwriting the state for a newer configuration. Rendering may start one de-duplicated probe for a new key; completion re-renders the panel only when the result is still current.

### UI

The hosting card shows one LAN badge beneath `LAN (share this)`:

- `LAN share: checking…`
- `LAN share: reachable from this device`
- `LAN share: unreachable`

An unreachable result includes an actionable warning to update Public URL override, restart the server, and test again. The text explicitly says that a successful local check does not guarantee passage through another device's firewall or Wi-Fi isolation.

The Active connection section keeps displaying the owner loopback URL and local live-sync state, with a short `Local owner connection` label so it cannot be mistaken for LAN reachability.

### Invite gate

Before the plugin asks the relay to create a team, room, or friend invite for this device's own embedded server, it runs the same LAN probe. Missing, checking, or unreachable LAN state prevents issuing a new token and surfaces the actionable error. Invites created on a remote active server are unaffected.

The existing loopback warning becomes a hard failure for own-server invite creation because a loopback invite is unusable by teammates.

## Error handling

- Invalid URL, timeout, DNS/routing failure, TLS verification failure, wrong SPKI, non-JSON response, and a non-Vault-Rooms health response all produce `unreachable`.
- Pin mismatch remains fail-closed and never falls back to unpinned transport.
- A probe failure does not stop the local relay or local owner sync.
- Stopping the relay clears the transient probe state.

## Testing

1. RED: own-server invite creation is rejected before the invite API is called when its LAN health probe fails.
2. RED: a reachable LAN URL allows own-server invite creation; remote active-server invites do not depend on the local host probe.
3. RED: panel probe state ignores a late result from a previous LAN URL.
4. RED: plaintext and pinned HTTPS probes call the correct transport without credentials.
5. GREEN: run focused plugin tests, `pnpm typecheck`, `pnpm test`, and `pnpm build:plugin`; confirm generated assets and plugin-review bundle constraints remain clean.

## Release impact

This is a release-blocking UX/correctness fix for `0.2.0`. The release tag is created only after the new tests and the complete verification suite pass.
