import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { openSqlJsDb } from "../src/db/sqlJsAdapter.js";

describe("invite schema migration", () => {
  it("rebuilds only the legacy invites table and preserves durable data", async () => {
    const db = await openSqlJsDb(":memory:");
    db.exec(`
      create table teams(
        id text primary key,
        slug text unique not null,
        name text not null,
        owner_user_id text not null,
        created_at text not null,
        updated_at text not null
      );
      create table users(
        id text primary key,
        display_name text not null,
        revoked_at text,
        created_at text not null,
        updated_at text not null
      );
      create table invites(
        id text primary key,
        team_id text not null,
        created_by_user_id text not null,
        token_hash text not null,
        role text not null,
        expires_at text not null,
        max_uses integer not null,
        use_count integer not null,
        revoked_at text,
        created_at text not null
      );
      insert into teams values ('team_1', 'demo', 'Demo', 'usr_1', 'now', 'now');
      insert into users values ('usr_1', 'Owner', null, 'now', 'now');
      insert into invites values ('inv_1', 'team_1', 'usr_1', 'hash', 'member', 'later', 1, 0, null, 'now');
    `);

    runMigrations(db);

    const columns = db.prepare("pragma table_info(invites)").all() as Array<{ name: string; notnull: number }>;
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "team_id",
      "room_id",
      "permission_preset",
      "created_by_user_id",
      "token_hash",
      "role",
      "expires_at",
      "max_uses",
      "use_count",
      "revoked_at",
      "created_at"
    ]);
    expect(columns.find((column) => column.name === "team_id")?.notnull).toBe(0);
    expect(columns.find((column) => column.name === "role")?.notnull).toBe(0);
    expect(db.prepare("select count(*) as count from invites").get()).toEqual({ count: 0 });
    expect(db.prepare("select id from teams").get()).toEqual({ id: "team_1" });
    expect(db.prepare("select id from users").get()).toEqual({ id: "usr_1" });

    await db.close();
  });
});
