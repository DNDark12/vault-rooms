import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { isV01Schema, runMigrations } from "./migrations.js";
import {
  inspectSqlJsDatabaseBytes,
  openSqlJsDb,
  type RelayDb,
  type RelayDbReader,
  type SqlJsLocator
} from "./sqlJsAdapter.js";

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
  const activeBytes = readFileSync(dbPath);
  if (!(await inspectDatabaseBytes(activeBytes, locator)).v01) {
    return;
  }
  const backupPath = `${dbPath}.bak-v1`;
  if (existsSync(backupPath)) {
    const backupBytes = readFileSync(backupPath);
    let matchingLegacyBackup = false;
    try {
      matchingLegacyBackup = (await inspectDatabaseBytes(backupBytes, locator)).v01 && backupBytes.equals(activeBytes);
    } catch {
      // Preserve the unparsable file under a quarantine name below.
    }
    if (matchingLegacyBackup) return;
    renameSync(backupPath, nextInvalidBackupPath(backupPath));
  }
  writeCreateOnlyAtomic(backupPath, activeBytes);
}

async function recoverArchivedLegacyDbIfEmpty(dbPath: string, locator?: SqlJsLocator): Promise<void> {
  const backupPath = `${dbPath}.bak-v1`;
  if (!existsSync(backupPath)) {
    return;
  }
  let backup: { v01: boolean; emptyCurrent: boolean };
  try {
    backup = await inspectDatabaseBytes(readFileSync(backupPath), locator);
  } catch {
    return;
  }
  if (!backup.v01) {
    return;
  }
  if (!existsSync(dbPath)) {
    copyFileSync(backupPath, dbPath);
    return;
  }
  let active: { v01: boolean; emptyCurrent: boolean };
  try {
    active = await inspectDatabaseBytes(readFileSync(dbPath), locator);
  } catch {
    return;
  }
  if (active.emptyCurrent) {
    copyFileSync(backupPath, dbPath);
  }
}

async function inspectDatabaseBytes(
  bytes: Uint8Array,
  locator?: SqlJsLocator
): Promise<{ v01: boolean; emptyCurrent: boolean }> {
  return inspectSqlJsDatabaseBytes(bytes, (db) => {
    const v01 = isV01Schema(db);
    if (v01 || !tableExists(db, "users") || !tableExists(db, "server_meta")) {
      return { v01, emptyCurrent: false };
    }
    const userCount = db.prepare("select count(*) as count from users").get() as { count: number };
    const owner = db.prepare("select value from server_meta where key = 'owner_user_id'").get();
    return { v01: false, emptyCurrent: userCount.count === 0 && !owner };
  }, locator);
}

function tableExists(db: RelayDbReader, table: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table));
}

function nextInvalidBackupPath(backupPath: string): string {
  const base = `${backupPath}.invalid`;
  if (!existsSync(base)) return base;
  let suffix = 2;
  while (existsSync(`${base}.${suffix}`)) suffix += 1;
  return `${base}.${suffix}`;
}

function writeCreateOnlyAtomic(targetPath: string, bytes: Uint8Array): void {
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // A hard link is an atomic create-only promotion: it fails instead of replacing targetPath.
    linkSync(temporaryPath, targetPath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}
