import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LanDiscoveryResponder,
  resolveLanDiscoveryInterface,
  startLanDiscovery,
  type LanDiscoveryDependencies,
  type LanDiscoverySocket
} from "./lanDiscovery.js";
import {
  LAN_DISCOVERY_GROUP,
  LAN_DISCOVERY_PORT,
  encodeLanDiscoveryQuery,
  encodeLanDiscoveryResponse,
  parseLanDiscoveryMessage
} from "./lanDiscoveryProtocol.js";

const nonce = Buffer.alloc(16, 1).toString("base64url");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("manual LAN discovery", () => {
  it("uses an advertised IPv4 address as the multicast interface", async () => {
    await expect(resolveLanDiscoveryInterface("https://192.168.12.16:8788")).resolves.toBe("192.168.12.16");
  });

  it("uses the multicast route instead of a hostname's first resolved interface", async () => {
    await expect(resolveLanDiscoveryInterface("https://host.local:8788", {
      resolveRouteInterface: vi.fn().mockResolvedValue("192.168.12.16")
    })).resolves.toBe("192.168.12.16");
  });

  it("sends three bounded queries and returns only matching deduplicated responses", async () => {
    const socket = new FakeSocket();
    const search = startLanDiscovery("srv_target", "192.168.12.16", deps(socket));
    socket.listen();

    expect(socket.multicastInterface).toBe("192.168.12.16");
    expect(socket.sent).toHaveLength(1);
    expect(parseLanDiscoveryMessage(socket.sent[0]!.data)?.type).toBe("discover");

    socket.message(encodeLanDiscoveryResponse("srv_other", nonce, "https", 8788), "192.168.1.8");
    socket.message(encodeLanDiscoveryResponse("srv_target", nonce, "https", 8788), "192.168.1.9");
    socket.message(encodeLanDiscoveryResponse("srv_target", nonce, "https", 8788), "192.168.1.9");

    await vi.advanceTimersByTimeAsync(750);
    expect(socket.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(750);
    expect(socket.sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1500);

    await expect(search.result).resolves.toEqual([
      { baseUrl: "https://192.168.1.9:8788", address: "192.168.1.9", transport: "https", port: 8788 }
    ]);
    expect(socket.closed).toBe(true);
  });

  it("also queries the selected interface's directed broadcast address", async () => {
    const socket = new FakeSocket();
    const search = startLanDiscovery("srv_target", "192.168.12.16", {
      ...deps(socket),
      getBroadcastAddress: () => "192.168.12.255"
    });
    socket.listen();

    expect(socket.broadcastEnabled).toBe(true);
    expect(socket.sent.map(({ address }) => address)).toEqual([
      LAN_DISCOVERY_GROUP,
      "192.168.12.255"
    ]);

    search.cancel();
    await expect(search.result).resolves.toEqual([]);
  });

  it("keeps multicast discovery when broadcast cannot be enabled", async () => {
    const socket = new FakeSocket();
    socket.broadcastError = new Error("broadcast unavailable");
    const search = startLanDiscovery("srv_target", "192.168.12.16", {
      ...deps(socket),
      getBroadcastAddress: () => "192.168.12.255"
    });
    socket.listen();

    expect(socket.sent.map(({ address }) => address)).toEqual([LAN_DISCOVERY_GROUP]);

    search.cancel();
    await expect(search.result).resolves.toEqual([]);
  });

  it("ignores wrong nonces and closes immediately when cancelled", async () => {
    const socket = new FakeSocket();
    const search = startLanDiscovery("srv_target", undefined, deps(socket));
    socket.listen();
    socket.message(
      encodeLanDiscoveryResponse("srv_target", Buffer.alloc(16, 2).toString("base64url"), "https", 8788),
      "192.168.1.9"
    );

    search.cancel();

    await expect(search.result).resolves.toEqual([]);
    expect(socket.closed).toBe(true);
    await vi.runAllTimersAsync();
    expect(socket.sent).toHaveLength(1);
  });

  it("rejects and closes when the discovery socket fails", async () => {
    const socket = new FakeSocket();
    const search = startLanDiscovery("srv_target", undefined, deps(socket));

    socket.fail(new Error("multicast unavailable"));

    await expect(search.result).rejects.toThrow("multicast unavailable");
    expect(socket.closed).toBe(true);
  });
});

describe("LAN discovery responder", () => {
  it("joins the fixed group and replies only to its exact server ID", async () => {
    const socket = new FakeSocket();
    const responder = new LanDiscoveryResponder(
      { serverId: "srv_target", transport: "https", port: 8788, interfaceAddress: "192.168.12.16" },
      deps(socket)
    );
    const started = responder.start();
    socket.listen();
    await started;

    expect(socket.boundPort).toBe(LAN_DISCOVERY_PORT);
    expect(socket.memberships).toEqual([{ group: LAN_DISCOVERY_GROUP, interfaceAddress: "192.168.12.16" }]);

    socket.message(encodeLanDiscoveryQuery("srv_other", nonce), "192.168.1.8", 50100);
    socket.message(encodeLanDiscoveryQuery("srv_target", nonce), "192.168.1.8", 50100);

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({ port: 50100, address: "192.168.1.8" });
    expect(parseLanDiscoveryMessage(socket.sent[0]!.data)).toMatchObject({
      type: "here", serverId: "srv_target", transport: "https", port: 8788
    });
    responder.stop();
    expect(socket.closed).toBe(true);
  });

  it("limits each source to five replies in five seconds", async () => {
    const socket = new FakeSocket();
    const responder = new LanDiscoveryResponder(
      { serverId: "srv_target", transport: "https", port: 8788 },
      deps(socket)
    );
    const started = responder.start();
    socket.listen();
    await started;

    for (let index = 0; index < 7; index += 1) {
      const queryNonce = Buffer.alloc(16, index + 1).toString("base64url");
      socket.message(encodeLanDiscoveryQuery("srv_target", queryNonce), "192.168.1.8", 50100);
    }
    expect(socket.sent).toHaveLength(5);

    await vi.advanceTimersByTimeAsync(5001);
    socket.message(encodeLanDiscoveryQuery("srv_target", nonce), "192.168.1.8", 50100);
    expect(socket.sent).toHaveLength(6);
  });
});

function deps(socket: FakeSocket): LanDiscoveryDependencies {
  return {
    createSocket: () => socket as LanDiscoverySocket,
    randomBytes: () => Buffer.alloc(16, 1),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    getBroadcastAddress: () => undefined
  };
}

class FakeSocket {
  sent: Array<{ data: Uint8Array; port: number; address: string }> = [];
  memberships: Array<{ group: string; interfaceAddress?: string }> = [];
  closed = false;
  boundPort: number | undefined;
  multicastInterface: string | undefined;
  broadcastEnabled = false;
  broadcastError: Error | undefined;
  private handlers = new Map<string, Array<(...args: never[]) => void>>();

  on(event: string, callback: (...args: never[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback]);
    return this;
  }

  once(event: string, callback: (...args: never[]) => void): this {
    const wrapper = ((...args: never[]) => {
      this.off(event, wrapper);
      callback(...args);
    }) as (...args: never[]) => void;
    return this.on(event, wrapper);
  }

  off(event: string, callback: (...args: never[]) => void): this {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((handler) => handler !== callback));
    return this;
  }

  bind(port = 0): void {
    this.boundPort = port;
  }

  listen(): void {
    this.emit("listening");
  }

  setMulticastTTL(_ttl: number): void {}

  setMulticastInterface(interfaceAddress: string): void {
    this.multicastInterface = interfaceAddress;
  }

  setBroadcast(enabled: boolean): void {
    if (this.broadcastError) throw this.broadcastError;
    this.broadcastEnabled = enabled;
  }

  addMembership(group: string, interfaceAddress?: string): void {
    this.memberships.push({ group, interfaceAddress });
  }

  send(data: Uint8Array, port: number, address: string): void {
    this.sent.push({ data: new Uint8Array(data), port, address });
  }

  close(): void {
    this.closed = true;
  }

  message(data: Uint8Array, address: string, port = LAN_DISCOVERY_PORT): void {
    this.emit("message", data, { address, port });
  }

  fail(error: Error): void {
    this.emit("error", error);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      handler(...(args as never[]));
    }
  }
}
