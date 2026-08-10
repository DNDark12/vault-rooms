/** Build-time lib0 environment shim without runtime environment probes. */

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
