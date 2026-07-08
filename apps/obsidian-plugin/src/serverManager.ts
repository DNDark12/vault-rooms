import { join } from "node:path";
import { createApp } from "vault-rooms-relay/app";
import { detectLanIp, resolveRuntimeConfig, type EnvLike } from "vault-rooms-relay/config";
import type { EmbeddedServerSettings } from "./settings.js";
// Bundled directly into main.js by esbuild's "binary" loader - see esbuild.config.mjs. This
// avoids depending on a separately-shipped sql-wasm.wasm file, which the community-plugin
// installer would never actually deliver (it only downloads main.js/manifest.json/styles.css).
import sqlWasmBinary from "sql.js/dist/sql-wasm.wasm";

type FastifyLikeApp = Awaited<ReturnType<typeof createApp>>;

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
 * Runs the Vault Rooms relay server (Fastify + WebSocket sync) directly inside the
 * Obsidian plugin process. No separate terminal/process is required: install the
 * plugin, click Start, and the server is listening.
 */
export class EmbeddedRelayServer {
  private app: FastifyLikeApp | null = null;
  private status: EmbeddedServerStatus = { running: false };

  constructor(
    /** Absolute filesystem path where the SQLite file and content blobs are stored. */
    private readonly dataDir: string
  ) {}

  getStatus(): EmbeddedServerStatus {
    return this.status;
  }

  /**
   * Reads the running embedded server's bootstrap PIN directly off the in-process Fastify
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
      const publicUrlOverride = settings.publicUrlOverride?.trim();
      const env: EnvLike = {
        HOST: "0.0.0.0",
        PORT: explicitPort ? String(explicitPort) : undefined,
        PUBLIC_URL: publicUrlOverride || undefined,
        MAX_FILE_BYTES: String(settings.maxFileBytes),
        ALLOW_REMOTE_BOOTSTRAP: settings.allowRemoteBootstrap ? "true" : "false"
      };
      const config = await resolveRuntimeConfig(env, preferredPort);
      const app = await createApp({
        dbPath: join(this.dataDir, "relay.sqlite"),
        publicUrl: config.publicUrl,
        allowRemoteBootstrap: config.allowRemoteBootstrap,
        maxFileBytes: config.maxFileBytes,
        sqlJsLocator: { wasmBinary: toArrayBuffer(sqlWasmBinary) }
      });
      await app.listen({ host: config.host, port: config.port });
      this.app = app;
      // If LAN IP detection fails and no override is set, do NOT quietly fall back to a "lanUrl"
      // of 127.0.0.1 - that produces exactly the "invite link is 127.0.0.1 and B can't join"
      // confusion, with no indication anything went wrong. Surface it instead so the UI can tell
      // the user to set a manual "Public URL override".
      const detectedLanIp = publicUrlOverride ? undefined : detectLanIp();
      const lanUrl = publicUrlOverride ? config.publicUrl : detectedLanIp ? `http://${detectedLanIp}:${config.port}` : undefined;
      const portPinChanged = !explicitPort && preferredPort !== undefined && config.port !== preferredPort;
      const portPinFallbackReason = portPinChanged
        ? (await isVaultRoomsServerOnPort(preferredPort))
          ? "zombie"
          : "occupied"
        : undefined;
      this.status = {
        running: true,
        host: config.host,
        port: config.port,
        localUrl: `http://127.0.0.1:${config.port}`,
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

async function isVaultRoomsServerOnPort(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    const body = (await response.json()) as { name?: unknown };
    return body.name === "vault-rooms";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
