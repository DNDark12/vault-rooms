# Vault Rooms (secure mesh fork)

![Status: Beta](https://img.shields.io/badge/status-beta-orange) ![Platform: Desktop only](https://img.shields.io/badge/platform-desktop--only-blue) ![Network: Local network](https://img.shields.io/badge/network-local%20network-informational)

Share folders of your Obsidian vault ("rooms") with people on the same local network and edit notes together, live, with each other's cursors. There is no server and no cloud: every computer is an equal peer, so it keeps working whoever is switched on. Everything a room shares is end-to-end encrypted.

This is a fork of [DNDark12/vault-rooms](https://github.com/DNDark12/vault-rooms). It keeps the original's idea and its live editing in Obsidian, and replaces the relay host with an encrypted peer-to-peer design built for an office or lab network where no computer is always on and security matters most. How it works and what it protects against: [SECURE-MESH.md](SECURE-MESH.md).

## What you get

- **Live co-editing.** Notes in a room update as people type, with their cursors shown. Other files (images, PDFs, canvases) sync as whole files.
- **No host.** Computers find each other on the network and connect directly. If one is off, the others carry on; when it comes back it catches up by itself, from whoever is online.
- **End-to-end encryption.** A computer only holds readable copies of the rooms its user belongs to. Content, file names and room names of other rooms pass through or are stored only as ciphertext.
- **Per-folder access.** Each room has its own members, each with a role: *can read*, *can edit*, or *manages* (can add and remove people). Even a workspace admin can't get into a room without its managers.
- **Invite links.** One link per new person, valid for a limited time, used once. Adding another computer of your own works the same way.
- **Revocation.** Revoke a lost computer or remove a person: they are cut off at once, invites they made stop working, and their rooms get new keys as soon as someone who can edit them is online, so nothing added afterwards reaches them.
- **Nothing is lost.** Files are only removed when someone deleted them in the room, and then to the trash. A version that clashes with someone else's, or can't be shared, is kept next to it as a copy, never overwritten.

## Requirements

- Obsidian 1.11.4 or later on Windows, macOS or Linux (desktop only). Tested on Obsidian 1.14.5 on Windows 11.
- The computers are on the same local network.
- **Firewall:** each computer must accept incoming connections from the local network on TCP port 47880 (the next free port up to 47889 is used if it's taken; never one outside them: if all ten are taken, the panel says so) and, for automatic discovery, UDP port 47879. On managed Windows PCs your IT department may have to add the rule. For example, in an elevated PowerShell:

  ```powershell
  New-NetFirewallRule -DisplayName "Obsidian Vault Rooms" -Direction Inbound -Protocol TCP -LocalPort 47880-47889 -RemoteAddress LocalSubnet -Profile Domain,Private -Action Allow
  New-NetFirewallRule -DisplayName "Obsidian Vault Rooms discovery" -Direction Inbound -Protocol UDP -LocalPort 47879 -RemoteAddress LocalSubnet -Profile Domain,Private -Action Allow
  ```

  To limit the rules to Obsidian, add `-Program "C:\Users\<user>\AppData\Local\Programs\Obsidian\Obsidian.exe"`. If discovery can't reach across your network (multicast and broadcast blocked), list other computers by address in the plugin's settings; connections still need only TCP. One address that can be reached is enough: devices tell each other where they can be reached and remember it, and a device that joined with an invite link keeps the link's addresses.

## Install

- **With BRAT:** add the beta plugin `AiSuperBot/vault-rooms`.
- **By hand:** download `main.js`, `manifest.json` and `styles.css` from the latest [release](https://github.com/AiSuperBot/vault-rooms/releases) into `<vault>/.obsidian/plugins/vault-rooms/`, then enable Vault Rooms under Community plugins.

Each release lists the SHA-256 of its files, and the build is reproducible: building its tag with `npx pnpm@11.7.0 install` and `npx pnpm@11.7.0 build:plugin` gives the same `main.js`.

This fork has the same plugin id as upstream Vault Rooms but a different, incompatible protocol: use it on every computer of the workspace.

## Getting started

1. **Create a workspace** (one person, who becomes its admin): open the Vault Rooms panel (people icon in the ribbon) and choose *Create a workspace*.
2. **Share a folder:** *Share a folder* turns a folder of your vault into a room. You manage it.
3. **Invite people:** *Invite someone* makes a link. Pick which of your rooms the person gets and with which role. Send the link privately (it lets one person join until it is used or expires).
4. **Join:** the other person opens the link in Obsidian (or uses *Join with an invite link* in the panel), gives their name, and joins. Rooms shared with them appear under `Rooms/` in their vault once a member who's online has handed them the room's key, which happens automatically within seconds.
5. **Manage:** *Members* on a room adds people, changes roles and removes people. The *People* section shows who is online on which computer. Admins can make other admins, remove people and revoke computers.
6. **Another computer of yours:** *Add another computer of mine* makes a link for your other computer; it gets all your rooms.

Nobody needs to be online at the same time as anyone else for things to work: whatever two computers have, they exchange when they meet.

## Everyday behaviour

- **Offline edits** are kept and merged when computers meet. Notes merge character by character.
- **Conflicts:** if a non-note file, or a note changed outside the editor (while Obsidian was closed, or by another program), changed on two computers at once, nothing is overwritten: the version on this computer is kept next to it as `name (conflict <computer> <date>).ext`, and shared.
- **Deletions** by others go to your trash (the system trash, or Obsidian's `.trash` folder), and only if your copy was unchanged and you weren't working on it; otherwise your copy stays and is shared again.
- **Deleting a room's folder** on your computer only hides the room there; nothing is deleted for anyone else. *Show in this vault* in the panel brings it back.
- **Read-only rooms:** notes open read-only; a change to a file is put back, with your version kept as a copy on your computer only.
- **Moving a room's folder** is fine; the room follows it. A room's folder can't go inside another room's folder (such a move is undone).
- **File types:** notes, canvases, bases, text and data files, PDF, EPUB, Word/Excel/PowerPoint (`.docx`, `.xlsx`, `.pptx`) and OpenDocument files, images, audio, video and ZIP files are shared. Programs, scripts, shortcuts, web pages and documents that can carry macros are not, in either direction, so nobody can plant something that runs when opened.
- **Leaving:** leaving a room or the workspace stops syncing; your files stay on your computer.

## Limits

- Desktop only. Notes are shared up to about 6 MB each, other files up to about 32 MB; larger ones stay on the computer they're on.
- If you use plugins that run code written in notes (Dataview JavaScript, Templater scripts), anyone who can edit a room could run code on your computer: see [SECURITY.md](SECURITY.md).
- A copy of a vault (or one moved outside Obsidian and opened as a new vault) has to join the workspace again.
- Peers can see some metadata: which computers are online, which rooms exist (as random ids), how many files a room has, sizes and timing of changes, and who made each change.
- A removed member keeps what they had already synced; new keys only protect what comes after.
- A computer that only talks to a malicious peer could be kept out of date (not deceived: everything is signed).
- Mobile isn't supported.

## For developers

```sh
npx pnpm@11.7.0 install
npx pnpm@11.7.0 typecheck
npx pnpm@11.7.0 test
npx pnpm@11.7.0 build:plugin   # builds main.js, copies the plugin files to the repo root, scans the bundle
```

- `packages/secure`: the protocol (identities, signed workspace record, room keys, invites, encrypted envelopes, sync between peers, TLS transport, discovery), with tests.
- `apps/obsidian-plugin`: the Obsidian plugin (service, room folders, live editing, UI).

## License and credits

MIT. Original Vault Rooms by DNDark ([DNDark12/vault-rooms](https://github.com/DNDark12/vault-rooms)); secure mesh fork by AiSuperBot.
