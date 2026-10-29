import { normalizePath, TFile, TFolder, type App, type DataAdapter } from "obsidian";
import type { Files } from "./diskStore.js";
import type { FileStat, VaultLike } from "./roomFolder.js";

/** The room folders' view of the vault, through Obsidian's vault API (so its caches and editors stay in step). */
export class ObsidianVault implements VaultLike {
  constructor(private readonly app: App) {}

  private file(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return file instanceof TFile ? file : null;
  }

  stat(path: string): FileStat | null {
    const file = this.file(path);
    return file ? { size: file.stat.size, mtime: file.stat.mtime } : null;
  }

  async readText(path: string): Promise<string> {
    const file = this.file(path);
    if (!file) throw new Error(`missing ${path}`);
    return this.app.vault.read(file);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const file = this.file(path);
    if (!file) throw new Error(`missing ${path}`);
    return new Uint8Array(await this.app.vault.readBinary(file));
  }

  private async ensureParent(path: string): Promise<void> {
    const parent = path.split("/").slice(0, -1).join("/");
    if (!parent || this.app.vault.getAbstractFileByPath(parent) instanceof TFolder) return;
    await this.app.vault.createFolder(parent).catch(() => {
      // created meanwhile
    });
  }

  async writeText(path: string, text: string, expected?: (current: string) => boolean): Promise<boolean> {
    const file = this.file(path);
    if (file) {
      if (!expected) {
        await this.app.vault.modify(file, text);
        return true;
      }
      // Replaced only if the file is still what the decision was based on (it may have changed since it was read).
      let replaced = false;
      await this.app.vault.process(file, (current) => {
        replaced = expected(current);
        return replaced ? text : current;
      });
      return replaced;
    }
    await this.ensureParent(path);
    await this.app.vault.create(normalizePath(path), text);
    return true;
  }

  async writeBytes(path: string, bytes: Uint8Array, expected?: (current: Uint8Array) => boolean): Promise<boolean> {
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const file = this.file(path);
    if (file) {
      if (expected) {
        // Replaced only if the file is still what the decision was based on, and didn't change while it was read.
        const { mtime, size } = file.stat;
        const current = new Uint8Array(await this.app.vault.readBinary(file));
        if (!expected(current) || file.stat.mtime !== mtime || file.stat.size !== size) return false;
      }
      await this.app.vault.modifyBinary(file, data);
      return true;
    }
    await this.ensureParent(path);
    await this.app.vault.createBinary(normalizePath(path), data);
    return true;
  }

  /** A plain move: link updates in other notes made by the person who renamed it arrive as their own edits. */
  async rename(from: string, to: string): Promise<void> {
    const file = this.file(from);
    if (!file) throw new Error(`missing ${from}`);
    await this.ensureParent(to);
    await this.app.vault.rename(file, normalizePath(to));
  }

  /**
   * To the system trash, or Obsidian's .trash folder where that isn't possible: a deletion that came from someone
   * else never deletes outright, whatever the "deleted files" setting says.
   */
  async trash(path: string): Promise<void> {
    const file = this.file(path);
    if (file) await this.app.vault.trash(file, true);
  }

  listFiles(folder: string): string[] {
    const prefix = `${normalizePath(folder)}/`;
    return this.app.vault
      .getFiles()
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => file.path);
  }

  folderExists(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFolder;
  }
}

/** The plugin's own data (encrypted envelopes, the record), through the vault's data adapter. */
export function adapterFiles(adapter: DataAdapter): Files {
  return {
    exists: (path) => adapter.exists(path),
    read: (path) => adapter.read(path),
    write: (path, data) => adapter.write(path, data),
    append: (path, data) => adapter.append(path, data),
    remove: (path) => adapter.remove(path),
    rename: (from, to) => adapter.rename(from, to),
    mkdir: (path) => adapter.mkdir(path),
    list: (path) => adapter.list(path),
    rmdir: (path, recursive) => adapter.rmdir(path, recursive),
    stat: async (path) => {
      const stat = await adapter.stat(path);
      return stat ? { size: stat.size, mtime: stat.mtime } : null;
    }
  };
}
