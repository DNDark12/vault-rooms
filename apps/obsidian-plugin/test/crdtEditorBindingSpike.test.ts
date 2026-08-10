// @vitest-environment jsdom
//
// Verifies CM6 collaboration and local-only undo behavior.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";

const RELAY_ORIGIN = Symbol("relay");

/** Wires two Y.Docs to relay updates to each other, simulating two peers over a network, without
 *  re-relaying an update back to the peer it just arrived from (which would infinite-loop). */
function relayBidirectionally(docA: Y.Doc, docB: Y.Doc): void {
  docA.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== RELAY_ORIGIN) {
      Y.applyUpdate(docB, update, RELAY_ORIGIN);
    }
  });
  docB.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== RELAY_ORIGIN) {
      Y.applyUpdate(docA, update, RELAY_ORIGIN);
    }
  });
}

function makePeer() {
  const doc = new Y.Doc();
  const text = doc.getText("codemirror");
  const undoManager = new Y.UndoManager(text);
  const view = new EditorView({
    state: EditorState.create({ doc: "", extensions: [yCollab(text, null, { undoManager })] })
  });
  return { doc, text, undoManager, view };
}

function insertAtEnd(view: EditorView, value: string): void {
  const pos = view.state.doc.length;
  view.dispatch({ changes: { from: pos, to: pos, insert: value } });
}

describe("CRDT editor binding spike (y-codemirror.next + CM6)", () => {
  it("propagates a local edit in one peer's editor to the other peer's editor via the CRDT doc", () => {
    const peerA = makePeer();
    const peerB = makePeer();
    relayBidirectionally(peerA.doc, peerB.doc);

    insertAtEnd(peerA.view, "hello");

    expect(peerA.text.toString()).toBe("hello");
    expect(peerB.text.toString()).toBe("hello");
    expect(peerB.view.state.doc.toString()).toBe("hello");

    peerA.view.destroy();
    peerB.view.destroy();
  });

  it("merges concurrent edits made before either side relays, instead of one clobbering the other", () => {
    const peerA = makePeer();
    const peerB = makePeer();
    // Deliberately not relaying yet - simulates both peers editing while offline from each other.

    insertAtEnd(peerA.view, "A-edit");
    insertAtEnd(peerB.view, "B-edit");

    // Now bring them online: relay each side's accumulated state to the other.
    Y.applyUpdate(peerB.doc, Y.encodeStateAsUpdate(peerA.doc), RELAY_ORIGIN);
    Y.applyUpdate(peerA.doc, Y.encodeStateAsUpdate(peerB.doc), RELAY_ORIGIN);

    const converged = peerA.text.toString();
    expect(peerB.text.toString()).toBe(converged);
    expect(converged).toContain("A-edit");
    expect(converged).toContain("B-edit");

    peerA.view.destroy();
    peerB.view.destroy();
  });

  it("scopes undo to the local peer's own edits, without eating a remote edit that arrived in between", () => {
    const peerA = makePeer();
    const peerB = makePeer();
    relayBidirectionally(peerA.doc, peerB.doc);

    insertAtEnd(peerA.view, "X"); // local edit on A, relayed to B
    insertAtEnd(peerB.view, "Y"); // local edit on B, relayed to A

    expect(peerA.text.toString()).toBe("XY");

    const undone = peerA.undoManager.undo();

    expect(undone).not.toBeNull();
    expect(peerA.text.toString()).toBe("Y"); // A's own "X" is undone...
    expect(peerA.text.toString()).toContain("Y"); // ...but B's remote "Y" survives the local undo.

    peerA.view.destroy();
    peerB.view.destroy();
  });
});
