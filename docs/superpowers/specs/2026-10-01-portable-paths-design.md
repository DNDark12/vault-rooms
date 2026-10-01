# Portable room paths: integrity design

**Workflow:** refactor. **Status:** implemented and locally verified on `develop`; initial fixes are preserved in `fd5885a`. No push or release.

## Problem and scope

Case-sensitive relay paths can identify two live files that one Windows/macOS vault identifies as one. The same mismatch bypasses path ACLs. New Windows-reserved names fail on receiving devices. This change covers shared path identity, in-place metadata migration, safe recovery of legacy collisions, both relay runtimes, and plugin reconciliation. It does not merge content, pick a winner, rewrite local vault names automatically, change content encodings, install dependencies, or publish a release.

## Decisions

- Preserve spelling; `portablePathKey(path)` is NFC followed by locale-independent `toLowerCase()`. ACL patterns and file paths use the same helper. This is the product's comparison contract, not an exact implementation of every filesystem's Unicode folding.
- Validate portable names only when creating a new name or changing one. Keep legacy read/delete/rename-source access. New/changed room `sourcePath` segments and `mountName` follow the same rules.
- A tombstone and a live row sharing a key are not a collision. Preserve tombstone metadata and enforce a version floor across that key. Only multiple live rows are quarantined. On migration or recovery, a sole live row advances above every alias tombstone so a client retaining a deletion version can pull it immediately; its current version reference is cloned and old history rows remain unchanged.
- Migration is in place, versioned, backed up in a metadata backup table, audited, and idempotent. A partial unique index protects live, non-quarantined keys. Quarantined keys cannot receive ordinary mutations, including CRDT materialization.
- New clients advertise `portablePaths`. Snapshots retain quarantined entries with `pathCollision: true`; new clients preserve local files and skip pull/push. Old clients receive `PATH_COLLISION` rather than a misleading snapshot/list they could reconcile destructively.
- Owner recovery identifies the file by stable ID, verifies room ownership and ACLs, durably renames while preserving ID/history/epoch, and updates quarantine flags in the same transaction. Fanout checks read access independently at old/new paths. Collision repair sends a complete personalized snapshot rather than an ambiguous disk rename/delete. Ordinary repairs retain partitioned rename/delete/change fanout. Post-commit content I/O rechecks stable ID, path, version, epoch and current room mode before structural events; a concurrent move/delete falls back to the current snapshot. Repairs cannot change content encoding or the CRDT lane.
- Previously quarantined local text and persisted CRDT epochs must be preserved before discarding ambiguous cached documents and pulling the surviving identity, including after restart. Multiple local live aliases remain paused even if saved metadata matches.
- Unmount, room deletion/revocation and mode changes retain quarantined caches. Blocked sessions are saved before teardown; saves keep all prior epochs until recovery preserves them. A failed save keeps the document recoverable. Structural journals touching an ambiguous/recovering identity remain paused rather than replaying an operation against a different surviving file; automatic resolution of those ambiguous intents is outside this change.
- Invalid local names produce one Notice per room/path/reason and are not pushed. A corrected name can sync normally. Dotfile behavior remains a silent skip.

## Risk and verification

Path identity and sync are non-trivial integrity changes. Verify Unicode/case aliases, DB-enforced uniqueness, tombstone version floors, legacy-invalid access, migration reruns, recovery permissions, and capability safety. Exercise the embedded adapter while a durable flush is blocked. Use case-insensitive vault fixtures for CAS and CRDT case-only renames. Run typecheck, the full suite, plugin build, and bundle scan. Real Windows/macOS filesystem and two-device Obsidian smoke remain explicit release gates; local mocks do not prove them.

## Execution evidence

- Initial fixes: commit `fd5885a` on existing `develop`; no push. Baseline 93 suites / 1107 tests, typecheck, plugin build, bundle scan.
- Shared path/ACL tests went red before implementation, then 76 passed. Repository/migration tests reproduced identity and invalid-name gaps before implementation.
- Independent review reproduced and repaired tombstone version floors and structural normalization of direct CRDT creates. Server tests now cover CAS/CRDT recipient ACL partitions, repair snapshot-only recovery, encoding/lane guard, missing/null bodies and stale post-commit moves or room modes.
- Embedded DataAdapter regression includes delayed persistence, owner repair and a competing real sync-handler CRDT update; reopen proves both repaired metadata and update survive.
- Plugin verification covers exact Obsidian-cache aliases, ambiguous siblings, NFC/NFD mount ancestor offsets, durable recovery markers, interrupted `.replace-backup`/`.tmp` caches, in-flight saves and paused-room disposal. Two regression assertions reproduced prior-epoch deletion during paused saves and unmount, then passed after keeping those epochs.
- Independent protocol and server review was performed; the main agent reviewed plugin integration and the final diff. No dependencies or live data were changed.
- Final verification on 2026-10-01: `node_modules/.bin/vitest run` passed **95 suites / 1246 tests** (including both two-client CAS/CRDT integration suites and the embedded concurrent-persistence regression); `node_modules/.bin/tsc -b` passed.
- Plugin build (`node esbuild.config.mjs`), root asset sync and `node scripts/scan-bundle.mjs` passed; root `main.js` is **1,852,357 bytes**. No scanner allowances changed for this task. `git diff --check` passed.
- Remaining release gate: real Windows/macOS filesystem and two-device Obsidian smoke have not been performed. Ambiguous local tracking/journal intents deliberately remain paused and require manual resolution; their data is retained.

Auto-Dispatch invariants: Inv-0 main agent chose the route; Inv-1 this full artifact exists; Inv-2 sync identity/integrity stayed non-trivial; Inv-3 the sole primary label is `refactor`; Inv-4 planning, TDD, review and verification were supporting workflows.

Rules follow [Microsoft naming guidance](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file), verified 2026-10-01.
