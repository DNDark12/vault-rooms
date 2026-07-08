import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { AppError, PRODUCT_NAME, PRODUCT_VERSION, toApiError, type HealthResponse } from "@vault-rooms/protocol";
import { openRelayDb } from "./db/db.js";
import type { SqlJsLocator } from "./db/sqlJsAdapter.js";
import { RelayRepository } from "./db/repositories/relayRepository.js";
import { registerAuthRoutes } from "./routes/auth.routes.js";
import { registerFileRoutes } from "./routes/file.routes.js";
import { registerFriendRoutes } from "./routes/friend.routes.js";
import { registerRoomRoutes } from "./routes/room.routes.js";
import { registerTeamRoutes } from "./routes/team.routes.js";
import { generateBootstrapPin } from "./security/bootstrapPin.js";
import { FixedWindowRateLimiter } from "./security/rateLimiter.js";
import { ConnectionRegistry } from "./sync/connectionRegistry.js";
import { registerSyncRoutes } from "./sync/syncServer.js";

export type CreateAppOptions = {
  dbPath?: string;
  publicUrl?: string;
  maxFileBytes?: number;
  maxConnections?: number;
  allowRemoteBootstrap?: boolean;
  rateLimit?: {
    bootstrapMax?: number;
    bootstrapWindowMs?: number;
  };
  sqlJsLocator?: SqlJsLocator;
};

export async function createApp(options: CreateAppOptions = {}) {
  const maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
  const maxConnections = options.maxConnections ?? 100;
  const bootstrapRateLimiter = new FixedWindowRateLimiter(options.rateLimit?.bootstrapMax ?? 5, options.rateLimit?.bootstrapWindowMs ?? 60_000);
  // The JSON request body wrapping a file's content (quoting/escaping newlines, etc.) is always
  // somewhat larger than the raw file itself, so Fastify's bodyLimit needs real headroom above
  // maxFileBytes - otherwise a file just under the configured limit can still be rejected at the
  // HTTP layer before the friendlier FILE_TOO_LARGE check even runs.
  const app = Fastify({ logger: false, bodyLimit: Math.max(maxFileBytes * 2, 5 * 1024 * 1024) });
  const db = await openRelayDb(options.dbPath ?? "data/relay.sqlite", options.sqlJsLocator);
  const repo = new RelayRepository(db);
  const connectionRegistry = new ConnectionRegistry();
  // Bootstrap PIN (see security/bootstrapPin.ts): required by POST /api/bootstrap in addition to
  // the existing localhost-only check, so a DNS-rebound "local-looking" request from a malicious
  // web page still can't provision a server owner. Exposed in-process only (decorated below, plus
  // printed to the console by the standalone CLI in index.ts) - the embedded plugin reads it
  // directly off this same object instead of ever sending it over the network unprompted.
  const bootstrapPin = generateBootstrapPin();

  app.addHook("onRequest", (request, reply, done) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    reply.header("access-control-allow-headers", "authorization,content-type");
    reply.header("access-control-max-age", "86400");
    if (request.method === "OPTIONS") {
      void reply.code(204).send();
      return;
    }
    done();
  });

  // Only POST /api/bootstrap gets a dedicated request-rate limiter: it is the sole unauthenticated
  // route that can provision a server owner, so it's a takeover surface worth capping tightly.
  // There is intentionally no general per-IP request limiter beyond this: authenticated file/sync
  // traffic (REST reads/writes plus the /sync WebSocket) legitimately scales with vault size - a
  // single "mount an existing room" reconciliation can fire well over a hundred requests in a
  // burst - and is already bounded by the WS connection cap (maxConnections) and the body-size
  // limit above, not by request volume. The other unauthenticated routes (/api/join,
  // /api/invites/accept) require a valid, single-use invite token and are low-volume by nature.
  app.addHook("onRequest", (request, reply, done) => {
    if (request.method === "POST" && request.url === "/api/bootstrap" && !bootstrapRateLimiter.consume(request.ip)) {
      void reply.status(429).send({ error: { code: "RATE_LIMITED", message: "Too many bootstrap attempts. Try again later." } });
      return;
    }

    done();
  });

  void app.register(websocket, { options: { maxPayload: maxFileBytes } });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send(toApiError(error));
      return;
    }
    reply.status(500).send(toApiError(new AppError("VALIDATION_ERROR", "Unexpected server error.", 500)));
  });

  app.get("/health", async (): Promise<HealthResponse> => ({
    ok: true,
    name: PRODUCT_NAME,
    version: PRODUCT_VERSION
  }));

  registerAuthRoutes(app, repo);
  registerTeamRoutes(app, repo, {
    publicUrl: options.publicUrl ?? "http://127.0.0.1:8787",
    allowRemoteBootstrap: options.allowRemoteBootstrap ?? false,
    bootstrapPin,
    connectionRegistry
  });
  registerRoomRoutes(app, repo, { connectionRegistry });
  registerFriendRoutes(app, repo, { connectionRegistry });
  registerFileRoutes(app, repo, {
    maxFileBytes,
    connectionRegistry
  });
  void app.register(async (syncApp) => {
    registerSyncRoutes(syncApp, repo, connectionRegistry, { maxFileBytes, maxConnections });
  });

  app.addHook("onClose", (_instance, done) => {
    db.close();
    done();
  });

  // In-process bootstrap PIN access (not test-only): the embedded plugin (serverManager.ts) reads
  // this directly off the running app instance - same process, no network round-trip - to supply
  // it transparently when it calls POST /api/bootstrap. Integration tests read it the same way.
  app.decorate("bootstrapPin", bootstrapPin);
  // Test-only hook: there is no REST route yet for registering a second device on an existing
  // account, so integration tests that need a multi-device fixture (e.g. per-device revoke)
  // reach into the repository through this decorator instead of duplicating repo internals.
  app.decorate("testRepo", repo);
  // Test-only hook: integration tests assert WebSocket connection-cap behavior without exposing
  // registry internals through production routes.
  app.decorate("testConnectionRegistry", connectionRegistry);

  return app;
}
