import { Modal, Notice, Setting } from "obsidian";
import type VaultRoomsPlugin from "../main.js";
import { defaultDeviceName } from "./deviceName.js";
import { assertPinMaterial, type PinnedInviteInfo } from "../pinnedTransport.js";

export class JoinTeamModal extends Modal {
  private inviteInput = "";
  private serverUrl = "";
  private inviteToken = "";
  private displayName = "";
  private deviceName = "";
  /** True when we already have a real server+token (opened via an invite link) - in that case
   *  there's nothing to parse or re-enter, so the form only needs to ask for a display name. */
  private readonly hasKnownInvite: boolean;
  private showManualForm: boolean;

  constructor(
    private readonly plugin: VaultRoomsPlugin,
    private readonly mode: "join" | "rejoin" = "join",
    serverUrl = "",
    inviteToken = "",
    private pin?: PinnedInviteInfo
  ) {
    super(plugin.app);
    this.serverUrl = serverUrl;
    this.inviteToken = inviteToken;
    this.hasKnownInvite = Boolean(serverUrl && inviteToken);
    this.showManualForm = !this.hasKnownInvite;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.mode === "join" ? "Join Vault Rooms" : "Rejoin Vault Rooms");

    if (this.hasKnownInvite && !this.showManualForm) {
      this.renderKnownInviteForm(contentEl);
      return;
    }
    this.renderManualForm(contentEl);
  }

  /** The common case: opened by clicking an invite link, so server+token are already known - the
   *  only thing genuinely missing is the person's name. */
  private renderKnownInviteForm(contentEl: HTMLElement): void {
    contentEl.createEl("p", { text: `Joining ${this.serverUrl} via invite link. Add your display name to finish.` });
    new Setting(contentEl)
      .setName("Display name")
      .setDesc("This is what teammates will see you as.")
      .addText((text) => {
        text.setValue(this.displayName).onChange((value) => (this.displayName = value.trim()));
        window.setTimeout(() => text.inputEl.focus(), 0);
      });
    new Setting(contentEl)
      .setName("Device name")
      .addText((text) => text.setValue(this.deviceName || defaultDeviceName()).onChange((value) => (this.deviceName = value.trim())));
    new Setting(contentEl).addButton((button) =>
      button.setCta().setButtonText(this.mode === "join" ? "Join" : "Rejoin").onClick(async () => {
        await this.submit();
      })
    );
    new Setting(contentEl).addButton((button) =>
      button.setButtonText("Use a different invite link").onClick(() => {
        this.showManualForm = true;
        this.onOpen();
      })
    );
  }

  /** Fallback for opening this modal without a link already in hand (command palette, or "use a
   *  different invite link") - lets someone paste a full invite link/text or fill fields by hand. */
  private renderManualForm(contentEl: HTMLElement): void {
    if (this.inviteToken) {
      contentEl.createEl("p", { text: "Invite link details filled in below. Add your display name to finish joining." });
    }
    new Setting(contentEl)
      .setName("Invite link")
      .setDesc("Paste a full obsidian://vault-rooms invite link or the raw text a teammate sent you.")
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
      .addText((text) => text.setValue(this.deviceName || defaultDeviceName()).onChange((value) => (this.deviceName = value.trim())));
    new Setting(contentEl).addButton((button) =>
      button.setButtonText("Test connection").onClick(async () => {
        await this.plugin.testConnection(this.serverUrl, this.pin);
      })
    );
    new Setting(contentEl).addButton((button) =>
      button.setCta().setButtonText(this.mode === "join" ? "Join" : "Rejoin").onClick(async () => {
        this.applyInviteInput(false);
        await this.submit();
      })
    );
  }

  private async submit(): Promise<void> {
    try {
      await this.plugin.joinServer(this.serverUrl, this.inviteToken, this.displayName, this.deviceName || "Obsidian desktop", this.pin);
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Join failed");
    }
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
    this.pin = parsed.pin;
    if (render) {
      this.onOpen();
    }
    return true;
  }
}

function parseInviteInput(input: string): { serverUrl?: string; inviteToken?: string; pin?: PinnedInviteInfo } {
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

function parseInviteUrl(input: string): { serverUrl?: string; inviteToken?: string; pin?: PinnedInviteInfo } {
  try {
    const url = new URL(input);
    const security = url.searchParams.get("security");
    const serverId = url.searchParams.get("serverId");
    const tlsName = url.searchParams.get("tlsName");
    const pinnedIdentitySpkiSha256 = url.searchParams.get("fp");
    const identityCertificateDer = url.searchParams.get("idc");
    const pin =
      security === "pinned-tls" && serverId && tlsName && pinnedIdentitySpkiSha256 && identityCertificateDer
        ? { serverId, tlsName, pinnedIdentitySpkiSha256, identityCertificateDer }
        : undefined;
    if (security === "pinned-tls" && !pin) {
      return {};
    }
    if (pin) assertPinMaterial(pin);
    return {
      serverUrl: url.searchParams.get("server") ?? undefined,
      inviteToken: url.searchParams.get("token") ?? url.searchParams.get("inviteToken") ?? undefined,
      pin
    };
  } catch {
    return {};
  }
}
