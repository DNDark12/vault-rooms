import { createHash, randomBytes } from "node:crypto";

export type TokenKind = "inv" | "dev";

export function createToken(kind: TokenKind): string {
  return `tr_${kind}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
