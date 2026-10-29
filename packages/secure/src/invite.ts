import { b64u, fromB64u, utf8 } from "./bytes.js";
import { canonicalJson } from "./canonical.js";
import { hashTagged, hkdf, randomBytes, sign, signingKeyPairFromSeed, verify, type KeyPair } from "./crypto.js";
import { fail } from "./errors.js";
import { deviceIdFor, isHash, isId, randomId } from "./ids.js";
import * as v from "./validate.js";
import { activeDevice, grantedRooms, inviteCreatorStands, overCapacity, parseAgreementKey, parseSigningKey, roleAtLeast, roleIn, type DeviceRecord, type InviteRecord, type Role, type SignedVersion, type WorkspaceState } from "./workspace.js";

/**
 * Invites. The link carries a random 32-byte secret. From it both sides derive an Ed25519 "invite key": the admin
 * puts its public half in the workspace record, and the joining device signs its join record with the private half.
 * So the secret itself never travels between peers, and nobody who merely sees a join record can reuse the invite.
 */

export function inviteKeyFromSecret(secret: Uint8Array): KeyPair {
  if (secret.length !== 32) fail("bad_secret");
  return signingKeyPairFromSeed(hkdf(secret, new Uint8Array(0), "invite-key"));
}

export interface NewInvite {
  inviteId: string;
  secret: Uint8Array;
  record: InviteRecord;
}

export function newInvite(by: { user: string; device: string }, rooms: Record<string, Role>, expires: number, forUser?: string): NewInvite {
  const secret = randomBytes(32);
  return {
    inviteId: randomId("i"),
    secret,
    record: { by: by.user, dev: by.device, key: inviteKeyFromSecret(secret).publicKey, expires, rooms, ...(forUser ? { forUser } : {}) }
  };
}

// ---- links ----

export interface InviteLink {
  workspaceId: string;
  inviteId: string;
  secret: Uint8Array;
  /** "host:port" of peers that were online when the link was made; discovery finds others. */
  peers: string[];
  /** Set for an invite to add another device of this existing user. */
  forUser?: string;
}

/** "host:port" of a peer: a name or IPv4 address, or an IPv6 address in brackets. */
export const PEER_PATTERN = /^[A-Za-z0-9.-]{1,253}:\d{1,5}$|^\[[0-9A-Fa-f:.]{2,45}\]:\d{1,5}$/;

export function formatInviteLink(link: InviteLink): string {
  const params = new URLSearchParams({ mode: "join-secure", ws: link.workspaceId, i: link.inviteId, s: b64u(link.secret) });
  if (link.peers.length > 0) params.set("p", link.peers.slice(0, 8).join(","));
  if (link.forUser) params.set("u", link.forUser);
  return `obsidian://vault-rooms?${params.toString()}`;
}

/** Accepts either the obsidian:// URL or the parameter object Obsidian hands to protocol handlers. */
export function parseInviteLink(input: string | Record<string, string>): InviteLink {
  let params: Record<string, string>;
  if (typeof input === "string") {
    let url: URL;
    try {
      url = new URL(input.trim());
    } catch {
      return fail("bad_invite_link");
    }
    if (url.protocol !== "obsidian:") fail("bad_invite_link");
    params = Object.fromEntries(url.searchParams.entries());
  } else {
    params = input;
  }
  if (params.mode !== "join-secure") fail("bad_invite_link");
  const workspaceId = params.ws;
  const inviteId = params.i;
  if (!isHash(workspaceId) || !isId(inviteId, "i") || typeof params.s !== "string") fail("bad_invite_link");
  const peers = (params.p ?? "").split(",").filter(Boolean);
  if (peers.length > 8 || peers.some((peer) => !PEER_PATTERN.test(peer))) fail("bad_invite_link");
  if (params.u !== undefined && !isId(params.u, "u")) fail("bad_invite_link");
  return { workspaceId, inviteId, secret: fromB64u(params.s, 32), peers, ...(params.u ? { forUser: params.u } : {}) };
}

// ---- join records ----

export interface JoinBody {
  kind: "vr-join-v1";
  ws: string;
  invite: string;
  user: { id: string; name: string };
  device: { id: string; name: string; sign: string; agree: string; tls: string };
  at: number;
}

export interface JoinRecord {
  body: JoinBody;
  /** Signature by the invite key (proves the secret). */
  inviteSig: string;
  /** Signature by the new device's key (proves the device key). */
  deviceSig: string;
}

const JOIN_INVITE_SIG = "join-invite";
const JOIN_DEVICE_SIG = "join-device";

export function createJoinRecord(input: {
  workspaceId: string;
  inviteId: string;
  secret: Uint8Array;
  user: { id: string; name: string };
  deviceName: string;
  deviceKey: KeyPair;
  agreementPublicKey: string;
  tlsFingerprint: string;
  now?: number;
}): JoinRecord {
  const body: JoinBody = {
    kind: "vr-join-v1",
    ws: input.workspaceId,
    invite: input.inviteId,
    user: input.user,
    device: { id: deviceIdFor(input.deviceKey.publicKey), name: input.deviceName, sign: input.deviceKey.publicKey, agree: input.agreementPublicKey, tls: input.tlsFingerprint },
    at: input.now ?? Date.now()
  };
  const message = utf8(canonicalJson(body));
  return { body, inviteSig: sign(inviteKeyFromSecret(input.secret).secretKey, JOIN_INVITE_SIG, message), deviceSig: sign(input.deviceKey.secretKey, JOIN_DEVICE_SIG, message) };
}

export function parseJoinRecord(value: unknown): JoinRecord {
  const o = v.obj(value, "join", ["body", "inviteSig", "deviceSig"]);
  const b = v.obj(o.body, "join.body", ["kind", "ws", "invite", "user", "device", "at"]);
  if (b.kind !== "vr-join-v1") v.bad("join.kind");
  const user = v.obj(b.user, "join.user", ["id", "name"]);
  const device = v.obj(b.device, "join.device", ["id", "name", "sign", "agree", "tls"]);
  const sign = parseSigningKey(device.sign, "join.device.sign");
  const id = v.id(device.id, "join.device.id", "d");
  if (deviceIdFor(sign) !== id) v.bad("join.device.id");
  return {
    body: {
      kind: "vr-join-v1",
      ws: v.hash(b.ws, "join.ws"),
      invite: v.id(b.invite, "join.invite", "i"),
      user: { id: v.id(user.id, "join.user.id", "u"), name: v.name(user.name, "join.user.name") },
      device: { id, name: v.name(device.name, "join.device.name"), sign, agree: parseAgreementKey(device.agree, "join.device.agree"), tls: v.hash(device.tls, "join.device.tls") },
      at: v.int(b.at, "join.at", 0, Number.MAX_SAFE_INTEGER)
    },
    inviteSig: v.b64(o.inviteSig, "join.inviteSig", 64),
    deviceSig: v.b64(o.deviceSig, "join.deviceSig", 64)
  };
}

export function joinHash(join: JoinRecord): string {
  return b64u(hashTagged("join-hash", utf8(canonicalJson(join))));
}

/** Slack for joins that happened just before expiry but reached this peer a little later. */
export const JOIN_EXPIRY_SLACK_MS = 10 * 60_000;

/**
 * The proof part of a join: it names this workspace and invite, it is signed with the key derived from the
 * invite's secret, and with the new device's own key. Whoever records a join in the workspace chain must include
 * the record, and every peer re-checks this, so no one can fill an invite with a device of their own choosing.
 */
export function verifyJoinProof(workspaceId: string, inviteId: string, invite: InviteRecord, join: JoinRecord): void {
  const { body } = join;
  if (body.ws !== workspaceId || body.invite !== inviteId) fail("join_workspace");
  if (deviceIdFor(body.device.sign) !== body.device.id) fail("join_device");
  if (invite.forUser !== undefined && body.user.id !== invite.forUser) fail("join_user");
  const message = utf8(canonicalJson(body));
  if (!verify(invite.key, JOIN_INVITE_SIG, message, join.inviteSig)) fail("join_invite_signature");
  if (!verify(body.device.sign, JOIN_DEVICE_SIG, message, join.deviceSig)) fail("join_device_signature");
}

/**
 * Throws unless `join` is a valid, still-unrecorded use of an open invite in `state`.
 * `firstSeen` is when this peer first saw the record (its own clock, not the record's claim).
 */
export function verifyJoinRecord(state: WorkspaceState, workspaceId: string, join: JoinRecord, firstSeen: number): void {
  const { body } = join;
  if (body.ws !== workspaceId) fail("join_workspace");
  const invite = state.invites[body.invite];
  if (!invite) fail("join_no_invite");
  if (invite.used !== undefined) fail("join_used");
  if (firstSeen > invite.expires + JOIN_EXPIRY_SLACK_MS) fail("join_expired");
  // The creator must still stand: their device active, and (inviting a new person) still an admin.
  if (!inviteCreatorStands(state, invite)) fail("join_creator");
  if (invite.forUser !== undefined) {
    const user = state.users[invite.forUser];
    if (body.user.id !== invite.forUser || !user || user.removed) fail("join_user");
  } else if (state.users[body.user.id]) fail("join_user");
  if (state.devices[body.device.id]) fail("join_device");
  verifyJoinProof(workspaceId, body.invite, invite, join);
}

/**
 * The membership peers act on: the signed state plus valid joins not yet recorded by an admin. For each invite
 * the join with the lowest hash wins, so every peer picks the same one. Returns the joins that took effect.
 */
export function applyJoins(
  state: WorkspaceState,
  workspaceId: string,
  joins: Iterable<{ join: JoinRecord; firstSeen: number }>
): { state: WorkspaceState; applied: JoinRecord[] } {
  const best = new Map<string, { join: JoinRecord; hash: string }>();
  for (const { join, firstSeen } of joins) {
    try {
      verifyJoinRecord(state, workspaceId, join, firstSeen);
    } catch {
      continue;
    }
    const hash = joinHash(join);
    const current = best.get(join.body.invite);
    if (!current || hash < current.hash) best.set(join.body.invite, { join, hash });
  }
  if (best.size === 0) return { state, applied: [] };
  const next = structuredClone(state);
  const applied: JoinRecord[] = [];
  const takenUsers = new Set<string>();
  for (const { join } of [...best.values()].sort((a, b) => (a.hash < b.hash ? -1 : 1))) {
    if (next.devices[join.body.device.id] || (!state.invites[join.body.invite]!.forUser && takenUsers.has(join.body.user.id))) continue;
    // Only within what the record may hold, counting the joins before it: as recording them all would be.
    if (overCapacity(next, join.body.user.id, true)) continue;
    foldJoinInto(next, join);
    takenUsers.add(join.body.user.id);
    applied.push(join);
  }
  return { state: next, applied };
}

/**
 * Records a join in a state: the user (unless joining as another device), the device, the invite as used, and its
 * room grants (those its creator still manages).
 */
/**
 * Whether the person a recorded join let in was taken back out later in the same branch: their device revoked or their
 * user removed, or (for a new user) a room they had when the join was recorded taken away or lowered by someone else,
 * and still so in the room's last state before any deletion (deleting a room takes nothing from anyone). `recorded` is
 * the state the recording version left, `after` the versions that follow it. A join recorded in a branch that lost a race
 * is waited on again unless it was taken back out. For another device of an existing user, only the device counts: that
 * user's room changes are made again on the winning branch like any other.
 */
export function takenBackOut(recorded: WorkspaceState, after: SignedVersion[], join: JoinRecord): boolean {
  const deviceId = join.body.device.id;
  const user = recorded.devices[deviceId]?.user;
  const end = after.length > 0 ? after[after.length - 1]!.body.state : recorded;
  if (!user || !activeDevice(end, deviceId)) return true;
  if (recorded.invites[join.body.invite]?.forUser !== undefined) return false;
  const states = [recorded, ...after.map((version) => version.body.state)];
  const lastLive = (roomId: string) => states.filter((state) => !state.rooms[roomId]?.deleted).pop() ?? recorded;
  let prev = recorded;
  for (const version of after) {
    const next = version.body.state;
    if (activeDevice(prev, version.body.by)?.user !== user) {
      for (const roomId of Object.keys(recorded.rooms)) {
        const given = roleIn(recorded, roomId, user);
        if (given === undefined || next.rooms[roomId]?.deleted) continue;
        const was = roleIn(prev, roomId, user);
        const now = roleIn(next, roomId, user);
        if (was !== undefined && !roleAtLeast(now, was) && !roleAtLeast(roleIn(lastLive(roomId), roomId, user), given)) return true;
      }
    }
    prev = next;
  }
  return false;
}

export function foldJoinInto(state: WorkspaceState, join: JoinRecord): void {
  const invite = state.invites[join.body.invite];
  if (!invite || invite.used !== undefined) fail("join_used");
  const { user, device } = join.body;
  const grants = grantedRooms(state, invite);
  if (invite.forUser === undefined) state.users[user.id] = { name: user.name, admin: false };
  const record: DeviceRecord = { user: user.id, name: device.name, sign: device.sign, agree: device.agree, tls: device.tls };
  state.devices[device.id] = record;
  invite.used = device.id;
  for (const [roomId, role] of Object.entries(grants)) {
    const room = state.rooms[roomId]!;
    if (room.members[user.id] === undefined) room.members[user.id] = role;
  }
}
