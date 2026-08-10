import type { DataAdapter } from "obsidian";
import { blobKeyForBytes, isValidBlobKey, shardedRelativePath, type BlobStore } from "vault-rooms-relay/embedded-core";
import {
  createDataAdapterFile,
  recoverDataAdapterFileReplacement
} from "./dataAdapterFileReplace.js";

/** Embedded immutable blob store backed by Obsidian's DataAdapter. */
export function createDataAdapterBlobStore(adapter: DataAdapter, rootDir: string): BlobStore {
  function pathFor(key: string): string {
    return `${rootDir}/${shardedRelativePath(key)}`;
  }

  async function ensureParentFolder(path: string): Promise<void> {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) {
      return;
    }
    const parts = path.slice(0, slash).split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) {
        await adapter.mkdir(current);
      }
    }
  }

  return {
    async put(bytes: Uint8Array): Promise<string> {
      const key = blobKeyForBytes(bytes);
      const finalPath = pathFor(key);
      await recoverDataAdapterFileReplacement(adapter, finalPath);
      if (await adapter.exists(finalPath)) {
        return key;
      }
      await ensureParentFolder(finalPath);
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      await createDataAdapterFile(adapter, finalPath, async (temporaryPath) => {
        await adapter.writeBinary(temporaryPath, buffer);
      });
      return key;
    },

    async get(key: string): Promise<Uint8Array | undefined> {
      if (!isValidBlobKey(key)) {
        return undefined;
      }
      const path = pathFor(key);
      await recoverDataAdapterFileReplacement(adapter, path);
      if (!(await adapter.exists(path))) {
        return undefined;
      }
      return new Uint8Array(await adapter.readBinary(path));
    },

    async has(key: string): Promise<boolean> {
      if (!isValidBlobKey(key)) {
        return false;
      }
      return adapter.exists(pathFor(key));
    },

    async delete(key: string): Promise<void> {
      if (!isValidBlobKey(key)) {
        return;
      }
      const path = pathFor(key);
      if (await adapter.exists(path)) {
        await adapter.remove(path);
      }
      const temporaryPath = `${path}.create-tmp`;
      if (await adapter.exists(temporaryPath)) {
        await adapter.remove(temporaryPath).catch(() => undefined);
      }
    },

    async list(): Promise<string[]> {
      const keys: string[] = [];
      if (!(await adapter.exists(rootDir))) {
        return keys;
      }
      const level1Listing = await adapter.list(rootDir);
      for (const level1Folder of level1Listing.folders) {
        const level2Listing = await adapter.list(level1Folder);
        for (const level2Folder of level2Listing.folders) {
          const fileListing = await adapter.list(level2Folder);
          for (const file of fileListing.files) {
            const name = file.slice(file.lastIndexOf("/") + 1);
            if (isValidBlobKey(name)) {
              keys.push(name);
            } else if (/^[0-9a-f]{64}\.create-tmp$/.test(name)) {
              await adapter.remove(file);
            }
          }
        }
      }
      return keys;
    }
  };
}
