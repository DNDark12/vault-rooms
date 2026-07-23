// Phase 0.3 spike (docs/superpowers/plans/2026-07-20-crdt-sync.md) - retires spec open question 2:
// does persisting the *full Yjs CRDT state* (not just a text baseline + hash) across a simulated
// restart let a client (a) avoid duplicating content when disk is unchanged, (b) reconcile a disk
// edit that happened while no editor/doc was bound (another app, or the plugin was disabled), and
// (c) still converge with a concurrent remote edit that arrived while this peer was "offline"?
//
// This directly informs contract 1.12 (pick ONE persistence strategy). The spike below tests
// strategy A (full Yjs persistence: `Y.encodeStateAsUpdate(doc)` saved and reloaded) rather than
// strategy B (baseline text + state vector only), because reconstructing the actual CRDT op history
// sidesteps the ambiguity a text-only baseline has (a text-only baseline can tell you *that* content
// changed, but the reconstructed doc's internal item/clock structure after a naive "seed a fresh
// Y.Doc from the baseline text" is a *different* CRDT identity than the original doc ever had, which
// is the "seed-then-merge duplicates content" trap the spec warns about). Full-state persistence
// avoids that entirely: the reloaded doc IS the original CRDT identity, just resumed.
//
// This is a spike/prototype (not the production module - that's apps/obsidian-plugin/src/
// crdtDocStore.ts and crdtReconcile.ts in Phase 5), but it is a real, working proof of the
// approach, not a thought experiment.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

const RELAY_ORIGIN = Symbol("relay");

/** Minimal common-prefix/common-suffix text diff, sufficient to prove the reconciliation approach
 *  for this spike. Production Phase 5 should use a real diff library (diff-match-patch or similar)
 *  for correctness on multi-region edits - this handles the single-edit-region case the spec's
 *  "external app changed the file" scenario actually produces. */
function applyTextDeltaToYText(ytext: Y.Text, newText: string, origin: unknown): void {
  const oldText = ytext.toString();
  if (oldText === newText) return;

  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(oldText.length, newText.length) - prefix;
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }

  const deleteLength = oldText.length - prefix - suffix;
  const insertText = newText.slice(prefix, newText.length - suffix);

  ytext.doc?.transact(() => {
    if (deleteLength > 0) ytext.delete(prefix, deleteLength);
    if (insertText.length > 0) ytext.insert(prefix, insertText);
  }, origin);
}

describe("CRDT persistence + offline reconciliation spike (strategy A: full Yjs state)", () => {
  it("restarting with an unchanged disk file does not duplicate content", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "hello world");

    // Simulate persisting full CRDT state to disk/storage.
    const persisted = Y.encodeStateAsUpdate(doc);

    // Simulate a restart: fresh in-memory Y.Doc, reconstruct from the persisted state.
    const restarted = new Y.Doc();
    Y.applyUpdate(restarted, persisted);
    const restartedText = restarted.getText("content");

    // Disk is unchanged (matches what was persisted) - reconciliation must be a no-op.
    applyTextDeltaToYText(restartedText, "hello world", null);

    expect(restartedText.toString()).toBe("hello world");
    // Re-encoding after a no-op reconcile should not have grown the update log with a spurious
    // delete+reinsert of the whole string - only the identical original insert operation exists.
    expect(Y.encodeStateAsUpdate(restarted).length).toBeLessThanOrEqual(persisted.length + 8);
  });

  it("reconciles a disk edit that happened while no doc was bound (external app / plugin disabled)", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "hello world");
    const persisted = Y.encodeStateAsUpdate(doc);

    // "Restart" with the doc gone from memory, reconstructed from persisted state...
    const restarted = new Y.Doc();
    Y.applyUpdate(restarted, persisted);
    const restartedText = restarted.getText("content");

    // ...but the actual vault file on disk was edited by something that doesn't speak CRDT while
    // the doc was unbound - simulate that divergence.
    const diskText = "hello CRDT world";

    applyTextDeltaToYText(restartedText, diskText, null);

    expect(restartedText.toString()).toBe(diskText);
  });

  it("an offline-reconciled local edit and a concurrent remote edit both survive after reconnect", () => {
    const docA = new Y.Doc();
    const textA = docA.getText("content");
    textA.insert(0, "shared start");
    const persistedA = Y.encodeStateAsUpdate(docA);

    // Peer B is a live remote peer that already has the same starting state.
    const docB = new Y.Doc();
    Y.applyUpdate(docB, persistedA);
    const textB = docB.getText("content");

    // Peer A "goes offline": simulate restart from persisted state (identity preserved)...
    const restartedA = new Y.Doc();
    Y.applyUpdate(restartedA, persistedA);
    const restartedTextA = restartedA.getText("content");
    // ...and while offline, disk changed underneath it (external edit at the end).
    applyTextDeltaToYText(restartedTextA, "shared start + offline edit", null);

    // Meanwhile, peer B made its own remote edit while A was offline (also at the end, so this
    // exercises real concurrent-tail-insert merge behavior, not just independent regions).
    textB.insert(textB.length, " + remote edit");

    // Reconnect: relay each side's full state to the other.
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(restartedA), RELAY_ORIGIN);
    Y.applyUpdate(restartedA, Y.encodeStateAsUpdate(docB), RELAY_ORIGIN);

    const convergedA = restartedTextA.toString();
    const convergedB = textB.toString();

    expect(convergedA).toBe(convergedB);
    expect(convergedA).toContain("offline edit");
    expect(convergedA).toContain("remote edit");
  });
});
