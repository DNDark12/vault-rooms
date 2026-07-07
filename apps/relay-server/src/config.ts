import { createServer } from "node:net";
import { networkInterfaces } from "node:os";

export const DEFAULT_PORT = 8787;
export const MAX_FALLBACK_PORT = 8797;

export type EnvLike = {
  PORT?: string;
  HOST?: string;
  PUBLIC_URL?: string;
  MAX_FILE_BYTES?: string;
  ALLOW_REMOTE_BOOTSTRAP?: string;
};

export type ServerRuntimeConfig = {
  host: string;
  port: number;
  publicUrl: string;
  maxFileBytes: number;
  allowRemoteBootstrap: boolean;
};

export async function choosePort(
  env: EnvLike = process.env,
  isPortAvailable: (port: number) => Promise<boolean> = defaultIsPortAvailable
): Promise<number> {
  if (env.PORT) {
    const port = parsePort(env.PORT);
    if (!(await isPortAvailable(port))) {
      throw new Error(`PORT=${port} is already in use`);
    }
    return port;
  }

  for (let port = DEFAULT_PORT; port <= MAX_FALLBACK_PORT; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No free port found between ${DEFAULT_PORT} and ${MAX_FALLBACK_PORT}`);
}

export async function resolveRuntimeConfig(env: EnvLike = process.env): Promise<ServerRuntimeConfig> {
  const host = env.HOST ?? "127.0.0.1";
  const port = await choosePort(env);
  return {
    host,
    port,
    publicUrl: env.PUBLIC_URL ?? detectPublicUrl(host, port),
    maxFileBytes: Number.parseInt(env.MAX_FILE_BYTES ?? "1048576", 10),
    allowRemoteBootstrap: env.ALLOW_REMOTE_BOOTSTRAP === "true"
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
