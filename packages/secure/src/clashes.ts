import * as Y from "yjs";
import { INDEX_DOC, type DocId, type SnapshotEnvelope, type UpdateEnvelope } from "./envelope.js";
import { isId } from "./ids.js";
import type { EditResult } from "./replica.js";

/**
 * Clashing whole-note saves (see ReplicaEvents.clash). A note saved outside the editor changes whole lines, each new line
 * put in front of the first character of the line it replaced (see reconcileYTextByLines), so two computers that replace
 * the same line at the same moment can be told from two changing lines next to each other. This finds such clashes, and
 * text typed into a line a save replaced, and settles them: one line is kept, the same on every computer, and what gave
 * way is taken out once its owner has kept a copy (see copyKept).
 */

/** A character's Yjs id. */
interface Id {
  client: number;
  clock: number;
}

/** A run of characters in a document by their Yjs ids. */
export interface IdRange extends Id {
  length: number;
}

/** A run of text put in, and the character it was put in front of (for a changed line: the first of the old one). */
export interface InsertedRun extends IdRange {
  right: Id | null;
}

/** A whole-note save made here (when, ms): what it took out and what it put in. */
export interface FileSave {
  at: number;
  deleted: IdRange[];
  inserted: InsertedRun[];
  /** Lines it put elsewhere as they were (moved, as a plugin moving a card), each with the first character of the old. */
  moved?: Array<{ line: IdRange; from: Id }>;
}

/** A line of a note: its text (without the line break) and its characters (with it). */
export interface Line {
  text: string;
  ranges: IdRange[];
}

/** A run as an update holds it: also its text (none if taken out since). */
interface Run extends InsertedRun {
  text?: string;
  /** Taken out since: what it was can't be seen. */
  gone: boolean;
}

/** What to take out of a note, and the copies its owner keeps first (see Clashes.settle). */
interface Pending {
  /**
   * Lines that gave way, each with the lines it gave way to (`to`): taken out, with what replaced them here since and
   * whatever went inside them, while one of those is still there (never to leave none).
   */
  lines: Array<{ line: IdRange; to: IdRange[] }>;
  /** Other text to take out (typed into a line a save replaced), with whatever went inside it since. */
  out: IdRange[];
  /** A line saved here gave way: the note without the lines it competed with is kept as a copy first. */
  copy: boolean;
  /** Copies to keep first. */
  versions: string[];
  /** What the copies hold (what was to be taken out when they were made): only that is ever taken out. */
  kept: IdRange[];
  /** One more copy was asked for, of what went into it while it waited: only once (someone may go on typing there). */
  extra: boolean;
}

const MAX_FILE_SAVES = 20;
/** Saves are remembered for this many notes at most, for this long (ms), across restarts too (see recentSaves). */
const MAX_SAVED_NOTES = 200;
const SAVE_KEPT_MS = 30 * 24 * 3600_000;
/** Larger saves (a whole note rewritten) aren't remembered: they would cost too much to keep and check. */
const MAX_SAVED_RANGES = 500;
/** All remembered saves together, at most (the oldest notes' are let go first). */
const MAX_SAVED_TOTAL = 20_000;
/** What is remembered of text typed here, per note (the newest), and for how many notes (see typedClash). */
const MAX_TYPED_RANGES = 2_000;
const MAX_TYPED_NOTES = 50;

const key = (id: Id) => `${id.client}:${id.clock}`;
const idOf = (id: Y.ID | null | undefined): Id | null => (id ? { client: id.client, clock: id.clock } : null);
const rangeOf = (item: Y.Item): IdRange => ({ client: item.id.client, clock: item.id.clock, length: item.length });
const inRange = (range: IdRange, id: Id) => id.client === range.client && id.clock >= range.clock && id.clock < range.clock + range.length;

/** A run as it is remembered (of a save, or of text typed here). */
const plain = ({ client, clock, length, right }: InsertedRun): InsertedRun => ({ client, clock, length, right });

/** What an update took out, and the runs of text it put in. */
function decodeRuns(update: Uint8Array): { deleted: IdRange[]; inserted: Run[] } {
  const { ds, structs } = Y.decodeUpdate(update);
  const deleted: IdRange[] = [];
  for (const [client, items] of ds.clients) for (const { clock, len } of items) deleted.push({ client, clock, length: len });
  const inserted: Run[] = [];
  for (const struct of structs) {
    if (!(struct instanceof Y.Item)) continue;
    const text = struct.content instanceof Y.ContentString ? struct.content.str : undefined;
    inserted.push({ ...rangeOf(struct), right: idOf(struct.rightOrigin), text, gone: struct.content instanceof Y.ContentDeleted });
  }
  return { deleted, inserted };
}

/** The index of the first number in a sorted list that is at least `value` (the list's length if none is). */
function firstAtLeast(list: number[], value: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Ranges merged per client, as sorted starts and ends, to look up by binary search. */
type Index = Map<number, { from: number[]; to: number[] }>;

function indexOf(ranges: IdRange[]): Index {
  const byClient = new Map<number, Array<[number, number]>>();
  for (const r of ranges) {
    const list = byClient.get(r.client);
    if (list) list.push([r.clock, r.clock + r.length]);
    else byClient.set(r.client, [[r.clock, r.clock + r.length]]);
  }
  const index: Index = new Map();
  for (const [client, list] of byClient) {
    list.sort((x, y) => x[0] - y[0]);
    const from: number[] = [];
    const to: number[] = [];
    for (const [start, end] of list) {
      if (to.length > 0 && start <= to[to.length - 1]!) {
        to[to.length - 1] = Math.max(to[to.length - 1]!, end);
      } else {
        from.push(start);
        to.push(end);
      }
    }
    index.set(client, { from, to });
  }
  return index;
}

/** The parts of `a` also in `b`. */
function overlap(a: IdRange[], b: Index): IdRange[] {
  const out: IdRange[] = [];
  for (const x of a) {
    const runs = b.get(x.client);
    if (!runs) continue;
    const end = x.clock + x.length;
    for (let i = firstAtLeast(runs.to, x.clock + 1); i < runs.from.length && runs.from[i]! < end; i++) {
      const from = Math.max(x.clock, runs.from[i]!);
      out.push({ client: x.client, clock: from, length: Math.min(end, runs.to[i]!) - from });
    }
  }
  return out;
}

/** `a` without the ids in `b`. */
function minus(a: IdRange[], b: Index): IdRange[] {
  const out: IdRange[] = [];
  for (const x of a) {
    let at = x.clock;
    for (const part of overlap([x], b)) {
      if (part.clock > at) out.push({ client: x.client, clock: at, length: part.clock - at });
      at = part.clock + part.length;
    }
    if (at < x.clock + x.length) out.push({ client: x.client, clock: at, length: x.clock + x.length - at });
  }
  return out;
}

/** Whether an id (or any of `length` ids from it) is in `ranges`. */
function member(ranges: IdRange[]): (id: Id, length?: number) => boolean {
  const index = indexOf(ranges);
  return (id, length = 1) => {
    const runs = index.get(id.client);
    if (!runs) return false;
    const i = firstAtLeast(runs.to, id.clock + 1);
    return i < runs.from.length && runs.from[i]! < id.clock + length;
  };
}

/** A Y.Text's items in document order, deleted ones too. */
function textItems(text: Y.Text): Y.Item[] {
  const items: Y.Item[] = [];
  for (let item = text._start; item; item = item.right) items.push(item);
  return items;
}

/** The character of a live item at `offset` (none for a deleted one, or anything but text). */
const charOf = (item: Y.Item, offset: number): string | undefined => (!item.deleted && item.content instanceof Y.ContentString ? item.content.str[offset] : undefined);

type Store = Y.Doc["store"];

/** Whether any character of `range` is still in the note, by its own items (not by going through the whole note). */
function live(store: Store, range: IdRange): boolean {
  for (let clock = range.clock; clock < range.clock + range.length; ) {
    if (Y.getState(store, range.client) <= clock) return false;
    const item = Y.getItem(store, Y.createID(range.client, clock));
    if (!item.deleted) return true;
    clock = item.id.clock + item.length;
  }
  return false;
}

/** The lines of a note as it is now. */
function linesOf(text: Y.Text): Line[] {
  const lines: Line[] = [];
  let line: Line = { text: "", ranges: [] };
  for (const item of textItems(text)) {
    if (item.deleted || !(item.content instanceof Y.ContentString)) continue;
    const str = item.content.str;
    let from = 0;
    for (let at = str.indexOf("\n"); ; at = str.indexOf("\n", from)) {
      const end = at < 0 ? str.length : at + 1;
      if (end > from) {
        line.text += str.slice(from, at < 0 ? end : at);
        line.ranges.push({ client: item.id.client, clock: item.id.clock + from, length: end - from });
      }
      if (at < 0) break;
      lines.push(line);
      line = { text: "", ranges: [] };
      from = end;
    }
  }
  if (line.ranges.length > 0) lines.push(line);
  return lines;
}

/** The text of a run still in the note, or null if any of it is gone. */
function rangeText(store: Store, range: IdRange): string | null {
  let out = "";
  for (let clock = range.clock; clock < range.clock + range.length; ) {
    if (Y.getState(store, range.client) <= clock) return null;
    const item = Y.getItem(store, Y.createID(range.client, clock));
    if (item.deleted || !(item.content instanceof Y.ContentString)) return null;
    const end = Math.min(item.length, range.clock + range.length - item.id.clock);
    out += item.content.str.slice(clock - item.id.clock, end);
    clock = item.id.clock + end;
  }
  return out;
}

/** Lines a save put elsewhere as they were: each new line whose text is that of an old line (not blank) it took out. */
function movesIn(before: Line[], deleted: IdRange[], inserted: Run[]): Array<{ line: IdRange; from: Id }> {
  const index = indexOf(deleted);
  const size = (ranges: IdRange[]) => ranges.reduce((sum, range) => sum + range.length, 0);
  const gone = new Map<string, Id[]>();
  for (const line of before) {
    if (!line.text.trim() || size(overlap(line.ranges, index)) !== size(line.ranges)) continue;
    const starts = gone.get(line.text);
    if (starts) starts.push(line.ranges[0]!);
    else gone.set(line.text, [line.ranges[0]!]);
  }
  const out: Array<{ line: IdRange; from: Id }> = [];
  if (gone.size === 0) return out;
  for (const run of inserted) {
    let at = 0;
    for (const part of run.text?.split(/(?<=\n)/) ?? []) {
      const from = gone.get(part.endsWith("\n") ? part.slice(0, -1) : part)?.shift();
      if (from) out.push({ line: { client: run.client, clock: run.clock + at, length: part.length }, from: { client: from.client, clock: from.clock } });
      at += part.length;
    }
  }
  return out;
}

/** Whether a line is still in the note, or a line that took its place since (see withInside). */
function stillThere(text: Y.Text, line: IdRange): boolean {
  return live(text.doc!.store, line) || spansOf(text, withInside(text, [line], true, true)).length > 0;
}

/** The losing lines that still have a rival in the note: a line whose rivals are all gone stays (never to leave none). */
function withRivals(text: Y.Text, lines: Pending["lines"]): Pending["lines"] {
  return lines.filter(({ to }) => to.some((winner) => stillThere(text, winner)));
}

/**
 * Where the characters of `ranges` still in a text are: [index, length] spans, last first. Each character counts once,
 * however often (or overlapping) the ranges name it, so taking the spans out never takes anything else.
 */
function spansOf(text: Y.Text, ranges: IdRange[]): Array<[number, number]> {
  const index = indexOf(ranges);
  const spans: Array<[number, number]> = [];
  let at = 0;
  for (const item of textItems(text)) {
    if (item.deleted || !item.countable) continue;
    if (index.has(item.id.client)) for (const part of overlap([rangeOf(item)], index)) spans.push([at + part.clock - item.id.clock, part.length]);
    at += item.length;
  }
  return spans.reverse();
}

/** A note's text (as Y.Text.toString gives it) with the characters of `ranges` taken out, the note itself left as it is. */
function textWithout(text: Y.Text, ranges: IdRange[]): string {
  const index = indexOf(ranges);
  const parts: string[] = [];
  for (const item of textItems(text)) {
    if (item.deleted || !(item.content instanceof Y.ContentString)) continue;
    const str = item.content.str;
    let at = 0;
    if (index.has(item.id.client)) {
      for (const part of overlap([rangeOf(item)], index)) {
        parts.push(str.slice(at, part.clock - item.id.clock));
        at = part.clock - item.id.clock + part.length;
      }
    }
    parts.push(at === 0 ? str : str.slice(at));
  }
  return parts.join("");
}

/**
 * `runs`, and what was put inside one of them since, in turn. For `lines` (runs that are whole lines), what was put in
 * front of a line's first character is before the line; with `replaced`, if the line is gone, it took the line's place
 * (the line changed again) and counts as a line too.
 */
function withInside(text: Y.Text, runs: IdRange[], lines: boolean, replaced = false): IdRange[] {
  if (runs.length === 0) return [];
  const items = textItems(text);
  const store = text.doc!.store;
  const inRuns = member(runs);
  const added = new Set<Y.Item>();
  const inside = (id: Y.ID) => inRuns(id) || (added.size > 0 && added.has(Y.getItem(store, id)));
  const out = [...runs];
  const starts = new Map<string, boolean>(lines ? runs.map((run) => [key(run), !live(store, run)]) : []);
  // Right to left: an item is always left of what it was put in front of, so that is decided first, in one pass.
  for (let k = items.length - 1; k >= 0; k--) {
    const item = items[k]!;
    const right = item.rightOrigin;
    if (!right || inRuns(item.id) || !inside(right)) continue;
    const start = starts.get(key(right));
    if (start !== undefined && !(replaced && start)) continue; // in front of a line: before it
    out.push(rangeOf(item));
    added.add(item);
    if (start === true) starts.set(key(item.id), !live(store, rangeOf(item)));
  }
  return out;
}

/**
 * The characters of the lines that start with one of `starts`, as the text has them now: from that first character on,
 * as long as the characters are `old` (the line's own text, as the other side took it out, and what was typed here
 * inside it), up to and with the line break that ends it (one of `breaks`). A character taken out here counts as well,
 * so a line whose break is already gone here still ends where it did.
 */
function linesFrom(text: Y.Text, starts: Id[], breaks: IdRange[], old: IdRange[]): IdRange[] {
  const isStart = member(starts.map((start) => ({ ...start, length: 1 })));
  const startsBy = new Map<number, number[]>();
  for (const { client, clock } of starts) {
    const list = startsBy.get(client);
    if (list) list.push(clock);
    else startsBy.set(client, [clock]);
  }
  for (const list of startsBy.values()) list.sort((a, b) => a - b);
  const inOld = member(old);
  const isBreak = member(breaks);
  const out: IdRange[] = [];
  let open = false;
  for (const item of textItems(text)) {
    // Only items with a line start in them, or inside a line, are looked at character by character.
    const list = startsBy.get(item.id.client) ?? [];
    let k = firstAtLeast(list, item.id.clock);
    const end = item.id.clock + item.length;
    if (!open && !(k < list.length && list[k]! < end)) continue;
    let from = -1;
    const close = (to: number) => {
      if (from >= 0 && to > from) out.push({ client: item.id.client, clock: item.id.clock + from, length: to - from });
      open = false;
      from = -1;
    };
    for (let i = open ? 0 : list[k]! - item.id.clock; i < item.length; i++) {
      const id = { client: item.id.client, clock: item.id.clock + i };
      if (open && !inOld(id)) close(i);
      if (!open && isStart(id)) open = true;
      if (open && from < 0) from = i;
      if (open && charOf(item, i) === "\n" && isBreak(id)) close(i + 1);
      if (!open) {
        // On to the next line start in this item, if there is one.
        while (k < list.length && list[k]! <= id.clock) k++;
        if (k >= list.length || list[k]! >= end) break;
        i = list[k]! - item.id.clock - 1;
      }
    }
    // A line going on past this item: what of it is here counts, and it goes on in the next.
    if (open) {
      close(item.length);
      open = true;
    }
  }
  return out;
}

/**
 * Text typed here (`typed`) that begins one of the lines that start with `starts`: from a line break (or the start of
 * the note) to that first character, all of it typed here (an indent, "# ").
 */
function typedPrefixes(text: Y.Text, starts: Id[], typed: IdRange[]): IdRange[] {
  const store = text.doc!.store;
  const mine = member(typed);
  const out: IdRange[] = [];
  for (const start of starts) {
    // A line this computer doesn't have yet: nothing was typed in front of it here.
    if (Y.getState(store, start.client) <= start.clock) continue;
    const found: IdRange[] = [];
    let item: Y.Item | null = Y.getItem(store, Y.createID(start.client, start.clock));
    let i = start.clock - item.id.clock;
    let lineStart = false;
    walk: while (item) {
      // A deleted item (or anything but text) is passed over whole.
      for (i--; i >= 0 && !item.deleted && item.countable; i--) {
        if (charOf(item, i) === "\n") {
          lineStart = true;
          break walk;
        }
        const id = { client: item.id.client, clock: item.id.clock + i };
        if (!mine(id)) break walk;
        const last = found[found.length - 1];
        if (last && last.client === id.client && last.clock === id.clock + 1) {
          last.clock--;
          last.length++;
        } else found.push({ ...id, length: 1 });
      }
      item = item.left;
      i = item?.length ?? 0;
    }
    // Only what begins the line: typed text after other text on the same line (two lines joined, say) is no prefix.
    if (lineStart || !item) for (const range of found) out.push(range);
  }
  return out;
}

const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/** Runs of a save read back (from disk), as they must be; `inserted`: each with what it went in front of. */
function validRuns(value: unknown, inserted: boolean): InsertedRun[] | null {
  if (!Array.isArray(value) || value.length > MAX_SAVED_RANGES) return null;
  const out: InsertedRun[] = [];
  for (const run of value as unknown[]) {
    const { client, clock, length, right } = (typeof run === "object" && run !== null ? run : {}) as Record<string, unknown>;
    // Yjs never makes an empty run.
    if (!count(client) || !count(clock) || !count(length) || length === 0) return null;
    if (!inserted || right === null) {
      out.push({ client, clock, length, right: null });
      continue;
    }
    const to = (typeof right === "object" && right !== null ? right : {}) as Record<string, unknown>;
    if (!count(to.client) || !count(to.clock)) return null;
    out.push({ client, clock, length, right: { client: to.client, clock: to.clock } });
  }
  return out;
}

function validSave(value: unknown): FileSave | null {
  const { at, deleted, inserted, moved } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const gone = validRuns(deleted, false);
  const added = validRuns(inserted, true);
  const moves = moved === undefined ? [] : validMoves(moved);
  if (!Number.isSafeInteger(at) || !gone || !added || !moves) return null;
  const save: FileSave = { at: at as number, deleted: gone.map(({ client, clock, length }) => ({ client, clock, length })), inserted: added };
  if (moves.length > 0) save.moved = moves;
  return save;
}

/** The moves of a save read back (see FileSave.moved), as they must be. */
function validMoves(value: unknown): Array<{ line: IdRange; from: Id }> | null {
  if (!Array.isArray(value)) return null;
  const field = (move: unknown, name: "line" | "from") => (typeof move === "object" && move !== null ? (move as Record<string, unknown>)[name] : undefined);
  const lines = validRuns(value.map((move) => field(move, "line")), false);
  const from = validRuns(value.map((move) => ({ ...(field(move, "from") ?? {}), length: 1 })), false);
  return lines && from ? lines.map(({ client, clock, length }, i) => ({ line: { client, clock, length }, from: { client: from[i]!.client, clock: from[i]!.clock } })) : null;
}

/** Add `more` to what is pending for a note (take-outs, or take-outs waiting for their copies). */
function addPending(map: Map<DocId, Pending>, docId: DocId, more: Pending): void {
  const was = map.get(docId);
  map.set(
    docId,
    was
      ? {
          lines: [...was.lines, ...more.lines],
          out: [...was.out, ...more.out],
          copy: was.copy || more.copy,
          versions: [...was.versions, ...more.versions.filter((version) => !was.versions.includes(version))],
          kept: [...was.kept, ...more.kept],
          extra: was.extra || more.extra
        }
      : more
  );
}

/** What Clashes needs of the room's replica. */
export interface ClashHost {
  /** This device: its own envelopes are never checked for clashes. */
  readonly deviceId: string;
  /** A note's text, if the note is loaded. */
  text(docId: DocId): Y.Text | undefined;
  /** The updates held for a note, decrypted (those that can be). */
  heldUpdates(docId: DocId): Iterable<[UpdateEnvelope, Uint8Array]>;
  /** Whether notes can be changed here now (this device may write, and the replica is still running). */
  mayEdit(): boolean;
  /** Change a note as a local edit, in one transaction (see RoomReplica.edit). */
  edit(docId: DocId, change: () => void): EditResult;
  /** See ReplicaEvents.clash. */
  clash(docId: DocId, version: string): boolean | void;
}

/** The clashes of a room's notes, as one device sees them (see the module's comment). */
export class Clashes {
  /** Recent whole-note saves made here, per note, to spot a clash with someone else's. */
  private fileSaves = new Map<DocId, FileSave[]>();
  /** Counts changes to `fileSaves`, so the owner stores them only when they change. */
  private savesVersion = 0;
  /** Text typed here in this session (not whole-note saves), per note: what it took out and put in (see typedClash). */
  private typed = new Map<DocId, { deleted: IdRange[]; inserted: InsertedRun[] }>();
  /** What lost a clash, per note, to take out (see settle). */
  private takeOuts = new Map<DocId, Pending>();
  /** Take-outs waiting for their copies to be kept (see copyKept, retryTakeOuts). */
  private waitingTakeOuts = new Map<DocId, Pending>();
  /** Lines of others found competing with lines saved here, per note: left out of the copy kept (see settle). */
  private rivals = new Map<DocId, IdRange[]>();
  /** A take-out of what lost a clash is being made: not text typed here. */
  private settling = false;
  /** Notes where taking out what lost a clash was refused (no room left, say): not tried again in this session. */
  private unsettled = new Set<DocId>();

  constructor(private readonly host: ClashHost) {}

  /** A local change of a note: a whole-note save (`save`, see RoomReplica.edit), or text typed here. */
  recordLocal(docId: DocId, update: Uint8Array, save: boolean, before?: Line[]): void {
    if (!save && (docId === INDEX_DOC || this.settling)) return;
    const { deleted, inserted } = decodeRuns(update);
    if (save) {
      if (deleted.length + inserted.length > MAX_SAVED_RANGES) return;
      const moved = before ? movesIn(before, deleted, inserted) : [];
      this.rememberSave(docId, { at: Date.now(), deleted, inserted: inserted.map(plain), ...(moved.length > 0 ? { moved } : {}) });
      return;
    }
    const typed = this.typed.get(docId) ?? { deleted: [], inserted: [] };
    // The newest last: the note typed into longest ago is let go first.
    this.typed.delete(docId);
    this.typed.set(docId, typed);
    // The newest ranges only, never more than that at a time (one edit may change a great many).
    for (const range of deleted.slice(-MAX_TYPED_RANGES)) typed.deleted.push(range);
    for (const run of inserted.slice(-MAX_TYPED_RANGES)) typed.inserted.push(plain(run));
    for (const list of [typed.deleted, typed.inserted]) if (list.length > MAX_TYPED_RANGES) list.splice(0, list.length - MAX_TYPED_RANGES);
    for (const oldest of this.typed.keys()) {
      if (this.typed.size <= MAX_TYPED_NOTES) break;
      this.typed.delete(oldest);
    }
  }

  private rememberSave(docId: DocId, save: FileSave): void {
    const saves = [...(this.fileSaves.get(docId) ?? []), save].slice(-MAX_FILE_SAVES);
    this.fileSaves.delete(docId);
    this.fileSaves.set(docId, saves);
    const size = (list: FileSave[]) => list.reduce((sum, one) => sum + one.deleted.length + one.inserted.length + (one.moved?.length ?? 0), 0);
    let total = [...this.fileSaves.values()].reduce((sum, list) => sum + size(list), 0);
    for (const [oldest, list] of this.fileSaves) {
      if (this.fileSaves.size <= MAX_SAVED_NOTES && total <= MAX_SAVED_TOTAL) break;
      total -= size(list);
      this.fileSaves.delete(oldest);
    }
    this.savesVersion++;
  }

  /** A note's lines before a save made here (see recordLocal: a line it puts elsewhere as it was is a move). */
  linesBefore(docId: DocId): Line[] | undefined {
    const text = this.host.text(docId);
    return text ? linesOf(text) : undefined;
  }

  /** Whether saves of a note made here are remembered (its incoming updates are then checked for clashes). */
  hasSaves(docId: DocId): boolean {
    return this.fileSaves.has(docId);
  }

  /** Changes whenever the saves remembered here change (see recentSaves). */
  get savesChanged(): number {
    return this.savesVersion;
  }

  /** Whole-note saves made here lately, for the owner to keep across restarts (see restoreSaves). */
  recentSaves(): Record<DocId, FileSave[]> {
    const since = Date.now() - SAVE_KEPT_MS;
    const out: Record<DocId, FileSave[]> = {};
    for (const [docId, saves] of this.fileSaves) {
      const kept = saves.filter((save) => save.at >= since);
      if (kept.length > 0) out[docId] = kept;
    }
    return out;
  }

  /**
   * Saves made here in an earlier session (see recentSaves). A loaded note they add saves to is checked against what is
   * already held of it, so a clash with a change that came in while this computer was off, or before this call, still
   * counts (one found again changes nothing more). Take-outs waiting for their copies are tried again first.
   */
  restoreSaves(saved: unknown): void {
    this.retryTakeOuts();
    if (typeof saved !== "object" || saved === null) return;
    const since = Date.now() - SAVE_KEPT_MS;
    for (const [docId, list] of Object.entries(saved).slice(-MAX_SAVED_NOTES)) {
      if (!isId(docId, "f") || !Array.isArray(list)) continue;
      const held = this.fileSaves.get(docId) ?? [];
      const known = new Set(held.map((save) => JSON.stringify(save)));
      const saves = list.slice(-MAX_FILE_SAVES).map(validSave).filter((save): save is FileSave => save !== null && save.at >= since && !known.has(JSON.stringify(save)));
      if (saves.length === 0) continue;
      this.fileSaves.set(docId, [...saves, ...held].slice(-MAX_FILE_SAVES));
      this.savesVersion++;
      // A note not loaded yet is checked as it loads.
      if (!this.host.text(docId)) continue;
      for (const [env, bytes] of this.host.heldUpdates(docId)) this.check(docId, env, bytes);
      this.settle(docId);
    }
  }

  /** The owner kept a copy it was asked for (see ReplicaEvents.clash): what waited for it goes, once all of its are kept. */
  copyKept(docId: DocId, version: string): void {
    const waiting = this.waitingTakeOuts.get(docId);
    if (!waiting) return;
    this.waitingTakeOuts.delete(docId);
    this.retry(docId, { ...waiting, versions: waiting.versions.filter((one) => one !== version) });
  }

  /** Take-outs that wait for their copies are asked for them again (the owner is back, say), or go ahead. */
  retryTakeOuts(): void {
    for (const [docId, waiting] of [...this.waitingTakeOuts]) {
      this.waitingTakeOuts.delete(docId);
      this.retry(docId, waiting);
    }
  }

  private retry(docId: DocId, waiting: Pending): void {
    const text = this.host.text(docId);
    if (!text) return;
    const lines = withRivals(text, waiting.lines);
    if (lines.length === 0 && waiting.out.length === 0) return;
    addPending(this.takeOuts, docId, { ...waiting, lines });
    this.settle(docId);
  }

  /** A take-out of what lost a clash is being made (not a change made here by someone). */
  get takingOut(): boolean {
    return this.settling;
  }

  /**
   * Did someone else's save, made at the same moment, replace a line a whole-note save of ours replaced too (a date
   * changed to two different values, say)? Both took the old line out and put their own in front of it (see
   * reconcileYTextByLines), so keeping both would leave the line twice. The line put in by the lower Yjs client id is
   * kept: each computer can tell, from the two lines alone, and the other computer takes its own out again (with any
   * line it later put in its place, and whatever went inside it) and keeps its version as a copy. An update made on one
   * computer in one go holds only its own lines; anything else (a snapshot, content passed on) counts
   * only for the lines this computer didn't have before it came (`known`, its state then), never while a note loads. A
   * line one side changed only in part is merged as it is.
   */
  check(docId: DocId, env: UpdateEnvelope | SnapshotEnvelope, bytes: Uint8Array, known?: Map<number, number>): void {
    const text = this.host.text(docId);
    if (this.unsettled.has(docId) || !text || env.author === this.host.deviceId || (env.k !== "u" && !known)) return;
    let theirs: IdRange[];
    let theirRuns: Run[];
    try {
      ({ deleted: theirs, inserted: theirRuns } = decodeRuns(bytes));
    } catch {
      return;
    }
    const single = env.k === "u" && new Set(theirRuns.map((run) => run.client)).size === 1;
    if (theirs.length === 0 || theirRuns.length === 0 || (!single && !known)) return;
    // The lines it brings that weren't here (from anything but an update made in one go: only whole lines).
    const fresh = single ? theirRuns : theirRuns.filter((t) => t.clock >= (known!.get(t.client) ?? 0) && (t.text?.endsWith("\n") || t.gone));
    const byRight = new Map<string, Run[]>();
    for (const t of fresh) {
      if (!t.right) continue;
      const list = byRight.get(key(t.right));
      if (list) list.push(t);
      else byRight.set(key(t.right), [t]);
    }
    const inTheirs = member(theirs);
    const theirIndex = indexOf(theirs);
    const lost: Array<{ line: IdRange; to: Run[] }> = [];
    const rivals: Run[] = [];
    const beaten: Run[] = [];
    const saves = this.fileSaves.get(docId) ?? [];
    // How far it reaches per writer of the text it holds.
    const reach = new Map<number, number>();
    for (const t of theirRuns) reach.set(t.client, Math.max(reach.get(t.client) ?? 0, t.clock + t.length));
    for (const save of saves) {
      // It holds this save, so the old line may have been taken out by this save alone: a line put in front of it (typed
      // above it, say) can't be told from a rival there.
      if (!single && save.inserted.some((mine) => (reach.get(mine.client) ?? 0) >= mine.clock + mine.length)) continue;
      if (!save.deleted.some((range) => inTheirs(range, range.length))) continue;
      const both = member(overlap(save.deleted, theirIndex));
      for (const run of save.inserted) {
        if (!run.right || !both(run.right)) continue;
        const others = (byRight.get(key(run.right)) ?? []).filter((t) => t.client !== run.client);
        if (others.length === 0) continue;
        // Gives way only to a line still in the note (or one that took its place since): never to leave none.
        const lower = others.filter((t) => t.client < run.client && stillThere(text, t));
        const loses = lower.length > 0;
        // The lines a line of ours lost to count against the copy only if that clash isn't settled yet (see below).
        for (const other of others) if (!(loses ? beaten : rivals).some((r) => Y.compareIDs(r, other))) (loses ? beaten : rivals).push(other);
        if (!loses || lost.some(({ line }) => Y.compareIDs(line, run))) continue;
        lost.push({ line: run, to: lower });
      }
      // A line this save moved (put elsewhere as it was, as a plugin moving a card) that the other side changed where it
      // was, or moved too: one of them stays. The line changed where it was stays (only the computer that moved a line
      // can tell it moved); of two moves, the lower client's. Ours gives way to it, and is kept in the copy.
      for (const { line, from } of save.moved ?? []) {
        if (!inTheirs(from) || lost.some((one) => Y.compareIDs(one.line, line))) continue;
        const moved = rangeText(text.doc!.store, line);
        if (moved === null) continue;
        const changed = (byRight.get(key(from)) ?? []).filter((t) => t.client !== line.client);
        const to = [...changed, ...fresh.filter((t) => t.client < line.client && t.text === moved)].filter((t) => stillThere(text, t));
        if (to.length === 0) continue;
        for (const other of to) if (!beaten.some((r) => Y.compareIDs(r, other))) beaten.push(other);
        lost.push({ line, to });
      }
    }
    this.noteRivals(docId, rivals);
    // A line already waiting to be taken out (for its copy) is that clash, found again: it is settled with it, and gives
    // way to these lines too (the ones it gave way to first may be gone by then, taken out on a third computer, say).
    const waiting = this.waitingTakeOuts.get(docId)?.lines ?? [];
    const losing = lost.filter(({ line, to }) => {
      const one = waiting.find((w) => Y.compareIDs(w.line, line));
      if (!one) return true;
      for (const winner of to) if (!one.to.some((r) => Y.compareIDs(r, winner))) one.to.push(winner);
      return false;
    });
    if (losing.length === 0) return;
    // A losing line goes with whatever went inside it (what was put in front of it since may be a line of its own).
    if (spansOf(text, withInside(text, this.withReplacements(docId, losing.map(({ line }) => line)), true)).length === 0) return; // settled before
    this.noteRivals(docId, beaten);
    this.takeOut(docId, { lines: losing, out: [], copy: true, versions: [], kept: [], extra: false });
  }

  /** `lines` saved here, and those this computer put in place of one of them later (with a save that took it out). */
  private withReplacements(docId: DocId, lines: IdRange[]): IdRange[] {
    const saves = this.fileSaves.get(docId) ?? [];
    const out = [...lines];
    for (let i = 0; i < out.length; i++) {
      const line = out[i]!;
      const gone = member([line]);
      for (const save of saves) {
        if (!save.deleted.some((range) => gone(range, range.length))) continue;
        for (const run of save.inserted) if (run.right && inRange(line, run.right) && !out.some((l) => Y.compareIDs(l, run))) out.push(run);
      }
    }
    return out;
  }

  /** Lines of others found competing with lines saved here: left out of the copy (see settle), until it is made. */
  private noteRivals(docId: DocId, rivals: IdRange[]): void {
    if (rivals.length === 0) return;
    this.rivals.set(docId, [...(this.rivals.get(docId) ?? []), ...rivals]);
    queueMicrotask(() => {
      if (!this.takeOuts.has(docId)) this.rivals.delete(docId);
    });
  }

  private takeOut(docId: DocId, pending: Pending): void {
    addPending(this.takeOuts, docId, pending);
    queueMicrotask(() => this.settle(docId));
  }

  /**
   * Before someone else's update goes in: did it replace a line (a whole-note save, see reconcileYTextByLines) that text
   * typed here at the same moment went into? Then the save's line is kept, the same on both computers (theirs finds no
   * line of its own to give way for): what was typed inside the old line is taken out again here, with whatever went
   * inside that since, and the note as it was here is kept as a copy (see takeOutTyped, once the update is in). What was
   * typed in front of the old line is a line of its own, unless it begins the line (an indent, "# ") and the save's line
   * goes in front of it, which would leave it at the start of the next line. Only text typed in this session counts.
   */
  typedClash(docId: DocId, env: UpdateEnvelope | SnapshotEnvelope, bytes: Uint8Array): { version: string; strays: IdRange[] } | null {
    const typed = this.typed.get(docId);
    const text = this.host.text(docId);
    if (!typed || !text || env.k !== "u" || env.author === this.host.deviceId) return null;
    let theirs: IdRange[];
    let runs: Run[];
    try {
      ({ deleted: theirs, inserted: runs } = decodeRuns(bytes));
    } catch {
      return null;
    }
    if (theirs.length === 0 || new Set(runs.map((run) => run.client)).size !== 1) return null;
    const inTheirs = member(theirs);
    // The lines it replaced, as they are here: each starts with a character one of its lines was put in front of.
    const starts = new Map<string, Id>();
    for (const run of runs) if (run.right && inTheirs(run.right)) starts.set(key(run.right), run.right);
    if (starts.size === 0) return null;
    const typedInside = withInside(text, typed.inserted.filter((run) => run.right && inTheirs(run.right)), false);
    const lines = linesFrom(text, [...starts.values()], theirs, [...theirs, ...typedInside]);
    const inLines = member(lines);
    const inside: IdRange[] = typed.inserted.filter((run) => run.right && inLines(run.right) && !starts.has(key(run.right)) && !inTheirs(run, run.length));
    // Yjs puts the save's line in front of what begins the old line if its client id is the lower one.
    for (const range of typedPrefixes(text, [...starts.values()], typed.inserted)) if (range.client > runs[0]!.client) inside.push(range);
    const strays = inside.length > 0 ? withInside(text, inside, false) : [];
    const live = spansOf(text, strays).length > 0;
    if (!live && !typed.deleted.some((range) => overlap(overlap([range], indexOf(theirs)), indexOf(lines)).length > 0)) return null;
    // Settled here: not counted again for another save of the same line.
    const settled = member(inside);
    typed.inserted = typed.inserted.filter((run) => !settled(run, run.length));
    typed.deleted = typed.deleted.filter((range) => !inTheirs(range, range.length));
    return { version: text.toString(), strays: live ? strays : [] };
  }

  /** The update typedClash looked at is in: what it found is taken out, the note as it was kept as a copy first. */
  takeOutTyped(docId: DocId, found: { version: string; strays: IdRange[] }): void {
    const text = this.host.text(docId);
    if (!text) return;
    // Its copy, the note as it was before that update, holds all of it.
    this.takeOut(docId, { lines: [], out: found.strays, copy: false, versions: found.version === textWithout(text, found.strays) ? [] : [found.version], kept: found.strays, extra: false });
  }

  /**
   * Take out what lost a clash in a note, once its owner has kept the copies (see ReplicaEvents.clash): a copy not kept
   * yet leaves everything in the note until it is (see copyKept).
   */
  settle(docId: DocId): void {
    const pending = this.takeOuts.get(docId);
    const text = this.host.text(docId);
    if (!pending || !text) return;
    this.takeOuts.delete(docId);
    const rivals = this.rivals.get(docId) ?? [];
    this.rivals.delete(docId);
    // Its rivals may be gone since it was found (taken out by an update that came in the same go).
    const lines = withRivals(text, pending.lines);
    if (lines.length === 0 && pending.out.length === 0) return;
    // With what replaced it here since, and whatever went inside it.
    const out = [...withInside(text, this.withReplacements(docId, lines.map(({ line }) => line)), true), ...withInside(text, pending.out, false)];
    // A copy is the note without the lines of others (with what replaced them since, and went inside them), but always
    // with all that goes: a rival noted long ago may have been replaced by a line that loses now.
    const copyWithout = (others: IdRange[]) => textWithout(text, minus(withInside(text, others, true, true), indexOf(out)));
    const versions = [...pending.versions];
    let { kept, extra } = pending;
    if (pending.copy) {
      const version = copyWithout(rivals);
      if (version !== textWithout(text, out)) versions.push(version);
      kept = out;
    } else if (!extra && textWithout(text, out) !== textWithout(text, overlap(out, indexOf(kept)))) {
      // Something went into what gives way while it waited for its copy, which doesn't hold it: one more copy keeps it,
      // once; what goes in after that stays in the note.
      versions.push(copyWithout(lines.flatMap(({ to }) => to)));
      kept = out;
      extra = true;
    }
    // Copies the owner keeps now go; it tells of the others when they are kept (see copyKept), and the rest waits.
    const waiting = versions.filter((version) => this.host.clash(docId, version) === false);
    if (waiting.length > 0 || !this.host.mayEdit()) {
      addPending(this.waitingTakeOuts, docId, { ...pending, lines, copy: false, versions: waiting, kept, extra });
      return;
    }
    // Only what the copies hold.
    const spans = spansOf(text, overlap(out, indexOf(kept)));
    if (spans.length === 0) return;
    // Marked while it runs: a refused edit rebuilds the note, which must not find the same clash and try again.
    this.unsettled.add(docId);
    this.settling = true;
    let result: EditResult;
    try {
      result = this.host.edit(docId, () => {
        for (const [at, length] of spans) text.delete(at, length);
      });
    } finally {
      this.settling = false;
    }
    if (result !== "refused") this.unsettled.delete(docId);
  }
}
