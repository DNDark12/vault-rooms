import type { Files } from "../../src/mesh/diskStore.js";

/** An in-memory stand-in for Obsidian's DataAdapter (paths use "/", folders are implied by files or made explicitly). */
export class MemoryFiles implements Files {
  readonly data = new Map<string, string>();
  readonly folders = new Set<string>();
  /** Set to make the next write to a path ending with this suffix fail half-way (writes nothing). */
  failNextWriteTo: string | null = null;

  async exists(path: string): Promise<boolean> {
    return this.data.has(path) || this.folders.has(path) || [...this.data.keys()].some((key) => key.startsWith(`${path}/`));
  }

  /** Set to make reads of some paths fail (a file held by another program). */
  failReads?: (path: string) => boolean;

  async read(path: string): Promise<string> {
    if (this.failReads?.(path)) throw new Error(`EBUSY ${path}`);
    const value = this.data.get(path);
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    if (this.failNextWriteTo && path.endsWith(this.failNextWriteTo)) {
      this.failNextWriteTo = null;
      throw new Error("disk full");
    }
    this.data.set(path, data);
  }

  async append(path: string, data: string): Promise<void> {
    if (this.failNextWriteTo && path.endsWith(this.failNextWriteTo)) {
      this.failNextWriteTo = null;
      throw new Error("disk full");
    }
    this.data.set(path, (this.data.get(path) ?? "") + data);
  }

  async remove(path: string): Promise<void> {
    this.data.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const value = this.data.get(from);
    if (value === undefined) throw new Error(`ENOENT ${from}`);
    if (this.data.has(to)) throw new Error(`EEXIST ${to}`);
    this.data.delete(from);
    this.data.set(to, value);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const files = new Set<string>();
    const folders = new Set<string>();
    for (const key of [...this.data.keys(), ...this.folders]) {
      if (!key.startsWith(`${path}/`)) continue;
      const rest = key.slice(path.length + 1);
      const slash = rest.indexOf("/");
      if (slash === -1) (this.data.has(key) ? files : folders).add(key);
      else folders.add(`${path}/${rest.slice(0, slash)}`);
    }
    return { files: [...files].sort(), folders: [...folders].sort() };
  }

  async stat(path: string): Promise<{ size: number; mtime: number } | null> {
    const value = this.data.get(path);
    return value === undefined ? null : { size: value.length, mtime: Date.now() };
  }

  async rmdir(path: string): Promise<void> {
    for (const key of [...this.data.keys()]) if (key === path || key.startsWith(`${path}/`)) this.data.delete(key);
    for (const key of [...this.folders]) if (key === path || key.startsWith(`${path}/`)) this.folders.delete(key);
  }
}
