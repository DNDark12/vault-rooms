import { Modal, Notice } from "obsidian";
import { copyInviteLink } from "../inviteClipboard.js";
import type VaultRoomsPlugin from "../main.js";

export class InviteMemberModal extends Modal {
  constructor(
    private readonly plugin: VaultRoomsPlugin,
    private readonly joinUrl: string
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("vault-rooms-invite-modal");
    this.setTitle("Invite member");
    contentEl.createEl("p", {
      cls: "vault-rooms-setting-hint",
      text: "Send this link to a teammate on the same LAN. Clicking it opens Obsidian and pre-fills the join form (Vault Rooms plugin must already be installed on their side)."
    });
    const linkInput = contentEl.createEl("textarea", { text: this.joinUrl });
    linkInput.readOnly = true;
    linkInput.addClass("vault-rooms-invite-link");
    const selectLink = () => {
      linkInput.focus();
      linkInput.select();
      new Notice("Invite link selected.");
    };
    const linkActions = contentEl.createDiv({ cls: "vault-rooms-invite-actions" });
    const copyButton = linkActions.createEl("button", { text: "Copy" });
    copyButton.addClass("mod-cta");
    copyButton.onClickEvent(async () => {
      if (await copyInviteLink(this.joinUrl, navigator.clipboard, selectLink)) {
        new Notice("Invite link copied.");
      }
    });
    linkActions.createEl("button", { text: "Select" }).onClickEvent(selectLink);
    const footer = contentEl.createDiv({ cls: "vault-rooms-invite-actions is-footer" });
    footer.createEl("button", { text: "Close" }).onClickEvent(() => this.close());
  }
}
