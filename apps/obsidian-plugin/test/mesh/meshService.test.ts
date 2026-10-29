import { once } from "node:events";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createJoinRecord, keyCommitment, newRoomKey, nextVersion, parseInviteLink, type WorkspaceState } from "@vault-rooms/secure";
import { newDevice } from "@vault-rooms/secure/testkit";
import { MeshService, type MeshDeps, type MeshSettings } from "../../src/mesh/meshService.js";
import type { SecretStore } from "../../src/mesh/secrets.js";
import { MemoryFiles } from "./memoryFiles.js";

const services: MeshService[] = [];
afterEach(async () => {
  while (services.length > 0) await services.pop()!.stop();
});

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function deps(name: string): MeshDeps & { notices: string[]; secretValues: Map<string, string> } {
  const secretValues = new Map<string, string>();
  const secrets: SecretStore = { get: (id) => secretValues.get(id) ?? null, set: (id, value) => void secretValues.set(id, value), remove: (id) => void secretValues.delete(id) };
  const settings: MeshSettings = { scope: `test${name.toLowerCase()}scope`, workspace: null };
  const notices: string[] = [];
  return { files: new MemoryFiles(), dataRoot: ".obsidian/plugins/vault-rooms/mesh", secrets, settings, save: async () => {}, notify: (m) => notices.push(m), log: () => {}, notices, secretValues };
}

/** Start a service on localhost with no discovery reach: peers are given by address. */
async function started(service: MeshService): Promise<MeshService> {
  service.settings.port = 0;
  await service.start();
  services.push(service);
  return service;
}

describe("mesh service", () => {
  it("creates a workspace, invites someone, and shares an encrypted room with them", async () => {
    const anaDeps = deps("Ana");
    const ana = await started(await MeshService.create(anaDeps, { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    // Nothing secret in the settings or in the stored files.
    const stored = [...(anaDeps.files as MemoryFiles).data.values()].join("\n") + JSON.stringify(anaDeps.settings);
    for (const secret of anaDeps.secretValues.values()) expect(stored.includes(secret)).toBe(false);

    const roomId = await ana.createRoom("Plans");
    const link = (await ana.createInvite({ [roomId]: "write" })).replace(/p=[^&]*/, `p=127.0.0.1%3A${ana.listeningPort}`);
    const benDeps = deps("Ben");
    const ben = await started(await MeshService.join(benDeps, { link, userName: "Ben", deviceName: "Ben PC" }));
    // Ana's device records the join, hands Ben the room key, and Ben's device can read the room.
    await until(() => ben.rooms().some((room) => room.id === roomId && room.name === "Plans" && room.role === "write"));
    await until(() => ana.node.chain.state.devices[ben.me.deviceId] !== undefined);

    const anaReplica = ana.replica(roomId)!;
    const fileId = "f" + "A".repeat(22);
    anaReplica.editIndex((files) => files.set(fileId, { path: "Plan.md", kind: "md" }));
    anaReplica.noteDoc(fileId).getText("content").insert(0, "Secret plan");
    await until(() => ben.replica(roomId)?.files().has(fileId) === true && ben.replica(roomId)!.noteText(fileId) === "Secret plan");
  });

  it("keeps the invitation's addresses, so a device that joined finds the others again after a restart", async () => {
    const ana = await started(await MeshService.create(deps("AnaR"), { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    const address = `127.0.0.1:${ana.listeningPort}`;
    const link = (await ana.createInvite({})).replace(/p=[^&]*/, `p=${encodeURIComponent(address)}`);
    const benDeps = deps("BenR");
    const ben = await started(await MeshService.join(benDeps, { link, userName: "Ben", deviceName: "Ben PC" }));
    await until(() => ana.node.chain.state.devices[ben.me.deviceId] !== undefined);
    expect(benDeps.settings.workspace!.peers).toEqual([address]);
    await ben.stop();
    services.splice(services.indexOf(ben), 1);
    const again = await started((await MeshService.open(benDeps))!);
    await until(() => again.node.connectedDevices().includes(ana.me.deviceId));
  });

  it("finds the others again after a restart, also while the device it joined through is away", async () => {
    const ana = await started(await MeshService.create(deps("AnaH"), { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    const address = `127.0.0.1:${ana.listeningPort}`;
    const link = async () => (await ana.createInvite({})).replace(/p=[^&]*/, `p=${encodeURIComponent(address)}`);
    const benDeps = deps("BenH");
    const ben = await started(await MeshService.join(benDeps, { link: await link(), userName: "Ben", deviceName: "Ben PC" }));
    const cy = await started(await MeshService.join(deps("CyH"), { link: await link(), userName: "Cy", deviceName: "Cy PC" }));
    // No discovery (it may reach between services on one computer): only what they tell each other.
    const noDiscovery = (service: MeshService) => (service as unknown as { discovery?: { stop(): void } }).discovery?.stop();
    for (const service of [ana, ben, cy]) noDiscovery(service);
    for (const service of [ben, cy]) service.addresses = () => [`127.0.0.1:${service.listeningPort}`];
    // Ana's device tells each where the other is: they connect, and Ben's remembers where Cy's is.
    await until(() => ben.node.connectedDevices().includes(cy.me.deviceId), 20_000);
    await until(() => (benDeps.settings.workspace!.addresses ?? []).some(([device]) => device === cy.me.deviceId));
    // Ana's device goes away, and Ben's restarts on another port (nothing answers where Cy's knew Ana's and Ben's): it
    // finds Cy's on its own.
    const ports = [ana.listeningPort, ben.listeningPort];
    for (const service of [ana, ben]) {
      await service.stop();
      services.splice(services.indexOf(service), 1);
    }
    const taken = ports.map((port) => createServer().listen(port, "0.0.0.0"));
    await Promise.all(taken.map((server) => once(server, "listening")));
    try {
      const again = await started((await MeshService.open(benDeps))!);
      noDiscovery(again);
      expect(ports).not.toContain(again.listeningPort);
      await until(() => again.node.connectedDevices().includes(cy.me.deviceId), 20_000);
    } finally {
      for (const server of taken) server.close();
    }
  }, 60_000);

  it("rotates the room key when a member is removed, so new content is out of their reach", async () => {
    const ana = await started(await MeshService.create(deps("Ana2"), { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    const roomId = await ana.createRoom("Plans");
    const link = (await ana.createInvite({ [roomId]: "write" })).replace(/p=[^&]*/, `p=127.0.0.1%3A${ana.listeningPort}`);
    const ben = await started(await MeshService.join(deps("Ben2"), { link, userName: "Ben", deviceName: "Ben PC" }));
    await until(() => ben.replica(roomId)?.keyFor(1) !== undefined);
    await ana.setMember(roomId, ben.me.userId, null);
    await until(() => ben.replica(roomId) === null);
    expect(ana.state.rooms[roomId]!.epochs).toHaveLength(2);
    expect(ana.replica(roomId)!.sealEpoch()!.n).toBe(2);
    // Ben's device never received a wrap of the new key.
    expect(ana.node.allWraps().some((w) => w.body.room === roomId && w.body.n === 2 && w.body.to === ben.me.deviceId)).toBe(false);
  });

  it("stores a new room key before the others can hear of it, so Obsidian stopping right then doesn't lose it", async () => {
    const anaDeps = deps("AnaK");
    const ana = await started(await MeshService.create(anaDeps, { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    // What is on disk as each version is taken in (and sent to the others): Obsidian may stop right after.
    const files = anaDeps.files as MemoryFiles;
    const disks = new Map<unknown, Map<string, string>>();
    const offer = ana.node.offerVersions.bind(ana.node);
    ana.node.offerVersions = (versions, ...rest) => {
      for (const version of versions) disks.set(version, new Map(files.data));
      return offer(versions, ...rest);
    };
    /** Ana's computer starting again from that moment, then hearing of the version from someone: does it hold key `n`? */
    const keyAfterCrash = async (version: typeof ana.node.chain.head, n: number) => {
      const disk = new MemoryFiles();
      for (const [path, data] of disks.get(version)!) disk.data.set(path, data);
      const again = (await MeshService.open({ ...anaDeps, files: disk }))!;
      services.push(again);
      expect(again.node.offerVersions([version]).status).toBe("appended");
      return again.replica(roomId)?.keyFor(n) !== undefined;
    };
    const roomId = await ana.createRoom("Plans");
    expect(await keyAfterCrash(ana.node.chain.head, 1)).toBe(true);
    const link = async () => (await ana.createInvite({ [roomId]: "write" })).replace(/p=[^&]*/, `p=127.0.0.1%3A${ana.listeningPort}`);
    const ben = await started(await MeshService.join(deps("BenK"), { link: await link(), userName: "Ben", deviceName: "Ben PC" }));
    const cy = await started(await MeshService.join(deps("CyK"), { link: await link(), userName: "Cy", deviceName: "Cy PC" }));
    await until(() => ben.replica(roomId)?.keyFor(1) !== undefined && cy.replica(roomId)?.keyFor(1) !== undefined);
    // A removal starts a new key.
    await ana.setMember(roomId, ben.me.userId, null);
    expect(await keyAfterCrash(ana.node.chain.head, 2)).toBe(true);
    // So does revoking a computer that held the newest one.
    await until(() => cy.replica(roomId)?.keyFor(2) !== undefined);
    await ana.revokeDevice(cy.me.deviceId);
    await until(() => ana.state.rooms[roomId]!.epochs.length === 3);
    expect(await keyAfterCrash(ana.node.chain.all().find((version) => version.body.state.rooms[roomId]?.epochs.length === 3)!, 3)).toBe(true);
  }, 30_000);

  it("leaves out a key replacement once another change has replaced the key meanwhile", async () => {
    const ana = await started(await MeshService.create(deps("AnaQ"), { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    const roomId = await ana.createRoom("Plans");
    const link = (await ana.createInvite({ [roomId]: "write" })).replace(/p=[^&]*/, `p=127.0.0.1%3A${ana.listeningPort}`);
    const cy = await started(await MeshService.join(deps("CyQ"), { link, userName: "Cy", deviceName: "Cy PC" }));
    await until(() => cy.replica(roomId)?.keyFor(1) !== undefined);
    // Ana's automation is held, so the two replacements below, made at once, are the only ones.
    const automation = ana as unknown as { automating: boolean; rotateWhereNeeded(): Promise<void> };
    automation.automating = true;
    await ana.revokeDevice(cy.me.deviceId);
    await Promise.all([automation.rotateWhereNeeded(), automation.rotateWhereNeeded()]);
    expect(ana.state.rooms[roomId]!.epochs).toHaveLength(2);
    automation.automating = false;
  });

  it("keeps the key of a room whose creation lost a race to someone ranking higher", async () => {
    const ana = await started(await MeshService.create(deps("Ana3"), { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    await ana.setRoomCreation("members");
    const link = (await ana.createInvite({})).replace(/p=[^&]*/, `p=127.0.0.1%3A${ana.listeningPort}`);
    const ben = await started(await MeshService.join(deps("Ben3"), { link, userName: "Ben", deviceName: "Ben PC" }));
    await until(() => ben.node.chain.state.devices[ben.me.deviceId] !== undefined);
    const parent = ben.node.chain.head;
    const roomId = await ben.createRoom("Design");
    // Ana changed something else at the same moment: her version wins, and Ben's device makes the room again.
    const sibling = nextVersion(ben.settings.id, parent, ana.secrets.sign, (state) => (state.name = "Ana's team"));
    expect(ben.node.offerVersions([sibling]).status).toBe("replaced");
    await until(() => ben.state.rooms[roomId] !== undefined && ben.state.name === "Ana's team");
    await until(() => ben.rooms().find((room) => room.id === roomId)?.name === "Design");
  });

  it("makes a removal that lost a race again, with a new room key in the same change", async () => {
    const ana = await started(await MeshService.create(deps("Ana4"), { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    const link = (await ana.createInvite({})).replace(/p=[^&]*/, `p=127.0.0.1%3A${ana.listeningPort}`);
    const ben = await started(await MeshService.join(deps("Ben4"), { link, userName: "Ben", deviceName: "Ben PC" }));
    await until(() => ben.node.chain.state.devices[ben.me.deviceId] !== undefined);
    await ana.setAdmin(ben.me.userId, true);
    await until(() => ben.isAdmin());
    const roomId = await ben.createRoom("Design");
    // Mal joins the workspace, and Ben adds him to his room.
    const invite = parseInviteLink(await ana.createInvite({}));
    const mal = newDevice(`u${"M".repeat(22)}`, "Mal PC");
    ana.node.addJoin(createJoinRecord({ workspaceId: ana.settings.id, inviteId: invite.inviteId, secret: invite.secret, user: { id: mal.userId, name: "Mal" }, deviceName: mal.name, deviceKey: mal.sign, agreementPublicKey: mal.agree.publicKey, tlsFingerprint: mal.tls }));
    await until(() => ben.node.chain.state.devices[mal.id] !== undefined);
    await ben.setMember(roomId, mal.userId, "write");
    // Ben takes Mal out (with a new key) while Ana, at the same moment, makes him an admin no more: hers wins.
    const parent = ben.node.chain.head;
    await ben.setMember(roomId, mal.userId, null);
    const sibling = nextVersion(ben.settings.id, parent, ana.secrets.sign, (state) => (state.users[ben.me.userId]!.admin = false));
    expect(ben.node.offerVersions([sibling]).status).toBe("replaced");
    await until(() => ben.node.chain.since(sibling.body.v + 1).some((version) => version.body.by === ben.me.deviceId));
    const redo = ben.node.chain.since(sibling.body.v + 1).find((version) => version.body.by === ben.me.deviceId)!;
    expect(redo.body.state.rooms[roomId]!.members[mal.userId]).toBeUndefined();
    expect(redo.body.state.rooms[roomId]!.epochs).toHaveLength(2);
    await until(() => ben.replica(roomId)?.keyFor(2) !== undefined);
  });

  it("withdraws the invite of someone let in and taken back out in a branch that lost a race", async () => {
    const ana = await started(await MeshService.create(deps("Ana5"), { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    const link = (await ana.createInvite({})).replace(/p=[^&]*/, `p=127.0.0.1%3A${ana.listeningPort}`);
    const ben = await started(await MeshService.join(deps("Ben5"), { link, userName: "Ben", deviceName: "Ben PC" }));
    await until(() => ben.node.chain.state.devices[ben.me.deviceId] !== undefined);
    await ana.setAdmin(ben.me.userId, true);
    await until(() => ben.isAdmin());
    // Ana's computer is off from now on (so Ben's device is the one recording the join).
    services.splice(services.indexOf(ana), 1);
    await ana.stop();
    // Ben's invite link leaks; Mal joins with it, Ben's device lets him in, and Ben takes him back out.
    const invite = parseInviteLink(await ben.createInvite({}));
    const parent = ben.node.chain.head;
    const mal = newDevice(`u${"L".repeat(22)}`, "Mal PC");
    ben.node.addJoin(createJoinRecord({ workspaceId: ben.settings.id, inviteId: invite.inviteId, secret: invite.secret, user: { id: mal.userId, name: "Mal" }, deviceName: mal.name, deviceKey: mal.sign, agreementPublicKey: mal.agree.publicKey, tlsFingerprint: mal.tls }));
    await until(() => ben.node.chain.state.devices[mal.id] !== undefined);
    await ben.removeUser(mal.userId);
    // At the same moment, Ana made Ben an admin no more: her change wins, and Mal's recording with it is gone.
    const sibling = nextVersion(ben.settings.id, parent, ana.secrets.sign, (state) => (state.users[ben.me.userId]!.admin = false));
    expect(ben.node.offerVersions([sibling]).status).toBe("replaced");
    await until(() => ben.node.chain.state.invites[invite.inviteId] === undefined);
    expect(ben.state.devices[mal.id]).toBeUndefined();
  });

  it("makes again at once a revocation in a losing branch it didn't sign, while its signer is away", async () => {
    const ana = await started(await MeshService.create(deps("Ana6"), { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    const join = async (name: string, letter: string) => {
      const invite = parseInviteLink(await ana.createInvite({}));
      const device = newDevice(`u${letter.repeat(22)}`, `${name} PC`);
      ana.node.addJoin(createJoinRecord({ workspaceId: ana.settings.id, inviteId: invite.inviteId, secret: invite.secret, user: { id: device.userId, name }, deviceName: device.name, deviceKey: device.sign, agreementPublicKey: device.agree.publicKey, tlsFingerprint: device.tls }));
      await until(() => ana.node.chain.state.devices[device.id] !== undefined);
      return device;
    };
    const cy = await join("Cy", "C");
    const mal = await join("Mal", "M");
    const dan = await join("Dan", "D");
    await ana.setAdmin(cy.userId, true);
    // Cy revokes Mal's computer while Ana revokes Dan's, and hers wins; Ana's computer had Cy's change first.
    const parent = ana.node.chain.head;
    expect(ana.node.offerVersions([nextVersion(ana.settings.id, parent, cy.sign, (state) => (state.devices[mal.id]!.revoked = true))]).status).toBe("appended");
    expect(ana.node.offerVersions([nextVersion(ana.settings.id, parent, ana.secrets.sign, (state) => (state.devices[dan.id]!.revoked = true))]).status).toBe("replaced");
    // Cy's computer is away: Ana's makes Cy's revocation again right away, leaving Mal no time to act against Cy.
    await until(() => ana.state.devices[mal.id]!.revoked === true, 2_000);
    expect(ana.state.devices[dan.id]!.revoked).toBe(true);
  });

  it("makes no change of its own to the record before comparing it with a member's since it started", async () => {
    const anaDeps = deps("AnaC");
    const ana = await started(await MeshService.create(anaDeps, { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    const address = `127.0.0.1:${ana.listeningPort}`;
    const link = (await ana.createInvite({})).replace(/p=[^&]*/, `p=${encodeURIComponent(address)}`);
    const benDeps = deps("BenC");
    const ben = await started(await MeshService.join(benDeps, { link, userName: "Ben", deviceName: "Ben PC" }));
    await until(() => ana.node.chain.state.devices[ben.me.deviceId] !== undefined);
    // Both close Obsidian; Ana's computer starts again alone, and a join comes in.
    for (const service of [ana, ben]) {
      await service.stop();
      services.splice(services.indexOf(service), 1);
    }
    const again = await started((await MeshService.open(anaDeps))!);
    const invite = parseInviteLink(await again.createInvite({}));
    const eve = newDevice(`u${"E".repeat(22)}`, "Eve PC");
    again.node.addJoin(createJoinRecord({ workspaceId: again.settings.id, inviteId: invite.inviteId, secret: invite.secret, user: { id: eve.userId, name: "Eve" }, deviceName: eve.name, deviceKey: eve.sign, agreementPublicKey: eve.agree.publicKey, tlsFingerprint: eve.tls }));
    // No member has answered since it started: recording the join waits (on an old record, it could start a branch).
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(again.node.chain.state.devices[eve.id]).toBeUndefined();
    // Ben's computer comes back and answers: the join is recorded.
    benDeps.settings.workspace!.peers = [`127.0.0.1:${again.listeningPort}`];
    await started((await MeshService.open(benDeps))!);
    await until(() => again.node.chain.state.devices[eve.id] !== undefined, 20_000);
    // Much longer than the automation's tick since it last ran (the computer slept): it waits for an answer again.
    (again as unknown as { lastAutomate: number }).lastAutomate = Date.now() - 300_000;
    await (again as unknown as { automate(): Promise<void> }).automate();
    expect(again.node.recordCompared).toBe(false);
    // Asked again, Ben's computer answers.
    await until(() => again.node.recordCompared);
  }, 60_000);

  it("listens only on its own ports, the one it had first, and says so when none of them is free", async () => {
    // Ten ports no other test uses, all held by another program at first.
    const base = 48_000 + (process.pid % 90) * 10;
    const hold = async (port: number) => {
      const server = createServer().listen(port, "0.0.0.0");
      await once(server, "listening");
      return server;
    };
    const held = new Map<number, ReturnType<typeof createServer>>();
    for (let i = 0; i < 10; i++) held.set(base + i, await hold(base + i));
    const free = async (port: number) => {
      const server = held.get(port)!;
      held.delete(port);
      await new Promise((resolve) => server.close(resolve));
    };
    const d = deps("Ports");
    const first = await MeshService.create(d, { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" });
    d.settings.workspace!.port = base;
    try {
      await expect(first.start()).rejects.toThrow(`${base}–${base + 9}`);
      expect(first.listeningPort).toBe(0);
      expect(first.addresses()).toEqual([]);
      await first.stop();
      /** Obsidian starting again: the port it listens on. */
      const restart = async () => {
        const service = (await MeshService.open(d))!;
        await service.start();
        const port = service.listeningPort;
        await service.stop();
        return port;
      };
      // One comes free: it is used, and kept to after that, even once the first of them is free too.
      await free(base + 3);
      expect(await restart()).toBe(base + 3);
      await free(base);
      expect(await restart()).toBe(base + 3);
      // Taken again: the first free one of the range, never one past it.
      held.set(base + 3, await hold(base + 3));
      expect(await restart()).toBe(base);
    } finally {
      for (const port of [...held.keys()]) await free(port);
    }
  }, 30_000);

  it("says which rooms no one could manage any more, were a computer revoked, and shows them so once it is", async () => {
    const ana = await started(await MeshService.create(deps("AnaM"), { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    const roomId = await ana.createRoom("Plans");
    const link = (await ana.createInvite({})).replace(/p=[^&]*/, `p=127.0.0.1%3A${ana.listeningPort}`);
    const ben = await started(await MeshService.join(deps("BenM"), { link, userName: "Ben", deviceName: "Ben PC" }));
    await until(() => ana.node.chain.state.devices[ben.me.deviceId] !== undefined);
    await ana.setAdmin(ben.me.userId, true);
    await until(() => ben.isAdmin());
    // Ana's PC is the last computer of the room's only manager.
    expect(ben.roomsLeftUnmanaged(ana.me.deviceId)).toEqual([roomId]);
    expect(ana.roomsOnlyManagedBy(ana.me.userId)).toEqual([roomId]);
    // With a second computer of hers, it isn't.
    const deviceLink = (await ana.createDeviceInvite()).replace(/p=[^&]*/, `p=127.0.0.1%3A${ana.listeningPort}`);
    const laptop = await started(await MeshService.join(deps("AnaM2"), { link: deviceLink, userName: "Ana", deviceName: "Ana laptop" }));
    await until(() => ben.state.devices[laptop.me.deviceId] !== undefined);
    expect(ben.roomsLeftUnmanaged(ana.me.deviceId)).toEqual([]);
    // Both revoked: the room is shown as one no one can manage.
    await ben.revokeDevice(laptop.me.deviceId);
    expect(ben.roomsLeftUnmanaged(ana.me.deviceId)).toEqual([roomId]);
    await ben.revokeDevice(ana.me.deviceId);
    expect(ben.rooms().find((room) => room.id === roomId)?.managed).toBe(false);
  }, 30_000);

  it("looks at the key wraps once a round of handing out keys, however many keys its rooms have had", async () => {
    const ana = await started(await MeshService.create(deps("AnaW"), { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    const roomId = await ana.createRoom("Plans");
    const service = ana as unknown as { commit(change: (state: WorkspaceState) => void, joins: unknown[], keys: Map<string, Uint8Array>): Promise<unknown>; ensureWraps(): void };
    for (let n = 2; n <= 6; n++) {
      const key = newRoomKey();
      await service.commit((state) => void state.rooms[roomId]!.epochs.push({ n, commit: keyCommitment(ana.settings.id, roomId, n, key) }), [], new Map([[roomId, key]]));
    }
    expect(ana.state.rooms[roomId]!.epochs).toHaveLength(6);
    let scans = 0;
    const allWraps = ana.node.allWraps.bind(ana.node);
    ana.node.allWraps = () => (scans++, allWraps());
    service.ensureWraps();
    expect(scans).toBe(1);
  });

  it("never goes online once stopped", async () => {
    const service = await MeshService.create(deps("Gone"), { workspaceName: "Team", userName: "Ana", deviceName: "PC" });
    service.settings.port = 0;
    await service.stop();
    await service.start();
    expect(service.listeningPort).toBe(0);
  });

  it("makes no change once stopped, even one whose new key was being stored as it stopped", async () => {
    const d = deps("Closing");
    const service = await MeshService.create(d, { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" });
    // Storing the new room key takes a while, and Obsidian closes meanwhile.
    const files = d.files as MemoryFiles;
    const write = files.write.bind(files);
    let release: (() => void) | undefined;
    files.write = async (path, data) => {
      if (path.includes("wraps") && !release) await new Promise<void>((resolve) => (release = resolve));
      return write(path, data);
    };
    const creating = service.createRoom("Plans");
    await until(() => release !== undefined);
    const stopping = service.stop();
    release!();
    await expect(creating).rejects.toThrow(/closing/);
    await stopping;
    expect(service.state.rooms).toEqual({});
  });

  it("refuses to open when this device's keys are missing (a copied vault), and can still be left", async () => {
    const d = deps("Copy");
    const service = await MeshService.create(d, { workspaceName: "Team", userName: "Ana", deviceName: "PC" });
    await service.stop();
    d.secretValues.clear();
    await expect(MeshService.open(d)).rejects.toThrow(/keys are missing/);
    await MeshService.forgetUnopened(d);
    expect(d.settings.workspace).toBeNull();
    expect([...(d.files as MemoryFiles).data.keys()].filter((key) => key.startsWith(d.dataRoot))).toEqual([]);
  });

});
