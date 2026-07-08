import { randomBytes } from "node:crypto";

export type IdPrefix =
  | "team"
  | "usr"
  | "dev"
  | "inv"
  | "room"
  | "cap"
  | "acl"
  | "fil"
  | "ver"
  | "aud"
  | "req";

export function createId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}
