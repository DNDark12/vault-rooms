# Roadmap

What's next, by priority. Nothing here is a product claim until it ships. See [README](README.md) for what the
plugin does today and [SECURITY.md](SECURITY.md) for the threat model.

## Next up

- **Onboarding.** In progress. An address that cannot work for a teammate (loopback, `0.0.0.0`) is now
  refused at the host with an explanation, instead of passing the host's own reachability check and failing
  later on the teammate's machine; a self-assigned `169.254.x` is allowed but flagged. The relay records the
  address teammates actually connect on, and the panel warns when that disagrees with what invites advertise -
  which is how a stale override after a DHCP change becomes visible. Still to do: reduce the remaining manual
  steps. Hard limit worth knowing: the plugin cannot auto-detect its own LAN address, because reading network
  interfaces is flagged by Obsidian's review as fingerprinting.
- **CRDT soak, then default-on for new rooms.** Live editing works and has been through extended two-device
  testing; it stays opt-in per room until it has run on real content for a while. Two of the three known gaps are
  now closed (an edit typed inside the rename acknowledgement window is re-offered immediately, and an in-flight
  request is failed rather than stranded when the socket drops). The remaining one is a coexistence trade-off
  needing a decision: a peer on a build older than the rename protocol applies a rename only after reconnecting.
  Closing it means also broadcasting the rename as a delete+create to non-CRDT peers, which is more traffic and
  more edge cases for a case that already self-heals.
- **Live cursors / note presence, before chat.** Much cheaper now that CRDT ships - the same connection already
  carries per-note document state, so this needs an ephemeral awareness protocol and editor UI, not new
  transport. Ship this as its own small phase: note-scoped cursor state must disappear promptly on disconnect,
  and is deliberately separate from chat's server-wide online/offline presence.
- **Chat v1, after live cursors.** The existing design remains viable: direct, team, and room threads; immutable
  Markdown messages; unread state; realtime delivery over the authenticated `/sync` socket; history isolated in
  a separately-pruned `chat.db`; and a docked desktop UI. Refresh the protocol and threat-model sections before
  implementation because TLS pinning and CRDT traffic have shipped since the design was written. Do not bundle
  chat with cursors: they can share connection lifecycle and identity, but not authorization or presence state.
- **Binary transport instead of base64.** Images and PDFs currently travel base64-encoded, costing ~33% overhead
  and lowering the practical size ceiling. Independent of everything else.

## Bigger efforts - each needs its own design pass

- **Selective sync / partial mounts.** Mounting a room is all-or-nothing per folder today.
- **Conflict resolution UI beyond keep-both.** A real diff/merge view for the whole-file lane.
- **Multi-server rooms.** A room lives on exactly one relay; there is no federation.
