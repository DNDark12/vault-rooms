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

  // Room-session hue leases (docs/superpowers/plans/2026-07-28-room-session-presence-colors.md).
  // The relay owns colour assignment because a client-side hash cannot be made consistent: two
  // userIds landing in one slot look identical on one screen and distinct on another. A lease is
  // keyed by (roomId, userId), so one human with several devices is one colour, and the lease is
  // released only when their last connection for that room goes away.
  it("assigns distinct hues to distinct live users in one room", () => {
    const registry = new PresenceRegistry(() => 0);
    const alice = registry.joinRoom(connection(), "room_1", "usr_alice");
    const bob = registry.joinRoom(connection(), "room_1", "usr_bob");

    expect(alice).toBeGreaterThanOrEqual(0);
    expect(alice).toBeLessThan(360);
    expect(bob).toBeGreaterThanOrEqual(0);
    expect(bob).toBeLessThan(360);
    expect(bob).not.toBe(alice);
  });

  it("shares one hue across devices until the final connection leaves", () => {
    const randomValues = [0, 0.5];
    const registry = new PresenceRegistry(() => randomValues.shift() ?? 0);
    const laptop = connection();
    const desktop = connection();
    const replacement = connection();

    const first = registry.joinRoom(laptop, "room_1", "usr_alice");
    expect(registry.joinRoom(desktop, "room_1", "usr_alice")).toBe(first);

    registry.removeConnectionRoom(laptop, "room_1");
    expect(registry.joinRoom(replacement, "room_1", "usr_alice")).toBe(first);

    registry.removeConnectionRoom(desktop, "room_1");
    registry.removeConnectionRoom(replacement, "room_1");
    // Every connection gone means the whole room session ended, so the next one starts from a fresh
    // random hue rather than resurrecting the old assignment.
    expect(registry.joinRoom(connection(), "room_1", "usr_alice")).not.toBe(first);
  });

  it("is idempotent for one connection and room", () => {
    const registry = new PresenceRegistry(() => 0);
    const a = connection();

    const first = registry.joinRoom(a, "room_1", "usr_a");

    // Re-subscribing (reconnect, ACL refresh) must not consume a second slot or hand back a
    // different colour for the same live connection.
    expect(registry.joinRoom(a, "room_1", "usr_a")).toBe(first);
    expect(registry.joinRoom(a, "room_1", "usr_a")).toBe(first);
  });

  it("stamps the leased hue into document presence", () => {
    const registry = new PresenceRegistry(() => 0);
    const a = connection();
    const hue = registry.joinRoom(a, "room_1", "usr_a");

    expect(registry.set(a, target, input(7, "usr_a")).current.state.user.hue).toBe(hue);
  });

  it("allocates a hue from set() even when the subscribe hook never ran", () => {
    const registry = new PresenceRegistry(() => 0);
    const a = connection();

    // set() is the authoritative allocation boundary: the subscribe hook only fixes ordering, so a
    // lifecycle path that reaches set() without it must still produce a valid hue.
    const hue = registry.set(a, target, input(7, "usr_a")).current.state.user.hue;

    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });

  it("never hands two live users the same hue", () => {
    // Twelve users is past the eight-slot ceiling the retired client-side palette wrapped at, which
    // is the collision this whole mechanism exists to remove. The allocator must never return a slot
    // that is already leased, whatever the golden-angle stride lands on.
    const registry = new PresenceRegistry(() => 0);
    const hues = new Set<number>();
    for (let index = 0; index < 12; index += 1) {
      hues.add(registry.joinRoom(connection(), "room_1", `usr_${index}`));
    }

    expect(hues.size).toBe(12);
  });

  it("drops hue leases after room-level access revalidation removes the subscription", () => {
    const randomValues = [0, 0.5];
    const registry = new PresenceRegistry(() => randomValues.shift() ?? 0);
    const a = connection();
    const first = registry.joinRoom(a, "room_1", "usr_a");

    // revalidateRoomAccess drops connection.subscriptions directly, without telling presence - this
    // sweep is what keeps a lease from outliving the access that justified it.
    a.subscriptions.delete("room_1");
    registry.removeUnsubscribedRoomHues();

    expect(registry.joinRoom(connection(), "room_1", "usr_a")).not.toBe(first);
  });

  it("releases hue leases when a connection or room goes away entirely", () => {
    const randomValues = [0, 0.5, 0.25];
    const registry = new PresenceRegistry(() => randomValues.shift() ?? 0);
    const a = connection();
    const first = registry.joinRoom(a, "room_1", "usr_a");

    registry.removeConnection(a);
    const second = registry.joinRoom(connection(), "room_1", "usr_a");
    expect(second).not.toBe(first);

    registry.removeRoom("room_1");
    expect(registry.joinRoom(connection(), "room_1", "usr_a")).not.toBe(second);
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
