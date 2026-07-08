type WindowCounter = {
  count: number;
  windowStart: number;
};

export class FixedWindowRateLimiter {
  private readonly counters = new Map<string, WindowCounter>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number
  ) {}

  consume(key: string): boolean {
    const now = Date.now();
    const counter = this.counters.get(key);
    if (!counter || now - counter.windowStart >= this.windowMs) {
      this.counters.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (counter.count >= this.maxRequests) {
      return false;
    }

    counter.count += 1;
    return true;
  }
}
