import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { AppError, PRODUCT_NAME, PRODUCT_VERSION, toApiError, type HealthResponse } from "@vault-rooms/protocol";
import { openRelayDb } from "./db/db.js";
import type { SqlJsLocator } from "./db/sqlJsAdapter.js";
import { RelayRepository } from "./db/repositories/relayRepository.js";
import { registerAgentRoutes } from "./routes/agent.routes.js";
import { registerAuthRoutes } from "./routes/auth.routes.js";
import { registerFileRoutes } from "./routes/file.routes.js";
import { registerMcpRoutes } from "./routes/mcp.routes.js";
import { registerRoomRoutes } from "./routes/room.routes.js";
import { registerTeamRoutes } from "./routes/team.routes.js";
import { ConnectionRegistry } from "./sync/connectionRegistry.js";
import { registerSyncRoutes } from "./sync/syncServer.js";

export type CreateAppOptions = {
  dbPath?: string;
  publicUrl?: string;
  maxFileBytes?: number;
  allowRemoteBootstrap?: boolean;
  sqlJsLocator?: SqlJsLocator;
};

export async function createApp(options: CreateAppOptions = {}) {
  const maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
  // The JSON request body wrapping a file's content (quoting/escaping newlines, etc.) is always
  // somewhat larger than the raw file itself, so Fastify's bodyLimit needs real headroom above
  // maxFileBytes - otherwise a file just under the configured limit can still be rejected at the
  // HTTP layer before the friendlier FILE_TOO_LARGE check even runs.
  const app = Fastify({ logger: false, bodyLimit: Math.max(maxFileBytes * 2, 5 * 1024 * 1024) });
  const db = await openRelayDb(options.dbPath ?? "data/relay.sqlite", options.sqlJsLocator);
  const repo = new RelayRepository(db);
  const connectionRegistry = new ConnectionRegistry();

  app.addHook("onRequest", (request, reply, done) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
    reply.header("access-control-allow-headers", "authorization,content-type");
    reply.header("access-control-max-age", "86400");
    if (request.method === "OPTIONS") {
      void reply.code(204).send();
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
    connectionRegistry
  });
  registerRoomRoutes(app, repo, { connectionRegistry });
  registerAgentRoutes(app, repo);
  registerFileRoutes(app, repo, {
    maxFileBytes,
    connectionRegistry
  });
  registerMcpRoutes(app, repo);
  void app.register(async (syncApp) => {
    registerSyncRoutes(syncApp, repo, connectionRegistry, { maxFileBytes });
  });

  app.addHook("onClose", (_instance, done) => {
    db.close();
    done();
  });

  return app;
}
