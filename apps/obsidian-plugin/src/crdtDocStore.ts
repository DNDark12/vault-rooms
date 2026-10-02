import type { DataAdapter } from "obsidian";
import { recoverDataAdapterFileReplacement, replaceDataAdapterFile } from "./dataAdapterFileReplace.js";

type RoomCacheAccess = {
  tail: Promise<void>;
  failedRetirement?: () => Promise<unknown>;
};
/** Deliberately shared volatile ownership: Obsidian unload cannot await final writes, and plugin
 * reload evaluates a new module while the old one may still own the same adapter/cache directory.
 * Anchor the private registry to the public vault adapter so different window globals also share
 * ownership. Keep failed final saves available to the next instance; this is not crash durability. */
const CACHE_ACCESS_KEY = Symbol.for("vault-rooms.crdt-cache-access.v1");
type CacheAccessAdapter = DataAdapter & { readonly [CACHE_ACCESS_KEY]?: Map<string, RoomCacheAccess> };

export type CrdtRoomAccessOptions = { retainFailure?: boolean };

/** Per-doc quota (contracts 1.7/1.12) - the client should never accumulate more local persisted
 *  state for one document than the server would ever hold for it. */
export const MAX_PERSISTED_CRDT_DOC_BYTES = 4 * 1024 * 1024;

export class CrdtDocStoreQuotaExceededError extends Error {
  constructor(byteLength: number) {
    super(`Encoded CRDT document is ${byteLength} bytes, exceeding the ${MAX_PERSISTED_CRDT_DOC_BYTES}-byte per-doc quota.`);
    this.name = "CrdtDocStoreQuotaExceededError";
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sanitizeSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized || "_";
}

/** Persists full Yjs state by room, path, and epoch in plugin-private storage. */
export class CrdtDocStore {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly baseDir: string
  ) {}

  private roomDir(roomId: string): string {
    return `${this.baseDir}/${sanitizeSegment(roomId)}`;
  }

  /** Register ownership synchronously, before any await. Call store methods directly inside the
   * callback: recursively acquiring this queue for the same room would wait on itself. */
  withRoomAccess<T>(roomId: string, operation: () => Promise<T>, options: CrdtRoomAccessOptions = {}): Promise<T> {
    const adapter = this.adapter as CacheAccessAdapter;
    let rooms = adapter[CACHE_ACCESS_KEY];
    if (!rooms) {
      rooms = new Map();
      Object.defineProperty(adapter, CACHE_ACCESS_KEY, { value: rooms });
    }
    const directory = this.roomDir(roomId);
    const access = rooms.get(directory) ?? { tail: Promise.resolve() };
    rooms.set(directory, access);
    const running = access.tail.then(async () => {
      const retained = access.failedRetirement;
      if (retained) {
        // Retry only the failed final save, once per subsequent access. No disk reconciliation,
        // journal replay or identity selection occurs before those captured bytes are durable.
        await retained();
        if (access.failedRetirement === retained) delete access.failedRetirement;
      }
      return operation();
    }).catch((error: unknown) => {
      // A final save can also be skipped by a rejected predecessor. Retain it in that case,
      // while keeping an older failed retirement when its own retry is what failed.
      if (options.retainFailure && !access.failedRetirement) access.failedRetirement = operation;
      throw error;
    });
    const tail = running.then(() => undefined);
    access.tail = tail;
    const settled = () => {
      if (access.tail !== tail) return;
      if (access.failedRetirement) access.tail = Promise.resolve();
      else rooms.delete(directory);
    };
    // Queued dependants receive predecessor failure. A later access can retry retained final
    // persistence; ordinary failed operations release ownership for their caller's explicit retry.
    void tail.then(settled, settled);
    return running;
  }

  private async keyFor(roomId: string, relativePath: string, epoch: number): Promise<{ dir: string; prefix: string; path: string }> {
    const hash = await sha256Hex(relativePath);
    const dir = this.roomDir(roomId);
    const prefix = hash.slice(0, 40);
    return { dir, prefix, path: `${dir}/${prefix}.epoch-${epoch}.ydoc` };
  }

  /** Loads the persisted full Yjs state for (roomId, relativePath, epoch), or null if nothing is
   *  persisted for this exact epoch (a stale/older epoch's entry, if any, is never returned). */
  async load(roomId: string, relativePath: string, epoch: number): Promise<Uint8Array | null> {
    const { path } = await this.keyFor(roomId, relativePath, epoch);
    await recoverDataAdapterFileReplacement(this.adapter, path);
    if (!(await this.adapter.exists(path))) {
      return null;
    }
    return new Uint8Array(await this.adapter.readBinary(path));
  }

  /** Quarantine recovery cannot assume the surviving document's epoch identifies an old cache.
   * Enumerate only this path's hashed entries in the room, retaining bytes until preserved. */
  async loadAllEpochs(roomId: string, relativePath: string): Promise<Array<{ epoch: number; state: Uint8Array }>> {
    const { dir, prefix } = await this.keyFor(roomId, relativePath, 0);
    if (!(await this.adapter.exists(dir))) return [];
    const listing = await this.adapter.list(dir);
    const epochs = new Set<number>();
    for (const path of listing.files) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      const match = new RegExp(`^${prefix}\\.epoch-(\\d+)\\.ydoc(?:\\.tmp|\\.replace-backup)?$`).exec(name);
      if (match) epochs.add(Number(match[1]));
    }
    const documents: Array<{ epoch: number; state: Uint8Array }> = [];
    for (const epoch of epochs) {
      const state = await this.load(roomId, relativePath, epoch);
      if (state) documents.push({ epoch, state });
      const { path } = await this.keyFor(roomId, relativePath, epoch);
      if (await this.adapter.exists(`${path}.tmp`)) {
        documents.push({ epoch, state: new Uint8Array(await this.adapter.readBinary(`${path}.tmp`)) });
      }
    }
    return documents;
  }

  /**
   * Atomic write (temp-then-rename, matching how obsidianSqlJsDb.ts replaces its own database
   * image) plus the per-doc quota from 1.7/1.12. Also prunes any *other* epoch's persisted entry
   * for this same path - so a repeated delete/recreate cycle across restarts (when the live
   * epoch-bump cleanup couldn't run because the process was closed in between) never leaves
   * multiple stale generations sitting on disk. Quarantined identities retain prior epochs until
   * recovery has preserved each document's text.
   */
  async save(roomId: string, relativePath: string, epoch: number, state: Uint8Array, retainPriorEpochs = false): Promise<void> {
    if (state.byteLength > MAX_PERSISTED_CRDT_DOC_BYTES) {
      throw new CrdtDocStoreQuotaExceededError(state.byteLength);
    }
    const { dir, path, prefix } = await this.keyFor(roomId, relativePath, epoch);
    await this.ensureDir(dir);
    const buffer = new ArrayBuffer(state.byteLength);
    new Uint8Array(buffer).set(state);
    await replaceDataAdapterFile(this.adapter, path, async (temporaryPath) => {
      await this.adapter.writeBinary(temporaryPath, buffer);
    });
    if (!retainPriorEpochs) await this.prunePriorEpochs(dir, prefix, epoch);
  }

  /** Moves persisted state to a renamed path without changing its epoch. */
  async rename(roomId: string, oldRelativePath: string, newRelativePath: string, epoch: number): Promise<void> {
    const { path: oldPath } = await this.keyFor(roomId, oldRelativePath, epoch);
    if (!(await this.adapter.exists(oldPath))) {
      return;
    }
    const { dir, path: newPath } = await this.keyFor(roomId, newRelativePath, epoch);
    await this.ensureDir(dir);
    await this.adapter.rename(oldPath, newPath);
  }

  /** Cleanup on epoch bump (contract 1.12): removes the specific stale entry for a superseded
   *  epoch, if present. Idempotent - a no-op when nothing was ever persisted for that epoch. */
  async deleteEpoch(roomId: string, relativePath: string, epoch: number): Promise<void> {
    const { path } = await this.keyFor(roomId, relativePath, epoch);
    if (await this.adapter.exists(path)) {
      await this.adapter.remove(path);
    }
    const tmp = `${path}.tmp`;
    if (await this.adapter.exists(tmp)) {
      await this.adapter.remove(tmp).catch(() => undefined);
    }
  }

  /** Cleanup on leaving/unmounting a room (contract 1.12): drops every persisted document for the
   *  room in one shot (keyed by directory, not by re-deriving every relativePath's hash). */
  async deleteRoom(roomId: string): Promise<void> {
    const dir = this.roomDir(roomId);
    if (!(await this.adapter.exists(dir))) {
      return;
    }
    const listing = await this.adapter.list(dir).catch(() => ({ files: [] as string[], folders: [] as string[] }));
    for (const file of listing.files) {
      await this.adapter.remove(file).catch(() => undefined);
    }
    await this.adapter.rmdir(dir, true).catch(() => undefined);
  }

  private async prunePriorEpochs(dir: string, prefix: string, currentEpoch: number): Promise<void> {
    const listing = await this.adapter.list(dir).catch(() => ({ files: [] as string[], folders: [] as string[] }));
    const currentSuffix = `${prefix}.epoch-${currentEpoch}.ydoc`;
    for (const file of listing.files) {
      const name = file.slice(file.lastIndexOf("/") + 1);
      if (name === currentSuffix || !name.startsWith(`${prefix}.epoch-`) || !name.endsWith(".ydoc")) {
        continue;
      }
      await this.adapter.remove(file).catch(() => undefined);
    }
  }

  private async ensureDir(dir: string): Promise<void> {
    if (!(await this.adapter.exists(dir))) {
      await this.adapter.mkdir(dir);
    }
  }
}
