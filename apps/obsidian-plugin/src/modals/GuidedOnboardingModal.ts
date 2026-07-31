import { Modal, Notice, Platform, Setting } from "obsidian";
import type { InviteLinkResponse, RoomSummary } from "../apiClient.js";
import { userFacingError } from "../errorMessages.js";
import { copyInviteLinkFromNavigator } from "../inviteClipboard.js";
import { classifyLanAddress, type LanAddressVerdict } from "../lanAddress.js";
import type VaultRoomsPlugin from "../main.js";
import {
  HOSTING_STATUS_COPY,
  ONBOARDING_STEPS,
  completedOnboardingSteps,
  desktopPlatform,
  firstIncompleteOnboardingStep,
  hasDurableOnboardingConnection,
  inviteTextForView,
  lanAddressHelp,
  onboardingCopyForStep,
  recommendedRoomInput,
  shouldExpandAddressHelp,
  type InviteView,
  type OnboardingStep,
  type OnboardingTerminalExit
} from "../onboarding.js";
import { defaultDeviceName } from "./deviceName.js";
import { VaultPathSuggestModal } from "./pickers.js";

const STEP_ORDER: readonly OnboardingStep[] = ["connection", "profile", "room", "invite"];

export class GuidedOnboardingModal extends Modal {
  private step: OnboardingStep = "connection";
  private lanAddress: string;
  private displayName = "";
  private selectedFolder = "";
  private roomName = "";
  private createdRoom?: RoomSummary;
  private invite?: InviteLinkResponse;
  private connectionVerdict?: LanAddressVerdict;
  private connectionProblem = "";
  private addressHelpExpanded: boolean;
  private access: "reader" | "editor" = "editor";
  private inviteView: InviteView = "message";
  private inviteTextarea?: HTMLTextAreaElement;
  private terminalExit?: OnboardingTerminalExit;
  private isOpen = false;
  private isLoading = false;
  private error = "";
  private readonly redirectToInvitePicker: boolean;

  constructor(private readonly plugin: VaultRoomsPlugin) {
    super(plugin.app);
    this.lanAddress = plugin.settings.server.publicUrlOverride?.trim() ?? "";
    this.addressHelpExpanded = shouldExpandAddressHelp(plugin.settings.server);
    const manageableRooms = plugin.visibleRooms.filter((room) => plugin.canManageRoom(room));
    this.redirectToInvitePicker = manageableRooms.length > 1;
    if (manageableRooms.length === 1) {
      this.createdRoom = manageableRooms[0];
    }
    this.step = firstIncompleteOnboardingStep({
      connectionConfigured: hasDurableOnboardingConnection(plugin.settings.server),
      ownerReady: plugin.hasOwnServer(),
      roomReady: this.createdRoom !== undefined
    });
  }

  onOpen(): void {
    this.isOpen = true;
    if (this.redirectToInvitePicker) {
      this.close();
      this.plugin.openCreateInviteModal();
      return;
    }
    this.render();
  }

  onClose(): void {
    this.isOpen = false;
    this.inviteTextarea = undefined;
    this.contentEl.empty();
  }

  private render(): void {
    if (this.step === "connection") {
      this.renderConnection();
      return;
    }
    if (this.step === "profile") {
      this.renderProfile();
      return;
    }
    if (this.step === "room") {
      this.renderRoom();
      return;
    }
    this.renderInvite();
  }

  private prepareScreen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("vault-rooms-onboarding");
    this.renderProgress();
    this.renderHostingStatus();
  }

  private renderProgress(): void {
    const completed = new Set(
      completedOnboardingSteps({ step: this.step, terminalExit: this.terminalExit })
    );
    const list = this.contentEl.createEl("ol", {
      cls: "vault-rooms-onboarding-steps",
      attr: { "aria-label": "Setup progress" }
    });
    for (const [index, label] of ONBOARDING_STEPS.entries()) {
      const step = STEP_ORDER[index]!;
      const item = list.createEl("li", {
        cls: completed.has(step) ? "is-complete" : step === this.step ? "is-current" : "",
        text: `${completed.has(step) ? "✓ " : ""}${index + 1}. ${label}`
      });
      if (step === this.step) {
        item.setAttr("aria-current", "step");
      }
    }
  }

  private renderHostingStatus(): void {
    const hasSavedAddress = Boolean(this.plugin.settings.server.publicUrlOverride?.trim());
    const status =
      this.terminalExit === "recovery"
        ? HOSTING_STATUS_COPY.recovery
        : this.invite !== undefined
          ? HOSTING_STATUS_COPY.ready
          : this.step === "connection" && !this.isLoading && !this.connectionVerdict && !hasSavedAddress
            ? HOSTING_STATUS_COPY.notSetUp
            : HOSTING_STATUS_COPY.inProgress;
    this.contentEl.createEl("p", { cls: "vault-rooms-status", text: status });
  }

  private renderConnection(): void {
    const copy = onboardingCopyForStep("connection");
    this.prepareScreen();
    this.setTitle(copy.title);

    new Setting(this.contentEl).setName(copy.fieldLabel).addText((text) => {
      text
        .setPlaceholder("192.168.1.100")
        .setValue(this.lanAddress)
        .setDisabled(this.isLoading)
        .onChange((value) => {
          this.lanAddress = value.trim();
          this.connectionVerdict = undefined;
          this.connectionProblem = "";
        });
    });
    if (this.connectionProblem) {
      this.contentEl.createDiv({
        cls: "vault-rooms-field-error",
        text: this.connectionProblem
      });
    }

    const helpButton = this.contentEl.createEl("button", {
      cls: "vault-rooms-onboarding-help",
      text: copy.helpAction,
      attr: {
        type: "button",
        "aria-expanded": String(this.addressHelpExpanded)
      }
    });
    helpButton.disabled = this.isLoading;
    helpButton.onClickEvent(() => {
      this.addressHelpExpanded = !this.addressHelpExpanded;
      this.render();
    });
    if (this.addressHelpExpanded) {
      this.contentEl.createEl("p", {
        cls: "setting-item-description",
        text: lanAddressHelp(desktopPlatform(Platform))
      });
    }

    const visibleAddressVerdict =
      this.connectionVerdict ??
      (this.lanAddress ? classifyLanAddress(this.lanAddress) : undefined);
    if (visibleAddressVerdict?.warning) {
      this.contentEl.createEl("p", {
        cls: "vault-rooms-onboarding-warning",
        text: visibleAddressVerdict.warning
      });
    }
    if (this.connectionVerdict?.problem) {
      this.contentEl.createDiv({
        cls: "vault-rooms-field-error",
        text: this.connectionVerdict.problem
      });
    }
    if (this.connectionVerdict) {
      this.contentEl.createEl("p", {
        cls: "vault-rooms-onboarding-ready",
        text: copy.readyStatus
      });
      this.contentEl.createEl("p", {
        cls: "setting-item-description",
        text: "This computer can reach the saved address. A teammate's firewall or Wi-Fi settings can still block their connection."
      });
    }
    this.renderError();

    const label = this.isLoading
      ? copy.pendingAction
      : this.connectionVerdict?.class === "link-local"
        ? copy.cautiousContinueAction
        : this.connectionVerdict
          ? copy.continueAction
          : copy.primaryAction;
    this.renderPrimaryAction(label, () => this.handleConnectionAction());
  }

  private async handleConnectionAction(): Promise<void> {
    const copy = onboardingCopyForStep("connection");
    if (this.connectionVerdict) {
      await this.run(async () => {
        if (this.connectionVerdict?.class === "link-local") {
          await this.plugin.confirmOnboardingConnection();
        }
        const status = this.plugin.getServerStatus();
        if (!this.plugin.hasOwnServer() && status.running && status.bootstrapped) {
          this.terminalExit = "recovery";
          this.render();
          this.close();
          this.plugin.openOwnerRecoveryModal();
          return;
        }
        this.step = "profile";
      }, "Could not finish connection setup");
      return;
    }

    const preflightVerdict = classifyLanAddress(this.lanAddress);
    if (!preflightVerdict.usableForTeammates) {
      this.connectionProblem =
        preflightVerdict.problem ?? "Enter this computer's address on your network.";
      this.render();
      return;
    }
    await this.run(async () => {
      this.connectionVerdict = await this.plugin.configureOnboardingConnection(this.lanAddress);
    }, copy.errorFallback);
  }

  private renderProfile(): void {
    const copy = onboardingCopyForStep("profile");
    this.prepareScreen();
    this.setTitle(copy.title);

    new Setting(this.contentEl).setName(copy.fieldLabel).addText((text) => {
      text
        .setValue(this.displayName)
        .setDisabled(this.isLoading)
        .onChange((value) => {
          this.displayName = value.trim();
        });
    });
    new Setting(this.contentEl)
      .setName(copy.deviceLabel)
      .setDesc(defaultDeviceName());
    this.renderError();
    this.renderPrimaryAction(
      this.isLoading ? copy.pendingAction : copy.primaryAction,
      async () => {
        if (!this.displayName) {
          this.error = "Enter the name your teammates should see.";
          this.render();
          return;
        }
        await this.run(async () => {
          const status = this.plugin.getServerStatus();
          if (!this.plugin.hasOwnServer() && status.running && status.bootstrapped) {
            this.terminalExit = "recovery";
            this.render();
            this.close();
            this.plugin.openOwnerRecoveryModal();
            return;
          }
          if (this.plugin.hasOwnServer()) {
            this.step = "room";
            return;
          }
          await this.plugin.setupServer(this.displayName, defaultDeviceName());
          this.step = "room";
        }, copy.errorFallback);
      }
    );
  }

  private renderRoom(): void {
    const copy = onboardingCopyForStep("room");
    this.prepareScreen();
    this.setTitle(copy.title);

    new Setting(this.contentEl)
      .setName(copy.chooseFolderAction)
      .setDesc("Choose a folder inside this vault.")
      .addButton((button) =>
        button
          .setButtonText(copy.chooseFolderAction)
          .setDisabled(this.isLoading)
          .onClick(() => {
            new VaultPathSuggestModal(this.app, "folder", (path) => {
              this.selectedFolder = path;
              this.roomName = recommendedRoomInput(path).name;
              this.error = "";
              this.render();
            }).open();
          })
      );
    if (this.selectedFolder) {
      new Setting(this.contentEl)
        .setName(copy.selectedFolderLabel)
        .setDesc(this.selectedFolder);
      new Setting(this.contentEl).setName(copy.fieldLabel).addText((text) =>
        text
          .setValue(this.roomName)
          .setDisabled(this.isLoading)
          .onChange((value) => {
            this.roomName = value.trim();
          })
      );
    }
    this.renderError();
    this.renderPrimaryAction(
      this.isLoading ? copy.pendingAction : copy.primaryAction,
      async () => {
        if (!this.selectedFolder) {
          this.error = "Choose the folder you want to share.";
          this.render();
          return;
        }
        if (!this.roomName) {
          this.error = "Enter a room name.";
          this.render();
          return;
        }
        await this.run(async () => {
          this.createdRoom = await this.plugin.createRoom(
            recommendedRoomInput(this.selectedFolder, this.roomName)
          );
          this.step = "invite";
        }, copy.errorFallback);
      },
      !this.selectedFolder
    );
  }

  private renderInvite(): void {
    const copy = onboardingCopyForStep("invite");
    this.prepareScreen();
    this.setTitle(copy.title);
    this.renderInviteSummary(copy.summaryLabels);

    if (!this.invite) {
      new Setting(this.contentEl).setName(copy.fieldLabel).addDropdown((dropdown) =>
        dropdown
          .addOption("editor", copy.accessLabels.editor)
          .addOption("reader", copy.accessLabels.reader)
          .setValue(this.access)
          .setDisabled(this.isLoading)
          .onChange((value) => {
            this.access = value as "reader" | "editor";
          })
      );
      this.renderError();
      this.renderPrimaryAction(
        this.isLoading ? copy.pendingAction : copy.primaryAction,
        () =>
          this.run(async () => {
            this.invite = await this.plugin.issueRoomInvite(this.createdRoom!.id, this.access);
            this.inviteView = "message";
          }, copy.errorFallback)
      );
      this.renderSecondaryAction(copy.laterAction, () => {
        this.terminalExit = "invite-later";
        this.close();
      });
      return;
    }

    const joinUrl = this.invite.joinUrl;
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: copy.inviteNote
    });
    const visibleInviteText = inviteTextForView(joinUrl, this.inviteView);
    this.inviteTextarea = this.contentEl.createEl("textarea", {
      cls: "vault-rooms-invite-link",
      text: visibleInviteText
    });
    this.inviteTextarea.readOnly = true;
    this.renderError();

    this.renderPrimaryAction(copy.copyMessageAction, () => this.copyInviteText("message"));
    this.renderSecondaryAction(copy.copyLinkAction, () => this.copyInviteText("link"));
    this.renderSecondaryAction(copy.selectAction, this.selectInviteText);
    this.renderSecondaryAction(copy.newLinkAction, () =>
      this.run(async () => {
        this.invite = await this.plugin.issueRoomInvite(this.createdRoom!.id, this.access);
        this.inviteView = "message";
      }, copy.errorFallback)
    );
    this.contentEl.createEl("p", {
      cls: "vault-rooms-onboarding-done",
      text: copy.doneNote
    });
  }

  private renderInviteSummary(labels: readonly string[]): void {
    const values = [
      this.plugin.settings.server.publicUrlOverride?.trim() ?? "",
      this.plugin.getActiveServer()?.userDisplayName ?? this.displayName,
      this.createdRoom?.name ?? this.roomName
    ];
    const list = this.contentEl.createEl("dl", { cls: "vault-rooms-onboarding-summary" });
    labels.forEach((label, index) => {
      list.createEl("dt", { text: label });
      list.createEl("dd", { text: values[index] ?? "" });
    });
  }

  private async copyInviteText(view: InviteView): Promise<void> {
    if (this.isLoading || !this.invite) return;
    this.inviteView = view;
    this.render();
    const text = inviteTextForView(this.invite.joinUrl, view);
    if (await copyInviteLinkFromNavigator(text, this.selectInviteText)) {
      new Notice(view === "message" ? "Invite message copied." : "Invite link copied.");
    }
  }

  private readonly selectInviteText = (): void => {
    if (!this.inviteTextarea) return;
    this.inviteTextarea.focus();
    this.inviteTextarea.select();
    new Notice("Invite text selected.");
  };

  private renderPrimaryAction(
    label: string,
    onClick: () => void | Promise<void>,
    disabled = false
  ): void {
    const setting = new Setting(this.contentEl);
    setting.addButton((button) =>
      button
        .setCta()
        .setButtonText(label)
        .setDisabled(this.isLoading || disabled)
        .onClick(onClick)
    );
  }

  private renderSecondaryAction(
    label: string,
    onClick: () => void | Promise<void>
  ): void {
    const button = this.contentEl.createEl("button", {
      cls: "vault-rooms-onboarding-secondary",
      text: label,
      attr: { type: "button" }
    });
    button.disabled = this.isLoading;
    button.onClickEvent(onClick);
  }

  private renderError(): void {
    if (this.error) {
      this.contentEl.createDiv({ cls: "vault-rooms-error", text: this.error });
    }
  }

  private async run(action: () => Promise<void>, fallback: string): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;
    this.error = "";
    this.render();
    try {
      await action();
    } catch (error) {
      this.error = userFacingError(error, fallback);
    } finally {
      this.isLoading = false;
      if (this.isOpen) {
        this.render();
      }
    }
  }
}
