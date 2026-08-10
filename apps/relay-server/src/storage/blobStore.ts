import { createHash } from "node:crypto";

/** Immutable raw bytes addressed by SHA-256 outside SQLite. */
export interface BlobStore {
  /** Stores bytes once and returns their hex SHA-256 key. */
  put(bytes: Uint8Array): Promise<string>;
  /** Returns stored bytes, or undefined when absent. */
  get(key: string): Promise<Uint8Array | undefined>;
  /** Returns whether `key` is currently stored, without reading its bytes. */
  has(key: string): Promise<boolean>;
  /** Removes a blob if present. */
  delete(key: string): Promise<void>;
  /** Lists finalized keys and clears unfinished writes. */
  list(): Promise<string[]>;
}

/** Full lowercase hex SHA-256: exactly 64 hex characters. */
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function isValidBlobKey(key: string): boolean {
  return HEX_SHA256_PATTERN.test(key);
}

/** Hex SHA-256 over raw bytes. */
export function blobKeyForBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Derives `ab/cd/<key>` after validating the key. */
export function shardedRelativePath(key: string): string {
  if (!isValidBlobKey(key)) {
    throw new Error(`Invalid blob store key: ${key}`);
  }
  return `${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`;
}

/** Non-durable store for tests. */
export function createInMemoryBlobStore(): BlobStore {
  const store = new Map<string, Uint8Array>();
  return {
    async put(bytes) {
      const key = blobKeyForBytes(bytes);
      if (!store.has(key)) {
        store.set(key, Uint8Array.from(bytes));
      }
      return key;
    },
    async get(key) {
      const value = store.get(key);
      return value ? Uint8Array.from(value) : undefined;
    },
    async has(key) {
      return store.has(key);
    },
    async delete(key) {
      store.delete(key);
    },
    async list() {
      return [...store.keys()];
    }
  };
}
