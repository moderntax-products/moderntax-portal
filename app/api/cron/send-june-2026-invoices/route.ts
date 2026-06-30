/**
 * One-shot June 2026 invoice send — Centerstone + California Statewide CDC.
 *
 * Matt (2026-06-29): send June invoices to MANAGERS + AP at 7pm PT on Jun 30,
 * accounting for the full billing cycle. Fires at 02:00 UTC Jul 1 (= 7pm PDT
 * Jun 30). The recurring monthly-client-invoices + auto-invoice crons defer
 * these two clients for June 2026 (see their guards), so this is the single
 * source of the June send — no double-billing.
 *
 * Reuses issueMonthlyInvoice() (the tested compute -> Mercury invoice ->
 * breakdown email path), with a recipient override = managers + AP, cc matt@.
 * Idempotent: issueMonthlyInvoice skips if INV-2026-06-* already exists.
 *
 * GET /api/cron/send-june-2026-invoices — Auth: Vercel cron Bearer secret.
 *   ?dry=1   resolve + report recipients, send nothing
 *   ?force=1 run regardless of the date guard
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { issueMonthlyInvoice } from '@/app/api/cron/monthly-client-invoices/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const TARGET_DATE_UTC = '2026-07-01'; // 02:00 UTC == 7pm PDT Jun 30
const PERIOD_START = '2026-06-01';
const PERIOD_END = '2026-06-30';
const CC = ['matt@moderntax.io'];
const TARGETS = [
  { id: '60f80d60-03ad-42d7-95da-c0f1cd311523', name: 'Centerstone' },
  { id: '3256293c-6c98-42bc-a828-2b73a603048e', name: 'California Statewide CDC' },
];

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const force = request.nextUrl.searchParams.get('force') === '1';
  const dry = request.nextUrl.searchParams.get('dry') === '1';
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (!force && todayUtc !== TARGET_DATE_UTC) {
    return NextResponse.json({ skipped: true, reason: `Today (${todayUtc}) is not the target ${TARGET_DATE_UTC} (7pm PT Jun 30). One-shot; pass ?force=1 to override.` });
  }

  const admin = createAdminClient();
  const log: string[] = [];
  const results: any[] = [];

  for (const t of TARGETS) {
    const { data: client } = await admin.from('clients')
      .select('billing_ap_email, billing_ap_email_cc').eq('id', t.id).single() as { data: any };
    const { data: mgrs } = await admin.from('profiles')
      .select('email').eq('client_id', t.id).eq('role', 'manager') as { data: { email: string }[] | null };

    // Recipients = managers + AP contacts (deduped), cc matt@.
    const to = [...new Set([
      ...(mgrs || []).map((m) => (m.email || '').trim().toLowerCase()),
      (client?.billing_ap_email || '').trim().toLowerCase(),
      ...((client?.billing_ap_email_cc || []) as string[]).map((e) => (e || '').trim().toLowerCase()),
    ].filter(Boolean))];

    if (dry) { results.push({ client: t.name, dry: true, to, cc: CC }); continue; }

    try {
      const r = await issueMonthlyInvoice(admin, t.id, PERIOD_START, PERIOD_END, log, { to, cc: CC });
      results.push({ client: t.name, recipients: to, ...(r || { note: 'nothing to bill / already issued' }) });
    } catch (e: any) {
      results.push({ client: t.name, error: e?.message });
    }
  }

  // Q3 transition (after June is billed at the standard rate): California
  // Statewide CDC prepaid Q3 at a locked $71.91/entity (QT-CALI-Q3-0003). Flip
  // their PDF rate now so any Q3 overage beyond the prepaid pool bills at the
  // locked rate. Q3 pool drawdown itself uses clients.credit_rate ($71.91),
  // already set. Idempotent. (Revert to $79.98 at Q4 / renewal.)
  let q3RateFlip: string | null = null;
  if (!dry) {
    const CDC = '3256293c-6c98-42bc-a828-2b73a603048e';
    const { error } = await admin.from('clients').update({ billing_rate_pdf: 71.91 }).eq('id', CDC);
    q3RateFlip = error ? `failed: ${error.message}` : 'CDC billing_rate_pdf -> $71.91 (Q3 locked overage rate)';
    log.push(`[q3-rate] ${q3RateFlip}`);
  }

  if (log.length) console.log('[send-june-2026-invoices]\n' + log.join('\n'));
  return NextResponse.json({ success: true, mode: dry ? 'dry' : 'live', date_utc: todayUtc, results, q3RateFlip });
}
