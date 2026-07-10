# Roadmap

This tracks what's next after v0.1, ordered by priority within each tier. See [README](README.md) for what v0.1 already does and [SECURITY.md](SECURITY.md) for the current threat model - nothing below changes either until it actually ships.

## Shipped

- **QR invite code** (0.1.5) - the invite modal now renders a QR code alongside the plaintext link, for a nearby teammate to scan with their phone and forward to their own desktop. Encodes the same link already shown as text, so it adds no new fingerprinting surface - this is why it shipped ahead of everything else below instead of waiting on the P1 items.

## Explicitly dropped - do not pick back up without a fresh decision

- **MCP/AI agent access.** Considered (competitors like EVC Team Relay and Fast Note Sync have it), but rejected for now: giving an AI agent read/write access to shared rooms is a meaningfully larger security surface than anything else in this plugin (a compromised or over-permissioned agent could exfiltrate or corrupt everything it can reach), and this repo doesn't have anything close to that today. If this comes back, it needs its own dedicated security-integrity review and threat-model write-up *before* any code, not just a normal feature PR - don't scope-creep it into a "quick MCP endpoint."

## P1 - next up, in priority order

### 1. TLS/WSS + server fingerprint pinning
The single biggest gap between "trusted-LAN toy" and "something a real team can rely on." Plaintext HTTP/WS today means every token and every file is readable to anyone who can observe LAN traffic (see SECURITY.md).

This needs a design pass before any code, not a quick patch:
- Where do certs come from? Self-signed generated on first bootstrap is the obvious default (no external CA dependency, matches the "no cloud, no account" positioning) - but that means clients must pin the server's certificate/public key on first connect (TOFU - trust-on-first-use) and warn loudly if it ever changes unexpectedly, the same way SSH host-key checking works. A silent "just trust whatever cert shows up" TLS setup would be security theater.
- What happens when the host's cert changes (server reinstalled, `server-data` wiped, moved to standalone)? Needs a clear, documented re-pairing story, not a confusing "connection insecure" dead end.
- Does this affect the embedded server's `0.0.0.0` bind story or the Public URL override flow? Probably not directly, but needs to be checked once the design exists.
- Standalone and embedded runtimes need the same behavior here, same as everything else that's had to be kept in sync between `appCore.ts` and `embeddedRelayApp.ts`.

Do this before CRDT/live-editing (P2) - security fundamentals first, features on top of a shaky transport just means more valuable data crossing that same plaintext wire.

### 2. Standalone relay packaging
Currently "standalone" means `pnpm dev:server` from a cloned repo - fine for the maintainer, real friction for a team that wants to run it on a NAS or an always-on machine without a dev toolchain.

- `Dockerfile` + `docker-compose.yml` (the relay has no native dependencies - `sql.js` is pure WASM - so this should be a small, straightforward image).
- A short "run this on your NAS" doc section (Synology/Unraid/etc. container instructions, or at minimum a systemd unit example for a bare Linux box).
- No code changes needed in the relay itself for this - it's packaging and docs only, low risk.

### 3. Audit log viewer
The audit *mechanism* already exists server-side - `repo.audit(...)` calls already fire on connect/disconnect, permission denials, revocations, etc. (see `apps/relay-server/src/sync/syncServer.ts`, `services/policyService.ts`). What's missing is a way to actually look at it - right now that data is written but never surfaced anywhere in the plugin UI. This is a smaller lift than it sounds since the backend data already exists: add a read endpoint + a simple table/list view in the Vault Rooms panel (owner/admin only), no new logging infrastructure required.

### 4. Better connection diagnostics
Right now "why can't B join" is a manual checklist in the Troubleshooting README section (health-check the URL, check subnet/firewall/AP isolation). A built-in "Test connection" flow that actually walks through those checks (resolve the URL, hit `/health`, report which step failed) would turn a support conversation into a self-serve error message. Moderate effort, no architecture risk.

## P2 - after TLS and onboarding are solid

Ordered roughly by how much they depend on each other (CRDT is a prerequisite for live cursors) rather than strict priority - these are all genuinely large efforts and shouldn't be started opportunistically; each deserves its own design pass when its turn comes.

1. **CRDT for Markdown files.** The current whole-file debounced-push + compare-and-swap model is a deliberate v0.1 simplification (see README "Sync latency"/"Concurrency model") - it's fine for "a few people editing occasionally," but two people actually typing in the same note at the same time will conflict-copy, not merge. Real concurrent editing needs a CRDT (Yjs is the de facto choice other Obsidian collab plugins already use) - this is a genuine rewrite of the sync core, not an incremental patch.
2. **Live cursors / presence.** Only makes sense once CRDT exists - showing where someone else is typing requires the same real-time text-position model CRDT provides.
3. **Binary blob transport instead of base64.** Images/PDFs currently travel as base64-encoded JSON (see README "Known limitations" - roughly 1.33x real size). A dedicated binary transport (multipart, or a raw-bytes WS frame type) would remove that overhead and raise the practical file-size ceiling. Independent of CRDT - could be picked up any time P1 is clear.
4. **Rollback / version history UI.** The server already keeps file version numbers for compare-and-swap; a "show me the last N versions of this file and let me restore one" UI is a natural extension once there's room in the schedule, but it's genuinely new surface (storage growth policy, UI, permission model for who can roll back what).
5. **Kanban/Tasks semantic adapters.** Room "capabilities" already flag that a room recommends Kanban/Tasks (see README "Plugin capability model") - deeper integration (e.g. structured conflict resolution for a Kanban board's JSON instead of generic whole-file conflict copies) is a nice-to-have once the fundamentals above are done, not before.

## Needs dedicated research before it becomes a real roadmap item

### mDNS/zeroconf LAN discovery
The original v0.1 plan (see README's "If the host's LAN IP changes... mDNS/QR discovery is on the roadmap") assumed this was a straightforward addition. **It is not**, given what 0.1.4/0.1.5 just went through: the embedded server's `os.networkInterfaces()`-based LAN IP auto-detection was *removed* specifically because Obsidian's plugin-review scanner flags reading network interfaces as machine fingerprinting (see CLAUDE.md rule 3, SECURITY.md, and the 0.1.4 release notes).

mDNS discovery fundamentally requires binding a UDP socket and listening/broadcasting on the local network's interfaces - which is architecturally the same category of "read/use network interface info" the scanner already flagged once. Before this goes back on the roadmap as a real, scheduled item:

1. **Research whether an mDNS implementation can avoid the specific APIs/patterns the scanner flags** (e.g. does the scanner key off literally calling `os.networkInterfaces()`, or does it do broader capability analysis that would also catch a UDP multicast socket bound to `0.0.0.0`/`224.0.0.251`?). This needs an actual test submission or a close reading of what Obsidian's review tooling actually inspects, not just an assumption either way.
2. If it turns out to be flaggable, decide whether an **opt-in setting** (default off, clearly disclosed in Settings and SECURITY.md, framed as "this reads network info to discover peers automatically instead of you copying an IP") is an acceptable trade - Obsidian's review process may treat opt-in differently, but that itself needs confirming, not assuming.
3. Only after 1-2 are actually answered should this get a version number and a place in the P1/P2 list above. Until then, treat the README's existing "mDNS/QR discovery... on the roadmap" line as QR-only (already shipped, see "Shipped" above) - the mDNS half of that sentence is aspirational, not scheduled.

## Positioning guardrails - don't do these regardless of feature progress

Carried over from a competitive review pass (comparing against Relay, EVC Team Relay, Collaborative Folders, Obsidian Live Share, Self-hosted LiveSync, LAN Vault Sync, and others) - these aren't technical roadmap items, they're constraints on how the project describes itself even as features above ship:

- Vault Rooms' actual differentiator is "no cloud, no account, LAN-only, room/path-level ACL," not feature-for-feature parity with mature collaboration suites.
- Don't use "real-time collaboration" or "live editing" language that implies Google-Docs-style character-level co-editing until CRDT (P2 #1) actually ships - "live file sync" is the accurate phrase for what v0.1-v0.1.5 do.
- Don't claim "version control" - no diff/merge UI exists yet (P2 #4 is a rollback viewer at most, not a Git-equivalent history/diff experience).
- Don't claim E2EE or "secure" without qualification until TLS (P1 #1) ships, and even then, be precise about what's encrypted (transport) versus what isn't (server-side plaintext storage, client-side token storage - see SECURITY.md).
