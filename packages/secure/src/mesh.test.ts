import { describe, expect, it, vi } from "vitest";
import { fromUtf8, utf8 } from "./bytes.js";
import { MAX_FORK_DEPTH, WorkspaceChain } from "./chain.js";
import { randomBytes } from "./crypto.js";
import { INDEX_DOC, openEnvelope, sealBlob, sealPresence, sealUpdate, type Envelope, type StoredEnvelope } from "./envelope.js";
import { randomId } from "./ids.js";
import { createJoinRecord, foldJoinInto, joinHash } from "./invite.js";
import { keyCommitment, newRoomKey, unwrapRoomKey, wrapRoomKey } from "./keys.js";
import { JoinHandshake, MeshNode, versionBatches, type Channel, type PeerMessage, type PeerSession } from "./mesh.js";
import { createRoom, fold, founder, invite, Network, step, type TestDevice } from "./testkit.js";
import { nextVersion, rebaseChange } from "./workspace.js";

function nodeFor(chain: WorkspaceChain, device: TestDevice, log: string[] = []): MeshNode {
  return new MeshNode(WorkspaceChain.load(chain.all()), device.id, { rejected: (reason) => log.push(reason) });
}

function texts(node: MeshNode, room: string, key: Uint8Array): string[] {
  const { updates } = node.store.envelopesOf(room, INDEX_DOC);
  return updates.map((env) => fromUtf8(openEnvelope(env, key))).sort();
}

function setup() {
  const { chain, ws, admin: ana } = founder();
  const { joiner: ben } = invite(chain, ana, { userName: "Ben" });
  const { joiner: cy } = invite(chain, ana, { userName: "Cy" });
  const { roomId, key } = createRoom(chain, ana, "Plans", { [cy.userId]: "write" });
  const seal = (device: TestDevice, clock: number, text: string): Envelope => sealUpdate({ ws, room: roomId, n: 1, key, author: device.sign }, INDEX_DOC, clock, utf8(text));
  return { chain, ws, ana, ben, cy, roomId, key, seal };
}

describe("mesh", () => {
  it("delivers live updates between two members", () => {
    const { chain, ana, cy, roomId, key, seal } = setup();
    const net = new Network();
    const a = nodeFor(chain, ana);
    const c = nodeFor(chain, cy);
    net.link(a, c);
    net.pump();
    expect(a.publish(seal(ana, 1, "hello"))).toBe(true);
    net.pump();
    expect(texts(c, roomId, key)).toEqual(["hello"]);
  });

  it("catches up after being apart, in both directions", () => {
    const { chain, ana, cy, roomId, key, seal } = setup();
    const net = new Network();
    const a = nodeFor(chain, ana);
    const c = nodeFor(chain, cy);
    for (let i = 1; i <= 3; i++) a.publish(seal(ana, i, `a${i}`));
    for (let i = 1; i <= 2; i++) c.publish(seal(cy, i, `c${i}`));
    net.link(a, c);
    net.pump();
    expect(texts(a, roomId, key)).toEqual(["a1", "a2", "a3", "c1", "c2"]);
    expect(texts(c, roomId, key)).toEqual(["a1", "a2", "a3", "c1", "c2"]);
    expect(a.store.digest(roomId)).toBe(c.store.digest(roomId));
  });

  it("relays through a peer that isn't in the room, which only ever holds ciphertext", () => {
    const { chain, ws, ana, ben, cy, roomId, key, seal } = setup();
    const net = new Network();
    const a = nodeFor(chain, ana);
    const b = nodeFor(chain, ben);
    const c = nodeFor(chain, cy);
    net.link(a, b);
    net.link(b, c);
    net.pump();
    a.publish(seal(ana, 1, "via Ben"));
    net.pump();
    expect(texts(c, roomId, key)).toEqual(["via Ben"]);
    expect(b.store.envelopesOf(roomId, INDEX_DOC).updates).toHaveLength(1);
    // Ben has no key wrap for this room, so there is nothing he could decrypt it with.
    const wrapForCy = wrapRoomKey(ws, roomId, 1, key, { id: cy.id, agree: cy.agree.publicKey }, ana.sign);
    expect(() => unwrapRoomKey(chain.state, ws, wrapForCy, ben.agree)).toThrow();
  });

  it("refuses writes from readers and from strangers' keys", () => {
    const { chain, ws, ana, ben, roomId, key } = setup();
    const log: string[] = [];
    const net = new Network();
    const a = nodeFor(chain, ana, log);
    const b = nodeFor(chain, ben);
    net.link(a, b);
    net.pump();
    // Ben isn't a member: his update is dropped at the first hop and never stored.
    const forged = sealUpdate({ ws, room: roomId, n: 1, key, author: ben.sign }, INDEX_DOC, 1, utf8("graffiti"));
    expect(b.publish(forged)).toBe(false);
    net.enqueue(() => (a as unknown as { sessionsFor?: unknown }) && undefined);
    net.pump();
    expect(a.store.envelopesOf(roomId, INDEX_DOC).updates).toHaveLength(0);
  });

  it("spreads workspace changes and lets the newest record decide", () => {
    const { chain, ana, cy } = setup();
    const net = new Network();
    const a = nodeFor(chain, ana);
    const c = nodeFor(chain, cy);
    net.link(a, c);
    net.pump();
    const version = nextVersion(a.workspaceId, a.chain.head, ana.sign, (state) => (state.name = "Renamed"));
    a.offerVersions([version]);
    net.pump();
    expect(c.chain.state.name).toBe("Renamed");
    expect(c.chain.headHash).toBe(a.chain.headHash);
  });

  it("converges when two admins changed the record while apart", () => {
    const { chain, ana, ben } = setup();
    step(chain, ana, (state) => (state.users[ben.userId]!.admin = true));
    const net = new Network();
    const a = nodeFor(chain, ana);
    const b = nodeFor(chain, ben);
    a.offerVersions([nextVersion(a.workspaceId, a.chain.head, ana.sign, (state) => (state.name = "Ana's"))]);
    b.offerVersions([nextVersion(b.workspaceId, b.chain.head, ben.sign, (state) => (state.name = "Ben's"))]);
    net.link(a, b);
    net.pump();
    expect(a.chain.headHash).toBe(b.chain.headHash);
    expect(a.chain.state.name).toBe("Ana's");
  });

  it("lets a new device join through any member, then get keys from a room member", () => {
    const { chain, ws, ana, ben, roomId, key, seal } = setup();
    // Ana invites Dee to the room; Dee joins through Ben while Ana is offline.
    const { joiner: dee, join } = invite(chain, ana, { userName: "Dee", rooms: { [roomId]: "read" }, fold: false });
    const net = new Network();
    const a = nodeFor(chain, ana);
    const b = nodeFor(chain, ben);
    a.publish(seal(ana, 1, "before Dee"));
    net.link(a, b);
    net.pump();
    let d: MeshNode | null = null;
    let sessionDB: PeerSession | null = null;
    let handshake: JoinHandshake | null = null;
    const route = { toDee: (message: unknown) => (sessionDB ? sessionDB.receive(message) : handshake!.receive(message)), toBen: (_: unknown) => {} };
    const deeChannel: Channel = { send: (m) => net.enqueue(() => route.toBen(JSON.parse(JSON.stringify(m)))), close: () => {} };
    const benChannel: Channel = { send: (m) => net.enqueue(() => route.toDee(JSON.parse(JSON.stringify(m)))), close: () => {} };
    const sessionBD = b.connect(benChannel, dee.id);
    route.toBen = (message) => sessionBD.receive(message);
    handshake = new JoinHandshake(
      deeChannel,
      ws,
      join,
      (joinedChain) => {
        d = new MeshNode(joinedChain, dee.id);
        d.addJoin(join);
        sessionDB = d.connect(deeChannel, ben.id);
      },
      (reason) => {
        throw new Error(reason);
      }
    );
    handshake.start();
    net.pump();
    expect(d).not.toBeNull();
    const deeNode = d as unknown as MeshNode;
    // Dee holds the room's ciphertext straight away...
    expect(deeNode.store.envelopesOf(roomId, INDEX_DOC).updates).toHaveLength(1);
    // ...and Ana learnt of the join through Ben.
    expect(a.effective().devices[dee.id]?.user).toBe(dee.userId);
    // Ana, a room member, wraps the key for Dee's device; it reaches Dee through Ben.
    a.addWrap(wrapRoomKey(ws, roomId, 1, key, { id: dee.id, agree: dee.agree.publicKey }, ana.sign));
    net.pump();
    const wrap = deeNode.allWraps().find((w) => w.body.to === dee.id)!;
    const deeKey = unwrapRoomKey(deeNode.effective(), ws, wrap, dee.agree);
    expect(texts(deeNode, roomId, deeKey)).toEqual(["before Dee"]);
  });

  it("drops a revoked device and refuses its later writes", () => {
    const { chain, ana, cy, roomId, seal } = setup();
    const net = new Network();
    const a = nodeFor(chain, ana);
    const c = nodeFor(chain, cy);
    net.link(a, c);
    net.pump();
    a.offerVersions([nextVersion(a.workspaceId, a.chain.head, ana.sign, (state) => (state.devices[cy.id]!.revoked = true))]);
    net.pump();
    expect(a.connectedDevices()).toEqual([]);
    expect(a.publish(seal(cy, 1, "after revocation"))).toBe(false);
    expect(a.store.envelopesOf(roomId, INDEX_DOC).updates).toHaveLength(0);
  });

  it("passes presence on without storing it, and without looping", () => {
    const { chain, ws, ana, ben, cy, roomId, key } = setup();
    const net = new Network();
    const seen: string[] = [];
    const a = nodeFor(chain, ana);
    const b = new MeshNode(WorkspaceChain.load(chain.all()), ben.id);
    const c = new MeshNode(WorkspaceChain.load(chain.all()), cy.id, { presence: (env) => seen.push(env.author) });
    net.link(a, b);
    net.link(b, c);
    net.link(a, c);
    net.pump();
    a.publish(sealPresence({ ws, room: roomId, n: 1, key, author: ana.sign }, Date.now(), utf8("cursor")));
    const delivered = net.pump();
    expect(seen).toEqual([ana.id]);
    expect(delivered).toBeLessThan(20);
    expect(c.store.rooms()).toEqual([]);
  });

  it("ends a session with a device that speaks for another workspace", () => {
    const one = setup();
    const other = founder();
    const net = new Network();
    const a = nodeFor(one.chain, one.ana);
    // Same device id (the transport proved the key), but its node belongs to a different workspace.
    const x = new MeshNode(other.chain, one.cy.id);
    net.link(a, x);
    net.pump();
    expect(a.connectedDevices()).toEqual([]);
    expect(x.connectedDevices()).toEqual([]);
  });

  it("keeps nothing a stranger sends before joining, and only one wrap per slot", () => {
    const { chain, ws, ana, cy, roomId, key } = setup();
    const a = nodeFor(chain, ana);
    const stranger = founder().admin;
    const session = a.connect({ send: () => {}, close: () => {} }, stranger.id);
    // A made-up join for an invite nobody issued: refused, and not kept for later.
    const fake = createJoinRecord({ workspaceId: ws, inviteId: randomId("i"), secret: randomBytes(32), user: { id: randomId("u"), name: "Eve" }, deviceName: "Eve", deviceKey: stranger.sign, agreementPublicKey: stranger.agree.publicKey, tlsFingerprint: stranger.tls });
    // Nor are other joins it passes on, and the session ends.
    const other = founder().admin;
    const passing = a.connect({ send: () => {}, close: () => {} }, other.id);
    passing.receive({ t: "joins", joins: [createJoinRecord({ workspaceId: ws, inviteId: randomId("i"), secret: randomBytes(32), user: { id: randomId("u"), name: "Mal" }, deviceName: "Mal", deviceKey: other.sign, agreementPublicKey: other.agree.publicKey, tlsFingerprint: other.tls })] });
    expect(passing.isClosed).toBe(true);
    expect(a.joinEntries()).toEqual([]);
    session.receive({ t: "join", join: fake });
    expect(session.isClosed).toBe(true);
    expect(a.joinEntries()).toEqual([]);
    expect(a.addWrap(wrapRoomKey(ws, roomId, 1, key, { id: cy.id, agree: cy.agree.publicKey }, ana.sign))).toBe(true);
    expect(a.addWrap(wrapRoomKey(ws, roomId, 1, key, { id: cy.id, agree: cy.agree.publicKey }, ana.sign))).toBe(false);
    expect(a.allWraps()).toHaveLength(1);
  });

  it("keeps one join per invite, the one every peer picks", () => {
    const { chain, ws, ana } = setup();
    const a = nodeFor(chain, ana);
    const withInvite = invite(chain, ana, { fold: false });
    a.offerVersions(chain.since(a.chain.length));
    const joins = [withInvite.join];
    for (let i = 0; i < 5; i++) {
      const device = founder().admin;
      joins.push(createJoinRecord({ workspaceId: ws, inviteId: withInvite.inviteId, secret: withInvite.secret, user: { id: randomId("u"), name: `Twin ${i}` }, deviceName: "Twin", deviceKey: device.sign, agreementPublicKey: device.agree.publicKey, tlsFingerprint: device.tls }));
    }
    for (const j of joins) a.addJoin(j);
    expect(a.pendingJoinRecords()).toHaveLength(1);
    const lowest = joins.map((j) => joinHash(j)).sort()[0];
    expect(joinHash(a.pendingJoinRecords()[0]!)).toBe(lowest);
  });

  it("a wrap that doesn't verify can't take the place of the genuine one", () => {
    const { chain, ws, ana, cy, roomId, key } = setup();
    const a = nodeFor(chain, ana);
    const genuine = wrapRoomKey(ws, roomId, 1, key, { id: cy.id, agree: cy.agree.publicKey }, ana.sign);
    // Someone sends a wrap in Ana's name (same room, epoch and recipient) with a signature that doesn't hold.
    const forged = structuredClone(genuine);
    forged.sig = genuine.sig.startsWith("A") ? `B${genuine.sig.slice(1)}` : `A${genuine.sig.slice(1)}`;
    expect(a.addWrap(forged)).toBe(false);
    expect(a.addWrap(genuine)).toBe(true);
    expect(a.allWraps()).toEqual([genuine]);
  });

  it("keeps the wraps of a room whose creation lost a race, so the room made again has its key", () => {
    const { chain, ws, ana, ben } = setup();
    step(chain, ana, (state) => (state.users[ben.userId]!.admin = true));
    const b = nodeFor(chain, ben);
    const parent = b.chain.head;
    // Ben creates a room and files his receipt for its key.
    const draft = WorkspaceChain.load(b.chain.all());
    const { roomId, key } = createRoom(draft, ben, "Design");
    const lost = draft.head;
    b.offerVersions([lost]);
    const receipt = wrapRoomKey(ws, roomId, 1, key, { id: ben.id, agree: ben.agree.publicKey }, ben.sign);
    expect(b.addWrap(receipt)).toBe(true);
    // At the same moment Ana, who ranks higher, changed something else: her version wins, and the room is gone...
    expect(b.offerVersions([nextVersion(ws, parent, ana.sign, (state) => (state.name = "Ana's"))]).status).toBe("replaced");
    expect(b.allWraps()).toEqual([]);
    expect(b.savedWraps()).toEqual([receipt]);
    // ...until Ben's device makes it again, with the same key: the receipt counts again, here and after a restart.
    b.offerVersions([nextVersion(ws, b.chain.head, ben.sign, (state) => void Object.assign(state, rebaseChange(parent.body.state, lost.body.state, state)))]);
    expect(b.allWraps()).toEqual([receipt]);
    const restarted = nodeFor(b.chain, ben);
    restarted.restore([], b.savedWraps());
    expect(restarted.allWraps()).toEqual([receipt]);
  });

  it("a join the losing branch took back out doesn't come back", () => {
    const { chain, ws, ana, ben, roomId } = setup();
    step(chain, ana, (state) => {
      state.users[ben.userId]!.admin = true;
      state.rooms[roomId]!.members[ben.userId] = "write";
    });
    const { joiner: mal, join } = invite(chain, ben, { userName: "Mal", fold: false });
    const a = nodeFor(chain, ana);
    const parent = a.chain.head;
    // Ben records Mal's join, then revokes Mal's device; Ana, at the same moment, lowers Ben in a room: hers wins.
    a.offerVersions([nextVersion(ws, parent, ben.sign, (state) => foldJoinInto(state, join), Date.now(), [join])]);
    a.offerVersions([nextVersion(ws, a.chain.head, ben.sign, (state) => (state.devices[mal.id]!.revoked = true))]);
    expect(a.offerVersions([nextVersion(ws, parent, ana.sign, (state) => (state.rooms[roomId]!.members[ben.userId] = "read"))]).status).toBe("replaced");
    expect(a.pendingJoinRecords()).toEqual([]);
    expect(a.effective().devices[mal.id]).toBeUndefined();
  });

  it("someone the losing branch took out of a room stays out, even if the room was deleted after", () => {
    const { chain, ws, ana, ben, cy, roomId } = setup();
    const { roomId: other } = createRoom(chain, ana, "Other", { [ben.userId]: "write" });
    step(chain, ana, (state) => {
      state.users[ben.userId]!.admin = true;
      state.rooms[roomId]!.members[ben.userId] = "manage";
      state.rooms[roomId]!.members[cy.userId] = "manage";
    });
    const { joiner: mal, join } = invite(chain, ben, { userName: "Mal", rooms: { [roomId]: "write" }, fold: false });
    const c = nodeFor(chain, cy);
    const parent = c.chain.head;
    // Ben records Mal's join and takes him out of the room, then Cy deletes the room; Ana's change at the same moment wins.
    c.offerVersions([nextVersion(ws, parent, ben.sign, (state) => foldJoinInto(state, join), Date.now(), [join])]);
    c.offerVersions([nextVersion(ws, c.chain.head, ben.sign, (state) => void delete state.rooms[roomId]!.members[mal.userId])]);
    c.offerVersions([nextVersion(ws, c.chain.head, cy.sign, (state) => void (state.rooms[roomId]!.deleted = true))]);
    expect(c.offerVersions([nextVersion(ws, parent, ana.sign, (state) => void delete state.rooms[other]!.members[ben.userId])]).status).toBe("replaced");
    expect(c.pendingJoinRecords()).toEqual([]);
    expect(c.effective().devices[mal.id]).toBeUndefined();
  });

  it("a join comes back when the losing branch only deleted a room it gave", () => {
    const { chain, ws, ana, ben, cy, roomId } = setup();
    const { roomId: other } = createRoom(chain, ana, "Other", { [ben.userId]: "write" });
    step(chain, ana, (state) => {
      state.users[ben.userId]!.admin = true;
      state.rooms[roomId]!.members[ben.userId] = "manage";
      state.rooms[roomId]!.members[cy.userId] = "manage";
    });
    const { join } = invite(chain, ben, { userName: "Mal", rooms: { [roomId]: "write" }, fold: false });
    const c = nodeFor(chain, cy);
    const parent = c.chain.head;
    c.offerVersions([nextVersion(ws, parent, ben.sign, (state) => foldJoinInto(state, join), Date.now(), [join])]);
    c.offerVersions([nextVersion(ws, c.chain.head, cy.sign, (state) => void (state.rooms[roomId]!.deleted = true))]);
    expect(c.offerVersions([nextVersion(ws, parent, ana.sign, (state) => void delete state.rooms[other]!.members[ben.userId])]).status).toBe("replaced");
    expect(c.pendingJoinRecords()).toEqual([join]);
  });

  it("another computer of an existing user comes back when the losing branch only changed that user's rooms", () => {
    const { chain, ws, ana, ben, cy, roomId } = setup();
    const { roomId: other } = createRoom(chain, ana, "Other", { [ben.userId]: "write" });
    step(chain, ana, (state) => {
      state.users[ben.userId]!.admin = true;
      state.rooms[roomId]!.members[ben.userId] = "manage";
    });
    const { join } = invite(chain, cy, { forUser: cy, fold: false });
    const a = nodeFor(chain, ana);
    const parent = a.chain.head;
    // Cy records her new computer, and Ben lowers Cy in the room he manages; Ana's change at the same moment wins.
    a.offerVersions([nextVersion(ws, parent, cy.sign, (state) => foldJoinInto(state, join), Date.now(), [join])]);
    a.offerVersions([nextVersion(ws, a.chain.head, ben.sign, (state) => void (state.rooms[roomId]!.members[cy.userId] = "read"))]);
    expect(a.offerVersions([nextVersion(ws, parent, ana.sign, (state) => void delete state.rooms[other]!.members[ben.userId])]).status).toBe("replaced");
    expect(a.pendingJoinRecords()).toEqual([join]);
  });

  it("a join comes back when its person only left a room themselves in the losing branch", () => {
    const { chain, ws, ana, ben, roomId } = setup();
    const { roomId: other } = createRoom(chain, ana, "Other", { [ben.userId]: "write" });
    step(chain, ana, (state) => {
      state.users[ben.userId]!.admin = true;
      state.rooms[roomId]!.members[ben.userId] = "manage";
    });
    const { joiner: mal, join } = invite(chain, ben, { userName: "Mal", rooms: { [roomId]: "write" }, fold: false });
    const a = nodeFor(chain, ana);
    const parent = a.chain.head;
    // Ben records Mal's join and Mal leaves the room he was given; Ana, at the same moment, takes Ben out of another room.
    a.offerVersions([nextVersion(ws, parent, ben.sign, (state) => foldJoinInto(state, join), Date.now(), [join])]);
    a.offerVersions([nextVersion(ws, a.chain.head, mal.sign, (state) => void delete state.rooms[roomId]!.members[mal.userId])]);
    expect(a.offerVersions([nextVersion(ws, parent, ana.sign, (state) => void delete state.rooms[other]!.members[ben.userId])]).status).toBe("replaced");
    expect(a.pendingJoinRecords()).toEqual([join]);
  });

  it("a join whose recording lost a race waits to be recorded again", () => {
    const { chain, ws, ana, ben, cy, roomId } = setup();
    step(chain, ana, (state) => (state.rooms[roomId]!.members[ben.userId] = "manage"));
    const { joiner: dan, join } = invite(chain, ana, { userName: "Dan", fold: false });
    const a = nodeFor(chain, ana);
    const parent = a.chain.head;
    a.offerVersions([nextVersion(ws, parent, ana.sign, (state) => foldJoinInto(state, join), Date.now(), [join])]);
    expect(a.chain.state.devices[dan.id]).toBeDefined();
    // At the same moment Ben lowers Cy in the room he manages: that takes standing away, so his branch wins.
    expect(a.offerVersions([nextVersion(ws, parent, ben.sign, (state) => (state.rooms[roomId]!.members[cy.userId] = "read"))]).status).toBe("replaced");
    expect(a.chain.state.devices[dan.id]).toBeUndefined();
    expect(a.pendingJoinRecords()).toEqual([join]);
    expect(a.effective().devices[dan.id]).toBeDefined();
  });

  it("keeps the wraps of a deleted room while a fork could still undo the deletion", () => {
    const { chain, ws, ana, cy, roomId, key } = setup();
    const toCy = wrapRoomKey(ws, roomId, 1, key, { id: cy.id, agree: cy.agree.publicKey }, ana.sign);
    step(chain, ana, (state) => (state.rooms[roomId]!.deleted = true));
    const a = nodeFor(chain, ana);
    a.restore([], [toCy]);
    expect(a.savedWraps()).toEqual([toCy]);
    for (let i = 0; i <= MAX_FORK_DEPTH; i++) a.offerVersions([nextVersion(ws, a.chain.head, ana.sign, (state) => (state.name = `Team ${i}`))]);
    expect(a.savedWraps()).toEqual([]);
  });

  it("after a restart, still knows who held a room's newest key, until that key is replaced", () => {
    const { chain, ws, ana, cy, roomId, key } = setup();
    const toCy = wrapRoomKey(ws, roomId, 1, key, { id: cy.id, agree: cy.agree.publicKey }, ana.sign);
    // Cy leaves the room; the key is to be replaced, and Ana's device restarts before it is.
    step(chain, cy, (state) => void delete state.rooms[roomId]!.members[cy.userId]);
    const a = nodeFor(chain, ana);
    a.restore([], [toCy]);
    expect(a.allWraps()).toEqual([]);
    expect(a.savedWraps()).toEqual([toCy]);
    a.offerVersions([nextVersion(ws, a.chain.head, ana.sign, (state) => void state.rooms[roomId]!.epochs.push({ n: 2, commit: keyCommitment(ws, roomId, 2, newRoomKey()) }))]);
    expect(a.savedWraps()).toEqual([]);
  });

  it("one peer's flood of wraps that never verify can't push out a wrap another peer sent", () => {
    const { chain, ws, ana, ben, cy, roomId } = setup();
    const a = nodeFor(chain, ana);
    // Cy's wrap of a key Ana's record doesn't know yet arrives, then a flood of junk from Ben's device.
    const k2 = newRoomKey();
    const early = wrapRoomKey(ws, roomId, 2, k2, { id: cy.id, agree: cy.agree.publicKey }, cy.sign);
    a.addWrap(early, { remoteDevice: cy.id } as PeerSession);
    for (let i = 0; i < 2100; i++) a.addWrap({ ...early, body: { ...early.body, by: randomId("d") } }, { remoteDevice: ben.id } as PeerSession);
    a.offerVersions([nextVersion(ws, a.chain.head, cy.sign, (state) => void state.rooms[roomId]!.epochs.push({ n: 2, commit: keyCommitment(ws, roomId, 2, k2) }))]);
    expect(a.allWraps()).toContainEqual(early);
  });

  it("waits for what is being stored even when a listener fails", async () => {
    const { chain, ana, seal } = setup();
    const a = new MeshNode(WorkspaceChain.load(chain.all()), ana.id, {
      stored: () => {
        throw new Error("listener");
      }
    });
    a.persist = () => Promise.resolve();
    a.publish(seal(ana, 1, "stored"));
    await expect(a.stored()).resolves.toBeUndefined();
  });

  it("stops storing, and trying again, once stopped", async () => {
    vi.useFakeTimers();
    try {
      const { chain, ana, seal } = setup();
      const a = nodeFor(chain, ana);
      let tries = 0;
      a.persist = () => (tries++, Promise.reject(new Error("disk full")));
      a.publish(seal(ana, 1, "never stored"));
      await vi.advanceTimersByTimeAsync(0);
      a.stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(tries).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps (receipts included) of a key that lost a rotation race stop counting, so the right one can take their place", () => {
    const { chain, ws, ana, cy, roomId } = setup();
    const net = new Network();
    const a = nodeFor(chain, ana);
    const c = nodeFor(chain, cy);
    const link = net.link(a, c);
    net.pump();
    link.cut();
    // Apart, both rotate the room's key; Cy files a receipt for hers.
    const kc = newRoomKey();
    const ka = newRoomKey();
    c.offerVersions([nextVersion(ws, c.chain.head, cy.sign, (state) => void state.rooms[roomId]!.epochs.push({ n: 2, commit: keyCommitment(ws, roomId, 2, kc) }))]);
    expect(c.addWrap(wrapRoomKey(ws, roomId, 2, kc, { id: cy.id, agree: cy.agree.publicKey }, cy.sign))).toBe(true);
    a.offerVersions([nextVersion(ws, a.chain.head, ana.sign, (state) => void state.rooms[roomId]!.epochs.push({ n: 2, commit: keyCommitment(ws, roomId, 2, ka) }))]);
    // They meet; Ana's rotation wins. Cy's receipt for the losing key no longer counts, and Ana's wrap gets through.
    net.link(a, c);
    net.pump();
    expect(c.chain.headHash).toBe(a.chain.headHash);
    expect(c.allWraps().filter((w) => w.body.n === 2)).toEqual([]);
    const right = wrapRoomKey(ws, roomId, 2, ka, { id: cy.id, agree: cy.agree.publicKey }, ana.sign);
    expect(a.addWrap(right)).toBe(true);
    net.pump();
    expect(c.allWraps().map((w) => w.body.commit)).toContain(keyCommitment(ws, roomId, 2, ka));
    // A wrap naming another commitment than the record's is refused outright.
    const stale = wrapRoomKey(ws, roomId, 2, kc, { id: cy.id, agree: cy.agree.publicKey }, cy.sign);
    expect(c.addWrap(stale)).toBe(false);
  });

  it("stores before sending, and keeps trying when storing fails", async () => {
    vi.useFakeTimers();
    try {
      const { chain, ana, cy, roomId, key, seal } = setup();
      const net = new Network();
      const a = nodeFor(chain, ana);
      const c = nodeFor(chain, cy);
      let failures = 1;
      a.persist = () => (failures-- > 0 ? Promise.reject(new Error("disk full")) : Promise.resolve());
      net.link(a, c);
      net.pump();
      const env = seal(ana, 1, "kept back");
      a.publish(env);
      await vi.advanceTimersByTimeAsync(0);
      net.pump();
      expect(texts(c, roomId, key)).toEqual([]);
      expect(a.isUnpersisted(env as StoredEnvelope)).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      net.pump();
      expect(texts(c, roomId, key)).toEqual(["kept back"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes on at once what it received, and keeps storing it until it is stored", async () => {
    vi.useFakeTimers();
    try {
      const { chain, ana, ben, cy, roomId, key, seal } = setup();
      const net = new Network();
      const a = nodeFor(chain, ana);
      const b = nodeFor(chain, ben);
      const c = nodeFor(chain, cy);
      let failures = 1;
      b.persist = () => (failures-- > 0 ? Promise.reject(new Error("disk full")) : Promise.resolve());
      net.link(a, b);
      net.link(b, c);
      net.pump();
      a.publish(seal(ana, 1, "via Ben"));
      net.pump();
      await vi.advanceTimersByTimeAsync(0);
      // Ben's disk couldn't store it: passed on all the same, and known not to be stored here yet.
      expect(texts(c, roomId, key)).toEqual(["via Ben"]);
      expect(b.hasUnstoredReceived(`${roomId}/${INDEX_DOC}/`)).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(b.hasUnstoredReceived(`${roomId}/${INDEX_DOC}/`)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the record as the previous release does, 500 versions a message, cutting only what wouldn't fit a frame", () => {
    const { chain, ana, cy } = setup();
    const base = chain.length;
    for (let i = 0; i < 20; i++) createRoom(chain, ana, `Room ${i}`);
    const added = chain.all().slice(base);
    /** Cy's computer with the record up to `base` (and, with `own`, a version of its own), meeting Ana's: what it is sent. */
    const meet = (own: boolean) => {
      const prefix = WorkspaceChain.load(chain.all().slice(0, base));
      if (own) step(prefix, cy, (state) => void (state.users[cy.userId]!.name = "Cy too"));
      const c = new MeshNode(prefix, cy.id);
      const offered: number[] = [];
      const offer = c.offerVersions.bind(c);
      c.offerVersions = (versions, from, appendOnly) => (from && offered.push(versions.length), offer(versions, from, appendOnly));
      const net = new Network();
      net.link(nodeFor(chain, ana), c);
      net.pump();
      return offered;
    };
    // Behind, or with a branch of its own: all of it in one message, judged whole.
    expect(meet(false)).toEqual([added.length]);
    expect(meet(true)).toEqual([added.length]);
    // Cut by size: every version, in order, each run within the size (or a single version).
    const size = (version: (typeof added)[number]) => Buffer.byteLength(JSON.stringify(version));
    const limit = Math.max(...added.map(size)) * 3;
    const runs = versionBatches(added, limit);
    expect(runs.flat()).toEqual(added);
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) expect(run.length === 1 || run.reduce((bytes, version) => bytes + size(version), 0) <= limit).toBe(true);
    expect(versionBatches(added, Infinity)).toEqual([added]);
  });

  it("lets a join take effect only within the record's limits, counting the joins before it", () => {
    const { chain, ana } = setup();
    // Computers of Ana's up to one below the limit, then two more joining at once.
    while (Object.values(chain.state.devices).filter((device) => device.user === ana.userId).length < 29) invite(chain, ana, { forUser: ana });
    const joins = [invite(chain, ana, { forUser: ana, fold: false }).join, invite(chain, ana, { forUser: ana, fold: false }).join];
    const a = nodeFor(chain, ana);
    for (const join of joins) a.addJoin(join);
    expect(a.joinsInEffect()).toHaveLength(1);
    expect(Object.values(a.effective().devices).filter((device) => device.user === ana.userId)).toHaveLength(30);
    // Once the one in effect is recorded, the other can't take effect at all.
    const recorded = a.joinsInEffect()[0]!;
    fold(chain, ana, recorded);
    const b = nodeFor(chain, ana);
    b.addJoin(joins.find((join) => join !== recorded)!);
    expect(b.joinsInEffect()).toEqual([]);
    expect(Object.values(b.effective().devices).filter((device) => device.user === ana.userId)).toHaveLength(30);
  });

  it("doesn't hold an attachment it received in memory to store it again", async () => {
    vi.useFakeTimers();
    try {
      const { chain, ws, ana, cy, roomId, key } = setup();
      const net = new Network();
      const a = nodeFor(chain, ana);
      const c = nodeFor(chain, cy);
      let tries = 0;
      c.persist = () => (tries++, Promise.reject(new Error("disk full")));
      net.link(a, c);
      net.pump();
      a.publish(sealBlob({ ws, room: roomId, n: 1, key, author: ana.sign }, utf8("a large scan")));
      net.pump();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(c.store.blobKeys(roomId)).toHaveLength(1);
      expect(tries).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes on more small file versions than fit in one message", async () => {
    const { chain, ws, ana, cy, roomId, key } = setup();
    const net = new Network();
    const a = nodeFor(chain, ana);
    for (let i = 0; i < 501; i++) a.publish(sealBlob({ ws, room: roomId, n: 1, key, author: ana.sign }, utf8(`file ${i}`)));
    const c = nodeFor(chain, cy);
    net.link(a, c);
    await net.settle();
    expect(c.store.blobKeys(roomId)).toHaveLength(501);
  });

  it("refuses presence that isn't fresh", () => {
    const { chain, ws, ana, roomId, key } = setup();
    const a = nodeFor(chain, ana);
    expect(a.publish(sealPresence({ ws, room: roomId, n: 1, key, author: ana.sign }, Date.now() - 5 * 60_000, utf8("old")))).toBe(false);
    expect(a.publish(sealPresence({ ws, room: roomId, n: 1, key, author: ana.sign }, Date.now(), utf8("now")))).toBe(true);
  });

  it("sends what it made only once it is stored", async () => {
    const { chain, ana, cy, roomId, key, seal } = setup();
    const net = new Network();
    const a = nodeFor(chain, ana);
    const c = nodeFor(chain, cy);
    let release: () => void = () => {};
    a.persist = () => new Promise<void>((resolve) => (release = resolve));
    net.link(a, c);
    net.pump();
    a.publish(seal(ana, 1, "pending"));
    net.pump();
    expect(texts(c, roomId, key)).toEqual([]);
    release();
    await net.settle();
    expect(texts(c, roomId, key)).toEqual(["pending"]);
  });

  it("a joining device refuses a record that doesn't know its invite", () => {
    const { chain, ws, ana } = setup();
    const { join } = invite(WorkspaceChain.load(chain.all()), ana, { fold: false });
    const outcome: string[] = [];
    const handshake = new JoinHandshake({ send: () => {}, close: () => {} }, ws, join, () => outcome.push("accepted"), (reason) => outcome.push(reason));
    handshake.receive({ t: "hello", ws, head: chain.head.body.v, recent: [] });
    handshake.receive({ t: "versions", versions: JSON.parse(JSON.stringify(chain.all())) });
    expect(outcome).toEqual([expect.stringMatching(/join_no_invite/)]);
  });

  it("counts its record as compared once a device the record lists answers, or when it lists no other, and asks again after a time away", () => {
    const { chain, ana, ben, cy } = setup();
    // A device joining through this one (its join not recorded yet) only has the record it got here: it doesn't count.
    const pending = invite(chain, ana, { fold: false });
    const a = nodeFor(chain, ana);
    expect(a.addJoin(pending.join)).toBe(true);
    expect(a.recordCompared).toBe(false);
    const joiner = a.connect({ send: () => {}, close: () => {} }, pending.joiner.id);
    joiner.receive({ t: "digests", rooms: {} });
    expect(a.recordCompared).toBe(false);
    // A member's answer to our hello counts.
    const sent: PeerMessage[] = [];
    const session = a.connect({ send: (m) => sent.push(m), close: () => {} }, cy.id);
    session.receive({ t: "digests", rooms: {} });
    expect(a.recordCompared).toBe(true);
    // After a time away it doesn't, until the member answers the hello it is sent again.
    sent.length = 0;
    a.recompare();
    expect(a.recordCompared).toBe(false);
    expect(sent.map((m) => m.t)).toEqual(["hello"]);
    session.receive({ t: "digests", rooms: {} });
    expect(a.recordCompared).toBe(true);
    // A device whose record lists no other active device has nothing to wait for (another device's revoked, say).
    const b = nodeFor(chain, ana);
    expect(b.recordCompared).toBe(false);
    for (const device of [ben, cy]) step(b.chain, ana, (state) => void (state.devices[device.id]!.revoked = true));
    expect(b.recordCompared).toBe(true);
    // Nor has one that was alone when it started, with only those that joined through it since; until it was away.
    const alone = founder();
    const c = nodeFor(alone.chain, alone.admin);
    expect(c.recordCompared).toBe(true);
    invite(c.chain, alone.admin, { userName: "Newcomer" });
    expect(c.recordCompared).toBe(true);
    c.recompare();
    expect(c.recordCompared).toBe(false);
  });

  it("takes from a device that isn't a member here only versions that extend its record, and lets it go on anything else", () => {
    const { chain, ana, ben } = setup();
    // A branch made elsewhere, next to ours, that would win against it (it revokes a device).
    const theirs = WorkspaceChain.load(chain.all());
    step(theirs, ana, (state) => void (state.devices[ben.id]!.revoked = true));
    step(chain, ana, (state) => void (state.name = "Ours"));
    const check = WorkspaceChain.load(chain.all());
    expect(check.offer(theirs.since(theirs.head.body.v)).status).toBe("replaced");
    const a = nodeFor(chain, ana);
    const sent: PeerMessage[] = [];
    const session = a.connect({ send: (m) => sent.push(m), close: () => {} }, founder().admin.id);
    // It holds our record up to where the branches part: it hears our hello, then sends its branch.
    const base = theirs.head.body.v - 1;
    session.receive({ t: "hello", ws: a.workspaceId, head: base, recent: [[base, theirs.hashAt(base)!]] });
    expect(sent.map((m) => m.t)).toEqual(["hello"]);
    session.receive({ t: "versions", versions: theirs.since(base + 1) });
    expect(session.isClosed).toBe(true);
    expect(a.chain.state.name).toBe("Ours");
    // Versions without a hello first, or with the first version of all among them, end the session too.
    const unasked = a.connect({ send: () => {}, close: () => {} }, founder().admin.id);
    unasked.receive({ t: "versions", versions: chain.since(chain.head.body.v) });
    expect(unasked.isClosed).toBe(true);
    const first = a.connect({ send: () => {}, close: () => {} }, founder().admin.id);
    first.receive({ t: "hello", ws: a.workspaceId, head: base, recent: [[base, theirs.hashAt(base)!]] });
    first.receive({ t: "versions", versions: chain.all().slice(0, 2) });
    expect(first.isClosed).toBe(true);
    // An answer that is over (its digests) without making it a member ends it as well.
    const over = a.connect({ send: () => {}, close: () => {} }, founder().admin.id);
    over.receive({ t: "hello", ws: a.workspaceId, head: base, recent: [[base, theirs.hashAt(base)!]] });
    over.receive({ t: "digests", rooms: {} });
    expect(over.isClosed).toBe(true);
  });

  it("says nothing to a device that isn't a member until it presents a join, even if it knows the workspace", () => {
    const { chain, ana } = setup();
    const stranger = founder().admin;
    const sent: PeerMessage[] = [];
    const a = nodeFor(chain, ana);
    const session = a.connect({ send: (m) => sent.push(m), close: () => {} }, stranger.id);
    expect(sent).toEqual([]);
    session.receive({ t: "hello", ws: a.workspaceId, head: 0, recent: [] });
    expect(session.isClosed).toBe(true);
    // Knowing the workspace id (the first version's hash) proves nothing either.
    const again = a.connect({ send: (m) => sent.push(m), close: () => {} }, stranger.id);
    again.receive({ t: "hello", ws: a.workspaceId, head: 0, recent: [[0, chain.hashAt(0)!]] });
    expect(again.isClosed).toBe(true);
    expect(sent).toEqual([]);
  });
});
