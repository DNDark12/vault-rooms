import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { computeTextDiff, reconcileYTextWithDiskText } from "./crdtReconcile.js";

/** Reconstructs the target text from a diff's ops, so tests can assert correctness without
 *  depending on any particular (equally-valid) minimal edit script - only that applying the script
 *  actually reproduces the target text. */
function applyDiff(ops: ReturnType<typeof computeTextDiff>): string {
  let result = "";
  for (const op of ops) {
    if (op.op !== "delete") {
      result += op.text;
    }
  }
  return result;
}

describe("computeTextDiff", () => {
  it("returns no ops for identical strings (except a single equal op for non-empty text)", () => {
    expect(computeTextDiff("", "")).toEqual([]);
    expect(computeTextDiff("same", "same")).toEqual([{ op: "equal", text: "same" }]);
  });

  it("captures a pure insertion", () => {
    const ops = computeTextDiff("hello", "hello world");
    expect(applyDiff(ops)).toBe("hello world");
  });

  it("captures a pure deletion", () => {
    const ops = computeTextDiff("hello world", "hello");
    expect(applyDiff(ops)).toBe("hello");
  });

  it("captures a replacement in the middle", () => {
    const ops = computeTextDiff("the cat sat", "the dog sat");
    expect(applyDiff(ops)).toBe("the dog sat");
  });

  it("captures two separately-edited regions without collapsing them into one big replacement", () => {
    const oldText = "AAAA middle BBBB";
    const newText = "XXXX middle YYYY";
    const ops = computeTextDiff(oldText, newText);
    expect(applyDiff(ops)).toBe(newText);
    // A real multi-region diff keeps "middle" as a shared equal op distinct from the two edited
    // regions - a naive whole-span replacement would instead emit one delete + one insert covering
    // everything including "middle".
    expect(ops.some((op) => op.op === "equal" && op.text.includes("middle"))).toBe(true);
  });

  it("falls back to a coarse (but still correct) delete+insert for a pathologically large differing region", () => {
    const oldText = "a".repeat(2000);
    const newText = "b".repeat(2000);
    const ops = computeTextDiff(oldText, newText);
    expect(applyDiff(ops)).toBe(newText);
  });
});

describe("reconcileYTextWithDiskText", () => {
  function docWithText(initial: string): { doc: Y.Doc; text: Y.Text } {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    if (initial) text.insert(0, initial);
    return { doc, text };
  }

  it("is a no-op when disk text already matches - does not grow the update log", () => {
    const { doc, text } = docWithText("hello world");
    const before = Y.encodeStateAsUpdate(doc);

    const changed = reconcileYTextWithDiskText(text, "hello world", null);

    expect(changed).toBe(false);
    expect(text.toString()).toBe("hello world");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("applies a disk-side edit made while no doc was bound", () => {
    const { text } = docWithText("hello world");

    const changed = reconcileYTextWithDiskText(text, "hello CRDT world", null);

    expect(changed).toBe(true);
    expect(text.toString()).toBe("hello CRDT world");
  });

  it("preserves a concurrent remote edit made on another peer while reconciling a local disk change", () => {
    const { doc: docA, text: textA } = docWithText("shared start");
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = docB.getText("content");

    // Peer A reconciles a local disk edit (offline) ...
    reconcileYTextWithDiskText(textA, "shared start + offline edit", null);
    // ... while peer B makes its own remote edit concurrently.
    textB.insert(textB.length, " + remote edit");

    // Reconnect: relay each side's full state to the other (mirrors the Phase 0.3 spike).
    const RELAY_ORIGIN = Symbol("relay");
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA), RELAY_ORIGIN);
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB), RELAY_ORIGIN);

    expect(textA.toString()).toBe(textB.toString());
    expect(textA.toString()).toContain("offline edit");
    expect(textA.toString()).toContain("remote edit");
  });

  it("applies origin tagging so the caller can distinguish reconcile-driven updates from other origins", () => {
    const { doc, text } = docWithText("hello");
    const origins: unknown[] = [];
    doc.on("update", (_update: Uint8Array, origin: unknown) => origins.push(origin));

    const LOCAL_ORIGIN = Symbol("local-reconcile");
    reconcileYTextWithDiskText(text, "hello world", LOCAL_ORIGIN);

    expect(origins).toEqual([LOCAL_ORIGIN]);
  });

  // Deterministic PRNG (mulberry32) so a failure is reproducible - the seed is printed on failure
  // rather than depending on Math.random(), per the plan's "fixed seed, prints the seed on failure"
  // requirement for this reconciliation property test.
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const ALPHABET = "abcde \n";

  function randomText(rand: () => number, length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) {
      out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
    }
    return out;
  }

  function mutate(rand: () => number, text: string): string {
    if (!text) return randomText(rand, 5);
    const start = Math.floor(rand() * text.length);
    const deleteLen = Math.floor(rand() * Math.min(5, text.length - start));
    const insertLen = Math.floor(rand() * 6);
    return text.slice(0, start) + randomText(rand, insertLen) + text.slice(start + deleteLen);
  }

  const FIXED_SEED = 424242;

  it(`converges to the exact target text across randomized reconciles (fixed seed ${FIXED_SEED})`, () => {
    const rand = mulberry32(FIXED_SEED);
    try {
      let current = randomText(rand, 20);
      const { text } = docWithText(current);
      for (let iteration = 0; iteration < 200; iteration++) {
        const next = mutate(rand, current);
        reconcileYTextWithDiskText(text, next, null);
        expect(text.toString()).toBe(next);
        current = next;
      }
    } catch (error) {
      console.error(`crdtReconcile fuzz test failed with seed ${FIXED_SEED}`);
      throw error;
    }
  });
});
