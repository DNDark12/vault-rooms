import { describe, expect, it, vi } from "vitest";

describe("standalone sql.js initialization", () => {
  it("retries after an initialization promise rejects", async () => {
    const actual = await vi.importActual<typeof import("sql.js")>("sql.js");
    const SQL = await actual.default();
    vi.resetModules();
    const initSqlJs = vi.fn()
      .mockRejectedValueOnce(new Error("simulated initialization failure"))
      .mockResolvedValue(SQL);
    vi.doMock("sql.js", () => ({ ...actual, default: initSqlJs }));
    const { openSqlJsDb } = await import("../src/db/sqlJsAdapter.js");

    await expect(openSqlJsDb(":memory:")).rejects.toThrow("simulated initialization failure");

    try {
      const db = await openSqlJsDb(":memory:");
      db.exec("create table retry_ok(id integer primary key)");
      expect(db.prepare("select count(*) as count from retry_ok").get()).toEqual({ count: 0 });
      await db.close();
    } finally {
      vi.doUnmock("sql.js");
    }
  });
});
