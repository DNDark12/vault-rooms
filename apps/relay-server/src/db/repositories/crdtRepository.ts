import { createId } from "@vault-rooms/protocol";
import type { CrdtSnapshotRow, CrdtUpdateRow } from "../schema.js";
import type { RelayDb } from "../sqlJsAdapter.js";

export type CrdtSnapshot = {
  stateVector: string;
  snapshot: string;
  upToSeq: number;
};

/** Owns the CRDT update log and compaction snapshots (docs/superpowers/plans/2026-07-20-crdt-sync.md
 *  Phase 2/4). Every method is keyed by `(fileId, epoch)` so a purged/superseded epoch's rows are
 *  never ambiguous with a later incarnation's (contract 1.5/1.9). This repository does not itself
 *  decide *when* to bump an epoch or compact - that orchestration lives in `CrdtDocManager` (Phase
 *  4) and in `RelayFileRepository.deleteFile` (contract 1.5's "delete wins, bump immediately"); this
 *  class only provides the durable primitives those callers use. */
export class RelayCrdtRepository {
  constructor(private readonly db: RelayDb) {}

  /** Appends an update and returns the seq it was assigned. Allocation and insert happen in one
   *  transaction so concurrent callers within the same process can never race to the same seq. */
  appendCrdtUpdate(fileId: string, epoch: number, updateBase64: string): number {
    const append = this.db.transaction(() => {
      const seq = this.nextSeq(fileId, epoch);
      this.db
        .prepare("insert into crdt_updates(id, file_id, epoch, seq, update_blob, created_at) values (?, ?, ?, ?, ?, ?)")
        .run(createId("cru"), fileId, epoch, seq, updateBase64, new Date().toISOString());
      return seq;
    });
    return append();
  }

  /** Updates with `seq` strictly greater than `sinceSeq`, in order - `sinceSeq = 0` (or a
   *  snapshot's `upToSeq`) returns everything a client catching up from that point still needs. */
  listCrdtUpdatesSince(fileId: string, epoch: number, sinceSeq: number): Array<{ seq: number; update: string }> {
    const rows = this.db
      .prepare("select seq, update_blob from crdt_updates where file_id = ? and epoch = ? and seq > ? order by seq asc")
      .all(fileId, epoch, sinceSeq) as Array<{ seq: number; update_blob: string }>;
    return rows.map((row) => ({ seq: row.seq, update: row.update_blob }));
  }

  /** Writes a compaction snapshot and deletes the updates it supersedes (`seq <= upToSeq`) in one
   *  transaction, so a crash between the two can never leave a snapshot without the updates it
   *  claims to supersede still being replayable, nor a dangling half-deleted update range. One
   *  snapshot row per `(fileId, epoch)` - a later compaction replaces the earlier one. */
  writeCrdtSnapshot(fileId: string, epoch: number, stateVectorBase64: string, snapshotBase64: string, upToSeq: number): void {
    const write = this.db.transaction(() => {
      const now = new Date().toISOString();
      const existing = this.db.prepare("select id from crdt_snapshots where file_id = ? and epoch = ?").get(fileId, epoch) as { id: string } | undefined;
      if (existing) {
        this.db
          .prepare("update crdt_snapshots set state_vector = ?, snapshot_blob = ?, up_to_seq = ?, created_at = ? where id = ?")
          .run(stateVectorBase64, snapshotBase64, upToSeq, now, existing.id);
      } else {
        this.db
          .prepare("insert into crdt_snapshots(id, file_id, epoch, state_vector, snapshot_blob, up_to_seq, created_at) values (?, ?, ?, ?, ?, ?, ?)")
          .run(createId("crs"), fileId, epoch, stateVectorBase64, snapshotBase64, upToSeq, now);
      }
      this.db.prepare("delete from crdt_updates where file_id = ? and epoch = ? and seq <= ?").run(fileId, epoch, upToSeq);
    });
    write();
  }

  getLatestCrdtSnapshot(fileId: string, epoch: number): CrdtSnapshot | null {
    const row = this.db.prepare("select * from crdt_snapshots where file_id = ? and epoch = ?").get(fileId, epoch) as CrdtSnapshotRow | undefined;
    if (!row) return null;
    return { stateVector: row.state_vector, snapshot: row.snapshot_blob, upToSeq: row.up_to_seq };
  }

  /** Destructive cleanup for one epoch's CRDT state (contract 1.5) - used when a file/room is
   *  deleted, never for ACL revocation (which must not touch shared state other members still
   *  use). Idempotent: purging an epoch with nothing recorded is a no-op. Opens its own
   *  transaction - for a caller that needs this atomic with other statements in an
   *  already-open transaction (like `deleteFile`'s epoch bump), use
   *  `purgeCrdtStateStatements` instead, which issues the same statements without wrapping. */
  purgeCrdtState(fileId: string, epoch: number): void {
    this.db.transaction(() => this.purgeCrdtStateStatements(fileId, epoch))();
  }

  /** Same cleanup as `purgeCrdtState`, without opening its own transaction - SQLite (and this
   *  repo's `RelayDb.transaction` helper) doesn't support nesting transactions, so a caller that's
   *  already inside one (e.g. `RelayFileRepository.deleteFile`'s tombstone update) must call this
   *  form to keep the epoch bump and the purge atomic with the rest of that transaction. */
  purgeCrdtStateStatements(fileId: string, epoch: number): void {
    this.db.prepare("delete from crdt_updates where file_id = ? and epoch = ?").run(fileId, epoch);
    this.db.prepare("delete from crdt_snapshots where file_id = ? and epoch = ?").run(fileId, epoch);
  }

  /** The next seq must continue past whatever compaction already superseded, not just the
   *  remaining rows in `crdt_updates` - compaction deletes updates up to and including a
   *  snapshot's `up_to_seq`, so `max(seq)` over the (now-purged) remaining rows alone would wrap
   *  back down and hand out a seq number `listCrdtUpdatesSince` would then filter out as
   *  already-seen. Take the max of both the remaining updates and the latest snapshot's
   *  `up_to_seq`. */
  private nextSeq(fileId: string, epoch: number): number {
    const updatesRow = this.db.prepare("select max(seq) as maxSeq from crdt_updates where file_id = ? and epoch = ?").get(fileId, epoch) as
      | { maxSeq: number | null }
      | undefined;
    const snapshotRow = this.db.prepare("select up_to_seq as upToSeq from crdt_snapshots where file_id = ? and epoch = ?").get(fileId, epoch) as
      | { upToSeq: number | null }
      | undefined;
    const highestKnownSeq = Math.max(updatesRow?.maxSeq ?? 0, snapshotRow?.upToSeq ?? 0);
    return highestKnownSeq + 1;
  }
}

export type { CrdtUpdateRow };
