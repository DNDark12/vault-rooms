/** Build-time lib0 logger shim that routes messages through allowed methods. */

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
