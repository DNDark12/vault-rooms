import { randomInt } from "node:crypto";

/**
 * Generates a short, unguessable numeric PIN (using the CSPRNG, not Math.random) that gates
 * POST /api/bootstrap - see team.routes.ts. This defends against drive-by/DNS-rebinding bootstrap
 * attempts: the localhost-only check alone is not enough, since a malicious web page can rebind a
 * DNS name to 127.0.0.1/a LAN IP and issue the request from what looks like a local origin. The
 * PIN is generated fresh per server process and is only ever read in-process (by the embedded
 * plugin) or printed to the operator's console (standalone CLI) - it is never itself transmitted
 * over the network except as the caller's own proof-of-possession in the bootstrap request body.
 */
export function generateBootstrapPin(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}
