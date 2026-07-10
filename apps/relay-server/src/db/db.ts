import { existsSync, renameSync, rmSync } from "node:fs";
import { runMigrations } from "./migrations.js";
import { openSqlJsDb, type RelayDb, type SqlJsLocator } from "./sqlJsAdapter.js";

export type { RelayDb } from "./sqlJsAdapter.js";

export async function openRelayDb(dbPath: string, locator?: SqlJsLocator): Promise<RelayDb> {
  if (dbPath !== ":memory:" && existsSync(dbPath)) {
    await archiveLegacyDbIfNeeded(dbPath, locator);
  }
  const db = await openSqlJsDb(dbPath, locator);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

// Breaking reset (no data migration): if the on-disk DB still has the old team-scoped devices
// table (devices.team_id), it predates this schema redesign. Archive it so a fresh DB gets
// created at the original path by the caller - see
// docs/superpowers/specs/2026-07-07-friends-teams-rooms-design.md.
async function archiveLegacyDbIfNeeded(dbPath: string, locator?: SqlJsLocator): Promise<void> {
  const probeDb = await openSqlJsDb(dbPath, locator);
  let isLegacy: boolean;
  try {
    isLegacy = Boolean(probeDb.prepare("select 1 from pragma_table_info('devices') where name = 'team_id'").get());
  } finally {
    void probeDb.close();
  }
  if (!isLegacy) {
    return;
  }
  const archivePath = `${dbPath}.bak-v1`;
  if (existsSync(archivePath)) {
    rmSync(archivePath);
  }
  renameSync(dbPath, archivePath);
}
