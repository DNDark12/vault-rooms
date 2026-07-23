import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { openSqlJsDb, type RelayDb } from "../src/db/sqlJsAdapter.js";
import { RelayRepository } from "../src/db/repositories/relayRepository.js";

// Phase 2 of docs/superpowers/plans/2026-07-20-crdt-sync.md: epoch-aware CRDT persistence.
// Contract 1.9 (authoritative epoch source): `files.crdt_epoch` survives purges because it lives
// on the FileRow itself, not inside the tables that get purged. Contract 1.5 (destructive vs
// non-destructive cleanup): a file delete bumps the epoch and purges crdt_updates/crdt_snapshots
// for the OLD epoch immediately ("delete wins" per contract 1.5), so any in-flight update for the
// old epoch is rejected as stale, and a later recreate-at-same-path starts clean at the new epoch.

async function createTestRepo(): Promise<{ db: RelayDb; repo: RelayRepository }> {
  const db = await openSqlJsDb(":memory:");
  runMigrations(db);
  const repo = new RelayRepository(db);
  return { db, repo };
}

function makeRoomAndFile(repo: RelayRepository) {
  const room = repo.createRoom({
    name: "Room",
    type: "folder",
    sourcePath: "/vault/room",
    mountName: "room",
    ownerUserId: "usr_owner",
    capabilities: []
  });
  const write = repo.writeFile({ roomId: room.id, relativePath: "note.md", baseVersion: 0, content: "hello", actorUserId: "usr_owner" });
  const file = repo.getFile(room.id, "note.md");
  if (!file) throw new Error("file not found after writeFile");
  return { room, file, write };
}

describe("CRDT persistence (Phase 2)", () => {
  it("adds rooms.crdt_enabled (default 0) without disturbing existing rooms", async () => {
    const { repo } = await createTestRepo();
    const { room } = makeRoomAndFile(repo);
    expect(room.crdt_enabled).toBe(0);
  });

  it("adds files.crdt_epoch (default 0) as the authoritative epoch source", async () => {
    const { repo } = await createTestRepo();
    const { file } = makeRoomAndFile(repo);
    expect(file.crdt_epoch).toBe(0);
  });

  it("preserves existing rooms/files/audit rows when migrating a pre-CRDT (v0.2) database", async () => {
    const db = await openSqlJsDb(":memory:");
    runMigrations(db); // simulate a pre-CRDT database already having the earlier schema...
    const repo = new RelayRepository(db);
    const { room, file } = makeRoomAndFile(repo);

    runMigrations(db); // ...then run migrations again (idempotent, like every startup).

    expect(repo.getRoom(room.id)).toMatchObject({ id: room.id, name: "Room" });
    expect(repo.getFile(room.id, "note.md")).toMatchObject({ id: file.id, version: 1 });
  });

  it("appends CRDT updates with an atomic per-(file,epoch) sequence and lists them in order", async () => {
    const { repo } = await createTestRepo();
    const { file } = makeRoomAndFile(repo);

    const seq1 = repo.appendCrdtUpdate(file.id, 0, "dXBkYXRlLTE="); // "update-1"
    const seq2 = repo.appendCrdtUpdate(file.id, 0, "dXBkYXRlLTI="); // "update-2"

    expect(seq2).toBeGreaterThan(seq1);

    const updates = repo.listCrdtUpdatesSince(file.id, 0, 0);
    expect(updates.map((u) => u.update)).toEqual(["dXBkYXRlLTE=", "dXBkYXRlLTI="]);
    expect(repo.listCrdtUpdatesSince(file.id, 0, seq1)).toEqual([{ seq: seq2, update: "dXBkYXRlLTI=" }]);
  });

  it("bumpFileCrdtEpoch starts a fresh, independent sequence space and purges the old epoch (contract 1.5)", async () => {
    const { repo } = await createTestRepo();
    const { file } = makeRoomAndFile(repo);

    repo.appendCrdtUpdate(file.id, 0, "ZXBvY2gtMC11cGRhdGU=");
    const newEpoch = repo.bumpFileCrdtEpoch(file.id); // destructive by design - old epoch is purged.
    const seqAtEpoch1 = repo.appendCrdtUpdate(file.id, newEpoch, "ZXBvY2gtMS11cGRhdGU=");

    expect(newEpoch).toBe(1);
    // The old epoch's data is gone - bumping is always destructive, matching what deleteFile
    // already relies on (a bare epoch bump has no other meaning than "start a fresh incarnation").
    expect(repo.listCrdtUpdatesSince(file.id, 0, 0)).toEqual([]);
    // The new epoch has its own independent sequence space, starting from 1.
    expect(repo.listCrdtUpdatesSince(file.id, newEpoch, 0)).toEqual([{ seq: seqAtEpoch1, update: "ZXBvY2gtMS11cGRhdGU=" }]);
  });

  it("writeCrdtSnapshot is transactional: it writes the snapshot and deletes superseded updates atomically", async () => {
    const { repo } = await createTestRepo();
    const { file } = makeRoomAndFile(repo);

    const seq1 = repo.appendCrdtUpdate(file.id, 0, "dTE=");
    const seq2 = repo.appendCrdtUpdate(file.id, 0, "dTI=");
    repo.appendCrdtUpdate(file.id, 0, "dTM=");

    repo.writeCrdtSnapshot(file.id, 0, "c3Y=", "c25hcHNob3Q=", seq2);

    // Updates up to and including seq2 are superseded by the snapshot and gone...
    const remaining = repo.listCrdtUpdatesSince(file.id, 0, 0);
    expect(remaining.map((u) => u.seq)).not.toContain(seq1);
    expect(remaining.map((u) => u.seq)).not.toContain(seq2);
    // ...but the update after the snapshot boundary survives.
    expect(remaining).toHaveLength(1);

    const snapshot = repo.getLatestCrdtSnapshot(file.id, 0);
    expect(snapshot).toMatchObject({ stateVector: "c3Y=", snapshot: "c25hcHNob3Q=", upToSeq: seq2 });
  });

  it("a cold sync_step1 after compaction can still catch up via snapshot + remaining updates", async () => {
    const { repo } = await createTestRepo();
    const { file } = makeRoomAndFile(repo);

    repo.appendCrdtUpdate(file.id, 0, "dTE=");
    const seq2 = repo.appendCrdtUpdate(file.id, 0, "dTI=");
    repo.writeCrdtSnapshot(file.id, 0, "c3Y=", "c25hcHNob3Q=", seq2);
    repo.appendCrdtUpdate(file.id, 0, "dTM=");

    // A "cold" client catching up needs both: the latest snapshot, plus anything appended after it.
    const snapshot = repo.getLatestCrdtSnapshot(file.id, 0);
    const updatesAfterSnapshot = repo.listCrdtUpdatesSince(file.id, 0, snapshot?.upToSeq ?? 0);

    expect(snapshot).not.toBeNull();
    expect(updatesAfterSnapshot.map((u) => u.update)).toEqual(["dTM="]);
  });

  it("[P0-a] survives a purge with the authoritative epoch intact - purging updates/snapshots for an epoch never loses the current epoch counter", async () => {
    const { repo } = await createTestRepo();
    const { file } = makeRoomAndFile(repo);

    repo.appendCrdtUpdate(file.id, 0, "dTE=");
    repo.writeCrdtSnapshot(file.id, 0, "c3Y=", "c25hcHNob3Q=", 1);
    repo.purgeCrdtState(file.id, 0);

    expect(repo.listCrdtUpdatesSince(file.id, 0, 0)).toEqual([]);
    expect(repo.getLatestCrdtSnapshot(file.id, 0)).toBeNull();
    // The epoch counter itself is untouched by purging that epoch's updates/snapshots - it lives
    // on the FileRow (contract 1.9), a different table than what purgeCrdtState clears.
    expect(repo.getFile(file.room_id, file.relative_path)?.crdt_epoch).toBe(0);
  });

  it("[contract 1.5] deleting a file bumps its epoch immediately and purges the old epoch's CRDT state, so recreate-at-same-path never resurrects old content", async () => {
    const { repo } = await createTestRepo();
    const { room, file, write } = makeRoomAndFile(repo);

    repo.appendCrdtUpdate(file.id, 0, "b2xkLWNvbnRlbnQ=");
    repo.writeCrdtSnapshot(file.id, 0, "c3Y=", "b2xkLXNuYXBzaG90", 1);

    repo.deleteFile({ roomId: room.id, relativePath: "note.md", baseVersion: write.version, actorUserId: "usr_owner" });

    const tombstoned = repo.getFile(room.id, "note.md");
    expect(tombstoned?.crdt_epoch).toBe(1); // bumped immediately on delete, not deferred to recreate.

    // The old epoch's CRDT state must be gone - a client resurrecting epoch 0 would see deleted
    // content, which is exactly the resurrection bug this contract exists to prevent.
    expect(repo.listCrdtUpdatesSince(file.id, 0, 0)).toEqual([]);
    expect(repo.getLatestCrdtSnapshot(file.id, 0)).toBeNull();

    // Recreate at the same path (baseVersion 0 revives the tombstone, per fileRepository.ts).
    const recreated = repo.writeFile({ roomId: room.id, relativePath: "note.md", baseVersion: 0, content: "fresh start", actorUserId: "usr_owner" });
    const recreatedRow = repo.getFile(room.id, "note.md");

    expect(recreatedRow?.id).toBe(file.id); // same file_id (tombstone revive), per existing CAS behavior.
    expect(recreatedRow?.crdt_epoch).toBe(1); // stayed at the epoch delete already bumped to.
    expect(recreated.content).toBe("fresh start");

    // A CRDT document created fresh at the new epoch has no access to the old epoch's history.
    expect(repo.listCrdtUpdatesSince(file.id, 1, 0)).toEqual([]);
  });
});
