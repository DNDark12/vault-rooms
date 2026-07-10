import { createServer } from "node:net";
import type { DataAdapter } from "obsidian";
import type { EmbeddedServerSettings } from "./settings.js";
import { requestUrlWithTimeout } from "./apiClient.js";
import { createEmbeddedRelayApp, type EmbeddedRelayApp } from "./embeddedRelayApp.js";
import { openObsidianSqlJsDb } from "./obsidianSqlJsDb.js";
// Bundled directly into main.js by esbuild's "binary" loader - see esbuild.config.mjs. This
// avoids depending on a separately-shipped sql-wasm.wasm file, which the community-plugin
// installer would never actually deliver (it only downloads main.js/manifest.json/styles.css).
import sqlWasmBinary from "sql.js/dist/sql-wasm-browser.wasm";

export type EmbeddedServerStatus =
  | { running: false; error?: string }
  | {
      running: true;
      host: string;
      port: number;
      localUrl: string;
      lanUrl?: string;
      lanDetectionFailed?: boolean;
      portPinChanged?: boolean;
      portPinFallbackReason?: "zombie" | "occupied";
    };

/**
 * Runs the Vault Rooms relay server (REST + WebSocket sync) directly inside the
 * Obsidian plugin process. No separate terminal/process is required: install the
 * plugin, click Start, and the server is listening.
 */
export class EmbeddedRelayServer {
  private app: EmbeddedRelayApp | null = null;
  private status: EmbeddedServerStatus = { running: false };

  constructor(
    private readonly adapter: DataAdapter,
    /** Vault-relative plugin data path where the SQLite file is stored through Obsidian's adapter. */
    private readonly dbPath: string
  ) {}

  getStatus(): EmbeddedServerStatus {
    return this.status;
  }

  /**
   * Reads the running embedded server's bootstrap PIN directly off the in-process relay app
   * instance (see relay-server's security/bootstrapPin.ts and team.routes.ts) - no network call.
   * The plugin's own setup flow (main.ts's setupServer()) uses this to satisfy POST
   * /api/bootstrap's PIN requirement transparently, since it is the legitimate same-process
   * caller. Returns null if the server isn't running.
   */
  getBootstrapPin(): string | null {
    return this.app ? (this.app as unknown as { bootstrapPin: string }).bootstrapPin : null;
  }

  async start(settings: EmbeddedServerSettings): Promise<EmbeddedServerStatus> {
    if (this.status.running) {
      return this.status;
    }
    const explicitPort = settings.port;
    const preferredPort = explicitPort ? undefined : settings.pinnedPort;
    try {
      // Always bind every interface (0.0.0.0), not just 127.0.0.1: there is no supported "this
      // device only" mode - a server that teammates can't reach isn't useful, and the invite
      // flow/policy engine already require a valid invite token (and localhost-only bootstrap by
      // default) to actually do anything, so this doesn't expose more than intended.
      const port = explicitPort ? await requireAvailablePort(explicitPort) : await chooseAvailablePort(preferredPort);
      const publicUrlOverride = settings.publicUrlOverride?.trim();
      const publicUrl = publicUrlOverride || `http://127.0.0.1:${port}`;
      const db = await openObsidianSqlJsDb(this.adapter, this.dbPath, { wasmBinary: toArrayBuffer(sqlWasmBinary) });
      let app: EmbeddedRelayApp;
      try {
        app = await createEmbeddedRelayApp(db, {
          publicUrl,
          allowRemoteBootstrap: settings.allowRemoteBootstrap,
          maxFileBytes: settings.maxFileBytes
        });
        await app.listen({ host: "0.0.0.0", port });
      } catch (error) {
        // A failed listen() (e.g. a TOCTOU port race) must not leave db open: its flush timer
        // would keep firing in the background, and a retried Start would open a second RelayDb
        // instance on the same file, racing the leaked one's writes.
        await db.close();
        throw error;
      }
      this.app = app;
      // Do not auto-read network interfaces in the plugin: Obsidian's publish scanner treats that
      // as machine fingerprinting. Users who want LAN invites can set the explicit Public URL
      // override; otherwise the embedded owner connection stays pinned to loopback.
      const lanUrl = publicUrlOverride ? publicUrl : undefined;
      const portPinChanged = !explicitPort && preferredPort !== undefined && port !== preferredPort;
      const portPinFallbackReason = portPinChanged
        ? (await isVaultRoomsServerOnPort(preferredPort))
          ? "zombie"
          : "occupied"
        : undefined;
      this.status = {
        running: true,
        host: "0.0.0.0",
        port,
        localUrl: `http://127.0.0.1:${port}`,
        lanUrl,
        lanDetectionFailed: !lanUrl,
        portPinChanged: portPinChanged || undefined,
        portPinFallbackReason
      };
      return this.status;
    } catch (error) {
      const finalError =
        explicitPort && isExplicitPortBusyError(error, explicitPort)
          ? new Error(await describeBusyPort(explicitPort))
          : error;
      this.status = { running: false, error: finalError instanceof Error ? finalError.message : String(finalError) };
      throw finalError;
    }
  }

  async stop(): Promise<void> {
    const app = this.app;
    this.app = null;
    if (app) {
      await app.close();
    }
    this.status = { running: false };
  }
}

function toArrayBuffer(buffer: Uint8Array): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function isExplicitPortBusyError(error: unknown, port: number): boolean {
  return error instanceof Error && error.message === `PORT=${port} is already in use`;
}

async function describeBusyPort(port: number): Promise<string> {
  if (await isVaultRoomsServerOnPort(port)) {
    return `PORT=${port} is already in use by what looks like a previous Vault Rooms server instance. Stop the old instance or choose another port.`;
  }
  return `PORT=${port} is already in use by another app. Stop that app or choose another port.`;
}

async function requireAvailablePort(port: number): Promise<number> {
  if (!(await isPortAvailable(port))) {
    throw new Error(`PORT=${port} is already in use`);
  }
  return port;
}

async function chooseAvailablePort(preferredPort?: number): Promise<number> {
  if (preferredPort !== undefined && (await isPortAvailable(preferredPort))) {
    return preferredPort;
  }
  for (let port = 8787; port <= 8797; port += 1) {
    if (port === preferredPort) {
      continue;
    }
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error("No free port found between 8787 and 8797");
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

async function isVaultRoomsServerOnPort(port: number): Promise<boolean> {
  try {
    const response = await requestUrlWithTimeout({ url: `http://127.0.0.1:${port}/health`, throw: false }, 800);
    const body = response.json as { name?: unknown };
    return body.name === "vault-rooms";
  } catch {
    return false;
  }
}
