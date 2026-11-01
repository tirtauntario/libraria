/** In-memory token buckets keyed by client IP. Good enough for one process. */
import type { RequestHandler } from 'express';
import type { BucketConfig } from './config';
import { HttpError } from './errors';

interface Bucket {
  tokens: number;
  last: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly config: BucketConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one token. Returns 0 when allowed, else seconds until the next token. */
  take(key: string): number {
    const t = this.now();
    const { capacity, refillPerSecond } = this.config;
    const b = this.buckets.get(key) ?? { tokens: capacity, last: t };
    b.tokens = Math.min(capacity, b.tokens + ((t - b.last) / 1000) * refillPerSecond);
    b.last = t;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / refillPerSecond);
  }

  /** Drops buckets that have refilled completely. */
  prune(): void {
    const t = this.now();
    const { capacity, refillPerSecond } = this.config;
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((t - b.last) / 1000) * refillPerSecond >= capacity) this.buckets.delete(key);
    }
  }

  middleware(when: (req: Parameters<RequestHandler>[0]) => boolean = () => true): RequestHandler {
    return (req, _res, next) => {
      if (!when(req)) return next();
      const wait = this.take(req.ip ?? 'unknown');
      if (wait > 0) {
        return next(new HttpError(429, 'rate_limited', 'Too many requests, slow down', {}, { 'Retry-After': String(wait) }));
      }
      next();
    };
  }
}
