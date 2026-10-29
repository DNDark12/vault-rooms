import { describe, expect, it } from "vitest";
import { randomBytes } from "./crypto.js";
import { SecureError } from "./errors.js";
import { randomId } from "./ids.js";
import { applyJoins, createJoinRecord, formatInviteLink, JOIN_EXPIRY_SLACK_MS, joinHash, parseInviteLink, parseJoinRecord, verifyJoinRecord } from "./invite.js";
import { createRoom, founder, invite, newDevice } from "./testkit.js";
import { roleIn } from "./workspace.js";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof SecureError ? error.code : String(error);
  }
  return "no error";
};

describe("invite links", () => {
  it("round-trip, from a URL or from Obsidian's parameter object", () => {
    const link = { workspaceId: "A".repeat(43), inviteId: randomId("i"), secret: randomBytes(32), peers: ["192.168.1.20:8790", "pc-ben.local:8790"] };
    const url = formatInviteLink(link);
    expect(parseInviteLink(url)).toEqual(link);
    expect(parseInviteLink(Object.fromEntries(new URL(url).searchParams))).toEqual(link);
  });
  it("refuse anything malformed", () => {
    const good = formatInviteLink({ workspaceId: "A".repeat(43), inviteId: randomId("i"), secret: randomBytes(32), peers: [] });
    expect(code(() => parseInviteLink(good.replace("join-secure", "join")))).toBe("bad_invite_link");
    expect(code(() => parseInviteLink(good.replace("obsidian:", "https:")))).toBe("bad_invite_link");
    expect(code(() => parseInviteLink(`${good}&p=evil host:1`))).toBe("bad_invite_link");
    expect(code(() => parseInviteLink(good.replace(/s=[^&]+/, "s=short")))).not.toBe("no error");
  });
});

describe("join records", () => {
  it("admit the joiner with the invite's rooms before any admin records it", () => {
    const { chain, ws, admin } = founder();
    const { roomId } = createRoom(chain, admin, "Docs");
    const { join } = invite(chain, admin, { rooms: { [roomId]: "write" }, fold: false });
    const parsed = parseJoinRecord(JSON.parse(JSON.stringify(join)));
    expect(() => verifyJoinRecord(chain.state, ws, parsed, Date.now())).not.toThrow();
    const { state, applied } = applyJoins(chain.state, ws, [{ join: parsed, firstSeen: Date.now() }]);
    expect(applied).toHaveLength(1);
    expect(roleIn(state, roomId, join.body.user.id)).toBe("write");
    expect(state.devices[join.body.device.id]?.user).toBe(join.body.user.id);
    expect(chain.state.devices[join.body.device.id]).toBeUndefined(); // the signed state itself is untouched
  });

  it("need the invite secret and the device key", () => {
    const { chain, ws, admin } = founder();
    const { join, inviteId } = invite(chain, admin, { fold: false });
    const imposter = newDevice(randomId("u"));
    const withoutSecret = createJoinRecord({ workspaceId: ws, inviteId, secret: randomBytes(32), user: { id: imposter.userId, name: "Eve" }, deviceName: "Eve", deviceKey: imposter.sign, agreementPublicKey: imposter.agree.publicKey, tlsFingerprint: imposter.tls });
    expect(code(() => verifyJoinRecord(chain.state, ws, withoutSecret, Date.now()))).toBe("join_invite_signature");
    const swappedKeys = structuredClone(join);
    swappedKeys.body.device.agree = imposter.agree.publicKey;
    expect(code(() => verifyJoinRecord(chain.state, ws, swappedKeys, Date.now()))).toBe("join_invite_signature");
  });

  it("expire, and can't be used twice", () => {
    const { chain, ws, admin } = founder();
    const expires = Date.now() + 60_000;
    const { join } = invite(chain, admin, { fold: false, expires });
    expect(code(() => verifyJoinRecord(chain.state, ws, join, expires + JOIN_EXPIRY_SLACK_MS + 1))).toBe("join_expired");
    const folded = invite(chain, admin);
    expect(code(() => verifyJoinRecord(chain.state, ws, folded.join, Date.now()))).toBe("join_used");
  });

  it("racing for one invite: every peer picks the same winner", () => {
    const { chain, ws, admin } = founder();
    const { join, inviteId, secret } = invite(chain, admin, { fold: false });
    const second = newDevice(randomId("u"));
    const rival = createJoinRecord({ workspaceId: ws, inviteId, secret, user: { id: second.userId, name: "Twin" }, deviceName: "Twin", deviceKey: second.sign, agreementPublicKey: second.agree.publicKey, tlsFingerprint: second.tls });
    const now = Date.now();
    const one = applyJoins(chain.state, ws, [{ join, firstSeen: now }, { join: rival, firstSeen: now }]);
    const other = applyJoins(chain.state, ws, [{ join: rival, firstSeen: now }, { join, firstSeen: now }]);
    const winner = joinHash(join) < joinHash(rival) ? join : rival;
    expect(one.applied).toEqual([winner]);
    expect(other.applied).toEqual([winner]);
  });
});
