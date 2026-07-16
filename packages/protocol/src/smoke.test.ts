import { describe, expect, it } from "vitest";
import {
  AppError,
  createInviteAcceptanceProof,
  createId,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  type IdentityRotationRecord,
  type SecurityUpgradeInfo,
  verifyInviteAcceptanceProof
} from "./index.js";

describe("protocol metadata", () => {
  it("uses the v0.2 product identity", () => {
    expect(PRODUCT_NAME).toBe("vault-rooms");
    expect(PRODUCT_VERSION).toBe("0.2.1");
  });

  it("exposes the TLS security protocol contract", () => {
    const upgradeInfo: SecurityUpgradeInfo = {
      httpsUrl: "https://127.0.0.1:8788",
      wssUrl: "wss://127.0.0.1:8788/sync",
      serverId: "srv_test",
      tlsName: "srv-test.vault-rooms.internal",
      identitySpkiSha256: "identity-pin",
      identityCertificateDer: "identity-cert",
      migrationMode: "non_strict"
    };
    const rotation: IdentityRotationRecord = {
      rotationId: "rot_test",
      serverId: upgradeInfo.serverId,
      oldIdentitySpkiSha256: "old-pin",
      newIdentitySpkiSha256: "new-pin",
      newIdentityCertificateDer: "new-cert",
      createdAt: "2026-07-13T00:00:00.000Z",
      notBefore: "2026-07-13T00:00:00.000Z",
      notAfter: "2026-07-14T00:00:00.000Z",
      signatureAlgorithm: "ecdsa-p256-sha256",
      canonicalPayload: "{}",
      signatureByOldIdentity: "signature"
    };

    expect(upgradeInfo.migrationMode).toBe("non_strict");
    expect(rotation.rotationId).toBe("rot_test");
    expect(createId("srv")).toMatch(/^srv_/);
    expect(new AppError("TLS_REQUIRED", "x", 426).code).toBe("TLS_REQUIRED");
  });

  it("binds strict invite acceptance proof to the exact invite and pinned identity", () => {
    const binding = {
      deviceId: "dev_1",
      serverId: "srv_1",
      inviteToken: "tr_inv_one",
      identitySpkiSha256: "sha256:identity-one"
    };
    const proof = createInviteAcceptanceProof("tr_dev_secret", binding);

    expect(verifyInviteAcceptanceProof("tr_dev_secret", proof, binding)).toBe(true);
    expect(verifyInviteAcceptanceProof("tr_dev_secret", proof, { ...binding, inviteToken: "tr_inv_other" })).toBe(false);
    expect(verifyInviteAcceptanceProof("tr_dev_secret", proof, { ...binding, identitySpkiSha256: "sha256:attacker" })).toBe(false);
  });
});
