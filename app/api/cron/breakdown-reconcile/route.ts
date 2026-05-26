/**
 * GET /api/cron/breakdown-reconcile
 *
 * Daily safety-net cron: for every invoice that was sent to Mercury but
 * never got its itemized breakdown PDF emailed to AP recipients, fire
 * the breakdown now.
 *
 * Why this exists (root cause 2026-05-26): customer Centerstone received
 * a $1,619.46 Mercury invoice on May 23 with no breakdown attached. The
 * primary send path in `/api/cron/send-may-2026-invoices` (and by
 * extension the regular `/api/cron/auto-invoice`) calls the breakdown
 * endpoint via HTTP `fetch()`. When that fetch silently fails — 502s,
 * timeouts, network blips — the Mercury invoice goes out alone and the
 * customer (Mathew Paek's words) thinks the invoice "is a mistake".
 *
 * Extracting the 479-line breakdown logic into a shared library to remove
 * the HTTP dependency is a bigger refactor. This cron is the defense-in-
 * depth backstop: whatever failed in the primary path, this catches
 * within 24 hours so no customer ever sees an unattached Mercury invoice
 * for more than a day.
 *
 * Trigger conditions per invoice:
 *   - status = 'sent' (Mercury fired)
 *   - sent_at IS NOT NULL
 *   - breakdown_sent_at IS NULL (the gap)
 *   - mercury_invoice_id IS NOT NULL (real Mercury invoice, not a draft)
 *   - billing_period_start in the last 90 days (sane bound — no zombie
 *     month-old invoices firing breakdowns surprise)
 *
 * Schedule: daily at 13:00 UTC (6 AM PT) — early enough that customers
 * see the breakdown when they sit down for business, late enough that the
 * primary send cron at 15:00 UTC has already attempted its breakdown.
 *
 * Auth: CRON_SECRET only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400 * 1000).toISOString().slice(0, 10);

  // Find every Mercury-sent invoice without a breakdown
  const { data: gap, error } = await admin.from('invoices')
    .select('id, invoice_number, total_amount, sent_at, mercury_invoice_id, clients(name, billing_ap_email)')
    .eq('status', 'sent')
    .not('sent_at', 'is', null)
    .is('breakdown_sent_at', null)
    .not('mercury_invoice_id', 'is', null)
    .gte('billing_period_start', ninetyDaysAgo)
    .order('sent_at', { ascending: true }) as { data: any[] | null; error: any };

  if (error) {
    console.error('[breakdown-reconcile] query failed:', error.message);
    return NextResponse.json({ error: 'Query failed', detail: error.message }, { status: 500 });
  }

  const candidates = gap || [];
  console.log(`[breakdown-reconcile] Found ${candidates.length} invoice(s) needing breakdown send.`);

  const results: Array<{ invoice: string; client: string; sent: boolean; error?: string }> = [];
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
  const cronSecret = process.env.CRON_SECRET || '';

  for (const inv of candidates) {
    const clientName = inv.clients?.name || '(unknown client)';
    if (!inv.clients?.billing_ap_email) {
      console.warn(`[breakdown-reconcile] ${inv.invoice_number}: ${clientName} has no billing_ap_email — skipping`);
      results.push({ invoice: inv.invoice_number, client: clientName, sent: false, error: 'no billing_ap_email on client' });
      continue;
    }

    try {
      // Call the breakdown endpoint. AbortController gives us a real 25s
      // timeout instead of relying on Vercel's silent 60s function ceiling
      // — if Dropbox/PDF rendering hangs, we want to know about it via
      // catch, not by waiting indefinitely.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25_000);
      const res = await fetch(`${appUrl}/api/admin/email-invoice-breakdown?invoiceId=${inv.id}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cronSecret}` },
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const snippet = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200);
        console.error(`[breakdown-reconcile] ${inv.invoice_number}: HTTP ${res.status} — ${snippet}`);
        results.push({ invoice: inv.invoice_number, client: clientName, sent: false, error: `HTTP ${res.status}: ${snippet}` });
        continue;
      }

      // The breakdown endpoint stamps breakdown_sent_at itself on success,
      // so we don't need to here. Double-check anyway in case the endpoint
      // ever changes that behavior.
      const { data: refetch } = await admin.from('invoices')
        .select('breakdown_sent_at').eq('id', inv.id).single() as { data: any };
      if (!refetch?.breakdown_sent_at) {
        await (admin.from('invoices') as any)
          .update({ breakdown_sent_at: new Date().toISOString() })
          .eq('id', inv.id);
      }

      console.log(`[breakdown-reconcile] ✓ ${inv.invoice_number} (${clientName}) — breakdown fired`);
      results.push({ invoice: inv.invoice_number, client: clientName, sent: true });
    } catch (err: any) {
      const msg = err?.name === 'AbortError'
        ? 'timeout after 25s — breakdown endpoint hung'
        : (err?.message || String(err));
      console.error(`[breakdown-reconcile] ${inv.invoice_number}: ${msg}`);
      results.push({ invoice: inv.invoice_number, client: clientName, sent: false, error: msg });
    }
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    found: candidates.length,
    sent: results.filter(r => r.sent).length,
    failed: results.filter(r => !r.sent).length,
    results,
  });
}
