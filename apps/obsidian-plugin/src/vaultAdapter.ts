import { normalizePath } from "obsidian";
import type { Plugin, TAbstractFile, TFile, Vault } from "obsidian";
import type { VaultAdapter, VaultChangeEvent } from "./syncClient.js";

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
      await this.app.vault.modify(existing, content);
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
      await this.app.vault.trash(existing, true);
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
  }

  async list(prefix: string): Promise<string[]> {
    const normalizedPrefix = normalizePath(prefix).replace(/\/+$/, "");
    return this.app.vault
      .getFiles()
      .map((file) => file.path)
      .filter((path) => path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`));
  }

  onChange(cb: (event: VaultChangeEvent) => void): () => void {
    const vault = this.app.vault as Vault;
    const refs = [
      vault.on("create", (file) => cb({ type: "create", path: file.path })),
      vault.on("modify", (file) => cb({ type: "modify", path: file.path })),
      vault.on("delete", (file) => cb({ type: "delete", path: file.path }))
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

function isFile(file: TAbstractFile): file is TFile {
  return "extension" in file;
}
