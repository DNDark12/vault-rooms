import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import { cleanName } from "@vault-rooms/secure";
import { PORT_SPAN, type MeshService } from "../mesh/meshService.js";
import type VaultRoomsPlugin from "../plugin.js";
import { confirmAction, CreateWorkspaceModal, JoinModal } from "./modals.js";

/** What leaving means, with a warning when this is the only computer of the only admin. */
export function leaveWarning(svc: MeshService | null): string {
  const base = "Leave on this computer? Others keep working; this computer stops syncing, and its workspace data and keys are deleted. Your files stay.";
  return svc?.isLastAdminDevice()
    ? `${base}\n\nYou are the workspace's only admin, and this is your only computer in it: after you leave, nobody can invite people, remove anyone or change the workspace's settings. Make someone else an admin first.`
    : base;
}

export class RoomsSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: VaultRoomsPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const svc = this.plugin.service;
    const ws = this.plugin.settings.mesh.workspace;
    if (!ws) {
      new Setting(containerEl)
        .setName("Workspace")
        .setDesc("This vault doesn't belong to a workspace yet.")
        .addButton((button) => button.setButtonText("Create").onClick(() => new CreateWorkspaceModal(this.plugin).open()))
        .addButton((button) => button.setButtonText("Join with an invite link").onClick(() => new JoinModal(this.plugin).open()));
      return;
    }
    const state = svc?.state;
    new Setting(containerEl).setName("Workspace").setDesc(state ? `${state.name} · you are ${state.users[ws.userId]?.name ?? "?"} on ${state.devices[ws.deviceId]?.name ?? "this computer"}` : "Not running.");
    // Whatever stopped the workspace, or sharing, from starting: shown until it starts.
    if (this.plugin.serviceError)
      new Setting(containerEl)
        .setName("Not syncing")
        .setDesc(this.plugin.serviceError)
        .addButton((button) =>
          button.setButtonText("Try again").onClick(async () => {
            button.setDisabled(true);
            await this.plugin.restartService();
            this.display();
          })
        );

    if (svc && svc.isMember()) {
      new Setting(containerEl).setName("Your name").addText((text) => {
        text.setValue(state!.users[ws.userId]?.name ?? "");
        text.inputEl.addEventListener("change", () => {
          const name = cleanName(text.getValue());
          if (name) void this.apply(() => svc.renameUser(ws.userId, name));
        });
      });
      if (svc.isAdmin()) {
        new Setting(containerEl)
          .setName("Who may share folders as rooms")
          .addDropdown((dropdown) =>
            dropdown
              .addOptions({ admins: "Admins only", members: "Everyone in the workspace" })
              .setValue(state!.roomCreation)
              .onChange((value) => void this.apply(() => svc.setRoomCreation(value as "admins" | "members")))
          );
      }
    }

    new Setting(containerEl)
      .setName("Folder for rooms shared with you")
      .setDesc("New rooms you're added to appear here, each in its own folder. You can move a room's folder later.")
      .addText((text) => {
        text.setValue(this.plugin.settings.mountRoot);
        text.inputEl.addEventListener("change", async () => {
          const value = text.getValue().trim() || "Rooms";
          const problem = this.plugin.mountRootProblem(value);
          if (problem) {
            new Notice(problem, 8000);
            text.setValue(this.plugin.settings.mountRoot);
            return;
          }
          this.plugin.settings.mountRoot = value;
          await this.plugin.saveSettings();
          this.plugin.retryUnplaced();
        });
      });

    new Setting(containerEl)
      .setName("Port")
      .setDesc(`The first port other computers connect to: the first free one of it and the next ${PORT_SPAN - 1} is used${svc?.listeningPort ? ` (now ${svc.listeningPort})` : ""}, never another. Every computer needs an inbound firewall rule for Obsidian on these ports (local network only). Takes effect after restarting Obsidian.`)
      .addText((text) =>
        text.setValue(String(ws.port)).onChange(async (value) => {
          const port = Number(value);
          if (!Number.isInteger(port) || port < 1024 || port > 65535 - PORT_SPAN + 1) return;
          ws.port = port;
          delete ws.boundPort;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Computers to connect to by address")
      .setDesc("Only needed where automatic discovery doesn't reach (multicast blocked): one host:port per line.")
      .addTextArea((text) =>
        text.setValue(ws.peers.join("\n")).onChange(async (value) => {
          ws.peers = value
            .split(/\s+/)
            .map((line) => line.trim())
            .filter(Boolean);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Leave the workspace on this computer")
      .setDesc("Deletes the workspace data and this computer's keys from this vault. Your files stay but no longer sync. To join again you need a new invite.")
      .addButton((button) =>
        button
          .setButtonText("Leave")
          .setWarning()
          .onClick(async () => {
            if (!(await confirmAction(this.app, "Leave the workspace", leaveWarning(svc), "Leave"))) return;
            await this.plugin.leaveWorkspace();
            this.display();
          })
      );
  }

  private async apply(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      new Notice("Saved.");
    } catch (error) {
      new Notice((error as Error).message, 8000);
    }
  }
}
