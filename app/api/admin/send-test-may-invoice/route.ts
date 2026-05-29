/**
 * POST /api/admin/send-test-may-invoice
 *
 * One-shot test-send: composes a Mercury invoice for the May 2026
 * cycle for a named client and routes it to a test email
 * (default matt@moderntax.io) so Matt can preview the final document
 * + pay URL before issuing the real invoice on 5/31.
 *
 * Body:
 *   {
 *     client_slug: "centerstone" | "cal_statewide",
 *     test_email?: string,         // default matt@moderntax.io
 *     include_pending?: boolean,   // default false — only completed entities
 *     mode?: "stage" | "send_now", // default "send_now"
 *
 *     // Optional balance-due mode (2026-05-29 — Matt's directive
 *     // "Cal Statewide CDC should only get invoice for balance due not
 *     // full amount"):
 *     entities_completed_after?: string,  // ISO date — only bill entities
 *                                          // completed strictly AFTER this.
 *                                          // Used when prior invoice already
 *                                          // billed everything ≤ this date.
 *     monitoring_active_after?: string,    // ISO date — only count monitoring
 *                                          // prorated AFTER this date.
 *     catchup_line?: {                     // Adds a single fixed-amount line
 *       amount: number,                    // for catch-up balance from an
 *       memo: string,                      // earlier, partially-paid invoice.
 *     },
 *   }
 *
 * Behavior:
 *   - Computes the EOM billing line items the same way the auto-invoice
 *     cron would: verification at the client's contracted rate,
 *     monitoring (when not disabled) prorated at the catalog $29.
 *   - Creates a SEPARATE test Mercury customer "ModernTax Test —
 *     <client name>" with email = test_email. Distinct from the
 *     production Mercury customer so the test invoice never ships to
 *     the real AP inbox.
 *   - Creates the Mercury invoice with sendEmailOption=SendNow
 *     (default) → email goes to test_email.
 *   - Does NOT touch the local `invoices` table — test invoices are
 *     not billable. Returns the Mercury PDF + pay URL so Matt can
 *     eyeball it.
 *
 * Auth: CRON_SECRET only.
 *
 * Idempotency: NOT idempotent. Each call creates a fresh Mercury
 * invoice + (potentially) a fresh test customer. Mercury invoices are
 * cheap and can be cancelled in the Mercury UI; the test customer is
 * reused across calls (same email).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { PRICE_POST_CLOSE_MONITORING_MONTHLY } from '@/lib/pricing';
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

const CLIENTS: Record<string, { name_ilike: string; slug: string }> = {
  centerstone:   { name_ilike: 'Centerstone%', slug: 'CENT' },
  cal_statewide: { name_ilike: 'Cal%Statewide%', slug: 'CALI' },
};

interface LineItem { name: string; unitPrice: number; quantity: number; }

export async function POST(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  let body: {
    client_slug?: string;
    test_email?: string;
    include_pending?: boolean;
    mode?: 'stage' | 'send_now';
    entities_completed_after?: string;
    monitoring_active_after?: string;
    catchup_line?: { amount: number; memo: string };
  };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const slug = body.client_slug || '';
  const mapping = CLIENTS[slug];
  if (!mapping) {
    return NextResponse.json({ error: `client_slug must be one of: ${Object.keys(CLIENTS).join(', ')}` }, { status: 400 });
  }
  const testEmail = body.test_email?.trim().toLowerCase() || 'matt@moderntax.io';
  const includePending = body.include_pending === true;
  const mode: 'stage' | 'send_now' = body.mode === 'stage' ? 'stage' : 'send_now';
  const entitiesCutoff = body.entities_completed_after?.trim() || null;
  const monitoringCutoff = body.monitoring_active_after?.trim() || null;
  const catchupLine = (body.catchup_line && typeof body.catchup_line.amount === 'number' && body.catchup_line.memo)
    ? body.catchup_line
    : null;

  const admin = createAdminClient();
  const log: string[] = [];
  const L = (s: string) => { log.push(s); console.log(`[test-invoice] ${s}`); };

  // Pull client.
  const { data: clientRows } = await admin.from('clients')
    .select('id, name, billing_rate_pdf, billing_rate_monitoring, disable_monitoring, disable_8821_surcharge, sla_tier')
    .ilike('name', mapping.name_ilike) as { data: any[] | null };
  const client = clientRows?.[0];
  if (!client) return NextResponse.json({ error: 'client not found' }, { status: 404 });
  L(`Client: ${client.name} (id=${client.id.slice(0, 8)})`);
  L(`  rate=$${client.billing_rate_pdf} monitoring_disabled=${client.disable_monitoring} sla=${client.sla_tier}`);

  // --- Verification line ---
  const periodStart = '2026-05-01';
  const periodEnd   = '2026-05-31';
  const billStatuses = includePending
    ? ['completed', '8821_signed', 'irs_queue', 'processing']
    : ['completed'];

  let entitiesQ = admin.from('request_entities')
    .select(`id, entity_name, status, completed_at, gross_receipts, requests!inner(loan_number, client_id, requested_by, profiles!requests_requested_by_fkey(full_name, email))`)
    .eq('requests.client_id', client.id)
    .in('status', billStatuses);
  // Floor on completion date is the LATER of periodStart and entitiesCutoff
  // (when provided). Used for balance-due invoices that net out work
  // already billed on a prior partially-paid invoice.
  const lowerBound = entitiesCutoff && entitiesCutoff > `${periodStart}T00:00:00Z`
    ? entitiesCutoff
    : `${periodStart}T00:00:00Z`;
  if (!includePending) {
    entitiesQ = entitiesQ.gt('completed_at', lowerBound).lte('completed_at', `${periodEnd}T23:59:59Z`);
  }
  L(`  Entity cutoff: completed > ${lowerBound}`);
  const { data: entities } = await entitiesQ as { data: any[] | null };
  const allEntities = entities || [];
  // Filter out pre-billed
  const billable = allEntities.filter((e) => !e?.gross_receipts?.pre_billed?.invoice_id);
  L(`  Entities found: ${allEntities.length} (pre-billed skipped: ${allEntities.length - billable.length})`);

  const ratePdf = Number(client.billing_rate_pdf || 59.98);
  // Group reorders separately (priced at $29.99).
  let reorderCount = 0;
  let standardCount = 0;
  for (const e of billable) {
    if (e?.gross_receipts?.reorder?.sku === 'reorder-from-history') reorderCount += 1;
    else standardCount += 1;
  }

  const lineItems: LineItem[] = [];
  if (standardCount > 0) {
    const verifLabel = entitiesCutoff
      ? `Tax Verification — ${client.name} (completed after ${entitiesCutoff.slice(0, 10)})`
      : `Tax Verification — ${client.name} (May 2026)`;
    lineItems.push({
      name: verifLabel,
      unitPrice: ratePdf,
      quantity: standardCount,
    });
  }
  if (reorderCount > 0) {
    lineItems.push({
      name: 'Tax Verification — Reorder (May 2026)',
      unitPrice: 29.99,
      quantity: reorderCount,
    });
  }

  // --- Monitoring line (if enabled for this client) ---
  let monitoringAmount = 0;
  let monitoringEntities = 0;
  if (!client.disable_monitoring) {
    const { data: monitors } = await admin.from('entity_monitoring')
      .select('id, enrolled_at, cancelled_at, status')
      .eq('client_id', client.id)
      .lte('enrolled_at', `${periodEnd}T23:59:59Z`)
      .or(`cancelled_at.is.null,cancelled_at.gte.${periodStart}`) as { data: any[] | null };
    const monitoringRate = client.billing_rate_monitoring ?? PRICE_POST_CLOSE_MONITORING_MONTHLY;
    const daysInMonth = 31;
    // Lower bound on the monitoring window — periodStart by default, OR
    // monitoringCutoff (when provided) for balance-due invoices that
    // already billed the early-period monitoring on a prior invoice.
    const monitoringLowerMs = monitoringCutoff
      ? Math.max(Date.parse(`${periodStart}T00:00:00Z`), Date.parse(monitoringCutoff))
      : Date.parse(`${periodStart}T00:00:00Z`);
    const periodEndMs = Date.parse(`${periodEnd}T23:59:59Z`) + 1;
    L(`  Monitoring window: ${new Date(monitoringLowerMs).toISOString()} → ${new Date(periodEndMs).toISOString()}`);
    for (const m of (monitors || [])) {
      if (m.status === 'pending') continue;
      const enrolled = Date.parse(m.enrolled_at);
      const cancelled = m.cancelled_at ? Date.parse(m.cancelled_at) : Number.POSITIVE_INFINITY;
      if (enrolled >= monitoringLowerMs && cancelled <= periodEndMs) continue;
      const windowStart = Math.max(enrolled, monitoringLowerMs);
      const windowEnd = Math.min(cancelled, periodEndMs);
      if (windowEnd <= windowStart) continue;
      const activeDays = Math.ceil((windowEnd - windowStart) / (24 * 3600 * 1000));
      const prorated = (Math.min(activeDays, daysInMonth) / daysInMonth) * monitoringRate;
      monitoringAmount += prorated;
      monitoringEntities += 1;
    }
    monitoringAmount = Math.round(monitoringAmount * 100) / 100;
    if (monitoringEntities > 0) {
      const monLabel = monitoringCutoff
        ? `Account Monitoring (${monitoringCutoff.slice(0, 10)} → ${periodEnd}, net new since prior invoice)`
        : `Account Monitoring (${periodStart} → ${periodEnd})`;
      lineItems.push({
        name: monLabel,
        unitPrice: Math.round((monitoringAmount / monitoringEntities) * 100) / 100,
        quantity: monitoringEntities,
      });
    }
  }

  // --- Catchup line (balance carried over from a partially-paid prior invoice) ---
  if (catchupLine) {
    lineItems.push({
      name: catchupLine.memo,
      unitPrice: Math.round(catchupLine.amount * 100) / 100,
      quantity: 1,
    });
    L(`  Catchup line: $${catchupLine.amount.toFixed(2)} — ${catchupLine.memo}`);
  }

  const grandTotal = Math.round(lineItems.reduce((a, l) => a + l.unitPrice * l.quantity, 0) * 100) / 100;
  L(`  Line items: ${lineItems.length}`);
  for (const l of lineItems) L(`    ${l.name} — ${l.quantity} × $${l.unitPrice.toFixed(2)} = $${(l.quantity * l.unitPrice).toFixed(2)}`);
  L(`  Grand total: $${grandTotal.toFixed(2)}`);

  if (lineItems.length === 0) {
    return NextResponse.json({ error: 'No billable lines for this period.', log }, { status: 400 });
  }

  // --- Test Mercury customer (distinct from prod) ---
  const testCustomer = await findOrCreateMercuryCustomer({
    name: `ModernTax TEST — ${client.name}`,
    email: testEmail,
    address: {
      name: `ModernTax TEST — ${client.name}`,
      address1: '548 Market St',
      city: 'San Francisco',
      region: 'CA',
      postalCode: '94104',
      country: 'US',
    },
  });
  L(`Test Mercury customerId: ${testCustomer.id} (email=${testEmail})`);

  // --- Create the test invoice ---
  const invoiceDate = new Date().toISOString().split('T')[0];
  const dueDate = new Date();
  dueDate.setUTCDate(dueDate.getUTCDate() + 5);
  const invoiceNumber = `TEST-INV-2026-05-${mapping.slug}-${Math.floor(Date.now() / 1000)}`;

  const mercuryInvoice = await createMercuryInvoice({
    customerId: testCustomer.id,
    destinationAccountId: getDestinationAccountId(),
    dueDate: dueDate.toISOString().split('T')[0],
    invoiceDate,
    invoiceNumber,
    lineItems,
    ccEmails: [],
    creditCardEnabled: false,
    achDebitEnabled: true,
    useRealAccountNumber: false,
    sendEmailOption: mode === 'send_now' ? 'SendNow' : 'DontSend',
    servicePeriodStartDate: periodStart,
    servicePeriodEndDate: periodEnd,
    payerMemo: `*** TEST INVOICE *** — Preview of the May 2026 ${client.name} invoice routed to ${testEmail}. Reference: ${invoiceNumber}. Not for payment.`,
    internalNote: `TEST INVOICE for ${client.name} May 2026 preview. Do NOT send to real customer.`,
  });

  const payUrl = getMercuryPayUrl(mercuryInvoice.slug);
  const pdfUrl = getMercuryInvoicePdfUrl(mercuryInvoice.slug);
  L(`✓ Test Mercury invoice ${mercuryInvoice.id} created (${mode})`);
  L(`  pdf: ${pdfUrl}`);
  L(`  pay: ${payUrl}`);

  return NextResponse.json({
    success: true,
    mode,
    client: client.name,
    test_email: testEmail,
    period: { start: periodStart, end: periodEnd },
    counts: {
      total_entities_seen: allEntities.length,
      pre_billed_skipped: allEntities.length - billable.length,
      standard_billable: standardCount,
      reorder_billable: reorderCount,
      monitoring_enrollments: monitoringEntities,
    },
    line_items: lineItems,
    grand_total: grandTotal,
    mercury: {
      invoice_id: mercuryInvoice.id,
      invoice_number: invoiceNumber,
      pdf_url: pdfUrl,
      pay_url: payUrl,
    },
    log,
  });
}
