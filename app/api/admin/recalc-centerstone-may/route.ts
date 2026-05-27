/**
 * POST /api/admin/recalc-centerstone-may
 *
 * One-shot reconciliation endpoint to fix the Centerstone May invoice
 * per Mathew Paek's 2026-05-26 contract pushback:
 *   - "Only completed tax transcript transactions should be included"
 *   - Pre-bills on 5 still-pending entities (8821_sent) violate that
 *   - Mercury invoice ($1,619.46) and breakdown PDF ($1,579.56) need
 *     to reconcile to the SAME number
 *
 * What this does:
 *   1. Reverse the pre-bill stamps on the 5 entities (so they bill
 *      normally when they complete in June+)
 *   2. Cancel the current Mercury invoice (Unpaid status so clean cancel)
 *   3. Create a NEW Mercury invoice at the correct amount:
 *      23 completed × $59.98 = $1,379.54
 *      (no pre-bill, no monitoring — monitoring fires via Stripe on 5/28)
 *   4. Update the local invoices row to reflect the new state
 *   5. Stamp breakdown_sent_at=null so the breakdown-reconcile cron
 *      fires a fresh breakdown PDF that matches the new Mercury total
 *
 * Auth: CRON_SECRET (admin-only, irreversible action)
 *
 * Hardcoded to the Centerstone May invoice ID since this is a one-shot
 * fix, not a general-purpose endpoint.
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
const OLD_MERCURY_INVOICE_ID = '1eddf3ea-56b8-11f1-bf6a-71da8309b250';
const PERIOD_START = '2026-05-01';
const PERIOD_END   = '2026-05-31';

export async function POST(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  try {
    return await handle();
  } catch (err: any) {
    console.error('[recalc-centerstone-may]', err);
    return NextResponse.json({
      error: 'Server error during reconciliation',
      detail: err?.message || String(err),
    }, { status: 500 });
  }
}

async function handle() {
  const admin = createAdminClient();
  const log: string[] = [];
  const L = (s: string) => { console.log(`[recalc-centerstone-may] ${s}`); log.push(s); };

  // ---- 1. Reverse pre-bill stamps on the 5 entities ----
  const { data: prebills } = await admin.from('request_entities')
    .select('id, entity_name, gross_receipts, status')
    .eq('gross_receipts->pre_billed->>invoice_id', CENTERSTONE_INVOICE_ID) as { data: any[] };
  L(`Found ${prebills?.length || 0} pre-billed entities to un-stamp`);

  for (const e of (prebills || [])) {
    const next = { ...(e.gross_receipts || {}) };
    delete next.pre_billed;
    const { error } = await (admin.from('request_entities') as any)
      .update({ gross_receipts: next })
      .eq('id', e.id);
    if (error) { L(`  ✗ ${e.entity_name}: ${error.message}`); continue; }
    L(`  ✓ ${e.entity_name} — pre_billed marker removed (will bill in completion month at $59.98)`);
  }

  // ---- 2. Compute new correct total (completed entities × flat rate) ----
  const { data: client } = await admin.from('clients').select('billing_rate_pdf, name, billing_ap_email, billing_ap_email_cc, billing_net_days, mercury_customer_id, address_line1, address_line2, address_city, address_state, address_postal_code, address_country')
    .eq('id', CENTERSTONE_CLIENT_ID).single() as { data: any };
  const rate = client.billing_rate_pdf || 59.98;

  const { data: completed } = await admin.from('request_entities')
    .select('id, entity_name, requests!inner(client_id)')
    .eq('status', 'completed').eq('requests.client_id', CENTERSTONE_CLIENT_ID)
    .gte('completed_at', `${PERIOD_START}T00:00:00Z`)
    .lte('completed_at', `${PERIOD_END}T23:59:59.999Z`) as { data: any[] };
  const completedCount = completed?.length || 0;
  const newTotal = Math.round(completedCount * rate * 100) / 100;
  L(`Completed in May: ${completedCount} × $${rate} = $${newTotal}`);

  // ---- 3. Cancel old Mercury invoice ----
  // Mercury's documented cancel endpoint: POST /ar/invoices/{id}/cancel
  const mercuryKey = process.env.MERCURY_API_KEY;
  if (!mercuryKey) {
    return NextResponse.json({ error: 'MERCURY_API_KEY not set in env', log }, { status: 500 });
  }
  const cancelRes = await fetch(`https://api.mercury.com/api/v1/ar/invoices/${OLD_MERCURY_INVOICE_ID}/cancel`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${mercuryKey}`, 'Content-Type': 'application/json' },
  });
  if (cancelRes.ok) {
    L(`✓ Cancelled old Mercury invoice ${OLD_MERCURY_INVOICE_ID}`);
  } else {
    const body = await cancelRes.text();
    L(`! Cancel returned ${cancelRes.status} — ${body.slice(0, 200)}. Continuing anyway (may need manual cancel in Mercury UI).`);
  }

  // ---- 4. Create new Mercury invoice at the corrected amount ----
  const invoiceDate = new Date().toISOString().split('T')[0];
  const dueDateObj = new Date(invoiceDate);
  dueDateObj.setUTCDate(dueDateObj.getUTCDate() + (client.billing_net_days ?? 5));
  const dueDate = dueDateObj.toISOString().split('T')[0];
  const newInvoiceNumber = `INV-2026-05-CENT-R1`; // R1 = revised v1

  const newMercury = await createMercuryInvoice({
    customerId: client.mercury_customer_id,
    destinationAccountId: getDestinationAccountId(),
    dueDate,
    invoiceDate,
    invoiceNumber: newInvoiceNumber,
    lineItems: [{
      name: `IRS Transcript Verification — May 2026 (${completedCount} completed verifications)`,
      unitPrice: rate,
      quantity: completedCount,
    }],
    ccEmails: client.billing_ap_email_cc || [],
    creditCardEnabled: false,
    achDebitEnabled: true,
    useRealAccountNumber: false,
    sendEmailOption: 'SendNow',
    servicePeriodStartDate: PERIOD_START,
    servicePeriodEndDate: PERIOD_END,
    payerMemo: `Reference: ${newInvoiceNumber}. Replaces INV-2026-05-CENT per Mathew's 2026-05-26 reconciliation request — only completed verifications included. Net ${client.billing_net_days ?? 5}.`,
    internalNote: `Reissue of INV-2026-05-CENT at corrected amount. Old total $1,619.46 included 5 pre-billed pending entities that violated Centerstone's "completed only" contract clause. New total $${newTotal} = ${completedCount} × $${rate}. Monitoring billed separately via Stripe.`,
  });
  L(`✓ Created new Mercury invoice ${newMercury.id} (slug=${newMercury.slug}) at $${newTotal}`);

  // ---- 5. Update local invoice row + reset breakdown flag ----
  const newPayUrl = getMercuryPayUrl(newMercury.slug);
  const newPdfUrl = getMercuryInvoicePdfUrl(newMercury.slug);
  await (admin.from('invoices') as any).update({
    invoice_number: newInvoiceNumber,
    total_entities: completedCount,
    total_amount: newTotal,
    monitoring_entities: 0,
    monitoring_amount: 0,
    mercury_invoice_id: newMercury.id,
    mercury_invoice_slug: newMercury.slug,
    mercury_pay_url: newPayUrl,
    mercury_pdf_url: newPdfUrl,
    mercury_reference: newMercury.invoiceNumber,
    breakdown_sent_at: null,
    notes: `Reissued 2026-05-26 per Mathew's reconciliation request. Was INV-2026-05-CENT at $1,619.46; corrected to $${newTotal} (${completedCount} completed verifications only). Pre-bills + monitoring removed from Mercury (monitoring fires via Stripe May 28).`,
    sent_at: new Date().toISOString(),
  }).eq('id', CENTERSTONE_INVOICE_ID);
  L(`✓ Updated local invoices row — breakdown_sent_at reset (cron will refire matching breakdown)`);

  return NextResponse.json({
    success: true,
    old_invoice_number: 'INV-2026-05-CENT',
    old_total: 1619.46,
    new_invoice_number: newInvoiceNumber,
    new_total: newTotal,
    new_mercury_id: newMercury.id,
    new_pay_url: newPayUrl,
    new_pdf_url: newPdfUrl,
    completed_entity_count: completedCount,
    prebills_reversed: prebills?.length || 0,
    log,
  });
}
