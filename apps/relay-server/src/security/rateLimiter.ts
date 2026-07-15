type WindowCounter = {
  count: number;
  windowStart: number;
};

export class FixedWindowRateLimiter {
  private readonly counters = new Map<string, WindowCounter>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly maxTrackedKeys = 10_000,
    private readonly now: () => number = Date.now
  ) {}

  consume(key: string): boolean {
    const now = this.now();
    this.pruneExpired(now);
    const counter = this.counters.get(key);
    if (!counter) {
      if (this.counters.size >= this.maxTrackedKeys) {
        const oldest = this.counters.keys().next();
        if (!oldest.done) {
          this.counters.delete(oldest.value);
        }
      }
      this.counters.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (counter.count >= this.maxRequests) {
      return false;
    }

    counter.count += 1;
    return true;
  }

  private pruneExpired(now: number): void {
    for (const [key, counter] of this.counters) {
      if (now - counter.windowStart < this.windowMs) {
        break;
      }
      this.counters.delete(key);
    }
  }
}
