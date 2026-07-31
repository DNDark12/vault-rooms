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

  // User-facing error messages (docs/superpowers/plans/2026-07-29-user-facing-error-messages.md).
  // `hello_error` used to carry a code and nothing else, so the plugin had no wording to show and fell
  // back to a generic notice. `message` is optional so a relay that predates this still parses.
  it("hello_error carries optional prose alongside its code", () => {
    const rejected: SyncServerMessage = {
      type: "hello_error",
      requestId: "hello_1",
      code: "UNAUTHORIZED",
      message: "This device is no longer signed in to this server."
    };
    const codeOnly: SyncServerMessage = { type: "hello_error", code: "UNAUTHORIZED" };

    expect(roundTrip(rejected)).toEqual(rejected);
    expect(roundTrip(codeOnly)).toEqual(codeOnly);
    expect(roundTrip(codeOnly).message).toBeUndefined();
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

  it("round-trips crdt_rename / crdt_renamed / remote_crdt_rename (fourth hardware-testing round, 2026-07-23)", () => {
    // Replaces the old delete-old+create-new translation for a rename inside a CRDT-enabled room -
    // epoch is unchanged (same field shape as every other CRDT message, carried for the receiving
    // side's own bookkeeping, not because the rename bumps it - CrdtDocManager caches by (fileId,
    // epoch), never by path, so a pure path change needs no epoch bump at all).
    const rename: SyncClientMessage = {
      type: "crdt_rename",
      requestId: "req_1",
      roomId: "room_1",
      oldRelativePath: "old-title.md",
      relativePath: "new-title.md"
    };
    const renamed: SyncServerMessage = {
      type: "crdt_renamed",
      requestId: "req_1",
      roomId: "room_1",
      oldRelativePath: "old-title.md",
      relativePath: "new-title.md",
      epoch: 0
    };
    const remoteRename: SyncServerMessage = {
      type: "remote_crdt_rename",
      roomId: "room_1",
      oldRelativePath: "old-title.md",
      relativePath: "new-title.md",
      epoch: 0,
      renamedBy: { userId: "usr_1", displayName: "Alice" }
    };

    expect(roundTrip(rename)).toEqual(rename);
    expect(roundTrip(renamed)).toEqual(renamed);
    expect(roundTrip(remoteRename)).toEqual(remoteRename);
  });
});

// Live cursors / note presence v1 (docs/superpowers/specs/2026-07-28-live-cursors-design.md).
// Presence is additively negotiated: `presence: true` is only meaningful alongside `crdt: true`,
// and a client that sends neither still parses under these unions. The cursor payload carries
// *JSON-serialized* Yjs relative positions (Y.relativePositionToJSON) - never live
// Y.RelativePosition objects - because this is exactly what crosses JSON.stringify on the wire.
describe("presence protocol messages", () => {
  const cursor = {
    yanchor: { type: { client: 11, clock: 3 }, tname: "content", assoc: 0 },
    yhead: { type: { client: 11, clock: 7 }, tname: "content", assoc: 0 }
  };

  it("hello can advertise presence alongside crdt, and older shapes still parse", () => {
    const withPresence: SyncClientMessage = {
      type: "hello",
      requestId: "hello_presence",
      token: "tr_dev_test",
      client: { kind: "obsidian-plugin", version: "0.2.5", deviceName: "Laptop" },
      capabilities: { crdt: true, presence: true }
    };
    const crdtOnly: SyncClientMessage = {
      type: "hello",
      requestId: "hello_crdt",
      token: "tr_dev_test",
      client: { kind: "obsidian-plugin", version: "0.2.5", deviceName: "Laptop" },
      capabilities: { crdt: true }
    };
    const legacy: SyncClientMessage = {
      type: "hello",
      requestId: "hello_legacy",
      token: "tr_dev_test",
      client: { kind: "obsidian-plugin", version: "0.1.6", deviceName: "Laptop" }
    };

    expect(roundTrip(withPresence).capabilities).toEqual({ crdt: true, presence: true });
    expect(roundTrip(crdtOnly).capabilities).toEqual({ crdt: true });
    expect(roundTrip(legacy).capabilities).toBeUndefined();
  });

  it("round-trips presence_set for both a live cursor and a removal", () => {
    const set: SyncClientMessage = {
      type: "presence_set",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 3,
      clientId: 42,
      cursor
    };
    const remove: SyncClientMessage = { ...set, cursor: null };

    expect(roundTrip(set)).toEqual(set);
    expect(roundTrip(remove)).toEqual(remove);
    expect(roundTrip(remove).cursor).toBeNull();
  });

  it("round-trips the server's snapshot, fanout, and rejection variants", () => {
    const state = {
      clientId: 42,
      user: { userId: "usr_1", displayName: "Alice", hue: 137.508 },
      cursor
    };
    const snapshot: SyncServerMessage = {
      type: "presence_snapshot",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 3,
      states: [state]
    };
    const remote: SyncServerMessage = {
      type: "remote_presence",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 3,
      state
    };
    // A removal fans out as a state whose cursor is null, so receivers need no separate message
    // type to drop a peer - and an unknown/stale removal stays idempotent.
    const removalFanout: SyncServerMessage = {
      type: "remote_presence",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 3,
      state: { ...state, cursor: null }
    };
    const rejected: SyncServerMessage = {
      type: "presence_rejected",
      roomId: "room_1",
      relativePath: "Board.md",
      code: "CRDT_STALE_EPOCH",
      message: "This document has moved to a new epoch.",
      currentEpoch: 4
    };

    expect(roundTrip(snapshot)).toEqual(snapshot);
    expect(roundTrip(remote)).toEqual(remote);
    expect(roundTrip(removalFanout).state.cursor).toBeNull();
    expect(roundTrip(rejected)).toEqual(rejected);
    // The relay-assigned hue survives both delivery paths untouched: a receiver must see the same
    // number in its initial snapshot as in every later fanout, or one peer renders a colour the
    // others don't agree on.
    expect(roundTrip(snapshot).states[0]?.user.hue).toBe(137.508);
    expect(roundTrip(remote).state.user.hue).toBe(137.508);
    // A removal keeps `user` intact (cursor-null is the whole signal), so the hue rides along and a
    // receiver never has to guess a colour for the peer it is retiring.
    expect(roundTrip(removalFanout).state.user.hue).toBe(137.508);
  });

  // `hue` is optional on purpose. Sync frames are untrusted input, and a mixed-version LAN (a 0.2.4
  // plugin joining an older relay, or a development build mid-rollout) legitimately emits presence
  // states without one - that must stay a valid message the client can render from its local
  // fallback, not a parse-level break.
  it("round-trips a presence state that carries no hue", () => {
    const withoutHue: SyncServerMessage = {
      type: "remote_presence",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 3,
      state: {
        clientId: 43,
        user: { userId: "usr_legacy", displayName: "Legacy" },
        cursor
      }
    };

    expect(roundTrip(withoutHue)).toEqual(withoutHue);
    expect(roundTrip(withoutHue).state.user.hue).toBeUndefined();
  });

  it("carries relative positions through JSON unchanged (no live Y objects on the wire)", () => {
    const set: SyncClientMessage = {
      type: "presence_set",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 3,
      clientId: 42,
      cursor
    };

    // The shape Y.relativePositionToJSON emits is two numbers per ID plus an optional tname/assoc,
    // so it survives the transport byte-for-byte. If this ever needs a custom reviver, the adapter
    // boundary in crdtPresence.ts is wrong.
    expect(roundTrip(set).cursor).toEqual(cursor);
  });
});
