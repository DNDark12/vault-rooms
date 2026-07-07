export const PRODUCT_NAME = "vault-rooms";
export const PRODUCT_VERSION = "0.1.0";

export * from "./errors.js";
export * from "./ids.js";
export * from "./paths.js";
export * from "./protocol.js";
export * from "./tokens.js";
export * from "./types.js";

export type HealthResponse = {
  ok: true;
  name: typeof PRODUCT_NAME;
  version: typeof PRODUCT_VERSION;
};
