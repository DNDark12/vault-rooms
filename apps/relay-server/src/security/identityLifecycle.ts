import "reflect-metadata";
import { AppError } from "@vault-rooms/protocol";
import * as x509 from "@peculiar/x509";
import { generateServerIdentity, issueLeafCertificate } from "./identity.js";
import type { IdentityStore, PersistedIdentity } from "./identityStore.js";
import { createRotationRecord } from "./rotation.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export async function ensureServerIdentity(input: {
  serverId: string;
  store: IdentityStore;
  now?: Date;
  renewLeafWithinDays?: number;
}): Promise<PersistedIdentity> {
  const persisted = await input.store.load();
  if (!persisted) {
    const created = {
      serverId: input.serverId,
      identity: await generateServerIdentity(input.serverId, input.now),
      rotations: []
    } satisfies PersistedIdentity;
    await input.store.save(created);
    return created;
  }
  if (persisted.serverId !== input.serverId) {
    throw new AppError("VALIDATION_ERROR", "Stored TLS identity belongs to a different server.", 400);
  }

  const now = input.now ?? new Date();
  const renewBefore = new Date(now.getTime() + (input.renewLeafWithinDays ?? 30) * DAY_MS);
  const leafCertificate = new x509.X509Certificate(persisted.identity.leafCertPem);
  if (leafCertificate.notAfter > renewBefore) {
    return persisted;
  }

  const leaf = await issueLeafCertificate(persisted.identity, persisted.identity.tlsName, now);
  const renewed: PersistedIdentity = {
    ...persisted,
    identity: {
      ...persisted.identity,
      ...leaf
    }
  };
  await input.store.save(renewed);
  return renewed;
}

export async function rotateServerIdentity(input: {
  persisted: PersistedIdentity;
  store: IdentityStore;
  now?: Date;
}): Promise<PersistedIdentity> {
  const newIdentity = await generateServerIdentity(input.persisted.serverId, input.now);
  const record = await createRotationRecord({
    serverId: input.persisted.serverId,
    oldIdentity: input.persisted.identity,
    newIdentity,
    now: input.now
  });
  const rotated: PersistedIdentity = {
    serverId: input.persisted.serverId,
    identity: newIdentity,
    rotations: [...input.persisted.rotations, record]
  };
  await input.store.save(rotated);
  return rotated;
}
