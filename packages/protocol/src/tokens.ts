import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type TokenKind = "inv" | "dev";

export function createToken(kind: TokenKind): string {
  return `tr_${kind}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type InviteAcceptanceProofBinding = {
  deviceId: string;
  serverId: string;
  inviteToken: string;
  identitySpkiSha256: string;
};

export function createInviteAcceptanceProof(deviceToken: string, binding: InviteAcceptanceProofBinding): string {
  return createInviteAcceptanceProofForTokenHash(hashToken(deviceToken), binding);
}

export function verifyInviteAcceptanceProof(
  deviceToken: string,
  proof: string,
  binding: InviteAcceptanceProofBinding
): boolean {
  return verifyInviteAcceptanceProofForTokenHash(hashToken(deviceToken), proof, binding);
}

export function verifyInviteAcceptanceProofForTokenHash(
  deviceTokenHash: string,
  proof: string,
  binding: InviteAcceptanceProofBinding
): boolean {
  const expected = Buffer.from(createInviteAcceptanceProofForTokenHash(deviceTokenHash, binding), "base64url");
  const presented = Buffer.from(proof, "base64url");
  return expected.byteLength === presented.byteLength && timingSafeEqual(expected, presented);
}

function createInviteAcceptanceProofForTokenHash(
  deviceTokenHash: string,
  binding: InviteAcceptanceProofBinding
): string {
  const message = JSON.stringify([
    "vault-rooms:strict-invite-accept:v1",
    binding.deviceId,
    binding.serverId,
    binding.inviteToken,
    binding.identitySpkiSha256
  ]);
  return createHmac("sha256", Buffer.from(deviceTokenHash, "hex")).update(message).digest("base64url");
}
