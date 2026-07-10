import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { AppError, PRODUCT_NAME, PRODUCT_VERSION, toApiError, type HealthResponse } from "@vault-rooms/protocol";
import WebSocket, { WebSocketServer } from "ws";
import {
  createRelayCore,
  handleSyncSocket,
  registerAuthRoutes,
  registerFileRoutes,
  registerFriendRoutes,
  registerRoomRoutes,
  registerTeamRoutes,
  type RelayDb
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
  };
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
  const { repo, connectionRegistry, bootstrapPin, bootstrapRateLimiter, maxFileBytes, maxConnections } = createRelayCore(db, options);
  const app = new EmbeddedRelayApp(db, maxFileBytes, bootstrapPin, (socket) => {
    handleSyncSocket(socket, repo, connectionRegistry, { maxFileBytes, maxConnections });
  });

  app.get("/health", async (): Promise<HealthResponse> => ({
    ok: true,
    name: PRODUCT_NAME,
    version: PRODUCT_VERSION
  }));

  app.beforeRoute((request) => {
    if (request.method === "POST" && request.url === "/api/bootstrap" && !bootstrapRateLimiter.consume(request.ip)) {
      throw new AppError("RATE_LIMITED", "Too many bootstrap attempts. Try again later.", 429);
    }
  });

  const routeApp = app as never;
  registerAuthRoutes(routeApp, repo);
  registerTeamRoutes(routeApp, repo, {
    publicUrl: options.publicUrl ?? "http://127.0.0.1:8787",
    allowRemoteBootstrap: options.allowRemoteBootstrap ?? false,
    bootstrapPin,
    connectionRegistry
  });
  const publicUrl = options.publicUrl ?? "http://127.0.0.1:8787";
  registerRoomRoutes(routeApp, repo, { publicUrl, connectionRegistry });
  registerFriendRoutes(routeApp, repo, { publicUrl, connectionRegistry });
  registerFileRoutes(routeApp, repo, {
    maxFileBytes,
    connectionRegistry
  });

  return app;
}

export class EmbeddedRelayApp {
  private readonly routes: Route[] = [];
  private readonly beforeRouteHooks: Array<(request: EmbeddedRequest) => void> = [];
  private readonly sockets = new Set<WebSocket>();
  private readonly webSocketServer: WebSocketServer;
  private server: Server | null = null;

  constructor(
    private readonly db: RelayDb,
    private readonly maxFileBytes: number,
    readonly bootstrapPin: string,
    private readonly handleSyncSocket: (socket: SyncSocketLike) => void
  ) {
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: Math.max(maxFileBytes * 2, MIN_WEBSOCKET_PAYLOAD_BYTES),
      perMessageDeflate: false
    });
    this.webSocketServer.on("connection", (webSocket) => {
      this.sockets.add(webSocket);
      webSocket.on("close", () => {
        this.sockets.delete(webSocket);
      });
      webSocket.on("error", () => {
        // ws emits protocol errors (for example maxPayload violations) before closing.
      });
      this.handleSyncSocket(webSocket);
    });
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
    const server = createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket as Socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
  }

  async close(): Promise<void> {
    await Promise.all([...this.sockets].map((socket) => closeSocketWithGrace(socket)));
    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      this.webSocketServer.close((error) => (error ? reject(error) : resolve()));
    });
    await this.db.close();
  }

  private addRoute(method: RouteMethod, path: string, handler: RouteHandler): void {
    this.routes.push({ method, path, segments: splitPath(path), handler });
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
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
        ip: request.socket.remoteAddress ?? ""
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

  private handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const parsedUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (parsedUrl.pathname !== "/sync") {
      socket.destroy();
      return;
    }

    try {
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
