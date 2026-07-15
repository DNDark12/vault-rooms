import { afterEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { RelayApiClient, requestUrlWithTimeout } from "./apiClient.js";

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
});
