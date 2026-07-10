import { normalizePath } from "obsidian";
import type { Plugin, TAbstractFile, TFile } from "obsidian";
import type { VaultAdapter, VaultChangeEvent } from "./syncClient.js";
import { isFile, listFiles } from "./vaultTraversal.js";

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
    const existing = this.app.vault.getAbstractFileByPath(normalized);
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
    await this.ensureFolder(normalized);
    await this.app.vault.create(normalized, content);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    return this.app.vault.readBinary(this.getFile(normalizePath(path)));
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing && isFile(existing)) {
      await this.app.vault.modifyBinary(existing, data);
      return;
    }
    await this.ensureFolder(normalized);
    await this.app.vault.createBinary(normalized, data);
  }

  async delete(path: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (existing) {
      await this.app.fileManager.trashFile(existing);
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
  }

  async list(prefix: string): Promise<string[]> {
    const normalizedPrefix = normalizePath(prefix).replace(/\/+$/, "");
    const root = normalizedPrefix ? this.app.vault.getAbstractFileByPath(normalizedPrefix) : this.app.vault.getRoot();
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
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !isFile(file)) {
      throw new Error(`File not found: ${path}`);
    }
    return file;
  }

  private async ensureFolder(path: string): Promise<void> {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) {
      return;
    }
    const folder = path.slice(0, slash);
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }
  }
}

