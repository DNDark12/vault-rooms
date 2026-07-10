import { Modal, Notice, Setting } from "obsidian";
import qrcode from "qrcode-generator";
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
    this.renderQrCode(contentEl);
    contentEl.createEl("p", { text: "Full details (server URL, token, link):" });
    contentEl.createEl("textarea", { text: this.inviteText }).setAttr("style", "width: 100%; min-height: 100px;");
    new Setting(contentEl).addButton((button) => button.setButtonText("Close").onClick(() => this.close()));
  }

  /** Encodes the same joinUrl already shown above - purely a client-side rendering convenience
   *  (e.g. for a teammate sitting nearby to scan with their phone and forward the link to their
   *  own desktop) - encodes no server/network info beyond what's already in the plaintext link
   *  above, so it doesn't add any new fingerprinting/privacy surface. Parses the library's SVG
   *  output into a real element via DOMParser instead of innerHTML, even though createSvgTag()
   *  only emits numeric rect coordinates here (no alt/title options passed, so no text from
   *  joinUrl ever reaches the markup) - avoids the injection footgun entirely rather than relying
   *  on that being true forever. */
  private renderQrCode(contentEl: HTMLElement): void {
    const qr = qrcode(0, "M");
    qr.addData(this.joinUrl);
    qr.make();
    const wrapper = contentEl.createDiv();
    wrapper.setAttr("style", "margin-bottom: 12px;");
    wrapper.createEl("p", { text: "Or have them scan this with their phone and forward it to their computer:" });
    const qrContainer = wrapper.createDiv();
    qrContainer.setAttr("style", "display: inline-block; background: #fff; padding: 8px; border-radius: 4px;");
    const svgMarkup = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    const svgElement = new DOMParser().parseFromString(svgMarkup, "image/svg+xml").documentElement;
    qrContainer.appendChild(qrContainer.doc.importNode(svgElement, true));
  }
}
