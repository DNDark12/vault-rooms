import { normalizePath, type DataAdapter } from "obsidian";
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from "sql.js/dist/sql-wasm-browser.js";
import type { PreparedStatement, RelayDb, SqlJsLocator, SqlRow } from "vault-rooms-relay/embedded-core";
import { recoverDataAdapterFileReplacement, replaceDataAdapterFile } from "./dataAdapterFileReplace.js";

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

function loadSqlJs(locator?: SqlJsLocator): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs(locator?.wasmBinary ? { wasmBinary: locator.wasmBinary } : undefined);
  }
  return sqlJsPromise;
}

function normalizeParams(params: unknown[]): (number | string | Uint8Array | null)[] {
  return params.map((value) => (value === undefined ? null : (value as number | string | Uint8Array | null)));
}

export async function openObsidianSqlJsDb(adapter: DataAdapter, dbPath: string, locator?: SqlJsLocator): Promise<RelayDb> {
  const normalizedPath = normalizePath(dbPath);
  const SQL = await loadSqlJs(locator);
  await recoverDataAdapterFileReplacement(adapter, normalizedPath);
  const initialBytes = await loadInitialDatabaseBytes(adapter, normalizedPath, SQL);
  let sqlDb: SqlJsDatabase = new SQL.Database(initialBytes);
  const flushPath = normalizedPath;

  let closed = false;
  let flushTimer: number | null = null;
  let pendingFlush: Promise<void> | null = null;
  let pendingDurableOperations = 0;
  let insideDurableOperation = false;
  let durableTail: Promise<void> = Promise.resolve();

  function assertOpen(): void {
    if (closed) {
      throw new Error("RelayDb is closed");
    }
  }

  function assertWritable(): void {
    if (pendingDurableOperations > 0 && !insideDurableOperation) {
      throw new Error("Database mutation is blocked until durable persistence completes.");
    }
  }

  async function flush(): Promise<void> {
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer);
      flushTimer = null;
    }
    // Chain onto any flush already in flight instead of racing it: two overlapping writeBinary
    // calls to the same path can finish in either order, so the last one to complete could
    // silently clobber fresher bytes with a stale snapshot. Chaining (and not resetting
    // pendingFlush back to null below) guarantees writes to flushPath happen strictly in
    // invocation order, and lets close()'s "await pendingFlush" guard drain the whole chain.
    const previous = pendingFlush;
    const current: Promise<void> = (async () => {
      if (previous) {
        await previous.catch(() => {});
      }
      const bytes = sqlDb.export();
      await ensureParentFolder(adapter, flushPath);
      const output = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(output).set(bytes);
      await replaceDataAdapterFile(adapter, flushPath, async (temporaryPath) => {
        await adapter.writeBinary(temporaryPath, output);
      });
    })();
    pendingFlush = current;
    await current;
  }

  function restore(snapshot: Uint8Array): void {
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer);
      flushTimer = null;
    }
    sqlDb.close();
    sqlDb = new SQL.Database(snapshot);
  }

  function scheduleFlush(): void {
    if (flushTimer !== null) {
      return;
    }
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      void flush();
    }, 25);
  }

  function prepare(sql: string): PreparedStatement {
    return {
      run(...params: unknown[]) {
        assertOpen();
        assertWritable();
        const stmt = sqlDb.prepare(sql);
        try {
          stmt.bind(normalizeParams(params));
          stmt.step();
        } finally {
          stmt.free();
        }
        scheduleFlush();
        return { changes: sqlDb.getRowsModified() };
      },
      get(...params: unknown[]) {
        assertOpen();
        const stmt = sqlDb.prepare(sql);
        try {
          stmt.bind(normalizeParams(params));
          const hasRow = stmt.step();
          return hasRow ? stmt.getAsObject() : undefined;
        } finally {
          stmt.free();
        }
      },
      all(...params: unknown[]) {
        assertOpen();
        const stmt = sqlDb.prepare(sql);
        const rows: SqlRow[] = [];
        try {
          stmt.bind(normalizeParams(params));
          while (stmt.step()) {
            rows.push(stmt.getAsObject());
          }
        } finally {
          stmt.free();
        }
        return rows;
      }
    };
  }

  return {
    prepare,
    exec(sql: string) {
      assertOpen();
      assertWritable();
      sqlDb.exec(sql);
      scheduleFlush();
    },
    pragma(pragmaString: string) {
      assertOpen();
      assertWritable();
      sqlDb.exec(`pragma ${pragmaString}`);
    },
    transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
      return (...args: Args) => {
        assertOpen();
        assertWritable();
        sqlDb.exec("begin");
        try {
          const result = fn(...args);
          sqlDb.exec("commit");
          scheduleFlush();
          return result;
        } catch (error) {
          sqlDb.exec("rollback");
          throw error;
        }
      };
    },
    flush,
    durable<T>(operation: () => T): Promise<T> {
      pendingDurableOperations += 1;
      const run = durableTail.then(async () => {
        try {
          await flush();
          const snapshot = sqlDb.export();
          try {
            insideDurableOperation = true;
            const result = operation();
            insideDurableOperation = false;
            await flush();
            return result;
          } catch (error) {
            insideDurableOperation = false;
            restore(snapshot);
            throw error;
          }
        } finally {
          pendingDurableOperations -= 1;
        }
      });
      durableTail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
    async close() {
      if (closed) {
        return;
      }
      await durableTail;
      await flush();
      if (pendingFlush) {
        await pendingFlush;
      }
      sqlDb.close();
      closed = true;
    }
  };
}

export async function restoreObsidianLegacyV01Backup(
  adapter: DataAdapter,
  dbPath: string,
  locator?: SqlJsLocator
): Promise<{ previousDatabaseBackupPath?: string }> {
  const normalizedPath = normalizePath(dbPath);
  const backupPath = `${normalizedPath}.bak-v1`;
  if (!(await adapter.exists(backupPath))) {
    throw new Error("No v0.1 relay database backup was found.");
  }
  const SQL = await loadSqlJs(locator);
  const legacyBytes = new Uint8Array(await adapter.readBinary(backupPath));
  if (!inspectRawDatabase(SQL, legacyBytes).v01) {
    throw new Error("The saved relay backup is not a v0.1 database.");
  }

  let previousDatabaseBackupPath: string | undefined;
  if (await adapter.exists(normalizedPath)) {
    previousDatabaseBackupPath = await nextAvailableBackupPath(adapter, `${normalizedPath}.pre-v01-restore`);
    const currentBytes = await adapter.readBinary(normalizedPath);
    await ensureParentFolder(adapter, previousDatabaseBackupPath);
    await adapter.writeBinary(previousDatabaseBackupPath, currentBytes);
  }

  await replaceDataAdapterFile(adapter, normalizedPath, async (temporaryPath) => {
    const replacement = new ArrayBuffer(legacyBytes.byteLength);
    new Uint8Array(replacement).set(legacyBytes);
    await adapter.writeBinary(temporaryPath, replacement);
  });
  return { previousDatabaseBackupPath };
}

async function nextAvailableBackupPath(adapter: DataAdapter, basePath: string): Promise<string> {
  if (!(await adapter.exists(basePath))) {
    return basePath;
  }
  let suffix = 2;
  while (await adapter.exists(`${basePath}.${suffix}`)) {
    suffix += 1;
  }
  return `${basePath}.${suffix}`;
}

async function loadInitialDatabaseBytes(adapter: DataAdapter, dbPath: string, SQL: SqlJsStatic): Promise<Uint8Array | undefined> {
  const backupPath = `${dbPath}.bak-v1`;
  const activeBytes = (await adapter.exists(dbPath)) ? new Uint8Array(await adapter.readBinary(dbPath)) : undefined;
  const backupBytes = (await adapter.exists(backupPath)) ? new Uint8Array(await adapter.readBinary(backupPath)) : undefined;

  if (backupBytes && inspectRawDatabase(SQL, backupBytes).v01) {
    if (!activeBytes || inspectRawDatabase(SQL, activeBytes).emptyCurrent) {
      return backupBytes;
    }
  }
  if (!activeBytes) {
    return undefined;
  }
  if (inspectRawDatabase(SQL, activeBytes).v01 && !backupBytes) {
    await ensureParentFolder(adapter, backupPath);
    const backup = new ArrayBuffer(activeBytes.byteLength);
    new Uint8Array(backup).set(activeBytes);
    await adapter.writeBinary(backupPath, backup);
  }
  return activeBytes;
}

function inspectRawDatabase(SQL: SqlJsStatic, bytes: Uint8Array): { v01: boolean; emptyCurrent: boolean } {
  const db = new SQL.Database(bytes);
  try {
    const deviceColumns = rawColumnNames(db, "devices");
    const v01 =
      deviceColumns.has("team_id") ||
      (deviceColumns.has("token_hash") && (!deviceColumns.has("last_transport") || !deviceColumns.has("token_security")));
    if (
      v01 ||
      !rawQueryHasRow(db, "select 1 from sqlite_master where type = 'table' and name = 'users'") ||
      !rawQueryHasRow(db, "select 1 from sqlite_master where type = 'table' and name = 'server_meta'")
    ) {
      return { v01, emptyCurrent: false };
    }
    const owner = rawQueryHasRow(db, "select value from server_meta where key = 'owner_user_id'");
    const users = rawScalarNumber(db, "select count(*) from users");
    return { v01: false, emptyCurrent: users === 0 && !owner };
  } finally {
    db.close();
  }
}

function rawColumnNames(db: SqlJsDatabase, table: string): Set<string> {
  const stmt = db.prepare(`pragma table_info(${table})`);
  const columns = new Set<string>();
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as { name?: unknown };
      if (typeof row.name === "string") {
        columns.add(row.name);
      }
    }
  } finally {
    stmt.free();
  }
  return columns;
}

function rawQueryHasRow(db: SqlJsDatabase, sql: string): boolean {
  const stmt = db.prepare(sql);
  try {
    return stmt.step();
  } finally {
    stmt.free();
  }
}

function rawScalarNumber(db: SqlJsDatabase, sql: string): number {
  const stmt = db.prepare(sql);
  try {
    if (!stmt.step()) {
      return 0;
    }
    return Number(stmt.get()[0] ?? 0);
  } finally {
    stmt.free();
  }
}

async function ensureParentFolder(adapter: DataAdapter, path: string): Promise<void> {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) {
    return;
  }
  const parts = path.slice(0, slash).split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) {
      await adapter.mkdir(current);
    }
  }
}
