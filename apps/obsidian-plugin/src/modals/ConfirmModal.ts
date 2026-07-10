import { Modal, Setting, type App } from "obsidian";

/** Promise-based replacement for window.confirm() - the plugin review guidelines reject native
 *  confirm dialogs, and a Modal keeps keyboard focus inside Obsidian's own UI. Resolves true only
 *  when the destructive button is clicked; closing the modal any other way resolves false. */
export function confirmModal(app: App, title: string, message: string, ctaText: string): Promise<boolean> {
  return new Promise((resolve) => {
    class ConfirmModal extends Modal {
      private confirmed = false;

      onOpen(): void {
        this.titleEl.setText(title);
        this.contentEl.createEl("p", { text: message });
        new Setting(this.contentEl)
          .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
          .addButton((button) =>
            button
              .setButtonText(ctaText)
              .setWarning()
              .onClick(() => {
                this.confirmed = true;
                this.close();
              })
          );
      }

      onClose(): void {
        this.contentEl.empty();
        resolve(this.confirmed);
      }
    }
    new ConfirmModal(app).open();
  });
}
