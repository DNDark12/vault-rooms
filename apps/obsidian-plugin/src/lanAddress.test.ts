import { describe, expect, it } from "vitest";
import { advertisedAddressDrift, classifyLanAddress, hostnameOf } from "./lanAddress.js";

describe("advertisedAddressDrift", () => {
  it("warns when a teammate reached a different address than invites advertise", () => {
    const warning = advertisedAddressDrift("http://192.168.1.50:8787", "192.168.1.77");
    expect(warning).toMatch(/reaching this server at 192\.168\.1\.77/);
    expect(warning).toMatch(/invites advertise 192\.168\.1\.50/);
    expect(warning).toMatch(/update Public URL override/i);
  });

  it("says nothing when they agree, or when there is nothing to compare yet", () => {
    expect(advertisedAddressDrift("http://192.168.1.50:8787", "192.168.1.50")).toBeNull();
    expect(advertisedAddressDrift("http://192.168.1.50:8787", null)).toBeNull();
    expect(advertisedAddressDrift("http://192.168.1.50:8787", undefined)).toBeNull();
    expect(advertisedAddressDrift("http://192.168.1.50:8787", "  ")).toBeNull();
  });

  it("does not nag when one side is a hostname and the other an IP", () => {
    // Both work; a teammate resolving a hostname to the same machine is not drift, and warning here would
    // train the user to ignore the warning.
    expect(advertisedAddressDrift("http://my-mac.local:8787", "192.168.1.50")).toBeNull();
    expect(advertisedAddressDrift("http://192.168.1.50:8787", "my-mac.local")).toBeNull();
  });
});

describe("hostnameOf", () => {
  it("accepts a bare address, host:port, and a full URL", () => {
    expect(hostnameOf("192.168.1.10")).toBe("192.168.1.10");
    expect(hostnameOf("192.168.1.10:8787")).toBe("192.168.1.10");
    expect(hostnameOf("https://192.168.1.10:8788/whatever")).toBe("192.168.1.10");
    expect(hostnameOf("  192.168.1.10  ")).toBe("192.168.1.10");
  });

  it("unwraps bracketed IPv6 and returns empty for junk", () => {
    expect(hostnameOf("[::1]:8787")).toBe("::1");
    expect(hostnameOf("")).toBe("");
    expect(hostnameOf("   ")).toBe("");
  });
});

describe("classifyLanAddress", () => {
  // The reason this module exists: the host-side probe reaches 127.0.0.1 happily, so the badge went green
  // and the invite was issued - and the failure then landed on the teammate's machine as "can't connect",
  // where they could neither see nor fix the cause.
  it("rejects every flavour of loopback, since an invite containing it points teammates at themselves", () => {
    for (const input of ["127.0.0.1", "127.0.0.1:8787", "http://127.0.0.1:8787", "127.1.2.3", "localhost", "LocalHost:8787", "::1", "[::1]:8787", "::ffff:127.0.0.1"]) {
      const verdict = classifyLanAddress(input);
      expect(verdict.class, input).toBe("loopback");
      expect(verdict.usableForTeammates, input).toBe(false);
      expect(verdict.problem, input).toMatch(/computer that's asking/);
    }
  });

  it("accepts ordinary private LAN addresses", () => {
    for (const input of ["192.168.1.100", "10.0.0.5", "172.16.4.9", "172.31.255.254", "192.168.1.100:9000"]) {
      const verdict = classifyLanAddress(input);
      expect(verdict.class, input).toBe("private");
      expect(verdict.usableForTeammates, input).toBe(true);
      expect(verdict.problem, input).toBeUndefined();
    }
  });

  it("does not mistake 172.x outside the private range for a private address", () => {
    // 172.16-31 is private; 172.15 and 172.32 are not. Getting this wrong would either reject a valid
    // setup or accept a wrong one, and both fail confusingly later.
    expect(classifyLanAddress("172.15.0.1").class).toBe("routable");
    expect(classifyLanAddress("172.32.0.1").class).toBe("routable");
  });

  it("rejects the wildcard address, which is not something anyone can connect to", () => {
    const verdict = classifyLanAddress("0.0.0.0");
    expect(verdict.class).toBe("unspecified");
    expect(verdict.usableForTeammates).toBe(false);
    expect(verdict.problem).toMatch(/every interface/);
  });

  it("warns about self-assigned link-local addresses but does not block them", () => {
    // Two machines on one link - a direct cable, or the same Wi-Fi with no DHCP - really can reach each
    // other this way, and that's a legitimate LAN-only setup here. Blocking would refuse an invite for
    // something that works, so this warns instead.
    const verdict = classifyLanAddress("169.254.10.20");
    expect(verdict.class).toBe("link-local");
    expect(verdict.usableForTeammates).toBe(true);
    expect(verdict.problem).toBeUndefined();
    expect(verdict.warning).toMatch(/self-assigned/);
    expect(classifyLanAddress("fe80::1").usableForTeammates).toBe(true);
    expect(classifyLanAddress("fe80::1").warning).toMatch(/same direct link/);
  });

  it("allows a hostname through, leaving it to the reachability probe", () => {
    // Can't be judged without resolving it, and resolving is exactly what the probe does.
    expect(classifyLanAddress("huy-macbook.local").class).toBe("hostname");
    expect(classifyLanAddress("huy-macbook.local").usableForTeammates).toBe(true);
  });

  it("allows a public address rather than second-guessing an unusual network", () => {
    expect(classifyLanAddress("203.0.113.5").class).toBe("routable");
    expect(classifyLanAddress("203.0.113.5").usableForTeammates).toBe(true);
  });

  it("reports invalid input as invalid instead of guessing", () => {
    for (const input of ["", "   ", "not a url at all", "999.1.1.1"]) {
      const verdict = classifyLanAddress(input);
      expect(verdict.usableForTeammates, input).toBe(false);
    }
  });
});
