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
  | { running: true; host: string; port: number; localUrl: string; lanUrl?: string; lanDetectionFailed?: boolean };

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

  async start(settings: EmbeddedServerSettings): Promise<EmbeddedServerStatus> {
    if (this.status.running) {
      return this.status;
    }
    try {
      // Always bind every interface (0.0.0.0), not just 127.0.0.1: there is no supported "this
      // device only" mode - a server that teammates can't reach isn't useful, and the invite
      // flow/policy engine already require a valid invite token (and localhost-only bootstrap by
      // default) to actually do anything, so this doesn't expose more than intended.
      const publicUrlOverride = settings.publicUrlOverride?.trim();
      const env: EnvLike = {
        HOST: "0.0.0.0",
        PORT: settings.port ? String(settings.port) : undefined,
        PUBLIC_URL: publicUrlOverride || undefined,
        MAX_FILE_BYTES: String(settings.maxFileBytes),
        ALLOW_REMOTE_BOOTSTRAP: settings.allowRemoteBootstrap ? "true" : "false"
      };
      const config = await resolveRuntimeConfig(env);
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
      this.status = {
        running: true,
        host: config.host,
        port: config.port,
        localUrl: `http://127.0.0.1:${config.port}`,
        lanUrl,
        lanDetectionFailed: !lanUrl
      };
      return this.status;
    } catch (error) {
      this.status = { running: false, error: error instanceof Error ? error.message : String(error) };
      throw error;
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
