/**
 * POST /api/admin/recalc-centerstone-may-r2
 *
 * Second reissue of the Centerstone May invoice — this time INCLUDING
 * monitoring fees + self-signed 8821 surcharge on the Mercury invoice
 * (rather than bifurcating monitoring to Stripe). Per Matt 2026-05-27
 * after Mathew's reconciliation pushback was addressed in R1:
 * "invoice needs to include all monitoring fees etc."
 *
 * Net effect: single unified Mercury invoice that Centerstone's AP can
 * process in one transaction. No Stripe-side monitoring charge — the
 * monitoring is captured here on Mercury.
 *
 * What this does:
 *   1. Cancel R1 Mercury invoice (INV-2026-05-CENT-R1, $1,379.54)
 *   2. Create R2 with three explicit line items:
 *        - IRS Transcript Verification: 23 × $59.98 = $1,379.54
 *        - Account Monitoring (prorated): ~$192.74
 *        - Self-signed 8821 surcharge: 14 × $10 = $140.00
 *      Total: ~$1,712.28
 *   3. Update local invoices row to mirror the new totals
 *   4. Reset breakdown_sent_at so the full breakdown (no
 *      verificationOnly flag) refires and matches Mercury exactly
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import {
  createMercuryInvoice,
  getDestinationAccountId,
  getMercuryPayUrl,
  getMercuryInvoicePdfUrl,
} from '@/lib/mercury';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CENTERSTONE_CLIENT_ID  = '60f80d60-03ad-42d7-95da-c0f1cd311523';
const CENTERSTONE_INVOICE_ID = '2050bc3d-b99b-4f06-8ec8-ebd45da93894';
const PERIOD_START = '2026-05-01';
const PERIOD_END   = '2026-05-31';

export async function POST(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;
  try { return await handle(); }
  catch (err: any) {
    console.error('[recalc-centerstone-may-r2]', err);
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 });
  }
}

async function handle() {
  const admin = createAdminClient();
  const log: string[] = [];
  const L = (s: string) => { console.log(`[r2] ${s}`); log.push(s); };

  // ---- Pull current state ----
  const { data: client } = await admin.from('clients')
    .select('billing_rate_pdf, billing_rate_monitoring, billing_net_days, mercury_customer_id, billing_ap_email_cc')
    .eq('id', CENTERSTONE_CLIENT_ID).single() as { data: any };
  const ratePdf = client.billing_rate_pdf || 59.98;
  const monthlyMonitoringRate = client.billing_rate_monitoring || 25;

  const { data: currentInv } = await admin.from('invoices')
    .select('mercury_invoice_id, invoice_number')
    .eq('id', CENTERSTONE_INVOICE_ID).single() as { data: any };
  const oldMercuryId = currentInv?.mercury_invoice_id;
  L(`Current local invoice: ${currentInv?.invoice_number} (mercury_id=${oldMercuryId})`);

  // ---- Compute line item totals ----
  // 1. Verification: completed entities × flat rate
  const { data: completed } = await admin.from('request_entities')
    .select('id, signature_id, requests!inner(client_id)')
    .eq('status', 'completed').eq('requests.client_id', CENTERSTONE_CLIENT_ID)
    .gte('completed_at', `${PERIOD_START}T00:00:00Z`)
    .lte('completed_at', `${PERIOD_END}T23:59:59.999Z`) as { data: any[] };
  const completedCount = completed?.length || 0;
  const verificationTotal = Math.round(completedCount * ratePdf * 100) / 100;
  L(`Verification: ${completedCount} × $${ratePdf} = $${verificationTotal}`);

  // 2. Self-signed 8821 surcharge: $10 per entity with a signature_id
  //    (i.e., e-signed via our Dropbox Sign flow vs externally signed PDF upload)
  const selfSignedCount = (completed || []).filter((e: any) => e.signature_id).length;
  const selfSignedTotal = Math.round(selfSignedCount * 10 * 100) / 100;
  L(`Self-signed 8821 surcharge: ${selfSignedCount} × $10 = $${selfSignedTotal}`);

  // 3. Monitoring: prorated over May for active enrollments (matches
  //    finalize-may-invoices.ts logic — excludes enrolled-and-cancelled
  //    within the period to avoid the bulk-enroll-mistake artifacts)
  const { data: monitoring } = await admin.from('entity_monitoring')
    .select('id, status, enrolled_at, cancelled_at')
    .eq('client_id', CENTERSTONE_CLIENT_ID)
    .in('status', ['active', 'paused', 'cancelled'])
    .lte('enrolled_at', `${PERIOD_END}T23:59:59.999Z`)
    .or(`cancelled_at.is.null,cancelled_at.gte.${PERIOD_START}`) as { data: any[] };

  const periodStartMs = new Date(`${PERIOD_START}T00:00:00Z`).getTime();
  const periodEndMs   = new Date(`${PERIOD_END}T23:59:59.999Z`).getTime() + 1;
  const daysInMay = 31;
  let monitoringTotal = 0;
  let monitoringCount = 0;
  for (const m of (monitoring || [])) {
    if (m.status === 'pending') continue;
    const enrolledMs = new Date(m.enrolled_at).getTime();
    const cancelledMs = m.cancelled_at ? new Date(m.cancelled_at).getTime() : Infinity;
    if (enrolledMs >= periodStartMs && cancelledMs <= periodEndMs) continue;
    const ws = Math.max(enrolledMs, periodStartMs);
    const we = Math.min(cancelledMs, periodEndMs);
    if (we <= ws) continue;
    const activeDays = Math.ceil((we - ws) / 86400000);
    monitoringTotal += (Math.min(activeDays, daysInMay) / daysInMay) * monthlyMonitoringRate;
    monitoringCount += 1;
  }
  monitoringTotal = Math.round(monitoringTotal * 100) / 100;
  L(`Monitoring: ${monitoringCount} entities (prorated) = $${monitoringTotal}`);

  const grandTotal = Math.round((verificationTotal + selfSignedTotal + monitoringTotal) * 100) / 100;
  L(`GRAND TOTAL: $${grandTotal}`);

  // ---- Cancel R1 ----
  const mercuryKey = process.env.MERCURY_API_KEY;
  if (!mercuryKey) return NextResponse.json({ error: 'MERCURY_API_KEY missing', log }, { status: 500 });
  if (oldMercuryId) {
    const r = await fetch(`https://api.mercury.com/api/v1/ar/invoices/${oldMercuryId}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${mercuryKey}`, 'Content-Type': 'application/json' },
    });
    L(r.ok ? `✓ Cancelled R1 Mercury invoice ${oldMercuryId}` : `! Cancel returned ${r.status} (may need manual cancel)`);
  }

  // ---- Create R2 with all line items ----
  const invoiceDate = new Date().toISOString().split('T')[0];
  const dueDateObj = new Date(invoiceDate);
  dueDateObj.setUTCDate(dueDateObj.getUTCDate() + (client.billing_net_days ?? 5));
  const dueDate = dueDateObj.toISOString().split('T')[0];
  const newInvoiceNumber = 'INV-2026-05-CENT-R2';

  const lineItems: Array<{ name: string; unitPrice: number; quantity: number }> = [];
  if (completedCount > 0) {
    lineItems.push({
      name: `IRS Transcript Verification — May 2026 (${completedCount} completed verifications)`,
      unitPrice: ratePdf,
      quantity: completedCount,
    });
  }
  if (selfSignedCount > 0) {
    lineItems.push({
      name: `Self-signed 8821 Surcharge (e-signature via Dropbox Sign)`,
      unitPrice: 10,
      quantity: selfSignedCount,
    });
  }
  if (monitoringCount > 0) {
    lineItems.push({
      name: `Account Monitoring — May 2026 (${monitoringCount} entit${monitoringCount === 1 ? 'y' : 'ies'} prorated)`,
      unitPrice: monitoringCount === 0 ? 0 : Math.round((monitoringTotal / monitoringCount) * 100) / 100,
      quantity: monitoringCount,
    });
  }

  const newMercury = await createMercuryInvoice({
    customerId: client.mercury_customer_id,
    destinationAccountId: getDestinationAccountId(),
    dueDate,
    invoiceDate,
    invoiceNumber: newInvoiceNumber,
    lineItems,
    ccEmails: client.billing_ap_email_cc || [],
    creditCardEnabled: false,
    achDebitEnabled: true,
    useRealAccountNumber: false,
    sendEmailOption: 'SendNow',
    servicePeriodStartDate: PERIOD_START,
    servicePeriodEndDate: PERIOD_END,
    payerMemo: `Reference: ${newInvoiceNumber}. Replaces INV-2026-05-CENT-R1. Net ${client.billing_net_days ?? 5}.`,
    internalNote: `R2 reissue. Includes verification + self-signed 8821 surcharge + monitoring (unified on Mercury, not split with Stripe).`,
  });
  L(`✓ Created R2 Mercury invoice ${newMercury.id} (slug=${newMercury.slug}) at $${grandTotal}`);

  // ---- Update local invoice row ----
  const payUrl = getMercuryPayUrl(newMercury.slug);
  const pdfUrl = getMercuryInvoicePdfUrl(newMercury.slug);
  await (admin.from('invoices') as any).update({
    invoice_number: newInvoiceNumber,
    total_entities: completedCount,
    total_amount: grandTotal,
    monitoring_entities: monitoringCount,
    monitoring_amount: monitoringTotal,
    mercury_invoice_id: newMercury.id,
    mercury_invoice_slug: newMercury.slug,
    mercury_pay_url: payUrl,
    mercury_pdf_url: pdfUrl,
    mercury_reference: newMercury.invoiceNumber,
    breakdown_sent_at: null,
    notes: `R2 reissue 2026-05-27. Was R1 verification-only at $1,379.54; updated to $${grandTotal} including monitoring ($${monitoringTotal}) + self-signed 8821 surcharge ($${selfSignedTotal}). Unified on Mercury — no separate Stripe monitoring charge.`,
    sent_at: new Date().toISOString(),
  }).eq('id', CENTERSTONE_INVOICE_ID);
  L(`✓ Updated local invoices row + reset breakdown_sent_at`);

  return NextResponse.json({
    success: true,
    new_invoice_number: newInvoiceNumber,
    new_total: grandTotal,
    line_items: {
      verification: { count: completedCount, rate: ratePdf, total: verificationTotal },
      self_signed_8821: { count: selfSignedCount, rate: 10, total: selfSignedTotal },
      monitoring: { count: monitoringCount, total: monitoringTotal },
    },
    new_mercury_id: newMercury.id,
    new_pay_url: payUrl,
    log,
  });
}
