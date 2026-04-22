/**
 * Stateless unsubscribe tokens.
 *
 * We don't want to add another table just to track "has this profile clicked
 * unsubscribe?". Instead:
 *
 *   • Sign (profile_id + purpose) with an HMAC keyed on UNSUBSCRIBE_SECRET.
 *   • Put the token in the email's one-click header + footer link.
 *   • When the endpoint receives the token, verify the HMAC, then write an
 *     audit_log entry `action=trial_welcome_unsubscribed` for that profile.
 *   • The drip cron checks audit_log for that event before sending the next
 *     email. No new table, no replay risk (signed), no DB round-trip to issue.
 *
 * If the UNSUBSCRIBE_SECRET env var isn't set, we fall back to BLAND_WEBHOOK_SECRET
 * or SENDGRID_API_KEY as a keying source — not ideal but keeps the system
 * functional in dev. Add UNSUBSCRIBE_SECRET to Vercel env for production.
 */

import { createHmac, timingSafeEqual } from 'crypto';

function getKey(): string {
  return (
    process.env.UNSUBSCRIBE_SECRET ||
    process.env.BLAND_WEBHOOK_SECRET ||
    process.env.SENDGRID_API_KEY ||
    'dev-unsubscribe-key-do-not-use-in-prod'
  );
}

/** Sign a (profileId, purpose) pair into an opaque token that fits in a URL. */
export function signUnsubscribeToken(profileId: string, purpose: string): string {
  const payload = `${profileId}:${purpose}`;
  const mac = createHmac('sha256', getKey()).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${mac}`;
}

/**
 * Verify a token. Returns the decoded { profileId, purpose } when valid,
 * or null if the signature doesn't match.
 */
export function verifyUnsubscribeToken(token: string | null | undefined): { profileId: string; purpose: string } | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, providedMacB64] = parts;

  let payload: string;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expectedMac = createHmac('sha256', getKey()).update(payload).digest();
  let providedMac: Buffer;
  try {
    providedMac = Buffer.from(providedMacB64, 'base64url');
  } catch {
    return null;
  }
  if (providedMac.length !== expectedMac.length) return null;
  if (!timingSafeEqual(providedMac, expectedMac)) return null;

  const [profileId, purpose] = payload.split(':');
  if (!profileId || !purpose) return null;
  return { profileId, purpose };
}
