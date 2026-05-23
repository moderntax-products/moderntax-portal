/**
 * GET /api/cron/send-may-2026-invoices
 *
 * One-shot Vercel cron — fires Saturday 2026-05-23 at 15:00 UTC (8 AM PT)
 * to send the May 2026 invoices for Centerstone + California Statewide CDC.
 *
 * Behavior per client (driven by scripts/send-may-invoices.ts logic):
 *   - Stripe auto-charge for the monitoring portion (off_session against
 *     the saved card on file)
 *   - Mercury invoice for the verification + pre-bill portion (ACH Debit
 *     only — creditCardEnabled=false, useRealAccountNumber=false means
 *     the pay page does NOT show "Accept credit cards" or "Accept ACH
 *     Credit / wire" options)
 *   - Breakdown email to billing_ap_email + CCs
 *
 * Date-guarded: returns skip immediately on any date other than
 * 2026-05-23 so the recurring `0 15 * * 6` cron entry can remain in
 * vercel.json indefinitely without spurious fires.
 *
 * Auth: CRON_SECRET only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { processClient, MAY_2026_TARGETS, type CliFlags } from '@/scripts/send-may-invoices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TARGET_DATE_UTC = '2026-05-23';

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const todayUtc = new Date().toISOString().slice(0, 10);
  if (todayUtc !== TARGET_DATE_UTC) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: `Today (${todayUtc}) is not the target Saturday (${TARGET_DATE_UTC}). Endpoint is one-shot.`,
    });
  }

  const sb = createAdminClient();
  const flags: CliFlags = { dryRun: false, sendEmail: true, clientFilter: null };
  const results = [];
  const errors: any[] = [];

  for (const name of MAY_2026_TARGETS) {
    try {
      const r = await processClient(sb as any, name, flags);
      if (r) results.push({
        client: r.clientName,
        stripe_amount: r.monitoring.amount,
        stripe_pi: r.monitoring.stripePaymentIntent,
        stripe_status: r.monitoring.status,
        mercury_amount: r.mercury.amount,
        mercury_invoice_id: r.mercury.mercuryInvoiceId,
        mercury_pay_url: r.mercury.payUrl,
        mercury_status: r.mercury.status,
        email_sent: r.emailSent,
        errors: r.errors,
      });
    } catch (err: any) {
      errors.push({ client: name, error: err?.message || String(err) });
    }
  }

  const stripeTotal  = results.reduce((s, r) => s + Number(r.stripe_amount || 0), 0);
  const mercuryTotal = results.reduce((s, r) => s + Number(r.mercury_amount || 0), 0);

  return NextResponse.json({
    success: errors.length === 0,
    date_fired: todayUtc,
    stripe_total: Math.round(stripeTotal * 100) / 100,
    mercury_total: Math.round(mercuryTotal * 100) / 100,
    combined_total: Math.round((stripeTotal + mercuryTotal) * 100) / 100,
    results,
    errors,
  });
}
