import { runMigrations } from "./db/migrations.js";
import { RelayRepository } from "./db/repositories/relayRepository.js";
import type { RelayDb } from "./db/sqlJsAdapter.js";
import { hasRoomPermission } from "./services/policyService.js";
import { generateBootstrapPin } from "./security/bootstrapPin.js";
import { FixedWindowRateLimiter } from "./security/rateLimiter.js";
import { ConnectionRegistry } from "./sync/connectionRegistry.js";
import { PresenceRegistry } from "./sync/presenceRegistry.js";
import { PresenceService } from "./sync/presenceService.js";
import type { CrdtMaterializedEvent, CrdtRepositoryPort } from "./sync/crdtDocManager.js";
import type { SecurityRuntime } from "./routes/security.routes.js";
import { createInMemoryBlobStore, type BlobStore } from "./storage/blobStore.js";
import { createContentWriteService, type ContentWriteService } from "./storage/contentWriteService.js";

export type RelayCoreOptions = {
  maxFileBytes?: number;
  /** Stored-content limit enforced atomically by the repository. */
  maxStoredContentBytes?: number;
  maxConnections?: number;
  /** Raw content store. Production callers inject a durable adapter. */
  blobStore?: BlobStore;
  rateLimit?: {
    bootstrapMax?: number;
    bootstrapWindowMs?: number;
    rotationProbeMax?: number;
    rotationProbeWindowMs?: number;
    /** Presence cursor updates per window and connection. */
    presenceMax?: number;
    presenceWindowMs?: number;
    /** Test clock for the presence limiter. */
    presenceNow?: () => number;
  };
  security?: {
    runtime: SecurityRuntime;
  };
};

export function createRelayCore(db: RelayDb, options: RelayCoreOptions = {}) {
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  const maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
  const maxStoredContentBytes = options.maxStoredContentBytes ?? 256 * 1024 * 1024;
  const maxConnections = options.maxConnections ?? 100;
  const repo = new RelayRepository(db, maxStoredContentBytes);
  const blobStore = options.blobStore ?? createInMemoryBlobStore();
  const contentWriteService = createContentWriteService(repo, blobStore);
  const connectionRegistry = new ConnectionRegistry();
  const bootstrapPin = generateBootstrapPin();
  const bootstrapRateLimiter = new FixedWindowRateLimiter(options.rateLimit?.bootstrapMax ?? 5, options.rateLimit?.bootstrapWindowMs ?? 60_000);
  const rotationProbeRateLimiter = new FixedWindowRateLimiter(
    options.rateLimit?.rotationProbeMax ?? 30,
    options.rateLimit?.rotationProbeWindowMs ?? 60_000
  );
  // Presence is the first *time-driven* traffic source here - its volume tracks how fast someone
  // moves a caret rather than how much content exists - so unlike file/sync traffic it does need a
  // volume bound. See appCore.ts's note on why there is deliberately no general request limiter.
  const presenceRegistry = new PresenceRegistry();
  const presenceRateLimiter = new FixedWindowRateLimiter(
    options.rateLimit?.presenceMax ?? 30,
    options.rateLimit?.presenceWindowMs ?? 1_000,
    10_000,
    options.rateLimit?.presenceNow ?? Date.now
  );
  const presenceService = new PresenceService(repo, connectionRegistry, presenceRegistry, presenceRateLimiter);

  return {
    repo,
    blobStore,
    contentWriteService,
    connectionRegistry,
    bootstrapPin,
    bootstrapRateLimiter,
    rotationProbeRateLimiter,
    presenceRegistry,
    presenceRateLimiter,
    presenceService,
    maxFileBytes,
    maxStoredContentBytes,
    maxConnections,
    security: options.security
  };
}

/** Routes CRDT materialization through the external content store. */
export function createCrdtRepositoryPort(repo: RelayRepository, contentWriteService: ContentWriteService): CrdtRepositoryPort {
  return {
    writeCrdtSnapshot: (...args) => repo.writeCrdtSnapshot(...args),
    getLatestCrdtSnapshot: (...args) => repo.getLatestCrdtSnapshot(...args),
    listCrdtUpdatesSince: (...args) => repo.listCrdtUpdatesSince(...args),
    appendCrdtUpdate: (...args) => repo.appendCrdtUpdate(...args),
    materializeCrdtContent: (input) => contentWriteService.materializeCrdtContent(input),
    getFileById: (fileId) => repo.getFileById(fileId)
  };
}

/** Broadcasts materialized CRDT content through the whole-file lane. */
export function createCrdtMaterializedHandler(
  repo: RelayRepository,
  connectionRegistry: ConnectionRegistry
): (event: CrdtMaterializedEvent) => void {
  return (event) => {
    const room = repo.getRoom(event.roomId);
    if (!room) return;
    const aclRules = repo.listAclRulesForRoom(event.roomId);
    const materializedFile = repo.getFile(event.roomId, event.relativePath);
    connectionRegistry.broadcastToRoom(
      event.roomId,
      {
        type: "remote_file_change",
        roomId: event.roomId,
        relativePath: event.relativePath,
        version: event.version,
        sha256: event.sha256,
        content: event.content,
        updatedBy: event.updatedBy,
        // Lets receivers adopt the existing CRDT document.
        ...(materializedFile ? { crdtEpoch: materializedFile.crdt_epoch } : {}),
        updatedAt: new Date().toISOString()
      },
      {
        // All authorized subscribers receive materialized snapshots.
        canReceive: (principal) =>
          hasRoomPermission({ repo, principal, room, permission: "file:read", relativePath: event.relativePath, aclRules })
      }
    );
  };
}
