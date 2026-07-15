import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { AppError, createId, type IdentityRotationRecord } from "@vault-rooms/protocol";
import * as x509 from "@peculiar/x509";
import {
  certPemToDerBase64Url,
  spkiSha256FromCertDer,
  spkiSha256FromCertPem,
  type ServerIdentity
} from "./identity.js";

const ECDSA_KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_SIGNING_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;

function validationError(message: string): AppError {
  return new AppError("VALIDATION_ERROR", message, 400);
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return webcrypto.subtle.importKey(
    "pkcs8",
    x509.PemConverter.decodeFirst(pem),
    ECDSA_KEY_ALGORITHM,
    false,
    ["sign"]
  );
}

export function rotationCanonicalPayload(
  record: Pick<
    IdentityRotationRecord,
    | "serverId"
    | "oldIdentitySpkiSha256"
    | "newIdentitySpkiSha256"
    | "newIdentityCertificateDer"
    | "notBefore"
    | "notAfter"
    | "rotationId"
  >
): string {
  return JSON.stringify({
    serverId: record.serverId,
    oldIdentitySpkiSha256: record.oldIdentitySpkiSha256,
    newIdentitySpkiSha256: record.newIdentitySpkiSha256,
    newIdentityCertificateDer: record.newIdentityCertificateDer,
    notBefore: record.notBefore,
    notAfter: record.notAfter,
    rotationId: record.rotationId
  });
}

export async function createRotationRecord(input: {
  serverId: string;
  oldIdentity: ServerIdentity;
  newIdentity: ServerIdentity;
  validityDays?: number;
  now?: Date;
}): Promise<IdentityRotationRecord> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.validityDays ?? 30) * 24 * 60 * 60 * 1_000);
  const unsigned: Omit<IdentityRotationRecord, "canonicalPayload" | "signatureByOldIdentity"> = {
    rotationId: createId("rot"),
    serverId: input.serverId,
    oldIdentitySpkiSha256: input.oldIdentity.identitySpkiSha256,
    newIdentitySpkiSha256: input.newIdentity.identitySpkiSha256,
    newIdentityCertificateDer: certPemToDerBase64Url(input.newIdentity.identityCertPem),
    createdAt: now.toISOString(),
    notBefore: now.toISOString(),
    notAfter: expiresAt.toISOString(),
    signatureAlgorithm: "ecdsa-p256-sha256"
  };
  const canonicalPayload = rotationCanonicalPayload(unsigned);
  const privateKey = await importPrivateKey(input.oldIdentity.identityKeyPem);
  const signature = await webcrypto.subtle.sign(
    ECDSA_SIGNING_ALGORITHM,
    privateKey,
    Buffer.from(canonicalPayload, "utf8")
  );

  return {
    ...unsigned,
    canonicalPayload,
    signatureByOldIdentity: Buffer.from(signature).toString("base64url")
  };
}

export async function verifyRotationRecord(
  record: IdentityRotationRecord,
  expectedOldSpkiSha256: string,
  oldIdentityCertificateDer: string,
  appliedRotationIds: ReadonlySet<string>,
  now = new Date()
): Promise<void> {
  try {
    if (record.signatureAlgorithm !== "ecdsa-p256-sha256") {
      throw validationError("Unsupported identity rotation signature algorithm.");
    }

    const oldCertificate = new x509.X509Certificate(Buffer.from(oldIdentityCertificateDer, "base64url"));
    const storedCertificateSpki = spkiSha256FromCertPem(oldCertificate.toString("pem"));
    if (storedCertificateSpki !== expectedOldSpkiSha256 || record.oldIdentitySpkiSha256 !== expectedOldSpkiSha256) {
      throw validationError("Identity rotation does not match the pinned identity.");
    }

    const canonicalPayload = rotationCanonicalPayload(record);
    if (record.canonicalPayload !== canonicalPayload) {
      throw validationError("Identity rotation payload is not canonical.");
    }

    const publicKey = await oldCertificate.publicKey.export(ECDSA_KEY_ALGORITHM, ["verify"]);
    const valid = await webcrypto.subtle.verify(
      ECDSA_SIGNING_ALGORITHM,
      publicKey,
      Buffer.from(record.signatureByOldIdentity, "base64url"),
      Buffer.from(canonicalPayload, "utf8")
    );
    if (!valid) {
      throw validationError("Identity rotation signature is invalid.");
    }

    const notBefore = new Date(record.notBefore);
    const notAfter = new Date(record.notAfter);
    if (!Number.isFinite(notBefore.getTime()) || !Number.isFinite(notAfter.getTime()) || now < notBefore || now > notAfter) {
      throw validationError("Identity rotation is outside its validity window.");
    }
    if (appliedRotationIds.has(record.rotationId)) {
      throw validationError("Identity rotation has already been applied.");
    }
    if (spkiSha256FromCertDer(record.newIdentityCertificateDer) !== record.newIdentitySpkiSha256) {
      throw validationError("Identity rotation certificate does not match its fingerprint.");
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw validationError(error instanceof Error ? error.message : String(error));
  }
}
