/**
 * Stateless filing-intake links (2026-06-29).
 *
 * A ModernTax Direct taxpayer can complete their filing-intake form WITHOUT
 * logging in, via a signed token in the URL. Same HMAC approach as
 * lib/unsubscribe-tokens — no new table, no DB round-trip to issue, no replay
 * risk (the entityId is signed). The token only authorizes writing the intake
 * answers to that one entity; it carries no PII.
 *
 * Key chain is INTAKE_TOKEN_SECRET → SENDGRID_API_KEY so a link signed anywhere
 * (local or prod) validates everywhere the same SENDGRID_API_KEY is set.
 */

import { createHmac, timingSafeEqual } from 'crypto';

const PURPOSE = 'filing_intake';
// These tokens gate no-login pages that expose PII (/review, /authorize,
// /intake), so they are time-bounded. 60 days covers the real "email a link,
// taxpayer acts within a few weeks" window while capping the exposure of a
// leaked URL.
const DEFAULT_TTL_DAYS = 60;

let warnedFallback = false;
function getKey(): string {
  const dedicated = process.env.INTAKE_TOKEN_SECRET;
  if (dedicated) return dedicated;
  // Security gap: without a dedicated secret the email-sending key doubles as
  // the auth-token signing key. Warn (once) so ops sets INTAKE_TOKEN_SECRET.
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn('[intake-tokens] INTAKE_TOKEN_SECRET not set — falling back to SENDGRID_API_KEY for token signing. Set a dedicated high-entropy INTAKE_TOKEN_SECRET so the email key is not reused for auth.');
  }
  return process.env.SENDGRID_API_KEY || 'dev-intake-key-do-not-use-in-prod';
}

/**
 * Sign an entityId into an opaque, URL-safe filing-intake token that expires.
 * Pass ttlDays to override the 60-day default (e.g. a shorter window for the
 * most sensitive PII pages).
 */
export function signFilingIntakeToken(entityId: string, ttlDays: number = DEFAULT_TTL_DAYS): string {
  const exp = Math.floor(Date.now() / 1000) + Math.round(ttlDays * 86400);
  const payload = `${entityId}:${PURPOSE}:${exp}`;
  const mac = createHmac('sha256', getKey()).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${mac}`;
}

/** Verify a token → the entityId it authorizes, or null if invalid/tampered/expired. */
export function verifyFilingIntakeToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  let payload: string;
  try { payload = Buffer.from(parts[0], 'base64url').toString('utf8'); } catch { return null; }

  const expected = createHmac('sha256', getKey()).update(payload).digest();
  let provided: Buffer;
  try { provided = Buffer.from(parts[1], 'base64url'); } catch { return null; }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  const [entityId, purpose, expStr] = payload.split(':');
  if (!entityId || purpose !== PURPOSE) return null;
  // Expiry check — v2 tokens carry an epoch; legacy v1 tokens (no 3rd field)
  // still validate so links already in the wild keep working through the
  // transition. New tokens are always bounded.
  if (expStr !== undefined && expStr !== '') {
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  }
  return entityId;
}

/** Full public URL for an entity's no-login filing-intake form. */
export function filingIntakeUrl(entityId: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
  return `${appUrl}/intake/${signFilingIntakeToken(entityId)}`;
}
