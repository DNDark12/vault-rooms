import { Modal, Notice, Setting } from "obsidian";
import type VaultRoomsPlugin from "../main.js";

export class JoinTeamModal extends Modal {
  private inviteInput = "";
  private serverUrl = "";
  private inviteToken = "";
  private displayName = "";
  private deviceName = "";

  constructor(
    private readonly plugin: VaultRoomsPlugin,
    private readonly mode: "join" | "rejoin" = "join",
    serverUrl = "",
    inviteToken = ""
  ) {
    super(plugin.app);
    this.serverUrl = serverUrl;
    this.inviteToken = inviteToken;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.mode === "join" ? "Join Vault Rooms" : "Rejoin Vault Rooms" });
    if (this.inviteToken) {
      contentEl.createEl("p", { text: "Invite link details filled in below. Add your display name to finish joining." });
    }
    new Setting(contentEl)
      .setName("Invite link")
      .addText((text) =>
        text
          .setPlaceholder("obsidian://vault-rooms/join?server=...&token=...")
          .setValue(this.inviteInput)
          .onChange((value) => (this.inviteInput = value.trim()))
      )
      .addButton((button) =>
        button.setButtonText("Parse").onClick(() => {
          if (!this.applyInviteInput(true)) {
            new Notice("Invite link must include server and token.");
          }
        })
      );
    new Setting(contentEl).setName("Server URL").addText((text) => text.setValue(this.serverUrl).onChange((value) => (this.serverUrl = value.trim())));
    new Setting(contentEl).setName("Invite token").addText((text) => text.setValue(this.inviteToken).onChange((value) => (this.inviteToken = value.trim())));
    new Setting(contentEl).setName("Display name").addText((text) => text.setValue(this.displayName).onChange((value) => (this.displayName = value.trim())));
    new Setting(contentEl)
      .setName("Device name")
      .addText((text) => text.setValue(this.deviceName || navigator.platform || "Obsidian desktop").onChange((value) => (this.deviceName = value.trim())));
    new Setting(contentEl).addButton((button) =>
      button.setButtonText("Test connection").onClick(async () => {
        await this.plugin.testConnection(this.serverUrl);
      })
    );
    new Setting(contentEl).addButton((button) =>
      button.setCta().setButtonText(this.mode === "join" ? "Join" : "Rejoin").onClick(async () => {
        try {
          this.applyInviteInput(false);
          await this.plugin.joinServer(this.serverUrl, this.inviteToken, this.displayName, this.deviceName || "Obsidian desktop");
          this.close();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Join failed");
        }
      })
    );
  }

  private applyInviteInput(render: boolean): boolean {
    if (!this.inviteInput) {
      return false;
    }
    const parsed = parseInviteInput(this.inviteInput);
    if (!parsed.serverUrl || !parsed.inviteToken) {
      return false;
    }
    this.serverUrl = parsed.serverUrl;
    this.inviteToken = parsed.inviteToken;
    if (render) {
      this.onOpen();
    }
    return true;
  }
}

function parseInviteInput(input: string): { serverUrl?: string; inviteToken?: string } {
  const text = input.trim();
  const parsed = parseInviteUrl(text);
  if (parsed.serverUrl || parsed.inviteToken) {
    return parsed;
  }
  const inviteToken = text.match(/tr_inv_[A-Za-z0-9_-]+/)?.[0];
  const urls = [...text.matchAll(/https?:\/\/[^\s]+/g)].map((match) => match[0]);
  const serverUrl = urls.find((url) => !url.includes("token=") && !url.includes("tr_inv_")) ?? urls[0];
  return { serverUrl, inviteToken };
}

function parseInviteUrl(input: string): { serverUrl?: string; inviteToken?: string } {
  try {
    const url = new URL(input);
    return {
      serverUrl: url.searchParams.get("server") ?? undefined,
      inviteToken: url.searchParams.get("token") ?? url.searchParams.get("inviteToken") ?? undefined
    };
  } catch {
    return {};
  }
}
