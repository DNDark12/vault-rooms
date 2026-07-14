import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { Socket } from "node:net";
import {
  AppError,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  toApiError,
  type HealthResponse,
  type IdentityRotationRecord,
  type MigrationMode,
  type SecurityUpgradeInfo,
  type ServerSecurityState
} from "@vault-rooms/protocol";
import WebSocket, { WebSocketServer } from "ws";
import {
  certPemToDerBase64Url,
  createRelayCore,
  handleSyncSocket,
  assertTransportAllowed,
  registerAuthRoutes,
  registerFileRoutes,
  registerFriendRoutes,
  registerRoomRoutes,
  registerSecurityRoutes,
  registerTeamRoutes,
  type RelayDb,
  type InviteSecurityContext,
  type RequestTransport,
  type SecurityRuntime
} from "vault-rooms-relay/embedded-core";

type SyncSocketLike = Parameters<typeof handleSyncSocket>[0];

type EmbeddedRelayAppOptions = {
  publicUrl?: string;
  maxFileBytes?: number;
  maxConnections?: number;
  allowRemoteBootstrap?: boolean;
  rateLimit?: {
    bootstrapMax?: number;
    bootstrapWindowMs?: number;
    rotationProbeMax?: number;
    rotationProbeWindowMs?: number;
  };
  security?: { runtime: SecurityRuntime };
  core?: ReturnType<typeof createRelayCore>;
};

type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type EmbeddedRequest = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  hostname: string;
  ip: string;
  transport: RequestTransport;
};

type RouteHandler = (request: EmbeddedRequest) => unknown;

type Route = {
  method: RouteMethod;
  path: string;
  segments: string[];
  handler: RouteHandler;
};

const MIN_WEBSOCKET_PAYLOAD_BYTES = 5 * 1024 * 1024;
const SOCKET_CLOSE_GRACE_MS = 500;

export async function createEmbeddedRelayApp(db: RelayDb, options: EmbeddedRelayAppOptions = {}): Promise<EmbeddedRelayApp> {
  const core = options.core ?? createRelayCore(db, options);
  const {
    repo,
    connectionRegistry,
    bootstrapPin,
    bootstrapRateLimiter,
    rotationProbeRateLimiter,
    maxFileBytes,
    maxConnections
  } = core;
  const security = options.security ?? core.security;
  const app = new EmbeddedRelayApp(db, maxFileBytes, bootstrapPin, (socket, transport) => {
    handleSyncSocket(socket, repo, connectionRegistry, { maxFileBytes, maxConnections, transport });
  }, options.publicUrl ?? "http://127.0.0.1:8787");

  app.get("/health", async (): Promise<HealthResponse> => ({
    ok: true,
    name: PRODUCT_NAME,
    version: PRODUCT_VERSION
  }));

  app.beforeRoute((request) => {
    assertTransportAllowed(repo, request.transport, request.url);
  });

  app.beforeRoute((request) => {
    if (request.method === "POST" && request.url === "/api/bootstrap" && !bootstrapRateLimiter.consume(request.ip)) {
      throw new AppError("RATE_LIMITED", "Too many bootstrap attempts. Try again later.", 429);
    }
  });

  const routeApp = app as never;
  const currentInviteSecurity = (): InviteSecurityContext | undefined => {
    const persistedIdentity = security?.runtime.getIdentity() ?? null;
    return persistedIdentity
      ? {
          serverId: persistedIdentity.serverId,
          tlsName: persistedIdentity.identity.tlsName,
          identitySpkiSha256: persistedIdentity.identity.identitySpkiSha256,
          identityCertificateDer: certPemToDerBase64Url(persistedIdentity.identity.identityCertPem)
        }
      : undefined;
  };
  registerAuthRoutes(routeApp, repo, { connectionRegistry, inviteSecurity: currentInviteSecurity });
  registerTeamRoutes(routeApp, repo, {
    get publicUrl() {
      return app.getPublicUrl();
    },
    get security() {
      return currentInviteSecurity();
    },
    allowRemoteBootstrap: options.allowRemoteBootstrap ?? false,
    bootstrapPin,
    connectionRegistry
  });
  registerRoomRoutes(routeApp, repo, {
    get publicUrl() {
      return app.getPublicUrl();
    },
    get security() {
      return currentInviteSecurity();
    },
    connectionRegistry
  });
  registerFriendRoutes(routeApp, repo, {
    get publicUrl() {
      return app.getPublicUrl();
    },
    get security() {
      return currentInviteSecurity();
    },
    connectionRegistry
  });
  registerFileRoutes(routeApp, repo, {
    maxFileBytes,
    connectionRegistry
  });
  if (security) {
    registerSecurityRoutes(routeApp, repo, { runtime: security.runtime, connectionRegistry, rotationProbeRateLimiter });
  }

  app.securityAdmin = {
    getSecurityState: () => repo.getSecurityState(),
    getMigrationMode: () => repo.getMigrationMode(),
    plainDeviceCount: () => repo.countActiveDevicesOnPlainTransport(),
    enableTlsMigration: async (mode, serverId) => {
      await repo.durable(() => {
        repo.setMigrationMode(mode);
        repo.setSecurityState("tls_migrating");
        repo.audit({
          teamId: null,
          actorType: "system",
          actorId: serverId,
          action: "security.migration_enabled",
          resourceType: "server",
          resourceId: serverId,
          metadata: { mode }
        });
      });
    },
    broadcastUpgrade: (info) => {
      connectionRegistry.broadcastAuthenticated({
        type: "security_upgrade_available",
        httpsUrl: info.httpsUrl,
        wssUrl: info.wssUrl
      });
    },
    enforceTls: async (serverId) => {
      await repo.durable(() => {
        repo.setSecurityState("tls_enforced");
        repo.audit({
          teamId: null,
          actorType: "system",
          actorId: serverId,
          action: "security.tls_enforced",
          resourceType: "server",
          resourceId: serverId,
          metadata: {}
        });
      });
      connectionRegistry.closeLegacyPlainTokenConnections();
    },
    recordIdentityRotation: async (serverId, record) => {
      await repo.durable(() => {
        repo.audit({
          teamId: null,
          actorType: "system",
          actorId: serverId,
          action: "identity.rotated",
          resourceType: "server",
          resourceId: serverId,
          metadata: {
            rotationId: record.rotationId,
            oldIdentitySpkiSha256: record.oldIdentitySpkiSha256,
            newIdentitySpkiSha256: record.newIdentitySpkiSha256
          }
        });
      });
    }
  };
  app.ownerAdmin = {
    isBootstrapped: () => repo.getServerOwnerId() !== null,
    recoverOwnerDevice: (deviceName, tokenSecurity) =>
      repo.durable(() => repo.recoverServerOwnerDevice({ deviceName, tokenSecurity })),
    revokeRecoveredOwnerDevice: (deviceId) => repo.durable(() => repo.revokeRecoveredOwnerDevice(deviceId))
  };

  return app;
}

export class EmbeddedRelayApp {
  private readonly routes: Route[] = [];
  private readonly beforeRouteHooks: Array<(request: EmbeddedRequest) => void> = [];
  private readonly sockets = new Map<WebSocket, RequestTransport>();
  private readonly webSocketServer: WebSocketServer;
  private plainServer: HttpServer | null = null;
  private tlsServer: HttpsServer | null = null;
  securityAdmin!: EmbeddedSecurityAdmin;
  ownerAdmin!: EmbeddedOwnerAdmin;

  constructor(
    private readonly db: RelayDb,
    private readonly maxFileBytes: number,
    readonly bootstrapPin: string,
    private readonly handleSyncSocket: (socket: SyncSocketLike, transport: RequestTransport) => void,
    private publicUrl = "http://127.0.0.1:8787"
  ) {
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: Math.max(maxFileBytes * 2, MIN_WEBSOCKET_PAYLOAD_BYTES),
      perMessageDeflate: false
    });
    this.webSocketServer.on("connection", (webSocket, request) => {
      const transport = (request as IncomingMessage & { transport?: RequestTransport }).transport ?? "http";
      this.sockets.set(webSocket, transport);
      webSocket.on("close", () => {
        this.sockets.delete(webSocket);
      });
      webSocket.on("error", () => {
        // ws emits protocol errors (for example maxPayload violations) before closing.
      });
      this.handleSyncSocket(webSocket, transport);
    });
  }

  getPublicUrl(): string {
    return this.publicUrl;
  }

  setPublicUrl(publicUrl: string): void {
    this.publicUrl = publicUrl;
  }

  get(path: string, handler: RouteHandler): void;
  get(path: string, _options: unknown, handler: RouteHandler): void;
  get(path: string, optionsOrHandler: unknown, maybeHandler?: RouteHandler): void {
    this.addRoute("GET", path, (typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler!) as RouteHandler);
  }

  post(path: string, handler: RouteHandler): void {
    this.addRoute("POST", path, handler);
  }

  put(path: string, handler: RouteHandler): void {
    this.addRoute("PUT", path, handler);
  }

  patch(path: string, handler: RouteHandler): void {
    this.addRoute("PATCH", path, handler);
  }

  delete(path: string, handler: RouteHandler): void {
    this.addRoute("DELETE", path, handler);
  }

  beforeRoute(hook: (request: EmbeddedRequest) => void): void {
    this.beforeRouteHooks.push(hook);
  }

  async listen(options: { host: string; port: number }): Promise<void> {
    const server = createHttpServer((request, response) => {
      void this.handleHttp(request, response, "http");
    });
    server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket as Socket, head, "http");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.plainServer = server;
  }

  async listenTls(options: { host: string; port: number; key: string; cert: string }): Promise<void> {
    const server = createHttpsServer({ key: options.key, cert: options.cert }, (request, response) => {
      void this.handleHttp(request, response, "https");
    });
    server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket as Socket, head, "https");
    });
    await listenServer(server, options.host, options.port);
    this.tlsServer = server;
  }

  async closePlainListener(): Promise<void> {
    const server = this.plainServer;
    this.plainServer = null;
    await this.closeListenerAndSockets(server, "http");
  }

  async closeTlsListener(): Promise<void> {
    const server = this.tlsServer;
    this.tlsServer = null;
    await this.closeListenerAndSockets(server, "https");
  }

  async restartTls(options: { host: string; port: number; key: string; cert: string }): Promise<void> {
    const server = this.tlsServer;
    this.tlsServer = null;
    await this.closeListenerAndSockets(server, "https");
    await this.listenTls(options);
  }

  async close(): Promise<void> {
    await Promise.all([...this.sockets.keys()].map((socket) => closeSocketWithGrace(socket)));
    await Promise.all([closeServer(this.plainServer), closeServer(this.tlsServer)]);
    this.plainServer = null;
    this.tlsServer = null;
    await new Promise<void>((resolve, reject) => {
      this.webSocketServer.close((error) => (error ? reject(error) : resolve()));
    });
    await this.db.close();
  }

  private async closeSocketsForTransport(transport: RequestTransport): Promise<void> {
    await Promise.all(
      [...this.sockets.entries()]
        .filter(([, socketTransport]) => socketTransport === transport)
        .map(([socket]) => closeSocketWithGrace(socket))
    );
  }

  private async closeListenerAndSockets(
    server: HttpServer | HttpsServer | null,
    transport: RequestTransport
  ): Promise<void> {
    const listenerClosed = closeServer(server);
    await this.closeSocketsForTransport(transport);
    await listenerClosed;
    // An upgrade already accepted before server.close() took effect can be registered after the
    // first snapshot. Once the listener is fully closed, a final pass is stable.
    await this.closeSocketsForTransport(transport);
  }

  private addRoute(method: RouteMethod, path: string, handler: RouteHandler): void {
    this.routes.push({ method, path, segments: splitPath(path), handler });
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse, transport: RequestTransport): Promise<void> {
    applyCors(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const parsedUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = (request.method ?? "GET").toUpperCase() as RouteMethod;
      const match = this.matchRoute(method, parsedUrl.pathname);
      if (!match) {
        throw new AppError("NOT_FOUND", "Route not found.", 404);
      }

      // Run beforeRouteHooks (e.g. the bootstrap rate limiter) against everything available
      // before reading the body, so a rejected request doesn't first pay the full body-read/parse
      // cost - matches the standalone Fastify path, where onRequest hooks run before body parsing.
      const baseRequest: EmbeddedRequest = {
        method,
        url: parsedUrl.pathname,
        headers: request.headers,
        body: undefined,
        params: match.params,
        query: Object.fromEntries(parsedUrl.searchParams.entries()),
        hostname: hostnameFromHeader(request.headers.host),
        ip: request.socket.remoteAddress ?? "",
        transport
      };
      for (const hook of this.beforeRouteHooks) {
        hook(baseRequest);
      }
      const embeddedRequest: EmbeddedRequest = {
        ...baseRequest,
        body: await readJsonBody(request, this.maxFileBytes)
      };
      sendJson(response, 200, await match.route.handler(embeddedRequest));
    } catch (error) {
      sendError(response, error);
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer, transport: RequestTransport): void {
    const parsedUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (parsedUrl.pathname !== "/sync") {
      socket.destroy();
      return;
    }

    try {
      const embeddedRequest: EmbeddedRequest = {
        method: (request.method ?? "GET").toUpperCase(),
        url: parsedUrl.pathname,
        headers: request.headers,
        body: undefined,
        params: {},
        query: Object.fromEntries(parsedUrl.searchParams.entries()),
        hostname: hostnameFromHeader(request.headers.host),
        ip: request.socket.remoteAddress ?? "",
        transport
      };
      for (const hook of this.beforeRouteHooks) {
        hook(embeddedRequest);
      }
      (request as IncomingMessage & { transport: RequestTransport }).transport = transport;
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer.emit("connection", webSocket, request);
      });
    } catch {
      socket.destroy();
    }
  }

  private matchRoute(method: RouteMethod, path: string): { route: Route; params: Record<string, string> } | null {
    const pathSegments = splitPath(path);
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== pathSegments.length) {
        continue;
      }
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const routeSegment = route.segments[index]!;
        const pathSegment = pathSegments[index]!;
        if (routeSegment.startsWith(":")) {
          params[routeSegment.slice(1)] = decodeURIComponent(pathSegment);
          continue;
        }
        if (routeSegment !== pathSegment) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return { route, params };
      }
    }
    return null;
  }
}

export type EmbeddedSecurityAdmin = {
  getSecurityState(): ServerSecurityState;
  getMigrationMode(): MigrationMode;
  plainDeviceCount(): number;
  enableTlsMigration(mode: MigrationMode, serverId: string): Promise<void>;
  broadcastUpgrade(info: SecurityUpgradeInfo): void;
  enforceTls(serverId: string): Promise<void>;
  recordIdentityRotation(serverId: string, record: IdentityRotationRecord): Promise<void>;
};

export type EmbeddedOwnerRecoveryResult = {
  user: { id: string; displayName: string };
  device: { id: string; displayName: string };
  deviceToken: string;
  isServerOwner: true;
};

export type EmbeddedOwnerAdmin = {
  isBootstrapped(): boolean;
  recoverOwnerDevice(deviceName: string, tokenSecurity: "plain" | "tls"): Promise<EmbeddedOwnerRecoveryResult>;
  revokeRecoveredOwnerDevice(deviceId: string): Promise<void>;
};

async function listenServer(server: HttpServer | HttpsServer, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: HttpServer | HttpsServer | null): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function closeSocketWithGrace(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
      resolve();
    }, SOCKET_CLOSE_GRACE_MS);
    const onClose = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      socket.off("close", onClose);
    };
    socket.once("close", onClose);
    socket.close();
    if (socket.readyState === WebSocket.CLOSED) {
      onClose();
    }
  });
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

async function readJsonBody(request: IncomingMessage, maxFileBytes: number): Promise<unknown> {
  if (request.method === "GET" || request.method === "DELETE") {
    return {};
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const requestBody = request as AsyncIterable<Buffer | Uint8Array | string>;
  for await (const chunk of requestBody) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > Math.max(maxFileBytes * 2, 5 * 1024 * 1024)) {
      throw new AppError("FILE_TOO_LARGE", "The request body is too large.", 413);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.", 400);
  }
}

function applyCors(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization,content-type");
  response.setHeader("access-control-max-age", "86400");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof AppError) {
    sendJson(response, error.statusCode, toApiError(error));
    return;
  }
  sendJson(response, 500, toApiError(new AppError("VALIDATION_ERROR", "Unexpected server error.", 500)));
}

function hostnameFromHeader(host: string | undefined): string {
  if (!host) {
    return "";
  }
  if (host.startsWith("[")) {
    return host.slice(1, host.indexOf("]"));
  }
  return host.split(":")[0] ?? "";
}
