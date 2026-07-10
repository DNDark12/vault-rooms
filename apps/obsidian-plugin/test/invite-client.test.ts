import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { RelayApiClient } from "../src/apiClient.js";
import { copyInviteLink } from "../src/inviteClipboard.js";
import { inviteAcceptanceNotice, inviteJoinNotice } from "../src/inviteNotices.js";

describe("invite API client", () => {
  beforeEach(() => {
    vi.mocked(requestUrl).mockReset();
    vi.mocked(requestUrl).mockResolvedValue({
      status: 200,
      headers: {},
      text: "{}",
      json: { inviteId: "inv_1", inviteToken: "tr_inv_1", serverUrl: "http://relay", joinUrl: "obsidian://invite" },
      arrayBuffer: new ArrayBuffer(0)
    });
  });

  it("posts room invites with the selected preset", async () => {
    const api = new RelayApiClient("http://relay", "tr_dev_owner");

    await api.createRoomInvite("room_1", "editor");

    expect(requestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://relay/api/rooms/room_1/invites",
        method: "POST",
        body: JSON.stringify({ preset: "editor", expiresInMinutes: 60, maxUses: 1 })
      })
    );
  });

  it("posts friend invites without a target", async () => {
    const api = new RelayApiClient("http://relay", "tr_dev_owner");

    await api.createFriendInvite();

    expect(requestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://relay/api/invites",
        method: "POST",
        body: JSON.stringify({ expiresInMinutes: 60, maxUses: 1 })
      })
    );
  });
});

describe("invite clipboard", () => {
  it("copies with the Clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const selectFallback = vi.fn();

    const copied = await copyInviteLink("obsidian://invite", { writeText }, selectFallback);

    expect(copied).toBe(true);
    expect(writeText).toHaveBeenCalledWith("obsidian://invite");
    expect(selectFallback).not.toHaveBeenCalled();
  });

  it("selects the link when clipboard access is unavailable or rejects", async () => {
    const selectUnavailable = vi.fn();
    const selectRejected = vi.fn();

    await expect(copyInviteLink("obsidian://invite", undefined, selectUnavailable)).resolves.toBe(false);
    await expect(
      copyInviteLink("obsidian://invite", { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, selectRejected)
    ).resolves.toBe(false);

    expect(selectUnavailable).toHaveBeenCalledOnce();
    expect(selectRejected).toHaveBeenCalledOnce();
  });
});

describe("invite notices", () => {
  it("formats new-device Team, Room, and Friend joins without assuming a team", () => {
    const identity = {
      user: { id: "usr_1", displayName: "Friend" },
      device: { id: "dev_1", displayName: "Laptop" },
      deviceToken: "tr_dev_1",
      isServerOwner: false
    };

    expect(inviteJoinNotice({ ...identity, inviteType: "team", team: { id: "team_1", slug: "demo", name: "Demo" } }, "http://relay")).toBe("Joined team Demo");
    expect(inviteJoinNotice({ ...identity, inviteType: "room", room: { id: "room_1", name: "Shared" } }, "http://relay")).toBe("Joined room Shared");
    expect(inviteJoinNotice({ ...identity, inviteType: "friend" }, "http://relay")).toBe("Connected to http://relay");
  });

  it("formats existing-device acceptance including the Friend no-op", () => {
    expect(inviteAcceptanceNotice({ inviteType: "team", team: { id: "team_1", slug: "demo", name: "Demo" } })).toBe("Joined team Demo");
    expect(inviteAcceptanceNotice({ inviteType: "room", room: { id: "room_1", name: "Shared" } })).toBe("Joined room Shared");
    expect(inviteAcceptanceNotice({ inviteType: "friend", alreadyConnected: true })).toBe("You're already connected to this server");
  });
});
