import type { FileStat, VaultLike } from "../../src/mesh/roomFolder.js";

/** An in-memory vault that reports writes, deletions and renames the way Obsidian's vault events do. */
export class MemoryVault implements VaultLike {
  readonly files = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();
  readonly trashed: string[] = [];
  /** Every write, in turn: the path, and the text written. */
  readonly written: Array<{ path: string; text: string }> = [];
  /** Reads of paths it gives a promise for wait for it first (a slow disk, say). */
  gate?: (path: string) => Promise<void> | undefined;
  private mtimes = new Map<string, number>();
  private clock = 1;
  listener: { write?(path: string): void; delete?(path: string): void; rename?(from: string, to: string): void } = {};

  stat(path: string): FileStat | null {
    const data = this.files.get(path);
    return data ? { size: data.length, mtime: this.mtimes.get(path)! } : null;
  }

  text(path: string): string | undefined {
    const data = this.files.get(path);
    return data ? Buffer.from(data).toString("utf8") : undefined;
  }

  /** Reads, or moves to the trash, of paths these are true for fail (a file held by another program, say). */
  failReads?: (path: string) => boolean;
  failTrash?: (path: string) => boolean;
  /** How many times the folder's files were listed. */
  lists = 0;

  async readText(path: string): Promise<string> {
    await this.gate?.(path);
    if (this.failReads?.(path)) throw new Error(`EBUSY ${path}`);
    const data = this.files.get(path);
    if (!data) throw new Error(`ENOENT ${path}`);
    return Buffer.from(data).toString("utf8");
  }

  async readBytes(path: string): Promise<Uint8Array> {
    if (this.failReads?.(path)) throw new Error(`EBUSY ${path}`);
    const data = this.files.get(path);
    if (!data) throw new Error(`ENOENT ${path}`);
    return new Uint8Array(data);
  }

  private put(path: string, data: Uint8Array): void {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
    this.files.set(path, data);
    this.mtimes.set(path, ++this.clock);
    this.written.push({ path, text: Buffer.from(data).toString("utf8") });
  }

  /** Writes to paths it is true for fail (a full disk, say). */
  failWrites?: (path: string) => boolean;

  async writeText(path: string, text: string, expected?: (current: string) => boolean): Promise<boolean> {
    if (this.failWrites?.(path)) throw new Error(`ENOSPC ${path}`);
    const current = this.files.get(path);
    if (current && expected && !expected(Buffer.from(current).toString("utf8"))) return false;
    this.put(path, new Uint8Array(Buffer.from(text, "utf8")));
    this.listener.write?.(path);
    return true;
  }

  /** Called just before a guarded write checks the file (tests use it to change the file at that very moment). */
  beforeGuardedWrite?: (path: string) => void;

  async writeBytes(path: string, bytes: Uint8Array, expected?: (current: Uint8Array) => boolean): Promise<boolean> {
    if (this.failWrites?.(path)) throw new Error(`ENOSPC ${path}`);
    const current = this.files.get(path);
    if (current && expected) {
      this.beforeGuardedWrite?.(path);
      if (!expected(new Uint8Array(this.files.get(path)!))) return false;
    }
    this.put(path, new Uint8Array(bytes));
    this.listener.write?.(path);
    return true;
  }

  /** Moves of paths this is true for fail (a file another program holds open). */
  failMoves?: (from: string) => boolean;

  async rename(from: string, to: string): Promise<void> {
    if (this.failMoves?.(from)) throw new Error(`EBUSY ${from}`);
    const data = this.files.get(from);
    if (!data) throw new Error(`ENOENT ${from}`);
    if (this.files.has(to)) throw new Error(`EEXIST ${to}`);
    this.files.delete(from);
    this.put(to, data);
    this.listener.rename?.(from, to);
  }

  async trash(path: string): Promise<void> {
    if (this.failTrash?.(path)) throw new Error(`EBUSY ${path}`);
    this.files.delete(path);
    this.trashed.push(path);
    this.listener.delete?.(path);
  }

  listFiles(folder: string): string[] {
    this.lists++;
    return [...this.files.keys()].filter((path) => path.startsWith(`${folder}/`)).sort();
  }

  folderExists(path: string): boolean {
    return this.folders.has(path);
  }

  /** Change a file without telling anyone (as if edited while Obsidian was closed). */
  silently(path: string, text: string): void {
    this.put(path, new Uint8Array(Buffer.from(text, "utf8")));
  }

  /** Delete a whole folder, reporting each file as deleted (as Obsidian does). */
  removeFolder(folder: string): void {
    for (const path of this.listFiles(folder)) {
      this.files.delete(path);
      this.listener.delete?.(path);
    }
    for (const path of [...this.folders]) if (path === folder || path.startsWith(`${folder}/`)) this.folders.delete(path);
  }
}
