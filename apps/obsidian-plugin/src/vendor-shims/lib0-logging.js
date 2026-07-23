/**
 * Build-time replacement for `lib0/logging.js` and `lib0/logging.node.js` (a transitive dependency
 * of `yjs`, pulled in for Phase 0.1 of the CRDT sync plan - see
 * docs/superpowers/plans/2026-07-20-crdt-sync.md).
 *
 * The real module's `print()` calls `console.log(...)` (both the browser and Node variants), and
 * yjs itself calls `logging.print(...)`/`logging.warn(...)` on two real code paths reachable from
 * this plugin: `Transaction.js` ("Changed the client-id because another client seems to be using
 * it") and `UndoManager.js` ("Not same Y.Doc" - directly relevant to the CM6 editor binding's
 * Y.UndoManager usage). CLAUDE.md rule 13 bans `console.log`/`console.info`/`console.trace` from the
 * git tree; both of yjs's real call sites are genuine runtime warnings, so every export below routes
 * to `console.warn`/`console.error` instead - a behavior no-op for correctness, only a change in
 * which console method carries the message. This is substituted in via the same esbuild `onLoad`
 * intercept as lib0-environment.js, matched on the resolved path so it applies regardless of which
 * of lib0's node/browser/bun export conditions esbuild would otherwise have picked.
 *
 * The color constants are exported as plain Symbols (matching lib0/symbol.js's `create = Symbol`)
 * purely so call sites that pass them as arguments (e.g. `logging.print(logging.ORANGE, ...)`)
 * don't throw; this shim never renders color and filters them out before logging.
 */

export const BOLD = Symbol("logging.BOLD");
export const UNBOLD = Symbol("logging.UNBOLD");
export const BLUE = Symbol("logging.BLUE");
export const GREY = Symbol("logging.GREY");
export const GREEN = Symbol("logging.GREEN");
export const RED = Symbol("logging.RED");
export const PURPLE = Symbol("logging.PURPLE");
export const ORANGE = Symbol("logging.ORANGE");
export const UNCOLOR = Symbol("logging.UNCOLOR");

/** @param {Array<unknown>} args */
const toLoggableArgs = (args) => {
  if (args.length === 1 && typeof args[0] === "function") {
    args = args[0]();
  }
  return args.filter((arg) => typeof arg !== "symbol");
};

/** @param {Array<unknown>} args */
export const print = (...args) => {
  console.warn(...toLoggableArgs(args));
};

/** @param {Array<unknown>} args */
export const warn = (...args) => {
  console.warn(...toLoggableArgs(args));
};

/** @param {Error} err */
export const printError = (err) => {
  console.error(err);
};

export const printImg = () => undefined;
export const printImgBase64 = () => undefined;
export const printDom = () => undefined;
export const printCanvas = () => printImg();
export const createVConsole = () => undefined;

/** @param {Array<unknown>} args */
export const group = (...args) => {
  console.warn(...toLoggableArgs(args));
};

/** @param {Array<unknown>} args */
export const groupCollapsed = (...args) => {
  console.warn(...toLoggableArgs(args));
};

export const groupEnd = () => undefined;

/**
 * @param {string} moduleName
 * @returns {(...args: unknown[]) => void}
 */
export const createModuleLogger = (moduleName) => {
  void moduleName;
  return () => undefined;
};
