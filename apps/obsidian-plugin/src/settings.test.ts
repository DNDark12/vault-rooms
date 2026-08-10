import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS, isOwnEmbeddedServerConnection, migrateVaultRoomsSettings } from "./settings.js";

describe("embedded owner connection identity", () => {
  const owner = {
    id: "owner",
    baseUrl: "http://127.0.0.1:8787",
    userId: "user",
    userDisplayName: "Owner",
    deviceId: "device",
    deviceName: "Mac",
    deviceToken: "token",
    isServerOwner: true,
    status: "active" as const,
    securityMode: "plain" as const
  };

  it("does not mistake ownership of a remote relay for this computer's embedded server", () => {
    expect(isOwnEmbeddedServerConnection(owner)).toBe(true);
    expect(isOwnEmbeddedServerConnection({ ...owner, baseUrl: "http://192.168.1.20:8787" })).toBe(false);
    expect(isOwnEmbeddedServerConnection({ ...owner, isServerOwner: false })).toBe(false);
  });
});

describe("v0.1 plugin settings migration", () => {
  it("marks one existing loopback owner connection as this device's embedded server", () => {
    const result = migrateVaultRoomsSettings({
      servers: [persistedOwner("dev_local", "https://127.0.0.1:8788")]
    });

    expect(result.settings.embeddedServerConnectionId).toBe("dev_local");
    expect(result.migratedLegacy).toBe(true);
  });

  it("preserves an existing IP or hostname endpoint without inferring remote ownership", () => {
    const ip = persistedOwner("dev_ip", "https://192.168.12.21:8788");
    const hostname = persistedOwner("dev_host", "https://host-b.local:8788");

    const result = migrateVaultRoomsSettings({ servers: [ip, hostname] });

    expect(result.settings.servers.map((server) => server.baseUrl)).toEqual([ip.baseUrl, hostname.baseUrl]);
    expect(result.settings.embeddedServerConnectionId).toBeUndefined();
  });

  it("preserves a valid explicit embedded connection marker", () => {
    const local = persistedOwner("dev_local", "https://host-b.local:8788");

    const result = migrateVaultRoomsSettings({
      servers: [local],
      embeddedServerConnectionId: local.id
    });

    expect(result.settings.embeddedServerConnectionId).toBe(local.id);
  });

  it("leaves an absent CRDT journal absent", () => {
    const result = migrateVaultRoomsSettings({
      servers: [],
      mountedRooms: {
        room_1: { roomId: "room_1", serverId: "server_1", mountPath: "Shared", files: {} }
      }
    } as never);

    expect(result.settings.mountedRooms.room_1).not.toHaveProperty("pendingCrdtOperations");
  });

  it("discards a non-array CRDT journal without dropping the rest of the mounted room", () => {
    const result = migrateVaultRoomsSettings({
      servers: [],
      mountedRooms: {
        room_1: {
          roomId: "room_1",
          serverId: "server_1",
          mountPath: "Shared",
          files: {
            "Kept.md": { serverVersion: 3, serverSha256: "sha", localSha256: "sha", dirty: false }
          },
          pendingCrdtOperations: { operationId: "not-an-array" }
        }
      }
    } as never);

    expect(result.migratedLegacy).toBe(true);
    expect(result.settings.mountedRooms.room_1).toMatchObject({
      roomId: "room_1",
      mountPath: "Shared",
      files: { "Kept.md": expect.objectContaining({ serverVersion: 3 }) },
      pendingCrdtOperations: []
    });
  });

  it("retains valid CRDT journal entries and discards malformed persisted operations", () => {
    const result = migrateVaultRoomsSettings({
      servers: [],
      mountedRooms: {
        room_1: {
          roomId: "room_1",
          serverId: "server_1",
          mountPath: "Shared",
          files: {},
          pendingCrdtOperations: [
            {
              operationId: "op_valid",
              kind: "rename",
              oldRelativePath: "Old.md",
              relativePath: "New.md",
              queuedAt: "2026-08-03T00:00:00.000Z",
              attemptedAt: "2026-08-03T00:00:01.000Z",
              deleteAfterAck: true
            },
            { operationId: "", kind: "create", relativePath: "Bad.md", queuedAt: "today" },
            { operationId: "op_bad_path", kind: "rename", oldRelativePath: "../escape.md", relativePath: "New.md", queuedAt: "today" },
            null
          ]
        }
      }
    } as never);

    expect(result.migratedLegacy).toBe(true);
    expect(result.settings.mountedRooms.room_1?.pendingCrdtOperations).toEqual([
      {
        operationId: "op_valid",
        kind: "rename",
        oldRelativePath: "Old.md",
        relativePath: "New.md",
        queuedAt: "2026-08-03T00:00:00.000Z",
        attemptedAt: "2026-08-03T00:00:01.000Z",
        deleteAfterAck: true
      }
    ]);
  });

  it("sanitizes and deduplicates pending CRDT text paths", () => {
    const result = migrateVaultRoomsSettings({
      mountedRooms: {
        room_1: {
          roomId: "room_1",
          mountPath: "Shared",
          files: {},
          pendingCrdtTextPaths: ["Board.md", "Board.md", "../escape.md", "image.png", 42]
        }
      }
    } as never);

    expect(result.settings.mountedRooms.room_1?.pendingCrdtTextPaths).toEqual(["Board.md"]);
    expect(result.migratedLegacy).toBe(true);
  });

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

    expect(result.migratedLegacy).toBe(true);
    expect(result.settings.embeddedServerConnectionId).toBe("dev_tls");
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

  it("normalizes a corrupted persisted maxStoredContentBytes back to the default and reports a migration (P1 review fix)", () => {
    const result = migrateVaultRoomsSettings({
      server: {
        // A hand-edited or future/older-version data.json can contain anything here - the
        // interactive Settings tab validates on entry, but this path has no such gate.
        maxFileBytes: 123456,
        maxStoredContentBytes: Number.NaN,
        autoStart: true
      }
    });

    expect(result.settings.server).toEqual(
      expect.objectContaining({ maxFileBytes: 123456, maxStoredContentBytes: DEFAULT_SERVER_SETTINGS.maxStoredContentBytes, autoStart: true })
    );
    expect(result.migratedLegacy).toBe(true);
  });

  it("normalizes a positive-but-rounds-to-zero persisted maxStoredContentBytes to the default (re-review fix)", () => {
    // 0.1 is finite and > 0, so it must be checked again *after* rounding: Math.round(0.1) is 0, and
    // a 0-byte cap rejects every content write on the next server start.
    const result = migrateVaultRoomsSettings({ server: { maxFileBytes: 5242880, maxStoredContentBytes: 0.1, autoStart: false } });

    expect(result.settings.server.maxStoredContentBytes).toBe(DEFAULT_SERVER_SETTINGS.maxStoredContentBytes);
    expect(result.migratedLegacy).toBe(true);
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["non-numeric", "268435456" as unknown as number]
  ])("normalizes a %s persisted maxStoredContentBytes to the default", (_label, invalidValue) => {
    const result = migrateVaultRoomsSettings({ server: { maxFileBytes: 5242880, maxStoredContentBytes: invalidValue, autoStart: false } });

    expect(result.settings.server.maxStoredContentBytes).toBe(DEFAULT_SERVER_SETTINGS.maxStoredContentBytes);
    expect(result.migratedLegacy).toBe(true);
  });

  it("leaves a valid persisted maxStoredContentBytes untouched and does not report a migration on its own", () => {
    const result = migrateVaultRoomsSettings({ server: { maxFileBytes: 5242880, maxStoredContentBytes: 1048576, autoStart: false } });

    expect(result.settings.server.maxStoredContentBytes).toBe(1048576);
    expect(result.migratedLegacy).toBe(false);
  });
});

function persistedOwner(id: string, baseUrl: string) {
  return {
    id,
    baseUrl,
    userId: `usr_${id}`,
    userDisplayName: "Owner",
    deviceId: id,
    deviceName: "Mac",
    deviceToken: `token_${id}`,
    isServerOwner: true,
    status: "active" as const,
    securityMode: "pinned-tls" as const,
    serverId: "srv_local",
    pinnedIdentitySpkiSha256: "pin",
    identityCertificateDer: "cert",
    tlsName: "srv-local.vault-rooms.internal",
    appliedRotationIds: []
  };
}
