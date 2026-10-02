# Portable recovery bug fixes

Primary workflow: bug-triage. User authorized all seven findings in the follow-up RCA. Work on existing develop; no new branch or dependencies.

Status: all five execution steps completed. Independent review findings were reproduced and fixed before final verification. See the paired RCA for implementation details and remaining release gates.

## Execution

1. Reproduce and fix pending CRDT lifecycle loss, stale disposal writes, and in-flight stale opens. Own lifecycle transitions and every cache write; capture state synchronously before host unload, await persistence on server switch.
2. Protect recovery download replacement/deletion against edits made after preservation. Centralize recovery overwrite ownership in the vault/sync boundary; failed preservation leaves pause intact.
3. Expose server/local collisions and pending recovery in panel and on attempted edits. Provide explicit exact-file recovery without automatic merge or winner; preserve cached states and structural intents before resuming canonical tracking.
4. Limit rename snapshots to collision repair or required stale-I/O/mode fallback; send peer CRDT updates using server spelling.
5. Integrate and review the combined diff; run focused reproductions, typecheck, full suite, plugin build and bundle scan. Update RCA with current evidence and limits.

Disjoint owners: CRDT session/store agent, relay fanout agent, pause UI/main agent; main agent owns recovery writes and safe local repair core. Shared contracts are agreed before callers change. Supporting TDD, debugging, planning and review skills do not change the primary route.

## Acceptance and verification

All four proven data-loss/stale-identity reproductions must pass as repository regressions. Cache-write failures and delayed opens/saves must not permit overwrite, resume, or cross-identity merge. Local repair must preserve every local file and unique CRDT state, keep pending structural intentions visible, and never replay a destructive ambiguous action. Normal files in the room continue syncing; blocked paths have persistent attention and a concrete action.

Tests use deterministic controlled promises and real classes. No timers increased to mask races. Runtime checks: tsc -b; vitest run (localhost listener permission when needed); plugin esbuild, asset sync, scan-bundle; git diff --check. Real Windows/macOS and two-device Obsidian CRDT smoke remain release gates and are not inferred from mocks.

## Delivery evidence

- Full suite: 1,314 tests / 98 suites pass on the final source.
- Typecheck, plugin build, asset sync, bundle scan and whitespace check pass; root main.js rebuilt.
- Bounded independent review: 7 scratch regressions and 194 tests / 8 focused suites pass, with no remaining actionable findings in the reviewed boundaries.
- Additional review fixes cover non-awaited module reload and failed-save handoff, queued stale rename, cached text beneath an ambiguous folder, and rollback preserving unrelated concurrent journal intentions.
- Real Obsidian, Windows/macOS and two-device smoke remain required before release. No push or live-vault mutation is part of this delivery.
