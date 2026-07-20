# Roadmap

This tracks work after the v0.2 transport-security release candidate, ordered by priority within each tier. See [README](README.md) for the implemented behavior and [SECURITY.md](SECURITY.md) for the current threat model; roadmap items are not product claims until they ship.

## Explicitly dropped - do not pick back up without a fresh decision

- **QR invite code** (shipped in 0.1.5, reverted the same cycle). The invite modal briefly rendered a QR code alongside the plaintext link, framed as "scan with your phone and forward to your computer." Dropped after review: this plugin is `isDesktopOnly`, so a phone can never run it, and "scan, then manually get the link from your phone to your desktop anyway" is strictly more steps than just copying the link into whatever chat app you're already using to reach the recipient. Don't re-add without a concrete scenario where a camera-to-desktop hop is actually faster than copy/paste.
- **MCP/AI agent access.** Considered (competitors like EVC Team Relay and Fast Note Sync have it), but rejected for now: giving an AI agent read/write access to shared rooms is a meaningfully larger security surface than anything else in this plugin (a compromised or over-permissioned agent could exfiltrate or corrupt everything it can reach), and this repo doesn't have anything close to that today. If this comes back, it needs its own dedicated security-integrity review and threat-model write-up *before* any code, not just a normal feature PR - don't scope-creep it into a "quick MCP endpoint."

## P1 - v0.2 implementation complete, pending manual release verification

### 1. TLS/WSS + server fingerprint pinning

Implemented for v0.2.1: new embedded servers default to self-managed pinned TLS/WSS; standalone supports pinned or OS-trusted TLS; invites carry the server identity/SPKI pin; legacy servers have owner-controlled normal and strict migration; enforcement covers the shared REST/WSS authentication path; and planned identity rotation uses signed, replay-protected chains with blocking mismatch UI.

The release candidate also includes zero-data-loss v0.1 upgrades across the tagged release schema
and both older team-scoped layouts (including `shares`/`share_id`): relay data, plugin credentials,
and mount tracking migrate in place, one-time safety backups are retained, and installations affected
by the earlier reset prototype have explicit database and owner-credential recovery paths.

The remaining release gate was the two-real-machine checklist in the implementation plan: fresh pinned join, normal migration, strict migration, unexpected wrong-server identity, and enforcement against an unmigrated client. **Verified on two real machines 2026-07-20** — all five scenarios passed. The v0.2 release itself (version bump + tag) is still pending an explicit cut. See [SECURITY.md](SECURITY.md) for the trust model and limitations.

## P1 - implemented 2026-07-20, pending release

### 2. Standalone relay packaging — done
`Dockerfile` + `docker-compose.yml` at the repo root (single-stage Node image running the same tsx entry point as `pnpm dev:server`; no native deps to build), plus a README section "Running the standalone relay in Docker (NAS / always-on machine)" covering `PUBLIC_URL`, the first-run `ALLOW_REMOTE_BOOTSTRAP` dance, the data volume's backup importance, and a systemd unit example for bare Linux.

### 3. Audit log viewer — done
`GET /api/audit` (`routes/audit.routes.ts`, registered in both runtimes) pages the existing `audit_events` rows newest-first: server owner sees everything, a team owner/admin sees only their team's rows via `?teamId=`. Surfaced as a collapsible "Audit log" section in the Vault Rooms panel (explicit Load/Refresh + Load more, metadata on hover). Covered by `apps/relay-server/test/audit-log.test.ts`.

### 4. Better connection diagnostics — done
The "Test" buttons (panel Other servers + Settings → Servers) now open a step-by-step diagnostics modal (`connectionDiagnostics.ts`, pure and unit-tested): valid URL → something answers → it's a Vault Rooms server with the expected pinned identity → saved login accepted, reporting exactly which step failed with a hint. A pin mismatch is classified as an identity failure, not unreachability; the run is side-effect-free (no pinned recovery, no revoked-marking).

## P2 - after TLS and onboarding are solid

Ordered roughly by how much they depend on each other (CRDT is a prerequisite for live cursors) rather than strict priority - these are all genuinely large efforts and shouldn't be started opportunistically; each deserves its own design pass when its turn comes.

1. **CRDT for Markdown files.** The current whole-file debounced-push + compare-and-swap model is deliberate (see README "Sync latency"/"Concurrency model") - it's fine for "a few people editing occasionally," but two people actually typing in the same note at the same time will conflict-copy, not merge. Real concurrent editing needs a CRDT (Yjs is the de facto choice other Obsidian collab plugins already use) - this is a genuine rewrite of the sync core, not an incremental patch and has no promised release number.
2. **Live cursors / presence.** Only makes sense once CRDT exists - showing where someone else is typing requires the same real-time text-position model CRDT provides.
3. **Binary blob transport instead of base64.** Images/PDFs currently travel as base64-encoded JSON (see README "Known limitations" - roughly 1.33x real size). A dedicated binary transport (multipart, or a raw-bytes WS frame type) would remove that overhead and raise the practical file-size ceiling. Independent of CRDT - could be picked up any time P1 is clear.
4. **Rollback / version history UI.** The server already keeps file version numbers for compare-and-swap; a "show me the last N versions of this file and let me restore one" UI is a natural extension once there's room in the schedule, but it's genuinely new surface (storage growth policy, UI, permission model for who can roll back what).
5. **Kanban/Tasks semantic adapters.** Room "capabilities" already flag that a room recommends Kanban/Tasks (see README "Plugin capability model") - deeper integration (e.g. structured conflict resolution for a Kanban board's JSON instead of generic whole-file conflict copies) is a nice-to-have once the fundamentals above are done, not before.

## Needs dedicated research before it becomes a real roadmap item

### mDNS/zeroconf LAN discovery
The original v0.1 plan (see README's "If the host's LAN IP changes... mDNS-based discovery is a research item") assumed this was a straightforward addition. **It is not**, given what 0.1.4/0.1.5 just went through: the embedded server's `os.networkInterfaces()`-based LAN IP auto-detection was *removed* specifically because Obsidian's plugin-review scanner flags reading network interfaces as machine fingerprinting (see CLAUDE.md rule 3, SECURITY.md, and the 0.1.4 release notes).

mDNS discovery fundamentally requires binding a UDP socket and listening/broadcasting on the local network's interfaces - which is architecturally the same category of "read/use network interface info" the scanner already flagged once. Before this goes back on the roadmap as a real, scheduled item:

1. **Research whether an mDNS implementation can avoid the specific APIs/patterns the scanner flags** (e.g. does the scanner key off literally calling `os.networkInterfaces()`, or does it do broader capability analysis that would also catch a UDP multicast socket bound to `0.0.0.0`/`224.0.0.251`?). This needs an actual test submission or a close reading of what Obsidian's review tooling actually inspects, not just an assumption either way.
2. If it turns out to be flaggable, decide whether an **opt-in setting** (default off, clearly disclosed in Settings and SECURITY.md, framed as "this reads network info to discover peers automatically instead of you copying an IP") is an acceptable trade - Obsidian's review process may treat opt-in differently, but that itself needs confirming, not assuming.
3. Only after 1-2 are actually answered should this get a version number and a place in the P1/P2 list above. Until then, treat the README's existing "mDNS-based discovery is a research item" line as aspirational, not scheduled.

## Positioning guardrails - don't do these regardless of feature progress

Carried over from a competitive review pass (comparing against Relay, EVC Team Relay, Collaborative Folders, Obsidian Live Share, Self-hosted LiveSync, LAN Vault Sync, and others) - these aren't technical roadmap items, they're constraints on how the project describes itself even as features above ship:

- Vault Rooms' actual differentiator is "no cloud, no account, LAN-only, room/path-level ACL," not feature-for-feature parity with mature collaboration suites.
- Don't use "real-time collaboration" or "live editing" language that implies Google-Docs-style character-level co-editing until CRDT (P2 #1) actually ships - "live file sync" is the accurate phrase for the current product.
- Don't claim "version control" - no diff/merge UI exists yet (P2 #4 is a rollback viewer at most, not a Git-equivalent history/diff experience).
- Don't claim E2EE or unqualified "secure." Be precise about what TLS protects (transport and server identity) versus what remains plaintext at authorized endpoints or at rest (server database, client token, server identity-key file - see SECURITY.md).
