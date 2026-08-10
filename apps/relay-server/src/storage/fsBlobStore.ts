import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { blobKeyForBytes, isValidBlobKey, shardedRelativePath, type BlobStore } from "./blobStore.js";

/** Standalone store using atomic same-filesystem rename. */
export function createFsBlobStore(rootDir: string): BlobStore {
  function pathFor(key: string): string {
    return join(rootDir, shardedRelativePath(key));
  }

  return {
    async put(bytes: Uint8Array): Promise<string> {
      const key = blobKeyForBytes(bytes);
      const finalPath = pathFor(key);
      if (existsSync(finalPath)) {
        return key;
      }
      mkdirSync(dirname(finalPath), { recursive: true });
      const temporaryPath = `${finalPath}.tmp-${randomUUID()}`;
      try {
        writeFileSync(temporaryPath, bytes);
        // Concurrent writes for this key contain identical bytes.
        renameSync(temporaryPath, finalPath);
      } catch (error) {
        rmSync(temporaryPath, { force: true });
        throw error;
      }
      return key;
    },

    async get(key: string): Promise<Uint8Array | undefined> {
      if (!isValidBlobKey(key)) {
        return undefined;
      }
      const path = pathFor(key);
      if (!existsSync(path)) {
        return undefined;
      }
      return new Uint8Array(readFileSync(path));
    },

    async has(key: string): Promise<boolean> {
      if (!isValidBlobKey(key)) {
        return false;
      }
      return existsSync(pathFor(key));
    },

    async delete(key: string): Promise<void> {
      if (!isValidBlobKey(key)) {
        return;
      }
      rmSync(pathFor(key), { force: true });
    },

    async list(): Promise<string[]> {
      if (!existsSync(rootDir)) {
        return [];
      }
      const keys: string[] = [];
      for (const level1 of readdirSync(rootDir, { withFileTypes: true })) {
        if (!level1.isDirectory()) continue;
        const level1Path = join(rootDir, level1.name);
        for (const level2 of readdirSync(level1Path, { withFileTypes: true })) {
          if (!level2.isDirectory()) continue;
          const level2Path = join(level1Path, level2.name);
          for (const entry of readdirSync(level2Path, { withFileTypes: true })) {
            if (entry.isFile() && isValidBlobKey(entry.name)) {
              keys.push(entry.name);
            } else if (entry.isFile() && /^[0-9a-f]{64}\.tmp-.+$/.test(entry.name)) {
              rmSync(join(level2Path, entry.name), { force: true });
            }
          }
        }
      }
      return keys;
    }
  };
}
