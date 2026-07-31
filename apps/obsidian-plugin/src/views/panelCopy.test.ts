import { describe, expect, it } from "vitest";
import { CONNECTION_STATUS_COPY, HOSTING_STATUS_COPY } from "../onboarding.js";
import { PANEL_COPY } from "./panelCopy.js";

const BANNED_WORDS = /\b(?:mount|mounted|mounts|unmount|unmounted|grant|grants|shared space|CRDT|Yjs)\b/i;

type CopyNode = string | ((...args: never[]) => string) | { readonly [key: string]: CopyNode };

/** Every plain-string leaf with its dotted path, so a failure names the offending key. */
function stringLeaves(node: CopyNode, path = ""): Array<[string, string]> {
  if (typeof node === "string") return [[path, node]];
  if (typeof node === "function") return [];
  return Object.entries(node).flatMap(([key, value]) =>
    stringLeaves(value, path ? `${path}.${key}` : key)
  );
}

/**
 * Function-valued copy is invisible to JSON.stringify, so a stringify-then-regex check cannot see the
 * interpolated strings most likely to carry a banned word. The paths are asserted exactly below:
 * adding a new function member fails this test until its output is added to `invokedStrings`.
 */
function functionPaths(node: CopyNode, path = ""): string[] {
  if (typeof node === "function") return [path];
  if (typeof node === "string") return [];
  return Object.entries(node).flatMap(([key, value]) =>
    functionPaths(value, path ? `${path}.${key}` : key)
  );
}

const invokedStrings: Array<[string, string]> = [
  ["room.location", PANEL_COPY.room.location("Notes/Daily Report")],
  ["room.needsChoice", PANEL_COPY.room.needsChoice(1)],
  ["room.needsChoice", PANEL_COPY.room.needsChoice(2)],
  ["hosting.pausedHere", PANEL_COPY.hosting.pausedHere(1)],
  ["hosting.pausedHere", PANEL_COPY.hosting.pausedHere(2)]
];

describe("panel copy contract", () => {
  it("keeps hosting and connection not-set-up labels distinct", () => {
    expect(CONNECTION_STATUS_COPY.notSetUp).toBe("Not set up");
    expect(HOSTING_STATUS_COPY.notSetUp).toBe("Not sharing yet");
    expect(HOSTING_STATUS_COPY.notSetUp).not.toBe(CONNECTION_STATUS_COPY.notSetUp);
  });

  it("asserts the exact visible labels the panel renders", () => {
    expect(PANEL_COPY.tabs).toEqual({ rooms: "Rooms", people: "People", activity: "Activity" });
    expect(PANEL_COPY.room.add).toBe("Add to this computer");
    expect(PANEL_COPY.room.remove).toBe("Remove from this computer");
    expect(PANEL_COPY.room.notOnDevice).toBe("Not on this computer");
    expect(PANEL_COPY.room.needsChoice(1)).toBe("1 file needs a choice");
    expect(PANEL_COPY.room.needsChoice(2)).toBe("2 files need a choice");
    expect(PANEL_COPY.room.location("Notes/Daily Report")).toBe(
      "In your vault at Notes/Daily Report"
    );
    expect(PANEL_COPY.hosting.start).toBe("Start sharing");
    expect(PANEL_COPY.hosting.stop).toBe("Pause sharing");
    expect(PANEL_COPY.activity.heading).toBe("Most recent first");
  });

  it("covers every function-valued copy member", () => {
    expect(functionPaths(PANEL_COPY).sort()).toEqual([
      "hosting.pausedHere",
      "room.location",
      "room.needsChoice"
    ]);
    const covered = [...new Set(invokedStrings.map(([path]) => path))].sort();
    expect(covered).toEqual(functionPaths(PANEL_COPY).sort());
  });

  it("uses plain words in every visible string, including interpolated ones", () => {
    const all = [...stringLeaves(PANEL_COPY), ...invokedStrings];
    expect(all.length).toBeGreaterThan(25);
    for (const [path, value] of all) {
      expect(value, path).not.toMatch(BANNED_WORDS);
    }
  });
});
