import type { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import type {
  PresenceCursor,
  PresenceRejected,
  PresenceSnapshot,
  RemotePresence,
  RemotePresenceState,
  SyncClientMessage
} from "@vault-rooms/protocol";

/**
 * Live cursors / note presence v1 (docs/superpowers/specs/2026-07-28-live-cursors-design.md).
 *
 * Supplies the minimum Awareness-shaped surface `y-codemirror.next@0.3.5` actually consumes, so the
 * mature remote-caret/selection renderer stays the source of editor behavior while identity, timers,
 * and lifecycle stay explicit and testable here. The renderer touches exactly six members
 * (`doc.clientID`, `getLocalState`, `setLocalStateField`, `getStates`, `on`/`off("change")`,
 * `destroy`) and types the argument `any`, so this is a duck type by design - `y-protocols` is not a
 * dependency and adding it would drag `lib0/observable` into the bundle for no product gain.
 *
 * Three details of that contract are load-bearing, and each fails *silently* if missed:
 *
 * 1. **The cursor format is asymmetric.** The renderer reads its own local state as JSON
 *    (`createRelativePositionFromJSON`) but consumes remote states as live `Y.RelativePosition`
 *    objects (`createAbsolutePositionFromRelativePosition`). So the local store keeps JSON and
 *    `getStates()` hands back rehydrated objects.
 * 2. **`getLocalState()` must never return `null`** - a null local state disables local cursor
 *    publishing entirely, so no cursor is ever advertised.
 * 3. **The `change` listener takes three positional arguments** and `.concat()`s all three of
 *    `{ added, updated, removed }`, so every notification must carry three arrays.
 *
 * Structural rule that is just as easy to regress: the adapter and its `ytext` must belong to one
 * *immutable* session/`Y.Doc` pair. `yCollab` captures both into a CodeMirror facet at
 * extension-build time, so a live getter onto "the current session" would let `awareness.doc` drift
 * ahead of `conf.ytext` - and the local peer's own caret would then render as a remote one. When an
 * epoch bump or recovery replaces the `Y.Doc`, the whole binding is rebuilt instead.
 */

export type AwarenessChange = {
  added: number[];
  updated: number[];
  removed: number[];
};

export type AwarenessListener = (change: AwarenessChange, origin: unknown, adapter: CrdtPresenceAdapter) => void;

/** The shape `y-codemirror.next` reads out of `getStates()`. `cursor` holds *live* relative positions. */
export type PresenceRenderState = {
  user: { name: string; color: string; colorLight: string };
  cursor: { anchor: Y.RelativePosition; head: Y.RelativePosition } | null;
};

export interface CrdtPresenceAdapter {
  readonly doc: Y.Doc;
  getLocalState(): { cursor: LocalCursorJson | null };
  setLocalStateField(field: string, value: unknown): void;
  getStates(): Map<number, PresenceRenderState>;
  on(event: "change", listener: AwarenessListener): void;
  off(event: "change", listener: AwarenessListener): void;
  destroy(): void;
}

/** JSON form of a selection, as stored locally and as it crosses the wire. */
type LocalCursorJson = { anchor: unknown; head: unknown };

const COALESCE_MS = 50;
/** Kept in sync with styles.css's `--vault-rooms-presence-N` palette. */
const PALETTE_SIZE = 8;

/**
 * Deterministic, theme-aware color for a user. Derived from the *authoritative* `userId` only - never
 * the display name (changes), the device (one human can have several), or `clientId` (regenerated on
 * every Y.Doc). Color is a cosmetic grouping signal, never an identity or authorization one.
 *
 * Returns CSS expressions rather than resolved colors: `y-codemirror.next` injects these inline, so
 * referencing the palette variables directly is what makes the caret theme-aware without CSS having
 * to fight an inline attribute. `colorLight` is supplied explicitly because the renderer's fallback
 * is string concatenation (`color + '33'`), which produces garbage for a non-hex value.
 */
export function presenceColor(userId: string): { color: string; colorLight: string } {
  const variable = `var(--vault-rooms-presence-${stableHash(userId) % PALETTE_SIZE})`;
  return { color: variable, colorLight: `color-mix(in srgb, ${variable} 22%, transparent)` };
}

/** FNV-1a, 32-bit. Stable across processes and runs, unlike anything seeded per session. */
function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function toWireCursor(cursor: LocalCursorJson): PresenceCursor {
  return { yanchor: cursor.anchor, yhead: cursor.head };
}

/** Rehydrates a wire cursor into the live objects the renderer needs. Returns null for anything that
 *  doesn't convert, so a malformed remote state is skipped rather than throwing mid-render. */
function toRenderCursor(cursor: PresenceCursor | null): PresenceRenderState["cursor"] {
  if (!cursor || cursor.yanchor === null || cursor.yhead === null) return null;
  try {
    const anchor = Y.createRelativePositionFromJSON(cursor.yanchor);
    const head = Y.createRelativePositionFromJSON(cursor.yhead);
    if (!isAnchored(anchor) || !isAnchored(head)) return null;
    return { anchor, head };
  } catch {
    return null;
  }
}

/**
 * `createRelativePositionFromJSON` does **not** throw on garbage - it reads `json.type`/`tname`/`item`
 * off whatever it is given, so a string or an empty object yields a RelativePosition with all three
 * null. That resolves to no absolute position at all, which the renderer would silently skip, but it
 * should never reach `getStates()` in the first place. A try/catch alone does not cover this.
 */
function isAnchored(position: Y.RelativePosition): boolean {
  return position.item !== null || position.tname !== null || position.type !== null;
}

export type CrdtPresenceSessionInput = {
  doc: Y.Doc;
  roomId: string;
  relativePath: string;
  epoch: number;
  send: (message: SyncClientMessage) => boolean | void;
  /** Injected rather than reaching for a global: plugin code must use `window.setTimeout` for
   *  popout-window compatibility, and tests need a deterministic clock. */
  schedule?: (callback: () => void, delayMs: number) => number;
  cancel?: (handle: number) => void;
};

/**
 * One presence session per CRDT document session, owning the remote states and the outbound
 * coalescing timer. Each bound editor view gets its own lightweight facade over this, because N panes
 * share one session and one `Y.Doc` - the existing `boundToEditor` boolean already had to be
 * refcounted by hand for exactly this reason, so per-view state is a map here from the start.
 */
export class CrdtPresenceSession {
  private readonly doc: Y.Doc;
  private readonly roomId: string;
  private relativePath: string;
  private epoch: number;
  private readonly send: (message: SyncClientMessage) => boolean | void;
  private readonly schedule: (callback: () => void, delayMs: number) => number;
  private readonly cancel: (handle: number) => void;

  /** Per-view local selection plus a monotonic recency counter, so the most recently moved pane wins
   *  and closing it can fall back to whichever pane is still open. */
  private readonly views = new Map<EditorView, { cursor: LocalCursorJson | null; order: number }>();
  private order = 0;
  private readonly remote = new Map<number, RemotePresenceState>();
  private readonly listeners = new Set<AwarenessListener>();
  private readonly facades = new Map<EditorView, CrdtPresenceAdapter>();

  /** What the relay currently believes, so a steady selection produces no traffic at all and a
   *  retraction is only sent when something was actually published. */
  private published: LocalCursorJson | null = null;
  private publishedClientId: number | null = null;
  private pendingTimer: number | null = null;
  private transportReady = false;
  private destroyed = false;

  constructor(input: CrdtPresenceSessionInput) {
    this.doc = input.doc;
    this.roomId = input.roomId;
    this.relativePath = input.relativePath;
    this.epoch = input.epoch;
    this.send = input.send;
    this.schedule = input.schedule ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
    this.cancel = input.cancel ?? ((handle) => window.clearTimeout(handle));
  }

  /** Builds the Awareness-shaped facade for one editor view. Safe to call repeatedly for the same
   *  view - the same facade is returned, so a re-bind never orphans a listener. */
  attachView(view: EditorView): CrdtPresenceAdapter {
    const existing = this.facades.get(view);
    if (existing) return existing;
    if (!this.views.has(view)) {
      this.views.set(view, { cursor: null, order: 0 });
    }

    const session = this;
    const facade: CrdtPresenceAdapter = {
      // Captured, never a live getter - see the class doc comment.
      get doc() {
        return session.doc;
      },
      getLocalState() {
        // Must be non-null or the renderer never publishes a local cursor at all.
        return { cursor: session.views.get(view)?.cursor ?? null };
      },
      setLocalStateField(field: string, value: unknown) {
        if (field !== "cursor") return;
        session.setViewCursor(view, value);
      },
      getStates() {
        return session.renderStates();
      },
      on(event: "change", listener: AwarenessListener) {
        if (event === "change") session.listeners.add(listener);
      },
      off(event: "change", listener: AwarenessListener) {
        if (event === "change") session.listeners.delete(listener);
      },
      destroy() {
        session.detachView(view);
      }
    };
    this.facades.set(view, facade);
    return facade;
  }

  /** Drops one pane. Presence survives while any other pane for this session is still bound; only the
   *  last one retracts. */
  detachView(view: EditorView): void {
    this.facades.delete(view);
    const had = this.views.delete(view);
    if (!had) return;
    if (this.views.size === 0) {
      this.retract();
      return;
    }
    this.publishLatest();
  }

  applySnapshot(message: PresenceSnapshot): void {
    if (!this.matches(message.relativePath, message.epoch)) return;
    const added: number[] = [];
    for (const state of message.states) {
      if (state.clientId === this.doc.clientID) continue;
      this.remote.set(state.clientId, state);
      added.push(state.clientId);
    }
    if (added.length > 0) this.emit({ added, updated: [], removed: [] });
  }

  applyRemote(message: RemotePresence): void {
    if (!this.matches(message.relativePath, message.epoch)) return;
    const state = message.state;
    // The relay never echoes our own state back, but a stale frame after a clientID change could
    // still name it - dropping it here keeps the renderer from drawing our caret twice.
    if (state.clientId === this.doc.clientID) return;
    if (state.cursor === null) {
      if (!this.remote.delete(state.clientId)) return;
      this.emit({ added: [], updated: [], removed: [state.clientId] });
      return;
    }
    const existed = this.remote.has(state.clientId);
    this.remote.set(state.clientId, state);
    this.emit(existed ? { added: [], updated: [state.clientId], removed: [] } : { added: [state.clientId], updated: [], removed: [] });
  }

  /**
   * A rejection is diagnostic, never an edit failure. It clears the local view of remote presence for
   * this target and stops re-announcing until the transport is confirmed ready again, so a revoked
   * path or stale epoch cannot spin on retries.
   */
  reject(message: PresenceRejected): void {
    if (message.relativePath !== this.relativePath) return;
    this.transportReady = false;
    this.published = null;
    this.publishedClientId = null;
    this.clearRemote();
  }

  /**
   * Gated on the CRDT handshake, not merely on `hello_ok`: announcing before the session has synced
   * would advertise a caret against a document the server may be about to replace at a new epoch.
   */
  setTransportReady(ready: boolean): void {
    if (this.destroyed || ready === this.transportReady) return;
    this.transportReady = ready;
    if (!ready) {
      // Socket loss: forget what the relay knew and drop peers' carets, but keep each pane's local
      // selection so reconnecting re-announces where the user actually is.
      this.published = null;
      this.publishedClientId = null;
      this.cancelPending();
      this.clearRemote();
      return;
    }
    this.publishLatest();
  }

  /** Follows a rename onto the new path. The old path's state is retracted by the relay as part of the
   *  rename, and this side stays quiet until the new path's handshake completes. */
  rekey(relativePath: string, epoch: number): void {
    if (this.relativePath === relativePath && this.epoch === epoch) return;
    this.transportReady = false;
    this.cancelPending();
    this.published = null;
    this.publishedClientId = null;
    this.relativePath = relativePath;
    this.epoch = epoch;
    this.clearRemote();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.retract();
    this.destroyed = true;
    this.cancelPending();
    this.views.clear();
    this.facades.clear();
    this.clearRemote();
    this.listeners.clear();
  }

  private matches(relativePath: string, epoch: number): boolean {
    return !this.destroyed && relativePath === this.relativePath && epoch === this.epoch;
  }

  private setViewCursor(view: EditorView, value: unknown): void {
    if (this.destroyed) return;
    const cursor = normalizeLocalCursor(value);
    this.order += 1;
    this.views.set(view, { cursor, order: this.order });
    this.schedulePublish();
  }

  /** The most recently moved pane's selection is the one advertised. */
  private latestCursor(): LocalCursorJson | null {
    let best: { cursor: LocalCursorJson | null; order: number } | undefined;
    for (const entry of this.views.values()) {
      if (!best || entry.order > best.order) best = entry;
    }
    return best?.cursor ?? null;
  }

  private schedulePublish(): void {
    if (this.pendingTimer !== null) return;
    // Trailing-edge coalescing: a drag or a held arrow key emits one send per window rather than one
    // per selection change.
    this.pendingTimer = this.schedule(() => {
      this.pendingTimer = null;
      this.publishLatest();
    }, COALESCE_MS);
  }

  private cancelPending(): void {
    if (this.pendingTimer === null) return;
    this.cancel(this.pendingTimer);
    this.pendingTimer = null;
  }

  private publishLatest(): void {
    if (this.destroyed || !this.transportReady) return;
    const cursor = this.latestCursor();
    if (cursor === null) {
      this.retract();
      return;
    }
    const clientId = this.doc.clientID;
    // No idle traffic: an unchanged selection under an unchanged renderer key sends nothing.
    if (this.publishedClientId === clientId && sameCursor(this.published, cursor)) return;
    const sent = this.send({
      type: "presence_set",
      roomId: this.roomId,
      relativePath: this.relativePath,
      epoch: this.epoch,
      clientId,
      cursor: toWireCursor(cursor)
    });
    if (sent === false) return;
    this.published = cursor;
    this.publishedClientId = clientId;
  }

  /** Sends exactly one removal, and only when something was actually published. */
  private retract(): void {
    this.cancelPending();
    if (this.publishedClientId === null) return;
    const clientId = this.publishedClientId;
    this.published = null;
    this.publishedClientId = null;
    if (!this.transportReady) return;
    this.send({
      type: "presence_set",
      roomId: this.roomId,
      relativePath: this.relativePath,
      epoch: this.epoch,
      clientId,
      cursor: null
    });
  }

  private clearRemote(): void {
    if (this.remote.size === 0) return;
    const removed = [...this.remote.keys()];
    this.remote.clear();
    this.emit({ added: [], updated: [], removed });
  }

  private renderStates(): Map<number, PresenceRenderState> {
    const states = new Map<number, PresenceRenderState>();
    for (const [clientId, state] of this.remote) {
      const cursor = toRenderCursor(state.cursor);
      if (!cursor) continue;
      const { color, colorLight } = presenceColor(state.user.userId);
      states.set(clientId, { user: { name: state.user.displayName, color, colorLight }, cursor });
    }
    return states;
  }

  private emit(change: AwarenessChange): void {
    for (const listener of [...this.listeners]) {
      // One misbehaving renderer plugin must not stop the others from being notified.
      try {
        listener(change, "presence", this.facades.values().next().value as CrdtPresenceAdapter);
      } catch (error) {
        console.error("Vault Rooms: a presence listener threw", error);
      }
    }
  }
}

/** `setLocalStateField("cursor", …)` hands us live relative positions; the wire and the renderer's own
 *  local-state reader both want JSON, so serialize once here at the boundary. */
function normalizeLocalCursor(value: unknown): LocalCursorJson | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as { anchor?: unknown; head?: unknown };
  if (candidate.anchor === undefined || candidate.head === undefined) return null;
  try {
    return {
      anchor: Y.relativePositionToJSON(candidate.anchor as Y.RelativePosition),
      head: Y.relativePositionToJSON(candidate.head as Y.RelativePosition)
    };
  } catch {
    return null;
  }
}

function sameCursor(a: LocalCursorJson | null, b: LocalCursorJson | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(a.anchor) === JSON.stringify(b.anchor) && JSON.stringify(a.head) === JSON.stringify(b.head);
}
