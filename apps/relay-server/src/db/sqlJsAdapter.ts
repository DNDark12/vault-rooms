import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from "sql.js";

export type SqlRow = Record<string, unknown>;

export interface PreparedStatement {
  run(...params: unknown[]): { changes: number };
  // Untyped like better-sqlite3's Statement#get/#all: callers cast the row shape themselves.
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface RelayDb {
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
  pragma(pragmaString: string): void;
  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R;
  /** Force any pending writes to disk immediately. No-op for in-memory databases. */
  flush(): void | Promise<void>;
  /**
   * Run a security/integrity-sensitive synchronous mutation and expose its result only after the
   * resulting database image is durable. A failed write restores the prior in-memory image too, so
   * the caller never observes a credential/state transition that only half happened.
   */
  durable<T>(operation: () => T): Promise<T>;
  close(): void | Promise<void>;
}

export type SqlJsLocator = {
  /** Pre-read wasm bytes (used when bundled, e.g. inside the Obsidian plugin). */
  wasmBinary?: ArrayBuffer;
  /** Custom resolver for the wasm asset (used when running unbundled, e.g. via tsx). */
  locateFile?: (file: string) => string;
};

let sqlJsPromise: Promise<SqlJsStatic> | null = null;
type FlushTimer = number | ReturnType<typeof setNodeTimeout>;

function setFlushTimeout(callback: () => void, delayMs: number): FlushTimer {
  return typeof window !== "undefined" ? window.setTimeout(callback, delayMs) : setNodeTimeout(callback, delayMs);
}

function clearFlushTimeout(timer: FlushTimer): void {
  if (typeof timer === "number") {
    window.clearTimeout(timer);
  } else {
    clearNodeTimeout(timer);
  }
}

function loadSqlJs(locator?: SqlJsLocator): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    const config = locator?.wasmBinary
      ? { wasmBinary: locator.wasmBinary }
      : locator?.locateFile
        ? { locateFile: locator.locateFile }
        : undefined;
    sqlJsPromise = initSqlJs(config);
  }
  return sqlJsPromise;
}

function normalizeParams(params: unknown[]): (number | string | Uint8Array | null)[] {
  return params.map((value) => (value === undefined ? null : (value as number | string | Uint8Array | null)));
}

export async function openSqlJsDb(dbPath: string, locator?: SqlJsLocator): Promise<RelayDb> {
  const SQL = await loadSqlJs(locator);
  const isMemory = dbPath === ":memory:";

  let initialBytes: Uint8Array | undefined;
  if (!isMemory) {
    mkdirSync(dirname(dbPath), { recursive: true });
    if (existsSync(dbPath)) {
      initialBytes = new Uint8Array(readFileSync(dbPath));
    }
  }

  let sqlDb: SqlJsDatabase = new SQL.Database(initialBytes);

  let closed = false;
  function assertOpen(): void {
    if (closed) {
      throw new Error("RelayDb is closed");
    }
  }

  let flushTimer: FlushTimer | null = null;

  function flush(): void {
    if (isMemory) {
      return;
    }
    if (flushTimer) {
      clearFlushTimeout(flushTimer);
      flushTimer = null;
    }
    const temporaryPath = `${dbPath}.tmp`;
    try {
      writeFileSync(temporaryPath, Buffer.from(sqlDb.export()));
      renameSync(temporaryPath, dbPath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  function restore(snapshot: Uint8Array): void {
    sqlDb.close();
    sqlDb = new SQL.Database(snapshot);
  }

  function scheduleFlush(): void {
    if (isMemory || flushTimer) {
      return;
    }
    flushTimer = setFlushTimeout(() => {
      flushTimer = null;
      flush();
    }, 25);
    if (typeof flushTimer !== "number") {
      flushTimer.unref();
    }
  }

  function prepare(sql: string): PreparedStatement {
    return {
      run(...params: unknown[]) {
        assertOpen();
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
      sqlDb.exec(sql);
      scheduleFlush();
    },
    pragma(pragmaString: string) {
      assertOpen();
      sqlDb.exec(`PRAGMA ${pragmaString}`);
    },
    transaction<Args extends unknown[], R>(fn: (...args: Args) => R) {
      return (...args: Args): R => {
        assertOpen();
        sqlDb.exec("BEGIN");
        try {
          const result = fn(...args);
          sqlDb.exec("COMMIT");
          scheduleFlush();
          return result;
        } catch (error) {
          try {
            sqlDb.exec("ROLLBACK");
          } catch {
            // no active transaction to roll back; ignore
          }
          throw error;
        }
      };
    },
    flush() {
      if (closed) {
        return;
      }
      flush();
    },
    async durable<T>(operation: () => T): Promise<T> {
      flush();
      const snapshot = sqlDb.export();
      try {
        const result = operation();
        flush();
        return result;
      } catch (error) {
        restore(snapshot);
        throw error;
      }
    },
    close() {
      if (closed) {
        return;
      }
      flush();
      closed = true;
      sqlDb.close();
    }
  };
}
