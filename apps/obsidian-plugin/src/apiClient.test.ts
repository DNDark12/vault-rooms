import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient } from "./apiClient.js";

describe("RelayApiClient.request", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws a clean error instead of a raw SyntaxError when the response body is not JSON", async () => {
    // Simulates a network-level proxy, empty response, or truncated body in front of (or from) the
    // relay - response.json() throws a raw SyntaxError for this, which used to bypass
    // onUnauthorized/toRelayError entirely instead of surfacing a clear, actionable error.
    const response = {
      ok: false,
      json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input"))
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const onUnauthorized = vi.fn();
    const client = new RelayApiClient("https://relay.example", "token", onUnauthorized);

    await expect(client.listRooms()).rejects.toThrow("Unexpected non-JSON response from relay");
    await expect(client.listRooms()).rejects.not.toBeInstanceOf(SyntaxError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("still parses a valid JSON error envelope and routes UNAUTHORIZED through onUnauthorized", async () => {
    const response = {
      ok: false,
      json: () => Promise.resolve({ error: { code: "UNAUTHORIZED", message: "Token no longer valid" } })
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const onUnauthorized = vi.fn();
    const client = new RelayApiClient("https://relay.example", "token", onUnauthorized);

    await expect(client.listRooms()).rejects.toThrow("Token no longer valid");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("returns the parsed JSON body on success", async () => {
    const response = {
      ok: true,
      json: () => Promise.resolve({ rooms: [] })
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const client = new RelayApiClient("https://relay.example", "token");
    await expect(client.listRooms()).resolves.toEqual({ rooms: [] });
  });
});
