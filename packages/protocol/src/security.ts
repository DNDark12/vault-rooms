export type SecurityMode = "plain" | "pinned-tls" | "os-trusted-tls";
export type ServerSecurityState = "plain_legacy" | "pinned_tls" | "tls_migrating" | "tls_enforced";
export type MigrationMode = "non_strict" | "strict";

export type SecurityUpgradeInfo = {
  httpsUrl: string;
  wssUrl: string;
  serverId: string;
  tlsName: string;
  identitySpkiSha256: string;
  identityCertificateDer: string;
  migrationMode: MigrationMode;
  plainDeviceCount?: number;
};

export type IdentityRotationRecord = {
  rotationId: string;
  serverId: string;
  oldIdentitySpkiSha256: string;
  newIdentitySpkiSha256: string;
  newIdentityCertificateDer: string;
  createdAt: string;
  notBefore: string;
  notAfter: string;
  signatureAlgorithm: "ecdsa-p256-sha256";
  canonicalPayload: string;
  signatureByOldIdentity: string;
};
