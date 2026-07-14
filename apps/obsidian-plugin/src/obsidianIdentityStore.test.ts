import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import type { PersistedIdentity } from "vault-rooms-relay/embedded-core";
import { createObsidianIdentityStore } from "./obsidianIdentityStore.js";

type AdapterMethod = "exists" | "read" | "write" | "mkdir" | "remove" | "rename";

class NoOverwriteDataAdapter implements Pick<DataAdapter, AdapterMethod> {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) {
      throw new Error(`Missing file: ${path}`);
    }
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.folders.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) {
      throw new Error(`Missing file: ${from}`);
    }
    if (this.files.has(to)) {
      throw new Error("Destination file already exists!");
    }
    this.files.set(to, value);
    this.files.delete(from);
  }
}

function persistedIdentity(leafKeyPem: string): PersistedIdentity {
  return {
    serverId: "srv_store",
    identity: {
      identityKeyPem: "identity-key",
      identityCertPem: "identity-cert",
      leafKeyPem,
      leafCertPem: "leaf-cert",
      identitySpkiSha256: "spki",
      tlsName: "srv-store.vault-rooms.internal"
    },
    rotations: []
  };
}

describe("createObsidianIdentityStore", () => {
  it("replaces an existing identity when DataAdapter rename refuses to overwrite its destination", async () => {
    const adapter = new NoOverwriteDataAdapter();
    const store = createObsidianIdentityStore(adapter as unknown as DataAdapter, "plugins/vault-rooms/server-data");
    const first = persistedIdentity("leaf-key-1");
    const second = persistedIdentity("leaf-key-2");

    await store.save(first);
    await store.save(second);

    await expect(store.load()).resolves.toEqual(second);
  });

  it("recovers the previous identity when startup finds an interrupted replacement", async () => {
    const adapter = new NoOverwriteDataAdapter();
    const directory = "plugins/vault-rooms/server-data";
    const identityPath = `${directory}/identity.json`;
    const first = persistedIdentity("leaf-key-1");
    adapter.files.set(`${identityPath}.replace-backup`, `${JSON.stringify(first, null, 2)}\n`);
    const store = createObsidianIdentityStore(adapter as unknown as DataAdapter, directory);

    await expect(store.load()).resolves.toEqual(first);
    expect(adapter.files.has(identityPath)).toBe(true);
    expect(adapter.files.has(`${identityPath}.replace-backup`)).toBe(false);
  });
});
