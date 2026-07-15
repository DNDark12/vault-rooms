import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import type { MigrationMode } from "@vault-rooms/protocol";

export const DEFAULT_PORT = 8787;
export const MAX_FALLBACK_PORT = 8797;

export type EnvLike = {
  PORT?: string;
  HOST?: string;
  PUBLIC_URL?: string;
  MAX_FILE_BYTES?: string;
  ALLOW_REMOTE_BOOTSTRAP?: string;
  TLS_MODE?: string;
  TLS_PORT?: string;
  TLS_CERT_FILE?: string;
  TLS_KEY_FILE?: string;
  IDENTITY_DIR?: string;
  TLS_DUAL_STACK?: string;
  TLS_MIGRATION_MODE?: string;
};

export type TlsMode = "plain" | "pinned" | "os-trusted";

export type ServerRuntimeConfig = {
  host: string;
  port: number;
  publicUrl: string;
  maxFileBytes: number;
  allowRemoteBootstrap: boolean;
  tlsMode: TlsMode;
  tlsPort?: number;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  identityDir: string;
  tlsDualStack: boolean;
  tlsMigrationMode: MigrationMode;
};

export async function choosePort(
  env: EnvLike = process.env,
  isPortAvailable: (port: number) => Promise<boolean> = defaultIsPortAvailable,
  preferredPort?: number
): Promise<number> {
  if (env.PORT) {
    const port = parsePort(env.PORT);
    if (!(await isPortAvailable(port))) {
      throw new Error(`PORT=${port} is already in use`);
    }
    return port;
  }

  if (preferredPort !== undefined && (await isPortAvailable(preferredPort))) {
    return preferredPort;
  }

  for (let port = DEFAULT_PORT; port <= MAX_FALLBACK_PORT; port += 1) {
    if (port === preferredPort) {
      continue;
    }
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No free port found between ${DEFAULT_PORT} and ${MAX_FALLBACK_PORT}`);
}

export async function resolveRuntimeConfig(
  env: EnvLike = process.env,
  preferredPort?: number,
  isPortAvailable: (port: number) => Promise<boolean> = defaultIsPortAvailable
): Promise<ServerRuntimeConfig> {
  const host = env.HOST ?? "127.0.0.1";
  const tlsMode = parseTlsMode(env.TLS_MODE);
  const tlsMigrationMode = parseTlsMigrationMode(env.TLS_MIGRATION_MODE);
  if (tlsMode === "os-trusted" && env.TLS_DUAL_STACK === "true") {
    throw new Error("TLS_DUAL_STACK is supported only with TLS_MODE=pinned");
  }
  const tlsDualStack = tlsMode === "pinned" && env.TLS_DUAL_STACK === "true";
  let port: number;
  let tlsPort: number | undefined;
  if (tlsMode !== "plain" && !tlsDualStack && env.TLS_PORT) {
    port = env.PORT ? parsePort(env.PORT) : (preferredPort ?? DEFAULT_PORT);
    tlsPort = parsePort(env.TLS_PORT);
    if (!(await isPortAvailable(tlsPort))) {
      throw new Error(`TLS_PORT=${tlsPort} is already in use`);
    }
  } else {
    port = await choosePort(env, isPortAvailable, preferredPort);
    tlsPort = await resolveTlsPort(env, tlsMode, tlsDualStack, port, isPortAvailable);
  }
  const detectedPublicUrl = detectPublicUrl(host, tlsPort ?? port);
  const publicUrl =
    env.PUBLIC_URL ?? (tlsMode === "plain" ? detectedPublicUrl : detectedPublicUrl.replace(/^http:/, "https:"));
  return {
    host,
    port,
    publicUrl,
    maxFileBytes: Number.parseInt(env.MAX_FILE_BYTES ?? "5242880", 10),
    allowRemoteBootstrap: env.ALLOW_REMOTE_BOOTSTRAP === "true",
    tlsMode,
    ...(tlsPort === undefined ? {} : { tlsPort }),
    ...(env.TLS_CERT_FILE ? { tlsCertFile: env.TLS_CERT_FILE } : {}),
    ...(env.TLS_KEY_FILE ? { tlsKeyFile: env.TLS_KEY_FILE } : {}),
    identityDir: env.IDENTITY_DIR ?? "data",
    tlsDualStack,
    tlsMigrationMode
  };
}

export function detectPublicUrl(host: string, port: number): string {
  if (host !== "0.0.0.0") {
    return `http://${host}:${port}`;
  }
  const lanIp = detectLanIp() ?? "127.0.0.1";
  return `http://${lanIp}:${port}`;
}

export function detectLanIp(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return null;
}

async function defaultIsPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }
  return port;
}

function parseTlsMode(value: string | undefined): TlsMode {
  const mode = value ?? "plain";
  if (mode !== "plain" && mode !== "pinned" && mode !== "os-trusted") {
    throw new Error(`Invalid TLS_MODE value: ${mode}`);
  }
  return mode;
}

function parseTlsMigrationMode(value: string | undefined): MigrationMode {
  const mode = value ?? "non_strict";
  if (mode !== "non_strict" && mode !== "strict") {
    throw new Error(`Invalid TLS_MIGRATION_MODE value: ${mode}`);
  }
  return mode;
}

async function resolveTlsPort(
  env: EnvLike,
  mode: TlsMode,
  dualStack: boolean,
  port: number,
  isPortAvailable: (port: number) => Promise<boolean>
): Promise<number | undefined> {
  if (mode === "plain") {
    return undefined;
  }
  const tlsPort = env.TLS_PORT ? parsePort(env.TLS_PORT) : dualStack ? port + 1 : port;
  if (dualStack && tlsPort === port) {
    throw new Error("TLS_PORT must differ from PORT when TLS_DUAL_STACK=true");
  }
  if (tlsPort !== port && !(await isPortAvailable(tlsPort))) {
    throw new Error(`TLS_PORT=${tlsPort} is already in use`);
  }
  return tlsPort;
}
