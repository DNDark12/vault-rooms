import { describe, expect, it } from "vitest";
import { migrateVaultRoomsSettings } from "./settings.js";

describe("v0.1 plugin settings migration", () => {
  it("quarantines malformed server entries without dropping valid connections", () => {
    const valid = {
      id: "dev_valid",
      baseUrl: "http://127.0.0.1:8787",
      userId: "usr_owner",
      userDisplayName: "Owner",
      deviceId: "dev_valid",
      deviceName: "Mac",
      deviceToken: "token",
      isServerOwner: true,
      status: "active" as const
    };
    const missingBaseUrl = { ...valid, id: "dev_invalid", deviceId: "dev_invalid" } as Record<string, unknown>;
    delete missingBaseUrl.baseUrl;

    const result = migrateVaultRoomsSettings({
      servers: [valid, null, 42, missingBaseUrl]
    });

    expect(result.migratedLegacy).toBe(true);
    expect(result.settings.servers).toHaveLength(1);
    expect(result.settings.servers[0]).toEqual(expect.objectContaining({ id: "dev_valid", securityMode: "plain" }));
    expect(result.settings.unrecognizedServers).toEqual([null, 42, missingBaseUrl]);
  });

  it("persists the security defaults added to an exact released v0.1 server entry", () => {
    const result = migrateVaultRoomsSettings({
      servers: [
        {
          id: "dev_release",
          baseUrl: "http://127.0.0.1:8787",
          userId: "usr_owner",
          userDisplayName: "Owner",
          deviceId: "dev_release",
          deviceName: "Mac",
          deviceToken: "release-token",
          isServerOwner: true,
          status: "active"
        }
      ]
    });

    expect(result.migratedLegacy).toBe(true);
    expect(result.settings.servers[0]).toEqual(
      expect.objectContaining({ securityMode: "plain", appliedRotationIds: [] })
    );
  });

  it("preserves credentials, active server, mounts, file state, and embedded settings", () => {
    const result = migrateVaultRoomsSettings({
      servers: [
        {
          id: "dev_owner",
          baseUrl: "http://192.168.1.49:8787",
          teamId: "team_a",
          teamName: "Alpha",
          teamSlug: "alpha",
          userId: "usr_owner",
          userDisplayName: "Owner",
          deviceId: "dev_owner",
          deviceName: "Mac",
          deviceToken: "tr_dev_secret",
          status: "active",
          role: "owner"
        }
      ],
      activeServerId: "dev_owner",
      mountRoot: "Shared Vaults",
      debounceMs: 900,
      mountedRooms: {
        room_a: {
          roomId: "room_a",
          mountPath: "Shared/Docs",
          files: {
            "note.md": {
              serverVersion: 7,
              serverSha256: "server-sha",
              localSha256: "local-sha",
              dirty: true
            }
          }
        }
      },
      roomMountPaths: { room_a: "Custom/Docs" },
      server: {
        port: 9876,
        maxFileBytes: 123456,
        autoStart: true,
        publicUrlOverride: "192.168.1.49"
      }
    });

    expect(result.migratedLegacy).toBe(true);
    expect(result.settings.servers).toEqual([
      expect.objectContaining({
        id: "dev_owner",
        baseUrl: "http://192.168.1.49:8787",
        userId: "usr_owner",
        userDisplayName: "Owner",
        deviceId: "dev_owner",
        deviceName: "Mac",
        deviceToken: "tr_dev_secret",
        status: "active",
        isServerOwner: true,
        securityMode: "plain",
        appliedRotationIds: []
      })
    ]);
    expect(result.settings.servers[0]).not.toHaveProperty("teamId");
    expect(result.settings.activeServerId).toBe("dev_owner");
    expect(result.settings.mountRoot).toBe("Shared Vaults");
    expect(result.settings.debounceMs).toBe(900);
    expect(result.settings.mountedRooms.room_a).toEqual({
      roomId: "room_a",
      serverId: "dev_owner",
      mountPath: "Shared/Docs",
      files: {
        "note.md": {
          serverVersion: 7,
          serverSha256: "server-sha",
          localSha256: "local-sha",
          dirty: true
        }
      }
    });
    expect(result.settings.roomMountPaths).toEqual({ room_a: "Custom/Docs" });
    expect(result.settings.server).toEqual(expect.objectContaining({ port: 9876, maxFileBytes: 123456, autoStart: true }));
  });

  it("leaves current TLS settings and applied rotation IDs intact", () => {
    const result = migrateVaultRoomsSettings({
      servers: [
        {
          id: "dev_tls",
          baseUrl: "https://127.0.0.1:8788",
          userId: "usr_owner",
          userDisplayName: "Owner",
          deviceId: "dev_tls",
          deviceName: "Mac",
          deviceToken: "tls-token",
          isServerOwner: true,
          status: "active",
          securityMode: "pinned-tls",
          pinnedIdentitySpkiSha256: "pin",
          identityCertificateDer: "cert",
          tlsName: "srv-test.vault-rooms.internal",
          appliedRotationIds: ["rot_1"]
        }
      ]
    });

    expect(result.migratedLegacy).toBe(false);
    expect(result.settings.servers[0]).toEqual(expect.objectContaining({
      securityMode: "pinned-tls",
      pinnedIdentitySpkiSha256: "pin",
      appliedRotationIds: ["rot_1"]
    }));
  });

  it("preserves current TLS identity and rotation fields on a team-scoped legacy entry", () => {
    const result = migrateVaultRoomsSettings({
      servers: [
        {
          id: "dev_tls_legacy",
          baseUrl: "https://127.0.0.1:8788",
          teamId: "team_old",
          role: "owner",
          userId: "usr_owner",
          userDisplayName: "Owner",
          deviceId: "dev_tls_legacy",
          deviceName: "Mac",
          deviceToken: "tls-token",
          status: "active",
          securityMode: "pinned-tls",
          serverId: "srv_stable",
          pinnedIdentitySpkiSha256: "sha256:pin",
          identityCertificateDer: "certificate",
          tlsName: "srv-stable.vault-rooms.internal",
          appliedRotationIds: ["rot_1"]
        }
      ]
    });

    expect(result.settings.servers[0]).toEqual(expect.objectContaining({
      isServerOwner: true,
      securityMode: "pinned-tls",
      serverId: "srv_stable",
      pinnedIdentitySpkiSha256: "sha256:pin",
      identityCertificateDer: "certificate",
      tlsName: "srv-stable.vault-rooms.internal",
      appliedRotationIds: ["rot_1"]
    }));
    expect(result.settings.servers[0]).not.toHaveProperty("teamId");
    expect(result.settings.servers[0]).not.toHaveProperty("role");
  });

  it("preserves but pauses a legacy mount when multiple old server entries make ownership ambiguous", () => {
    const legacy = (id: string, teamId: string) => ({
      id,
      baseUrl: `http://relay-${id}.example`,
      teamId,
      teamName: teamId,
      teamSlug: teamId,
      userId: `usr_${id}`,
      userDisplayName: id,
      deviceId: id,
      deviceName: id,
      deviceToken: `token_${id}`,
      status: "active" as const,
      role: "owner" as const
    });
    const result = migrateVaultRoomsSettings({
      servers: [legacy("dev_a", "team_a"), legacy("dev_b", "team_b")],
      activeServerId: "dev_a",
      mountedRooms: {
        room_unknown: { roomId: "room_unknown", mountPath: "Vault Rooms/Unknown", files: {} }
      }
    });

    const migratedRoom = result.settings.mountedRooms.room_unknown;
    expect(migratedRoom).toBeDefined();
    expect(migratedRoom).not.toHaveProperty("serverId");
    expect(migratedRoom?.mountPath).toBe("Vault Rooms/Unknown");
  });
});
