import { runMigrations } from "./migrations.js";
import { openSqlJsDb, type RelayDb, type SqlJsLocator } from "./sqlJsAdapter.js";

export type { RelayDb } from "./sqlJsAdapter.js";

export async function openRelayDb(dbPath: string, locator?: SqlJsLocator): Promise<RelayDb> {
  const db = await openSqlJsDb(dbPath, locator);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}
