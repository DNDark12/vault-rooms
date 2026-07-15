import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import initSqlJs, { type SqlJsStatic } from "sql.js/dist/sql-wasm-browser.js";
import { runMigrations } from "../../relay-server/src/db/migrations.js";
import { LEGACY_V01_SCHEMA, RELEASED_V01_SCHEMA } from "../../relay-server/test/fixtures/legacyV01.js";
import { openObsidianSqlJsDb, restoreObsidianLegacyV01Backup } from "./obsidianSqlJsDb.js";

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
  readBinaryCalls = 0;
  /** Per-call artificial delay (ms) for writeBinary, consumed FIFO - lets a test make one write
   *  slower than another to deterministically reproduce/verify flush ordering. */
  writeDelaysMs: number[] = [];
  writeFailures = 0;
  writeBinaryCalls = 0;
  readonly failingWriteCalls = new Set<number>();
  rejectRenameOverwrite = false;

  async exists(path: string): Promise<boolean> {
    return this.store.has(path) || this.folders.has(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    this.readBinaryCalls += 1;
    const data = this.store.get(path);
    if (!data) {
      throw new Error(`Missing file: ${path}`);
    }
    return data.slice(0);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.writeBinaryCalls += 1;
    const delay = this.writeDelaysMs.shift() ?? 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (this.writeFailures > 0 || this.failingWriteCalls.has(this.writeBinaryCalls)) {
      this.writeFailures = Math.max(0, this.writeFailures - 1);
      throw new Error("simulated durable write failure");
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
    if (this.rejectRenameOverwrite && this.store.has(normalizedNewPath)) {
      throw new Error("Destination file already exists!");
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

  it("reuses the startup probe bytes instead of reading a current database twice", async () => {
    const { wasmBinary } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    const dbPath = "vault-rooms/relay.sqlite";

    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    db.exec("create table devices (id integer primary key, name text not null)");
    db.prepare("insert into devices (id, name) values (1, ?)").run("device-a");
    await db.close();

    adapter.readBinaryCalls = 0;
    const reopened = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    try {
      expect(adapter.readBinaryCalls).toBe(1);
      expect(reopened.prepare("select name from devices where id = 1").get()).toEqual({ name: "device-a" });
    } finally {
      await reopened.close();
    }
  });

  it("backs up a legacy database without moving it and preserves its data through migration", async () => {
    const { SQL, wasmBinary } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    const dbPath = "vault-rooms/relay.sqlite";
    const legacyBytes = bytesFromSchema(
      SQL,
      `${LEGACY_V01_SCHEMA}
       insert into users values ('usr_owner', 'Owner', '2026-01-01', '2026-01-01');
       insert into teams values ('team_a', 'alpha', 'Alpha', 'usr_owner', '2026-01-01', '2026-01-01');
       insert into team_members values ('team_a', 'usr_owner', 'owner', null, '2026-01-01');
       insert into devices values ('dev_owner', 'team_a', 'usr_owner', 'Mac', 'token-hash', null, null, '2026-01-01');`
    );
    await adapter.writeBinary(dbPath, legacyBytes);

    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    try {
      runMigrations(db);
      expect(adapter.store.has(`${dbPath}.bak-v1`)).toBe(true);
      expect(new Uint8Array(adapter.store.get(`${dbPath}.bak-v1`)!)).toEqual(new Uint8Array(legacyBytes));
      expect(db.prepare("select token_hash from devices where id = 'dev_owner'").get()).toEqual({ token_hash: "token-hash" });
    } finally {
      await db.close();
    }
    expect(new Uint8Array(adapter.store.get(dbPath)!)).not.toEqual(new Uint8Array(legacyBytes));
  });

  it("backs up the exact released v0.1 schema before its additive migration", async () => {
    const { SQL, wasmBinary } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    const dbPath = "vault-rooms/relay.sqlite";
    const releasedBytes = bytesFromSchema(
      SQL,
      `${RELEASED_V01_SCHEMA}
       insert into users values ('usr_owner', 'Owner', null, '2026-01-01', '2026-01-01');
       insert into server_meta values ('owner_user_id', 'usr_owner');
       insert into devices values ('dev_owner', 'usr_owner', 'Mac', 'release-token-hash', null, null, '2026-01-01');`
    );
    await adapter.writeBinary(dbPath, releasedBytes);

    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    try {
      runMigrations(db);
      expect(adapter.store.has(`${dbPath}.bak-v1`)).toBe(true);
      expect(new Uint8Array(adapter.store.get(`${dbPath}.bak-v1`)!)).toEqual(new Uint8Array(releasedBytes));
      expect(db.prepare("select value from server_meta where key = 'legacy_v01_migrated'").get()).toEqual({ value: "1" });
    } finally {
      await db.close();
    }
  });

  it("quarantines a different valid v0.1 backup before archiving the active legacy bytes", async () => {
    const { SQL, wasmBinary } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    const dbPath = "vault-rooms/relay.sqlite";
    const activeBytes = bytesFromSchema(SQL, `${LEGACY_V01_SCHEMA}
      insert into users values ('usr_owner', 'Owner', '2026-01-01', '2026-01-01');
      insert into teams values ('team_a', 'alpha', 'Alpha', 'usr_owner', '2026-01-01', '2026-01-01');
      insert into devices values ('dev_owner', 'team_a', 'usr_owner', 'Mac', 'active-hash', null, null, '2026-01-01');
    `);
    const foreignBytes = bytesFromSchema(SQL, RELEASED_V01_SCHEMA);
    await adapter.writeBinary(dbPath, activeBytes);
    await adapter.writeBinary(`${dbPath}.bak-v1`, foreignBytes);

    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    await db.close();

    expect(new Uint8Array(adapter.store.get(`${dbPath}.bak-v1`)!)).toEqual(new Uint8Array(activeBytes));
    expect(new Uint8Array(adapter.store.get(`${dbPath}.bak-v1.invalid`)!)).toEqual(new Uint8Array(foreignBytes));
  });

  it("quarantines an unparsable canonical backup and continues from valid active legacy bytes", async () => {
    const { SQL, wasmBinary } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    const dbPath = "vault-rooms/relay.sqlite";
    const activeBytes = bytesFromSchema(SQL, LEGACY_V01_SCHEMA);
    const corruptBytes = new TextEncoder().encode("not a sqlite database").buffer;
    await adapter.writeBinary(dbPath, activeBytes);
    await adapter.writeBinary(`${dbPath}.bak-v1`, corruptBytes);

    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    await db.close();

    expect(new Uint8Array(adapter.store.get(`${dbPath}.bak-v1`)!)).toEqual(new Uint8Array(activeBytes));
    expect(new Uint8Array(adapter.store.get(`${dbPath}.bak-v1.invalid`)!)).toEqual(new Uint8Array(corruptBytes));
  });

  it("recovers an already-archived v0.1 database when the active replacement is empty", async () => {
    const { SQL, wasmBinary } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    const dbPath = "vault-rooms/relay.sqlite";

    const empty = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    runMigrations(empty);
    await empty.close();

    const legacyBytes = bytesFromSchema(
      SQL,
      `${LEGACY_V01_SCHEMA}
       insert into users values ('usr_owner', 'Owner', '2026-01-01', '2026-01-01');
       insert into teams values ('team_a', 'alpha', 'Alpha', 'usr_owner', '2026-01-01', '2026-01-01');
       insert into team_members values ('team_a', 'usr_owner', 'owner', null, '2026-01-01');
       insert into devices values ('dev_owner', 'team_a', 'usr_owner', 'Mac', 'token-hash', null, null, '2026-01-01');`
    );
    await adapter.writeBinary(`${dbPath}.bak-v1`, legacyBytes);

    const recovered = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    try {
      runMigrations(recovered);
      expect(recovered.prepare("select token_hash from devices where id = 'dev_owner'").get()).toEqual({ token_hash: "token-hash" });
    } finally {
      await recovered.close();
    }
    expect(new Uint8Array(adapter.store.get(`${dbPath}.bak-v1`)!)).toEqual(new Uint8Array(legacyBytes));
  });

  it("restores a legacy backup explicitly while retaining the current database separately", async () => {
    const { SQL, wasmBinary } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    const dbPath = "vault-rooms/relay.sqlite";
    const active = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    runMigrations(active);
    active.prepare("insert into users(id, display_name, revoked_at, created_at, updated_at) values ('usr_new', 'New', null, 'now', 'now')").run();
    active.prepare("insert into server_meta(key, value) values ('owner_user_id', 'usr_new')").run();
    await active.close();
    const activeBytes = adapter.store.get(dbPath)!;
    const legacyBytes = bytesFromSchema(SQL, LEGACY_V01_SCHEMA);
    await adapter.writeBinary(`${dbPath}.bak-v1`, legacyBytes);

    const result = await restoreObsidianLegacyV01Backup(asDataAdapter(adapter), dbPath, { wasmBinary });

    expect(result.previousDatabaseBackupPath).toBe(`${dbPath}.pre-v01-restore`);
    expect(new Uint8Array(adapter.store.get(`${dbPath}.pre-v01-restore`)!)).toEqual(new Uint8Array(activeBytes));
    expect(new Uint8Array(adapter.store.get(dbPath)!)).toEqual(new Uint8Array(legacyBytes));
    expect(new Uint8Array(adapter.store.get(`${dbPath}.bak-v1`)!)).toEqual(new Uint8Array(legacyBytes));
  });

  it("accepts an exact released v0.1 database for explicit restoration", async () => {
    const { SQL, wasmBinary } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    const dbPath = "vault-rooms/relay.sqlite";
    const activeBytes = bytesFromSchema(SQL, "create table current_data(id text); insert into current_data values ('keep');");
    const releasedBytes = bytesFromSchema(SQL, RELEASED_V01_SCHEMA);
    await adapter.writeBinary(dbPath, activeBytes);
    await adapter.writeBinary(`${dbPath}.bak-v1`, releasedBytes);

    await restoreObsidianLegacyV01Backup(asDataAdapter(adapter), dbPath, { wasmBinary });

    expect(new Uint8Array(adapter.store.get(dbPath)!)).toEqual(new Uint8Array(releasedBytes));
    expect(new Uint8Array(adapter.store.get(`${dbPath}.bak-v1`)!)).toEqual(new Uint8Array(releasedBytes));
  });

  it("leaves both databases intact when explicit legacy restoration cannot promote its copy", async () => {
    const { SQL, wasmBinary } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    const dbPath = "vault-rooms/relay.sqlite";
    const activeBytes = bytesFromSchema(SQL, "create table current_data(id text); insert into current_data values ('keep');");
    const legacyBytes = bytesFromSchema(SQL, LEGACY_V01_SCHEMA);
    await adapter.writeBinary(dbPath, activeBytes);
    await adapter.writeBinary(`${dbPath}.bak-v1`, legacyBytes);
    adapter.failingWriteCalls.add(adapter.writeBinaryCalls + 2);

    await expect(restoreObsidianLegacyV01Backup(asDataAdapter(adapter), dbPath, { wasmBinary })).rejects.toThrow("simulated durable write failure");

    expect(new Uint8Array(adapter.store.get(dbPath)!)).toEqual(new Uint8Array(activeBytes));
    expect(new Uint8Array(adapter.store.get(`${dbPath}.bak-v1`)!)).toEqual(new Uint8Array(legacyBytes));
    expect(new Uint8Array(adapter.store.get(`${dbPath}.pre-v01-restore`)!)).toEqual(new Uint8Array(activeBytes));
  });
});

describe("openObsidianSqlJsDb - sql.js initialization", () => {
  it("retries after an initialization promise rejects", async () => {
    const { SQL, wasmBinary } = await loadSqlJs();
    vi.resetModules();
    const initSqlJsMock = vi.fn()
      .mockRejectedValueOnce(new Error("simulated initialization failure"))
      .mockResolvedValue(SQL);
    vi.doMock("sql.js/dist/sql-wasm-browser.js", () => ({ default: initSqlJsMock }));
    const module = await import("./obsidianSqlJsDb.js");
    const adapter = new FakeDataAdapter();

    await expect(
      module.openObsidianSqlJsDb(asDataAdapter(adapter), "vault-rooms/relay.sqlite", { wasmBinary })
    ).rejects.toThrow("simulated initialization failure");

    try {
      const db = await module.openObsidianSqlJsDb(asDataAdapter(adapter), "vault-rooms/relay.sqlite", { wasmBinary });
      db.exec("create table retry_ok(id integer primary key)");
      await db.close();
    } finally {
      vi.doUnmock("sql.js/dist/sql-wasm-browser.js");
    }
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
  it("replaces an existing database when DataAdapter rename refuses to overwrite its destination", async () => {
    const { wasmBinary, SQL } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    adapter.rejectRenameOverwrite = true;
    const dbPath = "vault-rooms/relay.sqlite";
    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    db.exec("create table kv (id integer primary key, value text not null)");
    db.prepare("insert into kv (id, value) values (1, ?)").run("before");
    await db.flush();

    await expect(
      db.durable(() => db.prepare("update kv set value = ? where id = 1").run("after"))
    ).resolves.toEqual({ changes: 1 });

    const persisted = new SQL.Database(new Uint8Array(adapter.store.get(dbPath)!));
    try {
      expect(selectValue(persisted)).toEqual({ value: "after" });
    } finally {
      persisted.close();
      await db.close();
    }
  });

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

  it("rolls a durable mutation back in memory and leaves the previous database file intact when persistence fails", async () => {
    const { wasmBinary, SQL } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    const dbPath = "vault-rooms/relay.sqlite";
    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    db.exec("create table kv (id integer primary key, value text not null)");
    db.prepare("insert into kv (id, value) values (1, ?)").run("stable");
    await db.flush();

    const durable = (db as unknown as { durable?: <T>(operation: () => T) => Promise<T> }).durable;
    expect(durable).toBeTypeOf("function");
    adapter.writeFailures = 1;

    await expect(
      durable!.call(db, () => db.prepare("update kv set value = ? where id = 1").run("uncommitted"))
    ).rejects.toThrow("simulated durable write failure");

    expect(db.prepare("select value from kv where id = 1").get()).toEqual({ value: "stable" });
    expect(adapter.store.has(`${dbPath}.tmp`)).toBe(false);
    const persisted = new SQL.Database(new Uint8Array(adapter.store.get(dbPath)!));
    try {
      expect(selectValue(persisted)).toEqual({ value: "stable" });
    } finally {
      persisted.close();
      await db.close();
    }
  });

  it("blocks unrelated writers while a rollback-capable durable image is in flight", async () => {
    const { wasmBinary } = await loadSqlJs();
    const adapter = new FakeDataAdapter();
    const dbPath = "vault-rooms/relay.sqlite";
    const db = await openObsidianSqlJsDb(asDataAdapter(adapter), dbPath, { wasmBinary });
    db.exec("create table kv (id integer primary key, value text not null)");
    db.prepare("insert into kv (id, value) values (1, ?)").run("stable");
    await db.flush();

    adapter.writeDelaysMs = [0, 250];
    adapter.failingWriteCalls.add(adapter.writeBinaryCalls + 2);
    let durableError: unknown;
    const durable = db
      .durable(() => db.prepare("update kv set value = ? where id = 1").run("security-new"))
      .catch((error: unknown) => {
        durableError = error;
      });
    await vi.waitFor(() => expect(db.prepare("select value from kv where id = 1").get()).toEqual({ value: "security-new" }));

    expect(() => db.prepare("update kv set value = ? where id = 1").run("unrelated-write")).toThrow(
      "durable persistence"
    );
    await durable;
    expect(durableError).toMatchObject({ message: "simulated durable write failure" });
    expect(db.prepare("select value from kv where id = 1").get()).toEqual({ value: "stable" });
    await db.close();
  });
});
