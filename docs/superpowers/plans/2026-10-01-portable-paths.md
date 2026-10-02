# Portable Room Paths Implementation Plan

> **Original implementation scope:** Execute task by task with TDD; parallelize independent plugin and owner-UI assignments only after the server contract exists. That delivery excluded dependency changes and push. Later approved updates and branch integration are covered by [0.2.9 release preparation](../specs/2026-10-02-release-0.2.9.md).

**Goal:** One portable path identity across ACLs, DB and clients, with lossless owner recovery for legacy collisions.

**Architecture:** Shared NFC/lowercase key and separate portable-name validation. Persist comparison keys and collision flags, enforce a partial unique index, and use an owner-only stable-ID rename for recovery. Negotiate collision-aware snapshots; canonicalize plugin tracking without discarding local data.

**Tech Stack:** TypeScript, sql.js, shared HTTP/WS handlers, Obsidian DataAdapter, Yjs, Vitest.

## A. Server foundation

- [x] Switch to the existing `develop`, verify baseline (1107 tests, typecheck/build/scan), and commit existing fixes as `fd5885a`.
- [x] Add protocol tests: `portablePathKey("Secret/Cafe\u0301.md") === "secret/café.md"`; `assertPortablePath("CON.md")` throws `INVALID_PATH`; legacy `normalizeRelativePath("CON.md")` still succeeds. Run `node_modules/.bin/vitest run packages/protocol/src/paths.test.ts`, observe failure, implement in `packages/protocol/src/paths.ts`.
- [x] Add ACL tests for case/NFD aliases. Use the shared key inside `pathMatches` in `packages/policy-engine/src/index.ts`; run its policy suite.
- [x] Add repository/migration tests in `apps/relay-server/test/portable-paths.test.ts` for live uniqueness, direct repository calls, invalid new names, tombstone revival and case-only rename. Add `path_key`/`path_collision` to `FileRow`, migrate/backfill at the end of `runMigrations`, and add the live partial unique index. All file-row inserts/renames/revivals maintain the key; lookup prefers live rows and refuses ambiguous groups.
- [x] Validate create/changed room folder names in `routes/room.routes.ts`, preserve unchanged legacy names, and recheck portable names at the repository mutation boundary. Run focused REST/WS/repository tests.

## B. Legacy data and owner recovery

- [x] Add migration fixtures with two live case/NFD aliases and a live/tombstone alias. Preserve all rows and content/history, back up metadata, audit collisions once, and prove a rerun is a no-op.
- [x] Extend shared protocol with `portablePaths`, optional snapshot/list flags and `PATH_COLLISION`. Reject old-client lists/subscriptions for affected visible groups; retain flags in new-client snapshots and suppress ordinary mutation/materialize for quarantined groups.
- [x] Add owner-only `GET /api/rooms/:roomId/path-collisions` and `POST /api/rooms/:roomId/files/rename` with `{ fileId, relativePath }`. The stable-ID transaction preserves history/epoch, handles target tombstones/version floors, recomputes both groups, and emits ACL-filtered delete/change or CRDT rename events. Route the durable operation through `withExclusiveAccess`.
- [x] Add API-client calls and collision list/rename controls inside the existing room settings modal; all panel-visible copy belongs to constants. Successful recovery refreshes the mounted room snapshot. Add authorization and copy/UI tests.
- [x] Add an embedded DB regression with an in-flight durable flush, concurrent CRDT update and owner recovery; verify persisted metadata after reopening.

## C. Plugin identity and safe reconciliation

- [x] Add case-insensitive vault-mode tests for state aliases, CAS ordering, CRDT adopted paths and case-only rename. Canonicalize path-indexed tracking/queues/session lookups through `portablePathKey`; preserve spelling on wire and disk. Preserve colliding local tracking entries rather than choosing a winner.
- [x] Advertise `portablePaths` on HTTP and WS. Preserve flagged snapshot entries, skip reconciliation/push/session handshakes for those keys, and never infer deletion from quarantine.
- [x] Validate new local names before pushing, notify once, retain the file, and resume after correction. Handle case-only physical renames explicitly using the existing Obsidian rename API; avoid the existing destination-exists no-op.
- [x] Extend `client-stack-sync-flow.test.ts` and `crdt-two-client-remount.test.ts` with two-client case/NFD aliases and case-only rename on a case-insensitive fake vault.
- [x] Preserve ambiguous CRDT text across restart before adoption; retain paused room caches during unmount and retain their prior epochs during saves. Verify failing preservation keeps the old session/cache recoverable.

## Delivery

- [x] Update README Known limitations with Unicode folding limits, legacy quarantine, old-client errors and the remaining real-hardware gates.
- [x] Review committed baseline plus all task changes/untracked files; run focused tests, `node_modules/.bin/tsc -b`, full Vitest, plugin build/asset sync, bundle scan and `git diff --check`. Record evidence and remaining hardware checks in the spec.

Final local verification: **95 suites / 1246 tests**, typecheck, plugin build/asset sync, bundle scan and whitespace check passed on 2026-10-01. Root `main.js` rebuilt. Hardware smoke remains a release gate, not a claim from the case-insensitive fixtures. No dependency changes, push or release.

Follow-up recovery fixes and native-editor rename verification are complete in the [current delivery evidence](../specs/2026-10-02-release-0.2.9.md); the counts above describe this plan's initial implementation.
