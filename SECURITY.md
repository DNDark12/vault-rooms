# Security

The design, with every check and its reasons, is in [SECURE-MESH.md](SECURE-MESH.md). This page is the short version.

## Threat model

Who we defend against, on the local network:

- **A stranger's device** (a guest laptop, a compromised printer): it can neither read nor change anything. Every connection is TLS 1.3 to a certificate pinned in the signed workspace record, and both ends authenticate with their device keys over that very TLS session. Until a device is a member it may only show that it is (a join record, or newer versions of the signed record that only extend the one the other side has), under tight limits.
- **A member** can't read rooms they aren't in (they only ever receive those rooms as ciphertext), can't write where they may only read (every change is signed, and peers drop changes from anyone who isn't currently a writer), can't touch anything outside a room's folder or inside `.obsidian` (every path is checked before any file is written), can't plant programs, scripts or shortcuts (only file types that can't run anything are shared), and can't give themselves access to a room: only a room's managers change its membership, and nobody, admins included, can register a computer under someone else's name. A member also can't take away others' work: a snapshot that lies about what it contains removes nothing from a member's copy, a race between conflicting changes is settled by rules no one can game (someone being removed always loses), and a wrong room key sent to a newcomer doesn't stop the right one arriving.
- **A revoked computer or a removed person** is disconnected by every peer and turned away when it connects again, their open invites stop working, and their rooms get new keys as soon as someone who can edit them is online; they keep only what they already had.
- **A lost or stolen computer** exposes that user's rooms only. Its keys are in Obsidian's secret storage, encrypted by the operating system for that user and tied to the vault: copying a vault doesn't copy them. Revoke it from another computer: invites made on it stop working too.

Out of scope: someone controlling a member's computer while it is unlocked (they are that member), and availability (a malicious peer can refuse to pass things on, or spend a room's storage; it can't forge or read anything).

**Plugins that run code from notes.** If you use plugins that execute code written in notes (Dataview JavaScript queries, Templater user scripts and the like), anyone who can edit a room can run code on your computer through a note. Turn those features off for room folders, or don't use such plugins in a vault that shares rooms.

**Revocations add up.** When admins change things at the same moment (computers cut off from each other, say), every revocation and removal among them still takes effect whichever change wins, unless it came from someone the winning change itself revoked, removed or demoted, and what someone revoked at that moment granted then (including people let in through their invites) is taken back.

**Invite links are secrets.** Anyone holding a link can join until it is used, withdrawn or expired: if a link leaks, withdraw it in the panel. One case needs a look: if someone who got in with a leaked link is taken out again at the same moment as another admin's change (computers cut off from each other, say) and that change wins, the record keeps neither their joining nor their removal. The invite is then open again until a computer of an admin or of the invite's creator withdraws it, which happens on its own once one is online, and the link works meanwhile. After computers that were cut off reconnect, check the people list.

## What is protected, and how

| What | How |
|---|---|
| Room content, file names, room names, cursors | AES-256-GCM per room key epoch; associated data binds each message to its room, document, author and counter; new content only ever under the room's newest key |
| Who may do what | A signed, hash-chained workspace record; every version is checked against what its signer may change |
| Room keys | Random per epoch; delivered to each entitled device as an X25519-sealed, signed key wrap, checked against a commitment in the record; receipts show who has it |
| Connections | TLS 1.3, exact certificate pinning, signatures over the session's exported keying material |
| Invites | A one-time secret from which a signing key is derived; joiners prove it without revealing it; an invite only works while the computer that made it, and its maker's role, still stand |
| Your files | Removed only when someone deleted them in the room, and then to the trash; conflicting or unshareable versions are kept as copies, never overwritten |
| Device secrets | Obsidian secret storage (OS-encrypted, outside the vault) |

## Reporting a vulnerability

Please open a [private security advisory](https://github.com/AiSuperBot/vault-rooms/security/advisories/new) on this repository rather than a public issue. Include what an attacker needs (network position, membership, role) and what they get.
