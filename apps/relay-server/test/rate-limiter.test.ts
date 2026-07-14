import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "../src/security/rateLimiter.js";

describe("FixedWindowRateLimiter key retention", () => {
  it("prunes expired counters when the clock advances", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(1, 100, 10, () => now);

    expect(limiter.consume("expired-a")).toBe(true);
    expect(limiter.consume("expired-b")).toBe(true);

    now = 100;
    expect(limiter.consume("current")).toBe(true);

    expect(counterCount(limiter)).toBe(1);
  });

  it("evicts the oldest counter when distinct active keys reach the cap", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(1, 1_000, 2, () => now);

    expect(limiter.consume("oldest")).toBe(true);
    now = 1;
    expect(limiter.consume("retained")).toBe(true);
    now = 2;
    expect(limiter.consume("newest")).toBe(true);

    expect(counterCount(limiter)).toBe(2);
    expect(limiter.consume("retained")).toBe(false);
    expect(limiter.consume("oldest")).toBe(true);
    expect(counterCount(limiter)).toBe(2);
  });
});

function counterCount(limiter: FixedWindowRateLimiter): number {
  return (limiter as unknown as { counters: Map<string, unknown> }).counters.size;
}
