import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { fromUtf8, utf8 } from "./bytes.js";
import { WorkspaceChain } from "./chain.js";
import { randomId } from "./ids.js";
import { keyCommitment, newRoomKey, wrapRoomKey } from "./keys.js";
import { envelopeKey, openEnvelope, sealSnapshot } from "./envelope.js";
import { MeshNode } from "./mesh.js";
import { pathKey, safeRoomPath } from "./paths.js";
import { RoomReplica, type FileEntry, type ReplicaEvents } from "./replica.js";
import { EnvelopeStore, STORE_LIMITS } from "./store.js";
import { createRoom, founder, invite, Network, step, type TestDevice } from "./testkit.js";
import { nextVersion } from "./workspace.js";

describe("room paths", () => {
  it("accept ordinary names, in any script", () => {
    for (const ok of ["Plan.md", "Design/Notes.md", "תכנית עבודה.md", "a b/c-d_e (1).png", "日本語/メモ.md"]) expect(safeRoomPath(ok)).toBe(ok.normalize("NFC"));
  });
  it("refuse anything that could leave the room folder or reach Obsidian's configuration", () => {
    for (const bad of ["../evil.md", "a/../../b.md", "/etc/passwd", "C:/Windows/x", "C:x", ".obsidian/plugins/x/main.js", "Notes/.obsidian/app.json", ".trash/x", "a\\b", "a//b", "", "con.md", "Notes/NUL", "lpt1.txt", "end.", "end ", "a:b", "tab\there", `${"x".repeat(121)}.md`]) {
      expect(safeRoomPath(bad), bad).toBeNull();
    }
    expect(safeRoomPath(42)).toBeNull();
  });
  it("compare case- and form-insensitively", () => {
    expect(pathKey("Notes.md")).toBe(pathKey("NOTES.md"));
    expect(pathKey("e\u0301.md")).toBe(pathKey("\u00e9.md"));
  });
});

interface Member {
  device: TestDevice;
  node: MeshNode;
  replica: RoomReplica;
  refused: string[];
}

function setup() {
  const { chain, ws, admin: ana } = founder();
  const { joiner: cy } = invite(chain, ana, { userName: "Cy" });
  const { joiner: rae } = invite(chain, ana, { userName: "Rae" });
  const { joiner: ben } = invite(chain, ana, { userName: "Ben" });
  const { roomId, key } = createRoom(chain, ana, "Plans", { [cy.userId]: "write", [rae.userId]: "read" });
  const net = new Network();
  const nodes = new Map<string, MeshNode>();
  const members = new Map<string, Member>();
  const nodeOf = (device: TestDevice) => {
    let node = nodes.get(device.id);
    if (!node) {
      node = new MeshNode(WorkspaceChain.load(chain.all()), device.id, {
        envelope: (env) => members.get(device.id)?.replica.receive(env),
        wraps: () => members.get(device.id)?.replica.refreshKeys()
      });
      nodes.set(device.id, node);
    }
    return node;
  };
  const member = (device: TestDevice, events: ReplicaEvents = {}): Member => {
    const node = nodeOf(device);
    const refused: string[] = [];
    const replica = new RoomReplica(node, roomId, { sign: device.sign, agree: device.agree }, { localRefused: (_doc, code) => refused.push(code), ...events });
    const m = { device, node, replica, refused };
    members.set(device.id, m);
    return m;
  };
  // Ana wraps the key to every member's device, her own included.
  const wrapFor = (device: TestDevice, n = 1, k = key) => nodeOf(ana).addWrap(wrapRoomKey(ws, roomId, n, k, { id: device.id, agree: device.agree.publicKey }, ana.sign));
  return { chain, ws, ana, cy, rae, ben, roomId, key, net, nodeOf, member, wrapFor };
}

function addNote(replica: RoomReplica, path: string, text: string): string {
  const fileId = randomId("f");
  replica.editIndex((files) => files.set(fileId, { path, kind: "md" }));
  const doc = replica.noteDoc(fileId);
  doc.getText("content").insert(0, text);
  return fileId;
}

describe("room replica", () => {
  it("co-edits a note: both sides converge, including edits made while apart", () => {
    const s = setup();
    const a = s.member(s.ana);
    const c = s.member(s.cy);
    s.wrapFor(s.ana);
    s.wrapFor(s.cy);
    a.replica.refreshKeys();
    const link = s.net.link(a.node, c.node);
    s.net.pump();
    c.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "Hello");
    s.net.pump();
    expect([...c.replica.files().values()]).toEqual([{ path: "Plan.md", kind: "md" }]);
    expect(c.replica.noteText(fileId)).toBe("Hello");
    // Apart: Ana appends, Cy prepends.
    link.cut();
    a.replica.noteDoc(fileId).getText("content").insert(5, " world");
    c.replica.noteDoc(fileId).getText("content").insert(0, "Hi! ");
    s.net.link(a.node, c.node);
    s.net.pump();
    expect(a.replica.noteText(fileId)).toBe("Hi! Hello world");
    expect(c.replica.noteText(fileId)).toBe("Hi! Hello world");
  });

  it("keeps readers' local edits to themselves", () => {
    const s = setup();
    const a = s.member(s.ana);
    const r = s.member(s.rae);
    s.wrapFor(s.ana);
    s.wrapFor(s.rae);
    a.replica.refreshKeys();
    s.net.link(a.node, r.node);
    s.net.pump();
    r.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "Original");
    s.net.pump();
    expect(r.replica.canWrite()).toBe(false);
    r.replica.noteDoc(fileId).getText("content").insert(0, "Vandal ");
    expect(r.refused).toEqual(["read_only"]);
    expect(r.replica.reload(fileId).getText("content").toString()).toBe("Original");
    s.net.pump();
    expect(a.replica.noteText(fileId)).toBe("Original");
  });

  it("shows nothing until the key arrives, then everything", () => {
    const s = setup();
    const a = s.member(s.ana);
    const c = s.member(s.cy);
    s.wrapFor(s.ana);
    a.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "Secret plan");
    s.net.link(a.node, c.node);
    s.net.pump();
    expect(c.replica.files().size).toBe(0);
    expect(c.replica.epochsMissing()).toEqual([1]);
    s.wrapFor(s.cy);
    s.net.pump();
    expect(c.replica.noteText(fileId)).toBe("Secret plan");
  });

  it("keeps edits made before any key arrived, and sends them once one does", () => {
    const s = setup();
    const a = s.member(s.ana);
    const fileId = randomId("f");
    a.replica.editIndex((files) => files.set(fileId, { path: "Early.md", kind: "md" }));
    expect(a.node.store.envelopesOf(s.roomId, "index").updates).toHaveLength(0);
    a.replica.addOwnKey(1, s.key);
    expect(a.node.store.envelopesOf(s.roomId, "index").updates).toHaveLength(1);
    const c = s.member(s.cy);
    s.wrapFor(s.cy);
    s.net.link(a.node, c.node);
    s.net.pump();
    c.replica.refreshKeys();
    expect(c.replica.files().get(fileId)?.path).toBe("Early.md");
  });

  it("never lists a path that could leave the room folder", () => {
    const s = setup();
    const a = s.member(s.ana);
    s.wrapFor(s.ana);
    a.replica.refreshKeys();
    a.replica.editIndex((files) => {
      files.set(randomId("f"), { path: "../outside.md", kind: "md" });
      files.set(randomId("f"), { path: ".obsidian/plugins/evil/main.js", kind: "bin" });
      files.set(randomId("f"), { path: "Fine.md", kind: "md" });
      files.set(randomId("f"), { path: "Odd.md", kind: "exe" } as unknown as FileEntry);
    });
    expect([...a.replica.files().values()].map((f) => f.path)).toEqual(["Fine.md"]);
  });

  it("shares attachments as encrypted blobs others can check", async () => {
    const s = setup();
    const a = s.member(s.ana);
    const c = s.member(s.cy);
    s.wrapFor(s.ana);
    s.wrapFor(s.cy);
    a.replica.refreshKeys();
    const ref = a.replica.putBlob(utf8("PNG bytes"));
    const fileId = randomId("f");
    a.replica.editIndex((files) => files.set(fileId, { path: "img.png", kind: "bin", blob: ref }));
    s.net.link(a.node, c.node);
    await s.net.settle();
    c.replica.refreshKeys();
    const entry = c.replica.files().get(fileId)!;
    expect(fromUtf8((await c.replica.readBlob(entry.blob!))!)).toBe("PNG bytes");
  });

  it("compacts with a snapshot that a newcomer can start from", () => {
    const s = setup();
    const a = s.member(s.ana);
    s.wrapFor(s.ana);
    s.wrapFor(s.cy);
    a.replica.refreshKeys();
    const fileId = addNote(a.replica, "Long.md", "");
    const text = a.replica.noteDoc(fileId).getText("content");
    for (let i = 0; i < 50; i++) text.insert(text.length, `line ${i}\n`);
    expect(a.replica.snapshot(fileId)).not.toBeNull();
    expect(a.node.store.envelopesOf(s.roomId, fileId).updates).toHaveLength(0);
    const c = s.member(s.cy);
    s.net.link(a.node, c.node);
    s.net.pump();
    c.replica.refreshKeys();
    expect(c.replica.noteText(fileId)).toBe(text.toString());
  });

  it("marks as folded in only the updates a late snapshot holds, so a later update is still read back after a restart", () => {
    const s = setup();
    const a = s.member(s.ana);
    const c = s.member(s.cy);
    for (const device of [s.ana, s.cy]) s.wrapFor(device);
    a.replica.refreshKeys();
    s.net.link(a.node, c.node);
    s.net.pump();
    c.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "first");
    const early = Y.encodeStateAsUpdate(a.replica.noteDoc(fileId));
    a.replica.noteDoc(fileId).getText("content").insert(5, " SECOND");
    s.net.pump();
    // A snapshot of the note after Ana's first update only (made earlier, sent late) comes in after both updates.
    expect(c.node.publish(sealSnapshot({ ws: s.ws, room: s.roomId, n: 1, key: s.key, author: s.cy.sign }, fileId, 1, { [s.ana.id]: 1 }, early))).toBe(true);
    s.net.pump();
    const { marks, claimed, dropped } = a.node.store.marksOf(s.roomId, fileId);
    expect(marks[s.ana.id]).toBe(1);
    // Read back as after a restart: the second update is still there, and counted as held.
    const back = new EnvelopeStore();
    back.restoreMarks(s.roomId, fileId, marks, claimed, dropped);
    const { snapshots, updates } = a.node.store.envelopesOf(s.roomId, fileId);
    for (const env of [...snapshots, ...updates]) back.add(env);
    expect(back.envelopesOf(s.roomId, fileId).updates.map((update) => update.clock)).toEqual([2]);
    expect(back.vv(s.roomId, fileId)[s.ana.id]).toBe(2);
  });

  it("a snapshot that lies about what it covers takes nothing away from members and freezes nothing", () => {
    const s = setup();
    const a = s.member(s.ana);
    const c = s.member(s.cy);
    s.wrapFor(s.ana);
    s.wrapFor(s.cy);
    a.replica.refreshKeys();
    s.net.link(a.node, c.node);
    s.net.pump();
    c.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "Keep me");
    s.net.pump();
    // Cy, a writer, publishes an empty state claiming to cover every counter of everyone.
    const lie = sealSnapshot({ ws: s.ws, room: s.roomId, n: 1, key: s.key, author: s.cy.sign }, fileId, 1, { [s.ana.id]: Number.MAX_SAFE_INTEGER, [s.cy.id]: Number.MAX_SAFE_INTEGER }, Y.encodeStateAsUpdate(new Y.Doc()));
    expect(c.node.publish(lie)).toBe(true);
    s.net.pump();
    // Ana keeps every update (the snapshot doesn't contain them), and her text and counters are untouched.
    expect(a.node.store.envelopesOf(s.roomId, fileId).updates.length).toBeGreaterThan(0);
    expect(a.replica.reload(fileId).getText("content").toString()).toBe("Keep me");
    expect(a.node.store.maxClock(s.roomId, fileId, s.ana.id)).toBeLessThan(10);
    a.replica.noteDoc(fileId).getText("content").insert(7, " and more");
    s.net.pump();
    expect(c.replica.noteText(fileId)).toBe("Keep me and more");
  });

  /** Ana, Cy and Ben, all writers, each linked to the other two, sharing a note. */
  function triangle() {
    const s = setup();
    step(s.chain, s.ana, (state) => void (state.rooms[s.roomId]!.members[s.ben.userId] = "write"));
    for (const device of [s.ana, s.cy, s.ben, s.rae]) s.wrapFor(device);
    const [a, c, b] = [s.member(s.ana), s.member(s.cy), s.member(s.ben)];
    s.net.link(a.node, c.node);
    s.net.link(c.node, b.node);
    s.net.link(a.node, b.node);
    s.net.pump();
    for (const m of [a, c, b]) m.replica.refreshKeys();
    return { s, a, c, b };
  }

  it("lets go of a snapshot dropped as contained in another, instead of passing it around for ever", () => {
    const { s, a, c, b } = triangle();
    const fileId = addNote(a.replica, "Plan.md", "hello\n");
    s.net.pump();
    for (const m of [a, c, b]) m.replica.noteText(fileId);
    // Two writers snapshot the same note at once: one snapshot stays everywhere, and the network goes quiet.
    c.replica.snapshot(fileId);
    b.replica.snapshot(fileId);
    expect(() => s.net.pump(5_000)).not.toThrow();
    const kept = [a, c, b].map((m) => m.node.store.envelopesOf(s.roomId, fileId).snapshots.map((snapshot) => envelopeKey(snapshot)).join());
    expect(new Set(kept).size).toBe(1);
  });

  /** Let the network, and what waits for a microtask, run. */
  async function quiet(s: ReturnType<typeof setup>) {
    s.net.pump();
    await new Promise((resolve) => setTimeout(resolve, 0));
    s.net.pump();
  }

  /**
   * Ana and Cy, apart, each save the first line of a note ("due: 1") whole to a value of their own (as a plugin's write
   * is taken in, see reconcileYTextByLines), and `apart` runs then too; then they meet. Copies are kept while `keep.now`.
   */
  async function clashing(apart?: (a: Member, c: Member, fileId: string) => void) {
    const s = setup();
    const keep = { now: false };
    const asked: string[] = [];
    const copies: string[] = [];
    const clash = (_doc: string, version: string) => asked.push(version) > 0 && keep.now && copies.push(version) > 0;
    const a = s.member(s.ana, { clash });
    const c = s.member(s.cy, { clash });
    for (const device of [s.ana, s.cy]) s.wrapFor(device);
    a.replica.refreshKeys();
    let link = s.net.link(a.node, c.node);
    s.net.pump();
    c.replica.refreshKeys();
    const fileId = addNote(a.replica, "Task.md", "due: 1\nbody\n");
    s.net.pump();
    expect(c.replica.noteText(fileId)).toBe("due: 1\nbody\n");
    link.cut();
    const save = (m: Member, from: string, to: string) =>
      m.replica.edit(fileId, (doc) => {
        const text = doc.getText("content");
        const at = text.toString().indexOf(from);
        text.insert(at, to);
        text.delete(at + to.length, from.length);
      }, true);
    save(a, "due: 1\n", "due: 2\n");
    save(c, "due: 1\n", "due: 3\n");
    apart?.(a, c, fileId);
    link = s.net.link(a.node, c.node);
    await quiet(s);
    const [winner, loser] = a.replica.noteDoc(fileId).clientID < c.replica.noteDoc(fileId).clientID ? [a, c] : [c, a];
    const dues = (m: Member) => m.replica.noteText(fileId).split("\n").filter((line) => line.startsWith("due"));
    return { s, a, c, fileId, winner, loser, keep, asked, copies, save, dues };
  }

  it("leaves a clash in the note while nobody can keep the copy, and settles it when the saves are restored", async () => {
    const { s, a, c, fileId, keep, copies, dues } = await clashing();
    // Nobody could keep a copy (the room's folder away, say): both lines stay.
    expect(dues(a)).toHaveLength(2);
    expect(c.replica.noteText(fileId)).toBe(a.replica.noteText(fileId));
    // The folder is back: its saves are restored, and the clash is settled, with a copy.
    keep.now = true;
    for (const m of [a, c]) m.replica.restoreSaves(JSON.parse(JSON.stringify(m.replica.recentSaves())));
    await quiet(s);
    expect(dues(a)).toHaveLength(1);
    expect(c.replica.noteText(fileId)).toBe(a.replica.noteText(fileId));
    expect(copies).toEqual([`${dues(a)[0] === "due: 2" ? "due: 3" : "due: 2"}\nbody\n`]);
  });

  it("leaves a waiting clash alone once the line it gave way to is gone", async () => {
    const { s, a, c, fileId, winner, loser, keep, copies } = await clashing();
    // Nobody can keep a copy, so the losing line waits. Meanwhile the winning line is deleted.
    const kept = winner === a ? "due: 2\n" : "due: 3\n";
    const text = winner.replica.noteDoc(fileId).getText("content");
    text.delete(text.toString().indexOf(kept), kept.length);
    s.net.pump();
    keep.now = true;
    for (const m of [a, c]) m.replica.restoreSaves(JSON.parse(JSON.stringify(m.replica.recentSaves())));
    await quiet(s);
    // The losing line stays: never to leave none.
    expect(loser.replica.noteText(fileId)).toBe(`${winner === a ? "due: 3" : "due: 2"}\nbody\n`);
    expect(winner.replica.noteText(fileId)).toBe(loser.replica.noteText(fileId));
    expect(copies).toEqual([]);
  });

  it("takes out of a losing line that waited for its copy what was typed meanwhile in front of what went into it", async () => {
    // Each types into its own line before they meet: "x" after its first character.
    const { s, a, c, fileId, winner, loser, keep } = await clashing((a, c, fileId) => {
      for (const m of [a, c]) m.replica.noteDoc(fileId).getText("content").insert(1, "x");
    });
    // The losing line waits for its copy, its "x" with it. Meanwhile "y" is typed right in front of that "x".
    const text = winner.replica.noteDoc(fileId).getText("content");
    text.insert(text.toString().indexOf(loser === a ? "dxue: 2" : "dxue: 3") + 1, "y");
    s.net.pump();
    // The copy is kept now: what waited for it goes.
    keep.now = true;
    for (const m of [a, c]) m.replica.retryTakeOuts();
    await quiet(s);
    // The losing line goes whole, with all that went into it: nothing of it is left behind.
    expect(a.replica.noteText(fileId)).toBe(`${winner === a ? "dxue: 2" : "dxue: 3"}\nbody\n`);
    expect(c.replica.noteText(fileId)).toBe(a.replica.noteText(fileId));
  });

  it("keeps in one more copy what was typed into a losing line while it waited for its copy", async () => {
    const { s, a, c, fileId, winner, loser, keep, copies } = await clashing();
    // While the losing line waits for its copy, someone adds to it.
    const losing = loser === a ? "due: 2" : "due: 3";
    const text = winner.replica.noteDoc(fileId).getText("content");
    text.insert(text.toString().indexOf(losing) + losing.length, " (moved)");
    s.net.pump();
    keep.now = true;
    for (const m of [a, c]) m.replica.retryTakeOuts();
    await quiet(s);
    expect(a.replica.noteText(fileId)).toBe(`${winner === a ? "due: 2" : "due: 3"}\nbody\n`);
    expect(c.replica.noteText(fileId)).toBe(a.replica.noteText(fileId));
    // What was added goes with the line, and is kept in a copy too.
    expect(copies.some((copy) => copy.includes(`${losing} (moved)\n`))).toBe(true);
  });

  it("takes out with a losing line that waited for its copy the line saved here in its place meanwhile", async () => {
    const { s, a, c, fileId, winner, loser, keep, copies, save } = await clashing();
    // While its copy waits, the losing computer's plugin writes its own line again.
    save(loser, loser === a ? "due: 2\n" : "due: 3\n", "due: 4\n");
    s.net.pump();
    keep.now = true;
    for (const m of [a, c]) m.replica.retryTakeOuts();
    await quiet(s);
    expect(a.replica.noteText(fileId)).toBe(`${winner === a ? "due: 2" : "due: 3"}\nbody\n`);
    expect(c.replica.noteText(fileId)).toBe(a.replica.noteText(fileId));
    expect(copies).toContain("due: 4\nbody\n");
  });

  it("keeps at most one more copy of what goes into a losing line while it waits, and leaves the rest in the note", async () => {
    const { s, a, c, fileId, winner, loser, asked } = await clashing();
    expect(asked).toHaveLength(1);
    const losing = loser === a ? "due: 2" : "due: 3";
    const type = (what: string) => {
      const text = winner.replica.noteDoc(fileId).getText("content");
      text.insert(text.toString().indexOf(losing) + losing.length, what);
      s.net.pump();
    };
    // Someone goes on typing into the losing line while its copies are being written.
    type("x");
    loser.replica.copyKept(fileId, asked[0]!);
    await quiet(s);
    expect(asked).toHaveLength(2);
    type("y");
    loser.replica.copyKept(fileId, asked[1]!);
    await quiet(s);
    // No third copy: the line goes with what the copies hold, and the "y" typed after stays.
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain(`${losing}x\n`);
    expect(a.replica.noteText(fileId).replace("y", "")).toBe(`${winner === a ? "due: 2" : "due: 3"}\nbody\n`);
    expect(c.replica.noteText(fileId)).toBe(a.replica.noteText(fileId));
  });

  it("doesn't count taking out what lost a clash as work on the note here", async () => {
    const { s, fileId, loser, keep, dues } = await clashing();
    const before = loser.replica.lastLocalEdit(fileId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    keep.now = true;
    loser.replica.retryTakeOuts();
    await quiet(s);
    expect(dues(loser)).toHaveLength(1);
    expect(loser.replica.lastLocalEdit(fileId)).toBe(before);
  });

  it("takes out of two losing lines only the one whose rival is still there", async () => {
    const s = setup();
    let keep = false;
    const clash = () => keep;
    const a = s.member(s.ana, { clash });
    const c = s.member(s.cy, { clash });
    for (const device of [s.ana, s.cy]) s.wrapFor(device);
    a.replica.refreshKeys();
    let link = s.net.link(a.node, c.node);
    s.net.pump();
    c.replica.refreshKeys();
    const fileId = addNote(a.replica, "Task.md", "due: 1\nstatus: x\nbody\n");
    s.net.pump();
    c.replica.noteText(fileId);
    link.cut();
    // Each computer's plugin rewrites both lines at once.
    const save = (m: Member, due: string, status: string) =>
      m.replica.edit(fileId, (doc) => {
        const text = doc.getText("content");
        for (const [from, to] of [["due: 1\n", due], ["status: x\n", status]] as const) {
          const at = text.toString().indexOf(from);
          text.insert(at, to);
          text.delete(at + to.length, from.length);
        }
      }, true);
    save(a, "due: 2\n", "status: ana\n");
    save(c, "due: 3\n", "status: cy\n");
    link = s.net.link(a.node, c.node);
    await quiet(s);
    // Both lines of the computer that gives way wait for its copy; meanwhile someone deletes the winning "due" line.
    const [winner, loser] = a.replica.noteDoc(fileId).clientID < c.replica.noteDoc(fileId).clientID ? [a, c] : [c, a];
    const due = winner === a ? "due: 2\n" : "due: 3\n";
    const text = winner.replica.noteDoc(fileId).getText("content");
    text.delete(text.toString().indexOf(due), due.length);
    s.net.pump();
    keep = true;
    for (const m of [a, c]) m.replica.retryTakeOuts();
    await quiet(s);
    // The losing "due" line stays (nothing is left of its rival), the losing "status" line goes.
    const [loserDue, winnerStatus] = loser === a ? ["due: 2", "status: cy"] : ["due: 3", "status: ana"];
    expect(a.replica.noteText(fileId)).toBe(`${loserDue}\n${winnerStatus}\nbody\n`);
    expect(c.replica.noteText(fileId)).toBe(a.replica.noteText(fileId));
  });

  it("gives way to a lower line that comes while its line waits for a copy, also once the line it gave way to first is gone", async () => {
    const s = setup();
    step(s.chain, s.ana, (state) => void (state.rooms[s.roomId]!.members[s.ben.userId] = "write"));
    const asked: string[] = [];
    const a = s.member(s.ana, { clash: () => true });
    const c = s.member(s.cy, { clash: () => true });
    const b = s.member(s.ben, { clash: (_doc, version) => asked.push(version) < 0 });
    for (const device of [s.ana, s.cy, s.ben]) s.wrapFor(device);
    const links = [s.net.link(a.node, c.node), s.net.link(c.node, b.node), s.net.link(a.node, b.node)];
    s.net.pump();
    for (const m of [a, c, b]) m.replica.refreshKeys();
    const fileId = addNote(a.replica, "Task.md", "due: 1\nbody\n");
    s.net.pump();
    for (const link of links) link.cut();
    // Ana's client is the lowest, then Cy's, then Ben's. Each of their plugins writes its own date.
    [a, c, b].forEach((m, i) => {
      m.replica.reload(fileId).clientID = i + 1;
      m.replica.edit(fileId, (doc) => {
        const text = doc.getText("content");
        text.insert(0, `due: ${i + 2}\n`);
        text.delete(7, 7);
      }, true);
    });
    // Ben meets Cy, and his line waits for its copy; then Cy meets Ana, and gives way to her line (keeping its copy).
    s.net.link(b.node, c.node);
    await quiet(s);
    s.net.link(c.node, a.node);
    await quiet(s);
    expect(c.replica.noteText(fileId)).toBe("due: 2\ndue: 4\nbody\n");
    // Ben's copy is kept: his line goes, giving way to Ana's, though Cy's is gone.
    expect(asked).toHaveLength(1);
    b.replica.copyKept(fileId, asked[0]!);
    await quiet(s);
    for (const m of [a, c, b]) expect(m.replica.noteText(fileId)).toBe("due: 2\nbody\n");
  });

  it("takes nothing out, and asks for no copy, when the line it lost to went in the same go", async () => {
    for (const keepAtOnce of [true, false]) {
      const s = setup();
      const asked: string[] = [];
      const clash = (_doc: string, version: string) => asked.push(version) > 0 && keepAtOnce;
      const a = s.member(s.ana, { clash });
      const c = s.member(s.cy, { clash });
      for (const device of [s.ana, s.cy]) s.wrapFor(device);
      a.replica.refreshKeys();
      const link = s.net.link(a.node, c.node);
      s.net.pump();
      c.replica.refreshKeys();
      const fileId = addNote(a.replica, "Task.md", "due: 1\nbody\n");
      s.net.pump();
      c.replica.noteText(fileId);
      link.cut();
      // Ana's client is the lower. Her plugin writes a date and then takes the line out; Cy's writes another date.
      a.replica.reload(fileId).clientID = 1;
      c.replica.reload(fileId).clientID = 2;
      a.replica.edit(fileId, (doc) => {
        doc.getText("content").insert(0, "due: 2\n");
        doc.getText("content").delete(7, 7);
      }, true);
      a.replica.edit(fileId, (doc) => doc.getText("content").delete(0, 7), true);
      c.replica.edit(fileId, (doc) => {
        doc.getText("content").insert(0, "due: 3\n");
        doc.getText("content").delete(7, 7);
      }, true);
      s.net.link(a.node, c.node);
      await quiet(s);
      // Both of Ana's saves come in before Cy's clash is settled: Cy's date stays, the only one left.
      for (const m of [a, c]) expect(m.replica.noteText(fileId)).toBe("due: 3\nbody\n");
      expect(asked).toEqual([]);
    }
  });

  it("doesn't ask for a second copy of a waiting clash it finds again", async () => {
    const { s, a, c, fileId, winner, loser, keep, copies } = await clashing();
    // Someone adds to the note, and the losing computer rebuilds it (after an edit it couldn't share, say).
    const text = winner.replica.noteDoc(fileId).getText("content");
    text.insert(text.length, "more\n");
    s.net.pump();
    loser.replica.reload(fileId);
    keep.now = true;
    for (const m of [a, c]) m.replica.retryTakeOuts();
    await quiet(s);
    expect(loser.replica.noteText(fileId).split("\n").filter((line) => line.startsWith("due"))).toHaveLength(1);
    expect(copies).toHaveLength(1);
  });

  it("keeps the copy of a losing line as it was when the note holds something other than text", async () => {
    const s = setup();
    const copies: string[] = [];
    const clash = (_doc: string, version: string) => copies.push(version) > 0;
    const a = s.member(s.ana, { clash });
    const c = s.member(s.cy, { clash });
    for (const device of [s.ana, s.cy]) s.wrapFor(device);
    a.replica.refreshKeys();
    let link = s.net.link(a.node, c.node);
    s.net.pump();
    c.replica.refreshKeys();
    const fileId = addNote(a.replica, "Task.md", "old: 1\nbody\n");
    // Another program's client put an embed in front of the text.
    a.replica.noteDoc(fileId).getText("content").insertEmbed(0, { image: "x" });
    s.net.pump();
    c.replica.noteText(fileId);
    link.cut();
    const save = (m: Member, line: string) =>
      m.replica.edit(fileId, (doc) => {
        const text = doc.getText("content");
        text.insert(1, line);
        text.delete(1 + line.length, "old: 1\n".length);
      }, true);
    save(a, "aaa: 2\n");
    save(c, "zzz: 3\n");
    link = s.net.link(a.node, c.node);
    await quiet(s);
    expect(copies).toHaveLength(1);
    expect(["aaa: 2\nbody\n", "zzz: 3\nbody\n"]).toContain(copies[0]);
  });

  it("never lets working out clashes stop an edit being shared, or an update going in", () => {
    const s = setup();
    const a = s.member(s.ana);
    const c = s.member(s.cy);
    for (const device of [s.ana, s.cy]) s.wrapFor(device);
    a.replica.refreshKeys();
    s.net.link(a.node, c.node);
    s.net.pump();
    c.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "hello\n");
    s.net.pump();
    expect(c.replica.noteText(fileId)).toBe("hello\n");
    // Something goes wrong working out clashes (a huge edit, say).
    const broken = () => {
      throw new RangeError("Maximum call stack size exceeded");
    };
    for (const m of [a, c]) Object.assign((m.replica as unknown as { clashes: object }).clashes, { recordLocal: broken, typedClash: broken, check: broken, hasSaves: () => true });
    a.replica.noteDoc(fileId).getText("content").insert(5, " world");
    s.net.pump();
    expect(c.replica.noteText(fileId)).toBe("hello world\n");
  });

  it("ignores saves read back that Yjs couldn't have made", () => {
    const s = setup();
    const a = s.member(s.ana);
    s.wrapFor(s.ana);
    a.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "a\n");
    a.replica.noteText(fileId);
    a.replica.restoreSaves({ [fileId]: [{ at: Date.now(), deleted: [], inserted: [{ client: 4242, clock: 0, length: 0, right: null }] }] });
    expect(a.replica.recentSaves()).toEqual({});
  });

  it("doesn't hold a save twice when the same saves are restored on a running replica", () => {
    const s = setup();
    const a = s.member(s.ana);
    s.wrapFor(s.ana);
    a.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "a\nb\n");
    a.replica.edit(fileId, (doc) => {
      doc.getText("content").insert(2, "B\n");
      doc.getText("content").delete(4, 2);
    }, true);
    const saved = a.replica.recentSaves();
    expect(Object.values(saved).flat()).toHaveLength(1);
    a.replica.restoreSaves(JSON.parse(JSON.stringify(saved)));
    expect(a.replica.recentSaves()).toEqual(saved);
  });

  it("takes in again a snapshot it dropped on a claim alone once this computer is in the room", () => {
    const s = setup();
    const store = new EnvelopeStore();
    store.isMember = () => false;
    const ctx = { ws: s.ws, room: s.roomId, n: 1, key: s.key, author: s.cy.sign };
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "honest");
    const fileId = randomId("f");
    const honest = sealSnapshot(ctx, fileId, 1, { [s.cy.id]: 1 }, Y.encodeStateAsUpdate(doc));
    const lying = sealSnapshot(ctx, fileId, 2, { [s.cy.id]: 9 }, Y.encodeStateAsUpdate(new Y.Doc()));
    expect(store.add(honest)).toBe("added");
    expect(store.add(lying)).toBe("added");
    expect(store.envelopesOf(s.roomId, fileId).snapshots.map((snapshot) => snapshot.seq)).toEqual([2]);
    store.isMember = () => true;
    store.distrustClaims(s.roomId);
    expect(store.add(honest)).toBe("added");
  });

  it("passes a former writer's work on only once it waited, if not the first writer to do it", async () => {
    const { s, a, b } = triangle();
    const fileId = addNote(b.replica, "Ben.md", "Ben's work\n");
    s.net.pump();
    a.replica.noteText(fileId);
    const snapshots = () => a.node.store.envelopesOf(s.roomId, fileId).snapshots.length;
    await a.replica.passOnOldWork(false, (author) => author !== s.ben.id);
    expect(snapshots()).toBe(0);
    await a.replica.passOnOldWork(true, (author) => author !== s.ben.id);
    expect(snapshots()).toBe(1);
  });

  it("doesn't read and seal a former writer's file again and again when there is no room left for a copy", async () => {
    const { s, a, b } = triangle();
    const blob = b.replica.putBlob(utf8("Ben's picture"));
    b.replica.editIndex((files) => files.set(randomId("f"), { path: "pic.png", kind: "bin", blob }));
    s.net.pump();
    let reads = 0;
    const read = a.replica.readBlob.bind(a.replica);
    a.replica.readBlob = (ref) => (reads++, read(ref));
    const limit = STORE_LIMITS.memberBlobBytes;
    STORE_LIMITS.memberBlobBytes = 0;
    try {
      for (let run = 0; run < 3; run++) await a.replica.passOnOldWork(true, (author) => author !== s.ben.id);
    } finally {
      STORE_LIMITS.memberBlobBytes = limit;
    }
    expect(reads).toBe(1);
  });

  it("passes on one document and one file at a time, with a turn for the app in between", async () => {
    const { s, a, b } = triangle();
    const ids = Array.from({ length: 25 }, (_, i) => addNote(b.replica, `Ben ${i}.md`, `work ${i}\n`));
    for (let i = 0; i < 3; i++) {
      const blob = b.replica.putBlob(utf8(`picture ${i}`));
      b.replica.editIndex((files) => files.set(randomId("f"), { path: `pic ${i}.png`, kind: "bin", blob }));
    }
    s.net.pump();
    for (const id of ids) a.replica.noteText(id);
    let reading = 0;
    let most = 0;
    const read = a.replica.readBlob.bind(a.replica);
    a.replica.readBlob = async (ref) => {
      most = Math.max(most, ++reading);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await read(ref);
      } finally {
        reading--;
      }
    };
    const passed = () => ids.filter((id) => a.node.store.envelopesOf(s.roomId, id).snapshots.some((snapshot) => snapshot.author === s.ana.id)).length;
    const writes = (author: string) => author !== s.ben.id;
    const going = a.replica.passOnOldWork(true, writes);
    // Nothing yet: it goes on in turns of its own.
    expect(passed()).toBe(0);
    await going;
    expect(passed()).toBe(25);
    expect(most).toBe(1);
    expect([...a.replica.files().values()].filter((entry) => entry.blob?.by === s.ana.id)).toHaveLength(3);
  });

  it("doesn't try again and again to pass on what it can't", async () => {
    const { s, a, b } = triangle();
    const fileId = addNote(b.replica, "Ben.md", "Ben's work\n");
    const blob = b.replica.putBlob(utf8("Ben's picture"));
    b.replica.editIndex((files) => files.set(randomId("f"), { path: "pic.png", kind: "bin", blob }));
    s.net.pump();
    a.replica.noteText(fileId);
    // The note can't be snapshotted (too large, say), and the index takes no new version of the picture (it is full).
    let snapshots = 0;
    let reads = 0;
    const snapshot = a.replica.snapshot.bind(a.replica);
    a.replica.snapshot = (docId, always) => (docId === fileId ? (snapshots++, null) : snapshot(docId, always));
    const read = a.replica.readBlob.bind(a.replica);
    a.replica.readBlob = (ref) => (reads++, read(ref));
    const editIndex = a.replica.editIndex.bind(a.replica);
    a.replica.editIndex = (change) => (reads > 0 ? "refused" : editIndex(change));
    for (let run = 0; run < 3; run++) await a.replica.passOnOldWork(true, (author) => author !== s.ben.id);
    expect(snapshots).toBe(1);
    expect(reads).toBe(1);
  });

  it("never lets the snapshot of someone who may no longer write push out a writer's", async () => {
    // Device ids are random, and which of two equal snapshots stays depends on them: tried several times.
    for (let round = 0; round < 8; round++) await passedOnToLatePeer();
  });

  async function passedOnToLatePeer() {
    const { s, a, c, b } = triangle();
    const fileId = addNote(b.replica, "Ben.md", "Ben's work\n");
    s.net.pump();
    for (const m of [a, c]) m.replica.noteText(fileId);
    // Ben snapshots his note; then his computer is revoked, and Ana passes his work on (the same content).
    b.replica.snapshot(fileId);
    s.net.pump();
    const revoked = nextVersion(s.ws, a.node.chain.head, s.ana.sign, (state) => void (state.devices[s.ben.id]!.revoked = true));
    for (const m of [a, c]) m.node.offerVersions([revoked]);
    const writes = (author: string) => author !== s.ben.id;
    await a.replica.passOnOldWork(true, writes);
    s.net.pump();
    for (const m of [a, c]) expect(m.node.store.envelopesOf(s.roomId, fileId).snapshots.map((snapshot) => snapshot.author)).toEqual([s.ana.id]);
    // Rae's computer catches up later, from Cy's alone.
    const r = s.member(s.rae);
    r.node.offerVersions([revoked]);
    s.net.link(c.node, r.node);
    s.net.pump();
    r.replica.refreshKeys();
    expect(r.replica.noteText(fileId)).toBe("Ben's work\n");
  }

  it("an honest snapshot is checked, then replaces what it really contains", () => {
    const s = setup();
    const a = s.member(s.ana);
    s.wrapFor(s.ana);
    a.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "One");
    a.replica.noteDoc(fileId).getText("content").insert(3, " two");
    const before = a.node.store.envelopesOf(s.roomId, fileId).updates.length;
    expect(a.replica.snapshot(fileId)).not.toBeNull();
    expect(before).toBeGreaterThan(0);
    expect(a.node.store.envelopesOf(s.roomId, fileId).updates).toHaveLength(0);
    expect(a.replica.reload(fileId).getText("content").toString()).toBe("One two");
    expect(a.node.store.vv(s.roomId, fileId)[s.ana.id]).toBe(before);
  });

  it("seals new content only under the room's newest key, holding edits until it arrives", () => {
    const s = setup();
    const a = s.member(s.ana);
    const c = s.member(s.cy);
    s.wrapFor(s.ana);
    s.wrapFor(s.cy);
    a.replica.refreshKeys();
    c.replica.refreshKeys();
    s.net.link(a.node, c.node);
    s.net.pump();
    const fileId = addNote(a.replica, "Plan.md", "Before");
    s.net.pump();
    // Ana removes Rae and rotates; Cy learns of the new epoch before she has its key.
    const k2 = newRoomKey();
    a.node.offerVersions([
      nextVersion(s.ws, a.node.chain.head, s.ana.sign, (state) => {
        delete state.rooms[s.roomId]!.members[s.rae.userId];
        state.rooms[s.roomId]!.epochs.push({ n: 2, commit: keyCommitment(s.ws, s.roomId, 2, k2) });
      })
    ]);
    a.replica.addOwnKey(2, k2);
    s.net.pump();
    expect(c.replica.sealEpoch()).toBeNull();
    expect(c.replica.edit(fileId, (doc) => doc.getText("content").insert(6, " (Cy)"))).toBe("queued");
    // Nothing went out under the old key, which Rae still has.
    expect(a.node.store.envelopesOf(s.roomId, fileId).updates.every((u) => u.author !== s.cy.id)).toBe(true);
    s.wrapFor(s.cy, 2, k2);
    s.net.pump();
    expect(a.replica.noteText(fileId)).toBe("Before (Cy)");
    expect(a.node.store.envelopesOf(s.roomId, fileId).updates.filter((u) => u.author === s.cy.id).every((u) => u.n === 2)).toBe(true);
  });

  it("drops a key the record no longer backs, and sends again what was sealed under it", () => {
    const s = setup();
    const a = s.member(s.ana);
    const c = s.member(s.cy);
    s.wrapFor(s.ana);
    s.wrapFor(s.cy);
    a.replica.refreshKeys();
    c.replica.refreshKeys();
    const link = s.net.link(a.node, c.node);
    s.net.pump();
    const fileId = addNote(a.replica, "Plan.md", "Start");
    s.net.pump();
    link.cut();
    // Apart, both start epoch 2 with their own key, and Cy writes under hers.
    const kc = newRoomKey();
    const ka = newRoomKey();
    c.node.offerVersions([nextVersion(s.ws, c.node.chain.head, s.cy.sign, (state) => void state.rooms[s.roomId]!.epochs.push({ n: 2, commit: keyCommitment(s.ws, s.roomId, 2, kc) }))]);
    c.replica.addOwnKey(2, kc);
    c.replica.noteDoc(fileId).getText("content").insert(5, " by Cy");
    a.node.offerVersions([nextVersion(s.ws, a.node.chain.head, s.ana.sign, (state) => void state.rooms[s.roomId]!.epochs.push({ n: 2, commit: keyCommitment(s.ws, s.roomId, 2, ka) }))]);
    a.replica.addOwnKey(2, ka);
    // They meet: Ana's rotation wins (she is an admin). Cy drops her key and gets Ana's.
    s.net.link(a.node, c.node);
    s.net.pump();
    expect(c.node.chain.headHash).toBe(a.node.chain.headHash);
    c.replica.refreshKeys();
    expect(c.replica.keyFor(2)).toBeUndefined();
    expect(a.replica.noteText(fileId)).toBe("Start");
    s.wrapFor(s.cy, 2, ka);
    s.net.pump();
    expect(a.replica.noteText(fileId)).toBe("Start by Cy");
  });

  it("refuses an edit it can't share and rebuilds the document without it", () => {
    const s = setup();
    const a = s.member(s.ana);
    const r = s.member(s.rae);
    s.wrapFor(s.ana);
    s.wrapFor(s.rae);
    a.replica.refreshKeys();
    s.net.link(a.node, r.node);
    s.net.pump();
    r.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "Original");
    s.net.pump();
    expect(r.replica.edit(fileId, (doc) => doc.getText("content").insert(0, "Vandal "))).toBe("refused");
    expect(r.refused).toEqual([]);
    expect(r.replica.noteText(fileId)).toBe("Original");
  });

  it("after a key rotation, a removed member can't read new content", () => {
    const s = setup();
    const a = s.member(s.ana);
    s.wrapFor(s.ana);
    a.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "Before");
    // Rae is removed and the key rotated in the same change.
    const k2 = newRoomKey();
    a.node.offerVersions([
      nextVersion(s.ws, a.node.chain.head, s.ana.sign, (state) => {
        delete state.rooms[s.roomId]!.members[s.rae.userId];
        state.rooms[s.roomId]!.epochs.push({ n: 2, commit: keyCommitment(s.ws, s.roomId, 2, k2) });
      })
    ]);
    a.replica.addOwnKey(2, k2);
    a.replica.noteDoc(fileId).getText("content").insert(6, " and after");
    const latest = a.node.store.envelopesOf(s.roomId, fileId).updates.at(-1)!;
    expect(latest.n).toBe(2);
    // Rae's last key is epoch 1: the new update doesn't open with it; it does with the new key.
    expect(() => openEnvelope(latest, s.key)).toThrow(/decrypt_failed/);
    const update = openEnvelope(latest, k2);
    const check = new Y.Doc();
    Y.applyUpdate(check, update);
    expect(update.length).toBeGreaterThan(0);
  });
});
