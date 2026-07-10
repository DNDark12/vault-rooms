import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import initSqlJs, { type SqlJsStatic } from "sql.js/dist/sql-wasm-browser.js";
import { openObsidianSqlJsDb } from "./obsidianSqlJsDb.js";

// obsidianSqlJsDb.ts calls window.setTimeout/clearTimeout directly (it only ever runs embedded,
// inside Obsidian, so it has no need for the timerHost fallback the shared standalone/embedded
// sync code uses) - vitest's "node" test environment has no window global otherwise. Same shim as
// pushCoordinator.test.ts/syncWsClient.test.ts.
(globalThis as unknown as { window: typeof globalThis }).window ??= globalThis;

type AdapterMethod = "exists" | "readBinary" | "writeBinary" | "mkdir" | "remove" | "rename";

/** Minimal in-memory stand-in for Obsidian's DataAdapter - implements only what
 *  openObsidianSqlJsDb/archiveLegacyDbIfNeeded actually call. */
class FakeDataAdapter implements Pick<DataAdapter, AdapterMethod> {
  readonly store = new Map<string, ArrayBuffer>();
  readonly folders = new Set<string>();
  /** Per-call artificial delay (ms) for writeBinary, consumed FIFO - lets a test make one write
   *  slower than another to deterministically reproduce/verify flush ordering. */
  writeDelaysMs: number[] = [];

  async exists(path: string): Promise<boolean> {
    return this.store.has(path) || this.folders.has(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const data = this.store.get(path);
    if (!data) {
      throw new Error(`Missing file: ${path}`);
    }
    return data.slice(0);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const delay = this.writeDelaysMs.shift() ?? 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    this.store.set(path, data.slice(0));
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async remove(path: string): Promise<void> {
    this.store.delete(path);
    this.folders.delete(path);
  }

  async rename(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    const data = this.store.get(normalizedPath);
    if (!data) {
      throw new Error(`Missing file: ${normalizedPath}`);
    }
    this.store.set(normalizedNewPath, data);
    this.store.delete(normalizedPath);
  }
}

function asDataAdapter(adapter: FakeDataAdapter): DataAdapter {
  return adapter as unknown as DataAdapter;
}

let sqlJsPromise: Promise<{ SQL: SqlJsStatic; wasmBinary: ArrayBuffer }> | null = null;

/** Loads the same sql.js build (sql-wasm-browser) that obsidianSqlJsDb.ts itself imports, so the
 *  Statement/Database behavior under test matches production exactly. */
async function loadSqlJs(): Promise<{ SQL: SqlJsStatic; wasmBinary: ArrayBuffer }> {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      const distDir = dirname(createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm-browser.js"));
      const bytes = readFileSync(join(distDir, "sql-wasm-browser.wasm"));
      const wasmBinary = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const SQL = await initSqlJs({ wasmBinary });
      return { SQL, wasmBinary };
    })();
  }
  return sqlJsPromise;
}

/** Builds raw DB bytes with an arbitrary schema, without going through openObsidianSqlJsDb - used
 *  to plant a pre-existing "legacy" file on the fake adapter before opening it. */
function bytesFromSchema(SQL: SqlJsStatic, sql: string): ArrayBuffer {
  const db = new SQL.Database();
  try {
    db.exec(sql);
    const bytes = db.export();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } finally {
    db.close();
  }
}

describe("openObsidianSqlJsDb - legacy archive detection (A1)", () => {
  it("does not archive a current-schema database when reopening it, and preserves its data", async () => {
    const { wasmBinary } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    const dbPath = "vault-rooms/relay.sqlite";

    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    db.exec("create table devices (id integer primary key, name text not null)");
    db.prepare("insert into devices (id, name) values (1, ?)").run("device-a");
    await db.close();
    expect(adapter.store.has(`${dbPath}.bak-v1`)).toBe(false);

    // Reopening previously always mis-detected every existing DB as "legacy" (the buggy
    // Statement#get() with no step() call always returned a truthy []), archiving it and starting
    // fresh - i.e. reopening the plugin destroyed all data. Assert that no longer happens.
    const reopened = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    try {
      expect(adapter.store.has(`${dbPath}.bak-v1`)).toBe(false);
      expect(reopened.prepare("select name from devices where id = 1").get()).toEqual({ name: "device-a" });
    } finally {
      await reopened.close();
    }
  });

  it("archives a legacy database (devices.team_id present) and replaces it with a fresh database", async () => {
    const { SQL, wasmBinary } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    const dbPath = "vault-rooms/relay.sqlite";
    const legacyBytes = bytesFromSchema(SQL, "create table devices (id integer, team_id integer)");
    await adapter.writeBinary(dbPath, legacyBytes);

    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    try {
      expect(adapter.store.has(`${dbPath}.bak-v1`)).toBe(true);
      // ArrayBuffer has no enumerable own properties, so toEqual() on raw ArrayBuffers can't tell
      // byte content apart - compare via Uint8Array views instead.
      expect(new Uint8Array(adapter.store.get(`${dbPath}.bak-v1`)!)).toEqual(new Uint8Array(legacyBytes));
    } finally {
      await db.close();
    }
    // The fresh DB replacing the legacy one only gets flushed to disk on close()/scheduleFlush -
    // after close() above, dbPath should hold a brand-new (empty-schema) database, not the legacy
    // bytes that got moved to .bak-v1.
    expect(new Uint8Array(adapter.store.get(dbPath)!)).not.toEqual(new Uint8Array(legacyBytes));
  });
});

/** A raw sql.js Statement#getAsObject() with no prior step() call never executes the query (same
 *  underlying pitfall as A1's Statement#get()) - step() first, as the codebase's own raw-sql.js
 *  usages already do. */
function selectValue(db: InstanceType<SqlJsStatic["Database"]>): { value: string } {
  const stmt = db.prepare("select value from kv where id = 1");
  try {
    stmt.step();
    return stmt.getAsObject() as { value: string };
  } finally {
    stmt.free();
  }
}

describe("openObsidianSqlJsDb - flush serialization (A2)", () => {
  it("serializes overlapping flushes so the last write's bytes are what ends up persisted", async () => {
    const { wasmBinary } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    const dbPath = "vault-rooms/relay.sqlite";
    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    db.exec("create table kv (id integer primary key, value text not null)");
    db.prepare("insert into kv (id, value) values (1, ?)").run("first");

    // Make the FIRST flush's underlying write slow and the second one fast, so that without
    // serialization the fast (second) write would land on disk before the slow (first) write's
    // stale snapshot arrives and clobbers it.
    adapter.writeDelaysMs = [40, 0];
    const firstFlush = db.flush();
    db.prepare("update kv set value = ? where id = 1").run("second");
    const secondFlush = db.flush();
    await Promise.all([firstFlush, secondFlush]);

    const persisted = new Uint8Array(adapter.store.get(dbPath)!);
    const { SQL } = await loadSqlJs();
    const check = new SQL.Database(persisted);
    try {
      expect(selectValue(check)).toEqual({ value: "second" });
    } finally {
      check.close();
    }

    await db.close();
  });

  it("close() drains the fully-chained flush queue, not just its own flush call", async () => {
    const { wasmBinary, SQL } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    const dbPath = "vault-rooms/relay.sqlite";
    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    db.exec("create table kv (id integer primary key, value text not null)");
    db.prepare("insert into kv (id, value) values (1, ?)").run("first");

    adapter.writeDelaysMs = [40];
    const inFlight = db.flush();
    db.prepare("update kv set value = ? where id = 1").run("last");
    // close() itself triggers another flush chained after the slow one above; it must not resolve
    // until every chained write (including this in-flight one) has actually completed.
    await db.close();
    await inFlight;

    const persisted = new Uint8Array(adapter.store.get(dbPath)!);
    const check = new SQL.Database(persisted);
    try {
      expect(selectValue(check)).toEqual({ value: "last" });
    } finally {
      check.close();
    }
  });

  it("exports queued flush bytes at write time, after earlier flushes finish", async () => {
    const { wasmBinary, SQL } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    const dbPath = "vault-rooms/relay.sqlite";
    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    db.pragma("user_version = 1");

    adapter.writeDelaysMs = [40, 0];
    const firstFlush = db.flush();
    const secondFlush = db.flush();
    db.pragma("user_version = 2");
    await Promise.all([firstFlush, secondFlush]);

    const persisted = new Uint8Array(adapter.store.get(dbPath)!);
    const check = new SQL.Database(persisted);
    try {
      expect(check.exec("pragma user_version")[0]?.values[0]?.[0]).toBe(2);
    } finally {
      check.close();
      await db.close();
    }
  });
});
