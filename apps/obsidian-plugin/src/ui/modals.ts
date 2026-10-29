import { App, Modal, Notice, Setting, TFolder } from "obsidian";
import { cleanName, ROLES, roleIn, type Role } from "@vault-rooms/secure";
import type VaultRoomsPlugin from "../plugin.js";
import { personLabel } from "./labels.js";

const ROLE_LABEL: Record<Role, string> = { read: "Can read", write: "Can edit", manage: "Manages" };

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^forbidden:/, "Not allowed: ");
}

/** Ask before doing something that can't be undone. Resolves true if confirmed. */
export function confirmAction(app: App, title: string, body: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let answered = false;
    modal.titleEl.setText(title);
    for (const paragraph of body.split("\n\n")) modal.contentEl.createEl("p", { text: paragraph });
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => modal.close()))
      .addButton((button) =>
        button
          .setButtonText(action)
          .setWarning()
          .onClick(() => {
            answered = true;
            resolve(true);
            modal.close();
          })
      );
    modal.onClose = () => {
      if (!answered) resolve(false);
    };
    modal.open();
  });
}

/** Said of a room whose managers have no computer left in the workspace (see RoomInfo.managed). */
export const UNMANAGED = "No one can change this room's members any more: its managers have no computer left in the workspace. It keeps syncing for its members; an admin can delete it (its files stay on every computer), and share its folder again as a new room.";

/** Delete a room for everyone, once confirmed (managers and admins may). */
export async function deleteRoom(plugin: VaultRoomsPlugin, roomId: string, done?: () => void): Promise<void> {
  const svc = plugin.service;
  if (!svc) return;
  const name = svc.rooms().find((room) => room.id === roomId)?.name;
  if (!(await confirmAction(plugin.app, "Delete room", `${name ? `"${name}"` : "This room"} is deleted for everyone: its files stay on every computer that has them, but stop syncing, and no one can open the room again. This can't be undone.`, "Delete"))) return;
  try {
    await svc.deleteRoom(roomId);
    done?.();
  } catch (error) {
    new Notice(errorText(error), 8000);
  }
}

export class CreateWorkspaceModal extends Modal {
  constructor(private readonly plugin: VaultRoomsPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("Create a workspace");
    const values = { workspaceName: "Team", userName: "", deviceName: this.plugin.defaultDeviceName() };
    this.contentEl.createEl("p", { text: "A workspace is the group of people you share rooms (folders) with on this network. You'll be its first admin." });
    new Setting(this.contentEl).setName("Workspace name").addText((text) => text.setValue(values.workspaceName).onChange((v) => (values.workspaceName = cleanName(v))));
    new Setting(this.contentEl).setName("Your name").setDesc("How others see you.").addText((text) => text.onChange((v) => (values.userName = cleanName(v))));
    new Setting(this.contentEl).setName("This computer").addText((text) => text.setValue(values.deviceName).onChange((v) => (values.deviceName = cleanName(v))));
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Create")
        .setCta()
        .onClick(async () => {
          if (!values.workspaceName || !values.userName || !values.deviceName) return new Notice("Please fill in every field.");
          button.setDisabled(true);
          try {
            await this.plugin.createWorkspace(values);
            this.close();
          } catch (error) {
            button.setDisabled(false);
            new Notice(errorText(error), 8000);
          }
        })
    );
  }
}

export class JoinModal extends Modal {
  constructor(
    private readonly plugin: VaultRoomsPlugin,
    private readonly params?: Record<string, string>
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("Join a workspace");
    if (this.plugin.settings.mesh.workspace) {
      this.contentEl.createEl("p", { text: "This vault already belongs to a workspace. To join another one, use another vault." });
      return;
    }
    const link = this.params ? `obsidian://vault-rooms?${new URLSearchParams(this.params).toString()}` : "";
    const values = { link, userName: "", deviceName: this.plugin.defaultDeviceName(), address: "" };
    this.contentEl.createEl("p", { text: "Paste the invite link someone in the workspace sent you. This computer gets its own keys; nothing secret is in the link beyond the one-time invite." });
    new Setting(this.contentEl).setName("Invite link").addTextArea((text) => {
      text.setValue(link).onChange((v) => (values.link = v.trim()));
      text.inputEl.rows = 3;
      text.inputEl.style.width = "100%";
    });
    new Setting(this.contentEl).setName("Your name").setDesc("How others see you. For another computer of yours, use your usual name.").addText((text) => text.onChange((v) => (values.userName = cleanName(v))));
    new Setting(this.contentEl).setName("This computer").addText((text) => text.setValue(values.deviceName).onChange((v) => (values.deviceName = cleanName(v))));
    new Setting(this.contentEl)
      .setName("Computer address (optional)")
      .setDesc("Only if joining fails: the address of a computer in the workspace, e.g. 192.168.1.20:47880 (shown in its Vault Rooms panel).")
      .addText((text) => text.onChange((v) => (values.address = v.trim())));
    const status = this.contentEl.createEl("p", { cls: "vault-rooms-status" });
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Join")
        .setCta()
        .onClick(async () => {
          if (!values.link || !values.userName || !values.deviceName) return new Notice("Please fill in the link, your name and this computer's name.");
          button.setDisabled(true);
          status.setText("Connecting…");
          try {
            await this.plugin.joinWorkspace({ link: values.link, userName: values.userName, deviceName: values.deviceName, peers: values.address ? [values.address] : [] });
            new Notice("Joined. Rooms shared with you appear as their keys arrive.", 8000);
            this.close();
          } catch (error) {
            status.setText(errorText(error));
            button.setDisabled(false);
          }
        })
    );
  }
}

export class LinkModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly link: string,
    private readonly note: string
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl("p", { text: this.note });
    const area = this.contentEl.createEl("textarea", { cls: "vault-rooms-link" });
    area.value = this.link;
    area.readOnly = true;
    area.rows = 4;
    area.style.width = "100%";
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Copy link")
        .setCta()
        .onClick(async () => {
          await navigator.clipboard.writeText(this.link);
          new Notice("Invite link copied.");
        })
    );
  }
}

export class InviteModal extends Modal {
  constructor(private readonly plugin: VaultRoomsPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    const svc = this.plugin.service;
    this.titleEl.setText("Invite someone");
    if (!svc) return;
    const managed = svc.rooms().filter((room) => room.role === "manage");
    const grants: Record<string, Role> = {};
    let days = 3;
    this.contentEl.createEl("p", { text: "The link lets one new person join the workspace, with the rooms you pick here. You can give them more rooms later." });
    if (managed.length === 0) this.contentEl.createEl("p", { text: "You don't manage any rooms yet, so this invite brings no rooms; a room's managers can add the person afterwards." });
    for (const room of managed) {
      new Setting(this.contentEl).setName(room.name ?? "Room").addDropdown((dropdown) => {
        dropdown.addOption("", "No access");
        for (const role of ROLES) dropdown.addOption(role, ROLE_LABEL[role]);
        dropdown.onChange((value) => {
          if (value) grants[room.id] = value as Role;
          else delete grants[room.id];
        });
      });
    }
    new Setting(this.contentEl).setName("Link expires after").addDropdown((dropdown) =>
      dropdown
        .addOptions({ "1": "1 day", "3": "3 days", "7": "7 days" })
        .setValue("3")
        .onChange((value) => (days = Number(value)))
    );
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Create invite link")
        .setCta()
        .onClick(async () => {
          button.setDisabled(true);
          try {
            const link = await svc.createInvite(grants, days);
            this.close();
            new LinkModal(this.app, "Invite link", link, `Send this link privately (not in a public channel): whoever has it can join until it is used or expires in ${days} day${days > 1 ? "s" : ""}.`).open();
          } catch (error) {
            button.setDisabled(false);
            new Notice(errorText(error), 8000);
          }
        })
    );
  }
}

export class NewRoomModal extends Modal {
  constructor(private readonly plugin: VaultRoomsPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("Share a folder as a room");
    // The folders sharing would take: the same check it makes (names, dot folders, other rooms' folders).
    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder && file.path !== "/")
      .map((folder) => folder.path)
      .filter((path) => this.plugin.folderProblem(path) === null)
      .sort();
    const values = { folder: folders[0] ?? "", name: folders[0]?.split("/").pop() ?? "" };
    this.contentEl.createEl("p", { text: "Everything in the folder is shared, end-to-end encrypted, with the people you add. You manage the room; add people under Members afterwards." });
    let nameField: { setValue(value: string): unknown } | null = null;
    new Setting(this.contentEl).setName("Folder").addDropdown((dropdown) => {
      for (const path of folders) dropdown.addOption(path, path);
      dropdown.setValue(values.folder).onChange((value) => {
        values.folder = value;
        values.name = value.split("/").pop() ?? value;
        nameField?.setValue(values.name);
      });
    });
    new Setting(this.contentEl).setName("Room name").addText((text) => {
      nameField = text;
      text.setValue(values.name).onChange((value) => (values.name = cleanName(value)));
    });
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Share folder")
        .setCta()
        .onClick(async () => {
          if (!values.folder || !values.name) return new Notice("Pick a folder and a name.");
          button.setDisabled(true);
          try {
            await this.plugin.createRoom(values.folder, values.name);
            this.close();
          } catch (error) {
            button.setDisabled(false);
            new Notice(errorText(error), 8000);
          }
        })
    );
  }
}

export class MembersModal extends Modal {
  constructor(
    private readonly plugin: VaultRoomsPlugin,
    private readonly roomId: string
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const svc = this.plugin.service;
    this.contentEl.empty();
    if (!svc) return;
    const room = svc.rooms().find((r) => r.id === this.roomId);
    if (!room) return this.close();
    this.titleEl.setText(`Members of ${room.name ?? "this room"}`);
    const state = svc.state;
    const iManage = room.role === "manage";
    if (!room.managed) this.contentEl.createEl("p", { cls: "vault-rooms-error", text: UNMANAGED });
    for (const [userId, role] of Object.entries(room.members)) {
      const user = state.users[userId];
      if (!user || user.removed) continue;
      const row = new Setting(this.contentEl).setName(`${personLabel(state, userId)}${userId === svc.me.userId ? " (you)" : ""}`);
      if (iManage) {
        row.addDropdown((dropdown) => {
          for (const option of ROLES) dropdown.addOption(option, ROLE_LABEL[option]);
          dropdown.setValue(role).onChange(async (value) => {
            await this.run(() => svc.setMember(this.roomId, userId, value as Role));
          });
        });
        if (userId !== svc.me.userId)
          row.addButton((button) =>
            button.setButtonText("Remove").onClick(async () => {
              if (await confirmAction(this.app, "Remove from room", `${personLabel(state, userId)} loses access to this room. A new room key is made, so they can't read anything added from now on (they keep what they already have).`, "Remove")) await this.run(() => svc.setMember(this.roomId, userId, null));
            })
          );
      } else row.setDesc(ROLE_LABEL[role]);
    }
    if (iManage) {
      const candidates = Object.entries(state.users).filter(([userId, user]) => !user.removed && roleIn(state, this.roomId, userId) === undefined);
      if (candidates.length > 0) {
        let chosen = candidates[0]![0];
        let role: Role = "write";
        new Setting(this.contentEl)
          .setName("Add a person")
          .addDropdown((dropdown) => {
            for (const [userId] of candidates) dropdown.addOption(userId, personLabel(state, userId));
            dropdown.onChange((value) => (chosen = value));
          })
          .addDropdown((dropdown) => {
            for (const option of ROLES) dropdown.addOption(option, ROLE_LABEL[option]);
            dropdown.setValue(role).onChange((value) => (role = value as Role));
          })
          .addButton((button) =>
            button.setButtonText("Add").onClick(async () => {
              if (await confirmAction(this.app, "Add to room", `${personLabel(state, chosen)} is added to this room (${ROLE_LABEL[role].toLowerCase()}), and gets everything already in it.`, "Add")) await this.run(() => svc.setMember(this.roomId, chosen, role));
            })
          );
      }
      let name = room.name ?? "";
      new Setting(this.contentEl)
        .setName("Room name")
        .addText((text) => text.setValue(name).onChange((value) => (name = cleanName(value))))
        .addButton((button) => button.setButtonText("Rename").onClick(() => (name ? this.run(() => svc.renameRoom(this.roomId, name)) : undefined)));
    }
    const actions = new Setting(this.contentEl);
    if (svc.roomsOnlyManagedBy(svc.me.userId).includes(this.roomId)) {
      // Leaving would leave no one to manage it: the record wouldn't take it.
      actions.setDesc("You're this room's only manager: to leave it, make someone else a manager first, or delete the room.");
    } else
      actions.addButton((button) =>
        button.setButtonText("Leave this room").onClick(async () => {
          if (await confirmAction(this.app, "Leave room", "You stop receiving this room. Its folder stays on this computer but no longer syncs.", "Leave")) await this.run(() => svc.leaveRoom(this.roomId));
        })
      );
    if (iManage || svc.isAdmin()) actions.addButton((button) => button.setButtonText("Delete room").setWarning().onClick(() => deleteRoom(this.plugin, this.roomId, () => this.close())));
  }

  private async run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      new Notice(errorText(error), 8000);
    }
    this.render();
  }
}
