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
import sgMail from '@sendgrid/mail';
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
import { generateInvoiceBreakdownPdf } from '@/lib/invoice-breakdown-pdf';

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
    /**
     * When true, write the invoice row + breakdown to the local `invoices`
     * table with notes prefixed [TEST] so the manager portal can render
     * the breakdown for verification. The row gets the test Mercury IDs
     * and is filterable from the dashboard later if needed. Default false
     * (test invoices don't pollute the customer's invoice history).
     */
    persist_for_portal_preview?: boolean;
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
  const persistForPortal = body.persist_for_portal_preview === true;

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
    .select(`id, entity_name, form_type, status, completed_at, gross_receipts, requests!inner(loan_number, client_id, requested_by, profiles!requests_requested_by_fkey(full_name, email))`)
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

  // 2026-05-29 (revised) — Matt: "the itemized breakdown of all entities
  // per processor is what needs to accompany each Mercury invoice link
  // it needs to be sent through SendGrid and live in the managers
  // portal." So: Mercury invoice carries SUMMARY lines (one per category
  // — verification, monitoring, catchup). The per-entity / per-enrollment
  // breakdown goes out as an itemized HTML email via SendGrid alongside
  // the Mercury pay link, and is persisted on the invoice for the
  // /invoicing portal to render.
  const lineItems: LineItem[] = [];

  // Sort entities by processor name, then by completed_at — needed for the
  // breakdown payload (groups by processor in display order).
  const sortedBillable = [...billable].sort((a, b) => {
    const pa = ((a.requests || {}).profiles || {}).full_name || 'Unattributed';
    const pb = ((b.requests || {}).profiles || {}).full_name || 'Unattributed';
    if (pa !== pb) return pa.localeCompare(pb);
    return (a.completed_at || '').localeCompare(b.completed_at || '');
  });

  // Build the per-processor / per-entity breakdown (for the email + portal).
  type EntityDetail = { entity_name: string; form_type: string | null; completed_at: string | null; loan_number: string | null; unit_price: number; is_reorder: boolean };
  type ProcessorGroup = { processor: string; entities: EntityDetail[]; subtotal: number };
  const byProcessor: Record<string, ProcessorGroup> = {};
  let reorderCount = 0;
  let standardCount = 0;
  for (const e of sortedBillable) {
    const processorName = ((e.requests || {}).profiles || {}).full_name || 'Unattributed';
    const isReorder = e?.gross_receipts?.reorder?.sku === 'reorder-from-history';
    const unitPrice = isReorder ? 29.99 : ratePdf;
    if (isReorder) reorderCount += 1; else standardCount += 1;
    if (!byProcessor[processorName]) byProcessor[processorName] = { processor: processorName, entities: [], subtotal: 0 };
    byProcessor[processorName].entities.push({
      entity_name: e.entity_name,
      form_type: e.form_type || null,
      completed_at: e.completed_at,
      loan_number: ((e.requests || {}).loan_number) || null,
      unit_price: unitPrice,
      is_reorder: isReorder,
    });
    byProcessor[processorName].subtotal = Math.round((byProcessor[processorName].subtotal + unitPrice) * 100) / 100;
  }
  const processorGroups: ProcessorGroup[] = Object.values(byProcessor).sort((a, b) => a.processor.localeCompare(b.processor));

  // Mercury SUMMARY lines (one per category).
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
  type MonitorDetail = { entity_name: string; processor: string; window_start: string; window_end: string; active_days: number; prorated: number };
  const monitorDetails: MonitorDetail[] = [];
  if (!client.disable_monitoring) {
    const { data: monitors } = await admin.from('entity_monitoring')
      .select('id, enrolled_at, cancelled_at, status, entity_id, request_entities!inner(entity_name, requests!inner(loan_number, profiles!requests_requested_by_fkey(full_name)))')
      .eq('client_id', client.id)
      .lte('enrolled_at', `${periodEnd}T23:59:59Z`)
      .or(`cancelled_at.is.null,cancelled_at.gte.${periodStart}`) as { data: any[] | null };
    const monitoringRate = client.billing_rate_monitoring ?? PRICE_POST_CLOSE_MONITORING_MONTHLY;
    const daysInMonth = 31;
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
      const prorated = Math.round(((Math.min(activeDays, daysInMonth) / daysInMonth) * monitoringRate) * 100) / 100;
      const re = (m.request_entities || {});
      monitorDetails.push({
        entity_name: re.entity_name || '(unknown entity)',
        processor: ((re.requests || {}).profiles || {}).full_name || 'Unattributed',
        window_start: new Date(windowStart).toISOString().slice(0, 10),
        window_end: new Date(windowEnd - 1).toISOString().slice(0, 10),
        active_days: activeDays,
        prorated,
      });
      monitoringAmount += prorated;
      monitoringEntities += 1;
    }
    monitoringAmount = Math.round(monitoringAmount * 100) / 100;
    monitorDetails.sort((a, b) => a.processor.localeCompare(b.processor) || a.entity_name.localeCompare(b.entity_name));

    // SUMMARY line on Mercury — per-enrollment detail goes in the email.
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

  // Mercury invoice: always DontSend. The customer-facing email is now
  // composed by us via SendGrid (below) so the per-processor / per-entity
  // breakdown + Mercury pay link land together in one rich email. Mercury's
  // default email would only show the summary line items.
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
    sendEmailOption: 'DontSend',
    servicePeriodStartDate: periodStart,
    servicePeriodEndDate: periodEnd,
    payerMemo: `*** TEST INVOICE *** — Preview of the May 2026 ${client.name} invoice. Reference: ${invoiceNumber}. Not for payment.`,
    internalNote: `TEST INVOICE for ${client.name} May 2026 preview. Do NOT send to real customer.`,
  });

  const payUrl = getMercuryPayUrl(mercuryInvoice.slug);
  const pdfUrl = getMercuryInvoicePdfUrl(mercuryInvoice.slug);
  L(`✓ Test Mercury invoice ${mercuryInvoice.id} created (DontSend)`);

  // --- SendGrid: itemized breakdown email + Mercury pay link ---
  // This is the customer-facing communication. The HTML mirrors the
  // /invoicing portal page (per-processor table + per-enrollment
  // monitoring detail) so the AP team sees exactly what they'd see in
  // the manager portal.
  if (mode === 'send_now' && process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const fmtDate = (s: string | null) => s ? s.slice(0, 10) : '';

    const procRows = processorGroups.map((g) => {
      const rows = g.entities.map((e) => `
        <tr>
          <td style="padding:6px 12px;font-size:13px;color:#1f2937;">${e.entity_name}${e.is_reorder ? ' <span style="background:#ede9fe;color:#6b21a8;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:600;">REORDER</span>' : ''}</td>
          <td style="padding:6px 12px;font-size:12px;color:#6b7280;">${e.form_type || '—'}</td>
          <td style="padding:6px 12px;font-size:12px;color:#6b7280;">${e.loan_number || '—'}</td>
          <td style="padding:6px 12px;font-size:12px;color:#6b7280;">${fmtDate(e.completed_at)}</td>
          <td style="padding:6px 12px;font-size:13px;color:#1f2937;text-align:right;font-family:ui-monospace,monospace;">${fmt(e.unit_price)}</td>
        </tr>`).join('');
      return `
        <tr><td colspan="5" style="padding:14px 12px 4px 12px;font-size:12px;font-weight:700;color:#295c9e;background:#f8fafc;border-top:1px solid #e5e7eb;">
          ${g.processor} · ${g.entities.length} ${g.entities.length === 1 ? 'entity' : 'entities'} · ${fmt(g.subtotal)} subtotal
        </td></tr>
        ${rows}`;
    }).join('');

    const monRows = monitorDetails.map((m) => `
      <tr>
        <td style="padding:6px 12px;font-size:13px;color:#1f2937;">${m.entity_name}</td>
        <td style="padding:6px 12px;font-size:12px;color:#6b7280;">${m.processor}</td>
        <td style="padding:6px 12px;font-size:12px;color:#6b7280;">${m.window_start} → ${m.window_end} (${m.active_days}/31 days)</td>
        <td style="padding:6px 12px;font-size:13px;color:#1f2937;text-align:right;font-family:ui-monospace,monospace;">${fmt(m.prorated)}</td>
      </tr>`).join('');

    const catchupRow = catchupLine
      ? `<tr><td colspan="4" style="padding:14px 12px 4px 12px;font-size:12px;font-weight:700;color:#b91c1c;background:#fef2f2;border-top:1px solid #e5e7eb;">${catchupLine.memo}</td></tr>
         <tr><td colspan="3" style="padding:6px 12px;font-size:13px;color:#1f2937;">Catch-up balance</td><td style="padding:6px 12px;font-size:13px;color:#1f2937;text-align:right;font-family:ui-monospace,monospace;">${fmt(catchupLine.amount)}</td></tr>`
      : '';

    const grandTotal = Math.round(lineItems.reduce((a, l) => a + l.unitPrice * l.quantity, 0) * 100) / 100;

    const html = `
<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:780px;margin:0 auto;color:#1a2845;">
  <div style="background:#f8fafc;padding:18px 24px;border-bottom:3px solid #00C48C;">
    <h2 style="margin:0;font-size:20px;color:#0a1929;">${client.name} — May 2026 Invoice</h2>
    <p style="margin:4px 0 0 0;font-size:13px;color:#475569;">Reference: <code>${invoiceNumber}</code> · Period: ${periodStart} → ${periodEnd}</p>
    ${process.env.NODE_ENV !== 'production' || invoiceNumber.startsWith('TEST') ? '<p style="margin:8px 0 0 0;font-size:11px;color:#b91c1c;font-weight:700;letter-spacing:.5px;">*** TEST INVOICE — NOT FOR PAYMENT ***</p>' : ''}
  </div>

  <div style="padding:24px;">
    <p style="font-size:14px;color:#1f2937;">Below is the full per-processor breakdown for May. Pay via the Mercury link at the bottom — ACH only, net ${5} days from invoice date.</p>

    <h3 style="margin:24px 0 8px 0;font-size:15px;color:#0a1929;">Tax Verification — by loan officer</h3>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;">Entity</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;">Form</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;">Loan</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;">Completed</th>
          <th style="padding:8px 12px;text-align:right;font-size:11px;color:#6b7280;text-transform:uppercase;">Amount</th>
        </tr>
      </thead>
      <tbody>${procRows || '<tr><td colspan="5" style="padding:12px;font-size:13px;color:#9ca3af;font-style:italic;">No verification activity in this period.</td></tr>'}</tbody>
    </table>

    ${monitorDetails.length > 0 ? `
    <h3 style="margin:24px 0 8px 0;font-size:15px;color:#0a1929;">Account Monitoring — by enrollment</h3>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;">Entity</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;">Loan Officer</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;">Window</th>
          <th style="padding:8px 12px;text-align:right;font-size:11px;color:#6b7280;text-transform:uppercase;">Prorated</th>
        </tr>
      </thead>
      <tbody>${monRows}</tbody>
    </table>` : ''}

    ${catchupLine ? `
    <h3 style="margin:24px 0 8px 0;font-size:15px;color:#b91c1c;">Catch-up balance</h3>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
      <tbody>${catchupRow}</tbody>
    </table>` : ''}

    <div style="margin-top:24px;padding:16px;background:#f0fdf4;border:1px solid #00C48C;border-radius:8px;text-align:right;">
      <div style="font-size:12px;color:#15803d;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Total Due</div>
      <div style="font-size:28px;font-weight:700;color:#0a1929;margin-top:2px;font-family:ui-monospace,monospace;">${fmt(grandTotal)}</div>
    </div>

    <div style="margin-top:24px;text-align:center;">
      <a href="${payUrl}" style="display:inline-block;background:#0a1929;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">Pay invoice via Mercury &nbsp;→</a>
      <p style="margin:12px 0 0 0;font-size:11px;color:#6b7280;">ACH Debit only · net ${5} days · payable to ModernTax Inc.</p>
    </div>

    <p style="margin-top:32px;font-size:12px;color:#6b7280;">Questions? Reply to this email or contact matt@moderntax.io. Full per-line audit trail also available in your <a href="https://portal.moderntax.io/invoicing" style="color:#295c9e;">invoicing portal</a>.</p>
  </div>

  <div style="background:#f8fafc;padding:14px 24px;font-size:11px;color:#94a3b8;border-top:1px solid #e5e7eb;">
    ModernTax Inc. · IRS Practitioner Priority Service · ${invoiceNumber}
  </div>
</div>`;

    // Generate the itemized PDF attachment — same content as the HTML body
    // so the AP team can file it alongside the Mercury PDF without logging
    // into the portal.
    let breakdownPdfBuffer: Buffer | null = null;
    try {
      breakdownPdfBuffer = await generateInvoiceBreakdownPdf({
        clientName: client.name,
        invoiceNumber,
        periodStart,
        periodEnd,
        grandTotal,
        payUrl,
        isTest: invoiceNumber.startsWith('TEST'),
        processorGroups,
        monitoringDetails: monitorDetails,
        catchupLine: catchupLine || null,
      });
      L(`✓ Breakdown PDF generated (${breakdownPdfBuffer.length} bytes)`);
    } catch (pdfErr: any) {
      L(`! Breakdown PDF generation failed: ${pdfErr?.message || pdfErr}`);
    }

    try {
      const attachments = breakdownPdfBuffer ? [{
        content: breakdownPdfBuffer.toString('base64'),
        filename: `${invoiceNumber}-breakdown.pdf`,
        type: 'application/pdf',
        disposition: 'attachment' as const,
      }] : undefined;

      await sgMail.send({
        to: testEmail,
        from: { email: 'no-reply@moderntax.io', name: 'ModernTax Invoicing' },
        subject: `${invoiceNumber} — ${client.name} — ${fmt(grandTotal)} due`,
        html,
        text: `${client.name} May 2026 invoice ${invoiceNumber}. Total due: ${fmt(grandTotal)}. Pay: ${payUrl}. Detailed per-processor breakdown attached as PDF; also viewable at https://portal.moderntax.io/invoicing.`,
        attachments,
      });
      L(`✓ SendGrid breakdown email sent to ${testEmail}${breakdownPdfBuffer ? ` with PDF attachment` : ''}`);
    } catch (err: any) {
      L(`! SendGrid send failed: ${err?.message || err}`);
    }
  }

  // --- Optional: persist to invoices table for portal preview ---
  let portalInvoiceId: string | null = null;
  if (persistForPortal && mode === 'send_now') {
    const breakdown = {
      processor_groups: processorGroups,
      monitoring_details: monitorDetails,
      catchup_line: catchupLine,
    };
    const { data: ins, error: persistErr } = await (admin.from('invoices') as any).insert({
      client_id: client.id,
      invoice_number: invoiceNumber,
      billing_period_start: periodStart,
      billing_period_end: periodEnd,
      total_entities: standardCount + reorderCount,
      total_amount: grandTotal,
      monitoring_entities: monitoringEntities,
      monitoring_amount: monitoringAmount,
      status: 'sent',
      payment_method: 'ach',
      due_date: dueDate.toISOString().split('T')[0],
      mercury_invoice_id: mercuryInvoice.id,
      mercury_pay_url: payUrl,
      breakdown,
      notes: `[TEST PORTAL PREVIEW] ${invoiceNumber}. Routed to ${testEmail} via the send-test-may-invoice endpoint. Not the real customer invoice.`,
    }).select('id').single();
    if (persistErr && /breakdown|column .* does not exist|PGRST204/i.test(persistErr?.message || '')) {
      L(`! breakdown column missing — retrying without it. Paste supabase/migration-invoices-breakdown.sql to enable portal rendering.`);
      const { data: ins2, error: persistErr2 } = await (admin.from('invoices') as any).insert({
        client_id: client.id,
        invoice_number: invoiceNumber,
        billing_period_start: periodStart,
        billing_period_end: periodEnd,
        total_entities: standardCount + reorderCount,
        total_amount: grandTotal,
        monitoring_entities: monitoringEntities,
        monitoring_amount: monitoringAmount,
        status: 'sent',
        payment_method: 'ach',
        due_date: dueDate.toISOString().split('T')[0],
        mercury_invoice_id: mercuryInvoice.id,
        mercury_pay_url: payUrl,
        notes: `[TEST PORTAL PREVIEW — breakdown not persisted, migration pending] ${invoiceNumber}.`,
      }).select('id').single();
      if (persistErr2) { L(`! local invoices insert failed: ${persistErr2.message}`); }
      else { portalInvoiceId = ins2?.id || null; L(`✓ persisted invoice row ${portalInvoiceId} (no breakdown)`); }
    } else if (persistErr) {
      L(`! local invoices insert failed: ${persistErr.message}`);
    } else {
      portalInvoiceId = ins?.id || null;
      L(`✓ persisted invoice row ${portalInvoiceId} with breakdown`);
    }
  }

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
    breakdown: {
      processor_groups: processorGroups,
      monitoring_details: monitorDetails,
      catchup_line: catchupLine,
    },
    grand_total: grandTotal,
    mercury: {
      invoice_id: mercuryInvoice.id,
      invoice_number: invoiceNumber,
      pdf_url: pdfUrl,
      pay_url: payUrl,
    },
    portal_invoice_id: portalInvoiceId,
    log,
  });
}
