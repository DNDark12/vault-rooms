import { runMigrations } from "./db/migrations.js";
import { RelayRepository } from "./db/repositories/relayRepository.js";
import type { RelayDb } from "./db/sqlJsAdapter.js";
import { hasRoomPermission } from "./services/policyService.js";
import { generateBootstrapPin } from "./security/bootstrapPin.js";
import { FixedWindowRateLimiter } from "./security/rateLimiter.js";
import { ConnectionRegistry } from "./sync/connectionRegistry.js";
import { PresenceRegistry } from "./sync/presenceRegistry.js";
import { PresenceService } from "./sync/presenceService.js";
import type { CrdtMaterializedEvent } from "./sync/crdtDocManager.js";
import type { SecurityRuntime } from "./routes/security.routes.js";

export type RelayCoreOptions = {
  maxFileBytes?: number;
  maxConnections?: number;
  rateLimit?: {
    bootstrapMax?: number;
    bootstrapWindowMs?: number;
    rotationProbeMax?: number;
    rotationProbeWindowMs?: number;
    /** Presence cursor updates per window, per connection. Only non-null updates consume budget -
     *  a retraction is cleanup, not noise, and always goes through. */
    presenceMax?: number;
    presenceWindowMs?: number;
    /** Test seam for the fixed-window clock. `SyncTimerHost` deliberately stays a scheduler contract
     *  with no clock, so the limiter's own injectable `now` is threaded here instead. */
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
  const maxConnections = options.maxConnections ?? 100;
  const repo = new RelayRepository(db);
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
    connectionRegistry,
    bootstrapPin,
    bootstrapRateLimiter,
    rotationProbeRateLimiter,
    presenceRegistry,
    presenceRateLimiter,
    presenceService,
    maxFileBytes,
    maxConnections,
    security: options.security
  };
}

/** Builds the `CrdtDocManager` materialize callback (contract 1.2/1.6): when the CRDT lane
 *  debounce-materializes a document's text into `files`/`file_versions`, legacy/non-CRDT-capable
 *  room subscribers need to learn about it the same way they always have - a `remote_file_change`
 *  broadcast - since they never receive `remote_crdt_update`. Shared between both runtimes (unlike
 *  `CrdtDocManager` itself, which needs a runtime-specific timer host and so is constructed in
 *  `appCore.ts`/`embeddedRelayApp.ts` instead) because this closure only touches `repo` and
 *  `connectionRegistry`, neither of which differs between runtimes. */
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
        // This path *is* a CRDT document - tell CRDT-capable receivers its epoch so the vault-watcher
        // "create"/"modify" event caused by writing this content to disk adopts the existing document
        // rather than issuing a colliding `crdt_create` for it (ninth hardware-testing round).
        ...(materializedFile ? { crdtEpoch: materializedFile.crdt_epoch } : {}),
        updatedAt: new Date().toISOString()
      },
      {
        // Every room subscriber with file:read on this path receives this broadcast, CRDT-capable
        // or not (second-hardware-testing-round item 1, 2026-07-21): the earlier `connectionFilter`
        // here excluded every CRDT-capable connection on the assumption "the CRDT-capable half of
        // the room already learned about this content in real time via remote_crdt_update on every
        // accepted crdt_update" - that assumption only holds if the receiving *client* has an open
        // session for this exact path (see crdtSession.ts's handleServerMessage, which silently
        // drops remote_crdt_update when no local session exists). A device that is CRDT-capable
        // (every current build - syncWsClient.ts always advertises capabilities.crdt: true) but
        // never opened this file locally has no session either way, so excluding it here left it
        // with nothing - it's indistinguishable from a legacy connection until it opens the file.
        // The client, not this connection-level filter, is the correct place to decide whether to
        // apply this coarser snapshot (see syncWsClient.ts's remote_file_change handler, which now
        // skips applying it only when a CRDT session is already open for this path). canReceive's
        // per-path file:read check is therefore the only gate this broadcast needs.
        canReceive: (principal) =>
          hasRoomPermission({ repo, principal, room, permission: "file:read", relativePath: event.relativePath, aclRules })
      }
    );
  };
}
