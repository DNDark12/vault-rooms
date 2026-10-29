import { b64u, utf8 } from "./bytes.js";
import { canonicalJson } from "./canonical.js";
import { hashTagged } from "./crypto.js";
import { blobKeyOf, envelopeKey, type BlobEnvelope, type DocId, type SnapshotEnvelope, type StoredEnvelope, type UpdateEnvelope } from "./envelope.js";

/** For each author device, the highest clock up to which every update of a document is held (or was folded into a snapshot here). */
export type VersionVector = Record<string, number>;

export function vvDominates(a: VersionVector, b: VersionVector): boolean {
  return Object.entries(b).every(([author, clock]) => (a[author] ?? 0) >= clock);
}

interface DocEntry {
  updates: Map<string, Map<number, UpdateEnvelope>>;
  snapshots: Map<string, SnapshotEnvelope>;
  /** Per author: every update up to here was held here and is in a kept snapshot, as a member checked (`compact`). */
  marks: VersionVector;
  /** The same on a snapshot's word alone, in rooms this device only relays; dropped if it joins the room. */
  claimed: VersionVector;
  /**
   * Per author: the newest of their snapshots dropped here as checked to be contained in another kept one (see compact).
   * An author's snapshot holds all its earlier ones did, so one up to here is never wanted again: remembering this keeps
   * a dropped snapshot that is still going around the mesh from being taken in and passed on again, forever.
   */
  dropped: VersionVector;
}

/** What is kept in memory of a blob; the ciphertext itself stays in a BlobStorage. */
export interface BlobMeta {
  room: string;
  author: string;
  id: string;
  /** Key epoch it is sealed under. */
  n: number;
  /** Ciphertext length (base64url characters). */
  size: number;
  /** When it arrived here (ms). */
  at: number;
}

/** Where blob ciphertext lives: on disk in the plugin, in memory by default. */
export interface BlobStorage {
  put(env: BlobEnvelope): void;
  get(meta: BlobMeta): Promise<BlobEnvelope | null>;
  remove(meta: BlobMeta): void;
}

export class MemoryBlobs implements BlobStorage {
  private blobs = new Map<string, BlobEnvelope>();

  put(env: BlobEnvelope): void {
    this.blobs.set(`${env.room}/${blobKeyOf(env.author, env.id)}`, env);
  }

  async get(meta: BlobMeta): Promise<BlobEnvelope | null> {
    return this.blobs.get(`${meta.room}/${blobKeyOf(meta.author, meta.id)}`) ?? null;
  }

  remove(meta: BlobMeta): void {
    this.blobs.delete(`${meta.room}/${blobKeyOf(meta.author, meta.id)}`);
  }
}

export type AddResult = "added" | "duplicate" | "conflict" | "quota";

export interface StoreListener {
  added?(env: UpdateEnvelope | SnapshotEnvelope): void;
  /** Envelopes of a document were removed or its marks changed: whatever mirrors it should write it out again. */
  docChanged?(room: string, doc: DocId): void;
  /** The blobs remembered as gone in a room changed. */
  goneChanged?(room: string): void;
}

/** Sizes are in ciphertext characters (base64url: 4 for every 3 bytes). */
export const STORE_LIMITS = {
  /** A room's documents. Past it, new document envelopes for the room are refused. */
  roomDocBytes: 256 << 20,
  /** Blobs of a room this device is in. Past it, new blobs are refused. */
  memberBlobBytes: 4 * 1024 ** 3,
  /** Blobs of a room this device only relays. Past it, the oldest are dropped. */
  relayBlobBytes: 1 << 30,
  /** How long a dropped blob is remembered, so peers don't send it again. */
  goneMs: 90 * 86_400_000
};

/**
 * Encrypted envelopes of every room this peer relays, members or not. Callers verify envelopes (`verifyEnvelope`)
 * before adding them. Documents are kept in memory; blob ciphertext goes to a BlobStorage and only its size is kept.
 *
 * Snapshots compact a document, but what a snapshot says it covers is only its author's claim. In a room this device
 * is in, nothing is dropped on a claim: the replica checks that a snapshot really contains an envelope before it
 * asks to drop it (`compact`). In a room it only relays (it can't decrypt), it takes the claim, but only for the
 * snapshot's own author and only for updates it holds: a lying snapshot can cost the relayed copy of its author's own
 * content, never another member's, never a member's own history, and can't push any counter up.
 */
export class EnvelopeStore {
  private docsByRoom = new Map<string, Map<DocId, DocEntry>>();
  private blobsByRoom = new Map<string, Map<string, BlobMeta>>();
  private goneByRoom = new Map<string, Map<string, number>>();
  private signatures = new Map<string, string>();
  private docBytes = new Map<string, number>();
  private blobBytes = new Map<string, number>();
  /** Whether this device is a member of a room; set by the mesh node. */
  isMember: (room: string) => boolean = () => true;
  private unreadable = new Set<string>();
  now: () => number = Date.now;

  constructor(
    private readonly listener: StoreListener = {},
    readonly blobStorage: BlobStorage = new MemoryBlobs()
  ) {}

  private entry(room: string, doc: DocId): DocEntry {
    let docs = this.docsByRoom.get(room);
    if (!docs) this.docsByRoom.set(room, (docs = new Map()));
    let entry = docs.get(doc);
    if (!entry) docs.set(doc, (entry = { updates: new Map(), snapshots: new Map(), marks: {}, claimed: {}, dropped: {} }));
    return entry;
  }

  private markOf(entry: DocEntry, author: string): number {
    return Math.max(entry.marks[author] ?? 0, entry.claimed[author] ?? 0);
  }

  /**
   * "conflict": an envelope with the same identity but different content (an author equivocating); the first stays.
   * "quota": the room is over its storage limit.
   */
  add(env: StoredEnvelope): AddResult {
    if (env.k === "b") return this.addBlob(env);
    const key = envelopeKey(env);
    const existing = this.signatures.get(key);
    if (existing !== undefined) return existing === env.sig ? "duplicate" : "conflict";
    const entry = this.entry(env.room, env.doc);
    const member = this.isMember(env.room);
    if (env.k === "u") {
      if (env.clock <= this.markOf(entry, env.author)) return "duplicate";
    } else {
      if (env.seq <= (entry.dropped[env.author] ?? 0)) return "duplicate";
      if (!member) for (const kept of entry.snapshots.values()) if (kept.author === env.author && vvDominates(kept.covers, env.covers)) return "duplicate";
    }
    const bytes = this.docBytes.get(env.room) ?? 0;
    if (bytes + env.ct.length > STORE_LIMITS.roomDocBytes) return "quota";
    if (env.k === "u") {
      let byClock = entry.updates.get(env.author);
      if (!byClock) entry.updates.set(env.author, (byClock = new Map()));
      byClock.set(env.clock, env);
    } else {
      entry.snapshots.set(key, env);
    }
    this.docBytes.set(env.room, bytes + env.ct.length);
    this.signatures.set(key, env.sig);
    this.listener.added?.(env);
    if (env.k === "s" && !member) this.compactOnClaim(env.room, env.doc, entry, env);
    return "added";
  }

  /**
   * A relayed room: a snapshot replaces what it claims to cover, but only of its own author (that author's updates
   * held here, and that author's older snapshots). So a lying snapshot can cost a relay at most its author's own
   * content, never another member's.
   */
  private compactOnClaim(room: string, doc: DocId, entry: DocEntry, snapshot: SnapshotEnvelope): void {
    const author = snapshot.author;
    const limit = Math.min(snapshot.covers[author] ?? 0, this.vvOf(entry)[author] ?? 0);
    const remove: StoredEnvelope[] = [];
    const raised = limit > (entry.claimed[author] ?? 0);
    if (raised) {
      for (const [clock, update] of entry.updates.get(author) ?? []) if (clock <= limit) remove.push(update);
      entry.claimed[author] = limit;
    }
    for (const kept of entry.snapshots.values()) if (kept !== snapshot && kept.author === author && vvDominates(snapshot.covers, kept.covers)) remove.push(kept);
    if (!raised && remove.length === 0) return;
    this.removeFrom(room, entry, remove);
    this.listener.docChanged?.(room, doc);
  }

  /**
   * A member checked that a kept snapshot contains each of `remove`: drop them, and remember that each author's updates
   * up to `marks` are folded in (so they aren't fetched again).
   */
  compact(room: string, doc: DocId, remove: StoredEnvelope[], marks: VersionVector): void {
    const entry = this.docsByRoom.get(room)?.get(doc);
    if (!entry) return;
    for (const [author, clock] of Object.entries(marks)) entry.marks[author] = Math.max(entry.marks[author] ?? 0, clock);
    // Each snapshot dropped was checked to be in a kept one: never wanted again (a drop on a mere claim, in a room this
    // device only relays, is forgotten when it joins, like the claim).
    for (const env of remove) if (env.k === "s") entry.dropped[env.author] = Math.max(entry.dropped[env.author] ?? 0, env.seq);
    this.removeFrom(room, entry, remove);
    this.listener.docChanged?.(room, doc);
  }

  private removeFrom(room: string, entry: DocEntry, envs: StoredEnvelope[]): void {
    for (const env of envs) {
      const key = envelopeKey(env);
      if (env.k === "b" || this.signatures.get(key) !== env.sig) continue;
      if (env.k === "u") {
        const byClock = entry.updates.get(env.author);
        byClock?.delete(env.clock);
        if (byClock?.size === 0) entry.updates.delete(env.author);
      } else {
        entry.snapshots.delete(key);
      }
      this.signatures.delete(key);
      this.docBytes.set(room, (this.docBytes.get(room) ?? 0) - env.ct.length);
    }
  }

  /** This device joined the room: forget what it took on snapshots' word, so that is fetched again and checked. */
  distrustClaims(room: string): void {
    for (const [doc, entry] of this.docsByRoom.get(room) ?? []) {
      if (Object.keys(entry.claimed).length === 0) continue;
      entry.claimed = {};
      this.listener.docChanged?.(room, doc);
    }
  }

  /**
   * Whether part of a document's history on this device couldn't be read yet (its file was in use, say): until it is,
   * the document is incomplete here (see RoomReplica.isComplete), and nothing is decided on the rest of it.
   */
  isUnreadable(room: string, doc: DocId): boolean {
    return this.unreadable.size > 0 && this.unreadable.has(`${room}\u0000${doc}`);
  }

  setUnreadable(room: string, doc: DocId, unreadable: boolean): void {
    if (unreadable) this.unreadable.add(`${room}\u0000${doc}`);
    else this.unreadable.delete(`${room}\u0000${doc}`);
  }

  /** A document's marks, for saving next to its envelopes. */
  marksOf(room: string, doc: DocId): { marks: VersionVector; claimed: VersionVector; dropped: VersionVector } {
    const entry = this.docsByRoom.get(room)?.get(doc);
    return { marks: { ...(entry?.marks ?? {}) }, claimed: { ...(entry?.claimed ?? {}) }, dropped: { ...(entry?.dropped ?? {}) } };
  }

  /** Put saved marks back (loading from disk). */
  restoreMarks(room: string, doc: DocId, marks: VersionVector, claimed: VersionVector, dropped: VersionVector = {}): void {
    const entry = this.entry(room, doc);
    for (const [author, clock] of Object.entries(marks)) entry.marks[author] = Math.max(entry.marks[author] ?? 0, clock);
    for (const [author, clock] of Object.entries(claimed)) entry.claimed[author] = Math.max(entry.claimed[author] ?? 0, clock);
    for (const [author, seq] of Object.entries(dropped)) entry.dropped[author] = Math.max(entry.dropped[author] ?? 0, seq);
  }

  has(env: StoredEnvelope): boolean {
    if (env.k === "b") return this.blobsByRoom.get(env.room)?.has(blobKeyOf(env.author, env.id)) ?? false;
    return this.signatures.has(envelopeKey(env));
  }

  rooms(): string[] {
    return [...new Set([...this.docsByRoom.keys(), ...this.blobsByRoom.keys()])].sort();
  }

  docs(room: string): DocId[] {
    return [...(this.docsByRoom.get(room)?.keys() ?? [])].sort();
  }

  private vvOf(entry: DocEntry): VersionVector {
    const vv: VersionVector = {};
    for (const author of new Set([...entry.updates.keys(), ...Object.keys(entry.marks), ...Object.keys(entry.claimed)])) {
      let clock = this.markOf(entry, author);
      const byClock = entry.updates.get(author);
      while (byClock?.has(clock + 1)) clock++;
      if (clock > 0) vv[author] = clock;
    }
    return vv;
  }

  /** What this device has of a document: per author, marks, then consecutive updates after them. */
  vv(room: string, doc: DocId): VersionVector {
    const entry = this.docsByRoom.get(room)?.get(doc);
    return entry ? this.vvOf(entry) : {};
  }

  /**
   * The highest counter `author` is known to have used for a document, to continue numbering after a restart. Only
   * what can be trusted for that author counts: updates held, marks, and that author's own snapshots.
   */
  maxClock(room: string, doc: DocId, author: string): number {
    const entry = this.docsByRoom.get(room)?.get(doc);
    if (!entry) return 0;
    let max = this.markOf(entry, author);
    for (const snapshot of entry.snapshots.values()) if (snapshot.author === author) max = Math.max(max, snapshot.covers[author] ?? 0);
    for (const clock of entry.updates.get(author)?.keys() ?? []) max = Math.max(max, clock);
    return max;
  }

  maxSnapshotSeq(room: string, doc: DocId, author: string): number {
    let max = this.docsByRoom.get(room)?.get(doc)?.dropped[author] ?? 0;
    for (const snapshot of this.docsByRoom.get(room)?.get(doc)?.snapshots.values() ?? []) if (snapshot.author === author) max = Math.max(max, snapshot.seq);
    return max;
  }

  /** The authors of a document's envelopes held here (with repeats). */
  authorsOf(room: string, doc: DocId): string[] {
    const entry = this.docsByRoom.get(room)?.get(doc);
    return entry ? [...entry.updates.keys(), ...[...entry.snapshots.values()].map((snapshot) => snapshot.author)] : [];
  }

  /** Everything held for a document: snapshots, then updates in clock order per author. */
  envelopesOf(room: string, doc: DocId): { snapshots: SnapshotEnvelope[]; updates: UpdateEnvelope[] } {
    const entry = this.docsByRoom.get(room)?.get(doc);
    if (!entry) return { snapshots: [], updates: [] };
    const updates = [...entry.updates.values()].flatMap((byClock) => [...byClock.values()].sort((a, b) => a.clock - b.clock));
    return { snapshots: [...entry.snapshots.values()], updates };
  }

  /** Updates a peer that holds `theirs` lacks (snapshots go by key, see the room summary). */
  missingFor(room: string, doc: DocId, theirs: VersionVector): UpdateEnvelope[] {
    return this.envelopesOf(room, doc).updates.filter((u) => u.clock > (theirs[u.author] ?? 0));
  }

  snapshotKeys(room: string, doc: DocId): string[] {
    return [...(this.docsByRoom.get(room)?.get(doc)?.snapshots.keys() ?? [])].sort();
  }

  snapshotByKey(room: string, doc: DocId, key: string): SnapshotEnvelope | undefined {
    return this.docsByRoom.get(room)?.get(doc)?.snapshots.get(key);
  }

  // ---- blobs ----

  private addBlob(env: BlobEnvelope): AddResult {
    const key = blobKeyOf(env.author, env.id);
    const blobs = this.blobsByRoom.get(env.room);
    if (blobs?.has(key) || this.goneByRoom.get(env.room)?.has(key)) return "duplicate";
    const member = this.isMember(env.room);
    const limit = member ? STORE_LIMITS.memberBlobBytes : STORE_LIMITS.relayBlobBytes;
    const over = (this.blobBytes.get(env.room) ?? 0) + env.ct.length - limit;
    if (over > 0 && (member || !this.dropOldest(env.room, over))) return "quota";
    this.keepBlob({ room: env.room, author: env.author, id: env.id, n: env.n, size: env.ct.length, at: this.now() });
    this.blobStorage.put(env);
    return "added";
  }

  private keepBlob(meta: BlobMeta): void {
    let blobs = this.blobsByRoom.get(meta.room);
    if (!blobs) this.blobsByRoom.set(meta.room, (blobs = new Map()));
    blobs.set(blobKeyOf(meta.author, meta.id), meta);
    this.blobBytes.set(meta.room, (this.blobBytes.get(meta.room) ?? 0) + meta.size);
  }

  /** Put back a blob found on disk at startup (its ciphertext stays there). */
  restoreBlob(meta: BlobMeta): void {
    if (!this.blobsByRoom.get(meta.room)?.has(blobKeyOf(meta.author, meta.id))) this.keepBlob(meta);
  }

  /** Put back blobs remembered as gone. */
  restoreGone(room: string, entries: Array<[string, number]>): void {
    let gone = this.goneByRoom.get(room);
    if (!gone) this.goneByRoom.set(room, (gone = new Map()));
    for (const [key, at] of entries) gone.set(key, at);
  }

  /** Make room for `bytes` more in a relayed room by dropping its oldest blobs. */
  private dropOldest(room: string, bytes: number): boolean {
    const oldest = [...(this.blobsByRoom.get(room)?.values() ?? [])].sort((a, b) => a.at - b.at);
    const drop: string[] = [];
    let freed = 0;
    for (const meta of oldest) {
      if (freed >= bytes) break;
      drop.push(blobKeyOf(meta.author, meta.id));
      freed += meta.size;
    }
    if (freed < bytes) return false;
    this.dropBlobs(room, drop);
    return true;
  }

  /** Drop blobs for good, remembering them as gone so peers don't send them again. */
  dropBlobs(room: string, keys: string[]): void {
    const blobs = this.blobsByRoom.get(room);
    if (!blobs || keys.length === 0) return;
    let gone = this.goneByRoom.get(room);
    if (!gone) this.goneByRoom.set(room, (gone = new Map()));
    for (const key of keys) {
      const meta = blobs.get(key);
      if (!meta) continue;
      blobs.delete(key);
      this.blobBytes.set(room, (this.blobBytes.get(room) ?? 0) - meta.size);
      gone.set(key, this.now());
      this.blobStorage.remove(meta);
    }
    this.listener.goneChanged?.(room);
  }

  /** A file needs a blob dropped earlier: forget that it is gone, so a peer can send it again. */
  undrop(room: string, key: string): void {
    if (this.goneByRoom.get(room)?.delete(key)) this.listener.goneChanged?.(room);
  }

  blob(room: string, author: string, id: string): BlobMeta | undefined {
    return this.blobsByRoom.get(room)?.get(blobKeyOf(author, id));
  }

  /** The ciphertext of a blob held here, or null. */
  async loadBlob(room: string, author: string, id: string): Promise<BlobEnvelope | null> {
    const meta = this.blob(room, author, id);
    return meta ? this.blobStorage.get(meta) : null;
  }

  /** Blobs held, as "author/id". */
  blobKeys(room: string): string[] {
    return [...(this.blobsByRoom.get(room)?.keys() ?? [])].sort();
  }

  blobsOf(room: string): BlobMeta[] {
    return [...(this.blobsByRoom.get(room)?.values() ?? [])];
  }

  /** Blobs dropped here within STORE_LIMITS.goneMs, as "author/id" with when. */
  gone(room: string): Array<[string, number]> {
    const gone = this.goneByRoom.get(room);
    if (!gone) return [];
    const cutoff = this.now() - STORE_LIMITS.goneMs;
    for (const [key, at] of gone) if (at < cutoff) gone.delete(key);
    return [...gone].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** A short summary of a room's exact contents; two peers with equal digests hold the same envelopes. */
  digest(room: string): string {
    const parts = this.docs(room).map((doc) => {
      const entry = this.docsByRoom.get(room)!.get(doc)!;
      const updates = [...entry.updates].map(([author, byClock]) => [author, [...byClock.keys()].sort((a, b) => a - b)]).sort();
      return [doc, updates, this.snapshotKeys(room, doc)];
    });
    return b64u(hashTagged("room-digest", utf8(canonicalJson({ docs: parts, blobs: this.blobKeys(room) }))));
  }
}
