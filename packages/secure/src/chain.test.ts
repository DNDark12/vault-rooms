import { describe, expect, it } from "vitest";
import { MAX_FORK_DEPTH, WorkspaceChain } from "./chain.js";
import { keyCommitment, newRoomKey } from "./keys.js";
import { foldJoinInto } from "./invite.js";
import { createRoom, founder, invite, step } from "./testkit.js";
import { nextVersion, versionHash } from "./workspace.js";

describe("workspace chain", () => {
  it("appends in order, ignores duplicates and refuses gaps", () => {
    const { chain, admin } = founder();
    const v1 = step(chain, admin, (state) => (state.name = "One"));
    expect(chain.offer([v1])).toEqual({ status: "duplicate" });
    const other = WorkspaceChain.load(chain.all());
    const v2 = nextVersion(chain.workspaceId, chain.head, admin.sign, (state) => (state.name = "Two"));
    chain.offer([v2]);
    const v3 = nextVersion(chain.workspaceId, chain.head, admin.sign, (state) => (state.name = "Three"));
    expect(other.offer([v3])).toEqual({ status: "rejected", reason: "gap" });
    expect(other.offer([v2, v3])).toEqual({ status: "appended", count: 2 });
    expect(other.headHash).toBe(versionHash(v3));
  });

  it("refuses versions from another workspace", () => {
    const a = founder();
    const b = founder();
    const foreign = nextVersion(b.chain.workspaceId, b.chain.head, b.admin.sign, (state) => (state.name = "X"));
    expect(a.chain.offer([foreign])).toEqual({ status: "rejected", reason: "unknown_parent" });
  });

  it("reloads from stored versions", () => {
    const { chain, admin } = founder();
    invite(chain, admin);
    createRoom(chain, admin);
    const reloaded = WorkspaceChain.load(JSON.parse(JSON.stringify(chain.all())));
    expect(reloaded.headHash).toBe(chain.headHash);
    expect(reloaded.state).toEqual(chain.state);
  });

  it("two admins changing things at once converge on the same winner", () => {
    const { chain: anaChain, admin: ana } = founder();
    const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
    step(anaChain, ana, (state) => (state.users[ben.userId]!.admin = true));
    const benChain = WorkspaceChain.load(anaChain.all());
    const fromAna = nextVersion(anaChain.workspaceId, anaChain.head, ana.sign, (state) => (state.name = "Ana's name"));
    const fromBen = nextVersion(benChain.workspaceId, benChain.head, ben.sign, (state) => (state.name = "Ben's name"));
    anaChain.offer([fromAna]);
    benChain.offer([fromBen]);
    const anaResult = anaChain.offer([fromBen]);
    const benResult = benChain.offer([fromAna]);
    expect(anaChain.headHash).toBe(benChain.headHash);
    // Ana has been an admin longer, so her version wins, whatever the hashes; Ben is told his was replaced.
    expect(anaChain.state.name).toBe("Ana's name");
    expect(anaResult.status).toBe("rejected");
    expect(benResult).toMatchObject({ status: "replaced", lost: [fromBen] });
  });

  it("a branch that revokes the other side's signer always wins", () => {
    for (let round = 0; round < 6; round++) {
      const { chain: anaChain, admin: ana } = founder();
      const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
      const benChain = WorkspaceChain.load(anaChain.all());
      // Ben renames himself while Ana revokes his device; whatever the hashes, Ana's revocation stands.
      const revoke = nextVersion(anaChain.workspaceId, anaChain.head, ana.sign, (state) => (state.devices[ben.id]!.revoked = true));
      const rename = nextVersion(benChain.workspaceId, benChain.head, ben.sign, (state) => (state.users[ben.userId]!.name = `Ben ${round}`));
      anaChain.offer([revoke]);
      benChain.offer([rename]);
      expect(anaChain.offer([rename]).status).toBe("rejected");
      expect(benChain.offer([revoke]).status).toBe("replaced");
      expect(benChain.headHash).toBe(anaChain.headHash);
      expect(benChain.state.devices[ben.id]!.revoked).toBe(true);
    }
  });

  it("two admins revoking each other: the senior one stands, however the other grinds hashes", () => {
    for (let round = 0; round < 8; round++) {
      const { chain: anaChain, admin: ana } = founder();
      const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
      step(anaChain, ana, (state) => (state.users[ben.userId]!.admin = true));
      const benChain = WorkspaceChain.load(anaChain.all());
      const anaRevokesBen = nextVersion(anaChain.workspaceId, anaChain.head, ana.sign, (state) => (state.devices[ben.id]!.revoked = true));
      // Ben tries many timestamps and keeps the lowest hash he can find.
      let benRevokesAna = nextVersion(benChain.workspaceId, benChain.head, ben.sign, (state) => (state.devices[ana.id]!.revoked = true), 1);
      for (let at = 2; at < 40; at++) {
        const attempt = nextVersion(benChain.workspaceId, benChain.head, ben.sign, (state) => (state.devices[ana.id]!.revoked = true), at);
        if (versionHash(attempt) < versionHash(benRevokesAna)) benRevokesAna = attempt;
      }
      anaChain.offer([anaRevokesBen]);
      benChain.offer([benRevokesAna]);
      anaChain.offer([benRevokesAna]);
      benChain.offer([anaRevokesBen]);
      expect(anaChain.headHash).toBe(benChain.headHash);
      expect(anaChain.state.devices[ben.id]!.revoked).toBe(true);
      expect(anaChain.state.devices[ana.id]!.revoked).toBeUndefined();
    }
  });

  it("demoting an admin counts like revoking them", () => {
    const { chain: anaChain, admin: ana } = founder();
    const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
    step(anaChain, ana, (state) => (state.users[ben.userId]!.admin = true));
    const benChain = WorkspaceChain.load(anaChain.all());
    const demote = nextVersion(anaChain.workspaceId, anaChain.head, ana.sign, (state) => (state.users[ben.userId]!.admin = false));
    const revokeAna = nextVersion(benChain.workspaceId, benChain.head, ben.sign, (state) => (state.devices[ana.id]!.revoked = true));
    anaChain.offer([demote]);
    benChain.offer([revokeAna]);
    anaChain.offer([revokeAna]);
    benChain.offer([demote]);
    expect(benChain.headHash).toBe(anaChain.headHash);
    expect(benChain.state.users[ben.userId]!.admin).toBe(false);
  });

  it("refuses to rewrite history further back than the fork limit", () => {
    const { chain: anaChain, admin: ana } = founder();
    const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
    step(anaChain, ana, (state) => (state.users[ben.userId]!.admin = true));
    const benChain = WorkspaceChain.load(anaChain.all());
    const benVersion = step(benChain, ben, (state) => (state.name = "Ben's"));
    for (let i = 0; i <= MAX_FORK_DEPTH; i++) step(anaChain, ana, (state) => (state.name = `Ana ${i}`));
    expect(anaChain.offer([benVersion])).toEqual({ status: "rejected", reason: "fork_too_deep" });
    // The other way round it is an ordinary conflict, which Ana's branch wins.
    expect(benChain.offer(anaChain.since(benVersion.body.v)).status).toBe("replaced");
    expect(benChain.headHash).toBe(anaChain.headHash);
  });

  it("giving up one of your own devices can't undo your removal from a room", () => {
    const { chain: anaChain, admin: ana } = founder();
    const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
    const { joiner: laptop } = invite(anaChain, ben, { forUser: ben });
    const { roomId } = createRoom(anaChain, ana, "Docs", { [ben.userId]: "write" });
    const fork = WorkspaceChain.load(anaChain.all());
    // Ben renames himself from his laptop; then Ana, the room's manager, takes him out of the room.
    step(anaChain, laptop, (state) => (state.users[ben.userId]!.name = "Ben L"));
    step(anaChain, ana, (state) => delete state.rooms[roomId]!.members[ben.userId]);
    // From his other computer, Ben answers with a sibling that revokes his own laptop (which signed in Ana's branch).
    const sibling = nextVersion(fork.workspaceId, fork.head, ben.sign, (state) => (state.devices[laptop.id]!.revoked = true));
    expect(anaChain.offer([sibling]).status).toBe("rejected");
    expect(anaChain.state.rooms[roomId]!.members[ben.userId]).toBeUndefined();
  });

  it("an admin a manager took out of a room can't undo it with a change of their own", () => {
    const { chain: anaChain, admin: ana } = founder();
    const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
    const { roomId } = createRoom(anaChain, ana, "Docs", { [ben.userId]: "manage" });
    const fork = WorkspaceChain.load(anaChain.all());
    // Ben (a manager, junior to Ana) takes Ana out of the room; at the same moment Ana renames the workspace.
    const removal = nextVersion(fork.workspaceId, fork.head, ben.sign, (state) => delete state.rooms[roomId]!.members[ana.userId]);
    const rename = step(anaChain, ana, (state) => (state.name = "Ana's"));
    expect(anaChain.offer([removal]).status).toBe("replaced");
    expect(anaChain.state.rooms[roomId]!.members[ana.userId]).toBeUndefined();
    expect(fork.offer([removal]).status).toBe("appended");
    expect(fork.offer([rename]).status).toBe("rejected");
  });

  it("a removal can't be undone by an unrelated change made at the same moment, whoever ranks higher", () => {
    const { chain: anaChain, admin: ana } = founder();
    const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
    const { joiner: mal } = invite(anaChain, ana, { userName: "Mal" });
    step(anaChain, ana, (state) => (state.users[ben.userId]!.admin = true));
    const { roomId } = createRoom(anaChain, ben, "Docs", { [mal.userId]: "write" });
    const fork = WorkspaceChain.load(anaChain.all());
    // Ben, who manages the room, takes Mal out of it and starts a new key; Ana, senior to him, renames the workspace.
    const removal = nextVersion(fork.workspaceId, fork.head, ben.sign, (state) => {
      delete state.rooms[roomId]!.members[mal.userId];
      state.rooms[roomId]!.epochs.push({ n: 2, commit: keyCommitment(fork.workspaceId, roomId, 2, newRoomKey()) });
    });
    step(anaChain, ana, (state) => (state.name = "Ana's"));
    expect(anaChain.offer([removal]).status).toBe("replaced");
    expect(anaChain.state.rooms[roomId]!.members[mal.userId]).toBeUndefined();
    expect(anaChain.state.rooms[roomId]!.epochs).toHaveLength(2);
  });

  it("letting someone in and then revoking them still counts as a revocation", () => {
    const { chain: anaChain, admin: ana } = founder();
    const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
    step(anaChain, ana, (state) => (state.users[ben.userId]!.admin = true));
    const fork = WorkspaceChain.load(anaChain.all());
    // Ben records the join of someone whose invite link leaked, then revokes their device; Ana renames meanwhile.
    const { joiner: mal, join } = invite(fork, ben, { userName: "Mal", fold: false });
    const recorded = step(fork, ben, (state) => foldJoinInto(state, join), Date.now(), [join]);
    const revoked = step(fork, ben, (state) => (state.devices[mal.id]!.revoked = true));
    step(anaChain, ana, (state) => (state.name = "Ana's"));
    const branch = fork.since(anaChain.length - 1);
    expect(branch.map((version) => versionHash(version))).toContain(versionHash(recorded));
    expect(anaChain.offer(branch).status).toBe("replaced");
    expect(anaChain.state.devices[mal.id]!.revoked).toBe(true);
    expect(versionHash(anaChain.head)).toBe(versionHash(revoked));
  });

  it("taking standing away and giving it back in the same branch wins nothing", () => {
    const { chain: anaChain, admin: ana } = founder();
    const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
    const { joiner: cy } = invite(anaChain, ana, { userName: "Cy" });
    const { roomId } = createRoom(anaChain, ana, "Docs", { [ben.userId]: "manage", [cy.userId]: "write" });
    const fork = WorkspaceChain.load(anaChain.all());
    // Ben, who manages the room, lowers Cy and puts her back; at the same moment Ana, senior to him, renames.
    const lowered = step(fork, ben, (state) => (state.rooms[roomId]!.members[cy.userId] = "read"));
    const back = step(fork, ben, (state) => (state.rooms[roomId]!.members[cy.userId] = "write"));
    step(anaChain, ana, (state) => (state.name = "Ana's"));
    expect(anaChain.offer([lowered, back]).status).toBe("rejected");
    expect(anaChain.state.name).toBe("Ana's");
  });

  it("a writer's key rotation can't push aside the changes of someone who ranks higher", () => {
    const { chain: anaChain, admin: ana } = founder();
    const { joiner: wen } = invite(anaChain, ana, { userName: "Wen" });
    const { roomId } = createRoom(anaChain, ana, "Docs", { [wen.userId]: "write" });
    const fork = WorkspaceChain.load(anaChain.all());
    // A rotation signed as a sibling of Ana's change loses (it is made again on top when it is still needed), so a
    // writer can't throw away recent changes of others by rotating a key.
    const rotation = nextVersion(fork.workspaceId, fork.head, wen.sign, (state) => void state.rooms[roomId]!.epochs.push({ n: 2, commit: keyCommitment(fork.workspaceId, roomId, 2, newRoomKey()) }));
    step(anaChain, ana, (state) => (state.name = "Ana's"));
    expect(anaChain.offer([rotation]).status).toBe("rejected");
    expect(anaChain.state.name).toBe("Ana's");
  });

  it("one user signing on two computers can't throw away other people's changes", () => {
    const { chain: anaChain, admin: ana } = founder();
    const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
    const { joiner: laptop } = invite(anaChain, ben, { forUser: ben });
    const fork = WorkspaceChain.load(anaChain.all());
    step(anaChain, ben, (state) => (state.users[ben.userId]!.name = "Ben D"));
    step(anaChain, ana, (state) => (state.name = "Ana's"));
    const sibling = nextVersion(fork.workspaceId, fork.head, laptop.sign, (state) => (state.users[ben.userId]!.name = "Ben L"));
    expect(anaChain.offer([sibling]).status).toBe("rejected");
    expect(anaChain.state.name).toBe("Ana's");
  });

  it("three admins revoking one another at once end on the same branch, whatever order the branches arrive in", () => {
    const { chain, admin: a } = founder();
    const { joiner: b } = invite(chain, a, { userName: "B" });
    const { joiner: c } = invite(chain, a, { userName: "C" });
    step(chain, a, (state) => {
      state.users[b.userId]!.admin = true;
      state.users[c.userId]!.admin = true;
    });
    const branches = [
      [nextVersion(chain.workspaceId, chain.head, a.sign, (state) => (state.devices[b.id]!.revoked = true))],
      [nextVersion(chain.workspaceId, chain.head, b.sign, (state) => (state.devices[c.id]!.revoked = true))],
      [nextVersion(chain.workspaceId, chain.head, c.sign, (state) => (state.devices[a.id]!.revoked = true))]
    ];
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const heads = orders.map((order) => {
      const peer = WorkspaceChain.load(chain.all());
      for (const i of order) peer.offer(branches[i]!);
      // Offering them all again (a replay) changes nothing any more.
      for (const branch of branches) expect(["rejected", "duplicate"]).toContain(peer.offer(branch).status);
      return peer.headHash;
    });
    expect(new Set(heads).size).toBe(1);
  });

  it("settles a deeper fork the same way", () => {
    const { chain: anaChain, admin: ana } = founder();
    const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
    step(anaChain, ana, (state) => (state.users[ben.userId]!.admin = true));
    const benChain = WorkspaceChain.load(anaChain.all());
    const a1 = step(anaChain, ana, (state) => (state.name = "A1"));
    const a2 = step(anaChain, ana, (state) => (state.name = "A2"));
    const b1 = step(benChain, ben, (state) => (state.name = "B1"));
    anaChain.offer([b1]);
    benChain.offer([a1, a2]);
    expect(anaChain.headHash).toBe(benChain.headHash);
    expect(anaChain.state.name).toBe("A2");
    expect(versionHash(a1)).not.toBe(versionHash(b1));
  });
});
