import { b64u, utf8 } from "./bytes.js";
import { canonicalJson } from "./canonical.js";
import { MAX_FORK_DEPTH, WorkspaceChain, type OfferResult } from "./chain.js";
import { hashTagged } from "./crypto.js";
import { envelopeKey, isBlobKey, isDocId, parseEnvelope, verifyEnvelope, type Envelope, type PresenceEnvelope, type StoredEnvelope } from "./envelope.js";
import { fail, SecureError } from "./errors.js";
import { MAX_FRAME, PROVEN_MAX_FRAME } from "./frames.js";
import { isId } from "./ids.js";
import { applyJoins, joinHash, parseJoinRecord, PEER_PATTERN, takenBackOut, verifyJoinRecord, type JoinRecord } from "./invite.js";
import { parseKeyWrap, verifyKeyWrap, wrapSignatureValid, type KeyWrap } from "./keys.js";
import { EnvelopeStore, type VersionVector } from "./store.js";
import * as v from "./validate.js";
import { activeDevice, parseSignedVersion, roleIn, type SignedVersion, type WorkspaceState } from "./workspace.js";

/**
 * A mesh node: this device's copy of the workspace (record, pending joins, key wraps, encrypted room content) and
 * its sessions with other peers. Peers exchange only what the other side lacks and pass new things on, so the
 * workspace converges whichever peers happen to be online. Everything received is verified before it is kept or
 * passed on. Transport (TLS, proving who is on the other end) is the caller's job: a session is created for a
 * channel whose remote device id the transport has already proven.
 */

export interface Channel {
  send(message: PeerMessage): void;
  close(reason: string): void;
  /** Called once the other side is a member and the session is running (a transport lifts its pre-membership limits). */
  ready?(): void;
  /** Called before that once the other side has shown it holds our record: its versions may come in large messages. */
  widen?(): void;
}

type Recent = Array<[number, string]>;
type DocSummary = { vv: VersionVector; snaps: string[] };

export type PeerMessage =
  /** First message on a session: where my workspace record stands (`head` -1: I have none yet, I'm joining). */
  | { t: "hello"; ws: string; head: number; recent: Recent }
  /** Consecutive workspace versions, starting right after one the receiver has (or at genesis for a joiner). */
  | { t: "versions"; versions: unknown[] }
  | { t: "joins"; joins: unknown[] }
  | { t: "wraps"; wraps: unknown[] }
  /** Summaries of the rooms I hold. */
  | { t: "digests"; rooms: Record<string, string> }
  /** Exactly what I hold of one room (blobs as "author/id", those dropped here included), so the other side can send what I lack. */
  | { t: "room"; room: string; docs: Record<string, DocSummary>; blobs: string[] }
  | { t: "envelopes"; items: unknown[] }
  /** One new envelope, live. */
  | { t: "push"; env: unknown }
  /** A joining device's first message: its join record. */
  | { t: "join"; join: unknown }
  /** Where devices of the workspace can be reached: [device id, "host:port"] (see MeshNode.addressBook). */
  | { t: "addresses"; items: unknown[] };

export interface MeshEvents {
  /** The workspace record changed; for "replaced", `lost` lists our versions that a winning branch replaced. */
  chain?(result: OfferResult): void;
  /** A new room envelope was stored (from a peer or published here). */
  envelope?(env: StoredEnvelope): void;
  /**
   * An envelope made here is now safely stored (and on its way to peers), or the last of those received for a document
   * that were waiting to be.
   */
  stored?(env: StoredEnvelope): void;
  presence?(env: PresenceEnvelope): void;
  wraps?(): void;
  /** The effective membership changed (record or joins). */
  membership?(): void;
  /** A peer sent something invalid. Reported for diagnostics; never thrown at the caller. */
  rejected?(reason: string, from: string): void;
  sessions?(): void;
  /** The record has just been compared with a member's (see MeshNode.recordCompared). */
  compared?(): void;
}

const RECENT = 64;
const MAX_ITEMS = 500;
const MAX_ADDRESSES = 64;
const MAX_BATCH_BYTES = 8 << 20;
const PRESENCE_MEMORY = 2000;
const PRESENCE_WINDOW_MS = 60_000;
const MAX_PENDING = 2000;
const MAX_PENDING_WRAPS = 500;
const MAX_STALE = 10_000;
const MAX_JOIN_VERSIONS = 1_000_000;

function hashOf(purpose: string, value: unknown): string {
  return b64u(hashTagged(purpose, utf8(canonicalJson(value))));
}

/** `items` in runs of at most `size`. */
function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Record versions in runs of at most about `maxBytes` (a version is at most LIMITS.versionBytes, so one always fits the
 * frame limits that apply): all of them in one when they fit.
 */
export function versionBatches(versions: SignedVersion[], maxBytes: number): SignedVersion[][] {
  const out: SignedVersion[][] = [];
  let batch: SignedVersion[] = [];
  let bytes = 0;
  for (const version of versions) {
    const size = Buffer.byteLength(JSON.stringify(version), "utf8");
    if (batch.length > 0 && bytes + size > maxBytes) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(version);
    bytes += size;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

function errorText(error: unknown): string {
  return error instanceof SecureError ? `${error.code}:${error.message}` : `error:${String(error)}`;
}

/** A token bucket: `burst` at once, then one more every `everyMs`. */
class Budget {
  private tokens: number;
  private last: number;

  constructor(
    private readonly burst: number,
    private readonly everyMs: number,
    now: number
  ) {
    this.tokens = burst;
    this.last = now;
  }

  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + (now - this.last) / this.everyMs);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

export class MeshNode {
  readonly store: EnvelopeStore;
  chain: WorkspaceChain;
  private joins = new Map<string, { join: JoinRecord; firstSeen: number }>();
  /** One wrap per (room, epoch, recipient, wrapper): a member can't pile up wraps. */
  private wraps = new Map<string, KeyWrap>();
  /** Joins and wraps that didn't verify yet (our record may be behind); retried when membership changes. */
  private pendingJoins = new Map<string, { join: JoinRecord; firstSeen: number }>();
  /** Kept per device that sent them, so no one can push out what others sent. */
  private pendingWraps = new Map<string, Map<string, KeyWrap>>();
  /**
   * Saved wraps that don't count now. Kept (and saved again) while they may: one of a key the record no longer has (it
   * lost a race) counts again if the record names that key again, as when a room whose creation lost a race is made
   * again; one of the room's newest key shows who holds it, so the key is replaced if they lost access.
   */
  private staleWraps = new Map<string, KeyWrap>();
  private sessions = new Set<PeerSession>();
  private seenPresence = new Set<string>();
  private olderPresence = new Set<string>();
  private presenceBudgets = new Map<string, Budget>();
  private memberRooms = new Set<string>();
  private effectiveCache: { state: WorkspaceState; applied: JoinRecord[] } | null = null;
  /** Envelopes made here that aren't safely stored yet: they don't leave this device until they are. */
  private unpersisted = new Set<string>();
  /** Envelopes received that aren't safely stored yet, counted by document (`room/doc/`, see envelopeKey). */
  private unstoredReceived = new Map<string, number>();
  /** Attempts to store them that are under way. */
  private storing = new Set<Promise<void>>();
  /**
   * Set by the owner: resolves once an envelope is safely on disk. One made here is sent only then, so a crash can never
   * lose an envelope a peer already has, and the counter it used is never handed out twice. One received is passed on at
   * once (its author has it), and stored again until it is (an attachment isn't, see publish).
   */
  persist: ((env: StoredEnvelope) => Promise<void>) | null = null;
  /**
   * Set by the owner (see PeerManager): where devices of the workspace can be reached, told to each peer and to all of
   * them when it changes (shareAddresses), so peers can reach each other without the one that brought them together.
   */
  addressBook: () => Array<[string, string]> = () => [];
  /** Addresses a peer told of, in form only: whoever answers there is checked when dialled. */
  onAddresses: (items: Array<[string, string]>) => void = () => {};
  /** The record listed no other active device when this node started, and it hasn't been away since (see recompare). */
  private alone: boolean;
  /** When a member last answered our hello, and since when an answer counts (see recompare). */
  private answeredAt = 0;
  private answersSince = 0;
  private stopped = false;

  constructor(
    chain: WorkspaceChain,
    readonly deviceId: string,
    readonly events: MeshEvents = {},
    store?: EnvelopeStore,
    readonly now: () => number = Date.now
  ) {
    this.chain = chain;
    this.store = store ?? new EnvelopeStore();
    this.store.isMember = (room) => this.isMemberOf(room);
    this.store.now = now;
    this.memberRooms = this.currentMemberRooms();
    this.alone = !this.othersActive();
  }

  get workspaceId(): string {
    return this.chain.workspaceId;
  }

  /**
   * The record has been compared with a member's: a device the signed record lists answered our hello since this node
   * started, or since recompare (a device joining through us doesn't count: it only has what we gave it). Or there is no
   * one to compare with: the record lists no other active device, or listed none when this node started (the devices
   * listed since joined through this one) and it hasn't been away since. Until then, changes the device would make to
   * the record on its own (see MeshService.automate) wait: made on an old record, they would only start a branch.
   */
  get recordCompared(): boolean {
    return this.answeredAt > this.answersSince || this.alone || !this.othersActive();
  }

  private othersActive(): boolean {
    const state = this.chain.state;
    return Object.keys(state.devices).some((id) => id !== this.deviceId && activeDevice(state, id));
  }

  /** Only answers from now on count (see recordCompared), and every peer is asked again: this device may have been away. */
  recompare(): void {
    this.alone = false;
    this.answersSince = this.now();
    for (const session of this.sessions) session.askAgain();
  }

  /** @internal `from` answered our hello. */
  noteAnswer(from: string): void {
    if (!activeDevice(this.chain.state, from)) return;
    const was = this.recordCompared;
    this.answeredAt = Math.max(this.now(), this.answersSince + 1);
    if (!was) this.events.compared?.();
  }

  /** The signed record plus valid joins no one has recorded yet: the membership every check uses. */
  effective(): WorkspaceState {
    return this.withJoins().state;
  }

  /** The joins not recorded yet that take effect here (see applyJoins), in the order they do: the ones to record. */
  joinsInEffect(): JoinRecord[] {
    return this.withJoins().applied;
  }

  private withJoins(): { state: WorkspaceState; applied: JoinRecord[] } {
    if (!this.effectiveCache) this.effectiveCache = applyJoins(this.chain.state, this.workspaceId, this.joins.values());
    return this.effectiveCache;
  }

  /** Whether this device may read a room (its user is a member). */
  isMemberOf(room: string): boolean {
    const state = this.effective();
    const device = activeDevice(state, this.deviceId);
    return device !== null && roleIn(state, room, device.user) !== undefined;
  }

  private currentMemberRooms(): Set<string> {
    return new Set(Object.keys(this.effective().rooms).filter((room) => this.isMemberOf(room)));
  }

  /**
   * Keep a valid join unless one for the same invite with a lower hash is kept already (the one every peer picks, see
   * applyJoins): whoever holds an invite link can make any number of joins with it, but only one is ever kept.
   */
  private keepJoin(hash: string, entry: { join: JoinRecord; firstSeen: number }): boolean {
    for (const [other, kept] of this.joins) {
      if (kept.join.body.invite !== entry.join.body.invite) continue;
      if (other <= hash) return false;
      this.joins.delete(other);
    }
    this.joins.set(hash, entry);
    return true;
  }

  private membershipChanged(): void {
    // Joins the record now covers, or that turned invalid, are dropped; pending ones get another chance.
    for (const [hash, entry] of [...this.joins, ...this.pendingJoins]) {
      this.joins.delete(hash);
      this.pendingJoins.delete(hash);
      try {
        verifyJoinRecord(this.chain.state, this.workspaceId, entry.join, entry.firstSeen);
        this.keepJoin(hash, entry);
      } catch (error) {
        if (error instanceof SecureError && error.code === "join_no_invite") this.pendingJoins.set(hash, entry);
      }
    }
    this.effectiveCache = null;
    // Wraps of a key the record no longer has (a rotation that lost a race) stop counting, receipts included, so the
    // right key can take their place; they are set aside, not dropped, and count again if the record names the key.
    let wrapsChanged = false;
    for (const [slot, wrap] of this.wraps) {
      if (this.effective().rooms[wrap.body.room]?.epochs[wrap.body.n - 1]?.commit === wrap.body.commit) continue;
      this.wraps.delete(slot);
      this.keepAside(wrap);
      wrapsChanged = true;
    }
    for (const waiting of [this.staleWraps, ...this.pendingWraps.values()]) {
      for (const [hash, wrap] of waiting) {
        if (verifyKeyWrap(this.effective(), this.workspaceId, wrap)) {
          waiting.delete(hash);
          const slot = wrapSlot(wrap);
          if (!this.wraps.has(slot)) this.wraps.set(slot, wrap);
          wrapsChanged = true;
        } else if (waiting === this.staleWraps && !this.worthKeeping(wrap)) {
          waiting.delete(hash);
          wrapsChanged = true;
        }
      }
    }
    for (const [sender, waiting] of this.pendingWraps) if (waiting.size === 0) this.pendingWraps.delete(sender);
    if (wrapsChanged) this.events.wraps?.();
    // Rooms this device just joined: what it took on snapshots' word while it only relayed them is checked now.
    const rooms = this.currentMemberRooms();
    for (const room of rooms) if (!this.memberRooms.has(room)) this.store.distrustClaims(room);
    this.memberRooms = rooms;
    for (const session of [...this.sessions]) {
      if (session.ready && !activeDevice(this.effective(), session.remoteDevice)) session.close("not_a_member");
      else session.resync();
    }
    this.events.membership?.();
  }

  /** Compare rooms with every peer again (e.g. after forgetting that a blob was dropped). */
  resync(): void {
    for (const session of this.sessions) session.resync();
  }

  pendingJoinRecords(): JoinRecord[] {
    return [...this.joins.values()].map((entry) => entry.join);
  }

  /** Joins and when this device first saw them, for saving; `restore` puts them back after a restart. */
  joinEntries(): Array<{ join: JoinRecord; firstSeen: number }> {
    return [...this.joins.values(), ...this.pendingJoins.values()];
  }

  /** Reload saved joins and wraps (see savedWraps) without passing them on (peers get them at the next sync). */
  restore(joins: Array<{ join: JoinRecord; firstSeen: number }>, wraps: KeyWrap[]): void {
    for (const entry of joins) this.pendingJoins.set(joinHash(entry.join), entry);
    this.membershipChanged();
    for (const wrap of wraps) {
      if (verifyKeyWrap(this.effective(), this.workspaceId, wrap)) {
        const slot = wrapSlot(wrap);
        if (!this.wraps.has(slot)) this.wraps.set(slot, wrap);
      } else if (this.worthKeeping(wrap)) this.keepAside(wrap);
    }
    this.events.wraps?.();
  }

  private keepAside(wrap: KeyWrap): void {
    this.staleWraps.set(hashOf("wrap-hash", wrap), wrap);
    if (this.staleWraps.size > MAX_STALE) this.staleWraps.delete(this.staleWraps.keys().next().value!);
  }

  /**
   * Whether a wrap that doesn't count is worth keeping: its key isn't the record's (the record may name it again), it is
   * of a room's newest key (it shows who holds that key, see staleWraps), or of a room deleted recently enough for a
   * fork to undo that. Otherwise it doesn't count because of who gave or got it: should they get access again, the key
   * is simply wrapped for them anew.
   */
  private worthKeeping(wrap: KeyWrap): boolean {
    const room = this.effective().rooms[wrap.body.room];
    if (!room) return true;
    if (room.deleted) return this.chain.versionAt(this.chain.length - 1 - MAX_FORK_DEPTH)?.body.state.rooms[wrap.body.room]?.deleted !== true;
    return room.epochs[wrap.body.n - 1]?.commit !== wrap.body.commit || wrap.body.n === room.epochs.length;
  }

  /** The wraps that count: of a key the record has, from a device that may give it. */
  allWraps(): KeyWrap[] {
    return [...this.wraps.values()];
  }

  /** Wraps to keep on disk: those that count, and those set aside because the record may name their key again. */
  savedWraps(): KeyWrap[] {
    return [...this.wraps.values(), ...this.staleWraps.values()];
  }

  // ---- adding things (made here or received) ----

  /** `appendOnly`: from a device that isn't a member here, only versions that extend our record are taken. */
  offerVersions(versions: SignedVersion[], from?: PeerSession, appendOnly = false): OfferResult {
    const result = this.chain.offer(versions, this.now(), appendOnly);
    if (result.status === "replaced") {
      // Joins recorded in versions that lost wait again, until an admin or the invite's creator records them again;
      // not someone the lost branch itself took back out.
      result.lost.forEach((version, i) => {
        for (const join of version.body.joins ?? []) {
          if (!takenBackOut(version.body.state, result.lost.slice(i + 1), join) && this.pendingJoins.size < MAX_PENDING) this.pendingJoins.set(joinHash(join), { join, firstSeen: version.body.at });
        }
      });
    }
    if (result.status === "appended" || result.status === "replaced") {
      this.effectiveCache = null;
      this.events.chain?.(result);
      // Pass on only what is new here.
      this.broadcast({ t: "versions", versions: this.chain.since(this.chain.length - result.count) }, from);
      this.membershipChanged();
    }
    return result;
  }

  /**
   * True if the join was new and valid. A join for an invite our record doesn't know yet is kept for later, but only
   * when a member passed it on (`keepPending`): a stranger presenting a made-up join gets nothing stored.
   */
  addJoin(join: JoinRecord, from?: PeerSession, keepPending = true): boolean {
    const hash = joinHash(join);
    if (this.joins.has(hash) || this.pendingJoins.has(hash)) return false;
    const entry = { join, firstSeen: this.now() };
    try {
      verifyJoinRecord(this.chain.state, this.workspaceId, join, entry.firstSeen);
    } catch (error) {
      if (keepPending && error instanceof SecureError && error.code === "join_no_invite" && this.pendingJoins.size < MAX_PENDING) this.pendingJoins.set(hash, entry);
      throw error;
    }
    if (!this.keepJoin(hash, entry)) return false;
    this.broadcast({ t: "joins", joins: [join] }, from);
    this.membershipChanged();
    return true;
  }

  addWrap(wrap: KeyWrap, from?: PeerSession): boolean {
    const slot = wrapSlot(wrap);
    if (this.wraps.has(slot)) return false;
    if (!verifyKeyWrap(this.effective(), this.workspaceId, wrap)) {
      // Our record may be behind (a device, room or epoch it doesn't know yet): keep the wrap for later. Kept by its
      // contents, so a wrap that never verifies can't take the place of a genuine one, and not kept at all when its
      // wrapper is known and the signature simply doesn't hold. Kept apart per sender: when too many from one sender
      // wait, its oldest goes, so no one can push out wraps others sent.
      if (wrapSignatureValid(this.effective(), wrap) === false) return false;
      const sender = from?.remoteDevice ?? this.deviceId;
      let waiting = this.pendingWraps.get(sender);
      if (!waiting) this.pendingWraps.set(sender, (waiting = new Map()));
      const hash = hashOf("wrap-hash", wrap);
      if (waiting.has(hash)) return false;
      if (waiting.size >= MAX_PENDING_WRAPS) waiting.delete(waiting.keys().next().value!);
      waiting.set(hash, wrap);
      return false;
    }
    this.wraps.set(slot, wrap);
    this.events.wraps?.();
    this.broadcast({ t: "wraps", wraps: [wrap] }, from);
    return true;
  }

  /** Store and pass on a room envelope (presence is only passed on). False if invalid, already known or refused. */
  publish(env: Envelope, from?: PeerSession): boolean {
    if (!verifyEnvelope(this.effective(), this.workspaceId, env)) return false;
    if (env.k === "p") return this.presence(env, from);
    const result = this.store.add(env);
    if (result === "conflict") this.events.rejected?.("equivocation", env.author);
    if (result === "quota") this.events.rejected?.(`quota:${env.room}`, env.author);
    if (result !== "added") return false;
    this.events.envelope?.(env);
    const mine = !from && env.author === this.deviceId;
    if (!mine || !this.persist) this.broadcast({ t: "push", env }, from);
    // An attachment received isn't held in memory to be stored again (it can be large): should storing it fail, it is
    // missing here until Obsidian starts again, and then a peer sends it again.
    if (!this.persist || (!mine && env.k === "b")) return true;
    const key = envelopeKey(env);
    const doc = `${env.room}/${env.k === "b" ? "b" : env.doc}/`;
    if (mine) this.unpersisted.add(key);
    else this.unstoredReceived.set(doc, (this.unstoredReceived.get(doc) ?? 0) + 1);
    const attempt = (retryIn: number): void => {
      // Once stopped, nothing more is written: storage may be gone (left), or in use by the next session.
      if (this.stopped) return;
      const done = this.persist!(env).then(
        () => {
          if (!mine) {
            const left = this.unstoredReceived.get(doc)! - 1;
            if (left > 0) return void this.unstoredReceived.set(doc, left);
            this.unstoredReceived.delete(doc);
            // All that came for the document is stored now: the owner may count on it (see RoomFolder).
            if (!this.stopped) this.events.stored?.(env);
            return;
          }
          this.unpersisted.delete(key);
          if (this.stopped) return;
          this.broadcast({ t: "push", env });
          this.events.stored?.(env);
        },
        (error: unknown) => {
          // Not stored yet (a full disk, say): tried again later. One made here isn't sent until then.
          this.events.rejected?.(`not_stored:${errorText(error)}`, this.deviceId);
          if (this.stopped) return;
          const timer = setTimeout(() => attempt(Math.min(retryIn * 2, 300_000)), retryIn);
          (timer as { unref?: () => void }).unref?.();
        }
      ).catch((error: unknown) => this.events.rejected?.(`stored:${errorText(error)}`, this.deviceId));
      this.storing.add(done);
      void done.then(() => this.storing.delete(done));
    };
    attempt(5_000);
    return true;
  }

  /** Resolves once the envelopes being stored right now are stored (or failed to be, this time). */
  async stored(): Promise<void> {
    await Promise.all([...this.storing]);
  }

  /** Stop: nothing more is sent, stored or retried (the owner closes the connections). */
  stop(): void {
    this.stopped = true;
  }

  /** Whether an envelope made here (or the one with this key, see envelopeKey) is still waiting to be stored, so isn't sent yet. */
  isUnpersisted(env: StoredEnvelope | string): boolean {
    return this.unpersisted.size > 0 && this.unpersisted.has(typeof env === "string" ? env : envelopeKey(env));
  }

  /** Whether an envelope made here whose key starts with `prefix` (see envelopeKey) is still waiting to be stored. */
  hasUnpersisted(prefix: string): boolean {
    if (this.unpersisted.size === 0) return false;
    for (const key of this.unpersisted) if (key.startsWith(prefix)) return true;
    return false;
  }

  /** Whether an envelope received for a document (`room/doc/`, see envelopeKey) is still waiting to be stored. */
  hasUnstoredReceived(doc: string): boolean {
    return this.unstoredReceived.has(doc);
  }

  /** Presence: only fresh messages, at a bounded rate per author, each passed on once. */
  private presence(env: PresenceEnvelope, from?: PeerSession): boolean {
    const now = this.now();
    if (Math.abs(now - env.at) > PRESENCE_WINDOW_MS) return false;
    const key = `${env.room}/${env.author}/${env.at}/${env.sig}`;
    if (this.seenPresence.has(key) || this.olderPresence.has(key)) return false;
    let budget = this.presenceBudgets.get(env.author);
    if (!budget) {
      if (this.presenceBudgets.size >= PRESENCE_MEMORY) this.presenceBudgets.clear();
      this.presenceBudgets.set(env.author, (budget = new Budget(60, 40, now)));
    }
    if (!budget.take(now)) return false;
    // Two generations, so a message seen just before a turnover still isn't passed on twice.
    if (this.seenPresence.size >= PRESENCE_MEMORY) {
      this.olderPresence = this.seenPresence;
      this.seenPresence = new Set();
    }
    this.seenPresence.add(key);
    this.events.presence?.(env);
    this.broadcast({ t: "push", env }, from);
    return true;
  }

  // ---- sessions ----

  /** Start a session over an authenticated channel. `remoteDevice` is the device id the transport proved. */
  connect(channel: Channel, remoteDevice: string): PeerSession {
    const session = new PeerSession(this, channel, remoteDevice);
    this.sessions.add(session);
    session.start();
    this.events.sessions?.();
    return session;
  }

  /** @internal */
  detach(session: PeerSession): void {
    if (this.sessions.delete(session)) this.events.sessions?.();
  }

  connectedDevices(): string[] {
    return [...this.sessions].filter((s) => s.ready).map((s) => s.remoteDevice);
  }

  closeAll(reason: string): void {
    for (const session of [...this.sessions]) session.close(reason);
  }

  /** Tell every peer where the devices of the workspace can be reached (see addressBook). */
  shareAddresses(): void {
    const items = this.addressBook().slice(0, MAX_ADDRESSES);
    if (items.length > 0) this.broadcast({ t: "addresses", items });
  }

  private broadcast(message: PeerMessage, except?: PeerSession): void {
    for (const session of this.sessions) if (session !== except && session.ready) session.send(message);
  }

  /** @internal Recent version hashes, for working out where two chains meet. */
  recent(): Recent {
    const head = this.chain.head.body.v;
    const out: Recent = [];
    for (let at = Math.max(0, head - RECENT + 1); at <= head; at++) out.push([at, this.chain.hashAt(at)!]);
    return out;
  }
}

function wrapSlot(wrap: KeyWrap): string {
  const { room, n, to, by } = wrap.body;
  return `${room}/${n}/${to}/${by}`;
}

/** One peer, over one channel. The node owns the shared state; the session only speaks the protocol. */
export class PeerSession {
  ready = false;
  private closed = false;
  private budgets = new Map<string, Budget>();
  /** A hello received before the other side was a member here: answered in full once it is (see begin). */
  private earlyHello: Record<string, unknown> | null = null;
  /** Our hello was sent and its answer hasn't ended yet (see MeshNode.recordCompared). */
  private awaiting = false;

  constructor(
    private readonly node: MeshNode,
    private readonly channel: Channel,
    readonly remoteDevice: string
  ) {}

  /** @internal */
  start(): void {
    // A device that isn't a member yet may only introduce itself with a join record.
    if (activeDevice(this.node.effective(), this.remoteDevice)) this.begin();
  }

  /** `answered`: its answer to our hello will come (a joining device has no record to answer with). */
  private begin(answered = true): void {
    this.ready = true;
    this.channel.ready?.();
    this.send({ t: "hello", ws: this.node.workspaceId, head: this.node.chain.head.body.v, recent: this.node.recent() });
    this.awaiting = answered;
    const items = this.node.addressBook().slice(0, MAX_ADDRESSES);
    if (items.length > 0) this.send({ t: "addresses", items });
    // A hello it sent before it was let in is answered now, as any hello is (with what it lacks, and our rooms).
    const early = this.earlyHello;
    this.earlyHello = null;
    if (early) this.onHello(early);
  }

  /** @internal Ask again where the other side's record stands: its answer counts anew (see MeshNode.recompare). */
  askAgain(): void {
    if (!this.ready) return;
    this.send({ t: "hello", ws: this.node.workspaceId, head: this.node.chain.head.body.v, recent: this.node.recent() });
    this.awaiting = true;
  }

  /** Compare rooms again (envelopes refused earlier may verify now). */
  resync(): void {
    if (this.ready) this.sendDigests();
  }

  send(message: PeerMessage): void {
    if (!this.closed) this.channel.send(message);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.node.detach(this);
    this.channel.close(reason);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private reject(reason: string): void {
    this.node.events.rejected?.(reason, this.remoteDevice);
  }

  /** Requests that make this side send a lot are rationed per session; honest peers stay well within it. */
  private allow(kind: string, burst: number, everyMs: number): boolean {
    let budget = this.budgets.get(kind);
    if (!budget) {
      if (this.budgets.size >= 5000) this.budgets.clear();
      this.budgets.set(kind, (budget = new Budget(burst, everyMs, this.node.now())));
    }
    if (budget.take(this.node.now())) return true;
    this.reject(`rate:${kind}`);
    return false;
  }

  /** Feed one message from the channel. Never throws: bad input is reported, and before membership ends the session. */
  receive(raw: unknown): void {
    if (this.closed) return;
    try {
      this.handle(raw);
    } catch (error) {
      this.reject(errorText(error));
      if (!this.ready) this.close("protocol");
    }
  }

  private handle(raw: unknown): void {
    const message = v.obj(raw, "message", ["t", "ws", "head", "recent", "versions", "joins", "wraps", "rooms", "room", "docs", "blobs", "items", "env", "join"]);
    // An answer to our hello always ends with digests: the records have been compared (see MeshNode.recordCompared).
    if (this.awaiting && message.t === "digests") {
      this.awaiting = false;
      this.node.noteAnswer(this.remoteDevice);
    }
    if (!this.ready) return this.beforeMembership(message);
    switch (message.t) {
      case "hello":
        if (!this.allow("hello", 3, 30_000)) return;
        return this.onHello(message);
      case "versions":
        return this.offer(this.parseVersions(message.versions));
      case "joins":
        return this.each(message.joins, (join) => this.node.addJoin(parseJoinRecord(join), this));
      case "wraps":
        return this.each(message.wraps, (wrap) => this.node.addWrap(parseKeyWrap(wrap), this));
      case "digests":
        if (!this.allow("digests", 20, 3_000)) return;
        return this.onDigests(message.rooms);
      case "room":
        return this.onRoom(message);
      case "envelopes":
        return this.each(message.items, (item) => this.node.publish(parseEnvelope(item), this));
      case "push":
        return this.each([message.env], (item) => this.node.publish(parseEnvelope(item), this));
      case "join":
        return this.each([message.join], (join) => this.node.addJoin(parseJoinRecord(join), this));
      case "addresses":
        if (!this.allow("addresses", 5, 60_000)) return;
        return this.onAddresses(message.items);
      default:
        return this.reject("unknown_message");
    }
  }

  /**
   * The other side isn't a member here: a device joining, or a member this device doesn't know of yet (it joined while
   * this one was away, through someone else). Only what proves membership is taken in, each checked as always: its
   * join record, or the record's versions and joins (asked for with a hello of ours, when it counts us as a member).
   * Anything else is let go. Once the record names it, the session starts.
   */
  private beforeMembership(message: Record<string, unknown>): void {
    switch (message.t) {
      case "join": {
        const join = parseJoinRecord(message.join);
        if (join.body.device.id !== this.remoteDevice) return this.close("join_mismatch");
        this.node.addJoin(join, this, false);
        if (!activeDevice(this.node.effective(), this.remoteDevice)) return this.close("not_a_member");
        return this.begin(false);
      }
      case "hello":
        // It holds our record (one of its latest versions after the first is ours): our hello tells it what we lack,
        // and its versions may come in messages as large as members send. To anyone else, nothing is said.
        if (message.ws !== this.node.workspaceId || this.readHello(message).common < 1) return this.close("not_a_member");
        if (!this.allow("hello", 3, 30_000)) return;
        this.earlyHello = message;
        this.channel.widen?.();
        return this.send({ t: "hello", ws: this.node.workspaceId, head: this.node.chain.head.body.v, recent: this.node.recent() });
      case "versions": {
        // Only after such a hello, and only versions that extend our record, each message as it comes (a branch that
        // would replace part of it comes from members alone); anything else ends the session.
        const versions = this.earlyHello ? this.parseVersions(message.versions) : [];
        const result = versions.length === (message.versions as unknown[]).length ? this.node.offerVersions(versions, this, true) : null;
        if (!result || (result.status !== "appended" && result.status !== "duplicate")) return this.close("not_a_member");
        break;
      }
      case "joins":
        // Checked, and nothing kept for later: a made-up join for an invite we don't know yet is dropped.
        this.each(message.joins, (join) => this.node.addJoin(parseJoinRecord(join), this, false));
        break;
      case "digests":
        // Its answer is over, and it isn't a member: nothing more to wait for.
        return this.close("not_a_member");
      default:
        return;
    }
    if (activeDevice(this.node.effective(), this.remoteDevice)) this.begin();
    else if (message.t === "joins") this.close("not_a_member");
  }

  private onAddresses(raw: unknown): void {
    if (!Array.isArray(raw) || raw.length > MAX_ADDRESSES) v.bad("addresses");
    const items: Array<[string, string]> = [];
    for (const item of raw) {
      if (Array.isArray(item) && item.length === 2 && isId(item[0], "d") && typeof item[1] === "string" && PEER_PATTERN.test(item[1])) items.push([item[0], item[1]]);
    }
    this.node.onAddresses(items);
  }

  /** Handle each item of a batch; one bad item doesn't spoil the rest. */
  private each(value: unknown, handle: (item: unknown) => unknown): void {
    if (!Array.isArray(value) || value.length > MAX_ITEMS) v.bad("message.items");
    for (const item of value) {
      try {
        handle(item);
      } catch (error) {
        this.reject(errorText(error));
      }
    }
  }

  /** A hello's head, and the newest version both sides have (-1 if none of its latest versions is ours). */
  private readHello(message: Record<string, unknown>): { theirHead: number; theirHeadHash?: string; common: number } {
    const theirHead = v.int(message.head, "hello.head", -1, 1e12);
    if (!Array.isArray(message.recent) || message.recent.length > RECENT) v.bad("hello.recent");
    let common = -1;
    let theirHeadHash: string | undefined;
    for (const entry of message.recent as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 2) v.bad("hello.recent");
      const at = v.int(entry[0], "hello.recent.v", 0, 1e12);
      const hash = v.hash(entry[1], "hello.recent.hash");
      if (at === theirHead) theirHeadHash = hash;
      if (this.node.chain.hashAt(at) === hash) common = Math.max(common, at);
    }
    return { theirHead, theirHeadHash, common };
  }

  private onHello(message: Record<string, unknown>): void {
    if (message.ws !== this.node.workspaceId) return this.close("other_workspace");
    // If the other side's head isn't ours, send everything after the newest version both have; a joiner (head -1)
    // gets the whole record from genesis.
    const { theirHead, theirHeadHash, common } = this.readHello(message);
    if (theirHead !== this.node.chain.head.body.v || theirHeadHash !== this.node.chain.headHash) {
      const versions = theirHead === -1 ? this.node.chain.all() : this.node.chain.since(common >= 0 ? common + 1 : 1);
      // As the previous release sends them, 500 versions a message: the other side judges a branch by what one message
      // holds. Only a message too large for the frames it reads from us is cut by size (it would fail whole): 64 MiB, or
      // 16 MiB while its record doesn't list this device yet.
      const knowsUs = theirHead === -1 || (common >= 0 && this.node.chain.versionAt(common)?.body.state.devices[this.node.deviceId] !== undefined);
      const fits = (knowsUs ? MAX_FRAME : PROVEN_MAX_FRAME) - (1 << 20);
      for (const chunk of chunks(versions, MAX_ITEMS)) for (const batch of versionBatches(chunk, fits)) this.send({ t: "versions", versions: batch });
    }
    const joins = this.node.pendingJoinRecords();
    if (joins.length > 0) this.send({ t: "joins", joins });
    const wraps = this.node.allWraps();
    for (let i = 0; i < wraps.length; i += MAX_ITEMS) this.send({ t: "wraps", wraps: wraps.slice(i, i + MAX_ITEMS) });
    this.sendDigests();
  }

  private parseVersions(raw: unknown): SignedVersion[] {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ITEMS) v.bad("versions");
    return raw.map(parseSignedVersion).filter((version) => version.body.v > 0);
  }

  private offer(versions: SignedVersion[]): void {
    if (versions.length === 0) return;
    const result = this.node.offerVersions(versions, this);
    if (result.status === "rejected" && result.reason !== "loses") this.reject(`versions:${result.reason}`);
  }

  /** Every room of the record that isn't deleted: peers relay rooms they aren't in, as ciphertext. */
  private rooms(): string[] {
    return Object.entries(this.node.effective().rooms)
      .filter(([, room]) => !room.deleted)
      .map(([roomId]) => roomId);
  }

  private sendDigests(): void {
    const rooms: Record<string, string> = {};
    for (const room of this.rooms()) rooms[room] = this.node.store.digest(room);
    this.send({ t: "digests", rooms });
  }

  private onDigests(raw: unknown): void {
    const theirs = v.idMap(raw, "digests", "r", 10_000);
    for (const room of this.rooms()) if (theirs[room] === undefined || theirs[room] !== this.node.store.digest(room)) this.sendRoom(room);
  }

  private sendRoom(room: string): void {
    const store = this.node.store;
    const docs: Record<string, DocSummary> = {};
    for (const doc of store.docs(room)) docs[doc] = { vv: store.vv(room, doc), snaps: store.snapshotKeys(room, doc) };
    this.send({ t: "room", room, docs, blobs: [...store.blobKeys(room), ...store.gone(room).map(([key]) => key)] });
  }

  /** The other side told us exactly what it holds of a room: send what it lacks. */
  private onRoom(message: Record<string, unknown>): void {
    const room = v.id(message.room, "room.room", "r");
    if (!this.rooms().includes(room)) return;
    if (!this.allow(`room:${room}`, 6, 10_000)) return;
    const theirs = parseRoomSummary(message.docs);
    if (!Array.isArray(message.blobs) || message.blobs.length > 100_000) v.bad("room.blobs");
    const theirBlobs = new Set(message.blobs.map((key) => (isBlobKey(key) ? key : v.bad("room.blob"))));
    const store = this.node.store;
    const missing: StoredEnvelope[] = [];
    for (const doc of store.docs(room)) {
      const summary = theirs.get(doc) ?? { vv: {}, snaps: [] };
      const snaps = new Set(summary.snaps);
      for (const key of store.snapshotKeys(room, doc)) if (!snaps.has(key)) missing.push(store.snapshotByKey(room, doc, key)!);
      for (const env of store.missingFor(room, doc, summary.vv)) missing.push(env);
    }
    // Envelopes still being stored go out on their own once they are.
    this.sendBatched(missing.filter((env) => !this.node.isUnpersisted(env)));
    const blobs = store.blobsOf(room).filter((meta) => !theirBlobs.has(`${meta.author}/${meta.id}`));
    if (blobs.length > 0) void this.sendBlobs(room, blobs);
  }

  /** Blobs are read from storage one at a time and sent in their own batches. */
  private async sendBlobs(room: string, blobs: Array<{ author: string; id: string }>): Promise<void> {
    const out = this.batches();
    for (const { author, id } of blobs) {
      if (this.closed) return;
      const env = await this.node.store.loadBlob(room, author, id);
      if (env && !this.node.isUnpersisted(env)) out.add(env);
    }
    out.flush();
  }

  private sendBatched(envs: StoredEnvelope[]): void {
    const out = this.batches();
    for (const env of envs) out.add(env);
    out.flush();
  }

  /** Envelopes go out in messages the other side takes: at most MAX_ITEMS items and about MAX_BATCH_BYTES bytes each. */
  private batches(): { add(env: StoredEnvelope): void; flush(): void } {
    let batch: StoredEnvelope[] = [];
    let bytes = 0;
    const flush = () => {
      if (batch.length > 0) this.send({ t: "envelopes", items: batch });
      batch = [];
      bytes = 0;
    };
    return {
      add: (env) => {
        batch.push(env);
        bytes += env.ct.length;
        if (batch.length >= MAX_ITEMS || bytes > MAX_BATCH_BYTES) flush();
      },
      flush
    };
  }
}

function parseRoomSummary(raw: unknown): Map<string, DocSummary> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) v.bad("room.docs");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 100_000) v.bad("room.docs");
  const out = new Map<string, DocSummary>();
  for (const [doc, value] of entries) {
    if (!isDocId(doc)) v.bad("room.docs.id");
    const o = v.obj(value, "room.doc", ["vv", "snaps"]);
    const vv: VersionVector = {};
    for (const [author, clock] of Object.entries(v.idMap(o.vv, "room.vv", "d", 5000))) vv[author] = v.int(clock, "room.vv.clock", 0, Number.MAX_SAFE_INTEGER);
    if (!Array.isArray(o.snaps) || o.snaps.length > 100) v.bad("room.snaps");
    out.set(doc, { vv, snaps: o.snaps.map((key) => v.str(key, "room.snaps.key", 200)) });
  }
  return out;
}

/**
 * A device joining with an invite link has no workspace record yet. It sends its join record, receives the record
 * from genesis, and checks that it is the workspace the link named and that the record knows this invite. Then the
 * caller starts a normal node and session on the same channel.
 */
export class JoinHandshake {
  private versions: SignedVersion[] = [];
  private targetHead = -1;
  private done = false;

  constructor(
    private readonly channel: Channel,
    private readonly workspaceId: string,
    private readonly join: JoinRecord,
    private readonly onChain: (chain: WorkspaceChain) => void,
    private readonly onFail: (reason: string) => void
  ) {}

  start(): void {
    this.channel.send({ t: "join", join: this.join });
  }

  receive(raw: unknown): void {
    if (this.done) return;
    try {
      const message = v.obj(raw, "message", ["t", "ws", "head", "recent", "versions", "joins", "wraps", "rooms", "room", "docs", "blobs", "items", "env", "join"]);
      if (message.t === "hello") {
        if (message.ws !== this.workspaceId) fail("other_workspace");
        this.targetHead = v.int(message.head, "hello.head", 0, MAX_JOIN_VERSIONS);
        this.channel.send({ t: "hello", ws: this.workspaceId, head: -1, recent: [] });
      } else if (message.t === "versions") {
        if (!Array.isArray(message.versions) || message.versions.length > MAX_ITEMS) v.bad("versions");
        if (this.versions.length + message.versions.length > MAX_JOIN_VERSIONS) fail("too_many_versions");
        for (const version of message.versions) this.versions.push(parseSignedVersion(version));
      }
      if (this.targetHead >= 0 && this.versions.length >= this.targetHead + 1) {
        const chain = WorkspaceChain.load(this.versions.slice(0, this.targetHead + 1), Date.now());
        if (chain.workspaceId !== this.workspaceId) fail("other_workspace");
        // The record must know this invite: still open for this join, or already recorded for this device.
        const invite = chain.state.invites[this.join.body.invite];
        if (invite?.used !== this.join.body.device.id) verifyJoinRecord(chain.state, this.workspaceId, this.join, Date.now());
        this.done = true;
        this.onChain(chain);
      }
    } catch (error) {
      this.done = true;
      this.onFail(errorText(error));
    }
  }
}
