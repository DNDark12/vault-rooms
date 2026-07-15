# LAN Share Reachability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distinguish the owner's loopback sync from the advertised LAN endpoint, continuously show LAN reachability, and prevent issuing own-server invites through an unreachable address.

**Architecture:** Add a small credentialless probe/monitor module that reuses `RelayApiClient.testConnection()` so HTTP and pinned HTTPS validation stay identical to existing connection tests. `ServerConnectionManager` owns the transient monitor and exposes state to the plugin/view; invite creation forces a fresh probe only for the same-process embedded server. The panel renders LAN reachability separately and keeps local live sync unchanged.

**Tech Stack:** TypeScript 5.8, Vitest 3, Obsidian `requestUrl`, existing pinned `node:https` transport, pnpm 11.7.

---

### Task 1: Credentialless LAN probe and generation-safe monitor

**Files:**
- Create: `apps/obsidian-plugin/src/lanShareReachability.ts`
- Create: `apps/obsidian-plugin/src/lanShareReachability.test.ts`

- [x] **Step 1: Write failing probe and monitor tests**

Add tests which inject a probe function into `LanShareReachabilityMonitor` and assert:

```ts
it("ignores a late result from the previous LAN URL", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const probe = vi.fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const monitor = new LanShareReachabilityMonitor(probe, vi.fn());

  monitor.check({ baseUrl: "http://192.168.1.49:8787" });
  monitor.check({ baseUrl: "http://192.168.12.21:8787" });
  second.resolve();
  await second.promise;
  first.resolve();
  await first.promise;

  expect(monitor.getState()).toMatchObject({
    key: expect.stringContaining("192.168.12.21"),
    status: "reachable"
  });
});

it("turns a failed probe into an actionable unreachable state", async () => {
  const monitor = new LanShareReachabilityMonitor(
    vi.fn().mockRejectedValue(new Error("net::ERR_ADDRESS_UNREACHABLE")),
    vi.fn()
  );

  await expect(monitor.require({ baseUrl: "http://192.168.1.49:8787" }))
    .rejects.toThrow("LAN share URL is unreachable");
  expect(monitor.getState()).toMatchObject({ status: "unreachable" });
});
```

Mock `RelayApiClient` for the transport seam and assert `probeLanShareTarget()` constructs it with `(baseUrl, undefined, undefined, pin)` and calls only `testConnection()`; this proves neither token nor authorization callback is supplied for HTTP or pinned HTTPS.

- [x] **Step 2: Run tests to verify RED**

Run: `pnpm vitest run apps/obsidian-plugin/src/lanShareReachability.test.ts`

Expected: FAIL because `lanShareReachability.ts` and its exports do not exist.

- [x] **Step 3: Implement the monitor**

Create these public shapes:

```ts
export type LanShareProbeTarget = { baseUrl: string; pin?: PinnedServerInfo };
export type LanShareReachability =
  | { status: "unavailable" }
  | { key: string; baseUrl: string; status: "checking" }
  | { key: string; baseUrl: string; status: "reachable" }
  | { key: string; baseUrl: string; status: "unreachable"; error: string };

export async function probeLanShareTarget(target: LanShareProbeTarget): Promise<void> {
  await new RelayApiClient(target.baseUrl, undefined, undefined, target.pin).testConnection();
}

export class LanShareReachabilityMonitor {
  constructor(
    private readonly probe = probeLanShareTarget,
    private readonly onChange: () => void = () => undefined
  ) {}

  getState(): LanShareReachability;
  clear(): void;
  check(target?: LanShareProbeTarget, force?: boolean): void;
  require(target?: LanShareProbeTarget): Promise<void>;
}
```

Key targets by base URL plus `tlsName`, identity certificate, and SPKI pin. `check()` de-duplicates the same key unless `force` is true, while `require()` always starts a fresh generation. Both normalize caught `unknown`; only the current generation may update state. Missing targets remain `unavailable`; `require()` throws the Public URL configuration instruction.

- [x] **Step 4: Run tests to verify GREEN**

Run: `pnpm vitest run apps/obsidian-plugin/src/lanShareReachability.test.ts`

Expected: PASS.

- [x] **Step 5: Commit Task 1**

```bash
git add apps/obsidian-plugin/src/lanShareReachability.ts apps/obsidian-plugin/src/lanShareReachability.test.ts
git commit -m "feat(plugin): probe LAN share reachability"
```

### Task 2: Own-server lifecycle and invite gate

**Files:**
- Modify: `apps/obsidian-plugin/src/controllers/ServerConnectionManager.ts`
- Modify: `apps/obsidian-plugin/src/main.ts`
- Create: `apps/obsidian-plugin/src/main.inviteReachability.test.ts`

- [x] **Step 1: Write failing invite-gate tests**

Create a prototype-based `VaultRoomsPlugin` test following `main.refreshTeams.test.ts`. Inject an owner loopback server, a fake `ServerConnectionManager.assertLanShareReachable`, and an API spy:

```ts
await expect(plugin.createFriendInvite()).rejects.toThrow("LAN share URL is unreachable");
expect(api.createFriendInvite).not.toHaveBeenCalled();
```

Add a remote active-server case where invite creation reaches the API without calling the local LAN assertion, and repeat the gate assertion for team and room invite entry points.

- [x] **Step 2: Run tests to verify RED**

Run: `pnpm vitest run apps/obsidian-plugin/src/main.inviteReachability.test.ts`

Expected: FAIL because own-server invite creation does not assert LAN reachability.

- [x] **Step 3: Integrate the monitor with the lifecycle**

In `ServerConnectionManager`, construct one monitor with `ctx.renderOpenRoomsViews` as its change callback. Add:

```ts
getLanShareReachability(): LanShareReachability;
refreshLanShareReachability(force?: boolean): void;
assertLanShareReachable(): Promise<void>;
```

Build the target only from a running status with `lanUrl`; pass `status.pinnedInfo` for pinned HTTPS. Start a non-blocking check after successful start, TLS migration, enforcement, and rotation. Clear the monitor on stop/silent stop. `assertLanShareReachable()` uses `monitor.require()` so every own-server invite receives a fresh health probe.

In `VaultRoomsPlugin`, expose the manager state/refresh delegates plus:

```ts
activeServerIsOwnEmbeddedServer(): boolean {
  const server = this.getActiveServer();
  return Boolean(server && this.isOwnEmbeddedServerConnection(server));
}
```

Replace `warnIfInviteIsLoopback()` with an awaited gate used by all three create methods:

```ts
private async assertInviteServerReachable(server: ServerConnection): Promise<void> {
  if (this.isOwnEmbeddedServerConnection(server)) {
    await this.serverConnectionManager.assertLanShareReachable();
  }
}
```

Call it before the API creates any invite token. Remote active servers bypass this local-host gate.

- [x] **Step 4: Run focused tests to verify GREEN**

Run: `pnpm vitest run apps/obsidian-plugin/src/lanShareReachability.test.ts apps/obsidian-plugin/src/main.inviteReachability.test.ts apps/obsidian-plugin/src/main.refreshTeams.test.ts`

Expected: PASS.

- [x] **Step 5: Commit Task 2**

```bash
git add apps/obsidian-plugin/src/controllers/ServerConnectionManager.ts apps/obsidian-plugin/src/main.ts apps/obsidian-plugin/src/main.inviteReachability.test.ts
git commit -m "fix(plugin): block unreachable LAN invites"
```

### Task 3: Panel status, documentation, and release verification

**Files:**
- Modify: `apps/obsidian-plugin/src/views/VaultRoomsView.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-15-lan-share-reachability-design.md`
- Modify: `docs/superpowers/plans/2026-07-15-lan-share-reachability.md`
- Verify: root/plugin `main.js`, `manifest.json`, `styles.css`

- [x] **Step 1: Write failing presentation tests**

Extend `lanShareReachability.test.ts` for an exported presentation helper:

```ts
expect(lanSharePresentation({ key: "k", baseUrl: "http://lan", status: "reachable" }))
  .toEqual({ label: "LAN share: reachable from this device", className: "is-running" });
expect(lanSharePresentation({ key: "k", baseUrl: "http://bad", status: "unreachable", error: "offline" }))
  .toMatchObject({ label: "LAN share: unreachable", className: "is-stopped" });
```

- [x] **Step 2: Run the presentation test to verify RED**

Run: `pnpm vitest run apps/obsidian-plugin/src/lanShareReachability.test.ts`

Expected: FAIL because `lanSharePresentation` is not implemented.

- [x] **Step 3: Render distinct LAN and local states**

Implement `lanSharePresentation()` for checking/reachable/unreachable and return `null` for unavailable. In `VaultRoomsView.renderHostingSection()`, render its badge under the LAN URL, render the actionable unreachable diagnostic, and add `Test LAN URL` which forces a refresh. In `renderActiveConnectionSection()`, add `Local owner connection` when `activeServerIsOwnEmbeddedServer()` is true; do not alter `getSyncState()` or the loopback base URL.

Update README operational text: Public URL override is manually maintained, the panel probes it from the host, a green LAN badge does not prove firewall/AP reachability from every teammate, and invite creation is blocked on a failed host-side probe.

- [x] **Step 4: Verify focused GREEN**

Run: `pnpm vitest run apps/obsidian-plugin/src/lanShareReachability.test.ts apps/obsidian-plugin/src/main.inviteReachability.test.ts`

Expected: PASS.

- [x] **Step 5: Run full release verification**

Run sequentially:

```bash
pnpm typecheck
pnpm test
pnpm build:plugin
git diff --check
```

Expected: typecheck exits 0; all 39+ test files pass; build exits 0 with only the known 1.5 MB size hint; diff check exits 0.

Assert root/plugin artifacts are byte-identical and bundle counts stay clean for Fastify, AJV, dynamic code, `process.env`, `node:fs`, and `node:os`, while `noServer` and `maxPayload` remain present.

- [x] **Step 6: Record verification and commit Task 3**

Mark this plan complete with exact test/build evidence and note that `pnpm audit --prod` remains skipped because policy rejected external dependency-metadata disclosure. Then commit the UI, docs, plan, and regenerated root assets:

```bash
git add README.md apps/obsidian-plugin/src/views/VaultRoomsView.ts apps/obsidian-plugin/src/lanShareReachability.ts apps/obsidian-plugin/src/lanShareReachability.test.ts main.js manifest.json styles.css
git add -f docs/superpowers/specs/2026-07-15-lan-share-reachability-design.md docs/superpowers/plans/2026-07-15-lan-share-reachability.md
git commit -m "fix(plugin): validate LAN share address"
```

After this commit, merge into `main`, re-run the full verification on `main`, create annotated tag `0.2.0`, push it, wait for the release workflow, and publish the draft release.

## Verification record

Completed on 2026-07-15:

- RED evidence: the monitor suite first failed because `lanShareReachability.ts` did not exist; invite-gate tests then showed all three own-server invite methods issued tokens without awaiting a LAN assertion; presentation tests failed before `lanSharePresentation()` existed.
- Focused GREEN: `lanShareReachability.test.ts`, `main.inviteReachability.test.ts`, and `main.refreshTeams.test.ts` passed.
- Static check: `pnpm typecheck` exited 0.
- Full suite: `pnpm test` passed 41 test files and 291 tests.
- Build: `pnpm build:plugin` exited 0 with only the known `main.js 1.5mb` size hint.
- Artifact integrity: root and `apps/obsidian-plugin` copies of `main.js`, `manifest.json`, and `styles.css` are byte-identical. SHA-256: `main.js` `8bbf709dc7746c237116bc2e2e3483e0385d94d576cdf1c7d0a3f278e0c235c5`; `manifest.json` `658572aae8d468491574d160ad4c98afe4fda81f4c5b292614cbf1fb1d340c53`; `styles.css` `5ffe0f8b270eaefb60b8dc7eb7ba33c5f6fcc46094e94efcfaec390d608276b7`.
- Bundle scan: Fastify, AJV, `new Function`, `eval(`, `process.env`, `node:fs`, and `node:os` counts are zero; `noServer` and `maxPayload` remain present.
- `git diff --check` exited 0.
- `pnpm audit --prod` was not run because the execution policy rejected sending dependency metadata externally. No bypass was attempted.
- External checks still required after the local commit: re-run the same full suite on `main`, push the annotated `0.2.0` tag, wait for the GitHub release workflow, and publish its draft release. The two-real-machine TLS/LAN behavior was exercised manually by the user before this LAN-address UX correction; the corrected badge/gate still requires the final Obsidian manual smoke check after installing the rebuilt artifacts.
