import { openRelayDb } from "./db/db.js";
import type { SqlJsLocator } from "./db/sqlJsAdapter.js";
import { createAppWithDb, type CreateAppCoreOptions } from "./appCore.js";

export type CreateAppOptions = CreateAppCoreOptions & {
  dbPath?: string;
  sqlJsLocator?: SqlJsLocator;
};

export async function createApp(options: CreateAppOptions = {}) {
  const db = await openRelayDb(options.dbPath ?? "data/relay.sqlite", options.sqlJsLocator);
  return createAppWithDb(db, options);
}
