import { randomBytes as nodeRandomBytes } from "node:crypto";
import { createSocket as nodeCreateSocket } from "node:dgram";
import { networkInterfaces as nodeNetworkInterfaces } from "os";
import {
  LAN_DISCOVERY_GROUP,
  LAN_DISCOVERY_PORT,
  encodeLanDiscoveryQuery,
  encodeLanDiscoveryResponse,
  endpointFromDiscovery,
  parseLanDiscoveryMessage
} from "./lanDiscoveryProtocol.js";

type RemoteInfo = { address: string; port: number };
type TimerHandle = ReturnType<typeof setTimeout>;

export type LanDiscoverySocket = {
  on(event: "listening", callback: () => void): LanDiscoverySocket;
  on(event: "message", callback: (data: Uint8Array, remote: RemoteInfo) => void): LanDiscoverySocket;
  on(event: "error", callback: (error: Error) => void): LanDiscoverySocket;
  bind(port?: number): void;
  send(data: Uint8Array, port: number, address: string): void;
  setMulticastTTL(ttl: number): void;
  setMulticastInterface(interfaceAddress: string): void;
  setBroadcast(enabled: boolean): void;
  addMembership(group: string, interfaceAddress?: string): void;
  close(): void;
};

export type LanDiscoveryDependencies = {
  createSocket?: () => LanDiscoverySocket;
  randomBytes?: () => Uint8Array;
  setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
  now?: () => number;
  getBroadcastAddress?: (interfaceAddress?: string) => string | undefined;
};

export type LanDiscoveryCandidate = {
  baseUrl: string;
  address: string;
  transport: "http" | "https";
  port: number;
};

export type LanDiscoverySearch = {
  result: Promise<LanDiscoveryCandidate[]>;
  cancel(): void;
};

export function startLanDiscovery(
  serverId: string,
  interfaceAddress?: string,
  dependencies: LanDiscoveryDependencies = {}
): LanDiscoverySearch {
  const deps = resolvedDependencies(dependencies);
  const nonce = Buffer.from(deps.randomBytes()).toString("base64url");
  const query = encodeLanDiscoveryQuery(serverId, nonce);
  let broadcastAddress = deps.getBroadcastAddress(interfaceAddress);
  const socket = deps.createSocket();
  const candidates = new Map<string, LanDiscoveryCandidate>();
  const timers: TimerHandle[] = [];
  let settled = false;
  let resolveResult!: (candidates: LanDiscoveryCandidate[]) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<LanDiscoveryCandidate[]>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    for (const timer of timers) deps.clearTimeout(timer);
    try {
      socket.close();
    } catch {
      // The socket may have failed before binding.
    }
    if (error) rejectResult(error);
    else resolveResult([...candidates.values()]);
  };

  const sendQuery = () => {
    if (settled) return;
    try {
      socket.send(query, LAN_DISCOVERY_PORT, LAN_DISCOVERY_GROUP);
      if (broadcastAddress) socket.send(query, LAN_DISCOVERY_PORT, broadcastAddress);
    } catch (error) {
      finish(asError(error));
    }
  };

  socket.on("message", (data, remote) => {
    const message = parseLanDiscoveryMessage(data);
    if (
      settled ||
      message?.type !== "here" ||
      message.serverId !== serverId ||
      message.nonce !== nonce
    ) {
      return;
    }
    const baseUrl = endpointFromDiscovery(remote.address, message);
    candidates.set(baseUrl, {
      baseUrl,
      address: remote.address,
      transport: message.transport,
      port: message.port
    });
  });
  socket.on("error", (error) => finish(error));
  socket.on("listening", () => {
    try {
      socket.setMulticastTTL(1);
      if (interfaceAddress) socket.setMulticastInterface(interfaceAddress);
    } catch (error) {
      finish(asError(error));
      return;
    }
    if (broadcastAddress) {
      try {
        socket.setBroadcast(true);
      } catch {
        broadcastAddress = undefined;
      }
    }
    sendQuery();
    timers.push(deps.setTimeout(sendQuery, 750));
    timers.push(deps.setTimeout(sendQuery, 1500));
    timers.push(deps.setTimeout(() => finish(), 3000));
  });
  try {
    socket.bind(0);
  } catch (error) {
    finish(asError(error));
  }

  return { result, cancel: () => finish() };
}

export class LanDiscoveryResponder {
  private socket: LanDiscoverySocket | null = null;
  private readonly repliesByAddress = new Map<string, number[]>();

  constructor(
    private readonly endpoint: {
      serverId: string;
      transport: "http" | "https";
      port: number;
      interfaceAddress?: string;
    },
    private readonly dependencies: LanDiscoveryDependencies = {}
  ) {}

  start(): Promise<void> {
    if (this.socket) return Promise.resolve();
    const deps = resolvedDependencies(this.dependencies);
    const socket = deps.createSocket();
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      let started = false;
      socket.on("error", (error) => {
        if (!started) {
          this.stop();
          reject(error);
        }
      });
      socket.on("message", (data, remote) => {
        const message = parseLanDiscoveryMessage(data);
        if (message?.type !== "discover" || message.serverId !== this.endpoint.serverId) return;
        if (!this.allowReply(remote.address, deps.now())) return;
        const response = encodeLanDiscoveryResponse(
          this.endpoint.serverId,
          message.nonce,
          this.endpoint.transport,
          this.endpoint.port
        );
        try {
          socket.send(response, remote.port, remote.address);
        } catch {
          // A later query can retry.
        }
      });
      socket.on("listening", () => {
        try {
          socket.addMembership(LAN_DISCOVERY_GROUP, this.endpoint.interfaceAddress);
          started = true;
          resolve();
        } catch (error) {
          this.stop();
          reject(asError(error));
        }
      });
      try {
        socket.bind(LAN_DISCOVERY_PORT);
      } catch (error) {
        this.stop();
        reject(asError(error));
      }
    });
  }

  stop(): void {
    const socket = this.socket;
    this.socket = null;
    this.repliesByAddress.clear();
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }

  private allowReply(address: string, now: number): boolean {
    const recent = (this.repliesByAddress.get(address) ?? []).filter((sentAt) => now - sentAt <= 5000);
    if (recent.length >= 5) {
      this.repliesByAddress.set(address, recent);
      return false;
    }
    recent.push(now);
    this.repliesByAddress.set(address, recent);
    return true;
  }
}

type LanDiscoveryInterfaceDependencies = {
  resolveRouteInterface?: (target: string) => Promise<string | undefined>;
};

export async function resolveLanDiscoveryInterface(
  baseUrl: string,
  dependencies: LanDiscoveryInterfaceDependencies = {}
): Promise<string | undefined> {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.replace(/^\[|]$/g, "");
  } catch {
    return undefined;
  }
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return hostname;
  return (dependencies.resolveRouteInterface ?? resolveRouteInterface)(LAN_DISCOVERY_GROUP);
}

export async function resolveLanDiscoveryClientInterface(baseUrl: string): Promise<string | undefined> {
  const target = await resolveLanDiscoveryInterface(baseUrl);
  if (!target) return undefined;
  return resolveRouteInterface(target);
}

async function resolveRouteInterface(target: string): Promise<string | undefined> {
  const socket = nodeCreateSocket("udp4");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (address?: string) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // The socket may already be closed.
      }
      resolve(address);
    };
    socket.once("error", () => finish());
    try {
      socket.connect(9, target, () => {
        const address = socket.address().address;
        finish(address === "0.0.0.0" ? undefined : address);
      });
    } catch {
      finish();
    }
  });
}

function resolvedDependencies(dependencies: LanDiscoveryDependencies): Required<LanDiscoveryDependencies> {
  return {
    createSocket: dependencies.createSocket ?? (() => nodeCreateSocket({ type: "udp4", reuseAddr: true }) as LanDiscoverySocket),
    randomBytes: dependencies.randomBytes ?? (() => nodeRandomBytes(16)),
    setTimeout: dependencies.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
    clearTimeout: dependencies.clearTimeout ?? ((handle) => clearTimeout(handle)),
    now: dependencies.now ?? Date.now,
    getBroadcastAddress: dependencies.getBroadcastAddress ?? findDirectedBroadcastAddress
  };
}

function findDirectedBroadcastAddress(interfaceAddress?: string): string | undefined {
  if (!interfaceAddress) return undefined;
  for (const entries of Object.values(nodeNetworkInterfaces())) {
    const entry = entries?.find((candidate) =>
      candidate.address === interfaceAddress && candidate.family === "IPv4"
    );
    if (entry) return directedBroadcastAddress(entry.address, entry.netmask);
  }
  return undefined;
}

function directedBroadcastAddress(address: string, netmask: string): string | undefined {
  const addressParts = address.split(".").map(Number);
  const maskParts = netmask.split(".").map(Number);
  if (addressParts.length !== 4 || maskParts.length !== 4) return undefined;
  if ([...addressParts, ...maskParts].some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined;
  }
  return addressParts.map((part, index) => part | (~maskParts[index]! & 255)).join(".");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
