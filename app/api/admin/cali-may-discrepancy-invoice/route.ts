/**
 * POST /api/admin/cali-may-discrepancy-invoice
 *
 * One-shot: bill California Statewide CDC for the $260.32 short on
 * INV-2026-05-CALI. The 2026-05-28 ACH payment came in at $659.78
 * (= exactly 11 × $59.98, Centerstone's rate), not the contracted
 * 11 × $79.98 = $879.78 + $40.32 monitoring = $920.10. Either AP error
 * or an unstated rate dispute — Matt will discuss separately. This
 * endpoint just builds the Mercury invoice + Mercury pay link for the
 * outstanding balance so it can land on the last day of the month.
 *
 * Body:
 *   { mode: 'dry_run' | 'stage' | 'send_now' }
 *
 * Modes:
 *   dry_run   — compute the line items + amount, do NOT touch Mercury or DB.
 *               Returns the breakdown for Matt to eyeball.
 *   stage     — create the Mercury invoice with sendEmailOption='DontSend'
 *               (lands in Mercury as Unpaid, no email goes out). Insert a
 *               local `invoices` row with status='draft'. Matt can then
 *               preview the Mercury PDF + pay URL before firing.
 *   send_now  — create + send the Mercury invoice (sendEmailOption='SendNow').
 *               This is the one to call on 2026-05-31. Routes to
 *               zeinab@statewidecdc.com (primary, per the 2026-05-29
 *               routing update) with accountspayable@calstatewide.com CC.
 *
 * Auth: CRON_SECRET only (admin-protected, irreversible at send_now).
 *
 * Idempotency: rejects if an invoice number `INV-2026-05-CALI-DISC`
 * already exists in the local invoices table.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import {
  createMercuryInvoice,
  findOrCreateMercuryCustomer,
  getDestinationAccountId,
  getMercuryInvoicePdfUrl,
  getMercuryPayUrl,
} from '@/lib/mercury';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CAL_CLIENT_ID = '3256293c-6c98-42bc-a828-2b73a603048e';
const DISCREPANCY_INVOICE_NUMBER = 'INV-2026-05-CALI-DISC';
const ORIGINAL_INVOICE_NUMBER = 'INV-2026-05-CALI';
const ORIGINAL_AMOUNT = 920.10;
const ACH_RECEIVED = 659.78;
const SHORT_AMOUNT = Math.round((ORIGINAL_AMOUNT - ACH_RECEIVED) * 100) / 100; // 260.32

export async function POST(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  let body: { mode?: 'dry_run' | 'stage' | 'send_now' };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const mode = body.mode || 'dry_run';
  if (!['dry_run', 'stage', 'send_now'].includes(mode)) {
    return NextResponse.json({ error: 'mode must be dry_run | stage | send_now' }, { status: 400 });
  }

  const admin = createAdminClient();
  const log: string[] = [];
  const L = (s: string) => { log.push(s); console.log(`[cali-disc] ${s}`); };

  // Pull Cal Statewide client config (routing + mercury_customer_id).
  const { data: client, error: clientErr } = await admin.from('clients')
    .select('id, name, billing_ap_email, billing_ap_email_cc, billing_net_days, billing_payment_method, mercury_customer_id, address_line1, address_city, address_state, address_postal_code')
    .eq('id', CAL_CLIENT_ID).single() as { data: any; error: any };
  if (clientErr || !client) {
    return NextResponse.json({ error: 'Cal Statewide client not found' }, { status: 404 });
  }
  L(`Client: ${client.name}`);
  L(`  primary AP: ${client.billing_ap_email}`);
  L(`  cc:         ${JSON.stringify(client.billing_ap_email_cc)}`);

  // Check for existing discrepancy invoice — idempotency guard.
  const { data: existing } = await admin.from('invoices')
    .select('id, invoice_number, status, mercury_invoice_id, mercury_pay_url, total_amount, paid_at')
    .eq('invoice_number', DISCREPANCY_INVOICE_NUMBER).maybeSingle() as { data: any };
  if (existing && mode !== 'dry_run') {
    return NextResponse.json({
      already_exists: true,
      invoice: existing,
      message: `${DISCREPANCY_INVOICE_NUMBER} already exists in the local invoices table. Cancel it via Mercury + delete the row if you want to re-stage.`,
    });
  }

  // Build the breakdown.
  const lineItems = [
    {
      name: `Catch-up: ${ORIGINAL_INVOICE_NUMBER} short payment (invoiced $${ORIGINAL_AMOUNT.toFixed(2)}, received $${ACH_RECEIVED.toFixed(2)} ACH 2026-05-28)`,
      unitPrice: SHORT_AMOUNT,
      quantity: 1,
    },
  ];

  const breakdown = {
    invoice_number: DISCREPANCY_INVOICE_NUMBER,
    references_invoice: ORIGINAL_INVOICE_NUMBER,
    original_amount: ORIGINAL_AMOUNT,
    received_amount: ACH_RECEIVED,
    short_amount: SHORT_AMOUNT,
    line_items: lineItems,
    routing: {
      primary: client.billing_ap_email,
      cc: client.billing_ap_email_cc,
    },
  };

  if (mode === 'dry_run') {
    L(`mode=dry_run — no Mercury or DB writes`);
    return NextResponse.json({ mode, breakdown, log });
  }

  // Resolve or create the Mercury customer. Cal Statewide already has
  // mercury_customer_id set on the client row (the prior INV-2026-05-CALI
  // creation populated it), but fall through to find-or-create defensively
  // in case it ever drifts.
  let mercuryCustomerId: string = client.mercury_customer_id;
  if (!mercuryCustomerId) {
    const cust = await findOrCreateMercuryCustomer({
      name: client.name,
      email: client.billing_ap_email,
      address: {
        name: client.name,
        address1: client.address_line1 || '',
        city: client.address_city || '',
        region: client.address_state || '',
        postalCode: client.address_postal_code || '',
        country: 'US',
      },
    });
    mercuryCustomerId = cust.id;
  }
  L(`Mercury customerId: ${mercuryCustomerId}`);

  const invoiceDate = new Date().toISOString().split('T')[0];
  const netDays = client.billing_net_days ?? 5;
  const dueDateObj = new Date(invoiceDate);
  dueDateObj.setUTCDate(dueDateObj.getUTCDate() + netDays);
  const dueDate = dueDateObj.toISOString().split('T')[0];

  // Stage or send.
  const sendEmailOption = mode === 'send_now' ? 'SendNow' : 'DontSend';
  L(`Creating Mercury invoice (sendEmailOption=${sendEmailOption})...`);

  const mercuryInvoice = await createMercuryInvoice({
    customerId: mercuryCustomerId,
    destinationAccountId: getDestinationAccountId(),
    dueDate,
    invoiceDate,
    invoiceNumber: DISCREPANCY_INVOICE_NUMBER,
    lineItems,
    ccEmails: client.billing_ap_email_cc || [],
    creditCardEnabled: false,
    achDebitEnabled: true,
    useRealAccountNumber: false,
    sendEmailOption: sendEmailOption as any,
    servicePeriodStartDate: '2026-05-01',
    servicePeriodEndDate: '2026-05-31',
    payerMemo: `Reference: ${DISCREPANCY_INVOICE_NUMBER}. Catch-up balance on ${ORIGINAL_INVOICE_NUMBER} ($920.10 invoiced - $659.78 ACH received). Net ${netDays} days. ACH Debit only.`,
  });

  const mercuryPayUrl = getMercuryPayUrl(mercuryInvoice.slug);
  const mercuryPdfUrl = getMercuryInvoicePdfUrl(mercuryInvoice.slug);
  L(`✓ Mercury invoice ${mercuryInvoice.id} created`);
  L(`  pay URL: ${mercuryPayUrl}`);
  L(`  pdf URL: ${mercuryPdfUrl}`);

  // Local invoices row.
  const { data: localInvoice, error: insertErr } = await (admin.from('invoices') as any)
    .insert({
      client_id: CAL_CLIENT_ID,
      invoice_number: DISCREPANCY_INVOICE_NUMBER,
      billing_period_start: '2026-05-01',
      billing_period_end: '2026-05-31',
      total_entities: 0,
      total_amount: SHORT_AMOUNT,
      monitoring_entities: 0,
      monitoring_amount: 0,
      status: mode === 'send_now' ? 'sent' : 'draft',
      payment_method: 'ach',
      due_date: dueDate,
      mercury_invoice_id: mercuryInvoice.id,
      mercury_pay_url: mercuryPayUrl,
      notes: `Catch-up invoice for the short payment on ${ORIGINAL_INVOICE_NUMBER}. Invoiced $${ORIGINAL_AMOUNT.toFixed(2)}, ACH received $${ACH_RECEIVED.toFixed(2)} on 2026-05-28 (= 11 × $59.98 Centerstone rate, not 11 × $79.98 contracted Cal Statewide rate). Short $${SHORT_AMOUNT.toFixed(2)}.`,
    })
    .select('id')
    .single();

  if (insertErr) {
    L(`! local invoices insert failed: ${insertErr.message}`);
  } else {
    L(`✓ Local invoices row ${localInvoice.id}`);
  }

  return NextResponse.json({
    success: true,
    mode,
    breakdown,
    mercury: {
      invoice_id: mercuryInvoice.id,
      pay_url: mercuryPayUrl,
      pdf_url: mercuryPdfUrl,
    },
    local_invoice_id: localInvoice?.id,
    next_step: mode === 'stage'
      ? `Review Mercury PDF at ${mercuryPdfUrl}. When ready to send on 2026-05-31, hit this endpoint again with {"mode":"send_now"}.`
      : `Sent. Email landed at ${client.billing_ap_email} with CC ${JSON.stringify(client.billing_ap_email_cc)}.`,
    log,
  });
}
