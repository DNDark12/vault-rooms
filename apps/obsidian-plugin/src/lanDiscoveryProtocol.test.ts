import { describe, expect, it } from "vitest";
import {
  LAN_DISCOVERY_MAGIC,
  LAN_DISCOVERY_MAX_BYTES,
  LAN_DISCOVERY_PORT,
  encodeLanDiscoveryQuery,
  encodeLanDiscoveryResponse,
  endpointFromDiscovery,
  parseLanDiscoveryMessage
} from "./lanDiscoveryProtocol.js";

const nonce = "abcdefghijklmnopqrstuv";

describe("LAN discovery protocol", () => {
  it("round-trips a bounded query without credentials", () => {
    const encoded = encodeLanDiscoveryQuery("srv_1", nonce);

    expect(encoded.byteLength).toBeLessThanOrEqual(LAN_DISCOVERY_MAX_BYTES);
    expect(parseLanDiscoveryMessage(encoded)).toEqual({
      magic: LAN_DISCOVERY_MAGIC,
      version: 1,
      type: "discover",
      serverId: "srv_1",
      nonce
    });
    expect(Object.keys(JSON.parse(new TextDecoder().decode(encoded)) as object)).toEqual([
      "magic", "version", "type", "serverId", "nonce"
    ]);
  });

  it("round-trips an HTTPS response and derives the endpoint from the packet source", () => {
    const encoded = encodeLanDiscoveryResponse("srv_1", nonce, "https", 8788);
    const parsed = parseLanDiscoveryMessage(encoded);

    expect(parsed).toEqual({
      magic: LAN_DISCOVERY_MAGIC,
      version: 1,
      type: "here",
      serverId: "srv_1",
      nonce,
      transport: "https",
      port: 8788
    });
    expect(parsed?.type === "here" ? endpointFromDiscovery("192.168.12.16", parsed) : null)
      .toBe("https://192.168.12.16:8788");
  });

  it("brackets an IPv6 packet source", () => {
    const parsed = parseLanDiscoveryMessage(encodeLanDiscoveryResponse("srv_1", nonce, "http", 8787));

    expect(parsed?.type === "here" ? endpointFromDiscovery("fe80::1", parsed) : null)
      .toBe("http://[fe80::1]:8787");
  });

  it.each([
    ["oversized", new Uint8Array(LAN_DISCOVERY_MAX_BYTES + 1)],
    ["malformed JSON", new TextEncoder().encode("{")],
    ["wrong magic", message({ magic: "other" })],
    ["wrong version", message({ version: 2 })],
    ["unknown type", message({ type: "enumerate" })],
    ["empty server ID", message({ serverId: "" })],
    ["invalid server ID", message({ serverId: "srv/escape" })],
    ["invalid nonce", message({ nonce: "short" })],
    ["invalid transport", response({ transport: "ws" })],
    ["zero port", response({ port: 0 })],
    ["oversized port", response({ port: 65536 })],
    ["credential field", message({ deviceToken: "secret" })]
  ])("rejects %s packets", (_label, input) => {
    expect(parseLanDiscoveryMessage(input)).toBeNull();
  });

  it("uses a fixed non-relay discovery port", () => {
    expect(LAN_DISCOVERY_PORT).toBe(47878);
  });
});

function message(overrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    magic: LAN_DISCOVERY_MAGIC,
    version: 1,
    type: "discover",
    serverId: "srv_1",
    nonce,
    ...overrides
  }));
}

function response(overrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    magic: LAN_DISCOVERY_MAGIC,
    version: 1,
    type: "here",
    serverId: "srv_1",
    nonce,
    transport: "https",
    port: 8788,
    ...overrides
  }));
}
