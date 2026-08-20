import { afterEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { RelayApiClient, requestUrlWithTimeout } from "./apiClient.js";
import { pinnedRequest, type PinnedServerInfo } from "./pinnedTransport.js";

vi.mock("./pinnedTransport.js", () => ({
  pinnedRequest: vi.fn(),
  pinnedRawRequest: vi.fn()
}));

vi.stubGlobal("window", { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout });

describe("RelayApiClient.request", () => {
  afterEach(() => {
    vi.mocked(requestUrl).mockReset();
  });

  it("throws a clean error instead of a raw SyntaxError when the response body is not JSON", async () => {
    // Simulates a network-level proxy, empty response, or truncated body in front of (or from) the
    // relay - response.json() throws a raw SyntaxError for this, which used to bypass
    // onUnauthorized/toRelayError entirely instead of surfacing a clear, actionable error.
    const response = {
      status: 502,
      get json() {
        throw new SyntaxError("Unexpected end of JSON input");
      }
    };
    vi.mocked(requestUrl).mockResolvedValue(response as Awaited<ReturnType<typeof requestUrl>>);

    const onUnauthorized = vi.fn();
    const client = new RelayApiClient("https://relay.example", "token", onUnauthorized);

    await expect(client.listRooms()).rejects.toThrow("Unexpected non-JSON response from relay");
    await expect(client.listRooms()).rejects.not.toBeInstanceOf(SyntaxError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("still parses a valid JSON error envelope and routes UNAUTHORIZED through onUnauthorized", async () => {
    const response = {
      status: 401,
      json: { error: { code: "UNAUTHORIZED", message: "Token no longer valid" } }
    };
    vi.mocked(requestUrl).mockResolvedValue(response as Awaited<ReturnType<typeof requestUrl>>);

    const onUnauthorized = vi.fn();
    const client = new RelayApiClient("https://relay.example", "token", onUnauthorized);

    await expect(client.listRooms()).rejects.toThrow("Token no longer valid");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("returns the parsed JSON body on success", async () => {
    const response = {
      status: 200,
      json: { rooms: [] }
    };
    vi.mocked(requestUrl).mockResolvedValue(response as Awaited<ReturnType<typeof requestUrl>>);

    const client = new RelayApiClient("https://relay.example", "token");
    await expect(client.listRooms()).resolves.toEqual({ rooms: [] });
  });

  it("wraps non-Error requestUrl rejections in an Error", async () => {
    vi.mocked(requestUrl).mockRejectedValue("network failed");

    await expect(requestUrlWithTimeout({ url: "https://relay.example/health", throw: false }, 3_000)).rejects.toThrow("network failed");
    await expect(requestUrlWithTimeout({ url: "https://relay.example/health", throw: false }, 3_000)).rejects.toBeInstanceOf(Error);
  });

  it("reads raw bytes without requiring a JSON response", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    vi.mocked(requestUrl).mockResolvedValue({
      status: 200,
      arrayBuffer: bytes.buffer,
      get json() {
        throw new SyntaxError("not JSON");
      }
    } as Awaited<ReturnType<typeof requestUrl>>);
    const client = new RelayApiClient("https://relay.example", "token");

    await expect(client.readFileRaw("room 1", "image a.bin")).resolves.toEqual(bytes);
  });

  it("uploads the exact ArrayBuffer with the raw content type", async () => {
    vi.mocked(requestUrl).mockResolvedValue({
      status: 200,
      arrayBuffer: new ArrayBuffer(0),
      json: { ok: true, relativePath: "image.bin", version: 1, sha256: "hash" }
    } as Awaited<ReturnType<typeof requestUrl>>);
    const client = new RelayApiClient("https://relay.example", "token");
    const bytes = new Uint8Array([7, 8, 9]);

    await client.writeFileRaw("room", "image.bin", 0, bytes);

    expect(requestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ "content-type": "application/octet-stream" }),
        body: bytes.buffer
      })
    );
  });
});

describe("RelayApiClient pinned material", () => {
  afterEach(() => {
    vi.mocked(requestUrl).mockReset();
    vi.mocked(pinnedRequest).mockReset();
  });

  it("resolves the pinned identity per request, so a rotation applied elsewhere reaches a long-lived client", async () => {
    // The regression this guards: a client that outlives one request (VaultSyncEngine's) snapshotted
    // its pin at construction, so every request after an applied identity rotation kept presenting
    // the superseded certificate and failed the TLS handshake for good.
    const saved: PinnedServerInfo = {
      tlsName: "srv-1.vault-rooms.internal",
      identityCertificateDer: "cert-superseded",
      pinnedIdentitySpkiSha256: "pin-superseded"
    };
    vi.mocked(pinnedRequest).mockResolvedValue({ status: 200, text: "{}", json: { rooms: [] } });
    const client = new RelayApiClient("https://relay.example", "token", undefined, () => saved);

    await client.listRooms();
    expect(vi.mocked(pinnedRequest).mock.calls[0]?.[0]).toMatchObject({ identityCertificateDer: "cert-superseded" });

    saved.identityCertificateDer = "cert-current";
    saved.pinnedIdentitySpkiSha256 = "pin-current";
    await client.listRooms();

    expect(vi.mocked(pinnedRequest).mock.calls[1]?.[0]).toMatchObject({
      identityCertificateDer: "cert-current",
      pinnedIdentitySpkiSha256: "pin-current"
    });
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("routes through requestUrl when the resolver reports no pinned material", async () => {
    // A resolver is always truthy - reading it without calling it would push an unpinned server
    // into the pinned transport with undefined material.
    vi.mocked(requestUrl).mockResolvedValue({ status: 200, json: { rooms: [] } } as Awaited<ReturnType<typeof requestUrl>>);
    const client = new RelayApiClient("https://relay.example", "token", undefined, () => undefined);

    await expect(client.listRooms()).resolves.toEqual({ rooms: [] });
    expect(pinnedRequest).not.toHaveBeenCalled();
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });
});
