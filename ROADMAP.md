# Roadmap

What's next, by priority. Nothing here is a product claim until it ships. See [README](README.md) for what the
plugin does today and [SECURITY.md](SECURITY.md) for the threat model.

## Next up

- **Onboarding.** Setup still assumes the host knows their own LAN address and remembers to set it. The failure
  cases are silent and land on the teammate ("can't connect"), which is the worst place for them. Wanted: fewer
  manual steps, and errors that name the actual problem.
- **CRDT soak, then default-on for new rooms.** Live editing works and has been through extended two-device
  testing, but it stays opt-in per room until it has run on real content for a while. Three known gaps to close
  first: a peer on an older build applies a rename only after reconnecting, an edit typed inside the rename
  acknowledgement window waits for the next handshake, and an in-flight rename isn't settled if the socket drops.
- **Live cursors / presence.** Much cheaper now that CRDT ships - the same connection already carries per-note
  document state, so this needs an awareness protocol and UI, not new transport.
- **Binary transport instead of base64.** Images and PDFs currently travel base64-encoded, costing ~33% overhead
  and lowering the practical size ceiling. Independent of everything else.

## Bigger efforts - each needs its own design pass

- **Selective sync / partial mounts.** Mounting a room is all-or-nothing per folder today.
- **Conflict resolution UI beyond keep-both.** A real diff/merge view for the whole-file lane.
- **Multi-server rooms.** A room lives on exactly one relay; there is no federation.
