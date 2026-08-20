import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { certPemToDerBase64Url, generateServerIdentity } from "vault-rooms-relay/embedded-core";
import { RelayApiClient } from "../src/apiClient.js";
import {
  embeddedLanShareProbeTarget,
  normalizeReplacementServerUrl,
  pinnedInfoForServer,
  ServerConnectionManager
} from "../src/controllers/ServerConnectionManager.js";
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
  it("keeps same-hostname vault probes bound to each vault's own port and TLS identity", () => {
    const vaultA = embeddedStatus({
      localUrl: "https://127.0.0.1:8788",
      lanUrl: "https://huynd.local:8788",
      serverId: "srv_a",
      pinnedInfo: embeddedPin("srv_a", "pin-a")
    });
    const vaultB = embeddedStatus({
      localUrl: "https://127.0.0.1:8790",
      lanUrl: "https://huynd.local:8790",
      serverId: "srv_b",
      pinnedInfo: embeddedPin("srv_b", "pin-b")
    });

    expect(embeddedLanShareProbeTarget(vaultA)).toEqual({
      baseUrl: vaultA.lanUrl,
      connectionBaseUrl: vaultA.localUrl,
      pin: vaultA.pinnedInfo
    });
    expect(embeddedLanShareProbeTarget(vaultB)).toEqual({
      baseUrl: vaultB.lanUrl,
      connectionBaseUrl: vaultB.localUrl,
      pin: vaultB.pinnedInfo
    });
  });

  it("keeps IP advertisements on the existing direct probe path", () => {
    const status = embeddedStatus({
      localUrl: "https://127.0.0.1:8788",
      lanUrl: "https://192.168.12.16:8788"
    });

    expect(embeddedLanShareProbeTarget(status)).toEqual({
      baseUrl: status.lanUrl,
      pin: status.pinnedInfo
    });
    expect(embeddedLanShareProbeTarget({ running: false })).toBeUndefined();
    expect(embeddedLanShareProbeTarget(embeddedStatus({ lanUrl: undefined }))).toBeUndefined();
  });

  it("starts and stops LAN discovery with the embedded relay without making discovery a hosting dependency", async () => {
    const embedded = connection({ isServerOwner: true, securityMode: "pinned-tls", serverId: "srv_local" });
    const responder = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
    const createLanDiscoveryResponder = vi.fn(() => responder);
    const { manager } = createManager([embedded], {
      createLanDiscoveryResponder,
      resolveLanDiscoveryInterface: vi.fn().mockResolvedValue("192.168.12.16")
    });
    const status = {
      running: true,
      host: "0.0.0.0",
      port: 8787,
      localUrl: "https://127.0.0.1:8788",
      lanUrl: "https://host.local:8788",
      securityMode: "pinned-tls",
      bootstrapped: true,
      serverId: "srv_local",
      legacyV01BackupAvailable: false,
      securityState: "pinned_tls",
      pinnedInfo: {
        serverId: "srv_local",
        tlsName: "srv-local.vault-rooms.internal",
        identityCertificateDer: "cert",
        pinnedIdentitySpkiSha256: "pin"
      }
    } as const;
    const embeddedRuntime = {
      start: vi.fn().mockResolvedValue(status),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(() => status)
    };
    (manager as unknown as { embeddedServer: typeof embeddedRuntime }).embeddedServer = embeddedRuntime;

    await manager.startEmbeddedServer({ notify: false });

    expect(responder.start).toHaveBeenCalledOnce();
    expect(createLanDiscoveryResponder).toHaveBeenCalledWith(expect.objectContaining({
      interfaceAddress: "192.168.12.16"
    }));
    expect(manager.getServerStatus()).toMatchObject({ lanDiscoveryAvailable: true });

    await manager.stopEmbeddedServer({ notify: false });
    expect(responder.stop).toHaveBeenCalledOnce();
    expect(embeddedRuntime.stop).toHaveBeenCalledOnce();
  });

  it("keeps hosting available when the LAN discovery listener cannot start", async () => {
    const embedded = connection({ isServerOwner: true, securityMode: "pinned-tls", serverId: "srv_local" });
    const responder = { start: vi.fn().mockRejectedValue(new Error("UDP blocked")), stop: vi.fn() };
    const { manager } = createManager([embedded], {
      createLanDiscoveryResponder: vi.fn(() => responder)
    });
    const status = {
      running: true,
      host: "0.0.0.0",
      port: 8787,
      localUrl: "https://127.0.0.1:8788",
      securityMode: "pinned-tls",
      bootstrapped: true,
      serverId: "srv_local",
      legacyV01BackupAvailable: false,
      securityState: "pinned_tls"
    } as const;
    (manager as unknown as { embeddedServer: unknown }).embeddedServer = {
      start: vi.fn().mockResolvedValue(status),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(() => status)
    };

    await expect(manager.startEmbeddedServer({ notify: false })).resolves.toMatchObject({ running: true });
    expect(manager.getServerStatus()).toMatchObject({
      running: true,
      lanDiscoveryAvailable: false,
      lanDiscoveryError: "UDP blocked"
    });
  });

  it("stops LAN discovery during silent plugin teardown", async () => {
    const embedded = connection({ isServerOwner: true, securityMode: "pinned-tls", serverId: "srv_local" });
    const responder = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
    const { manager } = createManager([embedded], {
      createLanDiscoveryResponder: vi.fn(() => responder)
    });
    const status = {
      running: true,
      host: "0.0.0.0",
      port: 8787,
      localUrl: "https://127.0.0.1:8788",
      securityMode: "pinned-tls",
      bootstrapped: true,
      serverId: "srv_local",
      legacyV01BackupAvailable: false,
      securityState: "pinned_tls"
    } as const;
    const embeddedRuntime = {
      start: vi.fn().mockResolvedValue(status),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(() => status)
    };
    (manager as unknown as { embeddedServer: typeof embeddedRuntime }).embeddedServer = embeddedRuntime;

    await manager.startEmbeddedServer({ notify: false });
    await manager.stopSilently();

    expect(responder.stop).toHaveBeenCalledOnce();
    expect(manager.getServerStatus()).toMatchObject({ lanDiscoveryAvailable: false });
  });

  it("recognizes an explicitly marked embedded connection even when its saved endpoint is a hostname", () => {
    const embedded = connection({
      baseUrl: "https://host-b.local:8788",
      isServerOwner: true,
      securityMode: "pinned-tls"
    });
    const { manager, settings } = createManager([embedded]);
    settings.embeddedServerConnectionId = embedded.id;

    expect(manager.ownEmbeddedServerId()).toBe(embedded.id);
  });

  it("updates a DHCP-stale address without replacing identity or mounted-room ownership", async () => {
    const existing = connection({ baseUrl: "http://192.168.12.21:8787" });
    const { manager, settings, saveSettings } = createManager([existing]);
    settings.mountedRooms.room_1 = {
      roomId: "room_1",
      serverId: existing.id,
      mountPath: "Vault Rooms/Room",
      files: {},
      unmounted: false,
      canPushLocalEdits: true
    };
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      headers: {},
      text: "{}",
      json: {
        serverId: existing.serverId,
        user: { id: existing.userId, displayName: existing.userDisplayName },
        device: { id: existing.deviceId, displayName: existing.deviceName },
        isServerOwner: false,
        storageUsageBytes: 0,
        maxStoredContentBytes: 1024,
        teams: []
      },
      arrayBuffer: new ArrayBuffer(0)
    });

    const updated = await manager.updateServerAddress(existing.id, "HuyND.local");

    expect(updated.baseUrl).toBe("http://huynd.local:8787");
    expect(updated).toMatchObject({
      id: existing.id,
      serverId: existing.serverId,
      userId: existing.userId,
      deviceId: existing.deviceId,
      deviceToken: existing.deviceToken
    });
    expect(settings.mountedRooms.room_1?.serverId).toBe(existing.id);
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it("discovers and persists only a pinned endpoint with the same server, user, and device identity", async () => {
    const identity = await generateServerIdentity("srv_existing");
    const existing = connection({
      baseUrl: "https://192.168.12.21:8788",
      securityMode: "pinned-tls",
      tlsName: identity.tlsName,
      identityCertificateDer: certPemToDerBase64Url(identity.identityCertPem),
      pinnedIdentitySpkiSha256: identity.identitySpkiSha256
    });
    const startLanDiscovery = vi.fn(() => ({
      result: Promise.resolve([
        { baseUrl: "https://192.168.12.40:8788", address: "192.168.12.40", transport: "https" as const, port: 8788 }
      ]),
      cancel: vi.fn()
    }));
    const { manager, settings, saveSettings } = createManager([existing], {
      startLanDiscovery,
      resolveLanDiscoveryClientInterface: vi.fn().mockResolvedValue("192.168.12.16")
    });
    settings.mountedRooms.room_1 = {
      roomId: "room_1",
      serverId: existing.id,
      mountPath: "Shared",
      files: {}
    };
    vi.spyOn(pinnedTransport, "pinnedRequest").mockResolvedValue({
      status: 200,
      text: "{}",
      json: {
        serverId: existing.serverId,
        user: { id: existing.userId, displayName: existing.userDisplayName },
        device: { id: existing.deviceId, displayName: existing.deviceName },
        isServerOwner: false,
        storageUsageBytes: 0,
        maxStoredContentBytes: 1024,
        teams: []
      }
    });

    const updated = await manager.findServerOnLan(existing.id);

    expect(startLanDiscovery).toHaveBeenCalledWith(existing.serverId, "192.168.12.16");
    expect(updated).toMatchObject({
      id: existing.id,
      baseUrl: "https://192.168.12.40:8788",
      serverId: existing.serverId,
      userId: existing.userId,
      deviceId: existing.deviceId,
      deviceToken: existing.deviceToken
    });
    expect(settings.mountedRooms.room_1?.serverId).toBe(existing.id);
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it("verifies a pinned invite candidate without sending the invite or device token", async () => {
    const identity = await generateServerIdentity("srv_invite");
    const pin = {
      serverId: "srv_invite",
      tlsName: identity.tlsName,
      identityCertificateDer: certPemToDerBase64Url(identity.identityCertPem),
      pinnedIdentitySpkiSha256: identity.identitySpkiSha256
    };
    const startLanDiscovery = vi.fn(() => ({
      result: Promise.resolve([
        { baseUrl: "https://192.168.12.40:8788", address: "192.168.12.40", transport: "https" as const, port: 8788 }
      ]),
      cancel: vi.fn()
    }));
    const request = vi.spyOn(pinnedTransport, "pinnedRequest").mockResolvedValue({
      status: 200,
      text: JSON.stringify({ name: "vault-rooms", version: "0.2.7" }),
      json: { name: "vault-rooms", version: "0.2.7" }
    });
    const { manager, saveSettings } = createManager([], {
      startLanDiscovery,
      resolveLanDiscoveryClientInterface: vi.fn().mockResolvedValue("192.168.12.16")
    });

    await expect(manager.findInviteServerOnLan(pin, "https://old.local:8788")).resolves.toBe(
      "https://192.168.12.40:8788"
    );

    expect(startLanDiscovery).toHaveBeenCalledWith("srv_invite", "192.168.12.16");
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![1]).toMatchObject({ url: "https://192.168.12.40:8788/health" });
    expect(request.mock.calls[0]![1].headers).toBeUndefined();
    expect(request.mock.calls[0]![1].body).toBeUndefined();
    expect(JSON.stringify(request.mock.calls[0])).not.toContain("tr_inv_");
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("does not let remote-address controls rewrite the embedded connection", async () => {
    const embedded = connection({ isServerOwner: true, securityMode: "pinned-tls" });
    const startLanDiscovery = vi.fn();
    const { manager, settings, saveSettings } = createManager([embedded], { startLanDiscovery });
    settings.embeddedServerConnectionId = embedded.id;

    await expect(manager.updateServerAddress(embedded.id, "host-b.local")).rejects.toThrow(/Public URL/i);
    await expect(manager.findServerOnLan(embedded.id)).rejects.toThrow(/Public URL/i);

    expect(startLanDiscovery).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("does not mutate settings when a discovered candidate has another identity", async () => {
    const identity = await generateServerIdentity("srv_existing");
    const existing = connection({
      baseUrl: "https://192.168.12.21:8788",
      securityMode: "pinned-tls",
      tlsName: identity.tlsName,
      identityCertificateDer: certPemToDerBase64Url(identity.identityCertPem),
      pinnedIdentitySpkiSha256: identity.identitySpkiSha256
    });
    const { manager, settings, saveSettings } = createManager([existing], {
      resolveLanDiscoveryClientInterface: vi.fn().mockResolvedValue("192.168.12.16"),
      startLanDiscovery: () => ({
        result: Promise.resolve([
          { baseUrl: "https://192.168.12.40:8788", address: "192.168.12.40", transport: "https", port: 8788 }
        ]),
        cancel: vi.fn()
      })
    });
    vi.spyOn(pinnedTransport, "pinnedRequest").mockResolvedValue({
      status: 200,
      text: "{}",
      json: {
        serverId: "srv_attacker",
        user: { id: existing.userId, displayName: existing.userDisplayName },
        device: { id: existing.deviceId, displayName: existing.deviceName },
        isServerOwner: false,
        teams: []
      }
    });

    await expect(manager.findServerOnLan(existing.id)).rejects.toThrow(/could not verify/i);
    expect(settings.servers).toEqual([existing]);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it.each(["user", "device"] as const)(
    "does not mutate settings when a discovered candidate has another %s identity",
    async (mismatch) => {
      const identity = await generateServerIdentity("srv_existing");
      const existing = connection({
        baseUrl: "https://192.168.12.21:8788",
        securityMode: "pinned-tls",
        tlsName: identity.tlsName,
        identityCertificateDer: certPemToDerBase64Url(identity.identityCertPem),
        pinnedIdentitySpkiSha256: identity.identitySpkiSha256
      });
      const { manager, settings, saveSettings } = createManager([existing], {
        resolveLanDiscoveryClientInterface: vi.fn().mockResolvedValue("192.168.12.16"),
        startLanDiscovery: () => ({
          result: Promise.resolve([
            { baseUrl: "https://192.168.12.40:8788", address: "192.168.12.40", transport: "https", port: 8788 }
          ]),
          cancel: vi.fn()
        })
      });
      vi.spyOn(pinnedTransport, "pinnedRequest").mockResolvedValue({
        status: 200,
        text: "{}",
        json: {
          serverId: existing.serverId,
          user: {
            id: mismatch === "user" ? "usr_other" : existing.userId,
            displayName: existing.userDisplayName
          },
          device: {
            id: mismatch === "device" ? "dev_other" : existing.deviceId,
            displayName: existing.deviceName
          },
          isServerOwner: false,
          teams: []
        }
      });

      await expect(manager.findServerOnLan(existing.id)).rejects.toThrow(/could not verify/i);
      expect(settings.servers).toEqual([existing]);
      expect(saveSettings).not.toHaveBeenCalled();
    }
  );

  it("restores the old endpoint when a discovered address cannot be saved", async () => {
    const identity = await generateServerIdentity("srv_existing");
    const existing = connection({
      baseUrl: "https://192.168.12.21:8788",
      securityMode: "pinned-tls",
      tlsName: identity.tlsName,
      identityCertificateDer: certPemToDerBase64Url(identity.identityCertPem),
      pinnedIdentitySpkiSha256: identity.identitySpkiSha256
    });
    const { manager, settings, saveSettings } = createManager([existing], {
      resolveLanDiscoveryClientInterface: vi.fn().mockResolvedValue("192.168.12.16"),
      startLanDiscovery: () => ({
        result: Promise.resolve([
          { baseUrl: "https://192.168.12.40:8788", address: "192.168.12.40", transport: "https", port: 8788 }
        ]),
        cancel: vi.fn()
      })
    });
    vi.spyOn(pinnedTransport, "pinnedRequest").mockResolvedValue({
      status: 200,
      text: "{}",
      json: {
        serverId: existing.serverId,
        user: { id: existing.userId, displayName: existing.userDisplayName },
        device: { id: existing.deviceId, displayName: existing.deviceName },
        isServerOwner: false,
        teams: []
      }
    });
    saveSettings.mockRejectedValueOnce(new Error("save failed"));

    await expect(manager.findServerOnLan(existing.id)).rejects.toThrow("save failed");
    expect(settings.servers).toEqual([existing]);
  });

  it("keeps legacy HTTP discovery disabled before opening a socket", async () => {
    const existing = connection({ baseUrl: "http://192.168.12.21:8787", securityMode: "plain" });
    const startLanDiscovery = vi.fn();
    const { manager } = createManager([existing], { startLanDiscovery });

    await expect(manager.findServerOnLan(existing.id)).rejects.toThrow(/pinned TLS/i);
    expect(startLanDiscovery).not.toHaveBeenCalled();
  });

  it("rejects an address belonging to another server without mutating settings", async () => {
    const existing = connection({ baseUrl: "http://192.168.12.21:8787" });
    const { manager, settings, saveSettings } = createManager([existing]);
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      headers: {},
      text: "{}",
      json: {
        serverId: "srv_other",
        user: { id: existing.userId, displayName: existing.userDisplayName },
        device: { id: existing.deviceId, displayName: existing.deviceName },
        isServerOwner: false,
        teams: []
      },
      arrayBuffer: new ArrayBuffer(0)
    });

    await expect(manager.updateServerAddress(existing.id, "192.168.12.16")).rejects.toThrow(/different Vault Rooms server/i);
    expect(settings.servers).toEqual([existing]);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("preserves protocol and port when only a stable hostname is entered", () => {
    const existing = connection({ baseUrl: "http://192.168.12.21:8787" });
    expect(normalizeReplacementServerUrl("HuyND.local", existing)).toBe("http://huynd.local:8787");
    expect(() => normalizeReplacementServerUrl("https://HuyND.local:8787", existing)).toThrow(/must keep using http/i);
  });

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

function createManager(servers: ServerConnection[], contextOverrides: Record<string, unknown> = {}) {
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
    renderOpenRoomsViews: vi.fn(),
    ...contextOverrides
  } as never);
  return { manager, settings, saveSettings };
}

function embeddedPin(serverId: string, fingerprint: string) {
  return {
    serverId,
    tlsName: `${serverId}.vault-rooms.internal`,
    identityCertificateDer: `certificate-${serverId}`,
    pinnedIdentitySpkiSha256: fingerprint
  };
}

function embeddedStatus(overrides: Record<string, unknown> = {}) {
  const serverId = typeof overrides.serverId === "string" ? overrides.serverId : "srv_local";
  return {
    running: true,
    host: "0.0.0.0",
    port: 8787,
    localUrl: "https://127.0.0.1:8788",
    lanUrl: "https://huynd.local:8788",
    securityMode: "pinned-tls",
    bootstrapped: true,
    serverId,
    legacyV01BackupAvailable: false,
    securityState: "pinned_tls",
    pinnedInfo: embeddedPin(serverId, `pin-${serverId}`),
    ...overrides
  } as const;
}
