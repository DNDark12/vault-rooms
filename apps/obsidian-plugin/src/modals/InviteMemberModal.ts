import { Modal, Notice, Setting } from "obsidian";
import type VaultRoomsPlugin from "../main.js";

export class InviteMemberModal extends Modal {
  constructor(
    private readonly plugin: VaultRoomsPlugin,
    private readonly inviteText: string,
    private readonly joinUrl: string
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("Invite member");
    contentEl.createEl("p", {
      text: "Send this link to a teammate on the same LAN. Clicking it opens Obsidian and pre-fills the join form (Vault Rooms plugin must already be installed on their side)."
    });
    const linkInput = contentEl.createEl("textarea", { text: this.joinUrl });
    linkInput.readOnly = true;
    linkInput.setAttr("style", "width: 100%; min-height: 68px; margin-bottom: 12px;");
    new Setting(contentEl).addButton((button) =>
      button.setButtonText("Select invite link").onClick(() => {
        linkInput.focus();
        linkInput.select();
        new Notice("Invite link selected.");
      })
    );
    contentEl.createEl("p", { text: "Full details (server URL, token, link):" });
    contentEl.createEl("textarea", { text: this.inviteText }).setAttr("style", "width: 100%; min-height: 100px;");
    new Setting(contentEl).addButton((button) => button.setButtonText("Close").onClick(() => this.close()));
  }
}
