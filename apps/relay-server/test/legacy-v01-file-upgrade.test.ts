import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRelayDb } from "../src/db/db.js";
import { openSqlJsDb } from "../src/db/sqlJsAdapter.js";
import { LEGACY_V01_SCHEMA, RELEASED_V01_SCHEMA, seedLegacyV01Data } from "./fixtures/legacyV01.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "vault-rooms-v01-"));
  temporaryDirectories.push(directory);
  return join(directory, "relay.sqlite");
}

async function writeLegacyDb(path: string): Promise<void> {
  const db = await openSqlJsDb(path);
  db.exec(LEGACY_V01_SCHEMA);
  seedLegacyV01Data(db);
  await db.close();
}

async function writeReleasedV01Db(path: string): Promise<void> {
  const db = await openSqlJsDb(path);
  db.exec(`${RELEASED_V01_SCHEMA}
    insert into users values ('usr_owner', 'Owner', null, '2026-01-01', '2026-01-01');
    insert into server_meta values ('owner_user_id', 'usr_owner');
    insert into devices values ('dev_owner', 'usr_owner', 'Mac', 'release-token-hash', null, null, '2026-01-01');
  `);
  await db.close();
}

describe("standalone v0.1 file upgrade", () => {
  it("backs up and marks the exact released v0.1 schema before additive security migration", async () => {
    const dbPath = temporaryDbPath();
    await writeReleasedV01Db(dbPath);
    const originalBytes = readFileSync(dbPath);

    const migrated = await openRelayDb(dbPath);
    expect(migrated.prepare("select token_hash, token_security from devices where id = 'dev_owner'").get()).toEqual({
      token_hash: "release-token-hash",
      token_security: "plain"
    });
    expect(migrated.prepare("select value from server_meta where key = 'legacy_v01_migrated'").get()).toEqual({ value: "1" });
    await migrated.close();

    expect(readFileSync(`${dbPath}.bak-v1`)).toEqual(originalBytes);
  });

  it("keeps the active file, writes a one-time byte backup, and migrates the original data", async () => {
    const dbPath = temporaryDbPath();
    await writeLegacyDb(dbPath);
    const originalBytes = readFileSync(dbPath);

    const migrated = await openRelayDb(dbPath);
    expect(migrated.prepare("select token_hash from devices where id = 'dev_owner'").get()).toEqual({ token_hash: "owner-token-hash" });
    expect(migrated.prepare("select value from server_meta where key = 'owner_user_id'").get()).toEqual({ value: "usr_owner" });
    await migrated.close();

    expect(readFileSync(`${dbPath}.bak-v1`)).toEqual(originalBytes);
    const backup = await openSqlJsDb(`${dbPath}.bak-v1`);
    expect(backup.prepare("select team_id from devices where id = 'dev_owner'").get()).toEqual({ team_id: "team_a" });
    await backup.close();

    const reopened = await openRelayDb(dbPath);
    expect(reopened.prepare("select count(*) as count from rooms").get()).toEqual({ count: 1 });
    await reopened.close();
    expect(readFileSync(`${dbPath}.bak-v1`)).toEqual(originalBytes);
  });

  it("recovers an already-archived legacy database when the replacement database is empty", async () => {
    const dbPath = temporaryDbPath();
    await writeLegacyDb(`${dbPath}.bak-v1`);
    const empty = await openRelayDb(dbPath);
    await empty.close();

    const recovered = await openRelayDb(dbPath);
    expect(recovered.prepare("select token_hash from devices where id = 'dev_owner'").get()).toEqual({ token_hash: "owner-token-hash" });
    expect(recovered.prepare("select count(*) as count from files").get()).toEqual({ count: 1 });
    await recovered.close();
  });
});
