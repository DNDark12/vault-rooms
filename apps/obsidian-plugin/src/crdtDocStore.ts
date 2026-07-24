import type { DataAdapter } from "obsidian";
import { recoverDataAdapterFileReplacement, replaceDataAdapterFile } from "./dataAdapterFileReplace.js";

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

/**
 * Persists full Yjs encoded document state client-side (contract 1.12, strategy A - chosen by the
 * Phase 0.3 spike over a text+state-vector baseline because reloading the full encoded state
 * preserves the original CRDT identity exactly across a restart, avoiding the "seed a fresh Y.Doc
 * from baseline text" trap). Storage key is (roomId, relativePath, epoch): the epoch is baked into
 * the on-disk filename, so a key miss on the *current* epoch simply means "start fresh via
 * crdt_create/handshake" - a stale persisted doc from a purged incarnation is never accidentally
 * reloaded.
 *
 * Uses Obsidian's DataAdapter (never node:fs - CLAUDE.md rule 3), under this plugin's own private
 * data directory (a sibling of server-data/relay.sqlite - see ServerConnectionManager), not vault
 * content - this is plugin-private storage, so there is no whole-vault enumeration concern here.
 */
export class CrdtDocStore {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly baseDir: string
  ) {}

  private roomDir(roomId: string): string {
    return `${this.baseDir}/${sanitizeSegment(roomId)}`;
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

  /**
   * Atomic write (temp-then-rename, matching how obsidianSqlJsDb.ts replaces its own database
   * image) plus the per-doc quota from 1.7/1.12. Also prunes any *other* epoch's persisted entry
   * for this same path - so a repeated delete/recreate cycle across restarts (when the live
   * epoch-bump cleanup couldn't run because the process was closed in between) never leaves
   * multiple stale generations sitting on disk.
   */
  async save(roomId: string, relativePath: string, epoch: number, state: Uint8Array): Promise<void> {
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
    await this.prunePriorEpochs(dir, prefix, epoch);
  }

  /**
   * Moves a persisted document's on-disk entry to match a renamed path (fourth hardware-testing
   * round, 2026-07-23), preserving the exact same epoch's persisted bytes rather than losing them
   * (which would force a reseed-from-disk-text on next load, discarding fine-grained Yjs structure/
   * history even though the actual text content would still be recovered via the disk fallback).
   * `roomDir` only depends on `roomId` (unchanged by a rename), so this is always a same-directory
   * move of one file, keyed by the new path's content hash. A no-op if nothing was ever persisted
   * for this exact epoch yet - the next `save()` simply writes under the new key from scratch.
   */
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
