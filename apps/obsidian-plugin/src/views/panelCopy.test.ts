import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONNECTION_STATUS_COPY, HOSTING_STATUS_COPY } from "../onboarding.js";
import { PANEL_COPY } from "./panelCopy.js";

/**
 * Comments are stripped before scanning: the rule is about strings the panel renders, and a comment that
 * quotes a constant's value to explain a decision is legitimate. A tripwire that fires on documentation
 * gets weakened rather than obeyed.
 *
 * Line comments are only recognised at the start of a line so that a `//` inside a URL literal survives.
 */
const viewSource = readFileSync(new URL("./VaultRoomsView.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

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
  ["hosting.pausedHere", PANEL_COPY.hosting.pausedHere(2)],
  ["connection.ownedBy", PANEL_COPY.connection.ownedBy("Huy")],
  ["connection.unnamedOnPort", PANEL_COPY.connection.unnamedOnPort("8788")]
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
    // Two saved remote servers must never render the same label.
    expect(PANEL_COPY.connection.ownedBy("Huy")).toBe("Huy's server");
    expect(PANEL_COPY.connection.unnamedOnPort("8788")).toBe("Someone else's server · port 8788");
    expect(PANEL_COPY.connection.ownedBy("Huy")).not.toBe(PANEL_COPY.connection.someoneElse);
  });

  it("covers every function-valued copy member", () => {
    expect(functionPaths(PANEL_COPY).sort()).toEqual([
      "connection.ownedBy",
      "connection.unnamedOnPort",
      "hosting.pausedHere",
      "room.location",
      "room.needsChoice"
    ]);
    const covered = [...new Set(invokedStrings.map(([path]) => path))].sort();
    expect(covered).toEqual(functionPaths(PANEL_COPY).sort());
  });

  it("never lets the view retype a string that a shared constant already owns", () => {
    const owned = [
      ...stringLeaves(PANEL_COPY).map(([, value]) => value),
      ...Object.values(HOSTING_STATUS_COPY),
      ...Object.values(CONNECTION_STATUS_COPY)
    ].filter((value) => value.length > 3);

    const retyped = owned.filter((value) => viewSource.includes(`"${value}"`));
    expect(retyped, "VaultRoomsView.ts must reference the constant, not repeat its text").toEqual([]);
  });

  /**
   * An empty state is a dead end when it reports absence and stops. It escapes that by doing one of three
   * things: naming an action, naming who can act, or saying what will fill it. The third branch matters —
   * for a group whose emptiness is the healthy outcome, inventing an action would be worse copy.
   */
  it("never leaves an empty state as a dead end", () => {
    const NAMES_AN_ACTION = /\b(?:create|invite|join|set up|use|add)\b/i;
    const NAMES_AN_ACTOR = /\bonly\b|\bask\b|\bowner\b|\bmanager/i;
    const SAYS_WHAT_FILLS_IT = /\b(?:will appear|appear here|already has)\b/i;

    for (const [key, value] of Object.entries(PANEL_COPY.empty)) {
      const escapes =
        NAMES_AN_ACTION.test(value) || NAMES_AN_ACTOR.test(value) || SAYS_WHAT_FILLS_IT.test(value);
      expect(escapes, `PANEL_COPY.empty.${key} is a dead end: "${value}"`).toBe(true);
      expect(value.endsWith("."), `PANEL_COPY.empty.${key} must be a sentence`).toBe(true);
    }
    expect(Object.keys(PANEL_COPY.empty).length).toBeGreaterThanOrEqual(9);
  });

  it("uses plain words in every visible string, including interpolated ones", () => {
    const all = [...stringLeaves(PANEL_COPY), ...invokedStrings];
    expect(all.length).toBeGreaterThan(25);
    for (const [path, value] of all) {
      expect(value, path).not.toMatch(BANNED_WORDS);
    }
  });
});
