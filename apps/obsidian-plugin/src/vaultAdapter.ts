import { normalizePath } from "obsidian";
import { isValidUtf8, portablePathKey } from "@vault-rooms/protocol";
import type { Plugin, TAbstractFile, TFile } from "obsidian";
import type { VaultAdapter, VaultChangeEvent } from "./syncClient.js";
import { isFile, isFolder, listFiles } from "./vaultTraversal.js";

export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private readonly plugin: Plugin) {}

  private get app() {
    return this.plugin.app;
  }

  async read(path: string): Promise<string> {
    const file = this.getFile(normalizePath(path));
    return this.app.vault.read(file);
  }

  async write(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.resolvePath(normalized);
    if (existing && isFile(existing)) {
      // Vault.process() (not modify()) for writes that can land on a file the user currently has
      // open: process() reads the file fresh and applies the returned content atomically, so it
      // can't clobber an in-progress editor save the way a plain modify() with pre-read content
      // could. It still fires the same "modify" vault event modify() does, so this doesn't change
      // any of syncClient.ts's dirty/version bookkeeping - see applyRemoteChange()/
      // applyRemoteDelete(), which already update room.files synchronously right after this write
      // resolves, independent of when/whether the resulting "modify" event has fired yet.
      await this.app.vault.process(existing, () => content);
      return;
    }
    await this.app.vault.create(await this.ensureFolder(normalized), content);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    return this.app.vault.readBinary(this.getFile(normalizePath(path)));
  }

  async readStrictUtf8(path: string): Promise<string> {
    const file = this.getFile(normalizePath(path));
    if (!isValidUtf8(new Uint8Array(await this.app.vault.readBinary(file)))) {
      throw Object.assign(new Error("This file isn't UTF-8 text, so syncing it would damage it."), { code: "VALIDATION_ERROR" });
    }
    return this.app.vault.read(file);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.resolvePath(normalized);
    if (existing && isFile(existing)) {
      await this.app.vault.modifyBinary(existing, data);
      return;
    }
    await this.app.vault.createBinary(await this.ensureFolder(normalized), data);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);
    const existing = this.resolvePath(normalizedOld);
    if (!existing) {
      return;
    }
    // Obsidian throws "Destination file already exists!" rather than reporting it, and that rejection
    // used to propagate all the way out of a remote-rename apply as an uncaught error. Treat an
    // already-occupied destination as nothing-to-do: the local vault, not this move, decides what
    // lives at that path, and the room's next reconciliation settles any real divergence.
    const destination = this.resolvePath(normalizedNew);
    if (destination && destination !== existing) {
      return;
    }
    const destinationPath = await this.ensureFolder(normalizedNew);
    if (existing.path === destinationPath) return;
    // FileManager.renameFile (not Vault#rename) so backlinks get updated the same way they would
    // for a user-driven rename in Obsidian's own UI - this is applying someone else's rename, not
    // a raw file-system move.
    await this.app.fileManager.renameFile(existing, destinationPath);
  }

  async delete(path: string): Promise<void> {
    const existing = this.resolvePath(normalizePath(path));
    if (existing) {
      await this.app.fileManager.trashFile(existing);
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.resolvePath(normalizePath(path)) !== null;
  }

  async list(prefix: string): Promise<string[]> {
    const normalizedPrefix = normalizePath(prefix).replace(/\/+$/, "");
    const root = this.resolvePath(normalizedPrefix);
    if (!root) {
      return [];
    }
    return listFiles(root).map((file) => file.path);
  }

  onChange(cb: (event: VaultChangeEvent) => void): () => void {
    const vault = this.app.vault;
    const refs = [
      vault.on("create", (file) => cb({ type: "create", path: file.path })),
      vault.on("modify", (file) => cb({ type: "modify", path: file.path })),
      vault.on("delete", (file) => cb({ type: "delete", path: file.path })),
      // Obsidian fires exactly one "rename" event per moved/renamed file (folder renames are
      // reported as one "rename" per file inside the folder, each with its own old/new path) -
      // confirmed against Obsidian's own core "file explorer" rename handling, not directly
      // tested here since it requires the real Obsidian runtime; see classifyRenameEvent for how
      // this is turned into delete-old/create-new relative to a mounted room.
      vault.on("rename", (file, oldPath) => cb({ type: "rename", path: file.path, oldPath }))
    ];
    // registerEvent() is still the safety net for plugin unload; offref() below additionally lets
    // a specific registration (e.g. one room's watcher) be torn down early, on unmount, instead
    // of only ever being cleaned up when the whole plugin unloads.
    for (const ref of refs) {
      this.plugin.registerEvent(ref);
    }
    return () => {
      for (const ref of refs) {
        vault.offref(ref);
      }
    };
  }

  private getFile(path: string): TFile {
    const file = this.resolvePath(path);
    if (!file || !isFile(file)) {
      throw new Error(`File not found: ${path}`);
    }
    return file;
  }

  /** Obsidian's path cache is exact even on insensitive filesystems. Walk only the requested
   * ancestors so aliases resolve without enumerating the vault or selecting an ambiguous child. */
  private resolvePath(path: string): TAbstractFile | null {
    let current: TAbstractFile = this.app.vault.getRoot();
    for (const segment of path.split("/").filter(Boolean)) {
      if (!isFolder(current)) return null;
      const children = current.children.filter((child) => portablePathKey(child.path.slice(child.path.lastIndexOf("/") + 1)) === portablePathKey(segment));
      if (children.length > 1) {
        throw Object.assign(new Error(`Local path has a collision: ${path}`), { code: "PATH_COLLISION" });
      }
      if (!children[0]) return null;
      current = children[0];
    }
    return current;
  }

  /** Returns the requested filename under the actual spelling of its parent folders. */
  private async ensureFolder(path: string): Promise<string> {
    const segments = path.split("/");
    const filename = segments.pop()!;
    let parent = "";
    for (const segment of segments) {
      const requested = parent ? `${parent}/${segment}` : segment;
      const folder = this.resolvePath(requested);
      if (folder) {
        if (!isFolder(folder)) throw new Error(`Not a folder: ${requested}`);
        parent = folder.path;
      } else {
        const created = await this.app.vault.createFolder(requested);
        parent = created.path;
      }
    }
    return parent ? `${parent}/${filename}` : filename;
  }
}
