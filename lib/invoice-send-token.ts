/**
 * Signed one-click "send this invoice to the client" links.
 *
 * The monthly-invoice cron generates an invoice as a draft and emails Matt a
 * summary with a signed link per invoice. Clicking it opens a confirm page that
 * actually emails the client + marks the invoice sent. Same stateless HMAC
 * approach as lib/intake-tokens — the token authorizes sending exactly one
 * invoice and carries no PII. Key chain: INTAKE_TOKEN_SECRET → SENDGRID_API_KEY.
 */

import { createHmac, timingSafeEqual } from 'crypto';

const PURPOSE = 'invoice_send';

function getKey(): string {
  return (
    process.env.INTAKE_TOKEN_SECRET ||
    process.env.SENDGRID_API_KEY ||
    'dev-intake-key-do-not-use-in-prod'
  );
}

/** Sign an invoiceId into an opaque, URL-safe send token. */
export function signInvoiceSendToken(invoiceId: string): string {
  const payload = `${invoiceId}:${PURPOSE}`;
  const mac = createHmac('sha256', getKey()).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${mac}`;
}

/** Verify a token → the invoiceId it authorizes, or null if invalid/tampered. */
export function verifyInvoiceSendToken(token: string | null | undefined): string | null {
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

  const [invoiceId, purpose] = payload.split(':');
  if (!invoiceId || purpose !== PURPOSE) return null;
  return invoiceId;
}
