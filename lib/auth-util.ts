/**
 * Constant-time auth helpers for cron + webhook secrets.
 *
 * The naive `header !== `Bearer ${process.env.SECRET}`` comparison short-
 * circuits on the first mismatched byte, leaking the secret one byte at
 * a time over enough requests. SOC 2 CC6.1 expects authentication
 * comparisons to be constant-time. Use these helpers everywhere we
 * validate a shared secret from a request header.
 *
 * Usage:
 *   import { requireBearer } from '@/lib/auth-util';
 *
 *   const unauthorized = requireBearer(request, process.env.CRON_SECRET);
 *   if (unauthorized) return unauthorized;
 *
 * Returns a NextResponse with 401 on failure, or `null` on success.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';

/**
 * Constant-time string equality. Returns false (not throws) on length
 * mismatch so callers don't accidentally leak length info via different
 * error paths.
 */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  // Different lengths can't match, but compare against a constant-length
  // dummy buffer to keep the timing of the failure path uniform.
  if (a.length !== b.length) {
    // Burn the cycles a real comparison would have taken so attackers
    // can't distinguish "wrong length" from "wrong content" via timing.
    timingSafeEqual(Buffer.from(a), Buffer.from(a));
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Validate an `Authorization: Bearer <secret>` header against an
 * expected secret. Returns a 401 NextResponse on failure, or null on
 * success. Pass the env-var value directly; this handles the missing-
 * secret case (returns 401 — never trust requests when our own secret
 * isn't configured).
 *
 * Casing of the header name is not significant (HTTP headers are case-
 * insensitive); NextRequest.headers.get already normalizes.
 */
export function requireBearer(
  request: NextRequest,
  expectedSecret: string | undefined,
  headerName: string = 'authorization',
): NextResponse | null {
  if (!expectedSecret) {
    // Misconfiguration — never authenticate without a configured secret.
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  const header = request.headers.get(headerName);
  if (!header) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Strip the "Bearer " prefix, then constant-time compare.
  const presented = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (!safeEqual(presented, expectedSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

/**
 * Validate a custom header value (no Bearer prefix) constant-time
 * against the expected secret. Used for `x-bland-secret`,
 * `x-api-key`-style headers where the header value IS the secret.
 */
export function requireHeaderSecret(
  request: NextRequest,
  headerName: string,
  expectedSecret: string | undefined,
): NextResponse | null {
  if (!expectedSecret) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  const presented = request.headers.get(headerName);
  if (!presented) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!safeEqual(presented, expectedSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

/**
 * SHA-256 hex digest. Used to hash partner API keys for storage
 * (never store the plaintext key in DB; store the hash, compare via
 * safeEqual on the hex string).
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
