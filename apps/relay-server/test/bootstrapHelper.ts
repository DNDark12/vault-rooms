import type { createApp } from "../src/app.js";

type App = Awaited<ReturnType<typeof createApp>>;

/**
 * Reads the running test app's in-process bootstrap PIN the same way EmbeddedRelayServer does in
 * production (see security/bootstrapPin.ts and app.ts's `app.decorate("bootstrapPin", ...)`).
 */
export function getBootstrapPin(app: App): string {
  return (app as unknown as { bootstrapPin: string }).bootstrapPin;
}

/**
 * Shared POST /api/bootstrap helper for tests. Defaults to a real local caller (remoteAddress
 * 127.0.0.1) with the app's own correct PIN and no Host override (Fastify's inject default Host
 * of "localhost:80" already satisfies the Host-validation check in team.routes.ts) - i.e. the
 * happy path every existing flow test relies on. Individual tests can override `pin`,
 * `remoteAddress`, or `headers` to exercise the PIN/Host security checks themselves.
 */
export async function injectBootstrap(
  app: App,
  payload: { displayName: string; deviceName: string; teamName?: string },
  options: { remoteAddress?: string; pin?: string; headers?: Record<string, string> } = {}
) {
  return app.inject({
    method: "POST",
    url: "/api/bootstrap",
    remoteAddress: options.remoteAddress ?? "127.0.0.1",
    headers: options.headers,
    payload: { ...payload, pin: options.pin ?? getBootstrapPin(app) }
  });
}
