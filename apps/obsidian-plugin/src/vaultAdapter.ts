import type { Plugin, TAbstractFile, TFile, Vault } from "obsidian";
import type { VaultAdapter, VaultChangeEvent } from "./syncClient.js";

export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private readonly plugin: Plugin) {}

  private get app() {
    return this.plugin.app;
  }

  async read(path: string): Promise<string> {
    const file = this.getFile(path);
    return this.app.vault.read(file);
  }

  async write(path: string, content: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && isFile(existing)) {
      await this.app.vault.modify(existing, content);
      return;
    }
    await this.ensureFolder(path);
    await this.app.vault.create(path, content);
  }

  async delete(path: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      await this.app.vault.trash(existing, true);
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(path) !== null;
  }

  async list(prefix: string): Promise<string[]> {
    return this.app.vault
      .getFiles()
      .map((file) => file.path)
      .filter((path) => path.startsWith(prefix));
  }

  onChange(cb: (event: VaultChangeEvent) => void): void {
    const vault = this.app.vault as Vault;
    this.plugin.registerEvent(vault.on("create", (file) => cb({ type: "create", path: file.path })));
    this.plugin.registerEvent(vault.on("modify", (file) => cb({ type: "modify", path: file.path })));
    this.plugin.registerEvent(vault.on("delete", (file) => cb({ type: "delete", path: file.path })));
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
