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

function lcsDiff(a: string, b: string): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m ? [{ op: "insert", text: b }] : [];
  if (m === 0) return n ? [{ op: "delete", text: a }] : [];

  const dp: Uint32Array[] = new Array(n + 1);
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

  return coalesce(ops);
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
  if (a.length * b.length > MAX_DIFF_CELLS) {
    const ops: DiffOp[] = [];
    if (a) ops.push({ op: "delete", text: a });
    if (b) ops.push({ op: "insert", text: b });
    return ops;
  }
  return lcsDiff(a, b);
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

  let suffix = 0;
  const maxSuffix = Math.min(oldText.length, diskText.length) - prefix;
  while (suffix < maxSuffix && oldText[oldText.length - 1 - suffix] === diskText[diskText.length - 1 - suffix]) {
    suffix++;
  }

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
