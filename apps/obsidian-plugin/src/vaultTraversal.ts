import type { TAbstractFile, TFile, TFolder } from "obsidian";

export function isFile(file: TAbstractFile): file is TFile {
  return "extension" in file;
}

export function isFolder(file: TAbstractFile): file is TFolder {
  return "children" in file;
}

/** Recursively collects every TFile under root - or just [root] if root is itself a file. Does
 *  not include a folder root in its own result. */
export function listFiles(root: TAbstractFile): TFile[] {
  if (isFile(root)) {
    return [root];
  }
  if (!isFolder(root)) {
    return [];
  }
  const files: TFile[] = [];
  for (const child of root.children) {
    files.push(...listFiles(child));
  }
  return files;
}

/** Recursively collects folder itself plus every folder nested under it. */
export function listFolders(folder: TFolder): TFolder[] {
  const folders: TFolder[] = [folder];
  for (const child of folder.children) {
    if (isFolder(child)) {
      folders.push(...listFolders(child));
    }
  }
  return folders;
}
