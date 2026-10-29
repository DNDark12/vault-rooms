import * as Y from "yjs";
import { fromUtf8, isId, openEnvelope, sealPresence, utf8, type KeyPair, type PresenceEnvelope, type RoomReplica } from "@vault-rooms/secure";

/**
 * Cursors of other people in a room's notes. A cursor travels as a presence envelope: encrypted with the room key,
 * signed by its device and never stored. Who it belongs to comes from the verified signature (device -> user ->
 * name), never from the message itself; colours are computed here from the user id, never taken from the wire,
 * because y-codemirror puts them into an inline style.
 */

export type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };
type Listener = (change: AwarenessChange, origin: unknown) => void;
type LiveCursor = { anchor: Y.RelativePosition; head: Y.RelativePosition };

export interface RenderState {
  user: { name: string; color: string; colorLight: string };
  cursor: LiveCursor | null;
}

interface Remote extends RenderState {
  at: number;
}

const STALE_MS = 30_000;
const RESEND_MS = 15_000;
const SEND_EVERY_MS = 60;
const MAX_NOTES = 1000;
const MAX_CURSORS_PER_NOTE = 50;

/** FNV-1a: stable across devices, so everyone sees the same colour for a person. */
export function hueFor(userId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return Math.round((hash / 0x1_0000_0000) * 360) % 360;
}

function colours(userId: string): { color: string; colorLight: string } {
  const hue = hueFor(userId);
  return { color: `hsl(${hue} 70% 42%)`, colorLight: `hsla(${hue} 70% 42% / 0.22)` };
}

function isAnchored(position: Y.RelativePosition): boolean {
  return position.item !== null || position.tname !== null || position.type !== null;
}

function live(json: unknown): Y.RelativePosition | null {
  try {
    if (typeof json !== "object" || json === null) return null;
    const position = Y.createRelativePositionFromJSON(json);
    return isAnchored(position) ? position : null;
  } catch {
    return null;
  }
}

export interface RoomPresenceDeps {
  workspaceId: string;
  roomId: string;
  replica: RoomReplica;
  me: KeyPair;
  /** Send a presence envelope to the mesh. */
  publish(env: PresenceEnvelope): void;
  /** The user behind a (verified) device: id and display name. */
  userOf(deviceId: string): { id: string; name: string } | null;
}

export class RoomPresence {
  private remote = new Map<string, Map<number, Remote>>();
  private facades = new Map<string, Set<AwarenessFacade>>();
  private pending = new Map<string, { clientId: number; cursor: LiveCursor | null; timer: ReturnType<typeof setTimeout> }>();
  private lastSent = new Map<string, { clientId: number; cursor: LiveCursor | null; at: number }>();
  private sweeper: ReturnType<typeof setInterval>;

  constructor(private readonly deps: RoomPresenceDeps) {
    this.sweeper = setInterval(() => this.sweep(), 5_000);
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  destroy(): void {
    clearInterval(this.sweeper);
    for (const { timer } of this.pending.values()) clearTimeout(timer);
  }

  facade(fileId: string, doc: Y.Doc): AwarenessFacade {
    const facade = new AwarenessFacade(this, fileId, doc);
    let set = this.facades.get(fileId);
    if (!set) this.facades.set(fileId, (set = new Set()));
    set.add(facade);
    return facade;
  }

  /** @internal */
  detach(facade: AwarenessFacade): void {
    const set = this.facades.get(facade.fileId);
    set?.delete(facade);
    if (set && set.size === 0) {
      this.facades.delete(facade.fileId);
      this.send(facade.fileId, facade.doc.clientID, null);
    }
  }

  /** @internal Remote cursors in one note, by Yjs client id. */
  statesOf(fileId: string): Map<number, Remote> {
    return this.remote.get(fileId) ?? new Map();
  }

  /** @internal Queue my cursor for a note; at most one message per ~60 ms. */
  send(fileId: string, clientId: number, cursor: LiveCursor | null): void {
    const existing = this.pending.get(fileId);
    if (existing) {
      existing.clientId = clientId;
      existing.cursor = cursor;
      return;
    }
    const timer = setTimeout(() => {
      const entry = this.pending.get(fileId);
      this.pending.delete(fileId);
      if (entry) this.publishNow(fileId, entry.clientId, entry.cursor);
    }, SEND_EVERY_MS);
    this.pending.set(fileId, { clientId, cursor, timer });
  }

  private publishNow(fileId: string, clientId: number, cursor: LiveCursor | null): void {
    const epoch = this.deps.replica.sealEpoch();
    if (!epoch) return;
    const payload = { d: fileId, c: clientId, a: cursor ? Y.relativePositionToJSON(cursor.anchor) : null, h: cursor ? Y.relativePositionToJSON(cursor.head) : null };
    const at = Date.now();
    this.deps.publish(sealPresence({ ws: this.deps.workspaceId, room: this.deps.roomId, n: epoch.n, key: epoch.key, author: this.deps.me }, at, utf8(JSON.stringify(payload))));
    this.lastSent.set(fileId, { clientId, cursor, at });
  }

  /** Feed a verified presence envelope of this room. */
  receive(env: PresenceEnvelope): void {
    const key = this.deps.replica.keyFor(env.n);
    const user = this.deps.userOf(env.author);
    if (!key || !user) return;
    let payload: { d?: unknown; c?: unknown; a?: unknown; h?: unknown };
    try {
      payload = JSON.parse(fromUtf8(openEnvelope(env, key)));
    } catch {
      return;
    }
    // Only notes of this room, and only so many cursors: what a member sends can't grow these maps without end.
    if (!isId(payload.d, "f") || !Number.isSafeInteger(payload.c) || !this.deps.replica.index.has(payload.d)) return;
    const fileId = payload.d;
    const clientId = payload.c as number;
    const anchor = payload.a === null ? null : live(payload.a);
    const head = payload.h === null ? null : live(payload.h);
    let states = this.remote.get(fileId);
    if (!states) {
      if (this.remote.size >= MAX_NOTES) return;
      this.remote.set(fileId, (states = new Map()));
    }
    const existed = states.has(clientId);
    if (!existed && states.size >= MAX_CURSORS_PER_NOTE) return;
    if (payload.a === null || !anchor || !head) states.delete(clientId);
    else states.set(clientId, { user: { name: user.name, ...colours(user.id) }, cursor: { anchor, head }, at: Date.now() });
    const change: AwarenessChange = states.has(clientId) ? (existed ? { added: [], updated: [clientId], removed: [] } : { added: [clientId], updated: [], removed: [] }) : { added: [], updated: [], removed: [clientId] };
    for (const facade of this.facades.get(fileId) ?? []) facade.emit(change);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [fileId, states] of this.remote) {
      const removed = [...states].filter(([, state]) => now - state.at > STALE_MS).map(([clientId]) => clientId);
      for (const clientId of removed) states.delete(clientId);
      if (removed.length > 0) for (const facade of this.facades.get(fileId) ?? []) facade.emit({ added: [], updated: [], removed });
      if (states.size === 0) this.remote.delete(fileId);
    }
    // Keep our own cursor alive for others.
    for (const [fileId, sent] of this.lastSent) {
      if (!this.facades.has(fileId)) {
        this.lastSent.delete(fileId);
        continue;
      }
      if (sent.cursor && now - sent.at > RESEND_MS) this.publishNow(fileId, sent.clientId, sent.cursor);
    }
  }
}

/** The Awareness-shaped object y-codemirror.next expects, for one editor view of one note. */
export class AwarenessFacade {
  private local: { cursor: LiveCursor | null } = { cursor: null };
  private listeners = new Set<Listener>();

  constructor(
    private readonly presence: RoomPresence,
    readonly fileId: string,
    readonly doc: Y.Doc
  ) {}

  getLocalState(): { cursor: LiveCursor | null } {
    return this.local;
  }

  setLocalStateField(field: string, value: unknown): void {
    if (field !== "cursor") return;
    this.local = { cursor: (value as LiveCursor | null) ?? null };
    this.presence.send(this.fileId, this.doc.clientID, this.local.cursor);
  }

  getStates(): Map<number, RenderState> {
    return this.presence.statesOf(this.fileId);
  }

  on(_event: "change", listener: Listener): void {
    this.listeners.add(listener);
  }

  off(_event: "change", listener: Listener): void {
    this.listeners.delete(listener);
  }

  /** @internal */
  emit(change: AwarenessChange): void {
    for (const listener of this.listeners) listener(change, "remote");
  }

  destroy(): void {
    this.listeners.clear();
    this.presence.detach(this);
  }
}
