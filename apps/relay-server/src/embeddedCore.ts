export { runMigrations } from "./db/migrations.js";
export { RelayRepository } from "./db/repositories/relayRepository.js";
export { registerAuditRoutes } from "./routes/audit.routes.js";
export { registerAuthRoutes } from "./routes/auth.routes.js";
export { registerFileRoutes } from "./routes/file.routes.js";
export { registerFriendRoutes } from "./routes/friend.routes.js";
export type { InviteSecurityContext } from "./routes/inviteResponse.js";
export { registerRoomRoutes } from "./routes/room.routes.js";
export * from "./routes/security.routes.js";
export { registerTeamRoutes } from "./routes/team.routes.js";
export { generateBootstrapPin } from "./security/bootstrapPin.js";
export { FixedWindowRateLimiter } from "./security/rateLimiter.js";
export * from "./security/identity.js";
export * from "./security/identityLifecycle.js";
export * from "./security/identityStore.js";
export * from "./security/rotation.js";
export { ConnectionRegistry } from "./sync/connectionRegistry.js";
export { handleSyncSocket } from "./sync/syncServer.js";
export type { SyncTimerHost } from "./sync/syncServer.js";
// Live cursors (docs/superpowers/specs/2026-07-28-live-cursors-design.md). Both runtimes share one
// PresenceService instance out of createRelayCore - never construct a second registry, or the two
// halves of the relay would each own a partial view of who is editing what.
export { PresenceRegistry } from "./sync/presenceRegistry.js";
export type { PresenceEntry, PresenceTarget } from "./sync/presenceRegistry.js";
export { PresenceService } from "./sync/presenceService.js";
export { CrdtDocManager, CRDT_TEXT_KEY } from "./sync/crdtDocManager.js";
export type { CrdtMaterializedEvent, CrdtUpdatedBy } from "./sync/crdtDocManager.js";
export { createRelayCore, createCrdtMaterializedHandler } from "./relayCore.js";
export type { PreparedStatement, RelayDb, SqlJsLocator, SqlRow } from "./db/sqlJsAdapter.js";
export type { RelayCoreOptions } from "./relayCore.js";
