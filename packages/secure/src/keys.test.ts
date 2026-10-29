import { describe, expect, it } from "vitest";
import { utf8 } from "./bytes.js";
import { canonicalJson } from "./canonical.js";
import { sign } from "./crypto.js";
import { SecureError } from "./errors.js";
import { newRoomKey, openRoomName, parseKeyWrap, unwrapRoomKey, verifyKeyWrap, wrapRoomKey } from "./keys.js";
import { createRoom, founder, invite, newDevice } from "./testkit.js";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof SecureError ? error.code : String(error);
  }
  return "no error";
};

describe("room keys", () => {
  function setup() {
    const { chain, ws, admin } = founder();
    const { joiner: member } = invite(chain, admin, { userName: "Mia" });
    const { joiner: outsider } = invite(chain, admin, { userName: "Otto" });
    const { roomId, key } = createRoom(chain, admin, "Plans", { [member.userId]: "read" });
    return { chain, ws, admin, member, outsider, roomId, key };
  }

  it("reach members through signed wraps they can check", () => {
    const { chain, ws, admin, member, roomId, key } = setup();
    const wrap = parseKeyWrap(JSON.parse(JSON.stringify(wrapRoomKey(ws, roomId, 1, key, { id: member.id, agree: member.agree.publicKey }, admin.sign))));
    expect(verifyKeyWrap(chain.state, ws, wrap)).toBe(true);
    expect(unwrapRoomKey(chain.state, ws, wrap, member.agree)).toEqual(key);
  });

  it("only between members of the room", () => {
    const { chain, ws, admin, member, outsider, roomId, key } = setup();
    expect(verifyKeyWrap(chain.state, ws, wrapRoomKey(ws, roomId, 1, key, { id: outsider.id, agree: outsider.agree.publicKey }, admin.sign))).toBe(false);
    expect(verifyKeyWrap(chain.state, ws, wrapRoomKey(ws, roomId, 1, key, { id: member.id, agree: member.agree.publicKey }, outsider.sign))).toBe(false);
    const stranger = newDevice(member.userId);
    expect(verifyKeyWrap(chain.state, ws, wrapRoomKey(ws, roomId, 1, key, { id: member.id, agree: member.agree.publicKey }, stranger.sign))).toBe(false);
  });

  it("are refused if they carry a key other than the committed one", () => {
    const { chain, ws, admin, member, roomId } = setup();
    const wrong = wrapRoomKey(ws, roomId, 1, newRoomKey(), { id: member.id, agree: member.agree.publicKey }, admin.sign);
    // Naming another key's commitment, it doesn't count at all...
    expect(verifyKeyWrap(chain.state, ws, wrong)).toBe(false);
    // ...and naming the right one while carrying another key, it verifies but is useless to its recipient.
    const body = { ...wrong.body, commit: chain.state.rooms[roomId]!.epochs[0]!.commit };
    const lying = { body, sig: sign(admin.sign.secretKey, "key-wrap", utf8(canonicalJson(body))) };
    expect(verifyKeyWrap(chain.state, ws, lying)).toBe(true);
    expect(code(() => unwrapRoomKey(chain.state, ws, lying, member.agree))).toBe("key_mismatch");
  });

  it("can't be redirected or edited", () => {
    const { chain, ws, admin, member, outsider, roomId, key } = setup();
    const wrap = wrapRoomKey(ws, roomId, 1, key, { id: member.id, agree: member.agree.publicKey }, admin.sign);
    const redirected = structuredClone(wrap);
    redirected.body.to = outsider.id;
    expect(verifyKeyWrap(chain.state, ws, redirected)).toBe(false);
    expect(code(() => unwrapRoomKey(chain.state, ws, wrap, outsider.agree))).toBe("decrypt_failed");
  });

  it("seal the room name so only key holders read it", () => {
    const { chain, ws, roomId, key } = setup();
    const sealed = chain.state.rooms[roomId]!.name;
    expect(openRoomName(ws, roomId, key, sealed)).toBe("Plans");
    expect(code(() => openRoomName(ws, roomId, newRoomKey(), sealed))).toBe("decrypt_failed");
  });
});
