import { describe, expect, it } from "vitest";
import { isRestrictedPort } from "./restrictedPorts.js";

describe("isRestrictedPort", () => {
  it("flags well-known Chromium-restricted ports", () => {
    expect(isRestrictedPort(123)).toBe(true); // NTP - what triggered net::ERR_UNSAFE_PORT in practice
    expect(isRestrictedPort(25)).toBe(true); // SMTP
    expect(isRestrictedPort(6667)).toBe(true); // IRC
  });

  it("does not flag the plugin's own default port range", () => {
    for (let port = 8787; port <= 8797; port += 1) {
      expect(isRestrictedPort(port)).toBe(false);
    }
  });

  it("does not flag common unprivileged ports", () => {
    expect(isRestrictedPort(3000)).toBe(false);
    expect(isRestrictedPort(8080)).toBe(false);
  });
});
