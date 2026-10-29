import { describe, expect, it } from "vitest";
import {
  createGenesis,
  INDEX_DOC,
  keyCommitment,
  newAgreementKeyPair,
  newRoomKey,
  newSigningKeyPair,
  nextVersion,
  randomId,
  sealBlob,
  sealRoomName,
  sealSnapshot,
  sealUpdate,
  utf8,
  WorkspaceChain,
  wrapRoomKey
} from "@vault-rooms/secure";
import { DiskStore, fileNameOf } from "../../src/mesh/diskStore.js";
import { MemoryFiles } from "./memoryFiles.js";

function world() {
  const sign = newSigningKeyPair();
  const agree = newAgreementKeyPair();
  const { genesis, workspaceId, userId, deviceId } = createGenesis({ workspaceName: "Team", userName: "Ana", deviceName: "PC", deviceKey: sign, agreementPublicKey: agree.publicKey, tlsFingerprint: "A".repeat(43) });
  const chain = new WorkspaceChain(genesis);
  const roomId = randomId("r");
  const key = newRoomKey();
  chain.offer([
    nextVersion(workspaceId, chain.head, sign, (state) => {
      state.rooms[roomId] = { creator: userId, name: sealRoomName(workspaceId, roomId, 1, key, "Plans"), members: { [userId]: "manage" }, epochs: [{ n: 1, commit: keyCommitment(workspaceId, roomId, 1, key) }] };
    })
  ]);
  const ctx = { ws: workspaceId, room: roomId, n: 1, key, author: sign };
  return { chain, workspaceId, deviceId, sign, agree, roomId, key, ctx };
}

const docFile = (root: string, room: string, doc: string) => `${root}/docs/${fileNameOf(room)}/${fileNameOf(doc)}.jsonl`;
const lines = (text: string) => text.split("\n").filter((line) => line.trim());

describe("disk store", () => {
  it("round-trips the record, wraps, envelopes and blobs", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "plugin/mesh/ws1");
    await disk.saveChain(w.chain.all());
    await disk.saveWraps([wrapRoomKey(w.workspaceId, w.roomId, 1, w.key, { id: w.deviceId, agree: w.agree.publicKey }, w.sign)]);
    const live = await disk.open();
    const doc = randomId("f");
    live.add(sealUpdate(w.ctx, doc, 1, utf8("one")));
    live.add(sealUpdate(w.ctx, doc, 2, utf8("two")));
    live.add(sealUpdate(w.ctx, INDEX_DOC, 1, utf8("index")));
    const blob = sealBlob(w.ctx, utf8("attachment"));
    live.add(blob);
    await disk.flush();

    const again = new DiskStore(files, "plugin/mesh/ws1");
    expect((await again.loadChain())!.map((v) => v.body.v)).toEqual([0, 1]);
    expect(await again.loadWraps()).toHaveLength(1);
    const loaded = await again.open();
    expect(loaded.digest(w.roomId)).toBe(live.digest(w.roomId));
    // The blob's ciphertext stays on disk until it is asked for.
    expect((await loaded.loadBlob(w.roomId, w.deviceId, blob.id))?.sig).toBe(blob.sig);
    // Loading doesn't write anything back (no duplicated lines).
    await again.flush();
    expect(lines(await files.read(docFile("plugin/mesh/ws1", w.roomId, doc)))).toHaveLength(2);
  });

  it("names files so that ids differing only in case never share one", () => {
    const id = randomId("r");
    const variant = id[0] + [...id.slice(1)].map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join("");
    expect(fileNameOf(id)).toBe(fileNameOf(id).toLowerCase());
    expect(fileNameOf(id)).not.toBe(fileNameOf(variant));
  });

  it("rewrites a document's log, with its marks, after a snapshot replaces envelopes", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const store = await disk.open();
    store.isMember = () => false;
    const doc = randomId("f");
    for (let clock = 1; clock <= 5; clock++) store.add(sealUpdate(w.ctx, doc, clock, utf8(`u${clock}`)));
    await disk.flush();
    store.add(sealSnapshot(w.ctx, doc, 1, { [w.deviceId]: 4 }, utf8("state")));
    await disk.flush();
    const written = lines(await files.read(docFile("m", w.roomId, doc))).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(written.map((entry) => entry.k ?? "marks")).toEqual(["marks", "s", "u"]);
    const reloaded = await new DiskStore(files, "m").open();
    expect(reloaded.vv(w.roomId, doc)).toEqual({ [w.deviceId]: 5 });
  });

  it("keeps a document whose journal can't be read incomplete, never writes over that journal, and takes it in once it can", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const store = await disk.open();
    const doc = randomId("f");
    for (let clock = 1; clock <= 3; clock++) store.add(sealUpdate(w.ctx, doc, clock, utf8(`u${clock}`)));
    await disk.flush();
    const path = docFile("m", w.roomId, doc);
    const before = files.data.get(path)!;
    // Another program holds the journal while the store opens again.
    files.failReads = (p) => p === path;
    const again = new DiskStore(files, "m");
    const late: number[] = [];
    again.onLateRead = (_room, _doc, envelopes) => {
      for (const env of envelopes) if (env.k === "u") late.push(env.clock);
    };
    const reopened = await again.open();
    expect(reopened.isUnreadable(w.roomId, doc)).toBe(true);
    expect(again.unreadDocs()).toBe(1);
    // An update comes in meanwhile (appended), and the document's journal is to be rewritten: it isn't, yet.
    reopened.add(sealUpdate(w.ctx, doc, 4, utf8("u4")));
    reopened.compact(w.roomId, doc, [], {});
    await again.flush();
    expect(files.data.get(path)!.startsWith(before)).toBe(true);
    // It can be read again: what it holds is taken in, and the document is complete.
    files.failReads = undefined;
    await again.retryUnread();
    expect(reopened.isUnreadable(w.roomId, doc)).toBe(false);
    expect(late).toEqual([1, 2, 3]);
    expect(reopened.vv(w.roomId, doc)).toEqual({ [w.deviceId]: 4 });
  });

  it("survives a torn append, an interrupted rewrite and an interrupted swap", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const store = await disk.open();
    const doc = randomId("f");
    store.add(sealUpdate(w.ctx, doc, 1, utf8("kept")));
    await disk.flush();
    const path = docFile("m", w.roomId, doc);
    await files.append(path, '\n{"k":"u","ws":"tor');
    // The next append starts on its own line, so the torn one takes nothing with it.
    store.add(sealUpdate(w.ctx, doc, 2, utf8("after")));
    await disk.flush();
    expect((await new DiskStore(files, "m").open()).vv(w.roomId, doc)).toEqual({ [w.deviceId]: 2 });
    // A rewrite interrupted after the old log was moved aside: the old copy is still read.
    await files.rename(path, `${path}.old`);
    expect((await new DiskStore(files, "m").open()).vv(w.roomId, doc)).toEqual({ [w.deviceId]: 2 });
    // A swap of the record interrupted the same way.
    await disk.saveChain(w.chain.all());
    await files.rename("m/chain.json", "m/chain.json.old");
    expect(await new DiskStore(files, "m").loadChain()).toHaveLength(2);
  });

  it("tells when an envelope made here is on disk", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const store = await disk.open();
    const env = sealUpdate(w.ctx, randomId("f"), 1, utf8("mine"));
    store.add(env);
    await disk.persisted(env);
    expect(await files.exists(docFile("m", w.roomId, env.doc))).toBe(true);
  });

  it("writes an envelope again when asked after its first write failed", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const store = await disk.open();
    const env = sealUpdate(w.ctx, randomId("f"), 1, utf8("mine"));
    files.failNextWriteTo = ".jsonl";
    store.add(env);
    await expect(disk.persisted(env)).rejects.toThrow("disk full");
    await disk.persisted(env);
    expect(lines(await files.read(docFile("m", w.roomId, env.doc)))).toHaveLength(1);
  });

  it("writes again the envelopes of a log whose write failed in one append", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const store = await disk.open();
    const doc = randomId("f");
    const envs = [1, 2, 3].map((clock) => sealUpdate(w.ctx, doc, clock, utf8(`edit ${clock}`)));
    files.failNextWriteTo = ".jsonl";
    for (const env of envs) store.add(env);
    await expect(disk.persisted(envs[0]!)).rejects.toThrow("disk full");
    let appends = 0;
    const append = files.append.bind(files);
    files.append = (path, data) => (appends++, append(path, data));
    await Promise.all(envs.map((env) => disk.persisted(env)));
    expect(appends).toBe(1);
    expect(lines(await files.read(docFile("m", w.roomId, doc)))).toHaveLength(3);
  });

  it("keeps the old record if writing the new one fails", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    await disk.saveChain(w.chain.all());
    files.failNextWriteTo = "chain.json.tmp";
    await expect(disk.saveChain([w.chain.head])).rejects.toThrow("disk full");
    expect(await new DiskStore(files, "m").loadChain()).toHaveLength(2);
  });

  it("wipes everything on leaving", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    await disk.saveChain(w.chain.all());
    await disk.wipe();
    expect([...files.data.keys()].filter((key) => key.startsWith("m/"))).toEqual([]);
  });
});
