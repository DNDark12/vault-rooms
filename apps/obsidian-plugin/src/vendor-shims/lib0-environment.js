/**
 * Build-time replacement for `lib0/environment.js` (a transitive dependency of `yjs` and
 * `y-codemirror.next`, pulled in for Phase 0.1 of the CRDT sync plan - see
 * docs/superpowers/plans/2026-07-20-crdt-sync.md).
 *
 * The real module reads `process.env[...]`/`process.argv`/`process.stdout.isTTY` at *module load
 * time* (not lazily) to detect whether it's running in Node vs a browser and whether the terminal
 * supports ANSI colors, purely so its sibling `lib0/logging(.node).js` can decide whether to print
 * colored console output. Obsidian's community-plugin review scanner flags any `process.env` reach-
 * able from the embedded bundle (CLAUDE.md rule 3) regardless of who reads it or why, so this file
 * is substituted for the real one via an esbuild `onLoad` intercept in esbuild.config.mjs, matched
 * on the resolved path so it applies no matter which of lib0's node/browser export conditions
 * esbuild would otherwise have picked.
 *
 * Values below are hardcoded to what the real module would already compute in this plugin's actual
 * runtime (a bundled, `platform: "node"` Electron/Obsidian process, never a bare browser, never run
 * with `--production`/`NO_COLOR`/`FORCE_COLOR` flags a plugin user could set): `isNode = true`,
 * `isBrowser = false`. This is not a behavior change, only a way to reach the same values without a
 * runtime `process.env`/`process.argv` read. Every export below matches `lib0/environment.js`'s
 * public surface so any lib0 submodule that imports it (buffer.js, logging.js, logging.common.js,
 * schema.js, index.js) keeps working unchanged.
 */

export const isNode = true;
export const isBrowser = false;
export const isMac = false;

/** @returns {boolean} */
export const hasParam = () => false;

/**
 * @param {string} _name
 * @param {string} defaultVal
 * @returns {string}
 */
export const getParam = (_name, defaultVal) => defaultVal;

/**
 * @param {string} _name
 * @returns {string | null}
 */
export const getVariable = () => null;

/**
 * @param {string} _name
 * @returns {string | null}
 */
export const getConf = () => null;

/**
 * @param {string} name
 * @returns {string}
 */
export const ensureConf = (name) => {
  throw new Error(`Expected configuration "${name.toUpperCase().replaceAll("-", "_")}"`);
};

/** @returns {boolean} */
export const hasConf = () => false;

export const production = false;
export const supportsColor = false;
