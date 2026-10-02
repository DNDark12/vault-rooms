import { Modal, Notice, Setting } from "obsidian";
import { assertPortablePath } from "@vault-rooms/protocol";
import { userFacingError } from "../errorMessages.js";
import type VaultRoomsPlugin from "../main.js";
import { PANEL_COPY } from "../views/panelCopy.js";
import type { PausedPathGroup } from "../views/pausedPathModel.js";
import { confirmModal } from "./ConfirmModal.js";

export class PausedPathsModal extends Modal {
  private busy = false;
  private error?: string;
  private readonly draftPaths = new Map<string, string>();

  constructor(private readonly plugin: VaultRoomsPlugin, private readonly roomId: string) {
    super(plugin.app);
  }

  async onOpen(): Promise<void> {
    this.setTitle(PANEL_COPY.pausedPaths.heading);
    await this.run(() => this.plugin.refreshRoomPausedPaths(this.roomId));
  }

  private render(): void {
    this.contentEl.empty();
    if (this.error) this.contentEl.createDiv({ cls: "vault-rooms-alert is-error", text: this.error });
    const groups = this.plugin.listRoomPausedPaths(this.roomId);
    if (groups.length === 0) {
      this.contentEl.createDiv({ text: PANEL_COPY.pausedPaths.none });
      return;
    }
    for (const group of groups) this.renderGroup(group);
    new Setting(this.contentEl).addButton((button) => {
      button.setButtonText(this.busy ? PANEL_COPY.pausedPaths.retrying : PANEL_COPY.pausedPaths.retry)
        .onClick(() => this.run(() => this.plugin.retryRoomPathRecovery(this.roomId)));
      button.buttonEl.disabled = this.busy;
    });
  }

  private renderGroup(group: PausedPathGroup): void {
    const container = this.contentEl.createDiv({ cls: "vault-rooms-choice-list" });
    for (const path of group.paths) container.createEl("code", { text: path });
    const copy = group.reason === "server-collision" ? PANEL_COPY.pausedPaths.serverCollision
      : group.reason === "local-collision" ? PANEL_COPY.pausedPaths.localCollision : PANEL_COPY.pausedPaths.recoveryPending;
    container.createDiv({ text: copy });
    if (group.error) container.createDiv({ cls: "vault-rooms-alert is-error", text: group.error });
    if (group.reason === "server-collision") {
      const room = this.plugin.visibleRooms.find((candidate) => candidate.id === this.roomId);
      if (room && room.ownerUserId === this.plugin.getActiveServer()?.userId) {
        new Setting(container).addButton((button) => {
          button.setButtonText(PANEL_COPY.pausedPaths.ownerRepair)
            .onClick(() => this.plugin.openRoomSettingsModal(room));
          button.buttonEl.disabled = this.busy;
        });
      } else {
        container.createDiv({ text: PANEL_COPY.pausedPaths.askOwner });
      }
      return;
    }
    if (group.pendingIntentCount > 0) {
      container.createDiv({ text: PANEL_COPY.pausedPaths.ambiguousJournal });
    }
    if (group.reason === "local-collision" || group.pendingIntentCount > 0) {
      new Setting(container).addButton((button) => {
        button.setButtonText(PANEL_COPY.pausedPaths.preserveReload).onClick(async () => {
          if (await confirmModal(this.app, PANEL_COPY.pausedPaths.preserveReload,
            PANEL_COPY.pausedPaths.preserveReloadConfirm, PANEL_COPY.pausedPaths.preserveReload)) {
            await this.run(() => this.plugin.abandonRoomPathIntents(this.roomId, group.key));
          }
        });
        button.buttonEl.disabled = this.busy;
      });
    }
    if (group.pendingIntentCount > 0) return;
    if (group.reason !== "local-collision") return;
    for (const path of group.paths) {
      const setting = new Setting(container).setName(PANEL_COPY.pausedPaths.exactPath).setDesc(path);
      setting.addText((text) => {
        text.setPlaceholder(PANEL_COPY.pausedPaths.newPath).setValue(this.draftPaths.get(path) ?? "")
          .onChange((value) => this.draftPaths.set(path, value));
        text.inputEl.setAttribute("aria-label", `${PANEL_COPY.pausedPaths.newPath}: ${path}`);
        text.inputEl.disabled = this.busy;
      });
      setting.addButton((button) => {
        button.setButtonText(this.busy ? PANEL_COPY.pausedPaths.localRenaming : PANEL_COPY.pausedPaths.localRename)
          .onClick(() => this.run(async () => {
            const newPath = this.draftPaths.get(path) ?? "";
            assertPortablePath(newPath);
            await this.plugin.repairLocalRoomPath(this.roomId, path, newPath);
            new Notice(PANEL_COPY.pausedPaths.localRenamed);
          }));
        button.buttonEl.disabled = this.busy;
      });
    }
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = undefined;
    this.render();
    try {
      await action();
    } catch (error) {
      this.error = userFacingError(error, PANEL_COPY.pausedPaths.recoveryFailed);
      new Notice(this.error);
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
