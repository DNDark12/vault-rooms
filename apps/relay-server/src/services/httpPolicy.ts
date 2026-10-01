import { AppError } from "@vault-rooms/protocol";
import type { RelayRepository } from "../db/repositories/relayRepository.js";
import { getActivePrincipal } from "./authService.js";
import { formatFileLimit } from "./userFacingMessages.js";

// Request policy both runtimes apply before a route reads its body.

/** Body cap for every request that does not carry file content: settings, ACL rules, invites,
 *  bootstrap and join. The unauthenticated routes are among them, so a caller without a device
 *  token can never make the relay buffer a file-sized body. */
export const SMALL_JSON_BODY_BYTES = 64 * 1024;

// Routes a caller reaches before it has a device token, plus /sync, which authenticates in-band
// with its hello message.
const PUBLIC_ROUTES = new Set([
  "GET /health",
  "GET /sync",
  "POST /api/bootstrap",
  "POST /api/join",
  "POST /api/invites/accept",
  "GET /api/identity/rotations"
]);

// Obsidian's desktop renderer. Current plugins call the relay through requestUrl or Node
// transports, which CORS never applies to; releases before 0.1.4 used renderer fetch().
const ALLOWED_CORS_ORIGINS = new Set(["app://obsidian.md"]);

const CORS_GRANT = {
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-max-age": "86400"
};

const RAW_UPLOAD_ROUTE = "PUT /api/rooms/:roomId/files/raw";
const CONTENT_UPLOAD_ROUTE = "PUT /api/rooms/:roomId/files/content";

export function bodyLimitFor(method: string, routePath: string, maxFileBytes: number): number {
  const route = `${method} ${routePath}`;
  if (route === RAW_UPLOAD_ROUTE) {
    return maxFileBytes;
  }
  if (route === CONTENT_UPLOAD_ROUTE) {
    // JSON quoting and escaping (base64 for binary files) makes the body larger than the file it
    // carries, so a file just under the limit still reaches the handler's FILE_TOO_LARGE check.
    return Math.max(maxFileBytes * 2, 5 * 1024 * 1024);
  }
  return SMALL_JSON_BODY_BYTES;
}

export function bodyTooLargeError(method: string, routePath: string, maxFileBytes: number): AppError {
  const route = `${method} ${routePath}`;
  return route === RAW_UPLOAD_ROUTE || route === CONTENT_UPLOAD_ROUTE
    ? new AppError("FILE_TOO_LARGE", `This file is larger than this server accepts (limit ${formatFileLimit(maxFileBytes)}).`, 413)
    : new AppError("FILE_TOO_LARGE", "The request body is too large.", 413);
}

/** Rejects a protected route's caller before any of its request body is read. */
export function authenticateBeforeBody(
  repo: RelayRepository,
  method: string,
  routePath: string,
  request: { headers: { authorization?: string | undefined } }
): void {
  const routeMethod = method === "HEAD" ? "GET" : method;
  if (!PUBLIC_ROUTES.has(`${routeMethod} ${routePath}`)) {
    getActivePrincipal(repo, request);
  }
}

/** CORS headers for a response: a grant for an allowed origin, nothing for any other. */
export function corsHeadersFor(origin: string | undefined): Record<string, string> {
  return origin !== undefined && ALLOWED_CORS_ORIGINS.has(origin)
    ? { "access-control-allow-origin": origin, vary: "Origin", ...CORS_GRANT }
    : { vary: "Origin" };
}
