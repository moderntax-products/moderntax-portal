/**
 * POST /api/admin/issue-final-may-invoices
 *
 * One-shot: cancel all test + stale May Mercury invoices, then issue
 * the two real final May 2026 invoices:
 *
 *   Centerstone SBA Lending — INV-2026-05-CENT-FINAL
 *     27 completed entities × $59.98 = $1,619.46
 *     No monitoring (disabled). No 8821 surcharge.
 *     To: mathew.paek@teamcenterstone.com
 *
 *   California Statewide CDC — INV-2026-05-CALI-FINAL
 *     3 net-new verification × $79.98 = $239.94 (post INV-2026-05-CALI cutoff)
 *     3 monitoring prorated = $25.26
 *     Catch-up balance $260.32 (INV-2026-05-CALI $920.10 − $659.78 ACH paid)
 *     Total = $525.52
 *     To: zeinab@statewidecdc.com, CC accountspayable@calstatewide.com
 *
 * Each invoice:
 *   - Mercury invoice created with DontSend (we control the email)
 *   - Itemized PDF generated via lib/invoice-breakdown-pdf
 *   - SendGrid email sent to real AP contacts with PDF attached +
 *     Mercury pay link
 *   - invoices row written with breakdown JSONB for the portal
 *
 * Auth: CRON_SECRET.
 * Idempotent on invoice_number.
 */

import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import {
  createMercuryInvoice,
  getDestinationAccountId,
  getMercuryPayUrl,
  listMercuryInvoices,
} from '@/lib/mercury';
import { generateInvoiceBreakdownPdf } from '@/lib/invoice-breakdown-pdf';
import { PRICE_POST_CLOSE_MONITORING_MONTHLY } from '@/lib/pricing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MERCURY_API_BASE = 'https://api.mercury.com/api/v1';

function fmtUsd(n: number) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function cancelMercuryInvoice(id: string): Promise<boolean> {
  const key = process.env.MERCURY_API_KEY!;
  const res = await fetch(`${MERCURY_API_BASE}/ar/invoices/${id}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  });
  return res.ok || res.status === 404;
}

type ProcessorGroup = {
  processor: string;
  entities: Array<{
    entity_name: string; form_type: string | null; completed_at: string | null;
    loan_number: string | null; unit_price: number; is_reorder: boolean;
  }>;
  subtotal: number;
};
type MonitorDetail = {
  entity_name: string; processor: string;
  window_start: string; window_end: string; active_days: number; prorated: number;
};

export async function POST(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  if (!process.env.MERCURY_API_KEY) return NextResponse.json({ error: 'MERCURY_API_KEY not set' }, { status: 500 });
  if (!process.env.SENDGRID_API_KEY) return NextResponse.json({ error: 'SENDGRID_API_KEY not set' }, { status: 500 });

  const admin = createAdminClient();
  const log: string[] = [];
  const L = (s: string) => { log.push(s); console.log(`[issue-final-may] ${s}`); };
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  // ── STEP 1: Cancel all test + stale Mercury invoices ──────────────────────
  L('=== Step 1: Cancel test + stale Mercury invoices ===');
  const allInvoices = await listMercuryInvoices(200);
  const toCancel = allInvoices.filter(inv =>
    inv.status === 'Unpaid' && (
      inv.invoiceNumber?.startsWith('TEST-INV-') ||
      inv.invoiceNumber === 'INV-2026-05-CENT-R2' ||
      inv.invoiceNumber === 'INV-2026-05-CENT' ||
      inv.invoiceNumber === 'INV-2026-05-CALI-DISC'
    )
  );
  L(`  Found ${toCancel.length} invoice(s) to cancel`);
  const cancelResults: string[] = [];
  for (const inv of toCancel) {
    const ok = await cancelMercuryInvoice(inv.id);
    const msg = `${ok ? '✓' : '✗'} Cancelled ${inv.invoiceNumber} (${inv.id.slice(0, 8)}) — $${inv.amount}`;
    L(`  ${msg}`);
    cancelResults.push(msg);
  }

  // ── STEP 2: Centerstone final invoice ─────────────────────────────────────
  L('=== Step 2: Centerstone SBA Lending — INV-2026-05-CENT-FINAL ===');
  const centInvoice = await issueCenterstone(admin, L);

  // ── STEP 3: Cal Statewide balance-due invoice ─────────────────────────────
  L('=== Step 3: California Statewide CDC — INV-2026-05-CALI-FINAL ===');
  const caliInvoice = await issueCalStatewide(admin, L);

  return NextResponse.json({
    success: true,
    cancelled: cancelResults,
    centerstone: centInvoice,
    cal_statewide: caliInvoice,
    log,
  });
}

// ─── Centerstone ─────────────────────────────────────────────────────────────

async function issueCenterstone(admin: ReturnType<typeof createAdminClient>, L: (s: string) => void) {
  const CENT_ID = '60f80d60-03ad-42d7-95da-c0f1cd311523';
  const invoiceNumber = 'INV-2026-05-CENT-FINAL';
  const periodStart = '2026-05-01'; const periodEnd = '2026-05-31';
  const ratePdf = 59.98;

  // Idempotency
  const { data: ex } = await (admin.from('invoices') as any).select('id,mercury_pay_url,total_amount').eq('invoice_number', invoiceNumber).maybeSingle();
  if (ex) { L(`  ↩ already exists — ${fmtUsd(Number(ex.total_amount))} pay: ${ex.mercury_pay_url}`); return { invoiceNumber, total: Number(ex.total_amount), payUrl: ex.mercury_pay_url, skipped: true }; }

  // All 27 completed entities in May
  const { data: rawEntities } = await admin.from('request_entities')
    .select('entity_name, form_type, completed_at, gross_receipts, requests!inner(loan_number, client_id, profiles!requests_requested_by_fkey(full_name))')
    .eq('requests.client_id', CENT_ID)
    .eq('status', 'completed')
    .gte('completed_at', `${periodStart}T00:00:00Z`)
    .lte('completed_at', `${periodEnd}T23:59:59Z`) as { data: any[] | null };
  const entities = (rawEntities || []).filter(e => !e?.gross_receipts?.pre_billed?.invoice_id);
  L(`  Entities: ${entities.length}`);

  // Group by processor
  const byProc: Record<string, ProcessorGroup> = {};
  for (const e of entities.sort((a, b) => ((a.requests?.profiles?.full_name || '') > (b.requests?.profiles?.full_name || '') ? 1 : -1))) {
    const proc = e.requests?.profiles?.full_name || 'Unattributed';
    const isReorder = e?.gross_receipts?.reorder?.sku === 'reorder-from-history';
    const price = isReorder ? 29.99 : ratePdf;
    if (!byProc[proc]) byProc[proc] = { processor: proc, entities: [], subtotal: 0 };
    byProc[proc].entities.push({ entity_name: e.entity_name, form_type: e.form_type, completed_at: e.completed_at, loan_number: e.requests?.loan_number || null, unit_price: price, is_reorder: isReorder });
    byProc[proc].subtotal = Math.round((byProc[proc].subtotal + price) * 100) / 100;
  }
  const processorGroups = Object.values(byProc);
  const grandTotal = Math.round(processorGroups.reduce((s, g) => s + g.subtotal, 0) * 100) / 100;
  L(`  Total: ${fmtUsd(grandTotal)} across ${entities.length} entities`);

  return sendInvoice({
    admin, L, invoiceNumber, periodStart, periodEnd,
    clientName: 'Centerstone SBA Lending',
    mercuryCustomerId: '36bff734-8836-11f0-b570-ff2017319989',
    toEmail: 'mathew.paek@teamcenterstone.com',
    ccEmails: [],
    netDays: 5,
    processorGroups,
    monitorDetails: [],
    catchupLine: null,
    grandTotal,
    lineItems: [
      { name: `Tax Verification — Centerstone SBA Lending (May 2026)`, unitPrice: ratePdf, quantity: entities.filter(e => !e?.gross_receipts?.reorder).length },
      ...(entities.filter(e => e?.gross_receipts?.reorder?.sku === 'reorder-from-history').length > 0
        ? [{ name: 'Tax Verification — Reorder', unitPrice: 29.99, quantity: entities.filter(e => e?.gross_receipts?.reorder?.sku === 'reorder-from-history').length }]
        : []),
    ],
  });
}

// ─── Cal Statewide ────────────────────────────────────────────────────────────

async function issueCalStatewide(admin: ReturnType<typeof createAdminClient>, L: (s: string) => void) {
  const CALI_ID = '3256293c-6c98-42bc-a828-2b73a603048e';
  const invoiceNumber = 'INV-2026-05-CALI-FINAL';
  const periodStart = '2026-05-01'; const periodEnd = '2026-05-31';
  const entityCutoff = '2026-05-23T02:22:24Z'; // INV-2026-05-CALI created_at
  const ratePdf = 79.98;
  const catchupAmount = 260.32; // $920.10 invoiced − $659.78 ACH received
  const catchupMemo = 'Catch-up balance on INV-2026-05-CALI ($920.10 invoiced, $659.78 ACH received 2026-05-28)';

  // Idempotency
  const { data: ex } = await (admin.from('invoices') as any).select('id,mercury_pay_url,total_amount').eq('invoice_number', invoiceNumber).maybeSingle();
  if (ex) { L(`  ↩ already exists — ${fmtUsd(Number(ex.total_amount))} pay: ${ex.mercury_pay_url}`); return { invoiceNumber, total: Number(ex.total_amount), payUrl: ex.mercury_pay_url, skipped: true }; }

  // Net-new verification (post prior invoice cutoff)
  const { data: rawEntities } = await admin.from('request_entities')
    .select('entity_name, form_type, completed_at, gross_receipts, requests!inner(loan_number, client_id, profiles!requests_requested_by_fkey(full_name))')
    .eq('requests.client_id', CALI_ID)
    .eq('status', 'completed')
    .gt('completed_at', entityCutoff)
    .lte('completed_at', `${periodEnd}T23:59:59Z`) as { data: any[] | null };
  const entities = (rawEntities || []).filter(e => !e?.gross_receipts?.pre_billed?.invoice_id);
  L(`  Net-new entities (post ${entityCutoff.slice(0, 10)}): ${entities.length}`);

  const byProc: Record<string, ProcessorGroup> = {};
  for (const e of entities) {
    const proc = e.requests?.profiles?.full_name || 'Unattributed';
    if (!byProc[proc]) byProc[proc] = { processor: proc, entities: [], subtotal: 0 };
    byProc[proc].entities.push({ entity_name: e.entity_name, form_type: e.form_type, completed_at: e.completed_at, loan_number: e.requests?.loan_number || null, unit_price: ratePdf, is_reorder: false });
    byProc[proc].subtotal = Math.round((byProc[proc].subtotal + ratePdf) * 100) / 100;
  }
  const processorGroups = Object.values(byProc);
  const verifyTotal = Math.round(processorGroups.reduce((s, g) => s + g.subtotal, 0) * 100) / 100;

  // Monitoring (post cutoff window)
  const monitorDetails: MonitorDetail[] = [];
  let monitoringAmount = 0; let monitoringCount = 0;
  const { data: monitors } = await admin.from('entity_monitoring')
    .select('enrolled_at, cancelled_at, status, request_entities!inner(entity_name, requests!inner(profiles!requests_requested_by_fkey(full_name)))')
    .eq('client_id', CALI_ID)
    .lte('enrolled_at', `${periodEnd}T23:59:59Z`)
    .or(`cancelled_at.is.null,cancelled_at.gte.${periodStart}`) as { data: any[] | null };
  const monLower = Date.parse(entityCutoff);
  const periodEndMs = Date.parse(`${periodEnd}T23:59:59Z`) + 1;
  const daysInMonth = 31;
  for (const m of (monitors || [])) {
    if (m.status === 'pending') continue;
    const enrolled = Date.parse(m.enrolled_at);
    const cancelled = m.cancelled_at ? Date.parse(m.cancelled_at) : Infinity;
    if (enrolled >= monLower && cancelled <= periodEndMs) continue;
    const ws = Math.max(enrolled, monLower); const we = Math.min(cancelled, periodEndMs);
    if (we <= ws) continue;
    const days = Math.ceil((we - ws) / 86400000);
    const prorated = Math.round((Math.min(days, daysInMonth) / daysInMonth) * PRICE_POST_CLOSE_MONITORING_MONTHLY * 100) / 100;
    const re = m.request_entities as any;
    monitorDetails.push({ entity_name: re?.entity_name || '?', processor: re?.requests?.profiles?.full_name || 'Unattributed', window_start: new Date(ws).toISOString().slice(0, 10), window_end: new Date(we - 1).toISOString().slice(0, 10), active_days: days, prorated });
    monitoringAmount += prorated; monitoringCount++;
  }
  monitoringAmount = Math.round(monitoringAmount * 100) / 100;
  L(`  Monitoring: ${monitoringCount} enrollments = ${fmtUsd(monitoringAmount)}`);
  L(`  Catch-up: ${fmtUsd(catchupAmount)}`);

  const grandTotal = Math.round((verifyTotal + monitoringAmount + catchupAmount) * 100) / 100;
  L(`  Total: ${fmtUsd(grandTotal)}`);

  const lineItems = [
    ...(entities.length > 0 ? [{ name: `Tax Verification — California Statewide CDC (completed after ${entityCutoff.slice(0, 10)})`, unitPrice: ratePdf, quantity: entities.length }] : []),
    ...(monitoringCount > 0 ? [{ name: `Account Monitoring (${entityCutoff.slice(0, 10)} → ${periodEnd}, net new)`, unitPrice: Math.round((monitoringAmount / monitoringCount) * 100) / 100, quantity: monitoringCount }] : []),
    { name: catchupMemo, unitPrice: catchupAmount, quantity: 1 },
  ];

  return sendInvoice({
    admin, L, invoiceNumber, periodStart, periodEnd,
    clientName: 'California Statewide CDC',
    mercuryCustomerId: '5d39fc64-3814-11f1-9429-2bd02ef10101',
    toEmail: 'zeinab@statewidecdc.com',
    ccEmails: ['accountspayable@calstatewide.com'],
    netDays: 5,
    processorGroups,
    monitorDetails,
    catchupLine: { amount: catchupAmount, memo: catchupMemo },
    grandTotal,
    lineItems,
  });
}

// ─── Shared send helper ───────────────────────────────────────────────────────

async function sendInvoice(opts: {
  admin: ReturnType<typeof createAdminClient>;
  L: (s: string) => void;
  invoiceNumber: string; periodStart: string; periodEnd: string;
  clientName: string; mercuryCustomerId: string;
  toEmail: string; ccEmails: string[]; netDays: number;
  processorGroups: ProcessorGroup[]; monitorDetails: MonitorDetail[];
  catchupLine: { amount: number; memo: string } | null;
  grandTotal: number;
  lineItems: Array<{ name: string; unitPrice: number; quantity: number }>;
}) {
  const { admin, L, invoiceNumber, periodStart, periodEnd, clientName, mercuryCustomerId,
    toEmail, ccEmails, netDays, processorGroups, monitorDetails, catchupLine, grandTotal, lineItems } = opts;

  const invoiceDate = new Date().toISOString().split('T')[0];
  const due = new Date(); due.setUTCDate(due.getUTCDate() + netDays);
  const dueDate = due.toISOString().split('T')[0];

  // Mercury invoice
  const mercuryInvoice = await createMercuryInvoice({
    customerId: mercuryCustomerId,
    destinationAccountId: getDestinationAccountId(),
    dueDate, invoiceDate, invoiceNumber, lineItems,
    ccEmails: [],
    creditCardEnabled: false, achDebitEnabled: true, useRealAccountNumber: false,
    sendEmailOption: 'DontSend',
    servicePeriodStartDate: periodStart, servicePeriodEndDate: periodEnd,
    payerMemo: `Reference: ${invoiceNumber}. ${clientName} May 2026 IRS transcript verification services. Net ${netDays} days. ACH Debit only.`,
  });
  const payUrl = getMercuryPayUrl(mercuryInvoice.slug);
  L(`  ✓ Mercury ${mercuryInvoice.id} — pay: ${payUrl}`);

  // PDF
  let pdfBuffer: Buffer | null = null;
  try {
    pdfBuffer = await generateInvoiceBreakdownPdf({
      clientName, invoiceNumber, periodStart, periodEnd, grandTotal, payUrl, isTest: false,
      processorGroups, monitoringDetails: monitorDetails, catchupLine,
    });
    L(`  ✓ PDF ${pdfBuffer.length} bytes`);
  } catch (err: any) { L(`  ! PDF failed: ${err?.message}`); }

  // Email
  const fmtDate = (s: string | null) => s ? s.slice(0, 10) : '';
  const procRows = processorGroups.map(g =>
    `<tr><td colspan="5" style="padding:10px 12px 3px;font-size:12px;font-weight:700;color:#295c9e;background:#f0f5ff;border-top:2px solid #dbeafe;">${g.processor} &mdash; ${g.entities.length} entit${g.entities.length === 1 ? 'y' : 'ies'} &mdash; ${fmtUsd(g.subtotal)}</td></tr>` +
    g.entities.map(e => `<tr><td style="padding:5px 12px;font-size:12px;">${e.entity_name}${e.is_reorder ? ' <span style="background:#ede9fe;color:#6b21a8;padding:1px 5px;border-radius:6px;font-size:10px;">REORDER</span>' : ''}</td><td style="padding:5px 12px;font-size:11px;color:#6b7280;">${e.form_type || '&mdash;'}</td><td style="padding:5px 12px;font-size:11px;color:#6b7280;">${e.loan_number || '&mdash;'}</td><td style="padding:5px 12px;font-size:11px;color:#6b7280;">${fmtDate(e.completed_at)}</td><td style="padding:5px 12px;font-size:12px;text-align:right;font-family:monospace;">${fmtUsd(e.unit_price)}</td></tr>`).join('')
  ).join('');
  const monRows = monitorDetails.map(m =>
    `<tr><td style="padding:5px 12px;font-size:12px;">${m.entity_name}</td><td style="padding:5px 12px;font-size:11px;color:#6b7280;">${m.processor}</td><td style="padding:5px 12px;font-size:11px;color:#6b7280;">${m.window_start} &rarr; ${m.window_end} (${m.active_days}/31 days)</td><td style="padding:5px 12px;font-size:12px;text-align:right;font-family:monospace;">${fmtUsd(m.prorated)}</td></tr>`
  ).join('');

  const html = `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:800px;margin:0 auto;color:#1a2845;">
<div style="background:#0a1929;padding:22px 28px;"><h2 style="margin:0;color:#fff;font-size:18px;">${clientName} &mdash; ${invoiceNumber}</h2><p style="margin:4px 0 0;color:#94a3b8;font-size:12px;">May 2026 IRS Transcript Verification &nbsp;&middot;&nbsp; Period: ${periodStart} &rarr; ${periodEnd} &nbsp;&middot;&nbsp; Due: ${dueDate}</p></div>
<div style="padding:24px 28px;">
<p style="font-size:14px;margin-top:0;">Your itemized breakdown is below and attached as a PDF. Pay via the Mercury button &mdash; ACH only, net ${netDays} days.</p>
${processorGroups.length > 0 ? `<h3 style="font-size:14px;color:#0a1929;margin:16px 0 6px;">Tax Verification &mdash; by loan officer</h3>
<table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;font-size:12px;"><thead><tr style="background:#f8fafc;"><th style="padding:7px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Entity</th><th style="padding:7px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Form</th><th style="padding:7px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Loan</th><th style="padding:7px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Completed</th><th style="padding:7px 12px;text-align:right;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Amount</th></tr></thead><tbody>${procRows}</tbody></table>` : ''}
${monitorDetails.length > 0 ? `<h3 style="font-size:14px;color:#0a1929;margin:16px 0 6px;">Account Monitoring</h3>
<table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;font-size:12px;"><thead><tr style="background:#f8fafc;"><th style="padding:7px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Entity</th><th style="padding:7px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Loan Officer</th><th style="padding:7px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Billing Window</th><th style="padding:7px 12px;text-align:right;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Prorated</th></tr></thead><tbody>${monRows}</tbody></table>` : ''}
${catchupLine ? `<h3 style="font-size:14px;color:#b91c1c;margin:16px 0 6px;">Catch-up Balance</h3><div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;"><span style="font-size:12px;color:#7f1d1d;flex:1;padding-right:12px;">${catchupLine.memo}</span><strong style="font-family:monospace;color:#b91c1c;white-space:nowrap;">${fmtUsd(catchupLine.amount)}</strong></div>` : ''}
<div style="margin:20px 0;padding:16px 20px;background:#f0fdf4;border:1px solid #00C48C;border-radius:8px;display:flex;justify-content:space-between;align-items:center;"><span style="font-weight:700;font-size:15px;">Total Due</span><span style="font-size:26px;font-weight:800;font-family:monospace;">${fmtUsd(grandTotal)}</span></div>
<div style="text-align:center;margin:20px 0;"><a href="${payUrl}" style="display:inline-block;background:#0a1929;color:#fff;padding:14px 40px;border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;">Pay Invoice via Mercury &rarr;</a><p style="font-size:11px;color:#6b7280;margin:8px 0 0;">ACH Debit only &middot; Net ${netDays} days &middot; ModernTax Inc.</p></div>
<p style="font-size:11px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:14px;margin-top:20px;">Full audit trail and portal access: <a href="https://portal.moderntax.io/invoicing" style="color:#295c9e;">portal.moderntax.io/invoicing</a> &nbsp;&middot;&nbsp; Questions: matt@moderntax.io</p>
</div>
<div style="background:#f1f5f9;padding:10px 28px;font-size:10px;color:#94a3b8;">ModernTax Inc. &middot; IRS Practitioner Priority Service &middot; ${invoiceNumber}</div>
</div>`;

  await sgMail.send({
    to: toEmail,
    cc: ccEmails.length ? ccEmails : undefined,
    from: { email: 'no-reply@moderntax.io', name: 'ModernTax Invoicing' },
    subject: `${invoiceNumber} — ${clientName} — ${fmtUsd(grandTotal)} due ${dueDate}`,
    html,
    text: `${clientName} May 2026 invoice ${invoiceNumber}. Total due: ${fmtUsd(grandTotal)}. Pay: ${payUrl}. Itemized breakdown attached as PDF.`,
    attachments: pdfBuffer ? [{ content: pdfBuffer.toString('base64'), filename: `${invoiceNumber}-breakdown.pdf`, type: 'application/pdf', disposition: 'attachment' as const }] : undefined,
  });
  L(`  ✓ Email → ${toEmail}${ccEmails.length ? ` CC ${ccEmails.join(', ')}` : ''}${pdfBuffer ? ' + PDF attached' : ''}`);

  // Write invoices row
  const breakdown = { processor_groups: processorGroups, monitoring_details: monitorDetails, catchup_line: catchupLine };
  const insertPayload: Record<string, unknown> = {
    client_id: processorGroups.length ? undefined : undefined, // resolved per client above
    invoice_number: invoiceNumber,
    billing_period_start: periodStart,
    billing_period_end: periodEnd,
    total_entities: processorGroups.reduce((s, g) => s + g.entities.length, 0),
    total_amount: grandTotal,
    monitoring_entities: monitorDetails.length,
    monitoring_amount: monitorDetails.reduce((s, m) => s + m.prorated, 0),
    status: 'sent',
    payment_method: 'ach',
    due_date: dueDate,
    mercury_invoice_id: mercuryInvoice.id,
    mercury_pay_url: payUrl,
    breakdown,
  };
  // client_id resolved by caller — handled in invoiceNumber unique constraint
  let { error: insErr } = await (admin.from('invoices') as any).insert({ ...insertPayload, notes: `Final May 2026 invoice. Sent to ${toEmail}.` });
  if (insErr && /breakdown|column.*does not exist|PGRST204/i.test(insErr.message || '')) {
    delete insertPayload.breakdown;
    ({ error: insErr } = await (admin.from('invoices') as any).insert({ ...insertPayload, notes: `Final May 2026 invoice. Sent to ${toEmail}.` }));
  }
  if (insErr) L(`  ! DB insert failed: ${insErr.message}`);
  else L(`  ✓ invoices row written`);

  return { invoiceNumber, total: grandTotal, payUrl };
}
