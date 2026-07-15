import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { certPemToDerBase64Url, generateServerIdentity } from "vault-rooms-relay/embedded-core";
import { RelayApiClient } from "../src/apiClient.js";
import { pinnedInfoForServer, ServerConnectionManager } from "../src/controllers/ServerConnectionManager.js";
import { copyInviteLink } from "../src/inviteClipboard.js";
import { inviteAcceptanceNotice, inviteJoinNotice } from "../src/inviteNotices.js";
import * as pinnedTransport from "../src/pinnedTransport.js";
import type { ServerConnection, VaultRoomsSettings } from "../src/settings.js";

vi.mock("sql.js/dist/sql-wasm-browser.wasm", () => ({ default: new Uint8Array() }));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(requestUrl).mockReset();
  vi.mocked(requestUrl).mockResolvedValue({
    status: 200,
    headers: {},
    text: "{}",
    json: { inviteId: "inv_1", inviteToken: "tr_inv_1", serverUrl: "http://relay", joinUrl: "obsidian://invite" },
    arrayBuffer: new ArrayBuffer(0)
  });
});

describe("invite API client", () => {
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

describe("pinned invite connection updates", () => {
  it("matches an existing connection by stable serverId before URL", () => {
    const existing = connection();
    const { manager } = createManager([existing]);

    expect(manager.findInviteServer("https://127.0.0.1:8788", existing.serverId)).toBe(existing);
    expect(manager.findInviteServer("http://127.0.0.1:8787", undefined)).toBe(existing);
    expect(manager.findInviteServer(existing.baseUrl, "srv_different_server")).toBeUndefined();
  });

  it("backfills a legacy connection's stable serverId from its own authenticated server before strict invite matching", async () => {
    const existing = connection({ serverId: undefined });
    const { manager, saveSettings } = createManager([existing]);
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      headers: {},
      text: "{}",
      json: {
        serverId: "srv_strict_migration",
        user: { id: existing.userId, displayName: existing.userDisplayName },
        device: { id: existing.deviceId, displayName: existing.deviceName },
        isServerOwner: false,
        teams: []
      },
      arrayBuffer: new ArrayBuffer(0)
    });

    const matched = await manager.resolveInviteServer("https://127.0.0.1:8788", "srv_strict_migration");

    expect(matched).toBe(existing);
    expect(existing.serverId).toBe("srv_strict_migration");
    expect(requestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `${existing.baseUrl}/api/me`,
        headers: expect.objectContaining({ authorization: `Bearer ${existing.deviceToken}` })
      })
    );
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it("resolves a legacy strict-migration connection at its saved URL even when the fresh invite host changed", async () => {
    const existing = connection({ baseUrl: "http://192.168.1.10:8787", serverId: undefined });
    const { manager } = createManager([existing]);
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      headers: {},
      text: "{}",
      json: {
        serverId: "srv_moved",
        user: { id: existing.userId, displayName: existing.userDisplayName },
        device: { id: existing.deviceId, displayName: existing.deviceName },
        isServerOwner: false,
        teams: []
      },
      arrayBuffer: new ArrayBuffer(0)
    });

    await expect(manager.resolveInviteServer("https://192.168.1.99:8788", "srv_moved")).resolves.toBe(existing);
    expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({ url: "http://192.168.1.10:8787/api/me" }));
  });

  it("keeps legacy invite matching atomic when persisting the discovered serverId fails", async () => {
    const existing = connection({ serverId: undefined });
    const { manager, settings, saveSettings } = createManager([existing]);
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      headers: {},
      text: "{}",
      json: {
        serverId: "srv_strict_migration",
        user: { id: existing.userId, displayName: existing.userDisplayName },
        device: { id: existing.deviceId, displayName: existing.deviceName },
        isServerOwner: false,
        teams: []
      },
      arrayBuffer: new ArrayBuffer(0)
    });
    saveSettings.mockRejectedValueOnce(new Error("save failed"));

    await expect(manager.resolveInviteServer("https://127.0.0.1:8788", "srv_strict_migration")).rejects.toThrow("save failed");

    expect(existing.serverId).toBeUndefined();
    expect(settings.servers).toEqual([existing]);
  });

  it("derives reusable pinned transport material only for pinned connections", async () => {
    const identity = await generateServerIdentity("srv_test_button");
    const pinned = connection({
      securityMode: "pinned-tls",
      tlsName: identity.tlsName,
      identityCertificateDer: certPemToDerBase64Url(identity.identityCertPem),
      pinnedIdentitySpkiSha256: identity.identitySpkiSha256
    });

    expect(pinnedInfoForServer(pinned)).toEqual({
      tlsName: identity.tlsName,
      identityCertificateDer: certPemToDerBase64Url(identity.identityCertPem),
      pinnedIdentitySpkiSha256: identity.identitySpkiSha256
    });
    expect(pinnedInfoForServer(connection())).toBeUndefined();
  });

  it("accepts a strict legacy invite with a request-bound proof and never exposes the bearer token", async () => {
    const identity = await generateServerIdentity("srv_invite_update");
    const existing = connection({ serverId: "srv_invite_update" });
    const { manager, settings, saveSettings } = createManager([existing]);
    const request = vi.spyOn(pinnedTransport, "pinnedRequest").mockResolvedValue({
      status: 200,
      text: "{}",
      json: {
        inviteType: "team",
        team: { id: "team_1", slug: "demo", name: "Demo" },
        deviceToken: "tr_dev_rotated"
      }
    });
    const pin = {
      serverId: "srv_invite_update",
      tlsName: identity.tlsName,
      identityCertificateDer: certPemToDerBase64Url(identity.identityCertPem),
      pinnedIdentitySpkiSha256: identity.identitySpkiSha256
    };

    await manager.acceptInviteForServer(existing, "tr_invite", "https://127.0.0.1:8788", pin);

    expect(existing.baseUrl).toBe("http://127.0.0.1:8787");
    expect(settings.servers).toHaveLength(1);
    expect(settings.servers[0]).toMatchObject({
      id: existing.id,
      baseUrl: "https://127.0.0.1:8788",
      deviceToken: "tr_dev_rotated",
      securityMode: "pinned-tls",
      serverId: "srv_invite_update",
      tlsName: identity.tlsName,
      pinnedIdentitySpkiSha256: identity.identitySpkiSha256,
      appliedRotationIds: [],
      securityState: "ok"
    });
    expect(saveSettings).toHaveBeenCalledOnce();
    const sent = request.mock.calls[0]![1];
    expect(sent).toMatchObject({ url: "https://127.0.0.1:8788/api/invites/accept" });
    expect(sent.headers).not.toHaveProperty("authorization");
    expect(JSON.parse(sent.body!)).toMatchObject({
      inviteToken: "tr_invite",
      deviceId: existing.deviceId,
      deviceProof: expect.any(String)
    });
  });

  it("does not disclose a bearer token when an attacker copies serverId into an invite with another identity", async () => {
    const attackerIdentity = await generateServerIdentity("srv_invite_update");
    const existing = connection({ serverId: "srv_invite_update" });
    const { manager, settings, saveSettings } = createManager([existing]);
    const request = vi.spyOn(pinnedTransport, "pinnedRequest").mockResolvedValue({
      status: 401,
      text: "{}",
      json: { error: { code: "UNAUTHORIZED", message: "Invalid credentials" } }
    });

    await expect(
      manager.acceptInviteForServer(existing, "tr_attacker_invite", "https://attacker.invalid:8788", {
        serverId: existing.serverId!,
        tlsName: attackerIdentity.tlsName,
        identityCertificateDer: certPemToDerBase64Url(attackerIdentity.identityCertPem),
        pinnedIdentitySpkiSha256: attackerIdentity.identitySpkiSha256
      })
    ).rejects.toThrow();

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![1].headers).not.toHaveProperty("authorization");
    expect(request.mock.calls[0]![1].body).not.toContain(existing.deviceToken);
    expect(settings.servers).toEqual([existing]);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("fails closed before networking when a pinned connection has incomplete identity material", async () => {
    const existing = connection({ securityMode: "pinned-tls", tlsName: undefined });
    const { manager } = createManager([existing]);
    const request = vi.spyOn(pinnedTransport, "pinnedRequest");

    await expect(manager.testConnection(existing.baseUrl, pinnedInfoForServer(existing))).rejects.toBeInstanceOf(
      pinnedTransport.InvalidPinMaterialError
    );
    expect(request).not.toHaveBeenCalled();
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("rejects corrupted identity material with zero requests and no settings mutation", async () => {
    const identity = await generateServerIdentity("srv_corrupt_invite");
    const existing = connection({ serverId: "srv_corrupt_invite" });
    const { manager, settings, saveSettings } = createManager([existing]);
    const request = vi.spyOn(pinnedTransport, "pinnedRequest");

    await expect(
      manager.acceptInviteForServer(existing, "tr_invite", "https://127.0.0.1:8788", {
        serverId: "srv_corrupt_invite",
        tlsName: identity.tlsName,
        identityCertificateDer: certPemToDerBase64Url(identity.identityCertPem),
        pinnedIdentitySpkiSha256: "corrupted"
      })
    ).rejects.toBeInstanceOf(pinnedTransport.InvalidPinMaterialError);

    expect(request).not.toHaveBeenCalled();
    expect(settings.servers).toEqual([existing]);
    expect(saveSettings).not.toHaveBeenCalled();
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

function connection(overrides: Partial<ServerConnection> = {}): ServerConnection {
  return {
    id: "dev_1",
    baseUrl: "http://127.0.0.1:8787",
    userId: "usr_1",
    userDisplayName: "Member",
    deviceId: "dev_1",
    deviceName: "Laptop",
    deviceToken: "tr_dev_plain",
    isServerOwner: false,
    status: "active",
    securityMode: "plain",
    serverId: "srv_existing",
    appliedRotationIds: [],
    ...overrides
  };
}

function createManager(servers: ServerConnection[]) {
  const settings: VaultRoomsSettings = {
    servers,
    activeServerId: servers[0]?.id,
    mountRoot: "Vault Rooms",
    debounceMs: 300,
    mountedRooms: {},
    roomMountPaths: {},
    server: { maxFileBytes: 1024, autoStart: false }
  };
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const manager = new ServerConnectionManager({
    app: { vault: { adapter: {} } },
    manifest: { id: "vault-rooms", dir: ".obsidian/plugins/vault-rooms" },
    settings,
    saveSettings,
    renderOpenRoomsViews: vi.fn()
  } as never);
  return { manager, settings, saveSettings };
}
