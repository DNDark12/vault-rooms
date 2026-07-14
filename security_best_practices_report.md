# TLS/WSS and SPKI Pinning Security Audit

Date: 2026-07-14  
Branch: `feature/tls-wss-spki-pinning`  
Scope: the uncommitted TLS/WSS, SPKI-pinning, migration, rotation, embedded-runtime, client-routing, UI, documentation, and generated-bundle changes described by `docs/superpowers/plans/2026-07-13-tls-pinning.md`.

## Outcome

Six independent read-only review scopes were run in two waves, then every reported issue was re-checked against the current source, design, and plan. Confirmed findings were fixed with focused red/green tests before the full verification gate. A separate post-fix security re-review found one additional Critical and several Important/Minor issues; those were fixed and the same reviewer returned PASS with no remaining Critical/Important defect in that scope.

## Confirmed findings and resolution

| Severity | Finding | Resolution and evidence |
|---|---|---|
| Critical | An attacker could copy the public `serverId` into a pinned invite and make the client send an existing bearer token to attacker-controlled URL/pin material. | A changed/untrusted invite identity now receives no `Authorization` header. Strict migration uses a TLS-only HMAC proof bound to device ID, server ID, exact invite token, and SPKI; the real server verifies it against the stored token hash and rotates the credential atomically. Copied proofs are useless for another invite or identity. |
| High | Embedded plaintext WebSocket upgrades bypassed TLS enforcement. | Global transport hooks now run before `handleUpgrade`; a real-socket regression test proves `ws://` is rejected in `tls_enforced`. |
| High | Listener shutdown took its socket snapshot before stopping new accepts. | Listener close starts first and transport sockets are re-scanned after close stabilizes; a deterministic late-socket test covers the race. |
| High | Pinned standalone HTTPS-only startup could silently strand legacy clients without an explicit lifecycle decision. | `plain_legacy` requires explicit dual-stack migration; removing dual-stack from persisted `tls_migrating` is the explicit enforcement action and is committed before HTTPS-only startup. |
| High | Standalone dual-stack could expose a fresh pinned server over HTTP and had no explicit CLI enforcement transition. | Fresh/pinned/enforced states reject dual-stack. Existing plaintext enters migration only through explicit dual-stack startup; restarting a persisted migration with dual-stack disabled durably commits `tls_enforced` before HTTPS-only startup. |
| High | Token/security-state mutations could be returned before sql.js' delayed image write, allowing a crash or write failure to resurrect a replaced token or lose enforcement state. | Security-sensitive repository operations now cross a snapshot-backed durable boundary. Standalone uses atomic replacement; embedded persistence uses the crash-recoverable DataAdapter replacement described below. Write failure restores the prior in-memory database before the caller can expose the new credential/state. |
| High | Embedded durable writes promoted a sibling temp file with `DataAdapter.rename(temp, target)`, but the real Obsidian adapter rejects an existing destination; startup stopped with `Destination file already exists!` while permissive mocks passed. Identity renewal/rotation had the same latent failure. | Test adapters now reproduce real no-overwrite semantics. SQLite and identity stores share a recoverable temp → backup → target replacement, restore the last complete file on failure, and recover interrupted replacements on startup. |
| High | Interim v0.1 handling could archive/reset a legacy database and discard saved plugin credentials/mount state, leaving an intact first-owner-wins server whose UI incorrectly offered bootstrap again. | Exact tagged and older room/share-scoped fixtures now migrate in place. Both runtimes make a one-time byte backup, settings retain tokens and mount state, empty resets recover automatically, non-empty resets require an explicit backup-preserving restore, and erased local owner credentials recover only through a durable same-process lifecycle method. |
| High | An unrelated writer could interleave while an embedded durable image was in flight, then be erased by snapshot rollback if persistence failed. | Embedded durability is serialized and installs a mutation barrier before its first await. Outside writers fail transiently until the rollback-capable write completes, so restore cannot erase another request's committed mutation. |
| High | The route-level one-owner check left repository bootstrap vulnerable to a race between two already-authorized bootstrap requests. | `bootstrapServer` now re-checks owner absence inside its SQL transaction; first-owner-wins is enforced at the integrity boundary, not only before it. |
| High | A pinned invite with a different `serverId` could fall back by URL and receive another server's bearer token. | `serverId` matches are now exact; URL fallback is legacy-invite-only. |
| High | Strict migration could not match a real legacy connection with no stored `serverId`, especially after a host/IP change. | The client asks every eligible legacy connection at that connection's own saved URL for its stable server ID, persists an exact match, then uses the request-bound proof above. It never sends the legacy bearer token to the invite URL. |
| High | Rotation-probe URL userinfo could synthesize Basic Authorization over unverified TLS. | The probe requires HTTPS, rejects username/password before networking, and overwrites path/query/fragment with the exact public rotations path. |
| Medium | Credentialless rotation responses were buffered without a bound. | The probe rejects declared or streamed bodies above 256 KiB and destroys the response/request. |
| Medium | Public rotation probes wrote an unbounded durable audit row per unauthenticated request. | A shared per-IP fixed-window limiter rejects excess probes before the audit write; served responses still retain the plan-required audit event. |
| Medium | Standalone accepted `TLS_DUAL_STACK=true` with OS-trusted mode although that runtime is HTTPS-only. | Unsupported configuration is rejected explicitly; dual-stack remains pinned-mode-only. |
| Medium | Identity rotation persisted/audited the new identity before listener replacement succeeded, and incomplete rollback could leave stale `running` status. | Failed replacement attempts durable and listener rollback together; audit/status update only after success. If either rollback leg fails, the whole embedded relay is closed and reports stopped so no stale pin/listener state is advertised. |
| Medium | Embedded migration opened TLS before persisting state but did not close that listener or restore runtime URL state if persistence failed. | Migration persistence is awaited; failure closes only the new TLS listener, restores the prior runtime/public URL, keeps HTTP healthy, and allows a clean retry. |
| Medium | A stable server ID could be written lazily after `identity.json`, so a crash could leave the key file permanently mismatched with a regenerated DB ID. | Both runtimes persist `serverId` before creating/loading identity material; fresh embedded pinned state is committed in the same startup boundary. |
| Medium | Enforcement could commit `tls_enforced` and then fail to close the plaintext listener while status still reported migration. | Listener shutdown failure now closes the whole embedded relay and reports stopped. The durable enforced state makes the next start HTTPS-only. |
| Medium | A fixed identity temp path could follow a pre-created symlink or retain permissive mode. | Standalone identity saves use random exclusive `wx` temp files, handle-level `0600`, fsync, atomic rename, final `0600`, and cleanup. |
| Medium | Settings Test actions could bypass saved pin material, including when a pinned record was incomplete. | Both settings surfaces now use the same fail-closed `pinnedInfoForServer` helper; incomplete pin material throws before either pinned or unpinned networking. |
| Medium | Earliest `shares`/`share_id` databases could coexist with room/capability rows using the same primary ID; `insert ... where not exists`/`insert or ignore` could silently retain only one conflicting record. | Preflight integrity checks deduplicate only field-equivalent records. A conflicting room or capability ID aborts before mutation, leaving both legacy sources intact for recovery. |
| Medium | HTTPS-only standalone startup checked an unused plaintext `PORT` and could fail even when its actual `TLS_PORT` was free. | Port validation now follows the listener topology: HTTPS-only checks only the TLS port, while dual-stack checks both ports. |
| Low | Public per-IP limiter keys could accumulate indefinitely across distinct source addresses. | Expired windows are pruned and the in-memory key set is bounded. |
| Low | Rotation verification parsed attacker-controlled new-cert data before authenticating the record. | Verification order is now pinned old cert and canonical payload, signature, validity, replay, then new cert/SPKI. |
| Low | Injected lifecycle clocks did not drive renewed/rotated certificate and record timestamps. | `now` is threaded through identity generation, leaf renewal, and rotation-record creation; repeated checks at one clock are stable. |
| Low | Pin-mismatch UI omitted required recovery actions and technical context. | The blocking modal now offers fresh-invite, local removal, technical-details, and close actions only; no trust-anyway path exists. |
| Low | Documentation omitted the public rotation route and mixed v0.1/v0.2 behavior. | `README.md` and `SECURITY.md` now list the full unauthenticated surface, identify v0.2.0 transport behavior, and retain the two-machine release gate separately. |

## Security controls re-verified

- Normal pinned REST/WSS uses the saved identity certificate as `ca`, the stable internal TLS name, and `rejectUnauthorized: true`.
- The only `rejectUnauthorized: false` call remains the credentialless rotation probe.
- Normal bearer-token REST and WebSocket authentication share `authenticateActiveDeviceToken`; every successful migration rotation closes cached authenticated sockets. Strict fresh-invite acceptance uses only the scoped HMAC proof described above and never sends the old bearer to the invite endpoint.
- Device `token_security` is derived from the accepted listener transport, not request input.
- Fresh embedded bootstrap is pinned before credentials; planned-rotation replay IDs remain durable in settings.
- v0.1 tagged, room-scoped, and earliest `shares`/`share_id` data migrate without resetting bearer tokens, mounts, files/history, ACLs, or ownership; legacy tokens remain classified as `plain`.
- The Obsidian-reachable shared graph does not import standalone filesystem/environment modules.
- Release metadata is aligned at `0.2.0`; root and app manifests match `versions.json`, package metadata, protocol health output, and WebSocket hello metadata.

## Final automated verification

- `pnpm typecheck`: PASS.
- `pnpm test`: PASS — 36 files, 246 tests.
- `pnpm build:plugin`: PASS; root/app `main.js` are byte-identical. The minified bundle is 1,516,428 bytes. Esbuild prints its size marker (`⚠️`) because the single-file plugin embeds the required sql.js WASM; it is not a compilation diagnostic or an Obsidian submission error.
- Artifact/source policy scan: zero `fastify`, `Fastify`, `ajv`, `new Function`, `process.env`, `node:fs`, or `networkInterfaces` occurrences in `main.js`; bundled `noServer`/`maxPayload` remain present. All three `rejectUnauthorized` sites were inspected: two pinned authenticated transports are `true`, and the sole `false` is the credentialless rotation probe. The one clipboard occurrence is the documented invite-copy Recommendation-tier exception.
- Manifest/package check: root and app manifests, `versions.json`, all workspace package versions, protocol health metadata, and WebSocket hello metadata agree on `0.2.0`; `minAppVersion` is `1.12.7`.
- `git diff --check`: PASS.
- Live `pnpm audit --prod`: PASS — no known production dependency vulnerabilities reported by the npm registry.

## Release gate not verified here

The plan's two-real-machine manual E2E matrix remains owner-run: fresh pinned team, normal legacy migration, strict fresh-invite migration, wrong-server mismatch modal, and enforcement against an intentionally unmigrated client. No release tag should be created until those results are recorded.
