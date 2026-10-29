import { describe, expect, it } from "vitest";
import { utf8 } from "./bytes.js";
import { newRoomKey } from "./keys.js";
import { SecureError } from "./errors.js";
import { blobId, INDEX_DOC, openEnvelope, parseEnvelope, sealBlob, sealPresence, sealSnapshot, sealUpdate, verifyEnvelope, type SealContext } from "./envelope.js";
import { EnvelopeStore, vvDominates } from "./store.js";
import { createRoom, founder, invite, step } from "./testkit.js";
import { randomId } from "./ids.js";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof SecureError ? error.code : String(error);
  }
  return "no error";
};

function setup() {
  const { chain, ws, admin } = founder();
  const { joiner: writer } = invite(chain, admin, { userName: "Wen" });
  const { joiner: reader } = invite(chain, admin, { userName: "Rae" });
  const { roomId, key } = createRoom(chain, admin, "Docs", { [writer.userId]: "write", [reader.userId]: "read" });
  const ctx = (device: typeof writer): SealContext => ({ ws, room: roomId, n: 1, key, author: device.sign });
  return { chain, ws, admin, writer, reader, roomId, key, ctx };
}

describe("envelopes", () => {
  it("round-trip for every kind, through JSON and the strict parser", () => {
    const { chain, ws, writer, reader, key, ctx } = setup();
    const doc = randomId("f");
    const envelopes = [
      sealUpdate(ctx(writer), doc, 1, utf8("update")),
      sealSnapshot(ctx(writer), doc, 1, { [writer.id]: 1 }, utf8("state")),
      sealBlob(ctx(writer), utf8("attachment")),
      sealPresence(ctx(reader), 1234, utf8("cursor"))
    ];
    for (const env of envelopes) {
      const parsed = parseEnvelope(JSON.parse(JSON.stringify(env)));
      expect(parsed).toEqual(env);
      expect(verifyEnvelope(chain.state, ws, parsed)).toBe(true);
      expect(openEnvelope(parsed, key).length).toBeGreaterThan(0);
    }
  });

  it("can't be moved to another document, author, clock or room", () => {
    const { chain, ws, writer, key, ctx, admin } = setup();
    const env = sealUpdate(ctx(writer), INDEX_DOC, 1, utf8("text"));
    for (const change of [{ doc: randomId("f") }, { clock: 2 }, { author: admin.id }, { n: 2 }]) {
      const moved = { ...env, ...change };
      expect(verifyEnvelope(chain.state, ws, moved)).toBe(false);
    }
    // Even re-signed by a writer, ciphertext moved to another clock won't decrypt.
    const resealed = sealUpdate(ctx(writer), INDEX_DOC, 2, utf8("x"));
    expect(code(() => openEnvelope({ ...resealed, nonce: env.nonce, ct: env.ct }, key))).toBe("decrypt_failed");
  });

  it("are only accepted from current writers (any member for presence)", () => {
    const { chain, ws, admin, writer, reader, roomId, ctx } = setup();
    expect(verifyEnvelope(chain.state, ws, sealUpdate(ctx(reader), INDEX_DOC, 1, utf8("x")))).toBe(false);
    expect(verifyEnvelope(chain.state, ws, sealPresence(ctx(reader), Date.now(), utf8("x")))).toBe(true);
    const fromWriter = sealUpdate(ctx(writer), INDEX_DOC, 1, utf8("x"));
    step(chain, admin, (state) => (state.rooms[roomId]!.members[writer.userId] = "read"));
    expect(verifyEnvelope(chain.state, ws, fromWriter)).toBe(false);
  });

  it("check blob ids against the plaintext", () => {
    const { roomId, key, ctx, writer } = setup();
    const env = sealBlob(ctx(writer), utf8("real"));
    expect(env.id).toBe(blobId(key, roomId, utf8("real")));
    expect(code(() => openEnvelope({ ...env, id: blobId(key, roomId, utf8("fake")) }, key))).toBe("decrypt_failed");
    expect(blobId(newRoomKey(), roomId, utf8("real"))).not.toBe(env.id);
  });

  it("are parsed strictly", () => {
    const { ctx, writer } = setup();
    const env = JSON.parse(JSON.stringify(sealUpdate(ctx(writer), INDEX_DOC, 1, utf8("x"))));
    expect(code(() => parseEnvelope({ ...env, id: "x" }))).toBe("bad_record");
    expect(code(() => parseEnvelope({ ...env, doc: "../etc" }))).toBe("bad_record");
    expect(code(() => parseEnvelope({ ...env, clock: 0 }))).toBe("bad_record");
    expect(code(() => parseEnvelope({ ...env, extra: 1 }))).toBe("bad_record");
  });
});

describe("envelope store", () => {
  it("tracks contiguous coverage, duplicates and equivocation", () => {
    const { ctx, writer, roomId } = setup();
    const store = new EnvelopeStore();
    const doc = randomId("f");
    const u1 = sealUpdate(ctx(writer), doc, 1, utf8("a"));
    const u3 = sealUpdate(ctx(writer), doc, 3, utf8("c"));
    expect(store.add(u1)).toBe("added");
    expect(store.add(u1)).toBe("duplicate");
    expect(store.add(u3)).toBe("added");
    expect(store.vv(roomId, doc)).toEqual({ [writer.id]: 1 });
    expect(store.add(sealUpdate(ctx(writer), doc, 1, utf8("other a")))).toBe("conflict");
    store.add(sealUpdate(ctx(writer), doc, 2, utf8("b")));
    expect(store.vv(roomId, doc)).toEqual({ [writer.id]: 3 });
    expect(store.missingFor(roomId, doc, { [writer.id]: 1 }).map((e) => (e.k === "u" ? e.clock : -1))).toEqual([2, 3]);
  });

  it("in a room it only relays, lets a snapshot replace its own author's updates it holds and claims", () => {
    const { ctx, writer, admin, roomId } = setup();
    const changed: string[] = [];
    const store = new EnvelopeStore({ docChanged: (_room, doc) => changed.push(doc) });
    store.isMember = () => false;
    const doc = randomId("f");
    for (let clock = 1; clock <= 3; clock++) store.add(sealUpdate(ctx(writer), doc, clock, utf8(`w${clock}`)));
    store.add(sealUpdate(ctx(admin), doc, 1, utf8("a1")));
    store.add(sealSnapshot(ctx(writer), doc, 1, { [writer.id]: 2, [admin.id]: 1 }, utf8("state")));
    expect(changed).toEqual([doc]);
    // Only the writer's own updates go: what the snapshot says of the admin's isn't taken on its word.
    expect(store.envelopesOf(roomId, doc).updates.map((u) => `${u.author === writer.id ? "w" : "a"}${u.clock}`).sort()).toEqual(["a1", "w3"]);
    expect(store.vv(roomId, doc)).toEqual({ [writer.id]: 3, [admin.id]: 1 });
    // A newer snapshot drops the same author's older one; an older one arriving later is ignored.
    expect(store.add(sealSnapshot(ctx(writer), doc, 2, { [writer.id]: 3, [admin.id]: 1 }, utf8("state2")))).toBe("added");
    expect(store.envelopesOf(roomId, doc).snapshots).toHaveLength(1);
    expect(store.add(sealSnapshot(ctx(writer), doc, 3, { [writer.id]: 1 }, utf8("old")))).toBe("duplicate");
    // A lying snapshot can't remove another author's updates or snapshots, nor push any counter up.
    store.add(sealSnapshot(ctx(admin), doc, 1, { [writer.id]: Number.MAX_SAFE_INTEGER, [admin.id]: 1 }, utf8("liar")));
    expect(store.envelopesOf(roomId, doc).snapshots.some((s) => s.author === writer.id)).toBe(true);
    expect(store.vv(roomId, doc)).toEqual({ [writer.id]: 3, [admin.id]: 1 });
    expect(store.maxClock(roomId, doc, writer.id)).toBe(3);
    expect(store.add(sealUpdate(ctx(writer), doc, 4, utf8("w4")))).toBe("added");
    expect(store.missingFor(roomId, doc, { [writer.id]: 3, [admin.id]: 1 }).map((u) => u.clock)).toEqual([4]);
    expect(vvDominates({ a: 2 }, { a: 1 })).toBe(true);
  });

  it("in a room it is in, drops nothing on a snapshot's word", () => {
    const { ctx, writer, admin, roomId } = setup();
    const store = new EnvelopeStore();
    const doc = randomId("f");
    for (let clock = 1; clock <= 3; clock++) store.add(sealUpdate(ctx(writer), doc, clock, utf8(`w${clock}`)));
    store.add(sealSnapshot(ctx(admin), doc, 1, { [writer.id]: Number.MAX_SAFE_INTEGER }, utf8("empty")));
    expect(store.envelopesOf(roomId, doc).updates).toHaveLength(3);
    expect(store.vv(roomId, doc)).toEqual({ [writer.id]: 3 });
    expect(store.maxClock(roomId, doc, writer.id)).toBe(3);
    expect(store.add(sealUpdate(ctx(writer), doc, 4, utf8("w4")))).toBe("added");
    // What a member checked (compact) is dropped and counted as had.
    const [first] = store.envelopesOf(roomId, doc).updates;
    store.compact(roomId, doc, [first!], { [writer.id]: 1 });
    expect(store.envelopesOf(roomId, doc).updates.map((u) => u.clock)).toEqual([2, 3, 4]);
    expect(store.vv(roomId, doc)).toEqual({ [writer.id]: 4 });
    expect(store.add(first!)).toBe("duplicate");
  });

  it("keeps blobs per author, outside memory, and over quota drops the oldest of a relayed room", async () => {
    const { ctx, writer, admin, roomId } = setup();
    const store = new EnvelopeStore();
    const mine = sealBlob(ctx(writer), utf8("same bytes"));
    const theirs = sealBlob(ctx(admin), utf8("same bytes"));
    expect(store.add(mine)).toBe("added");
    expect(store.add(theirs)).toBe("added");
    expect(store.blobKeys(roomId)).toHaveLength(2);
    expect((await store.loadBlob(roomId, writer.id, mine.id))?.sig).toBe(mine.sig);
    store.dropBlobs(roomId, [`${writer.id}/${mine.id}`]);
    expect(store.add(mine)).toBe("duplicate");
    expect(store.gone(roomId).map(([key]) => key)).toEqual([`${writer.id}/${mine.id}`]);
  });

  it("gives equal digests for equal contents, whatever the order", () => {
    const { ctx, writer, admin, roomId } = setup();
    const doc = randomId("f");
    const envs = [sealUpdate(ctx(writer), doc, 1, utf8("a")), sealUpdate(ctx(admin), doc, 1, utf8("b")), sealBlob(ctx(writer), utf8("blob"))];
    const one = new EnvelopeStore();
    const two = new EnvelopeStore();
    envs.forEach((env) => one.add(env));
    [...envs].reverse().forEach((env) => two.add(env));
    expect(one.digest(roomId)).toBe(two.digest(roomId));
    two.add(sealUpdate(ctx(writer), doc, 5, utf8("gap")));
    expect(one.digest(roomId)).not.toBe(two.digest(roomId));
  });
});
