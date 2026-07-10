import { normalizePath, type DataAdapter } from "obsidian";
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from "sql.js/dist/sql-wasm-browser.js";
import type { PreparedStatement, RelayDb, SqlJsLocator, SqlRow } from "vault-rooms-relay/embedded-core";

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
  const initialBytes = await archiveLegacyDbIfNeeded(adapter, normalizedPath, SQL);
  const sqlDb: SqlJsDatabase = new SQL.Database(initialBytes);
  const flushPath = normalizedPath;

  let closed = false;
  let flushTimer: number | null = null;
  let pendingFlush: Promise<void> | null = null;

  function assertOpen(): void {
    if (closed) {
      throw new Error("RelayDb is closed");
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
      await adapter.writeBinary(flushPath, output);
    })();
    pendingFlush = current;
    await current;
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
      sqlDb.exec(`pragma ${pragmaString}`);
    },
    transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
      return (...args: Args) => {
        assertOpen();
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
    async close() {
      if (closed) {
        return;
      }
      await flush();
      if (pendingFlush) {
        await pendingFlush;
      }
      sqlDb.close();
      closed = true;
    }
  };
}

async function archiveLegacyDbIfNeeded(adapter: DataAdapter, dbPath: string, SQL: SqlJsStatic): Promise<Uint8Array | undefined> {
  if (!(await adapter.exists(dbPath))) {
    return undefined;
  }
  const bytes = new Uint8Array(await adapter.readBinary(dbPath));
  const probeDb = new SQL.Database(bytes);
  let legacy: boolean;
  try {
    // A raw sql.js Statement#get() with no prior step() never executes the query (it just
    // returns []) - step() first to actually check for a row, mirroring the bind+step pattern
    // this file's own prepare(sql).get() wrapper uses further up.
    const stmt = probeDb.prepare("select 1 from pragma_table_info('devices') where name = 'team_id'");
    try {
      legacy = stmt.step();
    } finally {
      stmt.free();
    }
  } finally {
    probeDb.close();
  }
  if (!legacy) {
    return bytes;
  }
  const archivePath = `${dbPath}.bak-v1`;
  if (await adapter.exists(archivePath)) {
    await adapter.remove(archivePath);
  }
  await ensureParentFolder(adapter, archivePath);
  await adapter.rename(dbPath, archivePath);
  return undefined;
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
