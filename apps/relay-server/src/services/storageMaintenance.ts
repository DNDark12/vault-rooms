import type { RelayDb } from "../db/sqlJsAdapter.js";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import type { ContentWriteService } from "../storage/contentWriteService.js";

/** Maximum files processed per backfill step. */
const BACKFILL_BATCH_SIZE = 200;
/** Yields between synchronous backfill batches. */
const BACKFILL_BATCH_DELAY_MS = 50;

/** Runtime-neutral timer used by standalone and embedded relays. */
export type StorageMaintenanceTimerHost<TimerHandle = unknown> = {
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

/** Cancels pending storage maintenance. */
export type StorageBackfillHandle = {
  cancel: () => void;
};

/** Runs resumable backfill, migration, and both orphan sweeps. */
export function scheduleStorageBackfill<TimerHandle>(
  repo: RelayRepository,
  timerHost: StorageMaintenanceTimerHost<TimerHandle>,
  contentWriteService?: ContentWriteService
): StorageBackfillHandle {
  let cancelled = false;
  let pendingTimer: TimerHandle | null = null;
  let phase: "backfill" | "migration" | "sweep" | "blobStoreSweep" = "backfill";

  const nextPhaseAfter = (current: typeof phase): typeof phase | null => {
    if (current === "backfill") return contentWriteService ? "migration" : "sweep";
    if (current === "migration") return "sweep";
    if (current === "sweep") return contentWriteService ? "blobStoreSweep" : null;
    return null;
  };

  const runBatch = (): Promise<{ done: boolean }> => {
    if (phase === "migration") {
      return contentWriteService!.migrateLegacyContentBatch(BACKFILL_BATCH_SIZE);
    }
    if (phase === "blobStoreSweep") {
      return contentWriteService!.sweepOrphanedBlobStoreBatch(BACKFILL_BATCH_SIZE);
    }
    return repo.withExclusiveAccess(() =>
      phase === "backfill" ? repo.backfillStorageBatch(BACKFILL_BATCH_SIZE) : repo.sweepOrphanedBlobsBatch(BACKFILL_BATCH_SIZE)
    );
  };

  const step = (): void => {
    pendingTimer = null;
    runBatch()
      .then(({ done }) => {
        if (cancelled) {
          return;
        }
        if (done) {
          const next = nextPhaseAfter(phase);
          if (!next) {
            return;
          }
          phase = next;
        }
        pendingTimer = timerHost.setTimeout(step, BACKFILL_BATCH_DELAY_MS);
      })
      .catch((error: unknown) => {
        console.error("Storage maintenance stopped until the next startup", error);
      });
  };

  pendingTimer = timerHost.setTimeout(step, BACKFILL_BATCH_DELAY_MS);

  return {
    cancel: () => {
      cancelled = true;
      if (pendingTimer !== null) {
        timerHost.clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    }
  };
}

/** Reclaims SQLite pages exclusively and flushes the compacted image before returning. */
export async function reclaimDatabaseSpace(repo: RelayRepository, db: RelayDb): Promise<void> {
  await repo.withExclusiveAccess(() => {
    db.exec("VACUUM");
  });
  await db.flush();
}
