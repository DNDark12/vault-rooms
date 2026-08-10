import { Modal, Notice, Setting } from "obsidian";
import type VaultRoomsPlugin from "../main.js";
import type { ServerConnection } from "../settings.js";
import { userFacingError } from "../errorMessages.js";

export class UpdateServerAddressModal extends Modal {
  private address: string;

  constructor(
    private readonly plugin: VaultRoomsPlugin,
    private readonly server: ServerConnection,
    private readonly onUpdated?: () => void
  ) {
    super(plugin.app);
    this.address = server.baseUrl;
  }

  onOpen(): void {
    this.setTitle("Update server address");
    this.contentEl.createEl("p", {
      text: "This keeps the same login, rooms, mounts, and access. A hostname must already resolve on this LAN; entering one here does not create it."
    });
    new Setting(this.contentEl)
      .setName("New address")
      .setDesc("Enter a hostname, IP address, or full base URL. The existing protocol and port are kept when omitted.")
      .addText((text) =>
        text
          .setPlaceholder("My-Mac.local")
          .setValue(this.address)
          .onChange((value) => (this.address = value.trim()))
      );
    new Setting(this.contentEl).addButton((button) =>
      button.setButtonText("Cancel").onClick(() => this.close())
    ).addButton((button) =>
      button.setCta().setButtonText("Verify and update").onClick(async () => {
        try {
          await this.plugin.updateServerAddress(this.server.id, this.address);
          this.onUpdated?.();
          this.close();
        } catch (error) {
          new Notice(addressUpdateError(error, this.address));
        }
      })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function addressUpdateError(error: unknown, address: string): string {
  const message = userFacingError(error, "Could not update the server address.");
  if (!/couldn't be looked up/i.test(message)) return message;
  let hostname = address.trim();
  try {
    hostname = new URL(hostname.includes("://") ? hostname : `https://${hostname}`).hostname;
  } catch {
    // Keep the user's input in the error.
  }
  return `${hostname} could not be found. Use the host computer's existing Local Hostname or its current LAN IP.`;
}
