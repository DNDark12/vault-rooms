import { hostname } from "node:os";
import { MarkdownView, Notice, normalizePath, Plugin, TAbstractFile, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { cleanName, isWithin, MAX_PATH, MAX_SEGMENT, pathKey, randomId, safeRoomPath, type Role, type RoomReplica } from "@vault-rooms/secure";
import { EditorBinding, type BindTarget } from "./mesh/editorBinding.js";
import { MeshService, MeshServiceError, type MeshDeps, type MeshSettings } from "./mesh/meshService.js";
import { adapterFiles, ObsidianVault } from "./mesh/obsidianVault.js";
import { RoomPresence } from "./mesh/presence.js";
import { folderProblem, normalizeNote, RoomFolder, type RoomFolderState, type RoomHealth } from "./mesh/roomFolder.js";
import { isScope, obsidianSecrets } from "./mesh/secrets.js";
import { JoinModal } from "./ui/modals.js";
import { ROOMS_VIEW, RoomsView } from "./ui/roomsView.js";
import { RoomsSettingTab } from "./ui/settingsTab.js";

export interface PluginSettings {
  mesh: MeshSettings;
  /** Where rooms shared with you are put, unless you choose a folder. */
  mountRoot: string;
}

/** Where an instance of this plugin that is stopping leaves its promise for the next one (shared by every instance). */
const STOPPING = Symbol.for("vault-rooms.stopping");
const shared = globalThis as unknown as Record<symbol, Promise<void> | undefined>;

/** Resolves once `promise` settles, or after `ms` at most. */
function within(promise: Promise<unknown> | undefined, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    void Promise.resolve(promise).then(done, done);
  });
}

function randomScope(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join("");
}

/** One folder name made from a room's name: nothing that could mean another place, or that Windows refuses. */
function folderName(name: string): string {
  const cleaned = cleanName(name)
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80)
    .trim();
  return cleaned && safeRoomPath(cleaned) !== null ? cleaned : cleaned && safeRoomPath(`Room ${cleaned}`) !== null ? `Room ${cleaned}` : "Room";
}

export default class VaultRoomsPlugin extends Plugin {
  declare settings: PluginSettings;
  service: MeshService | null = null;
  serviceError: string | null = null;
  private folders = new Map<string, RoomFolder>();
  private presences = new Map<string, RoomPresence>();
  private editors!: EditorBinding;
  private changeListeners = new Set<() => void>();
  private unsubscribers: Array<() => void> = [];
  private pausedFolders = new Set<string>();
  /** Rooms shared with us whose name we can't read yet (no key): mounted once the key arrives. */
  private pendingMounts = new Set<string>();

  async onload(): Promise<void> {
    // An instance of the plugin still stopping (updated, or turned off and on) finishes writing before this one reads
    // anything (a while at most: one that hangs doesn't keep this one from starting).
    await within(shared[STOPPING], 15_000);
    if (this.unloaded) return;
    await this.loadSettings();
    this.editors = new EditorBinding(
      (path) => this.bindTarget(path),
      (delayMs) => this.syncEditorsSoon(delayMs)
    );
    this.registerEditorExtension(this.editors.extension());
    this.registerView(ROOMS_VIEW, (leaf) => new RoomsView(leaf, this));
    this.addRibbonIcon("users", "Vault Rooms", () => void this.openPanel());
    this.addSettingTab(new RoomsSettingTab(this.app, this));
    this.addCommand({ id: "open-panel", name: "Open rooms panel", callback: () => void this.openPanel() });
    this.addCommand({ id: "join", name: "Join a workspace with an invite link", callback: () => new JoinModal(this).open() });
    this.registerObsidianProtocolHandler("vault-rooms", (params) => {
      if (params.mode === "join-secure") new JoinModal(this, params).open();
    });

    // Vault events: each goes to the room folder that contains the path.
    this.registerEvent(this.app.vault.on("create", (file) => this.onVaultWrite(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultWrite(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultDelete(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onVaultRename(file, oldPath)));
    // Editors: bind every open note of a room, whichever pane it is in.
    for (const event of ["active-leaf-change", "file-open", "layout-change"] as const) this.registerEvent(this.app.workspace.on(event as "layout-change", () => this.syncEditors()));

    this.app.workspace.onLayoutReady(() => {
      if (!this.unloaded) void this.startService();
    });
  }

  private unloaded = false;
  /** The last start of the service, done (or given up, once unloaded) when this resolves. */
  private starting: Promise<void> = Promise.resolve();

  async onunload(): Promise<void> {
    // Obsidian doesn't wait for this: the next instance waits for it instead (see onload). A start under way gives up
    // first, so nothing of this instance goes (or stays) online after it.
    this.unloaded = true;
    const done = Promise.all([shared[STOPPING], within(this.starting, 10_000).then(() => this.stopService())]).then(
      () => {},
      (error: Error) => console.debug(`Vault Rooms: stopping: ${error.message}`)
    );
    shared[STOPPING] = done;
    await done;
  }

  // ---- settings ----

  async loadSettings(): Promise<void> {
    const raw = ((await this.loadData()) ?? {}) as Partial<PluginSettings>;
    // A damaged scope doesn't drop the workspace: opening it then fails visibly and Leave cleans up.
    const mesh: MeshSettings = { scope: isScope(raw.mesh?.scope) ? raw.mesh!.scope : randomScope(), workspace: raw.mesh?.workspace ?? null };
    this.settings = { mesh, mountRoot: typeof raw.mountRoot === "string" && raw.mountRoot ? raw.mountRoot : "Rooms" };
    await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Why a folder can't be where rooms shared with you go, or null if it can. */
  mountRootProblem(path: string): string | null {
    const root = normalizePath(path);
    if (safeRoomPath(root) === null) return "Use a folder name without a leading dot or special characters.";
    if (root.length > MAX_PATH - MAX_SEGMENT - 1) return "That folder's path is too long.";
    if (this.roomFolders().some(([, folder]) => isWithin(root, folder))) return "That folder is a room's folder, or inside one.";
    return null;
  }

  /** Where rooms shared with you go: the chosen folder, or the first usable of "Rooms", "Rooms 2", ... (null if none). */
  private mountRoot(): string | null {
    const candidates = [this.settings.mountRoot, "Rooms", ...Array.from({ length: 8 }, (_, i) => `Rooms ${i + 2}`)];
    return candidates.map((root) => normalizePath(root)).find((root) => this.mountRootProblem(root) === null) ?? null;
  }

  private deps(): MeshDeps {
    return {
      files: adapterFiles(this.app.vault.adapter),
      dataRoot: normalizePath(`${this.manifest.dir}/mesh`),
      secrets: obsidianSecrets(this.app.secretStorage as unknown as Parameters<typeof obsidianSecrets>[0]),
      settings: this.settings.mesh,
      save: () => this.saveSettings(),
      notify: (message) => new Notice(message, 8000),
      log: (message) => console.debug(`Vault Rooms: ${message}`)
    };
  }

  // ---- service lifecycle ----

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  changed(): void {
    for (const listener of this.changeListeners) listener();
  }

  startService(service?: MeshService): Promise<void> {
    const started = this.startNow(service);
    this.starting = started.catch(() => {});
    return started;
  }

  private async startNow(service?: MeshService): Promise<void> {
    this.serviceError = null;
    let svc: MeshService | null;
    try {
      svc = service ?? (await MeshService.open(this.deps()));
    } catch (error) {
      this.service = null;
      this.serviceError = error instanceof MeshServiceError ? error.message : `Couldn't open the workspace: ${(error as Error).message}`;
      this.changed();
      return;
    }
    // Unloaded meanwhile: this instance doesn't go online (the next one opens the workspace instead).
    if (svc && this.unloaded) return svc.discard();
    this.service = svc;
    if (!svc) return this.changed();
    this.unsubscribers.push(
      svc.onChange(() => {
        this.retryPendingMounts();
        // A role may have changed: editors open on the room's notes become editable or read-only at once.
        this.syncEditorsSoon();
        this.changed();
      }),
      svc.onReplica((roomId, replica) => void this.onReplica(roomId, replica)),
      svc.onRoomActivity((roomId, docId) => {
        if (this.pendingMounts.has(roomId)) this.retryPendingMounts();
        this.folders.get(roomId)?.remoteChanged(docId);
      }),
      svc.onPresence((env) => this.presences.get(env.room)?.receive(env)),
      svc.onLocalRefused((roomId, docId, code) => this.onLocalRefused(roomId, docId, code)),
      svc.onLostRoom((roomId) => void this.forgetFolder(roomId)),
      // Without the room's folder (hidden, being moved) the clash waits for it, and is settled when it starts again.
      svc.onClash((roomId, docId, version) => this.folders.get(roomId)?.noteClashed(docId, version) ?? false)
    );
    for (const room of svc.rooms()) {
      const replica = svc.replica(room.id);
      if (replica) await this.onReplica(room.id, replica);
      if (this.unloaded) return;
    }
    try {
      await svc.start();
    } catch (error) {
      this.serviceError = `Couldn't start sharing on this computer: ${(error as Error).message}`;
    }
    this.syncEditors();
    this.changed();
  }

  private async stopFolders(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.editors?.unbindAll();
    await Promise.all([...this.folders.values()].map((folder) => folder.stop()));
    this.folders.clear();
    // Folders let go of earlier (a room re-made, a folder moved) finish too.
    await Promise.all(this.stopping.values());
    for (const presence of this.presences.values()) presence.destroy();
    this.presences.clear();
  }

  async stopService(): Promise<void> {
    await this.stopFolders();
    await this.service?.stop();
    this.service = null;
  }

  /**
   * Open the workspace and start sharing again (after either failed: shown until it works). One at a time: a second
   * call while one runs gets that one, so two services of this device never run at once; and an unload waits for it.
   */
  restartService(): Promise<void> {
    if (!this.restarting) {
      const run = this.starting.then(() => this.stopService()).then(() => this.startNow());
      this.starting = run.catch(() => {});
      this.restarting = run.finally(() => (this.restarting = null));
    }
    return this.restarting;
  }

  private restarting: Promise<void> | null = null;

  async createWorkspace(input: { workspaceName: string; userName: string; deviceName: string }): Promise<void> {
    const service = await MeshService.create(this.deps(), input);
    await this.startService(service);
  }

  async joinWorkspace(input: { link: string; userName: string; deviceName: string; peers?: string[] }): Promise<void> {
    const service = await MeshService.join(this.deps(), input);
    await this.startService(service);
  }

  /** Leave on this computer: stop syncing and delete the workspace data and this device's keys. Folders stay. */
  async leaveWorkspace(): Promise<void> {
    const service = this.service;
    await this.stopFolders();
    this.service = null;
    // Also when the workspace couldn't be opened at all (keys missing, record damaged).
    if (service) await service.forget();
    else await MeshService.forgetUnopened(this.deps());
    this.serviceError = null;
    this.changed();
  }

  defaultDeviceName(): string {
    try {
      return cleanName(hostname()).slice(0, 60) || "This computer";
    } catch {
      return "This computer";
    }
  }

  async openPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(ROOMS_VIEW)[0];
    const leaf: WorkspaceLeaf = existing ?? this.app.workspace.getRightLeaf(false)!;
    if (!existing) await leaf.setViewState({ type: ROOMS_VIEW, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  // ---- rooms in this vault ----

  private roomFolders(): Array<[string, string]> {
    return Object.entries(this.settings.mesh.workspace?.rooms ?? {})
      .filter(([, room]) => !room.hidden)
      .map(([roomId, room]) => [roomId, room.folder]);
  }

  /** The room whose folder holds a vault path (the innermost, if folders were ever nested), compared like the disk does. */
  private roomAt(path: string): string | null {
    const key = pathKey(path);
    let best: { roomId: string; length: number } | null = null;
    for (const [roomId, folder] of this.roomFolders()) if (key.startsWith(`${pathKey(folder)}/`) && (!best || folder.length > best.length)) best = { roomId, length: folder.length };
    return best?.roomId ?? null;
  }

  /** Why a folder can't be (or become) a room's folder (see folderProblem), rooms shown here counted, but `exceptRoomIds`. */
  folderProblem(path: string, exceptRoomIds: string[] = []): string | null {
    return folderProblem(
      path,
      this.roomFolders()
        .filter(([roomId]) => !exceptRoomIds.includes(roomId))
        .map(([, folder]) => folder)
    );
  }

  /** A folder for a room shared with you: under the mount root, named after the room, clashing with nothing (or null). */
  private freeFolder(name: string): string | null {
    const root = this.mountRoot();
    if (!root) return null;
    const segment = folderName(name);
    const taken = new Map(this.app.vault.getAllLoadedFiles().map((file) => [pathKey(file.path), file]));
    for (let i = 1; i <= 200; i++) {
      const candidate = `${root}/${i === 1 ? segment : `${segment} ${i}`}`;
      const existing = taken.get(pathKey(candidate));
      if (existing && !(existing instanceof TFolder && existing.children.length === 0)) continue;
      if (this.folderProblem(candidate) === null) return candidate;
    }
    return null;
  }

  /** Rooms that found no usable folder: tried again when the folder for shared rooms changes. */
  private unplaced = new Set<string>();

  /** Try again to show rooms that couldn't get a folder (after the folder for shared rooms changed). */
  retryUnplaced(): void {
    const svc = this.service;
    for (const roomId of [...this.unplaced]) {
      this.unplaced.delete(roomId);
      const replica = svc?.replica(roomId);
      if (replica) void this.onReplica(roomId, replica);
    }
  }

  folderOf(roomId: string): string | null {
    const room = this.settings.mesh.workspace?.rooms[roomId];
    return room && !room.hidden ? room.folder : null;
  }

  /** Rooms of yours that aren't shown in this vault (their folder was deleted here). */
  hiddenRooms(): string[] {
    return Object.entries(this.settings.mesh.workspace?.rooms ?? {})
      .filter(([, room]) => room.hidden)
      .map(([roomId]) => roomId);
  }

  /** Show a hidden room again, in a fresh folder if its old one is gone or taken. */
  async showRoom(roomId: string): Promise<void> {
    const ws = this.settings.mesh.workspace;
    const room = ws?.rooms[roomId];
    const replica = this.service?.replica(roomId);
    if (!ws || !room || !replica) return;
    delete room.hidden;
    if (this.folderProblem(room.folder, [roomId]) !== null || this.app.vault.getAbstractFileByPath(room.folder)) {
      delete ws.rooms[roomId];
    }
    await this.saveSettings();
    await this.onReplica(roomId, replica);
  }

  /** Share an existing folder as a new room. The folder is assigned before the room exists, so its files are shared from there. */
  async createRoom(folder: string, name: string, members: Record<string, Role> = {}): Promise<string> {
    const svc = this.service;
    const ws = this.settings.mesh.workspace;
    if (!svc || !ws) throw new Error("No workspace.");
    const path = normalizePath(folder);
    const problem = this.folderProblem(path);
    if (problem) throw new Error(problem);
    const roomId = randomId("r");
    ws.rooms[roomId] = { folder: path };
    await this.saveSettings();
    try {
      return await svc.createRoom(cleanName(name), members, roomId);
    } catch (error) {
      delete ws.rooms[roomId];
      await this.saveSettings();
      throw error;
    }
  }

  private async onReplica(roomId: string, replica: RoomReplica | null): Promise<void> {
    const svc = this.service;
    const ws = this.settings.mesh.workspace;
    if (!svc || !ws) return;
    if (!replica) {
      // Access ended (or the room was deleted): stop syncing; the files stay on this computer.
      await this.unmount(roomId);
      // Back meanwhile (a room re-made after a race): show it again, nothing to tell.
      const again = svc.replica(roomId);
      if (again) return this.onReplica(roomId, again);
      // Keep the folder assignment: if access comes back, the room returns to the same folder.
      const folder = ws.rooms[roomId]?.folder;
      if (folder && !ws.rooms[roomId]?.hidden) new Notice(`You no longer have access to the room in "${folder}". Its files stay on this computer but no longer sync.`, 10000);
      this.changed();
      return;
    }
    // The room's old folder, if it is still stopping, saves its state before the new one reads it.
    await this.stopping.get(roomId);
    if (this.folders.has(roomId) || ws.rooms[roomId]?.hidden) return;
    if (!ws.rooms[roomId]) {
      // Name the folder after the room, which needs the room key: wait for it rather than invent a name.
      const name = svc.rooms().find((room) => room.id === roomId)?.name;
      if (!name) {
        this.pendingMounts.add(roomId);
        return;
      }
      this.pendingMounts.delete(roomId);
      const free = this.freeFolder(name);
      if (!free) {
        if (!this.unplaced.has(roomId)) new Notice(`"${name}" can't be shown: no usable folder for it was found. Choose another folder for rooms shared with you in the Vault Rooms settings.`, 12000);
        this.unplaced.add(roomId);
        return;
      }
      ws.rooms[roomId] = { folder: free };
      await this.saveSettings();
    }
    const folderPath = ws.rooms[roomId]!.folder;
    const problem = this.folderProblem(folderPath, [roomId]);
    if (problem) {
      new Notice(`A room can't be shown here: ${problem}`, 10000);
      return;
    }
    if (!this.app.vault.getAbstractFileByPath(folderPath)) await this.app.vault.createFolder(folderPath).catch(() => {});
    // Shown meanwhile (by another call), or this replica was let go meanwhile.
    if (this.folders.has(roomId) || svc.replica(roomId) !== replica) return;
    const presence = new RoomPresence({
      workspaceId: ws.id,
      roomId,
      replica,
      me: svc.secrets.sign,
      publish: (env) => void svc.node.publish(env),
      userOf: (deviceId) => {
        const device = svc.state.devices[deviceId];
        const user = device ? svc.state.users[device.user] : undefined;
        return device && user ? { id: device.user, name: user.name } : null;
      }
    });
    this.presences.set(roomId, presence);
    const folder = new RoomFolder({
      folder: folderPath,
      replica,
      vault: new ObsidianVault(this.app),
      deviceName: svc.state.devices[svc.me.deviceId]?.name ?? this.defaultDeviceName(),
      isBound: (fileId) => this.editors.isBound(roomId, fileId),
      inOtherRoom: (path) => this.roomAt(path) !== roomId,
      folderGone: () => void this.folderGone(roomId),
      heldBackChanged: () => {
        this.syncEditorsSoon();
        this.changed();
      },
      passed: () => {
        if (this.editorsWaiting) this.syncEditorsSoon();
      },
      healthChanged: () => this.changed(),
      loadState: () => svc.disk.loadRoomState<RoomFolderState>(roomId),
      saveState: (state) => svc.disk.saveRoomState(roomId, state),
      loadSaves: () => svc.disk.loadRoomState(roomId, ".saves"),
      saveSaves: (saves) => svc.disk.saveRoomState(roomId, saves, ".saves"),
      notify: (message) => new Notice(message, 8000),
      log: (message) => console.debug(`Vault Rooms: ${message}`)
    });
    this.folders.set(roomId, folder);
    await folder.start();
    this.syncEditors();
    this.changed();
  }

  /** How a room's folder is syncing here (see RoomFolder.health), or null when it isn't shown here. */
  roomHealth(roomId: string): RoomHealth | null {
    return this.folders.get(roomId)?.health() ?? null;
  }

  /** Try a room's folder again now: what failed, or (if it doesn't sync at all) the whole folder, shown anew. */
  async retryRoom(roomId: string): Promise<void> {
    const folder = this.folders.get(roomId);
    if (!folder?.health().stopped) return folder?.retryNow();
    await this.unmount(roomId);
    const replica = this.service?.replica(roomId);
    if (replica) await this.onReplica(roomId, replica);
  }

  /** Room folders still stopping: a room shown again waits for its old folder to finish (see onReplica). */
  private stopping = new Map<string, Promise<void>>();

  private async unmount(roomId: string): Promise<void> {
    this.editors.unbindRoom(roomId);
    const folder = this.folders.get(roomId);
    this.folders.delete(roomId);
    this.presences.get(roomId)?.destroy();
    this.presences.delete(roomId);
    if (!folder) return;
    const stopped = folder.stop();
    this.stopping.set(roomId, stopped);
    await stopped;
    if (this.stopping.get(roomId) === stopped) this.stopping.delete(roomId);
  }

  /** The room's folder was deleted on this computer: that hides the room here; nothing is deleted for anyone else. */
  private async folderGone(roomId: string): Promise<void> {
    const room = this.settings.mesh.workspace?.rooms[roomId];
    if (!room || room.hidden) return;
    await this.unmount(roomId);
    room.hidden = true;
    await this.saveSettings();
    const name = this.service?.rooms().find((r) => r.id === roomId)?.name ?? room.folder;
    new Notice(`The folder of "${name}" was deleted on this computer. The room stays shared with the others; it just isn't shown in this vault any more. You can show it again from the Vault Rooms panel.`, 12000);
    this.changed();
  }

  /** A room this device created didn't survive a conflict: free its folder. */
  private async forgetFolder(roomId: string): Promise<void> {
    const ws = this.settings.mesh.workspace;
    if (!ws?.rooms[roomId] || this.service?.state.rooms[roomId]) return;
    await this.unmount(roomId);
    delete ws.rooms[roomId];
    await this.saveSettings();
    this.changed();
  }

  private retryPendingMounts(): void {
    const svc = this.service;
    for (const roomId of [...this.pendingMounts]) {
      const replica = svc?.replica(roomId);
      if (!replica) this.pendingMounts.delete(roomId);
      else if (svc!.rooms().find((room) => room.id === roomId)?.name) void this.onReplica(roomId, replica);
    }
  }

  private folderFor(path: string): { roomId: string; folder: RoomFolder } | null {
    const roomId = this.roomAt(path);
    const folder = roomId ? this.folders.get(roomId) : undefined;
    return roomId && folder && !this.pausedFolders.has(roomId) ? { roomId, folder } : null;
  }

  private onVaultWrite(file: TAbstractFile): void {
    if (file instanceof TFile) void this.folderFor(file.path)?.folder.onLocalWrite(file.path);
  }

  private onVaultDelete(file: TAbstractFile): void {
    if (file instanceof TFile) return void this.folderFor(file.path)?.folder.onLocalDelete(file.path);
    for (const [roomId, folder] of this.roomFolders()) if (isWithin(folder, file.path)) void this.folderGone(roomId);
  }

  private onVaultRename(file: TAbstractFile, oldPath: string): void {
    if (file instanceof TFolder) return void this.onFolderRename(file.path, oldPath);
    // Part of a whole room folder being moved (its folder isn't where it was): the folder's own event decides.
    const fromRoom = this.roomAt(oldPath);
    if (fromRoom && !(this.app.vault.getAbstractFileByPath(this.folderOf(fromRoom)!) instanceof TFolder)) return;
    const from = this.folderFor(oldPath);
    const to = this.folderFor(file.path);
    if (from && to && from.roomId === to.roomId) return void from.folder.onLocalRename(oldPath, file.path);
    // Between rooms, or in or out of one: a deletion in one and a new file in the other.
    if (from) void from.folder.onLocalDelete(oldPath);
    if (to) void to.folder.onLocalWrite(file.path);
    this.syncEditors();
  }

  /**
   * A folder was renamed or moved. A room's folder (or one holding room folders) is followed, ignoring the per-file
   * events the move produces; a move that would put one room inside another, or a room's folder somewhere it can't
   * be shared, is undone.
   */
  private async onFolderRename(newPath: string, oldPath: string): Promise<void> {
    const ws = this.settings.mesh.workspace;
    if (!ws) return;
    const moved = Object.entries(ws.rooms).filter(([, room]) => !room.hidden && isWithin(room.folder, oldPath));
    if (moved.length === 0) return;
    const problem = moved.map(([, room]) => this.folderProblem(newPath + room.folder.slice(oldPath.length), moved.map(([id]) => id))).find((p) => p !== null);
    if (problem) {
      new Notice(`That move was undone: ${problem}`, 10000);
      const folder = this.app.vault.getAbstractFileByPath(newPath);
      if (folder) await this.app.fileManager.renameFile(folder, oldPath).catch(() => {});
      return;
    }
    for (const [roomId, room] of moved) {
      const replica = this.service?.replica(roomId);
      this.pausedFolders.add(roomId);
      await this.unmount(roomId);
      room.folder = newPath + room.folder.slice(oldPath.length);
      await this.saveSettings();
      // Let the file events of the move pass before watching again.
      window.setTimeout(() => {
        this.pausedFolders.delete(roomId);
        if (replica) void this.onReplica(roomId, replica);
      }, 800);
    }
  }

  /**
   * An editor's change couldn't be shared. In a room you may only read, the note goes back to the shared version.
   * Otherwise (too large, the room's storage full) the editor keeps its text and stops co-editing: the note's file is
   * then handled like any change that can't be shared (kept, never overwritten).
   */
  private onLocalRefused(roomId: string, docId: string, code: string): void {
    // Called from inside the editor's own update: act once it is over.
    window.setTimeout(() => this.handleRefused(roomId, docId, code), 0);
  }

  private handleRefused(roomId: string, docId: string, code: string): void {
    const replica = this.service?.replica(roomId);
    if (!replica) return;
    if (code === "read_only") {
      replica.reload(docId);
      this.folders.get(roomId)?.remoteChanged(docId);
      return this.syncEditorsSoon();
    }
    this.folders.get(roomId)?.holdBackNote(docId);
    this.editors.unbindNote(roomId, docId);
    replica.reload(docId);
    this.syncEditorsSoon();
    new Notice("That change couldn't be shared (the note may be too large, or the room's storage is full). The note stays as it is on this computer.", 10000);
  }

  // ---- editors ----

  private bindTarget(path: string): BindTarget | null {
    const hit = this.folderFor(path);
    const replica = hit ? this.service?.replica(hit.roomId) : null;
    const presence = hit ? this.presences.get(hit.roomId) : null;
    if (!hit || !replica || !presence) return null;
    const fileId = hit.folder.noteIdAt(path);
    if (!fileId) return null;
    return {
      roomId: hit.roomId,
      fileId,
      ytext: replica.noteDoc(fileId).getText("content"),
      presence,
      readOnly: !replica.canWrite(),
      fromShared: (hash) => hit.folder.fromShared(fileId, hash),
      complete: replica.isComplete(fileId)
    };
  }

  private syncTimer: number | null = null;

  /** Coalesce sync requests (editors get new states in bursts while Obsidian opens files). */
  syncEditorsSoon(delayMs = 30): void {
    if (this.syncTimer !== null) return;
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.syncEditors();
    }, delayMs);
  }

  private syncing = false;
  /** An editor showing a room's note isn't bound yet: try again after the room folder's next pass. */
  private editorsWaiting = false;

  /** Bind every open editor of a room's note; an editor not bound yet is compared with its file's text first. */
  syncEditors(): void {
    if (this.syncing) return this.syncEditorsSoon();
    this.syncing = true;
    void this.collectEditors()
      .then((open) => {
        this.editors.sync(open);
        this.editorsWaiting = open.some(({ path, view }) => this.folderFor(path) !== null && this.editors.needsBinding(view));
      })
      .finally(() => (this.syncing = false));
  }

  private async collectEditors(): Promise<Array<{ path: string; view: EditorView; disk: string | null }>> {
    const open: Array<{ path: string; view: EditorView; disk: string | null }> = [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (!cm) continue;
      const needsDisk = this.editors.needsBinding(cm) && this.folderFor(view.file.path) !== null;
      const disk = needsDisk ? await this.app.vault.cachedRead(view.file).then(normalizeNote, () => null) : null;
      open.push({ path: view.file.path, view: cm, disk });
    }
    return open;
  }
}
