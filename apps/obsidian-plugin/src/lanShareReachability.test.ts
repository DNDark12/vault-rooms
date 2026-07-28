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

  it("distinguishes an address that can't work from one that's merely unreachable", () => {
    // Worded differently on purpose: this address IS reachable from the host, which is why it used to show
    // green. "Unreachable" would be actively wrong here and send the host looking at their firewall.
    expect(
      lanSharePresentation({ key: "k", baseUrl: "http://127.0.0.1:8787", status: "not-a-lan-address", error: "loopback" })
    ).toMatchObject({
      label: "LAN share: not a LAN address",
      className: "is-stopped"
    });
  });
});

describe("LanShareReachabilityMonitor address validation", () => {
  // The onboarding bug this closes: a loopback override is trivially reachable from the host, so the probe
  // reported success, the badge went green, and the invite was issued - and the failure surfaced on the
  // teammate's machine as "can't connect", the one place they can't diagnose it.
  it("never probes a loopback address, and reports why it can't be used", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    const monitor = new LanShareReachabilityMonitor(probe);

    monitor.check({ baseUrl: "http://127.0.0.1:8787" });

    expect(probe).not.toHaveBeenCalled();
    const state = monitor.getState();
    expect(state.status).toBe("not-a-lan-address");
    expect("error" in state && state.error).toMatch(/computer that's asking/);
  });

  it("blocks invite creation on a loopback address with an actionable message", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    const monitor = new LanShareReachabilityMonitor(probe);

    await expect(monitor.require({ baseUrl: "http://localhost:8787" })).rejects.toThrow(/can't be used by a teammate/i);
    expect(probe).not.toHaveBeenCalled();
  });

  // "Allowed but flagged" has to actually reach the UI. The classifier produced a warning for a
  // self-assigned address, but the monitor dropped it and reported a plain "reachable" - so a link-local
  // setup rendered as an ordinary green badge with nothing said about it.
  it("carries a usable-but-noteworthy address's warning through to the rendered state", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    const monitor = new LanShareReachabilityMonitor(probe);

    await monitor.require({ baseUrl: "http://169.254.10.20:8787" });

    const state = monitor.getState();
    expect(state.status).toBe("reachable");
    expect("warning" in state && state.warning).toMatch(/self-assigned/);
    expect(lanSharePresentation(state)).toMatchObject({ label: "LAN share: reachable, with a caveat" });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("still probes an ordinary private LAN address", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    const monitor = new LanShareReachabilityMonitor(probe);

    await monitor.require({ baseUrl: "http://192.168.1.50:8787" });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(monitor.getState().status).toBe("reachable");
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
