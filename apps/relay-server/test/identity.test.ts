import "reflect-metadata";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as x509 from "@peculiar/x509";
import { afterEach, describe, expect, it } from "vitest";
import { createFsIdentityStore } from "../src/security/fsIdentityStore.js";
import { openRelayDb } from "../src/db/db.js";
import { openSqlJsDb } from "../src/db/sqlJsAdapter.js";
import { createRelayCore } from "../src/relayCore.js";
import {
  certPemToDerBase64Url,
  generateServerIdentity,
  spkiSha256FromCertDer,
  spkiSha256FromCertPem
} from "../src/security/identity.js";
import {
  ensureServerIdentity,
  resolveServerIdForIdentityStore,
  rotateServerIdentity
} from "../src/security/identityLifecycle.js";
import { createRotationRecord, rotationCanonicalPayload, verifyRotationRecord } from "../src/security/rotation.js";
import { LEGACY_V01_SCHEMA, seedLegacyV01Data } from "./fixtures/legacyV01.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vault-rooms-identity-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("server TLS identity", () => {
  it("generates a stable pinnable identity", async () => {
    const identity = await generateServerIdentity("srv_test1");

    expect(identity.tlsName).toBe("srv-test1.vault-rooms.internal");
    expect(spkiSha256FromCertPem(identity.identityCertPem)).toBe(identity.identitySpkiSha256);
    expect(spkiSha256FromCertPem(identity.leafCertPem)).not.toBe(identity.identitySpkiSha256);
  });

  it("preserves the SPKI hash through a DER round-trip", async () => {
    const identity = await generateServerIdentity("srv_test2");
    const der = certPemToDerBase64Url(identity.identityCertPem);

    expect(spkiSha256FromCertDer(der)).toBe(identity.identitySpkiSha256);
  });

  it("accepts a rotation signed by the old identity and rejects invalid records", async () => {
    const oldIdentity = await generateServerIdentity("srv_r");
    const newIdentity = await generateServerIdentity("srv_r");
    const record = await createRotationRecord({ serverId: "srv_r", oldIdentity, newIdentity });
    const oldCertificateDer = certPemToDerBase64Url(oldIdentity.identityCertPem);

    await expect(
      verifyRotationRecord(record, oldIdentity.identitySpkiSha256, oldCertificateDer, new Set())
    ).resolves.toBeUndefined();
    await expect(
      verifyRotationRecord(record, newIdentity.identitySpkiSha256, oldCertificateDer, new Set())
    ).rejects.toThrow();
    await expect(
      verifyRotationRecord(record, oldIdentity.identitySpkiSha256, oldCertificateDer, new Set([record.rotationId]))
    ).rejects.toThrow();
    await expect(
      verifyRotationRecord(
        { ...record, signatureByOldIdentity: `${record.signatureByOldIdentity.slice(0, -4)}AAAA` },
        oldIdentity.identitySpkiSha256,
        oldCertificateDer,
        new Set()
      )
    ).rejects.toThrow();
    await expect(
      verifyRotationRecord(
        { ...record, notAfter: new Date(Date.now() - 1_000).toISOString() },
        oldIdentity.identitySpkiSha256,
        oldCertificateDer,
        new Set()
      )
    ).rejects.toThrow();
    await expect(
      verifyRotationRecord(
        { ...record, newIdentityCertificateDer: certPemToDerBase64Url(oldIdentity.identityCertPem) },
        oldIdentity.identitySpkiSha256,
        oldCertificateDer,
        new Set()
      )
    ).rejects.toThrow();

    const malformedCertificate = {
      ...record,
      newIdentityCertificateDer: "not-a-certificate"
    };
    malformedCertificate.canonicalPayload = rotationCanonicalPayload(malformedCertificate);
    await expect(
      verifyRotationRecord(
        malformedCertificate,
        oldIdentity.identitySpkiSha256,
        oldCertificateDer,
        new Set()
      )
    ).rejects.toThrow("signature is invalid");
  });
});

describe("server identity persistence", () => {
  it("seeds a recovered v0.1 database from the existing standalone identity before generating an ID", async () => {
    const directory = await createTemporaryDirectory();
    const dbPath = join(directory, "relay.sqlite");
    const stableServerId = "srv_standalone_recovery";
    const active = await openRelayDb(dbPath);
    createRelayCore(active).repo.setServerIdIfMissing(stableServerId);
    await active.close();
    const store = createFsIdentityStore(directory);
    const persisted = {
      serverId: stableServerId,
      identity: await generateServerIdentity(stableServerId),
      rotations: []
    };
    await store.save(persisted);
    const backup = await openSqlJsDb(`${dbPath}.bak-v1`);
    backup.exec(LEGACY_V01_SCHEMA);
    seedLegacyV01Data(backup);
    await backup.close();

    const recovered = await openRelayDb(dbPath);
    const repo = createRelayCore(recovered).repo;
    expect(repo.getServerId()).toBeNull();
    expect(await resolveServerIdForIdentityStore(repo, store)).toBe(stableServerId);
    expect(repo.getServerId()).toBe(stableServerId);
    expect(await ensureServerIdentity({ serverId: stableServerId, store })).toEqual(persisted);
    await recovered.close();
  });

  it("saves and loads atomically with private material restricted to mode 0600", async () => {
    const directory = await createTemporaryDirectory();
    const store = createFsIdentityStore(directory);
    expect(await store.load()).toBeNull();

    const identity = await generateServerIdentity("srv_store");
    const persisted = { serverId: "srv_store", identity, rotations: [] };
    await store.save(persisted);
    expect(await store.load()).toEqual(persisted);

    const identityPath = join(directory, "identity.json");
    await chmod(identityPath, 0o666);
    await store.save(persisted);
    expect((await stat(identityPath)).mode & 0o777).toBe(0o600);
  });

  it("does not follow a pre-created temporary-file symlink while saving private material", async () => {
    const directory = await createTemporaryDirectory();
    const outsidePath = join(directory, "outside.txt");
    await writeFile(outsidePath, "sentinel", "utf8");
    await symlink(outsidePath, join(directory, "identity.json.tmp"));
    const store = createFsIdentityStore(directory);
    const identity = await generateServerIdentity("srv_symlink");

    await store.save({ serverId: "srv_symlink", identity, rotations: [] });

    expect(await readFile(outsidePath, "utf8")).toBe("sentinel");
    expect((await store.load())?.identity.identitySpkiSha256).toBe(identity.identitySpkiSha256);
  });

  it("keeps the identity stable across reloads", async () => {
    const store = createFsIdentityStore(await createTemporaryDirectory());
    const first = await ensureServerIdentity({ serverId: "srv_stable", store });
    const second = await ensureServerIdentity({ serverId: "srv_stable", store });

    expect(second).toEqual(first);
  });

  it("renews only a leaf that is within the renewal window", async () => {
    const store = createFsIdentityStore(await createTemporaryDirectory());
    const first = await ensureServerIdentity({ serverId: "srv_renew", store });
    const leafExpiry = new x509.X509Certificate(first.identity.leafCertPem).notAfter;
    const nearExpiry = new Date(leafExpiry.getTime() - 10 * 24 * 60 * 60 * 1_000);

    const renewed = await ensureServerIdentity({ serverId: "srv_renew", store, now: nearExpiry });

    expect(renewed.identity.identitySpkiSha256).toBe(first.identity.identitySpkiSha256);
    expect(renewed.identity.identityKeyPem).toBe(first.identity.identityKeyPem);
    expect(renewed.identity.identityCertPem).toBe(first.identity.identityCertPem);
    expect(renewed.identity.leafCertPem).not.toBe(first.identity.leafCertPem);

    const stableAtSameTime = await ensureServerIdentity({ serverId: "srv_renew", store, now: nearExpiry });
    expect(stableAtSameTime.identity.leafCertPem).toBe(renewed.identity.leafCertPem);
  });

  it("persists a verifiable planned rotation with the new active identity", async () => {
    const store = createFsIdentityStore(await createTemporaryDirectory());
    const original = await ensureServerIdentity({ serverId: "srv_rotate", store });
    const rotated = await rotateServerIdentity({ persisted: original, store });
    const reloaded = await store.load();

    expect(rotated.serverId).toBe(original.serverId);
    expect(rotated.identity.identitySpkiSha256).not.toBe(original.identity.identitySpkiSha256);
    expect(rotated.rotations).toHaveLength(1);
    expect(reloaded).toEqual(rotated);
    await expect(
      verifyRotationRecord(
        rotated.rotations[0]!,
        original.identity.identitySpkiSha256,
        certPemToDerBase64Url(original.identity.identityCertPem),
        new Set()
      )
    ).resolves.toBeUndefined();
  });

  it("uses the injected clock for rotated certificates and continuity timestamps", async () => {
    const store = createFsIdentityStore(await createTemporaryDirectory());
    const original = await ensureServerIdentity({ serverId: "srv_clock", store });
    const now = new Date("2030-01-02T03:04:05.000Z");

    const rotated = await rotateServerIdentity({ persisted: original, store, now });

    expect(rotated.rotations.at(-1)).toMatchObject({
      createdAt: now.toISOString(),
      notBefore: now.toISOString()
    });
    expect(new x509.X509Certificate(rotated.identity.leafCertPem).notAfter.getTime()).toBeGreaterThan(now.getTime());
  });
});
