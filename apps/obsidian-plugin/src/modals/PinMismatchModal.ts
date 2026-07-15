import { Modal, Setting, type App } from "obsidian";
import type { ServerConnection } from "../settings.js";
import { setDestructiveCompat } from "../obsidianCompat.js";

type PinMismatchActions = {
  onJoinWithNewInvite?: () => void;
  onRemoveSavedConnection?: () => Promise<void>;
};

export class PinMismatchModal extends Modal {
  constructor(
    app: App,
    private readonly server: ServerConnection,
    private readonly presentedSpkiSha256: string,
    private readonly actions: PinMismatchActions = {}
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Vault Rooms server identity mismatch");
    this.contentEl.createEl("p", {
      text: "The server presented an identity that is not connected to your saved fingerprint by a valid signed rotation. Sync has been stopped. Verify the fingerprints with the server owner before taking any action."
    });
    new Setting(this.contentEl)
      .setName("Saved connection")
      .setDesc(`${this.server.userDisplayName} / ${this.server.deviceName}`);

    const technicalDetails = this.contentEl.createDiv();
    technicalDetails.hidden = true;
    new Setting(technicalDetails).setName("Server URL").setDesc(this.server.baseUrl);
    new Setting(technicalDetails)
      .setName("Saved fingerprint")
      .setDesc(this.server.pinnedIdentitySpkiSha256 ?? "Unavailable");
    new Setting(technicalDetails).setName("Presented fingerprint").setDesc(this.presentedSpkiSha256);
    new Setting(technicalDetails)
      .setName("Last successful connection")
      .setDesc(this.server.lastSuccessfulConnectionAt ?? "Unavailable");

    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("Join with new invite").onClick(() => {
          this.close();
          this.actions.onJoinWithNewInvite?.();
        })
      )
      .addButton((button) =>
        setDestructiveCompat(button.setButtonText("Remove saved connection"))
          .onClick(async () => {
            await this.actions.onRemoveSavedConnection?.();
            this.close();
          })
      );
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("Show technical details").onClick(() => {
          technicalDetails.hidden = !technicalDetails.hidden;
          button.setButtonText(technicalDetails.hidden ? "Show technical details" : "Hide technical details");
        })
      )
      .addButton((button) => button.setButtonText("Close").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
