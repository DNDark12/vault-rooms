import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { keyCommitment, MeshNode, newRoomKey, nextVersion, randomId, RoomReplica, WorkspaceChain, wrapRoomKey } from "@vault-rooms/secure";
import { createRoom, founder, invite, Network, type TestDevice } from "@vault-rooms/secure/testkit";
import { folderProblem, RoomFolder, type RoomFolderState } from "../../src/mesh/roomFolder.js";
import { MemoryVault } from "./memoryVault.js";

interface Pc {
  device: TestDevice;
  node: MeshNode;
  replica: RoomReplica;
  vault: MemoryVault;
  folder: RoomFolder;
  folderPath: string;
  /** The room's folder is hidden (see hide): clashes reach no folder, as with the plugin. */
  hidden: boolean;
  notices: string[];
  saved: { state: RoomFolderState | null; saves: unknown };
  /** The stored saves can't be read, or written (a locked file, say). */
  savesLocked?: "read" | "write";
  /** The stored state can't be read (a locked file, say). */
  stateLocked?: boolean;
  bound: Set<string>;
  gone: string[];
}

function setup(raeRole: "read" | "write" = "read") {
  const { chain, ws, admin: ana } = founder();
  const { joiner: cy } = invite(chain, ana, { userName: "Cy" });
  const { joiner: rae } = invite(chain, ana, { userName: "Rae" });
  const { roomId, key } = createRoom(chain, ana, "Team", { [cy.userId]: "write", [rae.userId]: raeRole });
  const net = new Network();
  const pcs = new Map<string, Pc>();
  /** A computer's room folder, on its replica. */
  const folderOf = (pc: Pc): RoomFolder => {
    const folder = new RoomFolder({
      folder: pc.folderPath,
      replica: pc.replica,
      vault: pc.vault,
      deviceName: pc.device.name,
      isBound: (id) => pc.bound.has(id),
      folderGone: () => void pc.gone.push(pc.folderPath),
      loadState: async () => {
        if (pc.stateLocked) throw new Error("EBUSY");
        return pc.saved.state;
      },
      saveState: async (state) => {
        pc.saved.state = structuredClone(state);
      },
      loadSaves: async () => {
        if (pc.savesLocked === "read") throw new Error("EBUSY");
        return pc.saved.saves;
      },
      saveSaves: async (saves) => {
        if (pc.savesLocked === "write") throw new Error("EBUSY");
        pc.saved.saves = structuredClone(saves);
      },
      notify: (message) => pc.notices.push(message),
      log: (message) => process.env.FOLDER_LOG && console.log(`[${pc.device.name}] ${message}`),
      now: () => new Date("2026-10-26T12:30:00Z")
    });
    pc.vault.listener = {
      write: (path) => void folder.onLocalWrite(path),
      delete: (path) => void folder.onLocalDelete(path),
      rename: (from, to) => void folder.onLocalRename(from, to)
    };
    return folder;
  };
  /** A computer with this room's folder. `restart`: the same computer starting again (its stored envelopes kept). */
  const make = (device: TestDevice, folderPath: string, vault = new MemoryVault(), restart?: Pc): Pc => {
    restart?.replica.destroy();
    // As the plugin tells the folder (see MeshService.roomActivity): an envelope stored, for its note only (an index
    // change or an attachment: for everything), and a key that came in.
    const changed = (env: { k: string; doc?: string }) => pcs.get(device.id)?.folder.remoteChanged(env.k === "b" ? undefined : env.doc);
    const node = restart?.node ?? new MeshNode(WorkspaceChain.load(chain.all()), device.id, {
      envelope: (env) => {
        pcs.get(device.id)?.replica.receive(env);
        changed(env);
      },
      stored: changed,
      wraps: () => {
        const pc = pcs.get(device.id);
        if (pc?.replica.refreshKeys()) pc.folder.remoteChanged();
      }
    });
    const replica = new RoomReplica(node, roomId, { sign: device.sign, agree: device.agree }, {
      clash: (docId, version) => {
        const pc = pcs.get(device.id);
        return pc && !pc.hidden ? pc.folder.noteClashed(docId, version) : false;
      }
    });
    const saved = { state: restart?.saved.state ?? null, saves: restart?.saved.saves ?? null };
    const pc: Pc = { device, node, replica, vault, folderPath, hidden: false, notices: [], saved, bound: new Set(), gone: [], folder: undefined as unknown as RoomFolder };
    pc.folder = folderOf(pc);
    pcs.set(device.id, pc);
    return pc;
  };
  /** Hide a computer's room folder (being moved, say): it stops, and clashes reach no folder until it is shown again. */
  const hide = async (pc: Pc) => {
    pc.hidden = true;
    await pc.folder.stop();
  };
  /** Show it again: a new folder on the same replica. */
  const show = async (pc: Pc) => {
    pc.folder = folderOf(pc);
    pc.hidden = false;
    await pc.folder.start();
  };
  const giveKey = (from: Pc, to: TestDevice) => from.node.addWrap(wrapRoomKey(ws, roomId, 1, key, { id: to.id, agree: to.agree.publicKey }, ana.sign));
  /** Run until the network and every folder are quiet. */
  const settle = async () => {
    for (let round = 0; round < 6; round++) {
      net.pump();
      for (const pc of pcs.values()) await pc.folder.settled();
    }
  };
  return { ws, ana, cy, rae, roomId, key, net, make, giveKey, settle, hide, show };
}

const text = (vault: MemoryVault, path: string) => vault.text(path);

describe("room folder", () => {
  it("shares a folder's files and keeps both sides in step", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "# Plan\n");
    await a.vault.writeBytes("Team/img.png", new Uint8Array([1, 2, 3]));
    const c = s.make(s.cy, "Shared/Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    expect(text(c.vault, "Shared/Team/Plan.md")).toBe("# Plan\n");
    expect([...c.vault.files.get("Shared/Team/img.png")!]).toEqual([1, 2, 3]);
    // Edits, renames and deletions travel both ways.
    await c.vault.writeText("Shared/Team/Plan.md", "# Plan\n\n- [ ] Kickoff\n");
    await s.settle();
    expect(text(a.vault, "Team/Plan.md")).toBe("# Plan\n\n- [ ] Kickoff\n");
    await a.vault.rename("Team/Plan.md", "Team/Roadmap.md");
    await s.settle();
    expect(text(c.vault, "Shared/Team/Roadmap.md")).toBe("# Plan\n\n- [ ] Kickoff\n");
    expect(c.vault.files.has("Shared/Team/Plan.md")).toBe(false);
    await c.vault.trash("Shared/Team/img.png");
    await s.settle();
    expect(a.vault.files.has("Team/img.png")).toBe(false);
    expect(a.vault.trashed).toContain("Team/img.png");
  });

  it("keeps a file changed on both sides as a conflict copy instead of overwriting it", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Notes.md", "base\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    const link = s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    // Cy closes Obsidian; while it's closed, his copy changes on disk, and Ana edits hers.
    link.cut();
    await c.folder.stop();
    c.vault.silently("Team/Notes.md", "base\nCy's offline edit\n");
    await a.vault.writeText("Team/Notes.md", "base\nAna's edit\n");
    await s.settle();
    // Cy restarts: his copy changed here and remotely since the last sync.
    const c2 = s.make(s.cy, "Team", c.vault);
    c2.saved.state = c.saved.state;
    s.net.link(a.node, c2.node);
    await s.settle();
    c2.replica.refreshKeys();
    await c2.folder.start();
    await s.settle();
    const copies = [...c2.vault.files.keys()].filter((path) => path.includes("(conflict"));
    expect(copies).toHaveLength(1);
    expect(text(c2.vault, copies[0]!)).toBe("base\nCy's offline edit\n");
    // The note itself now holds the shared version, on both sides.
    expect(text(c2.vault, "Team/Notes.md")).toBe("base\nAna's edit\n");
    expect(text(a.vault, "Team/Notes.md")).toBe("base\nAna's edit\n");
    expect(c2.notices.some((n) => n.includes("kept as"))).toBe(true);
    // The conflict copy is shared like any new file, so nothing is lost for anyone.
    await s.settle();
    expect([...a.vault.files.keys()].some((path) => path.includes("(conflict"))).toBe(true);
  });

  it("shares an offline edit made while Obsidian was closed when nothing changed remotely", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Todo.md", "one\n");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    await a.folder.stop();
    a.vault.silently("Team/Todo.md", "one\ntwo\n");
    const a2 = s.make(s.ana, "Team", a.vault, a);
    a2.replica.refreshKeys();
    await a2.folder.start();
    await s.settle();
    const [id] = [...a2.replica.files().keys()];
    expect(a2.replica.noteText(id!)).toBe("one\ntwo\n");
    expect([...a2.vault.files.keys()].filter((path) => path.includes("(conflict"))).toEqual([]);
  });

  it("brings back a file deleted elsewhere if it was changed here", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Keep.md", "v1\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    const link = s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    link.cut();
    await c.folder.stop();
    c.vault.silently("Team/Keep.md", "v1\nimportant\n");
    await a.vault.trash("Team/Keep.md");
    await s.settle();
    const c2 = s.make(s.cy, "Team", c.vault);
    c2.saved.state = c.saved.state;
    s.net.link(a.node, c2.node);
    await s.settle();
    c2.replica.refreshKeys();
    await c2.folder.start();
    await s.settle();
    expect(text(c2.vault, "Team/Keep.md")).toBe("v1\nimportant\n");
    expect(text(a.vault, "Team/Keep.md")).toBe("v1\nimportant\n");
  });

  it("puts back a reader's local changes", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Rules.md", "be nice\n");
    const r = s.make(s.rae, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.rae);
    a.replica.refreshKeys();
    await a.folder.start();
    s.net.link(a.node, r.node);
    await s.settle();
    r.replica.refreshKeys();
    await r.folder.start();
    await s.settle();
    await r.vault.writeText("Team/Rules.md", "anything goes\n");
    await s.settle();
    expect(text(r.vault, "Team/Rules.md")).toBe("be nice\n");
    expect(text(a.vault, "Team/Rules.md")).toBe("be nice\n");
    // Nothing of the reader's is lost: their version stays next to it, on this computer only.
    const copy = [...r.vault.files.keys()].find((path) => path.includes("(your copy"))!;
    expect(text(r.vault, copy)).toBe("anything goes\n");
    expect(r.notices[0]).toContain("was put back");
    expect([...a.vault.files.keys()].some((path) => path.includes("(your copy"))).toBe(false);
    await r.vault.trash("Team/Rules.md");
    await s.settle();
    expect(text(r.vault, "Team/Rules.md")).toBe("be nice\n");
  });

  it("gives clashing names the same tie-break everywhere", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    const one = randomId("f");
    const two = randomId("f");
    a.replica.editIndex((files) => {
      files.set(one, { path: "Same.md", kind: "md" });
      files.set(two, { path: "same.md", kind: "md" });
    });
    a.folder.remoteChanged();
    await s.settle();
    const names = [...a.vault.files.keys()].sort();
    expect(names).toHaveLength(2);
    const loser = one < two ? two : one;
    expect(names.some((name) => name.includes(`(${loser.slice(1, 5)})`))).toBe(true);
  });

  it("never writes outside its folder, whatever a writer puts in the index", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    a.replica.editIndex((files) => {
      files.set(randomId("f"), { path: "../escape.md", kind: "md" });
      files.set(randomId("f"), { path: ".obsidian/plugins/x/main.js", kind: "bin" });
    });
    a.folder.remoteChanged();
    await s.settle();
    expect([...a.vault.files.keys()].filter((path) => !path.startsWith("Team/"))).toEqual([]);
    expect([...a.vault.files.keys()]).toEqual([]);
  });

  it("never takes something missing from the index for a deletion", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "keep me\n");
    await a.vault.writeBytes("Team/img.png", new Uint8Array([9, 9]));
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    await a.folder.stop();
    // The device's store is lost (or its key hasn't arrived): it starts from an empty index, remembering the files.
    const fresh = s.make(s.ana, "Team", a.vault);
    fresh.saved.state = a.saved.state;
    await fresh.folder.start();
    await s.settle();
    expect(text(fresh.vault, "Team/Plan.md")).toBe("keep me\n");
    expect(fresh.vault.files.has("Team/img.png")).toBe(true);
    expect(fresh.vault.trashed).toEqual([]);
  });

  it("keeps an attachment version made at the same time as someone else's", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeBytes("Team/img.png", new Uint8Array([1]));
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    const link = s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    link.cut();
    await a.vault.writeBytes("Team/img.png", new Uint8Array([2]));
    await c.vault.writeBytes("Team/img.png", new Uint8Array([3]));
    await s.settle();
    s.net.link(a.node, c.node);
    await s.settle();
    await s.settle();
    // Both end up with the same file, and the version that lost is kept as a copy, on both sides.
    expect([...a.vault.files.get("Team/img.png")!]).toEqual([...c.vault.files.get("Team/img.png")!]);
    const copies = (pc: typeof a) => [...pc.vault.files.keys()].filter((path) => path.includes("(conflict"));
    expect(copies(a)).toHaveLength(1);
    expect(copies(c)).toHaveLength(1);
    const kept = [...a.vault.files.get(copies(a)[0]!)!];
    expect([[2], [3]]).toContainEqual(kept);
    expect(kept).not.toEqual([...a.vault.files.get("Team/img.png")!]);
  });

  it("doesn't share or write files that could run something", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeBytes("Team/tool.ps1", new Uint8Array([1]));
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    expect(a.replica.files().size).toBe(0);
    expect(a.notices.some((n) => n.includes("tool.ps1"))).toBe(true);
    const blob = a.replica.putBlob(new Uint8Array([7]));
    a.replica.editIndex((files) => files.set(randomId("f"), { path: "run.exe", kind: "bin", blob }));
    a.folder.remoteChanged();
    await s.settle();
    expect(a.vault.files.has("Team/run.exe")).toBe(false);
  });

  it("deleting the room's folder here deletes nothing for anyone else", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/One.md", "1\n");
    await a.vault.writeText("Team/Two.md", "2\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    c.vault.removeFolder("Team");
    await s.settle();
    expect(c.gone).toEqual(["Team"]);
    expect([...a.replica.files().values()].map((entry) => entry.path).sort()).toEqual(["One.md", "Two.md"]);
    expect(text(a.vault, "Team/One.md")).toBe("1\n");
  });

  it("keeps a note too large to share on this computer, and doesn't overwrite it", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    const big = "x".repeat(7 << 20);
    await a.vault.writeText("Team/Big.md", big);
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    expect(a.replica.files().size).toBe(0);
    expect(text(a.vault, "Team/Big.md")?.length).toBe(big.length);
    expect(a.notices.some((n) => n.includes("Big.md") && n.includes("too large"))).toBe(true);
  });

  it("puts a file back under its name when renamed to one that can't be shared", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "plan\n");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    await a.vault.rename("Team/Plan.md", `Team/${"x".repeat(130)}.md`);
    await s.settle();
    expect(text(a.vault, "Team/Plan.md")).toBe("plan\n");
    expect([...a.replica.files().values()].map((entry) => entry.path)).toEqual(["Plan.md"]);
    expect(a.notices.some((n) => n.includes("keeps its old name"))).toBe(true);
  });

  it("shares notes with Windows line endings as the editor sees them, without rewriting the file", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Win.md", "one\r\ntwo\r\n");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    const [id] = [...a.replica.files().keys()];
    expect(a.replica.noteText(id!)).toBe("one\ntwo\n");
    expect(text(a.vault, "Team/Win.md")).toBe("one\r\ntwo\r\n");
    await a.vault.writeText("Team/Win.md", "one\r\ntwo\r\nthree\r\n");
    await s.settle();
    expect(a.replica.noteText(id!)).toBe("one\ntwo\nthree\n");
  });

  it("brings someone else's edit into a note with Windows line endings", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Win.md", "one\r\ntwo\r\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    await c.vault.writeText("Team/Win.md", "one\ntwo\nthree from Cy\n");
    await s.settle();
    expect(text(a.vault, "Team/Win.md")).toBe("one\ntwo\nthree from Cy\n");
  });

  it("keeps an edit that may not have been stored before Obsidian stopped", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "base\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    const link = s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    link.cut();
    // Ana edits, but her disk never manages to store the change before Obsidian stops.
    a.node.persist = () => Promise.reject(new Error("disk full"));
    await a.vault.writeText("Team/Plan.md", "base\nAna's last words\n");
    await s.settle();
    await a.folder.stop();
    // Ana starts again: her store lacks the edit (Cy has the version before it), her file has it.
    const again = s.make(s.ana, "Team", a.vault);
    again.saved.state = a.saved.state;
    s.net.link(again.node, c.node);
    await s.settle();
    again.replica.refreshKeys();
    await again.folder.start();
    await s.settle();
    const files = [...again.vault.files.keys()];
    const copy = files.find((path) => path.includes("(conflict"));
    expect(copy && text(again.vault, copy)).toBe("base\nAna's last words\n");
  });

  it("keeps someone's edit it couldn't store, if Obsidian stops before anyone who has it is back", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "base\n");
    const c = s.make(s.cy, "Team");
    const r = s.make(s.rae, "Team");
    for (const device of [s.ana, s.cy, s.rae]) s.giveKey(a, device);
    a.replica.refreshKeys();
    await a.folder.start();
    const toCy = s.net.link(a.node, c.node);
    const toRae = s.net.link(a.node, r.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    // Rae's computer goes away with the note as it was; then Cy's edit reaches Ana's, whose disk can't store it.
    toRae.cut();
    a.node.persist = () => Promise.reject(new Error("disk full"));
    await c.vault.writeText("Team/Plan.md", "base\nfrom Cy\n");
    await s.settle();
    expect(text(a.vault, "Team/Plan.md")).toBe("base\nfrom Cy\n");
    await a.folder.stop();
    toCy.cut();
    // Ana's computer starts again while Cy's is away, and hears only from Rae's, which never had the edit.
    const again = s.make(s.ana, "Team", a.vault);
    again.saved.state = a.saved.state;
    s.net.link(again.node, r.node);
    await s.settle();
    again.replica.refreshKeys();
    await again.folder.start();
    await s.settle();
    const copy = [...again.vault.files.keys()].find((path) => path.includes("(conflict"));
    expect(copy && text(again.vault, copy)).toBe("base\nfrom Cy\n");
  });

  it("keeps what was typed while the room's new key was missing, if Obsidian stops before it comes", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "base\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    const link = s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    // Ana starts a new room key and goes away before Cy's computer gets it; Cy types on in the open note.
    const k2 = newRoomKey();
    a.node.offerVersions([nextVersion(s.ws, a.node.chain.head, s.ana.sign, (state) => void state.rooms[s.roomId]!.epochs.push({ n: 2, commit: keyCommitment(s.ws, s.roomId, 2, k2) }))]);
    await s.settle();
    link.cut();
    const [id] = [...c.replica.files().keys()];
    c.bound.add(id!);
    expect(c.replica.edit(id!, (doc) => doc.getText("content").insert(5, "typed meanwhile\n"))).toBe("queued");
    await c.vault.writeText("Team/Plan.md", "base\ntyped meanwhile\n");
    await s.settle();
    await c.folder.stop();
    // Cy's computer starts again and hears from Ana's, which never had the typing: it stays, as changed here.
    const again = s.make(s.cy, "Team", c.vault);
    again.saved.state = c.saved.state;
    s.net.link(again.node, a.node);
    await s.settle();
    again.replica.refreshKeys();
    await again.folder.start();
    await s.settle();
    expect(text(again.vault, "Team/Plan.md")).toBe("base\ntyped meanwhile\n");
    expect([...again.vault.files.keys()].filter((path) => path.includes("(conflict"))).toEqual([]);
  });

  it("trashes a note someone else deleted while it was off, once only what it received there was left unstored", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "base\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    const link = s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    // Ana's disk stores her own edit after a moment, and never Cy's.
    a.node.persist = (env) => (env.author === s.ana.id ? new Promise<void>((resolve) => setTimeout(resolve, 100)) : Promise.reject(new Error("disk full")));
    await c.vault.writeText("Team/Plan.md", "base\nfrom Cy\n");
    await s.settle();
    await a.vault.writeText("Team/Plan.md", "base\nfrom Cy\nfrom Ana\n");
    await new Promise((resolve) => setTimeout(resolve, 700));
    await s.settle();
    expect(text(c.vault, "Team/Plan.md")).toBe("base\nfrom Cy\nfrom Ana\n");
    await a.folder.stop();
    link.cut();
    // While Ana is away, Cy deletes the note.
    await c.vault.trash("Team/Plan.md");
    await s.settle();
    const again = s.make(s.ana, "Team", a.vault);
    again.saved.state = a.saved.state;
    s.net.link(again.node, c.node);
    await s.settle();
    again.replica.refreshKeys();
    await again.folder.start();
    await s.settle();
    expect(again.vault.files.has("Team/Plan.md")).toBe(false);
    expect(again.notices.filter((message) => message.includes("deleted by someone else"))).toEqual([]);
  });

  it("keeps an attachment's version whose entry it couldn't store, if Obsidian stops before anyone who has it is back", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeBytes("Team/plan.pdf", new Uint8Array([1, 1, 1]));
    const c = s.make(s.cy, "Team");
    const r = s.make(s.rae, "Team");
    for (const device of [s.ana, s.cy, s.rae]) s.giveKey(a, device);
    a.replica.refreshKeys();
    await a.folder.start();
    const toCy = s.net.link(a.node, c.node);
    const toRae = s.net.link(a.node, r.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    // Rae's computer goes away; Cy saves a new version, whose index entry Ana's disk can't store.
    toRae.cut();
    a.node.persist = () => Promise.reject(new Error("disk full"));
    await c.vault.writeBytes("Team/plan.pdf", new Uint8Array([2, 2, 2]));
    await s.settle();
    expect([...a.vault.files.get("Team/plan.pdf")!]).toEqual([2, 2, 2]);
    await a.folder.stop();
    toCy.cut();
    // Ana's computer starts again while Cy's is away, and hears only from Rae's, which has the old version.
    const again = s.make(s.ana, "Team", a.vault);
    again.saved.state = a.saved.state;
    s.net.link(again.node, r.node);
    await s.settle();
    again.replica.refreshKeys();
    await again.folder.start();
    await s.settle();
    const copy = [...again.vault.files.keys()].find((path) => path.includes("(conflict"));
    expect(copy && [...again.vault.files.get(copy)!]).toEqual([2, 2, 2]);
  });

  it("clears a note's mark once what it received there is stored, even with nothing else going on", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "base\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    // Ana's disk is slow: Cy's edit is stored there a second after her folder took it in and saved its state.
    a.node.persist = () => new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    await c.vault.writeText("Team/Plan.md", "base\nfrom Cy\n");
    await s.settle();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(Object.values(a.saved.state!.known).map((known) => known.unstored)).toContain("received");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await s.settle();
    expect(Object.values(a.saved.state!.known).filter((known) => known.unstored)).toEqual([]);
  });

  it("starts on a folder of many synced files without looking each one up among all the others", async () => {
    const s = setup();
    // 5,000 files remembered as synced in an earlier session.
    const vault = new MemoryVault();
    const known: RoomFolderState["known"] = {};
    for (let i = 0; i < 5000; i++) {
      await vault.writeText(`Team/Note ${i}.md`, "");
      known[randomId("f")] = { path: `Note ${i}.md`, hash: "", size: 0, mtime: 0 };
    }
    const a = s.make(s.ana, "Team", vault);
    a.saved.state = { known };
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    const start = performance.now();
    await a.folder.start();
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("doesn't hold in doubt an edit stored just as Obsidian stopped", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "base\n");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    // A slow disk: Obsidian stops while the last edit is still being written.
    a.node.persist = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
    await a.vault.writeText("Team/Plan.md", "base\nlast words\n");
    await a.folder.stop();
    expect(Object.values(a.saved.state!.known).filter((known) => known.unstored)).toEqual([]);
  });

  it("keeps an edit that may not have been stored when someone else deletes the file", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "base\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    const link = s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    link.cut();
    a.node.persist = () => Promise.reject(new Error("disk full"));
    await a.vault.writeText("Team/Plan.md", "base\nAna's last words\n");
    await s.settle();
    await a.folder.stop();
    await c.vault.trash("Team/Plan.md");
    await s.settle();
    const again = s.make(s.ana, "Team", a.vault);
    again.saved.state = a.saved.state;
    s.net.link(again.node, c.node);
    await s.settle();
    again.replica.refreshKeys();
    await again.folder.start();
    await s.settle();
    expect(text(again.vault, "Team/Plan.md")).toBe("base\nAna's last words\n");
    expect(text(c.vault, "Team/Plan.md")).toBe("base\nAna's last words\n");
  });

  it("shares again a new file whose entry wasn't stored before Obsidian stopped", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    const link = s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    link.cut();
    a.node.persist = () => Promise.reject(new Error("disk full"));
    await a.vault.writeText("Team/New.md", "");
    await s.settle();
    await a.folder.stop();
    const again = s.make(s.ana, "Team", a.vault);
    again.saved.state = a.saved.state;
    s.net.link(again.node, c.node);
    await s.settle();
    again.replica.refreshKeys();
    await again.folder.start();
    await s.settle();
    expect([...c.replica.files().values()].map((entry) => entry.path)).toEqual(["New.md"]);
  });

  it("deletes a file it never changed when someone else does, even while its own writes are slow", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await c.vault.writeText("Team/Cy.md", "from Cy\n");
    await s.settle();
    // Ana's disk is stuck while she adds a note; meanwhile Cy edits his note, then deletes it.
    a.node.persist = () => new Promise<void>(() => {});
    await a.vault.writeText("Team/New.md", "new\n");
    await s.settle();
    await c.vault.writeText("Team/Cy.md", "from Cy, edited\n");
    await s.settle();
    expect(text(a.vault, "Team/Cy.md")).toBe("from Cy, edited\n");
    await c.vault.trash("Team/Cy.md");
    await s.settle();
    expect(a.vault.files.has("Team/Cy.md")).toBe(false);
    expect(a.notices.filter((message) => message.includes("deleted by someone else"))).toEqual([]);
  });

  it("deletes a file it never changed when someone else did while it was off, even if its own last writes failed", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    const link = s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await c.vault.writeText("Team/Cy.md", "from Cy\n");
    await s.settle();
    // Ana's disk fails while she adds a note and Cy's edit comes in; then Obsidian stops.
    a.node.persist = () => Promise.reject(new Error("disk full"));
    await a.vault.writeText("Team/New.md", "new\n");
    await s.settle();
    await c.vault.writeText("Team/Cy.md", "from Cy, edited\n");
    await s.settle();
    await a.folder.stop();
    link.cut();
    // While Ana is away, Cy deletes his note.
    await c.vault.trash("Team/Cy.md");
    await s.settle();
    const again = s.make(s.ana, "Team", a.vault);
    again.saved.state = a.saved.state;
    s.net.link(again.node, c.node);
    await s.settle();
    again.replica.refreshKeys();
    await again.folder.start();
    await s.settle();
    expect(again.vault.files.has("Team/Cy.md")).toBe(false);
    expect([...c.replica.files().values()].map((entry) => entry.path)).toEqual(["New.md"]);
  });

  it("never writes over a note held back here, even when someone else changes it", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "base\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    const [id] = [...a.replica.files().keys()];
    // An editor's change to the note couldn't be shared, so the note is held back here; then Cy changes it.
    a.folder.holdBackNote(id!);
    await c.vault.writeText("Team/Plan.md", "base\nfrom Cy\n");
    await s.settle();
    expect(text(a.vault, "Team/Plan.md")).toBe("base\n");
  });

  it("takes another change to a new note still waiting for the room key as a change, not as one more new note", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    const c = s.make(s.cy, "Team");
    s.net.link(a.node, c.node);
    await a.folder.start();
    await a.vault.writeText("Team/Early.md", "early\n");
    await s.settle();
    await a.vault.writeText("Team/Early.md", "early, then more\n");
    await s.settle();
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.folder.remoteChanged();
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    expect([...c.replica.files().values()].map((entry) => entry.path)).toEqual(["Early.md"]);
    expect(text(c.vault, "Team/Early.md")).toBe("early, then more\n");
  });

  it("shares again a note made while the room key was missing, if Obsidian stopped before its entry was stored", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    const c = s.make(s.cy, "Team");
    s.net.link(a.node, c.node);
    await a.folder.start();
    // No room key yet: Ana's new note waits for it; when it comes, her disk fails, and Obsidian stops.
    await a.vault.writeText("Team/Early.md", "early\n");
    await s.settle();
    a.node.persist = () => Promise.reject(new Error("disk full"));
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.folder.remoteChanged();
    await s.settle();
    await a.folder.stop();
    const again = s.make(s.ana, "Team", a.vault);
    again.saved.state = a.saved.state;
    s.net.link(again.node, c.node);
    await s.settle();
    again.replica.refreshKeys();
    await again.folder.start();
    await s.settle();
    expect([...c.replica.files().values()].map((entry) => entry.path)).toEqual(["Early.md"]);
  });

  it("keeps a change another program made as a copy, rather than undo someone's edit not written here yet", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "base\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    // Cy's edit reaches Ana's computer; before it is written there, a script changes the file on Ana's.
    await c.vault.writeText("Team/Plan.md", "base\nfrom Cy\n");
    await c.folder.settled();
    s.net.pump();
    await a.vault.writeText("Team/Plan.md", "base\nfrom a script\n");
    await s.settle();
    expect(text(c.vault, "Team/Plan.md")).toBe("base\nfrom Cy\n");
    expect(text(a.vault, "Team/Plan.md")).toBe("base\nfrom Cy\n");
    const copy = [...a.vault.files.keys()].find((path) => path.includes("(conflict"));
    expect(copy && text(a.vault, copy)).toBe("base\nfrom a script\n");
  });

  it("doesn't sync a folder whose last synced state can't be read, and leaves that state alone", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.vault.writeText("Team/Plan.md", "here\n");
    let saves = 0;
    const folder = new RoomFolder({
      folder: "Team",
      replica: a.replica,
      vault: a.vault,
      deviceName: "PC",
      isBound: () => false,
      loadState: () => Promise.reject(new Error("locked")),
      saveState: async () => void saves++,
      loadSaves: async () => null,
      saveSaves: async () => void saves++,
      notify: (message) => a.notices.push(message),
      log: () => {}
    });
    await folder.start();
    await folder.onLocalWrite("Team/Plan.md");
    await folder.stop();
    expect(saves).toBe(0);
    expect(a.replica.files().size).toBe(0);
    expect(a.notices.join()).toMatch(/isn't syncing/);
  });

  it("does nothing more once the room's replica is let go", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "base\n");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    const [id] = [...a.replica.files().keys()];
    // A change still queued when the room goes (access ended, or the room is being made again).
    void a.folder.onLocalWrite("Team/Plan.md");
    a.vault.files.set("Team/Plan.md", new TextEncoder().encode("changed\n"));
    a.replica.destroy();
    expect(() => a.replica.editIndex(() => {})).toThrow(/destroyed/);
    await a.folder.stop();
    expect(a.saved.state!.known[id!]!.hash).toBe(createHash("sha256").update("base\n").digest("base64url"));
  });

  it("doesn't call a newer version of someone else's attachment a clash", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeBytes("Team/img.png", new Uint8Array([1]));
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    const link = s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    link.cut();
    // Ana saves the image twice while Cy is away; Cy then gets only the newest.
    await a.vault.writeBytes("Team/img.png", new Uint8Array([2]));
    await s.settle();
    await a.vault.writeBytes("Team/img.png", new Uint8Array([3]));
    await s.settle();
    s.net.link(a.node, c.node);
    await s.settle();
    expect([...c.vault.files.get("Team/img.png")!]).toEqual([3]);
    expect([...c.vault.files.keys()].filter((path) => path.includes("(conflict"))).toEqual([]);
  });

  it("shares a deletion made just before stopping, and an attachment added back after its blob was cleaned up", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Gone.md", "bye\n");
    await a.vault.writeBytes("Team/report.pdf", new Uint8Array([5, 5]));
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    await a.vault.trash("Team/Gone.md");
    await a.folder.stop();
    expect([...a.replica.files().values()].map((entry) => entry.path)).toEqual(["report.pdf"]);
    // The PDF is deleted and its blob cleaned up; the same file is added back later.
    const again = s.make(s.ana, "Team", a.vault, a);
    await again.folder.start();
    await a.vault.trash("Team/report.pdf");
    await s.settle();
    const [meta] = again.node.store.blobsOf(s.roomId);
    again.node.store.dropBlobs(s.roomId, [`${meta!.author}/${meta!.id}`]);
    await a.vault.writeBytes("Team/report.pdf", new Uint8Array([5, 5]));
    await s.settle();
    expect([...again.replica.files().values()].map((entry) => entry.path)).toEqual(["report.pdf"]);
    expect(again.node.store.blobKeys(s.roomId)).toHaveLength(1);
  });

  it("leaves notes open in an editor to the editor", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Live.md", "start\n");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    const [id] = [...a.replica.files().keys()];
    a.bound.add(id!);
    a.replica.noteDoc(id!).getText("content").insert(0, "typed ");
    a.folder.remoteChanged();
    await s.settle();
    expect(text(a.vault, "Team/Live.md")).toBe("start\n");
  });

  /** Ana and Cy, both writers, sharing the room's folder (Ana's files first). */
  async function pair(files: Record<string, string | Uint8Array> = {}) {
    const s = setup();
    const a = s.make(s.ana, "Team");
    for (const [path, content] of Object.entries(files)) {
      if (typeof content === "string") await a.vault.writeText(path, content);
      else await a.vault.writeBytes(path, content);
    }
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    const link = s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    return { s, a, c, link };
  }

  it("doesn't put back on a reader's computer a note whose history there can't be read", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "# Plan\n");
    const r = s.make(s.rae, "Team");
    for (const device of [s.ana, s.rae]) s.giveKey(a, device);
    a.replica.refreshKeys();
    await a.folder.start();
    const link = s.net.link(a.node, r.node);
    await s.settle();
    r.replica.refreshKeys();
    await r.folder.start();
    await s.settle();
    const id = [...r.replica.files().keys()][0]!;
    link.cut();
    // As after a restart while another program holds the note's history on disk.
    const store = r.node.store;
    store.compact(s.roomId, id, store.envelopesOf(s.roomId, id).updates, {});
    store.setUnreadable(s.roomId, id, true);
    r.replica.reload(id);
    await r.vault.writeText("Team/Plan.md", "# Plan\nmine\n");
    await s.settle();
    expect(text(r.vault, "Team/Plan.md")).toBe("# Plan\nmine\n");
  });

  it("looks only at the note that changed when one of many is edited elsewhere", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`Team/n${i}.md`] = `note ${i}\n`;
    const { s, a, c } = await pair(files);
    const read = new Set<string>();
    const noteText = c.replica.noteText.bind(c.replica);
    c.replica.noteText = (id) => {
      read.add(id);
      return noteText(id);
    };
    await a.vault.writeText("Team/n3.md", "note 3\nmore\n");
    await s.settle();
    expect(text(c.vault, "Team/n3.md")).toBe("note 3\nmore\n");
    expect([...read].map((id) => c.replica.files().get(id)?.path)).toEqual(["n3.md"]);
  });

  it("leaves a note as it is while its history here can't be read, and syncs it once it can", async () => {
    const { s, a, c, link } = await pair({ "Team/Plan.md": "# Plan\n- one\n" });
    const id = [...c.replica.files().keys()][0]!;
    link.cut();
    await c.folder.stop();
    // Cy restarts while another program holds the note's history on disk: the store opens without it.
    const store = c.node.store;
    const { snapshots, updates } = store.envelopesOf(s.roomId, id);
    expect(snapshots).toHaveLength(0);
    store.compact(s.roomId, id, updates, {});
    store.setUnreadable(s.roomId, id, true);
    const c2 = s.make(s.cy, "Team", c.vault, c);
    c2.replica.refreshKeys();
    await c2.folder.start();
    await s.settle();
    expect(text(c2.vault, "Team/Plan.md")).toBe("# Plan\n- one\n");
    // An edit made here meanwhile isn't shared on what little is known of the note.
    await c2.vault.writeText("Team/Plan.md", "# Plan\n- one\n- two\n");
    await s.settle();
    expect(c2.replica.noteText(id)).toBe("");
    // The history can be read now: it is taken in, and the edit made here is shared.
    for (const env of updates) store.add(env);
    store.setUnreadable(s.roomId, id, false);
    for (const env of updates) c2.replica.receive(env);
    c2.folder.remoteChanged(id);
    s.net.link(a.node, c2.node);
    await s.settle();
    expect(text(a.vault, "Team/Plan.md")).toBe("# Plan\n- one\n- two\n");
    expect(text(c2.vault, "Team/Plan.md")).toBe("# Plan\n- one\n- two\n");
  });

  it("keeps one of two values saved at the same moment in the same place, and the other as a copy", async () => {
    const { s, a, c, link } = await pair({ "Team/Task.md": "---\ndue: 2030-01-01\n---\nPlan\n" });
    link.cut();
    // Another plugin writes a different date on each computer while they are apart.
    await a.vault.writeText("Team/Task.md", "---\ndue: 2030-01-03\n---\nPlan\n");
    await a.folder.settled();
    await c.vault.writeText("Team/Task.md", "---\ndue: 2030-01-04\n---\nPlan\n");
    await c.folder.settled();
    s.net.link(a.node, c.node);
    await s.settle();
    await s.settle();
    const main = text(a.vault, "Team/Task.md")!;
    expect(text(c.vault, "Team/Task.md")).toBe(main);
    expect(["---\ndue: 2030-01-03\n---\nPlan\n", "---\ndue: 2030-01-04\n---\nPlan\n"]).toContain(main);
    const other = main.includes("01-03") ? "---\ndue: 2030-01-04\n---\nPlan\n" : "---\ndue: 2030-01-03\n---\nPlan\n";
    const copies = [a.vault, c.vault].flatMap((vault) => [...vault.files.keys()].filter((path) => path.includes("(conflict")).map((path) => text(vault, path)));
    expect(copies).toContain(other);
  });

  it("keeps one of two dates written over the same one whole, and what only one side changed", async () => {
    const { s, a, c, link } = await pair({ "Team/Task.md": "---\ntitle: Plan\nstart: 2030-01-09\nend: 2030-01-20\n---\n" });
    link.cut();
    // Ana's plugin moves the task by three days, Cy's to the next month (and renames it); the dates share characters.
    const ana = "---\ntitle: Plan\nstart: 2030-01-12\nend: 2030-01-23\n---\n";
    const cy = "---\ntitle: Plan B\nstart: 2030-02-03\nend: 2030-01-20\n---\n";
    await a.vault.writeText("Team/Task.md", ana);
    await a.folder.settled();
    await c.vault.writeText("Team/Task.md", cy);
    await c.folder.settled();
    s.net.link(a.node, c.node);
    await s.settle();
    await s.settle();
    const main = text(a.vault, "Team/Task.md")!;
    expect(text(c.vault, "Team/Task.md")).toBe(main);
    // One start date, whole (either may be kept, the same everywhere); what only one side changed stays.
    const start = /start: (.*)/.exec(main)?.[1];
    expect(["2030-01-12", "2030-02-03"]).toContain(start);
    expect(main).toBe(`---\ntitle: Plan B\nstart: ${start}\nend: 2030-01-23\n---\n`);
    // The other date is kept in a copy (shared like any file), in the note as it then was.
    const other = start === "2030-01-12" ? "2030-02-03" : "2030-01-12";
    const copies = [a.vault, c.vault].flatMap((vault) => [...vault.files.keys()].filter((path) => path.includes("(conflict")).map((path) => text(vault, path)));
    expect(new Set(copies)).toEqual(new Set([`---\ntitle: Plan B\nstart: ${other}\nend: 2030-01-23\n---\n`]));
  });

  /** Each computer saves `saves` (in turn) of a note while apart; then they meet. Returns the note and the copies. */
  async function savedApart(base: string, ana: string[], cy: string[], bind = false, restart = false) {
    const { s, a, c, link } = await pair({ "Team/Task.md": base });
    const id = [...a.replica.files().keys()][0]!;
    link.cut();
    for (const [pc, saves] of [[a, ana], [c, cy]] as const) {
      for (const save of saves) {
        await pc.vault.writeText("Team/Task.md", save);
        await pc.folder.settled();
      }
      if (bind) pc.bound.add(id);
    }
    let pcs = [a, c];
    if (restart) {
      // Both stop and start again; each has all of the other's saves before its folder starts.
      for (const pc of pcs) await pc.folder.stop();
      pcs = [s.make(s.ana, "Team", a.vault, a), s.make(s.cy, "Team", c.vault, c)];
      s.net.link(a.node, c.node);
      s.net.pump();
      for (const pc of pcs) {
        pc.replica.refreshKeys();
        await pc.folder.start();
      }
    } else s.net.link(a.node, c.node);
    await s.settle();
    await s.settle();
    const notes = pcs.map((pc) => pc.replica.noteText(id));
    const copies = new Set([a.vault, c.vault].flatMap((vault) => [...vault.files.keys()].filter((path) => path.includes("(conflict")).map((path) => text(vault, path))));
    return { notes, copies };
  }

  const board = "## Todo\n- [ ] Ship release\n- [ ] Write notes\n## Done\n- [ ] Old task\n";
  const moved = "## Todo\n- [ ] Write notes\n## Done\n- [ ] Ship release\n- [ ] Old task\n";

  it("keeps a card checked off where it was rather than also the same card moved on another computer, and the move as a copy", async () => {
    const { notes, copies } = await savedApart(board, [moved], [board.replace("- [ ] Ship", "- [x] Ship")]);
    expect(notes).toEqual([board.replace("- [ ] Ship", "- [x] Ship"), board.replace("- [ ] Ship", "- [x] Ship")]);
    expect(copies).toEqual(new Set([moved]));
  });

  it("keeps one card of two computers that moved it to different places, and the other place as a copy", async () => {
    const elsewhere = "## Todo\n- [ ] Write notes\n## Done\n- [ ] Old task\n- [ ] Ship release\n";
    const { notes, copies } = await savedApart(board, [moved], [elsewhere]);
    expect(notes[1]).toBe(notes[0]);
    expect([moved, elsewhere]).toContain(notes[0]);
    expect(copies).toEqual(new Set([notes[0] === moved ? elsewhere : moved]));
  });

  it("keeps one line of two computers that each changed it twice while apart", async () => {
    const { notes, copies } = await savedApart("due: 2030-01-09\n", ["due: 2030-01-10\n", "due: 2030-01-11\n"], ["due: 2030-02-01\n", "due: 2030-02-02\n"]);
    expect(notes[1]).toBe(notes[0]);
    expect(["due: 2030-01-11\n", "due: 2030-02-02\n"]).toContain(notes[0]);
    expect(copies).toEqual(new Set([notes[0] === "due: 2030-01-11\n" ? "due: 2030-02-02\n" : "due: 2030-01-11\n"]));
  });

  it("keeps one line of two computers that each changed it twice while apart, after a restart too", async () => {
    const { notes, copies } = await savedApart("due: 2030-01-09\n", ["due: 2030-01-10\n", "due: 2030-01-11\n"], ["due: 2030-02-01\n", "due: 2030-02-02\n"], false, true);
    expect(notes[1]).toBe(notes[0]);
    expect(["due: 2030-01-11\n", "due: 2030-02-02\n"]).toContain(notes[0]);
    expect(copies).toEqual(new Set([notes[0] === "due: 2030-01-11\n" ? "due: 2030-02-02\n" : "due: 2030-01-11\n"]));
  });

  it("keeps the losing version as a copy when the note is open in an editor", async () => {
    const { notes, copies } = await savedApart("due: 2030-01-09\n", ["due: 2030-01-12\n"], ["due: 2030-02-03\n"], true);
    expect(notes[1]).toBe(notes[0]);
    expect(["due: 2030-01-12\n", "due: 2030-02-03\n"]).toContain(notes[0]);
    expect(copies).toEqual(new Set([notes[0] === "due: 2030-01-12\n" ? "due: 2030-02-03\n" : "due: 2030-01-12\n"]));
  });

  it("keeps a line a plugin wrote over one typed into at the same moment, and the typed version as a copy", async () => {
    const { s, a, c, link } = await pair({ "Team/Task.md": "---\ndue: 2030-01-09\n---\n" });
    const id = [...a.replica.files().keys()][0]!;
    link.cut();
    // A plugin on Ana's computer writes a new date; on Cy's, someone types over one digit of the old one.
    await a.vault.writeText("Team/Task.md", "---\ndue: 2030-02-03\n---\n");
    await a.folder.settled();
    c.bound.add(id);
    const typed = c.replica.noteDoc(id);
    const at = typed.getText("content").toString().indexOf("9");
    typed.transact(() => {
      typed.getText("content").delete(at, 1);
      typed.getText("content").insert(at, "7");
    });
    s.net.link(a.node, c.node);
    await s.settle();
    await s.settle();
    // Ana's line is kept whole, on both computers; what was typed is kept on Cy's as a copy.
    expect(a.replica.noteText(id)).toBe("---\ndue: 2030-02-03\n---\n");
    expect(c.replica.noteText(id)).toBe("---\ndue: 2030-02-03\n---\n");
    const copies = new Set([a.vault, c.vault].flatMap((vault) => [...vault.files.keys()].filter((path) => path.includes("(conflict")).map((path) => text(vault, path))));
    expect(copies).toEqual(new Set(["---\ndue: 2030-01-07\n---\n"]));
  });

  it("never runs two lines together, even when the other's save only comes inside a snapshot", async () => {
    const { s, a, c, link } = await pair({ "Team/Task.md": "---\ndue: 2030-01-09\n---\n" });
    const id = [...a.replica.files().keys()][0]!;
    link.cut();
    await a.vault.writeText("Team/Task.md", "---\ndue: 2030-01-12\n---\n");
    await a.folder.settled();
    await c.vault.writeText("Team/Task.md", "---\ndue: 2030-02-03\n---\n");
    await c.folder.settled();
    // Cy's save now travels only inside a snapshot, which tells nobody whose lines it holds.
    expect(c.replica.snapshot(id, true)).not.toBeNull();
    s.net.link(a.node, c.node);
    await s.settle();
    await s.settle();
    const note = a.replica.noteText(id);
    expect(c.replica.noteText(id)).toBe(note);
    const dates = note.split("\n").filter((line) => line.startsWith("due"));
    expect(dates.length).toBeGreaterThan(0);
    for (const line of dates) expect(line).toMatch(/^due: 2030-\d\d-\d\d$/);
    const copies = [a.vault, c.vault].flatMap((vault) => [...vault.files.keys()].filter((path) => path.includes("(conflict")).map((path) => text(vault, path)));
    for (const date of ["2030-01-12", "2030-02-03"]) expect([note, ...copies].join()).toContain(date);
    // The line it brings that wasn't there before counts like one in an update: one line stays, the other is a copy.
    expect(dates).toHaveLength(1);
    expect(new Set(copies)).toEqual(new Set([`---\ndue: ${dates[0] === "due: 2030-01-12" ? "2030-02-03" : "2030-01-12"}\n---\n`]));
  });

  it("doesn't take a line typed in front of a saved one long ago for a rival when a snapshot brings it", async () => {
    // Ids are random, and what decides depends on them: tried many times.
    for (let round = 0; round < 16; round++) {
      const { s, a, c, link } = await pair({ "Team/Task.md": "---\ndue: 2030-01-09\n---\n" });
      const id = [...a.replica.files().keys()][0]!;
      // A line added above "due" earlier, then Ana's computer starts the note afresh (another Yjs client from then on).
      const text = a.replica.noteDoc(id).getText("content");
      text.insert(text.toString().indexOf("due"), "x: 1\n");
      await s.settle();
      a.replica.reload(id);
      link.cut();
      await a.vault.writeText("Team/Task.md", "---\nx: 1\ndue: 2030-01-12\n---\n");
      await a.folder.settled();
      await c.vault.writeText("Team/Task.md", "---\nx: 1\ndue: 2030-02-03\n---\n");
      await c.folder.settled();
      expect(c.replica.snapshot(id, true)).not.toBeNull();
      s.net.link(a.node, c.node);
      await s.settle();
      await s.settle();
      const note = a.replica.noteText(id);
      expect(c.replica.noteText(id)).toBe(note);
      expect(note.split("\n").filter((line) => line.startsWith("due"))).toHaveLength(1);
      expect(note).toContain("x: 1\n");
    }
  });

  it("keeps what was typed elsewhere in a note whose saved line clashed, on the winner and the loser", async () => {
    const { s, a, c, link } = await pair({ "Team/Task.md": "---\ndue: 2030-01-09\n---\nPlan\nNotes here\n" });
    const id = [...a.replica.files().keys()][0]!;
    link.cut();
    await a.vault.writeText("Team/Task.md", "---\ndue: 2030-01-12\n---\nPlan\nNotes here\n");
    await a.folder.settled();
    await c.vault.writeText("Team/Task.md", "---\ndue: 2030-02-03\n---\nPlan\nNotes here\n");
    await c.folder.settled();
    // Both also type in the body, in an editor.
    for (const [pc, typed] of [[a, " by Ana"], [c, " by Cy"]] as const) {
      pc.bound.add(id);
      const body = pc.replica.noteDoc(id).getText("content");
      body.insert(body.toString().indexOf("here") + 4, typed);
    }
    s.net.link(a.node, c.node);
    await s.settle();
    await s.settle();
    const note = a.replica.noteText(id);
    expect(c.replica.noteText(id)).toBe(note);
    expect(note.split("\n").filter((line) => line.startsWith("due"))).toHaveLength(1);
    expect(note).toMatch(/Notes here( by Ana| by Cy){2}\n$/);
  });

  it("settles a clash whose other line comes inside a snapshot that holds both lines", async () => {
    const s = setup("write");
    const [a, c, r] = [s.make(s.ana, "Team"), s.make(s.cy, "Team"), s.make(s.rae, "Team")];
    await a.vault.writeText("Team/Task.md", "---\ndue: 2030-01-09\n---\n");
    for (const pc of [a, c, r]) s.giveKey(a, pc.device);
    const links = [s.net.link(a.node, c.node), s.net.link(a.node, r.node), s.net.link(c.node, r.node)];
    for (const pc of [a, c, r]) {
      pc.replica.refreshKeys();
      await pc.folder.start();
    }
    await s.settle();
    const id = [...a.replica.files().keys()][0]!;
    for (const link of links) link.cut();
    await a.vault.writeText("Team/Task.md", "---\ndue: 2030-01-12\n---\n");
    await a.folder.settled();
    await c.vault.writeText("Team/Task.md", "---\ndue: 2030-02-03\n---\n");
    await c.folder.settled();
    // Rae gets Cy's save, then Ana's (and Ana settles against Cy's), and keeps both only in a snapshot of her own.
    let link = s.net.link(c.node, r.node);
    await s.settle();
    link.cut();
    link = s.net.link(a.node, r.node);
    await s.settle();
    expect(r.replica.snapshot(id, true)).not.toBeNull();
    link.cut();
    // Cy meets Rae alone: Ana's line reaches it only in that snapshot, along with Cy's own.
    s.net.link(c.node, r.node);
    await s.settle();
    s.net.link(a.node, c.node);
    s.net.link(a.node, r.node);
    await s.settle();
    await s.settle();
    const note = a.replica.noteText(id);
    for (const pc of [c, r]) expect(pc.replica.noteText(id)).toBe(note);
    expect(note.split("\n").filter((line) => line.startsWith("due"))).toHaveLength(1);
  });

  it("keeps the line of an earlier clash in the copy of a later one", async () => {
    const { s, a, c, link } = await pair({ "Team/Task.md": "---\ndue: 2030-01-09\n---\nstatus: open\n" });
    const id = [...a.replica.files().keys()][0]!;
    link.cut();
    await a.vault.writeText("Team/Task.md", "---\ndue: 2030-01-12\n---\nstatus: open\n");
    await a.folder.settled();
    await c.vault.writeText("Team/Task.md", "---\ndue: 2030-02-03\n---\nstatus: open\n");
    await c.folder.settled();
    let joined = s.net.link(a.node, c.node);
    await s.settle();
    await s.settle();
    const due = /due: .*/.exec(a.replica.noteText(id))![0];
    joined.cut();
    // A second clash, on another line, found as the note loads after both restart.
    await a.vault.writeText("Team/Task.md", `---\n${due}\n---\nstatus: done A\n`);
    await a.folder.settled();
    await c.vault.writeText("Team/Task.md", `---\n${due}\n---\nstatus: done C\n`);
    await c.folder.settled();
    for (const pc of [a, c]) await pc.folder.stop();
    const restarted = [s.make(s.ana, "Team", a.vault, a), s.make(s.cy, "Team", c.vault, c)];
    joined = s.net.link(a.node, c.node);
    s.net.pump();
    for (const pc of restarted) {
      pc.replica.refreshKeys();
      await pc.folder.start();
    }
    await s.settle();
    await s.settle();
    const note = a.replica.noteText(id);
    expect(note).toContain(`${due}\n`);
    const kept = /status: (.*)/.exec(note)![1];
    const other = kept === "done A" ? "done C" : "done A";
    const copies = [a.vault, c.vault].flatMap((vault) => [...vault.files.keys()].filter((path) => path.includes("(conflict")).map((path) => text(vault, path)));
    expect(copies).toContain(`---\n${due}\n---\nstatus: ${other}\n`);
  });

  /** Ana, Cy and Rae, all writers, each with the room's folder, all linked; `links()` cuts them all. */
  async function trio(base: string) {
    const s = setup("write");
    const [a, c, r] = [s.make(s.ana, "Team"), s.make(s.cy, "Team"), s.make(s.rae, "Team")];
    await a.vault.writeText("Team/Task.md", base);
    for (const pc of [a, c, r]) s.giveKey(a, pc.device);
    const links = [s.net.link(a.node, c.node), s.net.link(a.node, r.node), s.net.link(c.node, r.node)];
    for (const pc of [a, c, r]) {
      pc.replica.refreshKeys();
      await pc.folder.start();
    }
    await s.settle();
    for (const link of links) link.cut();
    return { s, a, c, r, id: [...a.replica.files().keys()][0]! };
  }

  it("keeps a line put above a losing line by someone else, even once that line changed again", async () => {
    for (let round = 0; round < 4; round++) {
      const { s, a, c, r, id } = await trio("---\nmodified: 9\n---\n");
      await a.vault.writeText("Team/Task.md", "---\nmodified: Ana\n---\n");
      await a.folder.settled();
      await c.vault.writeText("Team/Task.md", "---\nmodified: Cy 1\n---\n");
      await c.folder.settled();
      // Rae, with Cy, adds a line above Cy's; then Cy's plugin rewrites its line again.
      let link = s.net.link(c.node, r.node);
      await s.settle();
      r.bound.add(id);
      const text = r.replica.noteDoc(id).getText("content");
      text.insert(text.toString().indexOf("modified"), "tags: x\n");
      await s.settle();
      await c.vault.writeText("Team/Task.md", "---\ntags: x\nmodified: Cy 2\n---\n");
      await c.folder.settled();
      await s.settle();
      link.cut();
      for (const [x, y] of [[a, c], [a, r], [c, r]] as const) s.net.link(x.node, y.node);
      await s.settle();
      await s.settle();
      const note = a.replica.noteText(id);
      for (const pc of [c, r]) expect(pc.replica.noteText(id)).toBe(note);
      expect(note).toContain("tags: x\n");
      expect(note.split("\n").filter((line) => line.startsWith("modified"))).toHaveLength(1);
      link = link;
    }
  });

  it("doesn't let a line typed above a saved one, seen only in a snapshot holding the save, push the saved line out", async () => {
    // Whether the typed line would win depends on random ids: tried many times.
    for (let round = 0; round < 10; round++) {
      const { s, a, c, r, id } = await trio("---\ndue: 1\n---\n");
      // Ana's plugin rewrites the line while Cy, in an editor, types a new line above it.
      await a.vault.writeText("Team/Task.md", "---\ndue: 2\n---\n");
      await a.folder.settled();
      c.bound.add(id);
      const text = c.replica.noteDoc(id).getText("content");
      text.insert(text.toString().indexOf("due"), "tags: x\n");
      // Rae gets both, and keeps them only in a snapshot of her own; Ana then gets Cy's line only in it.
      for (const pc of [a, c]) {
        const link = s.net.link(pc.node, r.node);
        await s.settle();
        link.cut();
      }
      expect(r.replica.snapshot(id, true)).not.toBeNull();
      s.net.link(a.node, r.node);
      await s.settle();
      // Both lines stay (in either order: they were put in front of the same line at once).
      expect(["---\ntags: x\ndue: 2\n---\n", "---\ndue: 2\ntags: x\n---\n"]).toContain(a.replica.noteText(id));
    }
  });

  it("keeps one line of three computers that changed it at once, and nothing else is taken out", async () => {
    const s = setup("write");
    const pcs = [s.make(s.ana, "Team"), s.make(s.cy, "Team"), s.make(s.rae, "Team")];
    await pcs[0]!.vault.writeText("Team/Task.md", "---\ndue: 2030-01-09\n---\nPlan\nNext line stays\n");
    for (const pc of pcs) s.giveKey(pcs[0]!, pc.device);
    const links = [s.net.link(pcs[0]!.node, pcs[1]!.node), s.net.link(pcs[1]!.node, pcs[2]!.node), s.net.link(pcs[0]!.node, pcs[2]!.node)];
    for (const pc of pcs) {
      pc.replica.refreshKeys();
      await pc.folder.start();
    }
    await s.settle();
    for (const link of links) link.cut();
    const dates = ["2030-01-03", "2030-01-04", "2030-01-05"];
    for (const [i, pc] of pcs.entries()) {
      await pc.vault.writeText("Team/Task.md", `---\ndue: ${dates[i]}\n---\nPlan\nNext line stays\n`);
      await pc.folder.settled();
    }
    s.net.link(pcs[0]!.node, pcs[1]!.node);
    s.net.link(pcs[1]!.node, pcs[2]!.node);
    s.net.link(pcs[0]!.node, pcs[2]!.node);
    await s.settle();
    await s.settle();
    const id = [...pcs[0]!.replica.files().keys()][0]!;
    const note = pcs[0]!.replica.noteText(id);
    for (const pc of pcs) expect(pc.replica.noteText(id)).toBe(note);
    const kept = /due: (.*)/.exec(note)?.[1];
    expect(note).toBe(`---\ndue: ${kept}\n---\nPlan\nNext line stays\n`);
    const copies = new Set(pcs.flatMap((pc) => [...pc.vault.files.keys()].filter((path) => path.includes("(conflict")).map((path) => text(pc.vault, path))));
    expect(copies).toEqual(new Set(dates.filter((date) => date !== kept).map((date) => `---\ndue: ${date}\n---\nPlan\nNext line stays\n`)));
  });

  /**
   * Ana's plugin writes `saved` while Cy types into the note (`typing`, on Cy's computer); then they meet. `typerLower`:
   * Cy's Yjs client id is the lower one (text put in at the same place at once is ordered by client id).
   */
  async function typedApart(base: string, saved: string, typing: (text: Y.Text) => void, typerLower?: boolean) {
    const { s, a, c, link } = await pair({ "Team/Task.md": base });
    const id = [...a.replica.files().keys()][0]!;
    link.cut();
    if (typerLower !== undefined) a.replica.reload(id).clientID = typerLower ? 2 : 1;
    await a.vault.writeText("Team/Task.md", saved);
    await a.folder.settled();
    c.bound.add(id);
    const doc = typerLower === undefined ? c.replica.noteDoc(id) : c.replica.reload(id);
    if (typerLower !== undefined) doc.clientID = typerLower ? 1 : 2;
    typing(doc.getText("content"));
    s.net.link(a.node, c.node);
    await s.settle();
    await s.settle();
    const copies = new Set([a.vault, c.vault].flatMap((vault) => [...vault.files.keys()].filter((path) => path.includes("(conflict")).map((path) => text(vault, path))));
    return { notes: [a, c].map((pc) => pc.replica.noteText(id)), copies };
  }

  it("keeps a line added above a line a plugin rewrote at the same moment", async () => {
    // Enter at the start of the "due" line, up, and type: a line of its own, not a change inside "due".
    const { notes, copies } = await typedApart("---\ndue: 2030-01-01\n---\n", "---\ndue: 2030-02-02\n---\n", (text) => {
      const at = text.toString().indexOf("due");
      text.insert(at, "\n");
      text.insert(at, "tags: x");
    });
    expect(notes[1]).toBe(notes[0]);
    expect(["---\ntags: x\ndue: 2030-02-02\n---\n", "---\ndue: 2030-02-02\ntags: x\n---\n"]).toContain(notes[0]);
    expect(copies.size).toBe(0);
  });

  it("takes a line split in two inside a line a plugin rewrote at the same moment out whole, and keeps it as a copy", async () => {
    const { notes, copies } = await typedApart("---\ndue: 2030-01-01 note\n---\n", "---\ndue: 2030-02-02 note\n---\n", (text) => {
      text.insert(text.toString().indexOf(" note"), "\n");
    });
    expect(notes).toEqual(["---\ndue: 2030-02-02 note\n---\n", "---\ndue: 2030-02-02 note\n---\n"]);
    expect(copies).toEqual(new Set(["---\ndue: 2030-01-01\n note\n---\n"]));
  });

  it("leaves text typed at the end of a line alone when a save removes the last line after it", async () => {
    const { notes, copies } = await typedApart("first\nsecond\nlast", "FIRST\nsecond", (text) => {
      text.insert(text.toString().indexOf("\nlast"), " more");
    });
    expect(notes).toEqual(["FIRST\nsecond more", "FIRST\nsecond more"]);
    expect(copies.size).toBe(0);
  });

  it("keeps both of two lines added at the same moment to a note without a final line break", async () => {
    const { notes, copies } = await savedApart("# Log\n- one", ["# Log\n- one\n- from Ana"], ["# Log\n- one\n- from Cy"]);
    expect(notes[1]).toBe(notes[0]);
    expect(["# Log\n- one\n- from Ana\n- from Cy", "# Log\n- one\n- from Cy\n- from Ana"]).toContain(notes[0]);
    expect(copies.size).toBe(0);
  });

  it("keeps both of two lines added at the same moment to the end of a note with a final line break", async () => {
    const { notes, copies } = await savedApart("# Log\n- one\n", ["# Log\n- one\n- from Ana\n"], ["# Log\n- one\n- from Cy\n"]);
    expect(notes[1]).toBe(notes[0]);
    expect(["# Log\n- one\n- from Ana\n- from Cy\n", "# Log\n- one\n- from Cy\n- from Ana\n"]).toContain(notes[0]);
    expect(copies.size).toBe(0);
  });

  it("never leaves what was typed at the start of a line a plugin rewrote at the start of the next line", async () => {
    for (const typerLower of [true, false]) {
      const { notes, copies } = await typedApart("---\ndue: 2030-01-01\n---\n", "---\ndue: 2030-02-02\n---\n", (text) => text.insert(text.toString().indexOf("due"), "\t"), typerLower);
      expect(notes[1]).toBe(notes[0]);
      // Yjs puts the tab first if its client id is the lower: then it stays in front of the saved line. Otherwise it
      // would go to the start of the line after: it is taken out again, and kept in a copy.
      if (typerLower) {
        expect(notes[0]).toBe("---\n\tdue: 2030-02-02\n---\n");
        expect(copies.size).toBe(0);
      } else {
        expect(notes[0]).toBe("---\ndue: 2030-02-02\n---\n");
        expect(copies).toEqual(new Set(["---\n\tdue: 2030-01-01\n---\n"]));
      }
    }
  });

  it("leaves text typed after the line above alone when that line is joined to a line a plugin rewrote", async () => {
    for (const typerLower of [true, false]) {
      const { notes, copies } = await typedApart("foo\ndue: 2030-01-01\nend\n", "foo\ndue: 2030-02-02\nend\n", (text) => {
        text.insert(3, " bar");
        // The line break before "due" goes: the two lines are joined.
        text.delete(7, 1);
      }, typerLower);
      expect(notes).toEqual(["foo bardue: 2030-02-02\nend\n", "foo bardue: 2030-02-02\nend\n"]);
      expect(copies.size).toBe(0);
    }
  });

  it("doesn't take a losing line out before its copy is written", async () => {
    const { s, a, c, link } = await pair({ "Team/Task.md": "due: 2030-01-09\n" });
    const id = [...a.replica.files().keys()][0]!;
    link.cut();
    await a.vault.writeText("Team/Task.md", "due: 2030-01-12\n");
    await a.folder.settled();
    await c.vault.writeText("Team/Task.md", "due: 2030-02-03\n");
    await c.folder.settled();
    // No copy can be written for now (the disk is full, say).
    for (const pc of [a, c]) pc.vault.failWrites = (path) => path.includes("(conflict");
    s.net.link(a.node, c.node);
    await s.settle();
    await s.settle();
    // Nothing gave way: both dates are still in the note, everywhere.
    const dues = (note: string) => note.split("\n").filter((line) => line.startsWith("due"));
    for (const pc of [a, c]) expect(dues(pc.replica.noteText(id))).toHaveLength(2);
    // Copies can be written again: the next pass writes it, and the clash is settled.
    for (const pc of [a, c]) {
      pc.vault.failWrites = undefined;
      pc.folder.remoteChanged();
    }
    await s.settle();
    await s.settle();
    const note = a.replica.noteText(id);
    expect(c.replica.noteText(id)).toBe(note);
    expect(dues(note)).toHaveLength(1);
    const copies = [a.vault, c.vault].flatMap((vault) => [...vault.files.keys()].filter((path) => path.includes("(conflict")).map((path) => text(vault, path)));
    expect(new Set(copies)).toEqual(new Set([note.includes("01-12") ? "due: 2030-02-03\n" : "due: 2030-01-12\n"]));
  });

  it("doesn't write a note to disk while its clash copy is being written", async () => {
    const { s, a, c } = await pair({ "Team/Task.md": "due: 1\n", "Team/Other.md": "other\n" });
    const id = [...a.replica.files()].find(([, entry]) => entry.path === "Task.md")![0];
    // Ana's folder is busy (reading another note, slowly) when someone else's change of the note comes in.
    let open!: () => void;
    const slow = new Promise<void>((resolve) => (open = resolve));
    a.vault.gate = (path) => (path === "Team/Other.md" ? slow : undefined);
    void a.folder.onLocalWrite("Team/Other.md");
    await c.vault.writeText("Team/Task.md", "due: 2\n");
    await c.folder.settled();
    s.net.pump();
    const done = a.folder.settled();
    // A pass waits now; then a clash copy of the note is to be written.
    expect(a.folder.noteClashed(id, "due: mine\n")).toBe(false);
    const from = a.vault.written.length;
    open();
    await done;
    await a.folder.settled();
    const written = a.vault.written.slice(from).map(({ path }) => path);
    const copy = written.findIndex((path) => path.includes("(conflict"));
    expect(copy).toBeGreaterThanOrEqual(0);
    expect(written.indexOf("Team/Task.md")).toBeGreaterThan(copy);
    expect(text(a.vault, "Team/Task.md")).toBe("due: 2\n");
  });

  it("never writes a clash copy under a name the folder doesn't share", async () => {
    const { a } = await pair({ "Team/Task.md": "due: 1\n" });
    const id = [...a.replica.files().keys()][0]!;
    // A writer renames the note's entry to a name that could run something, then makes it clash.
    a.replica.editIndex((files) => files.set(id, { ...files.get(id)!, path: "Task.bat" }));
    expect(a.folder.noteClashed(id, "@echo off\n")).toBe(false);
    await a.folder.settled();
    expect([...a.vault.files.keys()].filter((path) => !path.endsWith(".md"))).toEqual([]);
  });

  it("writes one copy of a clash when the room's folder is hidden and shown again while it waits", async () => {
    const { s, a, c, link } = await pair({ "Team/Task.md": "due: 2030-01-09\n" });
    link.cut();
    await a.vault.writeText("Team/Task.md", "due: 2030-01-12\n");
    await a.folder.settled();
    await c.vault.writeText("Team/Task.md", "due: 2030-02-03\n");
    await c.folder.settled();
    s.net.link(a.node, c.node);
    s.net.pump();
    // The clash is found; before its copy is written, the folders are hidden, and shown again.
    for (const pc of [a, c]) await s.hide(pc);
    for (const pc of [a, c]) await s.show(pc);
    await s.settle();
    await s.settle();
    for (const vault of [a.vault, c.vault]) expect([...vault.files.keys()].filter((path) => path.includes("(conflict"))).toHaveLength(1);
    expect(text(c.vault, "Team/Task.md")).toBe(text(a.vault, "Team/Task.md"));
  });

  it("never writes a note with both lines of a clash found as it loads after a restart", async () => {
    const { s, a, c, link } = await pair({ "Team/Task.md": "due: 2030-01-09\n" });
    link.cut();
    await a.vault.writeText("Team/Task.md", "due: 2030-01-12\n");
    await a.folder.settled();
    await c.vault.writeText("Team/Task.md", "due: 2030-02-03\n");
    await c.folder.settled();
    // Both stop, and start again with the other's save already in.
    for (const pc of [a, c]) await pc.folder.stop();
    const pcs = [s.make(s.ana, "Team", a.vault, a), s.make(s.cy, "Team", c.vault, c)];
    s.net.link(a.node, c.node);
    s.net.pump();
    const from = [a.vault.written.length, c.vault.written.length];
    for (const pc of pcs) {
      pc.replica.refreshKeys();
      await pc.folder.start();
    }
    await s.settle();
    await s.settle();
    // The computer whose line gave way (the other shows both lines until it sees that) never wrote the note with both.
    const loser = text(a.vault, "Team/Task.md")!.includes("01-12") ? 1 : 0;
    const vault = [a.vault, c.vault][loser]!;
    for (const { path, text: written } of vault.written.slice(from[loser])) {
      if (path === "Team/Task.md") expect(written.split("\n").filter((line) => line.startsWith("due"))).toHaveLength(1);
    }
  });

  it("stores what was synced even when its saves can't be read or written, and never writes the saves over", async () => {
    const { s, a } = await pair({ "Team/Task.md": "due: 1\n" });
    await a.vault.writeText("Team/Task.md", "due: 22\n");
    await a.folder.settled();
    await a.folder.stop();
    const saves = a.saved.saves;
    expect(Object.keys(saves as object)).toHaveLength(1);
    // Ana's saves file can't be written for a while: what was synced is stored all the same.
    a.savesLocked = "write";
    const again = s.make(s.ana, "Team", a.vault, a);
    again.savesLocked = "write";
    again.replica.refreshKeys();
    await again.folder.start();
    await again.vault.writeText("Team/Task.md", "due: 333\n");
    await again.folder.settled();
    await again.folder.stop();
    expect(Object.values(again.saved.state!.known).map((known) => known.size)).toEqual([9]);
    // Then it can't be read when Obsidian starts: the saves in it are never written over.
    const last = s.make(s.ana, "Team", again.vault, again);
    last.savesLocked = "read";
    last.replica.refreshKeys();
    await last.folder.start();
    await last.vault.writeText("Team/Task.md", "due: 4444\n");
    await last.folder.settled();
    await last.folder.stop();
    expect(last.saved.saves).toBe(saves);
  });

  it("stores the saves of notes again only when they change", async () => {
    const { s, a, c } = await pair({ "Team/Task.md": "due: 1\n" });
    // What was synced is stored a moment after it changes.
    const stored = async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await a.folder.settled();
      return a.saved.saves;
    };
    const first = await stored();
    expect(first).toEqual({});
    // Someone else's change is written here: what was synced is stored again, the saves aren't.
    await c.vault.writeText("Team/Task.md", "due: 2\n");
    await s.settle();
    expect(text(a.vault, "Team/Task.md")).toBe("due: 2\n");
    expect(await stored()).toBe(first);
    // A save made here changes them.
    await a.vault.writeText("Team/Task.md", "due: 3\n");
    await s.settle();
    expect(Object.keys((await stored()) as object)).toHaveLength(1);
  });

  it("still notices a clash with a save made before a restart", async () => {
    const { s, a, c, link } = await pair({ "Team/Task.md": "---\nstart: 2030-01-09\n---\n" });
    const id = [...a.replica.files().keys()][0]!;
    link.cut();
    const ana = "---\nstart: 2030-01-12\n---\n";
    const cy = "---\nstart: 2030-02-03\n---\n";
    await a.vault.writeText("Team/Task.md", ana);
    await a.folder.settled();
    await c.vault.writeText("Team/Task.md", cy);
    await c.folder.settled();
    // Both computers restart, and meet: each has the other's save before its folder starts.
    await a.folder.stop();
    await c.folder.stop();
    const restarted = [s.make(s.ana, "Team", a.vault, a), s.make(s.cy, "Team", c.vault, c)];
    s.net.link(a.node, c.node);
    s.net.pump();
    for (const pc of restarted) {
      pc.replica.refreshKeys();
      pc.replica.noteText(id);
      await pc.folder.start();
    }
    await s.settle();
    await s.settle();
    const main = text(a.vault, "Team/Task.md")!;
    expect(text(c.vault, "Team/Task.md")).toBe(main);
    expect([ana, cy]).toContain(main);
    const copies = [a.vault, c.vault].flatMap((vault) => [...vault.files.keys()].filter((path) => path.includes("(conflict")).map((path) => text(vault, path)));
    expect(copies).toContain(main === ana ? cy : ana);
  });

  it("keeps a new save of an attachment made while its clash copy was being written", async () => {
    const { s, a, c, link } = await pair({ "Team/img.png": new Uint8Array([1]) });
    link.cut();
    await a.vault.writeBytes("Team/img.png", new Uint8Array([2]));
    await a.folder.settled();
    await c.vault.writeBytes("Team/img.png", new Uint8Array([3]));
    await c.folder.settled();
    // Whichever computer keeps its own version aside to take the other's, its user saves the image once more meanwhile.
    const saved: string[] = [];
    for (const [pc, again] of [[a, 4], [c, 5]] as const) {
      pc.vault.beforeGuardedWrite = (path) => {
        if (path !== "Team/img.png" || saved.includes(pc.device.name)) return;
        saved.push(pc.device.name);
        void pc.vault.writeBytes(path, new Uint8Array([again]));
      };
    }
    s.net.link(a.node, c.node);
    await s.settle();
    await s.settle();
    expect(saved).toHaveLength(1);
    const [pc, mine, again] = saved[0] === a.device.name ? [a, 2, 4] : [c, 3, 5];
    const versions = [...pc.vault.files.entries()].filter(([path]) => path.startsWith("Team/img")).map(([, bytes]) => [...bytes]);
    expect(versions).toContainEqual([again]);
    expect(versions).toContainEqual([mine]);
  });

  it("doesn't read attachments that didn't change when a note does", async () => {
    const { s, a, c } = await pair({ "Team/img.png": new Uint8Array(1000).fill(7), "Team/Plan.md": "plan\n" });
    let reads = 0;
    const read = a.replica.readBlob.bind(a.replica);
    a.replica.readBlob = (ref) => (reads++, read(ref));
    await c.vault.writeText("Team/Plan.md", "plan\nmore\n");
    await s.settle();
    expect(text(a.vault, "Team/Plan.md")).toBe("plan\nmore\n");
    expect(reads).toBe(0);
  });

  it("passes on the work of someone who may no longer write to a computer that catches up later", async () => {
    const { s, a, c } = await pair();
    await c.vault.writeText("Team/Cy.md", "from Cy\n");
    await c.vault.writeBytes("Team/pic.png", new Uint8Array([7, 7]));
    await s.settle();
    // Cy may only read from now on, and the room gets a new key; then Rae's computer catches up, from Ana's alone.
    const k2 = newRoomKey();
    a.node.offerVersions([
      nextVersion(s.ws, a.node.chain.head, s.ana.sign, (state) => {
        state.rooms[s.roomId]!.members[s.cy.userId] = "read";
        state.rooms[s.roomId]!.epochs.push({ n: 2, commit: keyCommitment(s.ws, s.roomId, 2, k2) });
      })
    ]);
    s.giveKey(a, s.rae);
    for (const to of [s.ana, s.cy, s.rae]) a.node.addWrap(wrapRoomKey(s.ws, s.roomId, 2, k2, { id: to.id, agree: to.agree.publicKey }, s.ana.sign));
    a.replica.refreshKeys();
    const r = s.make(s.rae, "Team");
    s.net.link(r.node, a.node);
    await s.settle();
    r.replica.refreshKeys();
    await r.folder.start();
    await s.settle();
    await a.replica.passOnOldWork(true, (author) => author === s.ana.id);
    await s.settle();
    await s.settle();
    expect(text(r.vault, "Team/Cy.md")).toBe("from Cy\n");
    expect([...(r.vault.files.get("Team/pic.png") ?? [])]).toEqual([7, 7]);
    // Ana's copy of the picture (under the new key) holds the same bytes: no computer reads it again when a note changes.
    expect(a.replica.files().get([...a.replica.files()].find(([, e]) => e.path === "pic.png")![0])!.blob!.by).toBe(s.ana.id);
    let reads = 0;
    for (const pc of [a, c, r]) {
      const read = pc.replica.readBlob.bind(pc.replica);
      pc.replica.readBlob = (ref) => (reads++, read(ref));
    }
    await a.vault.writeText("Team/Cy.md", "from Cy\nand Ana\n");
    await s.settle();
    expect(text(r.vault, "Team/Cy.md")).toBe("from Cy\nand Ana\n");
    expect(reads).toBe(0);
  });
});

async function until(check: () => boolean, ms = 8_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Ana's and Cy's computers, both with the room's folder "Team", started and in step. */
async function pair(files: Record<string, string> = {}) {
  const s = setup();
  const a = s.make(s.ana, "Team");
  for (const [path, content] of Object.entries(files)) await a.vault.writeText(`Team/${path}`, content);
  const c = s.make(s.cy, "Team");
  s.giveKey(a, s.ana);
  s.giveKey(a, s.cy);
  a.replica.refreshKeys();
  await a.folder.start();
  const link = s.net.link(a.node, c.node);
  await s.settle();
  c.replica.refreshKeys();
  await c.folder.start();
  await s.settle();
  return { s, a, c, link };
}

describe("room folder, files on disk", () => {
  it("puts back a note renamed into another type of file, and keeps sharing its edits", async () => {
    const { s, a, c } = await pair({ "a.md": "hello\n" });
    await a.vault.rename("Team/a.md", "Team/a.txt");
    await s.settle();
    expect(a.vault.files.has("Team/a.txt")).toBe(false);
    expect(a.notices.some((message) => message.includes("can't be renamed into another type of file"))).toBe(true);
    await a.vault.writeText("Team/a.md", "new\n");
    await s.settle();
    a.folder.remoteChanged();
    await s.settle();
    expect(text(a.vault, "Team/a.md")).toBe("new\n");
    expect(text(c.vault, "Team/a.md")).toBe("new\n");
  });

  it("puts back a file renamed into a note, and keeps sharing it", async () => {
    const { s, a, c } = await pair({ "b.txt": "plain\n" });
    await a.vault.rename("Team/b.txt", "Team/b.md");
    await s.settle();
    expect(a.vault.files.has("Team/b.md")).toBe(false);
    await a.vault.writeText("Team/b.txt", "changed\n");
    await s.settle();
    a.folder.remoteChanged();
    await s.settle();
    expect(text(a.vault, "Team/b.txt")).toBe("changed\n");
    expect(text(c.vault, "Team/b.txt")).toBe("changed\n");
  });

  it("shares edits of a note an earlier version renamed into another type of file, as a note", async () => {
    const { s, a, c, link } = await pair({ "a.md": "hello\n" });
    // Cy's computer, on an earlier version, renamed the note to a.txt in the index, still as a note.
    const [id] = [...c.replica.files().keys()];
    c.replica.editIndex((files) => files.set(id!, { path: "a.txt", kind: "md" }));
    await s.settle();
    expect(text(a.vault, "Team/a.txt")).toBe("hello\n");
    await a.vault.writeText("Team/a.txt", "new\n");
    await s.settle();
    a.folder.remoteChanged();
    await s.settle();
    expect(c.replica.noteText(id!)).toBe("new\n");
    expect(text(a.vault, "Team/a.txt")).toBe("new\n");
    // And after Ana's computer starts again.
    await a.folder.stop();
    link.cut();
    const again = s.make(s.ana, "Team", a.vault);
    again.saved.state = a.saved.state;
    s.net.link(again.node, c.node);
    await s.settle();
    again.replica.refreshKeys();
    await again.folder.start();
    await s.settle();
    expect(text(again.vault, "Team/a.txt")).toBe("new\n");
    expect([...again.vault.files.keys()].filter((path) => path.includes("(conflict"))).toEqual([]);
  });

  it("keeps trying a deletion it couldn't make yet, and never shares the file again for it", async () => {
    const { s, a, c } = await pair();
    await c.vault.writeText("Team/Plan.md", "base\n");
    await s.settle();
    // The file is held by another program on Ana's computer as Cy deletes it: reading it fails once, then trashing it.
    let reads = 1;
    let trashes = 1;
    a.vault.failReads = (path) => path === "Team/Plan.md" && reads-- > 0;
    a.vault.failTrash = (path) => path === "Team/Plan.md" && trashes-- > 0;
    await c.vault.trash("Team/Plan.md");
    await s.settle();
    await until(() => !a.vault.files.has("Team/Plan.md"));
    // Both failed once on the way.
    expect([reads < 0, trashes < 0]).toEqual([true, true]);
    await s.settle();
    expect([...a.replica.files().values()]).toEqual([]);
    expect([...c.replica.files().values()]).toEqual([]);
  }, 20_000);

  it("makes a deletion it couldn't make after a restart, and never shares the file again for it", async () => {
    const { s, a, c, link } = await pair();
    await c.vault.writeText("Team/Plan.md", "base\n");
    await s.settle();
    a.vault.failTrash = (path) => path === "Team/Plan.md";
    await c.vault.trash("Team/Plan.md");
    await s.settle();
    expect(a.vault.files.has("Team/Plan.md")).toBe(true);
    await a.folder.stop();
    link.cut();
    a.vault.failTrash = undefined;
    const again = s.make(s.ana, "Team", a.vault);
    again.saved.state = a.saved.state;
    s.net.link(again.node, c.node);
    await s.settle();
    again.replica.refreshKeys();
    await again.folder.start();
    await s.settle();
    expect(again.vault.files.has("Team/Plan.md")).toBe(false);
    expect([...c.replica.files().values()]).toEqual([]);
  });

  it("writes again by itself a file it couldn't write, once it can", async () => {
    const { s, a, c } = await pair();
    a.vault.failWrites = (path) => path === "Team/New.md";
    await c.vault.writeText("Team/New.md", "from Cy\n");
    await s.settle();
    expect(a.vault.files.has("Team/New.md")).toBe(false);
    a.vault.failWrites = undefined;
    await until(() => text(a.vault, "Team/New.md") === "from Cy\n");
  });

  it("gives files whose names collide names that fit every limit, so both stay shared", async () => {
    const { s, a, c } = await pair();
    const long = `${"x".repeat(117)}.md`;
    const deep = `${"d".repeat(100)}/${"e".repeat(100)}/${"f".repeat(100)}/${"y".repeat(90)}.md`;
    const ids = Array.from({ length: 4 }, () => randomId("f")).sort();
    // The lower id of each pair keeps the name.
    a.replica.editIndex((files) => {
      files.set(ids[0]!, { path: long, kind: "md" });
      files.set(ids[1]!, { path: long, kind: "md" });
      files.set(ids[2]!, { path: deep, kind: "md" });
      files.set(ids[3]!, { path: deep, kind: "md" });
    });
    for (const [i, id] of ids.entries()) a.replica.edit(id, (doc) => doc.getText("content").insert(0, `note ${i}\n`));
    a.folder.remoteChanged();
    await s.settle();
    const paths = [...a.replica.files()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([, entry]) => entry.path);
    expect(paths).toHaveLength(4);
    expect(new Set(paths.map((path) => path.toLowerCase())).size).toBe(4);
    for (const path of paths) {
      expect(path.length).toBeLessThanOrEqual(400);
      for (const segment of path.split("/")) expect(segment.length).toBeLessThanOrEqual(120);
    }
    expect([paths[0], paths[2]]).toEqual([long, deep]);
    for (const [i, path] of paths.entries()) {
      expect(text(a.vault, `Team/${path}`)).toBe(`note ${i}\n`);
      expect(text(c.vault, `Team/${path}`)).toBe(`note ${i}\n`);
    }
  });

  it("takes a longer tag when a colliding file's suffixed name is taken", async () => {
    const { s, a } = await pair();
    const ids = Array.from({ length: 2 }, () => randomId("f")).sort();
    const other = randomId("f");
    a.replica.editIndex((files) => {
      files.set(ids[0]!, { path: "plan.md", kind: "md" });
      files.set(ids[1]!, { path: "plan.md", kind: "md" });
      files.set(other, { path: `plan (${ids[1]!.slice(1, 5)}).md`, kind: "md" });
    });
    a.folder.remoteChanged();
    await s.settle();
    expect(a.replica.files().get(ids[1]!)?.path).toBe(`plan (${ids[1]!.slice(1, 9)}).md`);
    expect(a.replica.files().get(other)?.path).toBe(`plan (${ids[1]!.slice(1, 5)}).md`);
  });

  it("lists the folder's files about once per pass, however many files come in", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    for (let i = 0; i < 200; i++) await a.vault.writeText(`Team/n${i}.md`, `note ${i}\n`);
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    c.vault.lists = 0;
    await c.folder.start();
    await s.settle();
    expect(c.vault.files.size).toBe(200);
    expect(c.vault.lists).toBeLessThan(10);
  });
});

describe("room folder, rules and health", () => {
  it("offers and shares a folder by one rule: names, dot folders anywhere, overlaps as the disk compares them", () => {
    expect(folderProblem("Notes/.hidden/Sub", [])).not.toBeNull();
    expect(folderProblem(".obsidian", [])).not.toBeNull();
    expect(folderProblem("Team/Sub", ["team"])).not.toBeNull();
    expect(folderProblem("Projects", ["projects/2026"])).not.toBeNull();
    expect(folderProblem("Café", ["Café"])).not.toBeNull();
    expect(folderProblem("Team", ["Teams"])).toBeNull();
    // A hidden room's folder isn't among the folders of rooms shown here: it can be shared again.
    expect(folderProblem("Team", [])).toBeNull();
  });

  it("tells what isn't syncing, until it does", async () => {
    const { s, a, c } = await pair();
    a.vault.failWrites = (path) => path === "Team/New.md";
    await c.vault.writeText("Team/New.md", "from Cy\n");
    await s.settle();
    expect(a.folder.health()).toEqual({ stopped: null, failing: ["New.md"], heldBack: [] });
    a.vault.failWrites = undefined;
    a.folder.retryNow();
    await s.settle();
    expect(a.folder.health()).toEqual({ stopped: null, failing: [], heldBack: [] });
    expect(text(a.vault, "Team/New.md")).toBe("from Cy\n");
  });

  it("tells that a folder doesn't sync when what it last synced can't be read", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    a.stateLocked = true;
    await a.folder.start();
    expect(a.folder.health().stopped).toContain("EBUSY");
  });

  it("tells which notes of yours stay as they are here, not shared", async () => {
    const { s, a } = await pair({ "Plan.md": "base\n" });
    const [id] = [...a.replica.files().keys()];
    a.folder.holdBackNote(id!);
    await s.settle();
    expect(a.folder.health().heldBack).toEqual(["Plan.md"]);
  });
});

describe("room folder, retries", () => {
  it("shares a file it couldn't trash yet only once when it is saved meanwhile", async () => {
    const { s, a, c } = await pair();
    await c.vault.writeText("Team/Plan.md", "base\n");
    await s.settle();
    a.vault.failTrash = (path) => path === "Team/Plan.md";
    await c.vault.trash("Team/Plan.md");
    await s.settle();
    await a.vault.writeText("Team/Plan.md", "base\nkept\n");
    await s.settle();
    const live = (pc: { replica: { files(): Map<string, { path: string }> } }) => [...pc.replica.files().values()].filter((entry) => entry.path.startsWith("Plan"));
    expect(live(a)).toHaveLength(1);
    expect(live(c)).toHaveLength(1);
    expect(text(c.vault, `Team/${live(c)[0]!.path}`)).toBe("base\nkept\n");
  });

  it("takes in a local file it couldn't read at first, once it can", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeBytes("Team/scan.pdf", new Uint8Array([1, 2, 3]));
    let blocked = true;
    a.vault.failReads = (path) => blocked && path === "Team/scan.pdf";
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    expect([...a.replica.files().values()]).toEqual([]);
    blocked = false;
    await until(() => [...a.replica.files().values()].some((entry) => entry.path === "scan.pdf"));
  });

  it("tries a failed deletion again on its own schedule, keeping other passes small", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`n${i}.md`] = `note ${i}\n`;
    const { s, a, c } = await pair(files);
    await c.vault.writeText("Team/Plan.md", "base\n");
    await s.settle();
    a.vault.failTrash = (path) => path === "Team/Plan.md";
    await c.vault.trash("Team/Plan.md");
    await s.settle();
    // A change to one note right after: its pass looks at that note, not at every note of the room.
    let looked = 0;
    const noteText = a.replica.noteText.bind(a.replica);
    a.replica.noteText = (id: string) => (looked++, noteText(id));
    await c.vault.writeText("Team/n5.md", "note 5, edited\n");
    await s.settle();
    expect(text(a.vault, "Team/n5.md")).toBe("note 5, edited\n");
    expect(looked).toBeLessThan(5);
  });

  it("keeps one copy of a version it couldn't write over, however often it tries again", async () => {
    const { s, a, c } = await pair({ "Plan.md": "base\n" });
    // Changed here while Obsidian was closed, and by Cy: Ana's file can't be written while it is open elsewhere.
    a.vault.silently("Team/Plan.md", "base\nana\n");
    a.vault.failWrites = (path) => path === "Team/Plan.md";
    await c.vault.writeText("Team/Plan.md", "base\ncy\n");
    await s.settle();
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    const copies = () => [...a.vault.files.keys()].filter((path) => path.includes("(conflict"));
    expect(copies()).toHaveLength(1);
    a.vault.failWrites = undefined;
    await until(() => text(a.vault, "Team/Plan.md") === "base\ncy\n");
    expect(copies()).toHaveLength(1);
    expect(text(a.vault, copies()[0]!)).toBe("base\nana\n");
  }, 20_000);

  it("looks again at files held back when asked, and forgets those gone", async () => {
    const { s, a } = await pair({ "Plan.md": "base\n", "Log.md": "log\n" });
    const ids = [...a.replica.files()].map(([id]) => id);
    for (const id of ids) a.folder.holdBackNote(id);
    expect(a.folder.health().heldBack.sort()).toEqual(["Log.md", "Plan.md"]);
    await a.vault.trash("Team/Log.md");
    await s.settle();
    expect(a.folder.health().heldBack).toEqual(["Plan.md"]);
    a.folder.retryNow();
    await s.settle();
    expect(a.folder.health().heldBack).toEqual([]);
  });

  it("lets a note an earlier version renamed into another type of file take a note's name again", async () => {
    const { s, a, c } = await pair({ "a.md": "hello\n" });
    const [id] = [...c.replica.files().keys()];
    c.replica.editIndex((files) => files.set(id!, { path: "a.txt", kind: "md" }));
    await s.settle();
    await a.vault.rename("Team/a.txt", "Team/a.md");
    await s.settle();
    expect(a.vault.files.has("Team/a.md")).toBe(true);
    expect(c.replica.files().get(id!)?.path).toBe("a.md");
    expect(a.notices.filter((message) => message.includes("can't be renamed"))).toEqual([]);
  });
});

describe("room folder, retries and renames", () => {
  it("backs off retrying a write that keeps failing, even while other notes change", async () => {
    const { s, a, c } = await pair({ "n0.md": "note\n" });
    let attempts = 0;
    a.vault.failWrites = (path) => path === "Team/Locked.md" && ++attempts > 0;
    await c.vault.writeText("Team/Locked.md", "from Cy\n");
    await s.settle();
    // Cy keeps typing in another note meanwhile: those passes go fine, and mustn't make the retries come sooner.
    const start = Date.now();
    for (let i = 0; Date.now() - start < 4_500; i++) {
      await c.vault.writeText("Team/n0.md", `note ${i}\n`);
      await s.settle();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(attempts).toBeLessThanOrEqual(3);
  }, 20_000);

  it("doesn't read a local file too large to share", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeBytes("Team/kickoff.mp4", new Uint8Array(33 << 20));
    a.vault.failReads = (path) => path === "Team/kickoff.mp4";
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    expect(a.folder.health().failing).toEqual([]);
    expect(a.notices.some((message) => message.includes("kickoff.mp4") && message.includes("too large"))).toBe(true);
  });

  it("never takes another file for one whose rename here is blocked", async () => {
    const { s, a, c } = await pair();
    await c.vault.writeBytes("Team/a.pdf", new Uint8Array([1]));
    await c.vault.writeBytes("Team/b.pdf", new Uint8Array([2]));
    await s.settle();
    // Ana has a.pdf open in a program that won't let it be moved or trashed when Cy replaces it with b.pdf.
    a.vault.failTrash = (path) => path === "Team/a.pdf";
    await c.vault.trash("Team/a.pdf");
    await s.settle();
    await c.vault.rename("Team/b.pdf", "Team/a.pdf");
    await s.settle();
    expect([...c.vault.files.get("Team/a.pdf")!]).toEqual([2]);
    a.vault.failTrash = undefined;
    await until(() => a.vault.files.get("Team/a.pdf")?.[0] === 2);
    expect([...c.vault.files.get("Team/a.pdf")!]).toEqual([2]);
  }, 20_000);
});

describe("room folder, blocked renames", () => {
  /** Cy renames plan.pdf away and draft.pdf to its name, while Ana's plan.pdf can't be moved (open in another program). */
  async function blocked() {
    const { s, a, c } = await pair();
    await c.vault.writeBytes("Team/plan.pdf", new Uint8Array([1]));
    await c.vault.writeBytes("Team/draft.pdf", new Uint8Array([2]));
    await s.settle();
    a.vault.failMoves = (path) => path === "Team/plan.pdf";
    a.vault.failTrash = (path) => path === "Team/plan.pdf";
    await c.vault.rename("Team/plan.pdf", "Team/plan v1.pdf");
    await s.settle();
    await c.vault.rename("Team/draft.pdf", "Team/plan.pdf");
    await s.settle();
    return { s, a, c };
  }
  const bytes = (vault: MemoryVault, path: string) => [...(vault.files.get(path) ?? [])];

  it("never writes a new file over one whose rename is blocked, nor takes it for the renamed one", async () => {
    const { s, a, c } = await blocked();
    await c.vault.writeBytes("Team/draft.pdf", new Uint8Array([3]));
    await s.settle();
    expect(bytes(a.vault, "Team/draft.pdf")).toEqual([2]);
    a.vault.failMoves = a.vault.failTrash = undefined;
    await until(() => bytes(a.vault, "Team/draft.pdf")[0] === 3);
    await s.settle();
    for (const pc of [a, c]) {
      expect(bytes(pc.vault, "Team/plan v1.pdf")).toEqual([1]);
      expect(bytes(pc.vault, "Team/plan.pdf")).toEqual([2]);
      expect(bytes(pc.vault, "Team/draft.pdf")).toEqual([3]);
    }
  }, 20_000);

  it("takes a change made to a file whose rename is blocked from its new name, once it is there", async () => {
    const { s, a, c } = await blocked();
    await a.vault.writeBytes("Team/draft.pdf", new Uint8Array([2, 9]));
    await s.settle();
    a.vault.failMoves = a.vault.failTrash = undefined;
    a.folder.retryNow();
    for (let i = 0; i < 20 && bytes(c.vault, "Team/plan.pdf").length !== 2; i++) {
      await s.settle();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(bytes(c.vault, "Team/plan.pdf")).toEqual([2, 9]);
    expect(bytes(c.vault, "Team/plan v1.pdf")).toEqual([1]);
    // Moved, not left behind under its old name (to come back for everyone as a new file).
    expect(a.vault.files.has("Team/draft.pdf")).toBe(false);
    expect([...c.replica.files().values()].map((entry) => entry.path).sort()).toEqual(["plan v1.pdf", "plan.pdf"]);
  }, 20_000);

  it("keeps telling of a local file that can't be taken in, whatever else syncs", async () => {
    const { s, a, c } = await pair();
    a.vault.failReads = (path) => path === "Team/scan.pdf";
    await a.vault.writeBytes("Team/scan.pdf", new Uint8Array([1, 2, 3]));
    await s.settle();
    a.folder.retryNow();
    await s.settle();
    expect(a.folder.health().failing).toContain("scan.pdf");
    await c.vault.writeText("Team/New.md", "from Cy\n");
    await s.settle();
    expect(a.folder.health().failing).toContain("scan.pdf");
  });

  it("doesn't read a new local file too large to share", async () => {
    const { s, a } = await pair();
    a.vault.failReads = (path) => path === "Team/recording.mp4";
    await a.vault.writeBytes("Team/recording.mp4", new Uint8Array(33 << 20));
    await s.settle();
    expect(a.notices.some((message) => message.includes("recording.mp4") && message.includes("too large"))).toBe(true);
  });
});

describe("room folder, renames waiting", () => {
  const bytes = (vault: MemoryVault, path: string) => [...(vault.files.get(path) ?? [])];
  const copies = (vault: MemoryVault) => [...vault.files.keys()].filter((path) => path.includes("(conflict"));

  it("waits for a file whose removal is still to come rather than keep it as a copy", async () => {
    const { s, a, c } = await pair();
    await c.vault.writeBytes("Team/plan.pdf", new Uint8Array([1]));
    await c.vault.writeBytes("Team/draft.pdf", new Uint8Array([2]));
    await s.settle();
    // Ana has plan.pdf open in a program that won't let it be moved or trashed when Cy replaces it with the draft.
    a.vault.failTrash = (path) => path === "Team/plan.pdf";
    a.vault.failMoves = (path) => path === "Team/plan.pdf";
    await c.vault.trash("Team/plan.pdf");
    await s.settle();
    await c.vault.rename("Team/draft.pdf", "Team/plan.pdf");
    await s.settle();
    expect(copies(a.vault)).toEqual([]);
    a.vault.failTrash = a.vault.failMoves = undefined;
    a.folder.retryNow();
    for (let i = 0; i < 20 && bytes(a.vault, "Team/plan.pdf")[0] !== 2; i++) {
      await s.settle();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(bytes(a.vault, "Team/plan.pdf")).toEqual([2]);
    expect(a.vault.files.has("Team/draft.pdf")).toBe(false);
    expect([...copies(a.vault), ...copies(c.vault)]).toEqual([]);
    expect([...c.replica.files().values()].map((entry) => entry.path)).toEqual(["plan.pdf"]);
  }, 20_000);

  it("remembers an editor's save of a note whose rename waits, so no copy is made for it later", async () => {
    const { s, a, c } = await pair({ "Plan.md": "base\n" });
    const [id] = [...a.replica.files().keys()];
    a.vault.failMoves = (path) => path === "Team/Plan.md";
    await c.vault.rename("Team/Plan.md", "Team/Notes.md");
    await s.settle();
    // Ana types in the open note (the editor puts it into the shared text) and Obsidian saves it; Cy then edits too.
    a.bound.add(id!);
    a.replica.edit(id!, (doc) => doc.getText("content").insert(5, "typed\n"));
    await a.vault.writeText("Team/Plan.md", "base\ntyped\n");
    await s.settle();
    a.bound.delete(id!);
    await c.vault.writeText("Team/Notes.md", "base\ntyped\nfrom Cy\n");
    await s.settle();
    a.vault.failMoves = undefined;
    a.folder.retryNow();
    await s.settle();
    expect(text(a.vault, "Team/Notes.md")).toBe("base\ntyped\nfrom Cy\n");
    expect(copies(a.vault)).toEqual([]);
  });
});
