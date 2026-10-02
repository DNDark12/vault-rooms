// Strict-zero tokens are always rejected. Dependency-owned runtime tokens use approved baselines.
// Baselines include dependency, CRDT, storage, and LAN discovery timers.
// Any increase requires source inspection before updating these numbers.
// clearTimeout( 27 -> 28: CrdtDocManager.retireRoom cancels a room's pending materialize timers
// through the injected SyncTimerHost (window timers when embedded), not a bare global.
// globalThis 12 -> 10: CrdtDocStore now anchors its volatile cache ownership/failed-save
// registry to the public vault adapter, preserving reload/window handoff without a global.
// Only the previously inspected dependency-owned references remain allowed.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TIER2_STRICT_ZERO = ["fastify", "Fastify", "ajv", "new Function", "eval(", "process.env", "node:fs", "node:os", "console.log(", "console.info(", "console.trace("];

export const TIER3_APPROVED_BASELINE = {
  "setTimeout(": 27,
  "setInterval(": 3,
  "clearTimeout(": 28,
  "clearInterval(": 3,
  "globalThis": 10,
  "fetch(": 2,
  "window.setTimeout": 15
};

export const REQUIRED_PRESENT = ["noServer", "maxPayload"];

// Modules matched as a require/import specifier, not a substring: a bare "os" would match "photos".
export const STRICT_ZERO_MODULES = ["os"];

const moduleReferences = (bundle, name) =>
  bundle.match(new RegExp(`(?:require\\(\\s*|from\\s*)["'](?:node:)?${name}["']`, "g"))?.length ?? 0;

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

  for (const name of STRICT_ZERO_MODULES) {
    const count = moduleReferences(bundle, name);
    if (count !== 0) {
      failed = true;
      lines.push(`FAIL [tier2 strict-zero] module "${name}" is required ${count} time(s) in main.js - must be 0.`);
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

  // The scan report is command output, not diagnostic logging.
  process.stdout.write(lines.join("\n") + "\n");

  if (failed) {
    process.stderr.write("\nBundle scan FAILED - see FAIL lines above.\n");
    process.exitCode = 1;
  }
}
