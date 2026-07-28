/**
 * Lightweight email deliverability check — format + live MX lookup.
 *
 * Confirms an address is well-formed AND that its domain actually accepts mail
 * (has MX records), which catches typo'd / dead / placeholder domains before we
 * try to send. It is NOT a mailbox probe (no SMTP RCPT) — it validates the
 * domain can receive mail, which is the right bar short of actually sending.
 *
 * Used by the weekly Mercury sync to flag any Direct contact whose email won't
 * deliver, and reusable anywhere a contact email is captured. Matt 2026-07-28.
 */

import { promises as dns } from 'dns';

const FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLACEHOLDER_DOMAINS = new Set([
  'example.com', 'example.org', 'test.com', 'email.com', 'domain.com', 'none.com', 'na.com',
]);

export interface EmailCheck {
  email: string;
  /** True only when format is valid AND the domain has MX records. */
  valid: boolean;
  mxOk: boolean;
  reason: 'ok' | 'invalid_format' | 'placeholder_domain' | 'no_mx' | 'empty';
  checkedAt: string;
}

// Per-process MX cache — domains repeat heavily across a sync run.
const mxCache = new Map<string, boolean>();

export async function validateEmailDeliverable(email: string | null | undefined): Promise<EmailCheck> {
  const checkedAt = new Date().toISOString();
  const e = (email || '').trim();
  if (!e) return { email: e, valid: false, mxOk: false, reason: 'empty', checkedAt };
  if (!FORMAT.test(e)) return { email: e, valid: false, mxOk: false, reason: 'invalid_format', checkedAt };
  const domain = e.split('@')[1].toLowerCase();
  if (PLACEHOLDER_DOMAINS.has(domain)) return { email: e, valid: false, mxOk: false, reason: 'placeholder_domain', checkedAt };

  let mxOk: boolean;
  if (mxCache.has(domain)) {
    mxOk = mxCache.get(domain)!;
  } else {
    try {
      const recs = await dns.resolveMx(domain);
      mxOk = Array.isArray(recs) && recs.length > 0;
    } catch {
      mxOk = false;
    }
    mxCache.set(domain, mxOk);
  }
  return { email: e, valid: mxOk, mxOk, reason: mxOk ? 'ok' : 'no_mx', checkedAt };
}
