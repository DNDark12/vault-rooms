import { hashToken } from "@vault-rooms/protocol";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { RelayRepository } from "../src/db/repositories/relayRepository.js";
import { openSqlJsDb } from "../src/db/sqlJsAdapter.js";

describe("invite schema migration", () => {
  it("rebuilds the legacy invites table without discarding pending invites or durable data", async () => {
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
      insert into invites values ('inv_1', 'team_1', 'usr_1', 'hash', 'owner', 'later', 1, 0, null, 'now');
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
    expect(db.prepare("select id, team_id, room_id, role, token_hash from invites").get()).toEqual({
      id: "inv_1",
      team_id: "team_1",
      room_id: null,
      role: "admin",
      token_hash: "hash"
    });
    expect(db.prepare("select id from teams").get()).toEqual({ id: "team_1" });
    expect(db.prepare("select id from users").get()).toEqual({ id: "usr_1" });

    await db.close();
  });

  it("rejects unsupported stored team roles before consuming the invite or inserting a user", async () => {
    const db = await openSqlJsDb(":memory:");
    runMigrations(db);
    db.exec(`
      insert into users values ('usr_owner', 'Owner', null, 'now', 'now');
      insert into teams values ('team_1', 'demo', 'Demo', 'usr_owner', 'now', 'now');
      insert into invites values (
        'inv_bad', 'team_1', null, null, 'usr_owner', '${hashToken("bad-invite")}',
        'viewer', '2099-01-01', 1, 0, null, 'now'
      );
    `);
    const repo = new RelayRepository(db);

    expect(() => repo.joinInvite({
      inviteToken: "bad-invite",
      displayName: "New user",
      deviceName: "Laptop",
      tokenSecurity: "plain"
    })).toThrow(/unsupported team invite role/i);
    expect(db.prepare("select count(*) as count from users").get()).toEqual({ count: 1 });
    expect(db.prepare("select use_count from invites where id = 'inv_bad'").get()).toEqual({ use_count: 0 });
    await db.close();
  });
});
