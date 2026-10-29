import { afterEach, describe, expect, it } from "vitest";
import * as tls from "node:tls";
import { b64u, concatBytes, fromUtf8, utf8 } from "./bytes.js";
import { WorkspaceChain } from "./chain.js";
import { newSigningKeyPair, sign } from "./crypto.js";
import { makeAnnouncement, readAnnouncement } from "./discovery.js";
import { INDEX_DOC, openEnvelope, sealUpdate } from "./envelope.js";
import { encodeFrame, FrameReader } from "./frames.js";
import { randomId } from "./ids.js";
import { formatInviteLink, newInvite, parseInviteLink } from "./invite.js";
import { MeshNode } from "./mesh.js";
import { joinWorkspace, PeerManager } from "./peers.js";
import { createRoom, founder, invite, step } from "./testkit.js";
import { createTlsIdentity, type TlsIdentity } from "./tlsIdentity.js";
import { dial, PeerServer, workspaceTag, type PeerLink, type TransportConfig } from "./transport.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function world() {
  const tlsA = await createTlsIdentity();
  const tlsC = await createTlsIdentity();
  const { chain, ws, admin: ana } = founder("Team", "Ana", tlsA.fingerprint);
  const { joiner: cy } = invite(chain, ana, { userName: "Cy", tls: tlsC.fingerprint });
  const { roomId, key } = createRoom(chain, ana, "Plans", { [cy.userId]: "write" });
  return { chain, ws, ana, cy, tlsA, tlsC, roomId, key };
}

/** A peer: node, server, manager, all on localhost. */
async function peer(chain: WorkspaceChain, device: { id: string; sign: ReturnType<typeof newSigningKeyPair> }, tlsId: TlsIdentity, staticPeers: Array<{ host: string; port: number }> = []) {
  const node = new MeshNode(WorkspaceChain.load(chain.all()), device.id);
  const config: TransportConfig = { workspaceId: chain.workspaceId, deviceId: device.id, deviceKey: device.sign, tls: tlsId, membership: () => node.effective() };
  const manager = new PeerManager(node, config, () => staticPeers);
  const server = new PeerServer(config, (link) => manager.accept(link));
  const port = await server.listen(0, "127.0.0.1");
  manager.ownAddresses = () => [`127.0.0.1:${port}`];
  cleanups.push(() => server.close(), () => manager.stop());
  return { node, config, manager, server, port };
}

describe("frames", () => {
  it("reassemble messages split anywhere and refuse oversized ones", () => {
    const bytes = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: "two" })]);
    const reader = new FrameReader();
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i += 3) out.push(...reader.push(bytes.subarray(i, i + 3)));
    expect(out).toEqual([{ a: 1 }, { b: "two" }]);
    const small = new FrameReader(10);
    expect(() => small.push(encodeFrame({ long: "x".repeat(50) }))).toThrow(/frame_too_large/);
  });

  it("read a frame that trickles in a byte at a time, and refuse empty ones", () => {
    const bytes = encodeFrame({ text: "x".repeat(5000) });
    const reader = new FrameReader();
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i++) out.push(...reader.push(bytes.subarray(i, i + 1)));
    expect(out).toEqual([{ text: "x".repeat(5000) }]);
    expect(() => new FrameReader().push(Buffer.from([0, 0, 0, 0]))).toThrow(/bad_frame/);
  });
});

describe("TLS transport", () => {
  it("connects two members, pinned and mutually authenticated, and syncs over it", async () => {
    const w = await world();
    const a = await peer(w.chain, w.ana, w.tlsA);
    const c = await peer(w.chain, w.cy, w.tlsC, [{ host: "127.0.0.1", port: a.port }]);
    c.manager.start();
    await until(() => a.manager.connected().includes(w.cy.id) && c.manager.connected().includes(w.ana.id));
    a.node.publish(sealUpdate({ ws: w.ws, room: w.roomId, n: 1, key: w.key, author: w.ana.sign }, INDEX_DOC, 1, utf8("over TLS")));
    await until(() => c.node.store.envelopesOf(w.roomId, INDEX_DOC).updates.length === 1);
    expect(fromUtf8(openEnvelope(c.node.store.envelopesOf(w.roomId, INDEX_DOC).updates[0]!, w.key))).toBe("over TLS");
  });

  it("lets in a member that joined while this device was away, once its record shows it, and they sync", async () => {
    const w = await world();
    // Ana's device goes away; meanwhile Ben joins (through someone else). Ana's device comes back with the old record.
    const a = await peer(w.chain, w.ana, w.tlsA);
    a.node.publish(sealUpdate({ ws: w.ws, room: w.roomId, n: 1, key: w.key, author: w.ana.sign }, INDEX_DOC, 1, utf8("from Ana, while away")));
    const tlsB = await createTlsIdentity();
    const { joiner: ben } = invite(w.chain, w.ana, { userName: "Ben", tls: tlsB.fingerprint, rooms: { [w.roomId]: "write" } });
    // And a lot more happens meanwhile: what Ana's device lacks is far more than a frame before membership may hold.
    for (let i = 0; i < 60; i++) createRoom(w.chain, w.ana, `Room ${i}`);
    expect(a.node.effective().devices[ben.id]).toBeUndefined();
    const b = await peer(w.chain, ben, tlsB, [{ host: "127.0.0.1", port: a.port }]);
    b.manager.start();
    await until(() => a.node.connectedDevices().includes(ben.id) && b.node.connectedDevices().includes(w.ana.id));
    expect(a.node.effective().devices[ben.id]).toBeDefined();
    b.node.publish(sealUpdate({ ws: w.ws, room: w.roomId, n: 1, key: w.key, author: ben.sign }, INDEX_DOC, 1, utf8("from Ben")));
    // Each gets what the other wrote: Ben's device what Ana's wrote while away too.
    await until(() => a.node.store.envelopesOf(w.roomId, INDEX_DOC).updates.length === 2 && b.node.store.envelopesOf(w.roomId, INDEX_DOC).updates.length === 2);
  });

  it("turns away a computer that was revoked, at once, and never dials a port that can't be", async () => {
    const w = await world();
    const before = WorkspaceChain.load(w.chain.all());
    step(w.chain, w.ana, (state) => void (state.devices[w.cy.id]!.revoked = true));
    const a = await peer(w.chain, w.ana, w.tlsA);
    const reasons: string[] = [];
    const server = new PeerServer(a.config, () => reasons.push("accepted!"), (reason) => reasons.push(reason));
    const port = await server.listen(0, "127.0.0.1");
    cleanups.push(() => server.close());
    // Cy's computer doesn't know it was revoked yet.
    const cy: TransportConfig = { workspaceId: w.ws, deviceId: w.cy.id, deviceKey: w.cy.sign, tls: w.tlsC, membership: () => before.state };
    await expect(dial(cy, "127.0.0.1", port, { device: w.ana.id, fingerprint: w.tlsA.fingerprint })).rejects.toThrow();
    await until(() => reasons.length > 0);
    expect(reasons).toEqual(["revoked"]);
    await expect(dial(a.config, "127.0.0.1", 99999)).rejects.toThrow("bad_port");
    // An address with such a port, told of a member, isn't taken.
    const other = await world();
    const o = await peer(other.chain, other.ana, other.tlsA);
    o.manager.heard([[other.cy.id, "127.0.0.1:99999"]]);
    expect(o.manager.addressBook().some(([device]) => device === other.cy.id)).toBe(false);
  });

  it("keeps the others connected when the device that brought them together goes away", async () => {
    const w = await world();
    const tlsB = await createTlsIdentity();
    const { joiner: ben } = invite(w.chain, w.ana, { userName: "Ben", tls: tlsB.fingerprint, rooms: { [w.roomId]: "write" } });
    // No discovery: Cy's and Ben's devices know only the address of Ana's, which tells each where the other is.
    const a = await peer(w.chain, w.ana, w.tlsA);
    const c = await peer(w.chain, w.cy, w.tlsC, [{ host: "127.0.0.1", port: a.port }]);
    const b = await peer(w.chain, ben, tlsB, [{ host: "127.0.0.1", port: a.port }]);
    for (const p of [a, c, b]) p.manager.start();
    await until(() => b.node.connectedDevices().includes(w.cy.id) && c.node.connectedDevices().includes(ben.id), 20_000);
    expect(b.manager.addressBook()).toContainEqual([w.cy.id, `127.0.0.1:${c.port}`]);
    // Ana's device goes away: the others go on syncing with each other.
    a.manager.stop();
    await a.server.close();
    b.node.publish(sealUpdate({ ws: w.ws, room: w.roomId, n: 1, key: w.key, author: ben.sign }, INDEX_DOC, 1, utf8("without Ana")));
    await until(() => c.node.store.envelopesOf(w.roomId, INDEX_DOC).updates.length === 1);
  }, 30_000);

  it("refuses a server whose certificate isn't the pinned one", async () => {
    const w = await world();
    const a = await peer(w.chain, w.ana, w.tlsA);
    const config: TransportConfig = { workspaceId: w.ws, deviceId: w.cy.id, deviceKey: w.cy.sign, tls: w.tlsC, membership: () => w.chain.state };
    await expect(dial(config, "127.0.0.1", a.port, { device: w.ana.id, fingerprint: w.tlsC.fingerprint })).rejects.toThrow("certificate_mismatch");
  });

  it("hands on what comes in the same chunk as the answer to its authentication", async () => {
    const w = await world();
    // Ana's side answers and says hello in one write, as a busy computer may.
    const sockets: tls.TLSSocket[] = [];
    const server = tls.createServer({ key: w.tlsA.keyPem, cert: w.tlsA.certPem, minVersion: "TLSv1.3" }, (socket) => {
      sockets.push(socket);
      socket.once("data", () => {
        const ekm = new Uint8Array(socket.exportKeyingMaterial(32, "EXPORTER-vault-rooms-peer-auth", Buffer.alloc(0)));
        const sig = sign(w.ana.sign.secretKey, "peer-auth-ok", concatBytes(ekm, utf8(`ok|${w.cy.id}|${w.ana.id}|${workspaceTag(w.ws)}`)));
        socket.write(Buffer.concat([encodeFrame({ t: "auth_ok", device: w.ana.id, sig }), encodeFrame({ t: "hello", ws: w.ws })]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    });
    const config: TransportConfig = { workspaceId: w.ws, deviceId: w.cy.id, deviceKey: w.cy.sign, tls: w.tlsC, membership: () => w.chain.state };
    const link = await dial(config, "127.0.0.1", (server.address() as { port: number }).port, { device: w.ana.id, fingerprint: w.tlsA.fingerprint });
    const heard: unknown[] = [];
    link.onMessage((message) => heard.push(message));
    await until(() => heard.length > 0, 2000);
    expect(heard).toEqual([{ t: "hello", ws: w.ws }]);
    link.channel.close("done");
  });

  it("refuses a caller that claims a member's id without its key", async () => {
    const w = await world();
    const rejected: string[] = [];
    const node = new MeshNode(WorkspaceChain.load(w.chain.all()), w.ana.id);
    const config: TransportConfig = { workspaceId: w.ws, deviceId: w.ana.id, deviceKey: w.ana.sign, tls: w.tlsA, membership: () => node.effective() };
    const server = new PeerServer(config, () => rejected.push("accepted!"), (reason) => rejected.push(reason));
    const port = await server.listen(0, "127.0.0.1");
    cleanups.push(() => server.close());
    const impostor: TransportConfig = { workspaceId: w.ws, deviceId: w.cy.id, deviceKey: newSigningKeyPair(), tls: await createTlsIdentity(), membership: () => w.chain.state };
    await expect(dial(impostor, "127.0.0.1", port, { device: w.ana.id, fingerprint: w.tlsA.fingerprint })).rejects.toThrow();
    await until(() => rejected.length > 0);
    expect(rejected).toEqual(["auth_signature"]);
  });

  it("refuses anything but a well-formed auth frame, and drops oversized frames before auth", async () => {
    const w = await world();
    const reasons: string[] = [];
    const config: TransportConfig = { workspaceId: w.ws, deviceId: w.ana.id, deviceKey: w.ana.sign, tls: w.tlsA, membership: () => w.chain.state };
    const server = new PeerServer(config, () => reasons.push("accepted!"), (reason) => reasons.push(reason));
    const port = await server.listen(0, "127.0.0.1");
    cleanups.push(() => server.close());
    const raw = (payload: Buffer) =>
      new Promise<void>((resolve) => {
        const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, minVersion: "TLSv1.3" }, () => socket.write(payload));
        socket.on("close", () => resolve());
        socket.on("error", () => resolve());
      });
    await raw(encodeFrame({ t: "hello", ws: w.ws }));
    await raw(Buffer.concat([Buffer.from([0, 2, 0, 0]), Buffer.alloc(16)]));
    await until(() => reasons.length >= 2);
    expect(reasons).toEqual(expect.arrayContaining(["auth_malformed", "bad_frame"]));
    expect(reasons).not.toContain("accepted!");
  });

  it("lets a new device join over TLS with an invite link, then sync", async () => {
    const w = await world();
    const tlsD = await createTlsIdentity();
    const fresh = newInvite({ user: w.ana.userId, device: w.ana.id }, { [w.roomId]: "read" }, Date.now() + 3_600_000);
    step(w.chain, w.ana, (state) => (state.invites[fresh.inviteId] = fresh.record));
    const a = await peer(w.chain, w.ana, w.tlsA);
    a.node.publish(sealUpdate({ ws: w.ws, room: w.roomId, n: 1, key: w.key, author: w.ana.sign }, INDEX_DOC, 1, utf8("for Dee")));
    const link = parseInviteLink(formatInviteLink({ workspaceId: w.ws, inviteId: fresh.inviteId, secret: fresh.secret, peers: [`127.0.0.1:${a.port}`] }));
    const deeKey = newSigningKeyPair();
    const { chain, join, link: firstLink } = await joinWorkspace({ invite: link, userName: "Dee", deviceName: "Dee PC", deviceKey: deeKey, agreementKey: { publicKey: w.cy.agree.publicKey, secretKey: w.cy.agree.secretKey }, tls: tlsD, newUserId: randomId("u") });
    expect(chain.workspaceId).toBe(w.ws);
    const d = new MeshNode(chain, join.body.device.id);
    d.addJoin(join);
    const config: TransportConfig = { workspaceId: w.ws, deviceId: join.body.device.id, deviceKey: deeKey, tls: tlsD, membership: () => d.effective() };
    const manager = new PeerManager(d, config);
    cleanups.push(() => manager.stop());
    manager.adopt(firstLink as PeerLink);
    await until(() => d.store.envelopesOf(w.roomId, INDEX_DOC).updates.length === 1);
    expect(a.node.effective().devices[join.body.device.id]).toBeDefined();
  });

  it("closes the connection of a join attempt that fails, and joins through the next peer", async () => {
    const w = await world();
    const fresh = newInvite({ user: w.ana.userId, device: w.ana.id }, {}, Date.now() + 3_600_000);
    step(w.chain, w.ana, (state) => (state.invites[fresh.inviteId] = fresh.record));
    const a = await peer(w.chain, w.ana, w.tlsA);
    // A peer that authenticates, then answers the join for another workspace.
    let closed = false;
    const sockets: tls.TLSSocket[] = [];
    const wrong = tls.createServer({ key: w.tlsC.keyPem, cert: w.tlsC.certPem, minVersion: "TLSv1.3" }, (socket) => {
      sockets.push(socket);
      let seen = 0;
      socket.on("data", () => {
        if (++seen === 1) socket.write(encodeFrame({ t: "auth_ok", device: w.cy.id, sig: b64u(new Uint8Array(64)) }));
        else socket.write(encodeFrame({ t: "hello", ws: `w${"x".repeat(43)}`, head: 0 }));
      });
      socket.on("close", () => (closed = true));
    });
    await new Promise<void>((resolve) => wrong.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => wrong.close(resolve));
    });
    const peers = [`127.0.0.1:${(wrong.address() as { port: number }).port}`, `127.0.0.1:${a.port}`];
    const link = parseInviteLink(formatInviteLink({ workspaceId: w.ws, inviteId: fresh.inviteId, secret: fresh.secret, peers }));
    const joined = await joinWorkspace({ invite: link, userName: "Dee", deviceName: "Dee PC", deviceKey: newSigningKeyPair(), agreementKey: w.cy.agree, tls: await createTlsIdentity(), newUserId: randomId("u") });
    cleanups.push(() => joined.link.channel.close("done"));
    expect(joined.chain.workspaceId).toBe(w.ws);
    await until(() => closed, 2000);
  });

  it("won't join through a peer that isn't part of the workspace the link names", async () => {
    const w = await world();
    const other = await world();
    const b = await peer(other.chain, other.ana, other.tlsA);
    const fresh = newInvite({ user: w.ana.userId, device: w.ana.id }, {}, Date.now() + 3_600_000);
    const link = { workspaceId: w.ws, inviteId: fresh.inviteId, secret: fresh.secret, peers: [`127.0.0.1:${b.port}`] };
    await expect(joinWorkspace({ invite: link, userName: "Eve", deviceName: "Eve", deviceKey: newSigningKeyPair(), agreementKey: w.cy.agree, tls: await createTlsIdentity(), newUserId: randomId("u") })).rejects.toThrow(/could not join/);
  });
});

describe("discovery announcements", () => {
  it("accept fresh announcements signed by members, nothing else", async () => {
    const w = await world();
    const now = Date.now();
    const good = Buffer.from(JSON.stringify(makeAnnouncement(w.ws, w.cy.id, w.cy.sign, 4567, now)));
    expect(readAnnouncement(good, w.ws, w.chain.state, now)).toEqual({ device: w.cy.id, port: 4567 });
    expect(readAnnouncement(good, w.ws, w.chain.state, now + 121_000)).toBeNull();
    expect(readAnnouncement(good, founder().ws, w.chain.state, now)).toBeNull();
    const forged = Buffer.from(JSON.stringify(makeAnnouncement(w.ws, w.cy.id, newSigningKeyPair(), 4567, now)));
    expect(readAnnouncement(forged, w.ws, w.chain.state, now)).toBeNull();
    const tampered = JSON.parse(good.toString());
    tampered.p = 9999;
    expect(readAnnouncement(Buffer.from(JSON.stringify(tampered)), w.ws, w.chain.state, now)).toBeNull();
    expect(readAnnouncement(Buffer.from("not json"), w.ws, w.chain.state, now)).toBeNull();
    expect(workspaceTag(w.ws)).not.toContain(w.ws.slice(0, 10));
  });
});
