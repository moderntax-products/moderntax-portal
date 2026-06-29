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

function getKey(): string {
  return (
    process.env.INTAKE_TOKEN_SECRET ||
    process.env.SENDGRID_API_KEY ||
    'dev-intake-key-do-not-use-in-prod'
  );
}

/** Sign an entityId into an opaque, URL-safe filing-intake token. */
export function signFilingIntakeToken(entityId: string): string {
  const payload = `${entityId}:${PURPOSE}`;
  const mac = createHmac('sha256', getKey()).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${mac}`;
}

/** Verify a token → the entityId it authorizes, or null if invalid/tampered. */
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

  const [entityId, purpose] = payload.split(':');
  if (!entityId || purpose !== PURPOSE) return null;
  return entityId;
}

/** Full public URL for an entity's no-login filing-intake form. */
export function filingIntakeUrl(entityId: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
  return `${appUrl}/intake/${signFilingIntakeToken(entityId)}`;
}
