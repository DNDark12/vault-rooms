import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { computeTextDiff, reconcileYTextByLines, reconcileYTextWithDiskText } from "./crdtReconcile.js";

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
  it("takes two texts too large to compare as one change, cheaply", () => {
    const a = "a".repeat(2_000);
    const b = "b".repeat(2_000);
    expect(computeTextDiff(a, b)).toEqual([
      { op: "delete", text: a },
      { op: "insert", text: b }
    ]);
  });

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

describe("reconcileYTextByLines", () => {
  /** Reconcile `from` to `to`; returns the result and the update it made. */
  function byLines(from: string, to: string): { result: string; update: ReturnType<typeof Y.decodeUpdate> } {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, from);
    let update: ReturnType<typeof Y.decodeUpdate> | null = null;
    doc.once("update", (bytes: Uint8Array) => (update = Y.decodeUpdate(bytes)));
    reconcileYTextByLines(text, to, null);
    return { result: text.toString(), update: update! };
  }

  it("turns a note into another", () => {
    const cases = [["", "a\n"], ["a\n", ""], ["a", ""], ["", "a"], ["a\nb\nc\n", "a\nB\nc\n"], ["a\nb", "a\nb\nc"], ["a\nb\nc\n", "x\nb\ny\nz\n"], ["a\nb\nc\nd\n", "a\nd\n"], ["a\nb\nc", "a"], ["a\nb\nc", "c"], ["😃 a\n", "😃 b\n"], ["\n\n", "\n"], ["x", "\n\nx\n\n"]];
    for (const [from, to] of cases) expect(byLines(from!, to!).result, JSON.stringify([from, to])).toBe(to);
    // And any edit of lines, at random (fixed seed).
    let seed = 7;
    const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    const words = ["", "a", "bb", "start: 2030-01-09", "end", "😃"];
    for (let round = 0; round < 300; round++) {
      const note = () => Array.from({ length: random(6) }, () => words[random(words.length)]).join("\n");
      const [from, to] = [note(), note()];
      expect(byLines(from, to).result, JSON.stringify([from, to])).toBe(to);
    }
  });

  it("only adds when lines are added at either end, with or without a final line break", () => {
    for (const [from, to] of [["a\nb", "a\nb\nc"], ["a\nb\n", "a\nb\nc\n"], ["a\nb", "x\na\nb"], ["a\nb", "a\nb\n"]]) {
      expect(byLines(from!, to!).update.ds.clients.size, JSON.stringify([from, to])).toBe(0);
    }
  });

  it("puts each new line in front of the line it replaced", () => {
    const { update } = byLines("---\nstart: 2030-01-09\nend: 2030-01-20\n---\n", "---\nstart: 2030-01-12\nend: 2030-01-23\n---\n");
    const runs = update.structs.map((struct) => ({ text: ((struct as Y.Item).content as Y.ContentString).str, right: (struct as Y.Item).rightOrigin!.clock }));
    // Positions in the original text: "start..." begins at 4, "end..." at 22.
    expect(runs).toEqual([
      { text: "start: 2030-01-12\n", right: 4 },
      { text: "end: 2030-01-23\n", right: 22 }
    ]);
  });

  it("replaces a changed line whole, so two computers changing it take out the same text", () => {
    const base = new Y.Doc();
    base.getText("content").insert(0, "---\nstart: 2030-01-09\n---\n");
    const deletedBy = (to: string) => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(base));
      let deleted: unknown;
      doc.once("update", (update: Uint8Array) => (deleted = Y.decodeUpdate(update).ds));
      reconcileYTextByLines(doc.getText("content"), to, null);
      return deleted;
    };
    expect(deletedBy("---\nstart: 2030-01-12\n---\n")).toEqual(deletedBy("---\nstart: 2030-02-03\n---\n"));
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

  it("never splits an emoji, so what another computer receives is intact", () => {
    for (const [before, after] of [
      ["😀", "😃"],
      ["a😀b", "a😃b"],
      ["x\u{1F600}", "y\u{1F600}"],
      ["\u{1F600}\u{1F601}", "\u{1F600}\u{1F602}"],
      ["תכנית 👍", "תכנית 👎"]
    ] as const) {
      const local = new Y.Doc();
      const text = local.getText("content");
      text.insert(0, before);
      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
      local.on("update", (update: Uint8Array) => Y.applyUpdate(remote, update));
      reconcileYTextWithDiskText(text, after, "disk");
      expect(text.toString()).toBe(after);
      expect(remote.getText("content").toString()).toBe(after);
    }
  });

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
