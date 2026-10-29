// Test helpers (not exported from the package).
import { b64u } from "./bytes.js";
import { WorkspaceChain } from "./chain.js";
import { hashTagged, newAgreementKeyPair, newSigningKeyPair, randomBytes, type KeyPair } from "./crypto.js";
import { deviceIdFor, randomId } from "./ids.js";
import { createJoinRecord, foldJoinInto, newInvite, type JoinRecord } from "./invite.js";
import { keyCommitment, newRoomKey, sealRoomName } from "./keys.js";
import { createGenesis, nextVersion, type Role, type SignedVersion, type WorkspaceState } from "./workspace.js";
import type { Channel, MeshNode, PeerMessage, PeerSession } from "./mesh.js";

export interface TestDevice {
  id: string;
  userId: string;
  name: string;
  sign: KeyPair;
  agree: KeyPair;
  tls: string;
}

/** `tls`: a real certificate fingerprint when the test opens real connections; otherwise a random stand-in. */
export function newDevice(userId: string, name = "PC", tls?: string): TestDevice {
  const sign = newSigningKeyPair();
  return { id: deviceIdFor(sign.publicKey), userId, name, sign, agree: newAgreementKeyPair(), tls: tls ?? b64u(hashTagged("tls-test", randomBytes(16))) };
}

export function founder(workspaceName = "Team", userName = "Ana", tlsFingerprint?: string): { chain: WorkspaceChain; ws: string; admin: TestDevice } {
  const sign = newSigningKeyPair();
  const agree = newAgreementKeyPair();
  const tls = tlsFingerprint ?? b64u(hashTagged("tls-test", randomBytes(16)));
  const { genesis, workspaceId, userId, deviceId } = createGenesis({ workspaceName, userName, deviceName: "Ana PC", deviceKey: sign, agreementPublicKey: agree.publicKey, tlsFingerprint: tls });
  return { chain: new WorkspaceChain(genesis), ws: workspaceId, admin: { id: deviceId, userId, name: "Ana PC", sign, agree, tls } };
}

/** Sign the next version with `device`, apply it to `chain`, and return it. Throws if the change isn't allowed. */
export function step(chain: WorkspaceChain, device: TestDevice, change: (state: WorkspaceState) => void, now = Date.now(), joins: JoinRecord[] = []): SignedVersion {
  const version = nextVersion(chain.workspaceId, chain.head, device.sign, change, now, joins);
  const result = chain.offer([version]);
  if (result.status !== "appended") throw new Error(`step not appended: ${JSON.stringify(result)}`);
  return version;
}

/** Record a join in the chain, with the joiner's proof. */
export function fold(chain: WorkspaceChain, device: TestDevice, join: JoinRecord): SignedVersion {
  return step(chain, device, (state) => foldJoinInto(state, join), Date.now(), [join]);
}

export function createRoom(chain: WorkspaceChain, device: TestDevice, name = "Design", members: Record<string, Role> = {}): { roomId: string; key: Uint8Array } {
  const roomId = randomId("r");
  const key = newRoomKey();
  step(chain, device, (state) => {
    state.rooms[roomId] = {
      creator: device.userId,
      name: sealRoomName(chain.workspaceId, roomId, 1, key, name),
      members: { [device.userId]: "manage", ...members },
      epochs: [{ n: 1, commit: keyCommitment(chain.workspaceId, roomId, 1, key) }]
    };
  });
  return { roomId, key };
}

/** An admin invites someone; the new device makes its join record. Optionally the admin folds it into the chain. */
export function invite(
  chain: WorkspaceChain,
  admin: TestDevice,
  options: { rooms?: Record<string, Role>; userName?: string; fold?: boolean; forUser?: TestDevice; expires?: number; tls?: string } = {}
): { joiner: TestDevice; join: JoinRecord; inviteId: string; secret: Uint8Array } {
  const forUser = options.forUser;
  const fresh = newInvite({ user: admin.userId, device: admin.id }, options.rooms ?? {}, options.expires ?? Date.now() + 86_400_000, forUser?.userId);
  step(chain, admin, (state) => {
    state.invites[fresh.inviteId] = fresh.record;
  });
  const joiner = newDevice(forUser?.userId ?? randomId("u"), `${options.userName ?? "Ben"} PC`, options.tls);
  const join = createJoinRecord({
    workspaceId: chain.workspaceId,
    inviteId: fresh.inviteId,
    secret: fresh.secret,
    user: { id: joiner.userId, name: forUser ? chain.state.users[forUser.userId]!.name : (options.userName ?? "Ben") },
    deviceName: joiner.name,
    deviceKey: joiner.sign,
    agreementPublicKey: joiner.agree.publicKey,
    tlsFingerprint: joiner.tls
  });
  if (options.fold !== false) fold(chain, admin, join);
  return { joiner, join, inviteId: fresh.inviteId, secret: fresh.secret };
}

/** An in-memory network: messages queue up and are delivered (as JSON, like on the wire) by `pump`. */
export class Network {
  private queue: Array<() => void> = [];
  links: Array<{ a: string; b: string; cut: () => void }> = [];

  /** Connect two nodes, as if the transport had authenticated both ends. */
  link(a: MeshNode, b: MeshNode): { ab: PeerSession; ba: PeerSession; cut: () => void } {
    let open = true;
    const sessions: { ab?: PeerSession; ba?: PeerSession } = {};
    // Closing either end closes the connection, so the other end's session ends too (as with a real socket).
    const channel = (to: () => PeerSession | undefined): Channel => ({
      send: (message: PeerMessage) => {
        const wire = JSON.stringify(message);
        this.queue.push(() => open && to()?.receive(JSON.parse(wire)));
      },
      close: () => {
        if (!open) return;
        open = false;
        this.queue.push(() => to()?.close("remote_closed"));
      }
    });
    sessions.ab = a.connect(channel(() => sessions.ba), b.deviceId);
    sessions.ba = b.connect(channel(() => sessions.ab), a.deviceId);
    const cut = () => {
      open = false;
      sessions.ab!.close("cut");
      sessions.ba!.close("cut");
    };
    this.links.push({ a: a.deviceId, b: b.deviceId, cut });
    return { ab: sessions.ab, ba: sessions.ba, cut };
  }

  pump(limit = 100_000): number {
    let delivered = 0;
    while (this.queue.length > 0 && delivered < limit) {
      this.queue.shift()!();
      delivered++;
    }
    if (this.queue.length > 0) throw new Error("network did not settle");
    return delivered;
  }

  /** Pump until quiet, letting asynchronous sends (blobs read from storage) run in between. */
  async settle(rounds = 50): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      this.pump();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.queue.length === 0) return;
    }
    throw new Error("network did not settle");
  }

  enqueue(fn: () => void): void {
    this.queue.push(fn);
  }
}

