// Four-tier bundle scanner for the shipped Obsidian plugin artifact (root main.js).
//
// Context: docs/superpowers/plans/2026-07-20-crdt-sync.md Phase 0.1 / contract P1-g. A naive
// "these tokens must appear zero times" gate fails on the bundle we already ship today - a fresh
// build (before any CRDT code) already contains legitimate `window.setTimeout`-adjacent bare
// `setTimeout(`/`clearTimeout(` etc. from bundled third-party deps (`ws`'s pure-JS fallback,
// sql.js's emscripten glue) and `globalThis`/`fetch(` from the same sources. So this script tracks
// two different kinds of finding:
//
//   Tier 2 (strict-zero): tokens that must NEVER appear, no matter which dependency introduces
//   them, because Obsidian's plugin-review scanner treats their mere presence in the bundle as a
//   capability finding (Dynamic Code Execution, filesystem/OS access) regardless of source.
//
//   Tier 3/4 (baseline-aware): tokens that legitimately appear in bundled third-party code today
//   (bare timers, `globalThis`, `fetch(`) and are not by themselves a review-blocking finding (our
//   OWN source under apps/**/src/** is covered by the strict source-level ESLint rules in CLAUDE.md
//   rules 1-2/13 separately - this script only looks at the built artifact). The gate here is
//   regression-vs-approved-baseline: a count is fine at or below the last approved number; a rise
//   means a new dependency introduced a new occurrence and needs the same read-the-source
//   justification this file's history already has for the current approved numbers, not a silent
//   bump.
//
// Approved baseline history:
//   - 2026-07-20 pre-CRDT (this repo before any Phase 0.1 dependency): setTimeout( 17,
//     setInterval( 2, clearTimeout( 17, clearInterval( 2, globalThis 8, fetch( 2,
//     window.setTimeout 11. (ws pure-JS fallback + sql.js emscripten glue + our own
//     window.setTimeout call sites.)
//   - 2026-07-20 Phase 0.1 (yjs 13.6.31 + y-codemirror.next 0.3.5 added): globalThis rises to 10
//     (+2). Read at the source (lib0/buffer.js): its Node base64 codec looks up `Buffer` via a
//     lazy `globalThis.Buffer` accessor rather than a bare `Buffer` identifier, specifically so the
//     module doesn't force bundlers to polyfill/externalize `Buffer` when targeting a browser -
//     this is the *safer* of the two patterns, not a red flag. No other tier 3/4 count moved: the
//     `process.env` regression (lib0/environment.js, 0 -> 2) and the `console.log(` regression
//     (lib0/logging(.node).js, 0 -> 1) that adding these deps first produced were both Tier-2/13
//     violations and are fixed at the source via the esbuild onLoad substitution in
//     esbuild.config.mjs (see src/vendor-shims/lib0-*.js) - not allowlisted, actually removed.
//   - 2026-07-21 Phase 4 (apps/relay-server/src/sync/crdtDocManager.ts added): setTimeout( 17->18
//     (+1), setInterval( 2->3 (+1), clearTimeout( 17->20 (+3), clearInterval( 2->3 (+1). Read at
//     the source: every one of these is `this.timerHost.setTimeout/.setInterval/.clearTimeout/
//     .clearInterval(...)` inside crdtDocManager.ts - the materialize-debounce timer (one
//     setTimeout call site, cleared from three places: dispose(), evictDocument(), and
//     scheduleMaterialize()'s own clear-then-reset) and the idle-eviction sweep (one setInterval
//     call site, cleared from dispose()). All calls go through the injected `SyncTimerHost` this
//     class receives as a constructor parameter (real Node timers in appCore.ts, `window.setTimeout`
//     et al. in embeddedRelayApp.ts) - CLAUDE.md rule 2 compliant by construction, exactly the
//     "shared modules receive timers through explicit options" pattern the rule requires. The
//     scanner's substring match can't see the `this.timerHost.` prefix, so these show up as if they
//     were bare calls; they are not. No new globalThis/fetch(/process.env/console.log( occurrences -
//     this phase added no new third-party dependency, only first-party code.
//   - 2026-07-21 Phase 5 (apps/obsidian-plugin/src/crdtSession.ts added): setTimeout( 18->19 (+1),
//     clearTimeout( 20->21 (+1), window.setTimeout 11->12 (+1). Read at the source:
//     CrdtSessionManager's persist/materialize debounce timers default to
//     `(fn, ms) => window.setTimeout(fn, ms)` / `(id) => window.clearTimeout(id)` when the plugin
//     doesn't inject a `schedule`/`cancel` override - one call site each, exactly matching the
//     CLAUDE.md rule 2 pattern already used by pushCoordinator.ts's RoomPushCoordinator (plugin-only
//     file, calls `window.setTimeout`/`window.clearTimeout` directly rather than importing a shared
//     timer-host abstraction, since it never runs outside Obsidian's process). No new
//     setInterval(/clearInterval(/globalThis/fetch(/process.env/console.log( occurrences - this
//     phase added no new third-party dependency (yjs/y-codemirror.next were already bundled since
//     Phase 4), only first-party code.
//
// The scanning logic is exported so apps/obsidian-plugin/test/crdtBundleGuard.test.ts can run the
// exact same checks under `pnpm test` without duplicating the tier tables (duplication would let
// the CLI gate and the test drift apart, which is exactly the kind of silent regression this
// exists to prevent). This file's default CLI behavior (reading root main.js and writing a report)
// only runs when invoked directly, not when imported.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TIER2_STRICT_ZERO = ["fastify", "Fastify", "ajv", "new Function", "eval(", "process.env", "node:fs", "node:os", "console.log(", "console.info(", "console.trace("];

export const TIER3_APPROVED_BASELINE = {
  "setTimeout(": 19,
  "setInterval(": 3,
  "clearTimeout(": 21,
  "clearInterval(": 3,
  "globalThis": 10,
  "fetch(": 2,
  "window.setTimeout": 12
};

export const REQUIRED_PRESENT = ["noServer", "maxPayload"];

const countOf = (bundle, token) => {
  let count = 0;
  let index = bundle.indexOf(token);
  while (index !== -1) {
    count += 1;
    index = bundle.indexOf(token, index + token.length);
  }
  return count;
};

/**
 * @param {string} bundle
 * @returns {{ failed: boolean, lines: string[] }}
 */
export function scanBundle(bundle) {
  let failed = false;
  const lines = [];

  for (const token of TIER2_STRICT_ZERO) {
    const count = countOf(bundle, token);
    if (count !== 0) {
      failed = true;
      lines.push(`FAIL [tier2 strict-zero] "${token}" found ${count} time(s) in main.js - must be 0.`);
    }
  }

  for (const [token, approved] of Object.entries(TIER3_APPROVED_BASELINE)) {
    const count = countOf(bundle, token);
    if (count > approved) {
      failed = true;
      lines.push(`FAIL [tier3/4 regression] "${token}" appears ${count} time(s), approved baseline is ${approved}. A new dependency likely introduced this - read the source, then either fix it at the source (like lib0-environment.js/lib0-logging.js) or raise the approved baseline here with a written justification, same as the existing history in this file's header comment.`);
    } else {
      lines.push(`ok   [tier3/4] "${token}": ${count} (approved baseline ${approved})`);
    }
  }

  for (const token of REQUIRED_PRESENT) {
    const count = countOf(bundle, token);
    if (count === 0) {
      failed = true;
      lines.push(`FAIL [required-present] "${token}" not found in main.js - expected present (e.g. ws's noServer/maxPayload).`);
    } else {
      lines.push(`ok   [required-present] "${token}": ${count}`);
    }
  }

  lines.push(`main.js size: ${bundle.length} bytes`);
  return { failed, lines };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const bundle = readFileSync(resolve(root, "main.js"), "utf8");
  const { failed, lines } = scanBundle(bundle);

  // This report is the script's actual primary output (like index.ts's startup banner), not
  // diagnostic logging, so it goes straight to stdout/stderr rather than through console.* - see
  // CLAUDE.md rule 13.
  process.stdout.write(lines.join("\n") + "\n");

  if (failed) {
    process.stderr.write("\nBundle scan FAILED - see FAIL lines above.\n");
    process.exitCode = 1;
  }
}
