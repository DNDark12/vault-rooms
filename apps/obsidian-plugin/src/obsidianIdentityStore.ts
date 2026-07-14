import { normalizePath, type DataAdapter } from "obsidian";
import type { IdentityStore, PersistedIdentity } from "vault-rooms-relay/embedded-core";
import { recoverDataAdapterFileReplacement, replaceDataAdapterFile } from "./dataAdapterFileReplace.js";

async function ensureFolder(adapter: DataAdapter, directory: string): Promise<void> {
  const parts = normalizePath(directory).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) {
      await adapter.mkdir(current);
    }
  }
}

export function createObsidianIdentityStore(adapter: DataAdapter, pluginServerDataDirectory: string): IdentityStore {
  const directory = normalizePath(pluginServerDataDirectory);
  const identityPath = `${directory}/identity.json`;

  return {
    async load() {
      await recoverDataAdapterFileReplacement(adapter, identityPath);
      if (!(await adapter.exists(identityPath))) {
        return null;
      }
      return JSON.parse(await adapter.read(identityPath)) as PersistedIdentity;
    },
    async save(persisted) {
      await ensureFolder(adapter, directory);
      await replaceDataAdapterFile(adapter, identityPath, async (path) => {
        await adapter.write(path, `${JSON.stringify(persisted, null, 2)}\n`);
      });
    }
  };
}
