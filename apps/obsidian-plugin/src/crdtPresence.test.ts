import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { EditorView } from "@codemirror/view";
import type { SyncClientMessage } from "@vault-rooms/protocol";
import { CrdtPresenceSession, presenceColor } from "./crdtPresence.js";

// Live cursors / note presence v1 (docs/superpowers/specs/2026-07-28-live-cursors-design.md).
// Pins the exact `y-codemirror.next@0.3.5` Awareness contract this adapter has to satisfy - every one
// of these fails *silently* in a real editor if regressed, which is why they are asserted directly
// rather than only through the editor-binding tests.

type Sent = Extract<SyncClientMessage, { type: "presence_set" }>;

/** Deterministic clock: presence coalescing must be provable, not timing-dependent. */
class FakeClock {
  private nextHandle = 1;
  private readonly pending = new Map<number, () => void>();

  readonly schedule = (callback: () => void): number => {
    const handle = this.nextHandle++;
    this.pending.set(handle, callback);
    return handle;
  };

  readonly cancel = (handle: number): void => {
    this.pending.delete(handle);
  };

  flush(): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) callback();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

function setup(options: { relativePath?: string; epoch?: number } = {}) {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, "hello world");
  const sent: Sent[] = [];
  const clock = new FakeClock();
  const session = new CrdtPresenceSession({
    doc,
    roomId: "room_1",
    relativePath: options.relativePath ?? "Board.md",
    epoch: options.epoch ?? 3,
    send: (message) => {
      sent.push(message as Sent);
      return true;
    },
    schedule: clock.schedule,
    cancel: clock.cancel
  });
  return { doc, ytext, sent, clock, session };
}

/** Views are only ever used as map keys here, so an opaque token is enough. */
function view(name: string): EditorView {
  return { name } as unknown as EditorView;
}

function selection(ytext: Y.Text, from: number, to: number) {
  return {
    anchor: Y.createRelativePositionFromTypeIndex(ytext, from),
    head: Y.createRelativePositionFromTypeIndex(ytext, to)
  };
}

function remoteState(clientId: number, ytext: Y.Text, from: number, to: number, userId = "usr_a", displayName = "Alice") {
  const { anchor, head } = selection(ytext, from, to);
  return {
    clientId,
    user: { userId, displayName },
    cursor: { yanchor: Y.relativePositionToJSON(anchor), yhead: Y.relativePositionToJSON(head) }
  };
}

describe("CrdtPresenceSession adapter contract", () => {
  it("returns a non-null local state before any selection exists", () => {
    const { session } = setup();
    const adapter = session.attachView(view("a"));

    // A null local state makes y-codemirror.next skip local cursor publishing entirely, so no caret
    // would ever be advertised.
    expect(adapter.getLocalState()).not.toBeNull();
    expect(adapter.getLocalState().cursor).toBeNull();
  });

  it("serializes live RelativePosition values onto the wire as JSON", () => {
    const { ytext, sent, clock, session } = setup();
    const adapter = session.attachView(view("a"));
    session.setTransportReady(true);

    const { anchor, head } = selection(ytext, 2, 6);
    adapter.setLocalStateField("cursor", { anchor, head });
    clock.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.cursor).toEqual({
      yanchor: Y.relativePositionToJSON(anchor),
      yhead: Y.relativePositionToJSON(head)
    });
    // Round-trips: what the peer rehydrates must resolve back to the same index.
    const rehydrated = Y.createRelativePositionFromJSON(sent[0]!.cursor!.yanchor);
    expect(Y.createAbsolutePositionFromRelativePosition(rehydrated, ytext.doc!)?.index).toBe(2);
  });

  it("stores the local cursor as JSON, matching the renderer's own local read path", () => {
    const { ytext, session } = setup();
    const adapter = session.attachView(view("a"));

    const { anchor, head } = selection(ytext, 1, 4);
    adapter.setLocalStateField("cursor", { anchor, head });

    // y-codemirror.next calls createRelativePositionFromJSON on its *own* local state, so storing
    // live objects here would throw inside the renderer's update loop.
    const stored = adapter.getLocalState().cursor!;
    expect(() => Y.createRelativePositionFromJSON(stored.anchor)).not.toThrow();
    expect(stored.anchor).toEqual(Y.relativePositionToJSON(anchor));
  });

  it("rehydrates wire cursors into live RelativePositions before exposing remote states", () => {
    const { ytext, doc, session } = setup();
    const adapter = session.attachView(view("a"));

    session.applyRemote({
      type: "remote_presence",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 3,
      state: remoteState(99, ytext, 3, 8)
    });

    const state = adapter.getStates().get(99)!;
    // The renderer passes these straight to createAbsolutePositionFromRelativePosition, so raw JSON
    // here would render nothing at all.
    expect(Y.createAbsolutePositionFromRelativePosition(state.cursor!.anchor, doc)?.index).toBe(3);
    expect(Y.createAbsolutePositionFromRelativePosition(state.cursor!.head, doc)?.index).toBe(8);
    expect(state.user.name).toBe("Alice");
  });

  it("skips a remote cursor whose relative position cannot be rehydrated", () => {
    const { session } = setup();
    const adapter = session.attachView(view("a"));

    session.applyRemote({
      type: "remote_presence",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 3,
      state: { clientId: 99, user: { userId: "usr_a", displayName: "Alice" }, cursor: { yanchor: "nope", yhead: 7 } }
    });

    // Skipped, not thrown: a malformed peer must never break the local render pass or touch content.
    expect(adapter.getStates().size).toBe(0);
  });

  it("calls change listeners with three positional arguments and three arrays", () => {
    const { ytext, session } = setup();
    const adapter = session.attachView(view("a"));
    const calls: Array<{ change: unknown; origin: unknown; argCount: number }> = [];
    adapter.on("change", (change, origin, self) => {
      calls.push({ change, origin, argCount: [change, origin, self].filter((value) => value !== undefined).length });
    });

    session.applyRemote({
      type: "remote_presence",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 3,
      state: remoteState(99, ytext, 1, 2)
    });

    expect(calls).toHaveLength(1);
    // The renderer destructures { added, updated, removed } and .concat()s all three - any of them
    // being undefined throws inside its listener.
    expect(calls[0]!.change).toEqual({ added: [99], updated: [], removed: [] });
    expect(calls[0]!.argCount).toBe(3);
    expect(Array.isArray((calls[0]!.change as { updated: unknown }).updated)).toBe(true);
  });

  it("reports added, updated, and removed client IDs accurately", () => {
    const { ytext, session } = setup();
    const adapter = session.attachView(view("a"));
    const changes: unknown[] = [];
    adapter.on("change", (change) => changes.push(change));

    const envelope = { type: "remote_presence" as const, roomId: "room_1", relativePath: "Board.md", epoch: 3 };
    session.applyRemote({ ...envelope, state: remoteState(99, ytext, 1, 2) });
    session.applyRemote({ ...envelope, state: remoteState(99, ytext, 4, 5) });
    session.applyRemote({
      ...envelope,
      state: { clientId: 99, user: { userId: "usr_a", displayName: "Alice" }, cursor: null }
    });
    // Already gone - must not emit a second removal.
    session.applyRemote({
      ...envelope,
      state: { clientId: 99, user: { userId: "usr_a", displayName: "Alice" }, cursor: null }
    });

    expect(changes).toEqual([
      { added: [99], updated: [], removed: [] },
      { added: [], updated: [99], removed: [] },
      { added: [], updated: [], removed: [99] }
    ]);
  });

  it("ignores presence for another path or epoch", () => {
    const { ytext, session } = setup();
    const adapter = session.attachView(view("a"));

    session.applyRemote({
      type: "remote_presence",
      roomId: "room_1",
      relativePath: "Other.md",
      epoch: 3,
      state: remoteState(99, ytext, 1, 2)
    });
    session.applyRemote({
      type: "remote_presence",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 4,
      state: remoteState(98, ytext, 1, 2)
    });

    expect(adapter.getStates().size).toBe(0);
  });

  it("never renders its own clientID as a remote peer", () => {
    const { ytext, doc, session } = setup();
    const adapter = session.attachView(view("a"));

    session.applySnapshot({
      type: "presence_snapshot",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 3,
      states: [remoteState(doc.clientID, ytext, 1, 2), remoteState(77, ytext, 3, 4)]
    });

    expect([...adapter.getStates().keys()]).toEqual([77]);
  });

  it("coalesces local movement to one send per window", () => {
    const { ytext, sent, clock, session } = setup();
    const adapter = session.attachView(view("a"));
    session.setTransportReady(true);

    for (let index = 0; index < 5; index += 1) {
      adapter.setLocalStateField("cursor", selection(ytext, index, index + 1));
    }
    expect(sent).toHaveLength(0);
    clock.flush();

    // Only the final selection of the window is advertised.
    expect(sent).toHaveLength(1);
    expect(Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(sent[0]!.cursor!.yanchor), ytext.doc!)?.index).toBe(4);
  });

  it("sends no traffic while the selection is steady", () => {
    const { ytext, sent, clock, session } = setup();
    const adapter = session.attachView(view("a"));
    session.setTransportReady(true);
    const steady = selection(ytext, 2, 5);

    adapter.setLocalStateField("cursor", steady);
    clock.flush();
    expect(sent).toHaveLength(1);

    // The renderer re-reports the same selection on every editor update; re-advertising it would be
    // exactly the idle traffic the design forbids.
    for (let index = 0; index < 4; index += 1) {
      adapter.setLocalStateField("cursor", selection(ytext, 2, 5));
      clock.flush();
    }
    expect(sent).toHaveLength(1);
    expect(clock.pendingCount).toBe(0);
  });

  it("ignores fields other than cursor", () => {
    const { sent, clock, session } = setup();
    const adapter = session.attachView(view("a"));
    session.setTransportReady(true);

    adapter.setLocalStateField("user", { name: "Impostor" });
    clock.flush();

    // Identity is the relay's to stamp; the adapter forwards only the cursor field.
    expect(sent).toHaveLength(0);
  });

  it("retains local selection while disconnected but clears remote decorations", () => {
    const { ytext, sent, clock, session } = setup();
    const adapter = session.attachView(view("a"));
    session.setTransportReady(true);
    adapter.setLocalStateField("cursor", selection(ytext, 1, 3));
    clock.flush();
    session.applyRemote({
      type: "remote_presence",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 3,
      state: remoteState(99, ytext, 5, 6)
    });
    sent.length = 0;

    session.setTransportReady(false);

    // Peers' carets go (they may be gone by the time we return), but the local selection is kept so
    // reconnect re-announces where the user actually is. No traffic on a dead socket.
    expect(adapter.getStates().size).toBe(0);
    expect(adapter.getLocalState().cursor).not.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("re-announces the retained selection only after the transport is ready again", () => {
    const { ytext, sent, clock, session } = setup();
    const adapter = session.attachView(view("a"));
    session.setTransportReady(true);
    adapter.setLocalStateField("cursor", selection(ytext, 1, 3));
    clock.flush();
    session.setTransportReady(false);
    sent.length = 0;

    // Movement while offline must not be sent.
    adapter.setLocalStateField("cursor", selection(ytext, 4, 7));
    clock.flush();
    expect(sent).toHaveLength(0);

    session.setTransportReady(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.cursor).not.toBeNull();
  });

  it("advertises the most recently moved pane and falls back when it closes", () => {
    const { ytext, sent, clock, session } = setup();
    const first = view("first");
    const second = view("second");
    const adapterA = session.attachView(first);
    const adapterB = session.attachView(second);
    session.setTransportReady(true);

    adapterA.setLocalStateField("cursor", selection(ytext, 1, 2));
    clock.flush();
    adapterB.setLocalStateField("cursor", selection(ytext, 6, 8));
    clock.flush();
    expect(sent).toHaveLength(2);
    const indexOf = (message: Sent): number | undefined =>
      Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(message.cursor!.yanchor), ytext.doc!)?.index;
    expect(indexOf(sent[1]!)).toBe(6);

    // Closing the pane that moved last falls back to the surviving pane's selection rather than
    // retracting - the note is still open.
    session.detachView(second);
    expect(sent).toHaveLength(3);
    expect(sent[2]!.cursor).not.toBeNull();
    expect(indexOf(sent[2]!)).toBe(1);
  });

  it("sends exactly one removal when the final pane closes", () => {
    const { ytext, sent, clock, session } = setup();
    const first = view("first");
    const second = view("second");
    const adapterA = session.attachView(first);
    const adapterB = session.attachView(second);
    session.setTransportReady(true);
    // Both panes carry a selection, as two panes showing the same note do once each has been focused.
    adapterA.setLocalStateField("cursor", selection(ytext, 1, 2));
    clock.flush();
    adapterB.setLocalStateField("cursor", selection(ytext, 5, 6));
    clock.flush();
    sent.length = 0;

    // Closing one pane keeps presence alive - it falls back to the pane still bound.
    session.detachView(first);
    expect(sent.filter((message) => message.cursor === null)).toHaveLength(0);

    session.detachView(second);
    const removals = sent.filter((message) => message.cursor === null);
    expect(removals).toHaveLength(1);
    expect(removals[0]!.clientId).toBeTypeOf("number");
  });

  it("retracts when the surviving pane has no selection of its own", () => {
    const { ytext, sent, clock, session } = setup();
    const focused = view("focused");
    const background = view("background");
    const adapter = session.attachView(focused);
    session.attachView(background);
    session.setTransportReady(true);
    adapter.setLocalStateField("cursor", selection(ytext, 1, 2));
    clock.flush();
    sent.length = 0;

    // y-codemirror.next only publishes a cursor for a *focused* view, so an unfocused background pane
    // legitimately holds none. Closing the focused pane then leaves nothing to advertise, and the
    // caret has to come down rather than freeze at its last position.
    session.detachView(focused);

    expect(sent.filter((message) => message.cursor === null)).toHaveLength(1);
  });

  it("does not send a removal when nothing was ever published", () => {
    const { sent, session } = setup();
    session.attachView(view("a"));
    session.setTransportReady(true);

    session.destroy();

    expect(sent).toHaveLength(0);
  });

  it("destroy is idempotent, sends one removal, and persists nothing", () => {
    const { ytext, sent, clock, session } = setup();
    const adapter = session.attachView(view("a"));
    session.setTransportReady(true);
    adapter.setLocalStateField("cursor", selection(ytext, 1, 2));
    clock.flush();
    sent.length = 0;

    session.destroy();
    session.destroy();

    expect(sent.filter((message) => message.cursor === null)).toHaveLength(1);
    expect(adapter.getStates().size).toBe(0);
  });

  it("stops publishing after a rejection until the transport is confirmed again", () => {
    const { ytext, sent, clock, session } = setup();
    const adapter = session.attachView(view("a"));
    session.setTransportReady(true);
    adapter.setLocalStateField("cursor", selection(ytext, 1, 2));
    clock.flush();
    session.applyRemote({
      type: "remote_presence",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 3,
      state: remoteState(99, ytext, 4, 5)
    });
    sent.length = 0;

    session.reject({
      type: "presence_rejected",
      roomId: "room_1",
      relativePath: "Board.md",
      code: "PERMISSION_DENIED",
      message: "no"
    });

    // Decorations clear immediately, and further movement does not retry into a closed door.
    expect(adapter.getStates().size).toBe(0);
    adapter.setLocalStateField("cursor", selection(ytext, 7, 9));
    clock.flush();
    expect(sent).toHaveLength(0);
  });

  it("rekeys onto a renamed path and announces only after readiness returns", () => {
    const { ytext, sent, clock, session } = setup();
    const adapter = session.attachView(view("a"));
    session.setTransportReady(true);
    adapter.setLocalStateField("cursor", selection(ytext, 1, 2));
    clock.flush();
    sent.length = 0;

    session.rekey("Renamed.md", 3);
    adapter.setLocalStateField("cursor", selection(ytext, 3, 4));
    clock.flush();
    // The relay clears the old path as part of the rename; this side stays quiet until its own
    // handshake for the new path completes.
    expect(sent).toHaveLength(0);

    session.setTransportReady(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.relativePath).toBe("Renamed.md");
  });

  it("drops presence for the old path after a rekey", () => {
    const { ytext, session } = setup();
    const adapter = session.attachView(view("a"));
    session.applyRemote({
      type: "remote_presence",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 3,
      state: remoteState(99, ytext, 1, 2)
    });
    expect(adapter.getStates().size).toBe(1);

    session.rekey("Renamed.md", 3);

    expect(adapter.getStates().size).toBe(0);
  });

  it("treats a dropped send as unpublished so the next attempt retries", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "hello world");
    const sent: Sent[] = [];
    let open = false;
    const clock = new FakeClock();
    const session = new CrdtPresenceSession({
      doc,
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 3,
      // RoomSyncSocket#send returns false when the socket wasn't open and the message was dropped.
      send: (message) => {
        if (!open) return false;
        sent.push(message as Sent);
        return true;
      },
      schedule: clock.schedule,
      cancel: clock.cancel
    });
    const adapter = session.attachView(view("a"));
    session.setTransportReady(true);

    adapter.setLocalStateField("cursor", selection(ytext, 1, 2));
    clock.flush();
    expect(sent).toHaveLength(0);

    open = true;
    adapter.setLocalStateField("cursor", selection(ytext, 1, 2));
    clock.flush();
    expect(sent).toHaveLength(1);
  });

  it("returns the same facade for a repeated attach of one view", () => {
    const { session } = setup();
    const target = view("a");

    expect(session.attachView(target)).toBe(session.attachView(target));
  });

  it("exposes the session Y.Doc so the renderer can filter its own cursor", () => {
    const { doc, session } = setup();

    // Captured, never a live getter: yCollab freezes (ytext, awareness) into one facet, so a doc that
    // could drift ahead of ytext would make the local caret render as a remote one.
    expect(session.attachView(view("a")).doc).toBe(doc);
  });
});

describe("presence diagnostics", () => {
  it("reports every link of the cursor path", () => {
    const { ytext, clock, session } = setup();
    const adapter = session.attachView(view("a"));

    // Before the handshake: bound but not advertising - the state a "why can't I see cursors" report
    // needs to be able to distinguish from "nobody else is here".
    expect(session.describe()).toMatchObject({
      transportReady: false,
      published: false,
      remotePeers: 0,
      boundPanes: 1,
      panesWithSelection: 0,
      destroyed: false
    });

    session.setTransportReady(true);
    adapter.setLocalStateField("cursor", selection(ytext, 1, 3));
    clock.flush();
    session.applyRemote({
      type: "remote_presence",
      roomId: "room_1",
      relativePath: "Board.md",
      epoch: 3,
      state: remoteState(99, ytext, 5, 6)
    });

    expect(session.describe()).toMatchObject({
      transportReady: true,
      published: true,
      remotePeers: 1,
      remoteNames: ["Alice"],
      panesWithSelection: 1
    });

    session.destroy();
    expect(session.describe()).toMatchObject({ destroyed: true, remotePeers: 0, boundPanes: 0 });
  });

  it("distinguishes a rejected session from a merely quiet one", () => {
    const { ytext, clock, session } = setup();
    const adapter = session.attachView(view("a"));
    session.setTransportReady(true);
    adapter.setLocalStateField("cursor", selection(ytext, 1, 3));
    clock.flush();

    session.reject({
      type: "presence_rejected",
      roomId: "room_1",
      relativePath: "Board.md",
      code: "PERMISSION_DENIED",
      message: "no"
    });

    // transportReady false while a session is open is the signal that separates "cursors are off" from
    // "cursors are on and you are alone".
    expect(session.describe()).toMatchObject({ transportReady: false, remotePeers: 0 });
  });
});

describe("presenceColor", () => {
  it("derives a stable, palette-bound color from the authoritative userId", () => {
    expect(presenceColor("usr_alice")).toEqual(presenceColor("usr_alice"));
    expect(presenceColor("usr_alice").color).toMatch(/^var\(--vault-rooms-presence-[0-7]\)$/);
    expect(presenceColor("usr_alice").colorLight).toContain("color-mix(");
  });

  it("supplies colorLight explicitly rather than relying on the renderer's hex fallback", () => {
    // y-codemirror.next falls back to `color + '33'`, which is meaningless for a var()/color-mix()
    // expression - so the adapter must always provide both.
    const { color, colorLight } = presenceColor("usr_bob");
    expect(colorLight).toContain(color);
    expect(colorLight).not.toBe(`${color}33`);
  });

  it("only ever names palette slots that styles.css actually defines", async () => {
    // The palette lives in CSS but is indexed from TS, so drift between PALETTE_SIZE and the number of
    // --vault-rooms-presence-N declarations would silently yield `var(--undefined-slot)` - a caret with
    // no color, in a build that typechecks and passes every other test.
    const fs = await import("node:fs");
    const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const declared = new Set([...css.matchAll(/--vault-rooms-presence-(\d+)\s*:/g)].map((match) => match[1]));
    expect(declared.size).toBeGreaterThan(0);

    const used = new Set(
      Array.from({ length: 512 }, (_unused, index) => presenceColor(`usr_${index}`).color).map(
        (color) => /presence-(\d+)\)/.exec(color)![1]
      )
    );
    for (const slot of used) {
      expect(declared, `slot ${slot} is used by presenceColor but not declared in styles.css`).toContain(slot);
    }
  });

  it("spreads users across the palette", () => {
    const slots = new Set(
      ["usr_a", "usr_b", "usr_c", "usr_d", "usr_e", "usr_f", "usr_g", "usr_h", "usr_i", "usr_j"].map(
        (userId) => presenceColor(userId).color
      )
    );
    expect(slots.size).toBeGreaterThan(1);
  });
});
