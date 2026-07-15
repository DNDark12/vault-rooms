import { runMigrations } from "./db/migrations.js";
import { RelayRepository } from "./db/repositories/relayRepository.js";
import type { RelayDb } from "./db/sqlJsAdapter.js";
import { generateBootstrapPin } from "./security/bootstrapPin.js";
import { FixedWindowRateLimiter } from "./security/rateLimiter.js";
import { ConnectionRegistry } from "./sync/connectionRegistry.js";
import type { SecurityRuntime } from "./routes/security.routes.js";

export type RelayCoreOptions = {
  maxFileBytes?: number;
  maxConnections?: number;
  rateLimit?: {
    bootstrapMax?: number;
    bootstrapWindowMs?: number;
    rotationProbeMax?: number;
    rotationProbeWindowMs?: number;
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

  return {
    repo,
    connectionRegistry,
    bootstrapPin,
    bootstrapRateLimiter,
    rotationProbeRateLimiter,
    maxFileBytes,
    maxConnections,
    security: options.security
  };
}
