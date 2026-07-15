import { beforeEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient } from "./apiClient.js";
import {
  LanShareReachabilityMonitor,
  lanSharePresentation,
  probeLanShareTarget,
  type LanShareProbeTarget
} from "./lanShareReachability.js";

const apiMocks = vi.hoisted(() => ({
  testConnection: vi.fn()
}));

vi.mock("./apiClient.js", () => ({
  RelayApiClient: vi.fn(function RelayApiClientMock() {
    return { testConnection: apiMocks.testConnection };
  })
}));

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.testConnection.mockResolvedValue({ ok: true, version: "test" });
});

describe("probeLanShareTarget", () => {
  it("uses a credentialless client for plain HTTP", async () => {
    await probeLanShareTarget({ baseUrl: "http://192.168.12.21:8787" });

    expect(RelayApiClient).toHaveBeenCalledWith(
      "http://192.168.12.21:8787",
      undefined,
      undefined,
      undefined
    );
    expect(apiMocks.testConnection).toHaveBeenCalledOnce();
  });

  it("uses the same credentialless seam with pinned HTTPS", async () => {
    const pin = {
      tlsName: "srv_test.vault-rooms.internal",
      identityCertificateDer: "certificate",
      pinnedIdentitySpkiSha256: "fingerprint"
    };

    await probeLanShareTarget({ baseUrl: "https://192.168.12.21:8788", pin });

    expect(RelayApiClient).toHaveBeenCalledWith(
      "https://192.168.12.21:8788",
      undefined,
      undefined,
      pin
    );
    expect(apiMocks.testConnection).toHaveBeenCalledOnce();
  });
});

describe("LanShareReachabilityMonitor", () => {
  it("ignores a late result from the previous LAN URL", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const probe = vi
      .fn<(target: LanShareProbeTarget) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onChange = vi.fn();
    const monitor = new LanShareReachabilityMonitor(probe, onChange);

    monitor.check({ baseUrl: "http://192.168.1.49:8787" });
    monitor.check({ baseUrl: "http://192.168.12.21:8787" });
    second.resolve();
    await vi.waitFor(() => expect(monitor.getState()).toMatchObject({ status: "reachable" }));
    first.resolve();
    await first.promise;

    expect(monitor.getState()).toMatchObject({
      key: expect.stringContaining("192.168.12.21"),
      status: "reachable"
    });
    expect(onChange).toHaveBeenCalled();
  });

  it("turns a failed required probe into an actionable unreachable state", async () => {
    const monitor = new LanShareReachabilityMonitor(
      vi.fn().mockRejectedValue(new Error("net::ERR_ADDRESS_UNREACHABLE")),
      vi.fn()
    );

    await expect(monitor.require({ baseUrl: "http://192.168.1.49:8787" })).rejects.toThrow(
      "LAN share URL is unreachable"
    );
    expect(monitor.getState()).toMatchObject({
      status: "unreachable",
      error: expect.stringContaining("net::ERR_ADDRESS_UNREACHABLE")
    });
  });

  it("deduplicates a checked target by URL and full pin unless forced", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    const monitor = new LanShareReachabilityMonitor(probe, vi.fn());
    const target = pinnedTarget("fingerprint-a");

    monitor.check(target);
    await vi.waitFor(() => expect(monitor.getState()).toMatchObject({ status: "reachable" }));
    monitor.check(target);
    monitor.check(target, true);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));

    monitor.check(pinnedTarget("fingerprint-b"));
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(3));
  });

  it("keeps missing targets unavailable and explains how to configure one", async () => {
    const probe = vi.fn();
    const monitor = new LanShareReachabilityMonitor(probe, vi.fn());

    monitor.check(undefined);

    expect(monitor.getState()).toEqual({ status: "unavailable" });
    await expect(monitor.require(undefined)).rejects.toThrow("Public URL override");
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("lanSharePresentation", () => {
  it("renders a reachable LAN endpoint separately from local sync", () => {
    expect(lanSharePresentation({ key: "k", baseUrl: "http://lan", status: "reachable" })).toEqual({
      label: "LAN share: reachable from this device",
      className: "is-running"
    });
  });

  it("renders an unreachable LAN endpoint as stopped", () => {
    expect(
      lanSharePresentation({ key: "k", baseUrl: "http://bad", status: "unreachable", error: "offline" })
    ).toMatchObject({
      label: "LAN share: unreachable",
      className: "is-stopped"
    });
  });
});

function pinnedTarget(fingerprint: string): LanShareProbeTarget {
  return {
    baseUrl: "https://192.168.12.21:8788",
    pin: {
      tlsName: "srv_test.vault-rooms.internal",
      identityCertificateDer: "certificate",
      pinnedIdentitySpkiSha256: fingerprint
    }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
