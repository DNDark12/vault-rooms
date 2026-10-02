# Obsidian source warning fixes

**Workflow:** bug-triage. **Scope:** the four source warnings reported after the 0.2.9 branch checks. Preserve public behavior, pending CRDT persistence, supported Obsidian versions and the existing release gates.

## Findings and approach

1. `crdtDocStore.ts` stores cache ownership on `globalThis`. Apart from the Obsidian rule violation, evaluating the module with a separate window global creates a second registry for the same vault adapter. A cache read can bypass an old pending final save or a retained failed retirement. Two isolated-JavaScript-context reproductions fail on the original source. Attach a non-enumerable, Symbol-scoped room registry to the public vault adapter instead: shared adapter identity is already the ownership boundary, independent of current window or module reload. Preserve cache-directory/room isolation and retained-save retry semantics.
2. `crdtSession.ts` uses a constant-true final-save loop. Replace the loop condition with whether the saved revision remains current. A late edit while storage is pending must cause another save before document teardown.
3. `pushCoordinator.ts` has an unnecessary non-null assertion on the tracked entry. Remove it, verify TypeScript's narrowing and preserve readable terminal error reporting.
4. `paths.ts` embeds ASCII control characters in a regular expression. Use an explicit character-code check while preserving Windows punctuation, reserved names, trailing dot/space rejection and legacy structural reads.

## Verification

Run the actual `eslint-plugin-obsidianmd/no-global-this`, `no-constant-condition`, `@typescript-eslint/no-unnecessary-type-assertion` and `no-control-regex` rules against the four files, with typed package projects. The diagnostic tools live in a temporary directory; repository dependencies remain unchanged. Confirm the original four warnings before fixing them.

Run isolated-window ownership/failure tests, module-reload handoff tests, late-revision retirement, coordinator terminal-error tests and all portable-path validation tests. Then run full tests, typecheck, plugin build/asset sync, bundle scan and whitespace checks. Rebuild the root artifact. Reduce the bundle's `globalThis` allowance by the two removed plugin-owned references; dependency-owned references retain their existing baseline.

## Results

- The four reported rules reproduce four errors on the original source and report **zero errors** on the corrected source. Logs: `/tmp/vault-source-warnings-eslint-red.log` and `/tmp/vault-source-warnings-eslint-green.log`. No repository dependency or lockfile changes were required.
- Both isolated-window ownership regressions fail before the fix and pass afterward. The final-save test confirms an edit arriving during an awaited write is saved in a second pass. Focused checks: **164 tests pass**; full suite: **1,320 tests / 98 suites pass**, recorded in `/tmp/vault-source-warnings-full.log`.
- Typecheck, plugin build, root asset sync, bundle scan and whitespace checks pass. The bundle allowance for `globalThis` drops from 12 to 10; the remaining references belong to previously inspected dependencies.
- Current-build native smoke on Obsidian **1.13.7/macOS** uses a newly initialized host vault, owner and room with the machine's `.local` hostname entered in the setup wizard. No IP address was entered or substituted. Connection check, room creation, hostname invite parsing, pinned-TLS join and initial download succeed; the peer retains `https://<hostname>.local:18888` with security state `ok`.
- Host and peer editor changes sync in both directions. A real **Open in new window** popout accepts a further CRDT edit, which appears in the peer's editor. Read-only disk checks confirm the two files are byte-identical and all four unique markers occur once. Fixtures are under `/private/tmp/VaultRoomsSmoke-20261002/HostnameHost` and `Peer`. Test vault windows were closed and relay listeners on 18787/18788/18887/18888 were confirmed stopped.

Real Windows and two physical machines remain release gates. The hostname test confirms local macOS resolution and transport behavior; both vaults run on one machine. Isolated-context tests exercise pending and failed ownership handoff deterministically; the native popout smoke checks ordinary editing, without claiming a forced disk-failure reproduction in the app. This follow-up was reviewed locally; no additional independent agent review was performed.

Inv-0: main agent selected bug-triage. Inv-1: this RCA exists. Inv-2: CRDT ownership stays non-trivial. Inv-3: one primary label. Inv-4: debugging, TDD and review/verification skills support the route.
