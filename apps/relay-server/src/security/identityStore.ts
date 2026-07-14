import type { IdentityRotationRecord } from "@vault-rooms/protocol";
import type { ServerIdentity } from "./identity.js";

export type PersistedIdentity = {
  serverId: string;
  identity: ServerIdentity;
  rotations: IdentityRotationRecord[];
};

export type IdentityStore = {
  load(): Promise<PersistedIdentity | null>;
  save(persisted: PersistedIdentity): Promise<void>;
};
