export const LAN_DISCOVERY_MAGIC = "vault-rooms-lan";
export const LAN_DISCOVERY_VERSION = 1;
export const LAN_DISCOVERY_GROUP = "239.255.86.82";
export const LAN_DISCOVERY_PORT = 47878;
export const LAN_DISCOVERY_MAX_BYTES = 1024;

export type LanDiscoveryQuery = {
  magic: typeof LAN_DISCOVERY_MAGIC;
  version: typeof LAN_DISCOVERY_VERSION;
  type: "discover";
  serverId: string;
  nonce: string;
};

export type LanDiscoveryResponse = {
  magic: typeof LAN_DISCOVERY_MAGIC;
  version: typeof LAN_DISCOVERY_VERSION;
  type: "here";
  serverId: string;
  nonce: string;
  transport: "http" | "https";
  port: number;
};

export type LanDiscoveryMessage = LanDiscoveryQuery | LanDiscoveryResponse;

const QUERY_KEYS = ["magic", "nonce", "serverId", "type", "version"];
const RESPONSE_KEYS = [...QUERY_KEYS, "port", "transport"].sort();
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function encodeLanDiscoveryQuery(serverId: string, nonce: string): Uint8Array {
  assertCommon(serverId, nonce);
  return encode({
    magic: LAN_DISCOVERY_MAGIC,
    version: LAN_DISCOVERY_VERSION,
    type: "discover",
    serverId,
    nonce
  });
}

export function encodeLanDiscoveryResponse(
  serverId: string,
  nonce: string,
  transport: "http" | "https",
  port: number
): Uint8Array {
  assertCommon(serverId, nonce);
  if ((transport !== "http" && transport !== "https") || !validPort(port)) {
    throw new Error("Invalid LAN discovery endpoint.");
  }
  return encode({
    magic: LAN_DISCOVERY_MAGIC,
    version: LAN_DISCOVERY_VERSION,
    type: "here",
    serverId,
    nonce,
    transport,
    port
  });
}

export function parseLanDiscoveryMessage(input: Uint8Array): LanDiscoveryMessage | null {
  if (input.byteLength === 0 || input.byteLength > LAN_DISCOVERY_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(input));
  } catch {
    return null;
  }
  if (!isRecord(value) || value.magic !== LAN_DISCOVERY_MAGIC || value.version !== LAN_DISCOVERY_VERSION) {
    return null;
  }
  if (!validCommon(value.serverId, value.nonce)) return null;
  if (value.type === "discover" && hasExactKeys(value, QUERY_KEYS)) {
    return value as LanDiscoveryQuery;
  }
  if (
    value.type === "here" &&
    hasExactKeys(value, RESPONSE_KEYS) &&
    (value.transport === "http" || value.transport === "https") &&
    validPort(value.port)
  ) {
    return value as LanDiscoveryResponse;
  }
  return null;
}

export function endpointFromDiscovery(address: string, response: LanDiscoveryResponse): string {
  const host = address.includes(":") ? `[${address.replace(/^\[|\]$/g, "")}]` : address;
  return `${response.transport}://${host}:${response.port}`;
}

function encode(value: LanDiscoveryMessage): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.byteLength > LAN_DISCOVERY_MAX_BYTES) {
    throw new Error("LAN discovery message is too large.");
  }
  return encoded;
}

function assertCommon(serverId: string, nonce: string): void {
  if (!validCommon(serverId, nonce)) {
    throw new Error("Invalid LAN discovery identity.");
  }
}

function validCommon(serverId: unknown, nonce: unknown): serverId is string {
  return typeof serverId === "string" && SERVER_ID_PATTERN.test(serverId) && typeof nonce === "string" && NONCE_PATTERN.test(nonce);
}

function validPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
