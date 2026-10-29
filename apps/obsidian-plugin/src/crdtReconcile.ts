import type * as Y from "yjs";

/**
 * Text reconciliation (contract 1.12, blocker 2). Productionizes the Phase 0.3 spike
 * (crdtPersistenceReconcileSpike.test.ts), whose own comment flagged its diff as "sufficient to
 * prove the approach for the single-edit-region case" and recommended a real diff algorithm for
 * multi-region edits in production. This upgrades it: common-prefix/suffix trimming (unchanged from
 * the spike - it's the cheap, common case) followed by a proper LCS-based diff of the remaining
 * middle region, so two or more separately-edited regions in the same reconcile are each captured
 * as their own minimal insert/delete instead of being collapsed into one delete-everything-then-
 * insert-everything replacement of the whole middle span.
 *
 * Deliberately hand-rolled rather than adding a diff-match-patch-style dependency: this repo already
 * grew its bundle-scan surface once for yjs/y-codemirror.next (Phase 0.1), and a classic LCS diff
 * bounded by a cell-count cap (see MAX_DIFF_CELLS) is simple enough to verify correct by direct unit
 * test (including a fixed-seed fuzz test - see crdtReconcile.test.ts) without pulling in another
 * dependency to scan.
 */

export type DiffOp = { op: "equal" | "delete" | "insert"; text: string };

/** Above this many (oldMid.length * newMid.length) cells, the O(N*M) DP table below would cost too
 *  much time/memory for a rare pathological case (e.g. a file rewritten in full while offline with
 *  no shared prefix/suffix at all). Falls back to a coarse-but-still-correct single delete+insert of
 *  the whole differing region - still converges, just without minimal per-region granularity. */
const MAX_DIFF_CELLS = 1_000_000;

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** One op per element of `a` and `b` (code points, or lines); past MAX_DIFF_CELLS, all of `a` out and all of `b` in. */
function lcsOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > MAX_DIFF_CELLS) return [...a.map((text) => ({ op: "delete" as const, text })), ...b.map((text) => ({ op: "insert" as const, text }))];

  const dp: Uint32Array[] = new Array<Uint32Array>(n + 1);
  for (let i = 0; i <= n; i++) {
    dp[i] = new Uint32Array(m + 1);
  }
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const nextRow = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? nextRow[j + 1]! + 1 : Math.max(nextRow[j]!, row[j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: "equal", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ op: "delete", text: a[i]! });
      i++;
    } else {
      ops.push({ op: "insert", text: b[j]! });
      j++;
    }
  }
  while (i < n) {
    ops.push({ op: "delete", text: a[i]! });
    i++;
  }
  while (j < m) {
    ops.push({ op: "insert", text: b[j]! });
    j++;
  }
  return ops;
}

function coalesce(ops: DiffOp[]): DiffOp[] {
  const coalesced: DiffOp[] = [];
  for (const op of ops) {
    const last = coalesced[coalesced.length - 1];
    if (last && last.op === op.op) {
      last.text += op.text;
    } else {
      coalesced.push({ ...op });
    }
  }
  return coalesced;
}

/** Computes a minimal (or, for pathologically large differing regions, a coarser but still correct)
 *  edit script turning `a` into `b`. Exported standalone so it can be unit-tested independent of
 *  Yjs/Y.Text. */
export function computeTextDiff(a: string, b: string): DiffOp[] {
  if (a === b) {
    return a ? [{ op: "equal", text: a }] : [];
  }
  // Too large to diff: all of `a` out and all of `b` in, whole (one op per code point would cost a lot here).
  if (a.length * b.length > MAX_DIFF_CELLS) return [...(a ? [{ op: "delete" as const, text: a }] : []), ...(b ? [{ op: "insert" as const, text: b }] : [])];
  // By code points (not UTF-16 units), so an edit never splits a surrogate pair (an emoji, say) in two.
  return coalesce(lcsOps(Array.from(a), Array.from(b)));
}

/**
 * Reconciles a Y.Text's content with independently-obtained `diskText` by computing a diff and
 * applying it as Yjs operations tagged with `origin`, inside a single transaction. Trims the common
 * prefix/suffix first (as the spike did - the cheap, common "single edit region" case), then runs
 * `computeTextDiff` on whatever's left in the middle, so multiple separately-edited regions are each
 * captured as their own minimal insert/delete rather than being flattened into one big replacement.
 *
 * Returns `false` (and applies nothing) when `diskText` already matches the Y.Text's current
 * content - the "restart with unchanged disk is a no-op" property the Phase 0.3 spike verified must
 * hold, otherwise every reconcile would spuriously grow the update log with a delete+reinsert of
 * content that never actually changed.
 */
export function reconcileYTextWithDiskText(ytext: Y.Text, diskText: string, origin: unknown): boolean {
  const oldText = ytext.toString();
  if (oldText === diskText) {
    return false;
  }

  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, diskText.length);
  while (prefix < maxPrefix && oldText[prefix] === diskText[prefix]) {
    prefix++;
  }
  // Never cut a surrogate pair (an emoji, say) in two: half of one can't be stored or sent.
  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) prefix--;

  let suffix = 0;
  const maxSuffix = Math.min(oldText.length, diskText.length) - prefix;
  while (suffix < maxSuffix && oldText[oldText.length - 1 - suffix] === diskText[diskText.length - 1 - suffix]) {
    suffix++;
  }
  if (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))) suffix--;

  const oldMid = oldText.slice(prefix, oldText.length - suffix);
  const newMid = diskText.slice(prefix, diskText.length - suffix);
  const ops = computeTextDiff(oldMid, newMid);

  const doc = ytext.doc;
  const apply = (): void => {
    let pos = prefix;
    for (const op of ops) {
      if (op.op === "equal") {
        pos += op.text.length;
      } else if (op.op === "delete") {
        ytext.delete(pos, op.text.length);
      } else {
        ytext.insert(pos, op.text);
        pos += op.text.length;
      }
    }
  };
  if (doc) {
    doc.transact(apply, origin);
  } else {
    // Not attached to a doc yet (e.g. a bare Y.Text in a unit test) - apply directly, matching how
    // Y.Text's own mutators behave when called outside a transaction.
    apply();
  }
  return true;
}

/**
 * Like reconcileYTextWithDiskText, for a whole note saved outside the editor (by another program, or a plugin writing
 * a date). Lines are compared by their text, and each changed line is replaced whole: the new line is put in right
 * before the old, which is then taken out. Yjs remembers what an insertion was put in front of,
 * so each new line stays tied to the line it replaced: two computers that change the same line at the same moment can
 * be told from two changing lines next to each other (see RoomReplica, clashing saves). Lines added or removed touch
 * no other line, at the end of a note too, with or without a final line break.
 */
export function reconcileYTextByLines(ytext: Y.Text, text: string, origin: unknown): boolean {
  const oldText = ytext.toString();
  if (oldText === text) return false;
  const a = oldText.split("\n");
  const b = text.split("\n");
  const last = a.length - 1;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[last - suffix] === b[b.length - 1 - suffix]) suffix++;
  const oldMid = a.slice(prefix, a.length - suffix);
  const newMid = b.slice(prefix, b.length - suffix);
  const ops = lcsOps(oldMid, newMid);
  const apply = (): void => {
    // `line`: the next old line; `pos`: where it starts now (or the end of the text, past the last one).
    let line = prefix;
    let pos = 0;
    for (let k = 0; k < prefix; k++) pos += a[k]!.length + (k < last ? 1 : 0);
    for (let i = 0; i < ops.length; ) {
      if (ops[i]!.op === "equal") {
        pos += a[line]!.length + (line < last ? 1 : 0);
        line++;
        i++;
        continue;
      }
      const gone: string[] = [];
      const added: string[] = [];
      for (; i < ops.length && ops[i]!.op !== "equal"; i++) (ops[i]!.op === "delete" ? gone : added).push(ops[i]!.text);
      const pairs = Math.min(gone.length, added.length);
      for (let k = 0; k < pairs; k++) {
        // With its line break (the last line has none): two computers that changed the same line, if both are kept,
        // leave two whole lines, never one run together.
        const end = line < last ? 1 : 0;
        ytext.insert(pos, end ? `${added[k]}\n` : added[k]!);
        ytext.delete(pos + added[k]!.length + end, gone[k]!.length + end);
        pos += added[k]!.length + end;
        line++;
      }
      for (let k = pairs; k < gone.length; k++) {
        // A line taken out goes with one line break: its own, or (the last line) the one before it.
        if (line < last) ytext.delete(pos, gone[k]!.length + 1);
        else if (pos > 0) ytext.delete(--pos, gone[k]!.length + 1);
        else ytext.delete(pos, gone[k]!.length);
        line++;
      }
      for (let k = pairs; k < added.length; k++) {
        // A new line goes before the next old line, or after a new line break at the end.
        const inserted = line <= last ? `${added[k]}\n` : `\n${added[k]}`;
        ytext.insert(pos, inserted);
        pos += inserted.length;
      }
    }
  };
  if (ytext.doc) ytext.doc.transact(apply, origin);
  else apply();
  return true;
}
