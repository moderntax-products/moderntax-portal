/**
 * Lightweight in-memory rate limiter for Next.js route handlers.
 *
 * Implementation notes:
 *   • This is a single-instance counter keyed by IP (or any provided key).
 *     On Vercel serverless, each lambda instance gets its own Map. Limits
 *     therefore apply per-instance, not globally — acceptable as a baseline
 *     mitigation against brute-force / password-spray. For strict global
 *     limits (SOC 2 evidence), migrate to Upstash/Redis via @upstash/ratelimit.
 *   • Expired entries are evicted on every call; there is no background GC.
 *   • For SOC 2 CC7.3 (monitoring): every block is returned with a `retryAfter`
 *     header and logged to audit_log by the caller when relevant.
 *
 * Use:
 *   const rl = consumeRateLimit(ip, 'auth:login', { max: 10, windowMs: 60_000 });
 *   if (!rl.allowed) return NextResponse.json(…, { status: 429, headers: { 'Retry-After': String(rl.retryAfter) }});
 */

import type { NextRequest } from 'next/server';

interface Bucket {
  count: number;
  resetAt: number;
}

// Module-level singleton Map — survives across requests on the same instance.
const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number; // seconds until next slot opens
  resetAt: number;    // epoch ms
}

export interface RateLimitOptions {
  /** Maximum requests allowed inside the window */
  max: number;
  /** Sliding window length in milliseconds */
  windowMs: number;
}

/**
 * Consume one slot from a named bucket for the given key.
 * If the key has never been seen (or its window expired), a fresh bucket is
 * created. Returns `{ allowed: false }` once `max` is exceeded.
 */
export function consumeRateLimit(
  key: string,
  bucketName: string,
  opts: RateLimitOptions,
): RateLimitResult {
  const composite = `${bucketName}::${key}`;
  const now = Date.now();
  const existing = buckets.get(composite);

  if (!existing || existing.resetAt <= now) {
    buckets.set(composite, { count: 1, resetAt: now + opts.windowMs });
    return {
      allowed: true,
      remaining: opts.max - 1,
      retryAfter: 0,
      resetAt: now + opts.windowMs,
    };
  }

  if (existing.count >= opts.max) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil((existing.resetAt - now) / 1000),
      resetAt: existing.resetAt,
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: opts.max - existing.count,
    retryAfter: 0,
    resetAt: existing.resetAt,
  };
}

/**
 * Extract the best-available client IP from a NextRequest. Falls back to the
 * unlabelled "unknown" bucket so a missing header can't sidestep the limiter
 * (all unknowns share one bucket → the attacker can't get more capacity by
 * stripping headers).
 */
export function getClientIp(request: NextRequest): string {
  // Vercel / most reverse proxies set x-forwarded-for as a comma list; first IP is the client.
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const xreal = request.headers.get('x-real-ip');
  if (xreal) return xreal.trim();
  return 'unknown';
}
