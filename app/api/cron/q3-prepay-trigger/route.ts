/**
 * GET /api/cron/q3-prepay-trigger
 *
 * Daily armed-and-waiting cron — fires the moment May 2026 invoices clear
 * to create Q3 2026 prepay invoices for Centerstone + California Statewide
 * CDC. Idempotent (per-client gate via existing invoice_number lookup).
 *
 * Driver: 2026-05-23 Matt's directive — "Once may invoices are paid generate
 * these offers." Q3 prepay at 8% discount converts a paying customer into
 * 90-day cash, locks rate through 9/30, and pulls revenue forward toward
 * the Q2 $228K target. Total Q3 prepay potential: $7,481.01.
 *
 * Per-client trigger logic:
 *   - WAIT until ALL the client's May 2026 invoices have paid_at IS NOT NULL.
 *     For Centerstone + Cal Statewide this means BOTH the Mercury verification
 *     invoice AND the Stripe monitoring invoice (-MON, created 2026-05-28).
 *   - On first detection of full payment, create the Mercury Q3 prepay invoice
 *     using sendEmailOption='DontSend' (the closest API equivalent to "draft":
 *     invoice exists in Mercury as Unpaid but no email goes out — Matt sends
 *     it via Gmail draft after attaching the pay URL).
 *   - Insert a tracking row into the local `invoices` table.
 *   - Send a heads-up email to matt@moderntax.io with the slug + pay URL so
 *     he can update the Gmail drafts and fire them.
 *
 * Settings on the Q3 prepay invoice (matches Matt's exact spec):
 *   creditCardEnabled: false       (matches Centerstone + Cal Statewide pattern)
 *   achDebitEnabled:   true        (the only payment surface)
 *   useRealAccountNumber: false    (suppresses ACH Credit / wire panel on pay page)
 *   sendEmailOption:   DontSend    (don't auto-email; Matt sends via Gmail)
 *
 * Schedule: `0 14 * * *` (daily 14:00 UTC = 7 AM PT). ACH clears in 2-5
 * business days so daily polling is sufficient; hourly would just burn API
 * quota with no faster response.
 *
 * Auth: CRON_SECRET only.
 */

import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';
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

interface PrepayPlan {
  clientId: string;
  clientName: string;
  mercuryCustomerId: string;
  mayInvoiceNumbers: string[];      // both Mercury + Stripe -MON must be paid
  q3InvoiceNumber: string;
  q3Amount: number;
  monthlyStandardRate: number;
  discountAmount: number;
  ccEmails: string[];
  apEmail: string;
  lineItemDescription: string;
  payerMemo: string;
  internalNote: string;
}

// Specs match the Q3 prepay offer Matt drafted 2026-05-23. The $1,790.41
// (Centerstone) and $920.10 (Cal Statewide) monthly rates are the May 2026
// totals (verification + pre-bill + monitoring). 8% prepay discount applied.
const PREPAY_PLANS: PrepayPlan[] = [
  {
    clientId:          '60f80d60-03ad-42d7-95da-c0f1cd311523',
    clientName:        'Centerstone SBA Lending',
    mercuryCustomerId: '36bff734-8836-11f0-b570-ff2017319989',
    mayInvoiceNumbers: ['INV-2026-05-CENT', 'INV-2026-05-CENT-MON'],
    q3InvoiceNumber:   'INV-2026-Q3-CENT-PREPAY',
    q3Amount:          4941.53,   // 3 × 1790.41 × 0.92 (rounded)
    monthlyStandardRate: 1790.41,
    discountAmount:    429.70,
    apEmail:           'Mathew.paek@teamcenterstone.com',
    ccEmails:          ['jasmine.kim@teamcenterstone.com'],
    lineItemDescription:
      'Q3 2026 Prepaid Verification & Monitoring (Jun + Jul + Aug) - 3 months @ $1,790.41/mo standard rate, 8% prepay discount applied ($429.70 savings). Locks rate through 9/30/2026. Includes verifications, pre-billed entities, and monitoring bundle.',
    payerMemo:
      'Reference: INV-2026-Q3-CENT-PREPAY. Q3 2026 prepay (Jun/Jul/Aug). 8% discount vs. monthly billing. Net 5 days. ACH Debit only. Pauses standard monthly billing through 9/30/2026.',
    internalNote:
      'Q3 quarterly prepay extended to Centerstone post-May-payment-clear. Replaces monthly INV-2026-06/07/08-CENT cadence. Discount: $429.70 (8%) off gross $5,371.23.',
  },
  {
    clientId:          '3256293c-6c98-42bc-a828-2b73a603048e',
    clientName:        'California Statewide CDC',
    mercuryCustomerId: '5d39fc64-3814-11f1-9429-2bd02ef10101',
    mayInvoiceNumbers: ['INV-2026-05-CALI', 'INV-2026-05-CALI-MON'],
    q3InvoiceNumber:   'INV-2026-Q3-CALI-PREPAY',
    q3Amount:          2539.48,   // 3 × 920.10 × 0.92 (rounded)
    monthlyStandardRate: 920.10,
    discountAmount:    220.82,
    apEmail:           'accountspayable@calstatewide.com',
    ccEmails:          ['zeinab@statewidecdc.com'],
    lineItemDescription:
      'Q3 2026 Prepaid Verification & Monitoring (Jun + Jul + Aug) - 3 months @ $920.10/mo standard rate, 8% prepay discount applied ($220.82 savings). Locks rate through 9/30/2026. Verification + pre-bill + monitoring bundle.',
    payerMemo:
      'Reference: INV-2026-Q3-CALI-PREPAY. Q3 2026 prepay (Jun/Jul/Aug). 8% discount vs. monthly billing. Net 5 days. ACH Debit only. Pauses standard monthly billing through 9/30/2026.',
    internalNote:
      'Q3 quarterly prepay extended to Cal Statewide post-May-payment-clear via Sonja Lewis. Replaces monthly INV-2026-06/07/08-CALI. Discount: $220.82 (8%) off gross $2,760.30.',
  },
];

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  // DISARMED 2026-06-29. Q3 2026 prepays are now handled via signed proposals +
  // manual accounting, not this auto-cron. Its hardcoded terms went stale: Cal
  // Statewide actually signed $3,023.24 (10% off, Jul-Sep, QT-CALI-Q3-0003) vs.
  // this cron's $2,539.48 (8%, Jun-Aug) — already recorded as INV-2026-Q3-CALI-
  // PREPAY. Centerstone's $4,941.53/8% line is likewise unconfirmed and must not
  // auto-fire a wrong invoice. Schedule removed from vercel.json too; this guard
  // is belt-and-suspenders. Re-enable only with Q3_PREPAY_AUTO_ENABLED=true.
  if (process.env.Q3_PREPAY_AUTO_ENABLED !== 'true') {
    return NextResponse.json({
      skipped: true,
      disarmed: true,
      reason: 'q3-prepay-trigger is disarmed — Q3 2026 prepays are handled manually via signed proposals (see INV-2026-Q3-CALI-PREPAY).',
    });
  }

  const admin = createAdminClient();
  const results: Array<{ client: string; status: string; slug?: string; payUrl?: string; reason?: string }> = [];

  for (const plan of PREPAY_PLANS) {
    try {
      const result = await processPrepayPlan(admin, plan);
      results.push(result);
    } catch (err: any) {
      console.error(`[q3-prepay-trigger] ${plan.clientName}: ${err.message}`);
      results.push({ client: plan.clientName, status: 'error', reason: err.message });
    }
  }

  return NextResponse.json({
    success: results.every(r => r.status !== 'error'),
    ran_at: new Date().toISOString(),
    results,
  });
}

async function processPrepayPlan(
  admin: ReturnType<typeof createAdminClient>,
  plan: PrepayPlan,
): Promise<{ client: string; status: string; slug?: string; payUrl?: string; reason?: string }> {
  // 1. Idempotency: has the Q3 prepay invoice already been created?
  const { data: existingQ3 } = await admin.from('invoices')
    .select('id, invoice_number, mercury_invoice_slug, mercury_pay_url, created_at')
    .eq('invoice_number', plan.q3InvoiceNumber)
    .maybeSingle() as { data: any };
  if (existingQ3) {
    return {
      client: plan.clientName,
      status: 'already_created',
      slug: existingQ3.mercury_invoice_slug,
      payUrl: existingQ3.mercury_pay_url,
      reason: `Q3 invoice already created at ${existingQ3.created_at}`,
    };
  }

  // 2. Gate: all May invoices for this client must be paid_at IS NOT NULL
  const { data: mayInvoices } = await admin.from('invoices')
    .select('invoice_number, paid_at, total_amount')
    .in('invoice_number', plan.mayInvoiceNumbers) as { data: any[] };
  const expectedCount = plan.mayInvoiceNumbers.length;
  const foundCount = (mayInvoices || []).length;
  const paidCount  = (mayInvoices || []).filter((i: any) => !!i.paid_at).length;

  // If the -MON row hasn't been created yet (Stripe charge scheduled for 5/28),
  // it's missing from the lookup. That's a not-yet, not an error.
  if (foundCount < expectedCount) {
    return {
      client: plan.clientName,
      status: 'waiting',
      reason: `${foundCount}/${expectedCount} May invoices exist (Stripe -MON row not yet created by 2026-05-28 cron)`,
    };
  }
  if (paidCount < expectedCount) {
    const unpaid = (mayInvoices || []).filter((i: any) => !i.paid_at).map((i: any) => i.invoice_number);
    return {
      client: plan.clientName,
      status: 'waiting',
      reason: `${paidCount}/${expectedCount} May invoices paid; waiting on: ${unpaid.join(', ')}`,
    };
  }

  // 3. All May invoices paid — create the Q3 Mercury invoice (DontSend = draft)
  console.log(`[q3-prepay-trigger] ${plan.clientName}: all May invoices paid, creating Q3 prepay`);

  const invoiceDate = new Date().toISOString().split('T')[0];
  const dueDateObj = new Date(invoiceDate);
  dueDateObj.setUTCDate(dueDateObj.getUTCDate() + 5);
  const dueDate = dueDateObj.toISOString().split('T')[0];

  const mercuryInvoice = await createMercuryInvoice({
    customerId: plan.mercuryCustomerId,
    destinationAccountId: getDestinationAccountId(),
    dueDate,
    invoiceDate,
    invoiceNumber: plan.q3InvoiceNumber,
    lineItems: [{
      name: plan.lineItemDescription.slice(0, 200),  // Mercury max
      unitPrice: plan.q3Amount,
      quantity: 1,
    }],
    ccEmails: plan.ccEmails,
    creditCardEnabled: false,
    achDebitEnabled: true,
    useRealAccountNumber: false,
    sendEmailOption: 'DontSend',   // draft mode — Matt sends via Gmail
    servicePeriodStartDate: '2026-06-01',
    servicePeriodEndDate:   '2026-08-31',
    payerMemo: plan.payerMemo,
    internalNote: plan.internalNote,
  });

  const payUrl = getMercuryPayUrl(mercuryInvoice.slug);
  const pdfUrl = getMercuryInvoicePdfUrl(mercuryInvoice.slug);

  // 4. Insert tracking row in local invoices table
  const { data: insertedInv } = await admin.from('invoices').insert({
    client_id: plan.clientId,
    invoice_number: plan.q3InvoiceNumber,
    billing_period_start: '2026-06-01',
    billing_period_end: '2026-08-31',
    total_entities: 0,
    total_amount: plan.q3Amount,
    status: 'draft',  // Mercury invoice exists but email not sent
    payment_method: 'ach',
    due_date: dueDate,
    mercury_reference: mercuryInvoice.invoiceNumber,
    mercury_invoice_id: mercuryInvoice.id,
    mercury_invoice_slug: mercuryInvoice.slug,
    mercury_pay_url: payUrl,
    mercury_pdf_url: pdfUrl,
    notes: `Q3 2026 prepay. Discount $${plan.discountAmount.toFixed(2)} (8%) off 3 × $${plan.monthlyStandardRate}/mo. Pauses monthly billing through 9/30/2026 when paid.`,
  } as any).select('id').single() as { data: any };

  // 5. Email matt@moderntax.io with the slug + pay URL so he can update Gmail drafts
  if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    try {
      await sgMail.send({
        to: 'matt@moderntax.io',
        from: 'no-reply@moderntax.io',
        subject: `[Q3 Prepay Ready] ${plan.clientName} — $${plan.q3Amount.toFixed(2)} Mercury draft created`,
        text: [
          `Q3 2026 prepay invoice created (draft mode — not emailed by Mercury):`,
          ``,
          `Client:        ${plan.clientName}`,
          `Invoice #:     ${plan.q3InvoiceNumber}`,
          `Amount:        $${plan.q3Amount.toFixed(2)}`,
          `Mercury ID:    ${mercuryInvoice.id}`,
          `Slug:          ${mercuryInvoice.slug}`,
          `Pay URL:       ${payUrl}`,
          `PDF URL:       ${pdfUrl}`,
          `Due:           ${dueDate}`,
          ``,
          `Settings: ACH Debit only · No credit card · No ACH Credit / wire`,
          ``,
          `Next step: update the Gmail draft to ${plan.apEmail} (CC: ${plan.ccEmails.join(', ')}) `,
          `with the pay URL and send.`,
          ``,
          `Local invoice row id: ${insertedInv?.id}`,
        ].join('\n'),
      });
    } catch (emailErr: any) {
      console.warn(`[q3-prepay-trigger] notification email failed: ${emailErr.message}`);
    }
  }

  console.log(`[q3-prepay-trigger] ${plan.clientName}: Q3 invoice ${mercuryInvoice.slug} created, pay url ${payUrl}`);
  return {
    client: plan.clientName,
    status: 'created',
    slug: mercuryInvoice.slug,
    payUrl,
  };
}
