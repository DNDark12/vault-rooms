// Notes saved outside the editor (a plugin writing a note) on several computers at the same moment.
// The seeded fuzz test: each round the computers part, save the note, meet again in a random order, and keep the copies
// they are asked for. Checked, as SECURE-MESH.md promises: they end up with the same note; no line a computer saved is
// lost (it is in the note, or in that computer's copies); no line is made of two; a line nobody changed stays; of a line
// several replaced, only the version of the lowest Yjs client id stays; and only computers whose line gave way keep
// copies. Left out (documented limits): a note without a final line break, and typing in an editor.
// FUZZ_SEEDS=500 for a longer run; FUZZ_SEED=n runs the seed a failure names.
import { describe, expect, it } from "vitest";
import { MeshNode, randomId, RoomReplica, WorkspaceChain, wrapRoomKey } from "@vault-rooms/secure";
import { createRoom, founder, invite, Network } from "@vault-rooms/secure/testkit";
import { reconcileYTextByLines } from "../../src/crdtReconcile.js";

const ROUNDS = 6;

/** mulberry32: the same numbers for the same seed. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(list: T[], rand: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A line of a computer's note: `origin` is the line it stands for at the start of the round ("+text": one it added). */
interface Line {
  text: string;
  origin: string;
  /** Put elsewhere as it was this round (a plugin moving a card). */
  moved?: boolean;
}

interface Pc {
  name: string;
  node: MeshNode;
  replica: RoomReplica;
  /** A new replica on the stored envelopes, as when Obsidian starts again. */
  start: () => void;
  /** Copies asked for (see ReplicaEvents.clash) and not kept yet. */
  asked: string[];
  /** Copies kept this round. */
  copies: string[];
  /** The note as this computer saved it last this round. */
  view: Line[];
  saves: number;
  client: number;
}

const linesOf = (text: string) => text.split("\n").slice(0, -1);
const textOf = (lines: Line[]) => lines.map((line) => `${line.text}\n`).join("");

/** Writers of one room (Ana, Cy, Ben), each linked to the others, with a note (`fileId`, empty). `clash`: see ReplicaEvents. */
async function room(count: number, clash: (pc: Pc, version: string) => boolean) {
  const { chain, ws, admin } = founder();
  const devices = [admin, ...["Cy", "Ben"].slice(0, count - 1).map((userName) => invite(chain, admin, { userName }).joiner)];
  const { roomId, key } = createRoom(chain, admin, "Team", Object.fromEntries(devices.slice(1).map((device) => [device.userId, "write" as const])));
  const net = new Network();
  const errors: unknown[] = [];
  const pcs = devices.map((device, i) => {
    const pc = { name: "ACB"[i]!, asked: [], copies: [], view: [], saves: 0, client: 0 } as unknown as Pc;
    pc.node = new MeshNode(WorkspaceChain.load(chain.all()), device.id, { envelope: (env) => pc.replica.receive(env), wraps: () => pc.replica.refreshKeys() });
    pc.start = () => {
      pc.replica = new RoomReplica(pc.node, roomId, { sign: device.sign, agree: device.agree }, { clash: (_doc, version) => clash(pc, version) });
      // The replica never lets working out a clash throw (see quietly): note what would have.
      const clashes = (pc.replica as unknown as { clashes: Record<string, (...args: unknown[]) => unknown> }).clashes;
      for (const name of ["recordLocal", "check", "settle", "typedClash", "takeOutTyped", "restoreSaves", "copyKept", "retryTakeOuts"]) {
        const call = clashes[name]!.bind(clashes);
        clashes[name] = (...args) => {
          try {
            return call(...args);
          } catch (error) {
            errors.push(error);
            throw error;
          }
        };
      }
    };
    pc.start();
    return pc;
  });
  for (const device of devices) pcs[0]!.node.addWrap(wrapRoomKey(ws, roomId, 1, key, { id: device.id, agree: device.agree.publicKey }, admin.sign));
  const pairs = pcs.flatMap((a, i) => pcs.slice(i + 1).map((b) => [a, b] as const));
  const links = pairs.map(([a, b]) => net.link(a.node, b.node));
  await net.settle();
  for (const pc of pcs) pc.replica.refreshKeys();
  const fileId = randomId("f");
  pcs[0]!.replica.editIndex((files) => files.set(fileId, { path: "Task.md", kind: "md" }));
  /** A computer's plugin writes the note (see reconcileYTextByLines). */
  const save = (pc: Pc, text: string) => {
    expect(pc.replica.edit(fileId, (doc) => void reconcileYTextByLines(doc.getText("content"), text, "disk"), true)).toBe("published");
    expect(pc.replica.noteText(fileId)).toBe(text);
  };
  /** Keep the copies asked for (`some`: each with that chance; the room's folder may be busy), as the folder's passes do. */
  const keep = async (pc: Pc, some?: () => boolean) => {
    for (const version of pc.asked.splice(0)) {
      if (some && !some()) {
        pc.asked.push(version);
        continue;
      }
      pc.copies.push(version);
      pc.replica.copyKept(fileId, version);
    }
    await net.settle();
  };
  return { pcs, net, pairs, links, errors, fileId, save, keep };
}

/** One save: up to three changes, each to a line of its own, with an unchanged line between any two. */
function change(view: Line[], rand: () => number, line: () => string): void {
  // Now and then a save moves a line instead, one not changed this round, past two lines or more (one line further is
  // just as well the other line moved).
  if (rand() < 0.15) {
    const from = Math.floor(rand() * view.length);
    const to = Math.floor(rand() * (view.length + 1));
    const one = view[from];
    if (one && one.text === one.origin && !one.moved && (to <= from - 2 || to >= from + 3)) {
      view.splice(from, 1);
      view.splice(to > from ? to - 1 : to, 0, { ...one, moved: true });
      return;
    }
  }
  const picked: number[] = [];
  for (let tries = 0; tries < 6 && picked.length < 3; tries++) {
    const at = Math.floor(rand() * (view.length + 1));
    if (picked.every((p) => Math.abs(p - at) >= 2)) picked.push(at);
  }
  for (const at of picked.sort((a, b) => b - a)) {
    const r = rand();
    if (at === view.length || r < 0.15) {
      const text = line();
      view.splice(at, 0, { text, origin: `+${text}` });
    } else if (r < 0.3) view.splice(at, 1);
    else if (!view[at]!.moved) view[at] = { text: line(), origin: view[at]!.origin };
  }
}

async function run(seed: number): Promise<void> {
  const rand = random(seed);
  // A third of the copies asked for are kept at once, the others later.
  const { pcs, net, pairs, links: first, errors, fileId, save, keep } = await room(rand() < 0.5 ? 2 : 3, (pc, version) => {
    if (rand() < 0.3) return pc.copies.push(version) > 0;
    pc.asked.push(version);
    return false;
  });
  let links = first;
  const known = new Set<string>();
  let count = 0;
  const line = () => {
    const text = `t${count++} 2026-${String(1 + Math.floor(rand() * 12)).padStart(2, "0")}-${String(1 + Math.floor(rand() * 28)).padStart(2, "0")}`;
    known.add(text);
    return text;
  };
  pcs[0]!.replica.edit(fileId, (doc) => doc.getText("content").insert(0, Array.from({ length: 3 + Math.floor(rand() * 6) }, () => `${line()}\n`).join("")));
  await net.settle();

  for (let round = 0; round < ROUNDS; round++) {
    const start = pcs[0]!.replica.noteText(fileId);
    for (const link of links) link.cut();
    await net.settle();
    // Each computer starts the round with a Yjs client of its own (as after a restart), lowest in the seed's order.
    const order = shuffle(pcs.map((_, i) => i), rand);
    pcs.forEach((pc, i) => {
      pc.asked = [];
      pc.copies = [];
      pc.client = 1 + round * pcs.length + order[i]!;
      pc.replica.reload(fileId).clientID = pc.client;
      // Loading the note again (and checking what it holds) changes nothing: the round before ended settled.
      expect(pc.replica.noteText(fileId), `seed ${seed}, round ${round}: ${pc.name} reloaded`).toBe(start);
      expect([...pc.asked, ...pc.copies], `seed ${seed}, round ${round}: ${pc.name} reloaded`).toEqual([]);
      pc.view = linesOf(start).map((text) => ({ text, origin: text }));
      pc.saves = [0, 1, 1, 2][Math.floor(rand() * 4)]!;
      for (let k = 0; k < pc.saves; k++) {
        change(pc.view, rand, line);
        save(pc, textOf(pc.view));
      }
    });
    // They meet again, two at a time, keeping some copies as they go, or asking again (the room's folder came back).
    links = [];
    for (const [a, b] of shuffle([...pairs], rand)) {
      links.push(net.link(a.node, b.node));
      await net.settle();
      for (const pc of pcs) {
        if (rand() < 0.5) await keep(pc, () => rand() < 0.5);
        if (rand() < 0.1) pc.replica.retryTakeOuts();
      }
    }
    for (let i = 0; pcs.some((pc) => pc.asked.length > 0); i++) {
      if (i === 10) throw new Error(`seed ${seed}: copies asked for again and again`);
      for (const pc of pcs) await keep(pc);
    }

    const final = pcs[0]!.replica.noteText(fileId);
    const finalLines = new Set(linesOf(final));
    const show = (text: string) => linesOf(text).join(" | ");
    const report = [
      `seed ${seed} (FUZZ_SEED=${seed}), round ${round}`,
      `start: ${show(start)}`,
      ...pcs.map((pc) => `${pc.name} client ${pc.client}, ${pc.saves} saves: ${show(textOf(pc.view))}\n  copies: ${pc.copies.map(show).join(" // ")}`),
      ...pcs.map((pc) => `${pc.name} final: ${show(pc.replica.noteText(fileId))}`)
    ].join("\n");
    expect(errors, report).toEqual([]);
    for (const pc of pcs) expect(pc.replica.noteText(fileId), report).toBe(final);
    expect(final === "" || final.endsWith("\n"), report).toBe(true);
    for (const text of [final, ...pcs.flatMap((pc) => pc.copies)]) for (const l of linesOf(text)) expect(known.has(l), `made of two lines: ${l}\n${report}`).toBe(true);
    for (const pc of pcs) {
      for (const { text, origin } of pc.view) {
        if (text === origin || finalLines.has(text)) continue;
        expect(pc.copies.some((copy) => linesOf(copy).includes(text)), `${pc.name} lost ${text}\n${report}`).toBe(true);
      }
    }
    for (const l of linesOf(start)) if (pcs.every((pc) => pc.view.some((v) => v.text === l))) expect(finalLines.has(l), `nobody changed ${l}\n${report}`).toBe(true);
    expect(finalLines.size, `a line twice\n${report}`).toBe(linesOf(final).length);
    const gaveWay = new Set<Pc>();
    const lowest = <T extends { pc: Pc }>(list: T[]) => list.reduce((a, b) => (b.pc.client < a.pc.client ? b : a));
    for (const origin of linesOf(start)) {
      const replaced = pcs.flatMap((pc) => pc.view.filter((v) => v.origin === origin && v.text !== origin).map((v) => ({ pc, text: v.text })));
      const moved = pcs.filter((pc) => pc.view.some((v) => v.origin === origin && v.moved)).map((pc) => ({ pc }));
      // A line changed where it was stays over one moved (of several, the lowest client's); of several moves, one.
      const kept = replaced.length > 0 ? lowest(replaced).pc : moved.length > 0 ? lowest(moved).pc : null;
      for (const { pc, text } of replaced) {
        expect(finalLines.has(text), `${text} ${pc === kept ? "should stay" : "should give way"}\n${report}`).toBe(pc === kept);
        if (pc !== kept) gaveWay.add(pc);
      }
      if (moved.length > 0) expect(finalLines.has(origin), `${origin} moved ${replaced.length > 0 ? "should give way" : "should stay"}\n${report}`).toBe(replaced.length === 0);
      for (const { pc } of moved) {
        if (pc === kept) continue;
        gaveWay.add(pc);
        // Moved to the same place as the move that stays, it isn't lost (and its copy would be the note itself).
        expect(finalLines.has(origin) || pc.copies.some((copy) => linesOf(copy).includes(origin)), `${pc.name} lost its move of ${origin}\n${report}`).toBe(true);
      }
    }
    for (const pc of pcs) if (!gaveWay.has(pc)) expect(pc.copies, `${pc.name} kept a copy for nothing\n${report}`).toEqual([]);
  }
}

describe("clashing saves", () => {
  const one = Number(process.env.FUZZ_SEED);
  const seeds = Number.isInteger(one) && process.env.FUZZ_SEED ? [one] : Array.from({ length: Number(process.env.FUZZ_SEEDS) || 40 }, (_, i) => i + 1);
  it("converge, lose no saved line, mix none, and keep the lowest client's line (seeded fuzz)", async () => {
    for (const seed of seeds) await run(seed);
  }, 60_000 + seeds.length * 3_000);

  it("keep a losing line in its copy when the clash is found as the note loads, its old rival replaced since", async () => {
    // Copies are asked for, and kept later, as by the room folder.
    const { pcs, net, links, errors, fileId, save, keep } = await room(2, (pc, version) => pc.asked.push(version) < 0);
    const [a, c] = pcs as [Pc, Pc];
    a.replica.edit(fileId, (doc) => doc.getText("content").insert(0, "due: 2030-01-01\nmid\nend\n"));
    await net.settle();
    c.replica.noteText(fileId);
    let link = links[0]!;
    /** Apart, each computer's plugin writes the note (`apart`, with Yjs client ids of the round), then they meet. */
    const round = async (apart: () => void) => {
      link.cut();
      await net.settle();
      apart();
      link = net.link(a.node, c.node);
      await net.settle();
      c.replica.noteText(fileId);
      for (let i = 0; i < 5 && pcs.some((pc) => pc.asked.length > 0); i++) for (const pc of pcs) await keep(pc);
    };
    const saveAs = (pc: Pc, client: number, ...texts: string[]) => {
      pc.replica.reload(fileId).clientID = client;
      for (const text of texts) save(pc, text);
    };
    // Cy's plugin writes a date and takes the line out again; Ana's writes another date, which stays (Cy's is gone).
    await round(() => {
      saveAs(c, 1, "due: 2030-01-02\nmid\nend\n", "mid\nend\n");
      saveAs(a, 2, "due: 2030-01-03\nmid\nend\n");
    });
    await round(() => saveAs(a, 3, "due: 2030-01-04\nmid\nend\n"));
    // Both write the date again; Cy's client is the higher, so Cy's gives way. Cy's Obsidian starts again before they
    // meet, and Ana's save comes in before the note is loaded there: the old clash is looked at again as it loads.
    c.copies = [];
    await round(() => {
      saveAs(a, 4, "due: 2030-01-05\nmid\nend\n");
      saveAs(c, 5, "due: 2030-01-06\nmid\nend\n");
      const saves = c.replica.recentSaves();
      c.replica.destroy();
      c.start();
      c.replica.restoreSaves(saves);
    });
    expect(errors).toEqual([]);
    for (const pc of pcs) expect(pc.replica.noteText(fileId)).toBe("due: 2030-01-05\nmid\nend\n");
    expect(c.copies).toEqual(["due: 2030-01-06\nmid\nend\n"]);
  });
});
