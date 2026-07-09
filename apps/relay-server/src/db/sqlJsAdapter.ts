import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  flush(): void;
  close(): void;
}

export type SqlJsLocator = {
  /** Pre-read wasm bytes (used when bundled, e.g. inside the Obsidian plugin). */
  wasmBinary?: ArrayBuffer;
  /** Custom resolver for the wasm asset (used when running unbundled, e.g. via tsx). */
  locateFile?: (file: string) => string;
};

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

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

  const sqlDb: SqlJsDatabase = new SQL.Database(initialBytes);

  let closed = false;
  function assertOpen(): void {
    if (closed) {
      throw new Error("RelayDb is closed");
    }
  }

  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (isMemory) {
      return;
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    writeFileSync(dbPath, Buffer.from(sqlDb.export()));
  }

  function scheduleFlush(): void {
    if (isMemory || flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, 25);
    flushTimer.unref?.();
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
