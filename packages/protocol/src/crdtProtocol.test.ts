import { describe, expect, it } from "vitest";
import type { SyncClientMessage, SyncServerMessage } from "./protocol.js";

// Phase 3 of docs/superpowers/plans/2026-07-20-crdt-sync.md: CRDT wire messages + capability
// negotiation. Every CRDT message is keyed by roomId + relativePath + epoch (contract 1.3/1.9);
// documentId is the stable outer identity carried only in crdt_created/room_snapshot metadata, not
// repeated on every update (Phase 3 scoping decision). Round-tripping through JSON.stringify/parse
// is the same shape the real WS transport uses (see connectionRegistry.ts's sendJson), so this is
// not just a type-level check.
//
// Colocated in src/ (like smoke.test.ts), not a separate test/ directory - this package's
// tsconfig.json only includes "src/**/*.ts", so a test/ directory file would silently escape
// `pnpm typecheck` coverage even though vitest would still run it.
function roundTrip<T>(message: T): T {
  return JSON.parse(JSON.stringify(message)) as T;
}

describe("CRDT protocol messages", () => {
  it("hello optionally carries a crdt capability flag, and still parses without one (back-compat)", () => {
    const withCapability: SyncClientMessage = {
      type: "hello",
      requestId: "req_1",
      token: "tok",
      client: { kind: "obsidian-plugin", version: "0.3.0", deviceName: "laptop" },
      capabilities: { crdt: true }
    };
    const withoutCapability: SyncClientMessage = {
      type: "hello",
      requestId: "req_2",
      token: "tok",
      client: { kind: "obsidian-plugin", version: "0.2.1", deviceName: "laptop" }
    };

    expect(roundTrip(withCapability).capabilities).toEqual({ crdt: true });
    expect(roundTrip(withoutCapability).capabilities).toBeUndefined();
  });

  it("round-trips crdt_create / crdt_created (first-create flow, contract 1.10)", () => {
    const create: SyncClientMessage = { type: "crdt_create", requestId: "req_1", roomId: "room_1", relativePath: "note.md" };
    const created: SyncServerMessage = {
      type: "crdt_created",
      requestId: "req_1",
      roomId: "room_1",
      relativePath: "note.md",
      documentId: "fil_1",
      epoch: 0
    };

    expect(roundTrip(create)).toEqual(create);
    expect(roundTrip(created)).toEqual(created);
  });

  it("round-trips the bidirectional handshake messages (contract 1.3), scoped by epoch", () => {
    const clientStep1: SyncClientMessage = {
      type: "crdt_sync_step1",
      requestId: "req_1",
      roomId: "room_1",
      relativePath: "note.md",
      epoch: 0,
      stateVector: "AAA="
    };
    const serverStep2: SyncServerMessage = {
      type: "crdt_sync_step2",
      requestId: "req_1",
      roomId: "room_1",
      relativePath: "note.md",
      epoch: 0,
      update: "BBB="
    };
    // The server ALSO sends its own step1 (unprompted, not a reply to a requestId) so the client
    // can answer with whatever the server is missing - the bidirectional half of the handshake.
    const serverStep1: SyncServerMessage = {
      type: "crdt_sync_step1",
      roomId: "room_1",
      relativePath: "note.md",
      epoch: 0,
      stateVector: "CCC="
    };
    const clientStep2: SyncClientMessage = {
      type: "crdt_sync_step2",
      requestId: "req_2",
      roomId: "room_1",
      relativePath: "note.md",
      epoch: 0,
      update: "DDD="
    };

    expect(roundTrip(clientStep1)).toEqual(clientStep1);
    expect(roundTrip(serverStep2)).toEqual(serverStep2);
    expect(roundTrip(serverStep1)).toEqual(serverStep1);
    expect(roundTrip(clientStep2)).toEqual(clientStep2);
  });

  it("round-trips crdt_update / remote_crdt_update fanout", () => {
    const update: SyncClientMessage = {
      type: "crdt_update",
      requestId: "req_1",
      roomId: "room_1",
      relativePath: "note.md",
      epoch: 0,
      update: "EEE="
    };
    const remote: SyncServerMessage = {
      type: "remote_crdt_update",
      roomId: "room_1",
      relativePath: "note.md",
      epoch: 0,
      update: "EEE=",
      updatedBy: { userId: "usr_1", displayName: "Alice" }
    };

    expect(roundTrip(update)).toEqual(update);
    expect(roundTrip(remote)).toEqual(remote);
  });

  it("round-trips room_mode_changed and crdt_rejected (with currentEpoch for stale-epoch resync, contract 1.9)", () => {
    const modeChanged: SyncServerMessage = { type: "room_mode_changed", roomId: "room_1", crdtEnabled: true };
    const rejectedStaleEpoch: SyncServerMessage = {
      type: "crdt_rejected",
      requestId: "req_1",
      roomId: "room_1",
      relativePath: "note.md",
      code: "STALE_EPOCH",
      message: "This document was recreated at a newer epoch.",
      currentEpoch: 2
    };
    const rejectedNoEpoch: SyncServerMessage = {
      type: "crdt_rejected",
      roomId: "room_1",
      relativePath: "note.md",
      code: "PERMISSION_DENIED",
      message: "You do not have permission to write to this document."
    };

    expect(roundTrip(modeChanged)).toEqual(modeChanged);
    expect(roundTrip(rejectedStaleEpoch)).toEqual(rejectedStaleEpoch);
    expect(roundTrip(rejectedNoEpoch).currentEpoch).toBeUndefined();
  });
});
