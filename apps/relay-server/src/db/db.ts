import { copyFileSync, existsSync } from "node:fs";
import { isV01Schema, runMigrations } from "./migrations.js";
import { openSqlJsDb, type RelayDb, type SqlJsLocator } from "./sqlJsAdapter.js";

export type { RelayDb } from "./sqlJsAdapter.js";

export async function openRelayDb(dbPath: string, locator?: SqlJsLocator): Promise<RelayDb> {
  if (dbPath !== ":memory:") {
    await recoverArchivedLegacyDbIfEmpty(dbPath, locator);
    if (existsSync(dbPath)) {
      await backupLegacyDbIfNeeded(dbPath, locator);
    }
  }
  const db = await openSqlJsDb(dbPath, locator);
  try {
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    await db.flush();
    return db;
  } catch (error) {
    // Do not leak a live sql.js image or its delayed flush timer when startup rejects a database.
    // Preserve the migration error; close is only cleanup and may itself fail on a broken adapter.
    try {
      await db.close();
    } catch {
      // The original migration/startup error is the actionable one.
    }
    throw error;
  }
}

async function backupLegacyDbIfNeeded(dbPath: string, locator?: SqlJsLocator): Promise<void> {
  const probeDb = await openSqlJsDb(dbPath, locator);
  let isLegacy: boolean;
  try {
    isLegacy = isV01Schema(probeDb);
  } finally {
    void probeDb.close();
  }
  if (!isLegacy) {
    return;
  }
  const backupPath = `${dbPath}.bak-v1`;
  if (!existsSync(backupPath)) {
    copyFileSync(dbPath, backupPath);
  }
}

async function recoverArchivedLegacyDbIfEmpty(dbPath: string, locator?: SqlJsLocator): Promise<void> {
  const backupPath = `${dbPath}.bak-v1`;
  if (!existsSync(backupPath)) {
    return;
  }
  const backup = await inspectDatabase(backupPath, locator);
  if (!backup.v01) {
    return;
  }
  if (!existsSync(dbPath)) {
    copyFileSync(backupPath, dbPath);
    return;
  }
  const active = await inspectDatabase(dbPath, locator);
  if (active.emptyCurrent) {
    copyFileSync(backupPath, dbPath);
  }
}

async function inspectDatabase(dbPath: string, locator?: SqlJsLocator): Promise<{ v01: boolean; emptyCurrent: boolean }> {
  const db = await openSqlJsDb(dbPath, locator);
  try {
    const v01 = isV01Schema(db);
    if (v01 || !tableExists(db, "users") || !tableExists(db, "server_meta")) {
      return { v01, emptyCurrent: false };
    }
    const userCount = db.prepare("select count(*) as count from users").get() as { count: number };
    const owner = db.prepare("select value from server_meta where key = 'owner_user_id'").get();
    return { v01: false, emptyCurrent: userCount.count === 0 && !owner };
  } finally {
    await db.close();
  }
}

function tableExists(db: RelayDb, table: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table));
}
