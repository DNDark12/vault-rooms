import { describe, expect, it } from "vitest";
import { AppError } from "@vault-rooms/protocol";
import { PresenceRegistry, type PresenceTarget } from "../src/sync/presenceRegistry.js";
import type { SyncConnection, SyncSocket } from "../src/sync/connectionRegistry.js";

// Live cursors / note presence v1 (docs/superpowers/specs/2026-07-28-live-cursors-design.md).
// PresenceRegistry is the pure, in-memory ownership layer: no sockets are written, no policy is
// evaluated, and nothing reaches RelayRepository/SQLite. Everything about *who may see what* lives
// in PresenceService; this file only pins the storage contract.
//
// The one non-obvious invariant: state is keyed by connection, but `clientId` must additionally be
// unique per document. Connection keying protects this registry (one connection can never overwrite
// another's entry), while clientId uniqueness protects the *renderer* - y-codemirror.next consumes
// getStates() as a Map<number, State>, so two peers sharing a live key collide downstream.

function socket(): SyncSocket {
  return {
    OPEN: 1,
    readyState: 1,
    send: () => undefined,
    close: () => undefined,
    ping: () => undefined
  };
}

let connectionSeq = 0;

function connection(): SyncConnection {
  connectionSeq += 1;
  return {
    id: `req_${connectionSeq}`,
    socket: socket(),
    principal: null,
    subscriptions: new Set(["room_1"]),
    capabilities: { crdt: true, presence: true }
  };
}

const target: PresenceTarget = { roomId: "room_1", relativePath: "Board.md", epoch: 3 };
const other: PresenceTarget = { roomId: "room_1", relativePath: "Other.md", epoch: 0 };

function cursor(index: number) {
  return {
    yanchor: { tname: "content", assoc: 0, item: { client: 1, clock: index } },
    yhead: { tname: "content", assoc: 0, item: { client: 1, clock: index } }
  };
}

function input(clientId: number, userId: string, index = 1) {
  return { clientId, cursor: cursor(index), userId, displayName: userId.toUpperCase() };
}

describe("PresenceRegistry", () => {
  it("stores at most one state per connection and document", () => {
    const registry = new PresenceRegistry();
    const a = connection();

    registry.set(a, target, input(7, "usr_a"));
    registry.set(a, target, input(7, "usr_a", 9));

    expect(registry.size()).toBe(1);
    expect(registry.get(a, target)?.state.cursor).toEqual(cursor(9));
  });

  it("returns a snapshot excluding the requesting connection", () => {
    const registry = new PresenceRegistry();
    const a = connection();
    const b = connection();
    const c = connection();

    registry.set(a, target, input(1, "usr_a"));
    registry.set(b, target, input(2, "usr_b"));
    const result = registry.set(c, target, input(3, "usr_c"));

    expect(result.snapshot.map((state) => state.clientId).sort()).toEqual([1, 2]);
    expect(result.firstForConnectionDocument).toBe(true);
  });

  it("replaces the same connection's changed clientId and returns the retired state", () => {
    const registry = new PresenceRegistry();
    const a = connection();

    registry.set(a, target, input(7, "usr_a"));
    const result = registry.set(a, target, input(8, "usr_a"));

    // The retired renderer key has to come back out so the service can broadcast an explicit
    // remove-old before add-new; otherwise peers keep rendering a caret for a Y.Doc that no longer
    // exists (this is the epoch-bump/recovery path, which replaces the Y.Doc and its clientID).
    expect(result.retired?.state.clientId).toBe(7);
    expect(result.current.state.clientId).toBe(8);
    expect(result.firstForConnectionDocument).toBe(false);
    expect(registry.size()).toBe(1);
  });

  it("rejects a clientId already live on another connection for the same document", () => {
    const registry = new PresenceRegistry();
    const a = connection();
    const b = connection();

    registry.set(a, target, input(7, "usr_a"));

    expect(() => registry.set(b, target, input(7, "usr_b"))).toThrowError(/renderer key is already live/i);
    expect(registry.size()).toBe(1);
  });

  it("allows the same numeric clientId on a different document", () => {
    const registry = new PresenceRegistry();
    const a = connection();
    const b = connection();

    registry.set(a, target, input(7, "usr_a"));
    registry.set(b, other, input(7, "usr_b"));

    expect(registry.size()).toBe(2);
  });

  it("removes one target idempotently", () => {
    const registry = new PresenceRegistry();
    const a = connection();

    registry.set(a, target, input(7, "usr_a"));

    expect(registry.remove(a, target)?.state.clientId).toBe(7);
    expect(registry.remove(a, target)).toBeNull();
    expect(registry.size()).toBe(0);
  });

  it("does not let a stale clientId removal delete a newer replacement state", () => {
    const registry = new PresenceRegistry();
    const a = connection();

    registry.set(a, target, input(7, "usr_a"));
    registry.set(a, target, input(8, "usr_a"));

    // A null presence_set from an adapter that has already been retired must not take out the
    // replacement session's state.
    expect(registry.remove(a, target, 7)).toBeNull();
    expect(registry.get(a, target)?.state.clientId).toBe(8);
    expect(registry.remove(a, target, 8)?.state.clientId).toBe(8);
  });

  it("removes every state for one connection", () => {
    const registry = new PresenceRegistry();
    const a = connection();
    const b = connection();

    registry.set(a, target, input(1, "usr_a"));
    registry.set(a, other, input(2, "usr_a"));
    registry.set(b, target, input(3, "usr_b"));

    const removed = registry.removeConnection(a);

    expect(removed.map((entry) => entry.state.clientId).sort()).toEqual([1, 2]);
    expect(registry.size()).toBe(1);
    expect(registry.removeConnection(a)).toEqual([]);
  });

  it("removes every state for one connection and room", () => {
    const registry = new PresenceRegistry();
    const a = connection();

    registry.set(a, target, input(1, "usr_a"));
    registry.set(a, { roomId: "room_2", relativePath: "Elsewhere.md", epoch: 0 }, input(2, "usr_a"));

    const removed = registry.removeConnectionRoom(a, "room_1");

    expect(removed.map((entry) => entry.state.clientId)).toEqual([1]);
    expect(registry.size()).toBe(1);
  });

  it("removes every state for a renamed or deleted document", () => {
    const registry = new PresenceRegistry();
    const a = connection();
    const b = connection();

    registry.set(a, target, input(1, "usr_a"));
    registry.set(b, target, input(2, "usr_b"));
    registry.set(a, other, input(3, "usr_a"));

    const removed = registry.removeDocument(target.roomId, target.relativePath, target.epoch);

    expect(removed.map((entry) => entry.state.clientId).sort()).toEqual([1, 2]);
    expect(registry.size()).toBe(1);
  });

  it("removes a document across every epoch when no epoch is supplied", () => {
    const registry = new PresenceRegistry();
    const a = connection();
    const b = connection();

    registry.set(a, target, input(1, "usr_a"));
    registry.set(b, { ...target, epoch: 4 }, input(2, "usr_b"));

    expect(registry.removeDocument(target.roomId, target.relativePath)).toHaveLength(2);
    expect(registry.size()).toBe(0);
  });

  it("removes every state in a room", () => {
    const registry = new PresenceRegistry();
    const a = connection();
    const b = connection();

    registry.set(a, target, input(1, "usr_a"));
    registry.set(b, other, input(2, "usr_b"));
    registry.set(a, { roomId: "room_2", relativePath: "Elsewhere.md", epoch: 0 }, input(3, "usr_a"));

    expect(registry.removeRoom("room_1")).toHaveLength(2);
    expect(registry.size()).toBe(1);
  });

  it("lists a document's live entries and every entry for revalidation sweeps", () => {
    const registry = new PresenceRegistry();
    const a = connection();
    const b = connection();

    registry.set(a, target, input(1, "usr_a"));
    registry.set(b, other, input(2, "usr_b"));

    expect(registry.listDocument(target).map((entry) => entry.state.clientId)).toEqual([1]);
    expect(registry.listAll()).toHaveLength(2);
  });

  it("throws a typed AppError for a renderer-key collision", () => {
    const registry = new PresenceRegistry();
    const a = connection();
    const b = connection();

    registry.set(a, target, input(7, "usr_a"));

    try {
      registry.set(b, target, input(7, "usr_b"));
      expect.unreachable("expected a collision");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).statusCode).toBe(409);
    }
  });

  it("never writes through RelayRepository or SQLite", async () => {
    // Structural guarantee rather than a mock assertion: the module must not import a repository,
    // a db adapter, or anything that could persist. Presence is ephemeral by contract - a restart
    // legitimately forgets every cursor.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/sync/presenceRegistry.ts", import.meta.url), "utf8")
    );

    expect(source).not.toMatch(/relayRepository|sqlJs|obsidianSqlJs|RelayDb|\bdurable\(/i);
    expect(source).not.toMatch(/^\s*import[^\n]*\b(db|repositories)\b/m);
  });
});
