import { ConnectorError } from "./errors.js";

export interface RateLimiter {
  /** Throws ConnectorError with code `rate_limit` when the call must not proceed. */
  acquire(cost?: number): void;
}

/**
 * Sliding window. `blockedFor` does not consume a slot.
 * `acquire` checks, then commits only when the call proceeds.
 */
export class SlidingWindowLimiter implements RateLimiter {
  private hits: number[] = [];

  constructor(
    readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ConnectorError("config", "Rate limit must be a positive integer.");
    }
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new ConnectorError("config", "Rate limit window must be a positive integer.");
    }
  }

  blockedFor(): number | null {
    const now = this.now();
    this.prune(now);
    if (this.hits.length < this.limit) return null;
    const oldest = this.hits[0];
    if (oldest === undefined) return null;
    return Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000));
  }

  acquire(cost = 1): void {
    if (!Number.isInteger(cost) || cost < 1) {
      throw new ConnectorError("config", "Rate limit cost must be a positive integer.");
    }
    const seconds = Math.round(this.windowMs / 1000);
    if (cost > this.limit) {
      throw new ConnectorError(
        "rate_limit",
        `Request costs ${cost} transactions, above the local window of ${this.limit} per ${seconds}s.`,
        null,
      );
    }
    const now = this.now();
    this.prune(now);
    if (this.hits.length + cost > this.limit) {
      const oldest = this.hits[0];
      const wait =
        oldest === undefined
          ? 1
          : Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000));
      throw new ConnectorError(
        "rate_limit",
        `Local rate limit reached (${this.limit} per ${seconds}s, this call needs ${cost}). Retry in ~${wait}s. Cached results are still served.`,
        wait,
      );
    }
    for (let index = 0; index < cost; index += 1) this.hits.push(now);
  }

  private prune(now: number): void {
    this.hits = this.hits.filter((hit) => now - hit < this.windowMs);
  }
}

/** UTC calendar-day counter. Resets when the UTC date changes. */
export class DayWindow implements RateLimiter {
  private stamp = "";
  private count = 0;

  constructor(
    readonly limit: number,
    private readonly now: () => number,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ConnectorError("config", "Daily limit must be a positive integer.");
    }
  }

  private roll(): void {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.stamp) {
      this.stamp = day;
      this.count = 0;
    }
  }

  blocked(): boolean {
    this.roll();
    return this.count >= this.limit;
  }

  acquire(cost = 1): void {
    if (!Number.isInteger(cost) || cost < 1) {
      throw new ConnectorError("config", "Rate limit cost must be a positive integer.");
    }
    this.roll();
    if (cost > this.limit || this.count + cost > this.limit) {
      throw new ConnectorError(
        "rate_limit",
        `Daily request budget exhausted (${this.limit}/day, this call needs ${cost}). Resets at 00:00 UTC. Cached results are still served.`,
        null,
      );
    }
    this.count += cost;
  }
}
