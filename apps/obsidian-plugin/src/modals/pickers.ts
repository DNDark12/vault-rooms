import { App, SuggestModal, TAbstractFile, TFile, TFolder } from "obsidian";

export type PluginOption = {
  pluginId: string;
  displayName: string;
};

const KNOWN_PLUGINS: PluginOption[] = [
  { pluginId: "obsidian-tasks-plugin", displayName: "Tasks" },
  { pluginId: "obsidian-kanban", displayName: "Kanban" },
  { pluginId: "dataview", displayName: "Dataview" },
  { pluginId: "obsidian-excalidraw-plugin", displayName: "Excalidraw" }
];

export function pluginOptions(app: App, selected: PluginOption[] = []): PluginOption[] {
  const registry = (app as App & { plugins?: { enabledPlugins?: Set<string>; manifests?: Record<string, { name?: string }> } }).plugins;
  const options = new Map<string, PluginOption>();
  for (const plugin of KNOWN_PLUGINS) {
    options.set(plugin.pluginId, plugin);
  }
  for (const pluginId of registry?.enabledPlugins ?? []) {
    options.set(pluginId, { pluginId, displayName: registry?.manifests?.[pluginId]?.name ?? pluginId });
  }
  for (const plugin of selected) {
    options.set(plugin.pluginId, plugin);
  }
  return [...options.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export class VaultPathSuggestModal extends SuggestModal<TAbstractFile> {
  constructor(
    app: App,
    private readonly type: "file" | "folder",
    private readonly onChoose: (path: string) => void
  ) {
    super(app);
    this.setPlaceholder(type === "folder" ? "Choose folder" : "Choose file");
  }

  getSuggestions(query: string): TAbstractFile[] {
    const needle = query.toLowerCase().trim();
    const files = this.type === "folder" ? this.app.vault.getAllLoadedFiles().filter(isFolder) : this.app.vault.getFiles();
    return files
      .filter((file) => file.path && !file.path.startsWith(".obsidian/"))
      .filter((file) => !needle || file.path.toLowerCase().includes(needle))
      .slice(0, 100);
  }

  renderSuggestion(file: TAbstractFile, el: HTMLElement): void {
    el.createEl("div", { text: file.path });
    el.createEl("small", { text: this.type === "folder" ? "Folder" : "File" });
  }

  onChooseSuggestion(file: TAbstractFile): void {
    this.onChoose(file.path);
  }
}

function isFolder(file: TAbstractFile): file is TFolder {
  return file instanceof TFolder;
}

export function isFile(file: TAbstractFile): file is TFile {
  return file instanceof TFile;
}
