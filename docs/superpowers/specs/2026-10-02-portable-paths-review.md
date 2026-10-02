# Portable paths: follow-up review and RCA

**Workflow:** bug-triage. **Status:** implemented and locally verified; hardware release gates remain. **Checkout:** existing `develop`; review baseline `34aaa35`.

The findings and source locations below describe the review baseline. The implementation and fresh delivery evidence follow them.

## Confirmed findings

### P1: an edit during recovery download is overwritten

`syncWsClient.ts:562` preserves the initial local content, then `:589` awaits a survivor download and `:590` writes it. `main.ts:1790` ignores local changes while the path remains blocked. `preserveRecoveredLocalFile` clears dirty tracking after copying the earlier text, so a later edit in the download window is neither recorded nor copied before being replaced.

Reproduction uses the real `RoomSyncSocket` and `VaultSyncEngine` with a controlled API promise: recover `note.md`, wait until `readFile` starts, change `Room/Note.md`, release the download, then inspect every local copy. The latest edit is missing; only the old conflict copy and server survivor remain. Scratch test: `/private/tmp/vault-rooms-review-recovery.test.ts`; failing log: `/tmp/vault-rooms-review-race.log`.

The same preserve-before-download order exists in `RoomMountController.ts`; it must obey the same preservation invariant. Fix acceptance: an edit after the initial copy, during download or before replacement survives in the local file or a conflict copy. Failed preservation never clears the pause or overwrites the file. Tests must cover CAS/CRDT materialized fallback and mount-time reconciliation.

### P1: unload/server switch drops a debounced quarantined document

`crdtSession.ts:901` marks the manager disposed, cancels pending timers through teardown and destroys every document without saving the latest state. Unlike `disposeRoom`, it has no paused-state persistence path. Production callers are plugin unload (`main.ts:435`) and server switch (`main.ts:1986`). An edit still present only in the Y.Doc, followed by a quarantine snapshot and disposal before debounce, cannot be recovered from the older disk/cache after restart.

The scratch test places the unique edit before the first quarantine snapshot, disposes immediately, restarts with the retained cache and recovers the path. Only the earlier text is preserved. This is a document-lifecycle reproduction; real Obsidian editor autosave/close behavior is not asserted by it. Acceptance: retain the latest unique pending state before tearing down paused documents; explicitly handle the host's non-awaiting unload lifecycle and write failures without claiming arbitrary process termination can be made durable.

### P1: concurrent room disposal recreates a discarded ambiguous cache

`disposeRoom` directly awaits `docStore.save` (`crdtSession.ts:873`) without registering it in `persistWrites`. Recovery only awaits that registry (`:234`), so a repair can preserve/delete the old cache while the disposal write is still running; the delayed write then recreates it. Mode-disable disposal is fire-and-forget (`main.ts:2160`) and can overlap a repair snapshot.

Controlled-write reproduction confirms the cache is removed during repair and reappears after releasing the disposal save. A restarted manager then loads it under the survivor's unchanged epoch; applying its update to the survivor produces both old ambiguous and surviving text. Acceptance: serialize retirement/recovery cache ownership and prevent all old-identity writes after invalidation.

### P1: an in-flight session open reinstalls the retired document

`openSession` reads cache (`crdtSession.ts:676`) and awaits disk (`:677`), then installs the session (`:728`). Its blocked-path check occurs before those awaits (`:642`); no identity generation check invalidates the captured cache after quarantine and owner repair. Recovery sees no installed session, preserves/deletes the cache and clears the quarantine. Releasing the pending disk read then opens the old cached document at the survivor's unchanged epoch.

The scratch reproduction delays `readDiskText`, runs quarantine/repair, resumes the open and applies the survivor update. The old and survivor texts are combined. Acceptance: invalidate pending opens on quarantine/repair/disposal and recheck identity/lifecycle after awaits; rechecking only the current boolean pause is insufficient because repair has already cleared it.

### P2: paused paths are invisible and local collisions have no recovery route

`pushCoordinator.ts:51` and the mounted watcher in `main.ts:1790` silently return for blocked paths. The panel only considers mount state and ordinary conflict copies (`panelModel.ts:269`, `VaultRoomsView.ts:140`). The room owner discovers server collision groups only by opening room settings. A local rename alone cannot repair duplicate tracking because both halves of the rename are also filtered while blocked.

Proposed UI: persistent room attention count/status plus a once-per-path/reason Notice on attempted edits. Distinguish server collision (owner repair; members ask owner), local collision (explicit per-file recovery without choosing/merging a winner), and recovery still pending/failed (retry/status). Keep other room files syncing. The local repair flow must preserve all files, exact-spelling CRDT caches and pending intents before updating tracking; merely telling users to rename then refresh is insufficient.

### P3: every owner rename broadcasts a full snapshot

`file.routes.ts:127` always broadcasts. Restrict to collision recovery or a necessary fallback when post-commit I/O observes a changed identity, path, version, epoch or room mode, or fanout fails. The current competing-rename regression requires this fallback; removing all ordinary-rename snapshots would reintroduce stale-client state.

### P3: CRDT update fanout uses the sender's spelling

`syncServer.ts:850` sends `normalizedPath` rather than `file.relative_path`. New clients compare portable keys, but older exact-path clients may ignore the update. Use current server spelling for peer fanout; preserve request-correlated replies where older callers need their requested path. Verify case/NFD sender aliases with a peer expecting the stored spelling and retain ACL isolation.

## Implemented fixes

1. Recovery keeps dirty and structural intent until replacement succeeds. Immediately before replacing or deleting an ambiguous local path, the production vault adapter moves the live file, including its latest raw bytes, into a unique conflict copy. The survivor is created exclusively; a newly recreated source causes failure and retains the pause. CAS, CRDT materialized fallback, mount reconciliation, binary content and absent snapshot identities use this preservation boundary.
2. Global disposal now synchronously gates traffic, captures pending document snapshots and awaits final persistence before destruction. Server switches and reconnect transitions await it; unload reports rejection explicitly. Failed retirement retains paused documents and the manager for retry instead of dropping edits.
3. Every cache operation shares room-level ownership through `CrdtDocStore.withRoomAccess`. A Symbol-scoped volatile WeakMap keyed by public vault adapter and exact cache directory survives module reload, so a new manager cannot repair/read ahead of an old final save. Failed or skipped final saves retain their snapshot callback; later access retries it before proceeding and remains paused if storage still fails. This handles non-awaited plugin reload within the same host process; it does not promise durability after forced process termination.
4. Per-path generations invalidate pending opens and queued renames on quarantine, repair, deletion, resync and retirement. Async boundaries recheck the captured generations before installing documents or moving/rekeying files. A disposed snapshot handler rejects with `SESSION_INVALIDATED`, preventing a repair from bypassing failed retirement.
5. The panel displays paused-file attention and a Review paused files action for members and owners. Attempted edits show a deduplicated Notice. The modal distinguishes server collisions, exact local file/folder aliases and pending recovery, with owner guidance and retry. Local repair preserves unique CRDT states and archives affected tracking/journal intent before moving the selected exact alias. It never selects a winner or replays an ambiguous destructive action. Empty aliased folders and tracking-only aliases remain actionable; quarantine persists until explicit preservation succeeds. Cached text under an ambiguous parent can be preserved at an unambiguous room-root path.
6. Owner rename sends a full snapshot only for collision repair or required stale/failed fanout reconciliation, including concurrent identity/version/epoch/mode changes.
7. Peer `remote_crdt_update` uses stored server spelling. Request-correlated handshake replies keep the requested spelling for compatibility; ACL filtering remains enforced.

The final independent review additionally reproduced cross-manager stale-cache adoption, a queued rename acting on a retired identity, ambiguous-parent cached-text preservation failure and rollback dropping an unrelated new journal intention. These are fixed with the shared handoff, generation checks, root-level backup fallback and rollback that merges affected intentions into current state. Repository regressions cover these boundaries.

## Verification and limits

- The four initial P1 reproductions failed at `34aaa35` and now have passing repository regressions. Historical scratch evidence: `/private/tmp/vault-rooms-review-recovery.test.ts` and `/private/tmp/vault-recovery-review/recovery.test.ts`.
- Fresh full suite: **1,314 tests / 98 suites pass** (`node_modules/.bin/vitest run`; local listener permission enabled). Delivery log: `/tmp/vault-recovery-delivery-full.log`.
- `node_modules/.bin/tsc -b`, plugin esbuild, asset sync, bundle scan and `git diff --check` pass. Root `main.js` was rebuilt from the final source.
- Independent bounded final review: **7 scratch regressions and 194 tests / 8 focused repository suites pass**; no remaining actionable finding in the reviewed recovery, retirement, rename, backup and rollback boundaries. This is not an exhaustive proof of the application.
- Bundle scanner `globalThis` allowance changes from 10 to 12: inspected generated code emits one read and one write for the scoped volatile cache queue registry. Strict-zero checks remain unchanged. The scanner source documents the reason; no host inspection or new dependency is introduced.
- At the initial recovery delivery, UI interactions were covered by DOM tests. A file-URL preview was rejected by browser URL policy; no alternate route was attempted. The subsequent user-requested native Obsidian macOS smoke, editor-alias RCA, approved dependency updates and branch delivery are recorded in [0.2.9 verification](2026-10-02-release-0.2.9.md). Windows and two physical machines remain release gates.
- The initial recovery commit made no dependency changes, push or live-vault mutation. Later release preparation and pushes to `develop` then `main` have explicit user authorization; native smoke uses disposable vaults.

Inv-0: main agent selected the route. Inv-1: this full RCA exists. Inv-2: sync/recovery integrity remains non-trivial. Inv-3: sole primary workflow is `bug-triage`. Inv-4: code-review, debugging and design are supporting skills.
