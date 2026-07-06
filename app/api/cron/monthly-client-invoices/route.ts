/**
 * GET /api/cron/monthly-client-invoices
 *
 * Fires on the last few days of each month. Internally checks whether
 * today is the last BUSINESS day (Mon-Fri) of the month — if not, exits
 * silently so the cron can run daily without double-billing.
 *
 * For each active per-TIN client (Centerstone, Cal Statewide, and any
 * future clients on the same model):
 *   1. Gathers all completed entities for the billing period.
 *   2. Generates the itemized PDF breakdown via lib/invoice-breakdown-pdf.
 *   3. Creates the Mercury invoice with DontSend (we control the email).
 *   4. Sends the SendGrid email to billing_ap_email with the PDF attached
 *      and the Mercury pay link prominent.
 *   5. Writes the invoices row with breakdown JSONB for the portal.
 *
 * Cal Statewide special case: if a prior partial-payment invoice exists
 * for the same period (INV-2026-05-CALI), computes a catch-up line so
 * only the balance owed is billed.
 *
 * Auth: CRON_SECRET.
 * Schedule: 0 6 28-31 * * (runs daily on days 28-31; last-biz-day check
 * inside prevents double execution). See vercel.json.
 *
 * Driver: 2026-05-29 Matt — "Set these to go out on the last business
 * day of each month for the rest of the year automatically."
 */

import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { PRICE_POST_CLOSE_MONITORING_MONTHLY, entityBillableRate } from '@/lib/pricing';
import {
  createMercuryInvoice,
  getDestinationAccountId,
  getMercuryPayUrl,
  getMercuryInvoicePdfUrl,
} from '@/lib/mercury';
import { generateInvoiceBreakdownPdf } from '@/lib/invoice-breakdown-pdf';
import { MONTHLY_1CLICK_CLIENTS } from '@/lib/monthly-invoice-clients';
import { signInvoiceSendToken } from '@/lib/invoice-send-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 min — enough for 2 clients × PDF + Mercury + email

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtUsd(n: number) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── Types ───────────────────────────────────────────────────────────────────

type EntityRow = {
  entity_name: string;
  form_type: string | null;
  completed_at: string | null;
  gross_receipts: any;
  requests: { loan_number: string | null; profiles: { full_name: string | null } | null } | null;
};

type MonitorRow = {
  enrolled_at: string;
  cancelled_at: string | null;
  status: string;
  request_entities: { entity_name: string; requests: { profiles: { full_name: string | null } | null } | null } | null;
};

type ProcessorGroup = {
  processor: string;
  entities: Array<{ entity_name: string; form_type: string | null; completed_at: string | null; loan_number: string | null; unit_price: number; is_reorder: boolean; is_filing_compliance: boolean }>;
  subtotal: number;
};

type MonitorDetail = {
  entity_name: string; processor: string;
  window_start: string; window_end: string; active_days: number; prorated: number;
};

// ─── Per-client invoice builder ───────────────────────────────────────────────

export async function issueMonthlyInvoice(
  admin: ReturnType<typeof createAdminClient>,
  clientId: string,
  periodStart: string, // YYYY-MM-DD
  periodEnd: string,
  log: string[],
  // Optional recipient override (e.g. send to managers + AP instead of AP-only).
  // When provided, the breakdown email goes to `to` (cc `cc`); otherwise it
  // falls back to the client's billing_ap_email / billing_ap_email_cc.
  recipients?: { to: string[]; cc?: string[] },
  // When true, the invoice is generated as a DRAFT and NO client email is sent
  // — the caller sends it later with one click. Used by the 1-click monthly cron.
  deferSend = false,
): Promise<{ invoiceNumber: string; total: number; payUrl: string; invoiceId?: string | null; dueDate?: string; netDays?: number } | null> {
  const L = (s: string) => { log.push(s); console.log(`[monthly-invoice] ${s}`); };

  // Pull client config
  const { data: client } = await admin.from('clients')
    .select('id, name, slug, billing_ap_email, billing_ap_email_cc, billing_net_days, billing_payment_method, billing_rate_pdf, billing_rate_monitoring, disable_monitoring, mercury_customer_id')
    .eq('id', clientId).single() as { data: any };
  if (!client) { L(`✗ client ${clientId} not found`); return null; }
  L(`Client: ${client.name}`);

  // Idempotency — skip if invoice already issued for this period
  const slugUpper = (client.slug || client.name).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  const [y, m] = periodStart.split('-');
  const invoiceNumber = `INV-${y}-${m}-${slugUpper}`;
  const { data: existing } = await (admin.from('invoices') as any)
    .select('id, invoice_number, total_amount, status, mercury_pay_url, due_date')
    .eq('invoice_number', invoiceNumber).maybeSingle();
  if (existing) {
    L(`  ↩ already issued: ${invoiceNumber} ($${existing.total_amount}, ${existing.status}) — skipping`);
    return { invoiceNumber: existing.invoice_number, total: Number(existing.total_amount), payUrl: existing.mercury_pay_url || '', invoiceId: existing.id, dueDate: existing.due_date };
  }

  const ratePdf = Number(client.billing_rate_pdf || 99.99);
  const monitoringRate = client.billing_rate_monitoring ?? PRICE_POST_CLOSE_MONITORING_MONTHLY;
  const periodStartMs = Date.parse(`${periodStart}T00:00:00Z`);
  const periodEndMs = Date.parse(`${periodEnd}T23:59:59Z`) + 1;

  // ── Does a prior partial-payment invoice exist for the same period? ──────
  // If so, compute a catch-up line for the unpaid balance.
  const { data: priorInvoices } = await (admin.from('invoices') as any)
    .select('invoice_number, total_amount, paid_at')
    .eq('client_id', clientId)
    .gte('billing_period_start', periodStart)
    .lte('billing_period_end', periodEnd)
    .neq('invoice_number', invoiceNumber);
  // Payments on prior invoices come from the known-amounts map below;
  // paid_at is flipped by the mercury-reconcile cron once ACH clears.
  // Cal Statewide specific: $659.78 paid on INV-2026-05-CALI
  const knownPriorPayments: Record<string, number> = {
    'INV-2026-05-CALI': 659.78,
  };
  let catchupAmount = 0;
  let catchupMemo = '';
  for (const inv of (priorInvoices || [])) {
    const paid = knownPriorPayments[inv.invoice_number] || 0;
    const owed = Number(inv.total_amount) - paid;
    if (owed > 0.01) {
      catchupAmount = Math.round(owed * 100) / 100;
      catchupMemo = `Catch-up balance on ${inv.invoice_number} (${fmtUsd(Number(inv.total_amount))} invoiced, ${fmtUsd(paid)} ACH received)`;
      L(`  Catch-up: ${catchupMemo}`);
    }
  }

  // ── Entities: find cutoff (date of prior invoice, if any) ───────────────
  let entityCutoff = periodStartMs;
  if (priorInvoices && priorInvoices.length > 0) {
    const { data: priorRow } = await (admin.from('invoices') as any)
      .select('created_at').eq('invoice_number', (priorInvoices[0] as any).invoice_number).single();
    if (priorRow?.created_at) {
      entityCutoff = Date.parse(priorRow.created_at);
      L(`  Entity cutoff: ${new Date(entityCutoff).toISOString()} (from prior invoice)`);
    }
  }

  // Select credit_paid so entities already paid from the prepaid credit wallet
  // are excluded from the Mercury invoice (no double-billing). Two-phase: if the
  // column isn't migrated yet, fall back (no credit clients exist pre-migration,
  // so there's nothing to exclude).
  const entitySelectBase = 'entity_name, form_type, completed_at, gross_receipts, requests!inner(loan_number, client_id, profiles!requests_requested_by_fkey(full_name))';
  let rawEntities: EntityRow[] | null = null;
  {
    const withCredit = await admin.from('request_entities')
      .select(`${entitySelectBase}, credit_paid`)
      .eq('requests.client_id', clientId)
      .eq('status', 'completed')
      .gt('completed_at', new Date(entityCutoff).toISOString())
      .lte('completed_at', `${periodEnd}T23:59:59Z`) as { data: EntityRow[] | null; error: any };
    if (withCredit.error && /credit_paid|column .* does not exist|PGRST/i.test(withCredit.error.message || '')) {
      const fallback = await admin.from('request_entities')
        .select(entitySelectBase)
        .eq('requests.client_id', clientId)
        .eq('status', 'completed')
        .gt('completed_at', new Date(entityCutoff).toISOString())
        .lte('completed_at', `${periodEnd}T23:59:59Z`) as { data: EntityRow[] | null };
      rawEntities = fallback.data;
    } else {
      rawEntities = withCredit.data;
    }
  }

  const entities = (rawEntities || []).filter(e => !e.gross_receipts?.pre_billed?.invoice_id && !(e as any).credit_paid);
  L(`  Entities: ${entities.length} billable`);

  // ── Build processor groups ───────────────────────────────────────────────
  const byProc: Record<string, ProcessorGroup> = {};
  for (const e of entities) {
    const proc = (e.requests as any)?.profiles?.full_name || 'Unattributed';
    const { price, kind } = entityBillableRate(e.gross_receipts, ratePdf);
    if (!byProc[proc]) byProc[proc] = { processor: proc, entities: [], subtotal: 0 };
    byProc[proc].entities.push({ entity_name: e.entity_name, form_type: e.form_type, completed_at: e.completed_at, loan_number: (e.requests as any)?.loan_number || null, unit_price: price, is_reorder: kind === 'reorder', is_filing_compliance: kind === 'filing_compliance' });
    byProc[proc].subtotal = Math.round((byProc[proc].subtotal + price) * 100) / 100;
  }
  const processorGroups = Object.values(byProc).sort((a, b) => a.processor.localeCompare(b.processor));
  const verifyTotal = processorGroups.reduce((s, g) => s + g.subtotal, 0);

  // ── Monitoring ───────────────────────────────────────────────────────────
  let monitoringAmount = 0;
  let monitoringEntities = 0;
  const monitorDetails: MonitorDetail[] = [];
  if (!client.disable_monitoring) {
    const monLower = Math.max(entityCutoff, periodStartMs);
    const { data: monitors } = await admin.from('entity_monitoring')
      .select('enrolled_at, cancelled_at, status, request_entities!inner(entity_name, requests!inner(profiles!requests_requested_by_fkey(full_name)))')
      .eq('client_id', clientId)
      .lte('enrolled_at', `${periodEnd}T23:59:59Z`)
      .or(`cancelled_at.is.null,cancelled_at.gte.${periodStart}`) as { data: MonitorRow[] | null };
    const daysInMonth = new Date(Number(y), Number(m), 0).getDate();
    for (const mon of (monitors || [])) {
      if (mon.status === 'pending') continue;
      const enrolled = Date.parse(mon.enrolled_at);
      const cancelled = mon.cancelled_at ? Date.parse(mon.cancelled_at) : Infinity;
      if (enrolled >= monLower && cancelled <= periodEndMs) continue;
      const ws = Math.max(enrolled, monLower);
      const we = Math.min(cancelled, periodEndMs);
      if (we <= ws) continue;
      const days = Math.ceil((we - ws) / 86400000);
      const prorated = Math.round((Math.min(days, daysInMonth) / daysInMonth) * monitoringRate * 100) / 100;
      const re = mon.request_entities as any;
      monitorDetails.push({ entity_name: re?.entity_name || '?', processor: re?.requests?.profiles?.full_name || 'Unattributed', window_start: new Date(ws).toISOString().slice(0, 10), window_end: new Date(we - 1).toISOString().slice(0, 10), active_days: days, prorated });
      monitoringAmount += prorated;
      monitoringEntities++;
    }
    monitoringAmount = Math.round(monitoringAmount * 100) / 100;
    monitorDetails.sort((a, b) => a.processor.localeCompare(b.processor) || a.entity_name.localeCompare(b.entity_name));
    L(`  Monitoring: ${monitoringEntities} enrollments = ${fmtUsd(monitoringAmount)}`);
  }

  const grandTotal = Math.round((verifyTotal + monitoringAmount + catchupAmount) * 100) / 100;
  if (grandTotal < 0.01 && !catchupAmount) { L(`  Nothing to bill — skipping`); return null; }
  L(`  Grand total: ${fmtUsd(grandTotal)}`);

  // ── Mercury line items (summary) ─────────────────────────────────────────
  const lineItems: Array<{ name: string; unitPrice: number; quantity: number }> = [];
  const stdCount = processorGroups.reduce((s, g) => s + g.entities.filter(e => !e.is_reorder && !e.is_filing_compliance).length, 0);
  const reoCount = processorGroups.reduce((s, g) => s + g.entities.filter(e => e.is_reorder).length, 0);
  const fcCount = processorGroups.reduce((s, g) => s + g.entities.filter(e => e.is_filing_compliance).length, 0);
  if (stdCount > 0) lineItems.push({ name: `Tax Verification — ${client.name} (${periodStart.slice(0, 7)})`, unitPrice: ratePdf, quantity: stdCount });
  if (reoCount > 0) lineItems.push({ name: 'Tax Verification — Reorder', unitPrice: 29.99, quantity: reoCount });
  if (fcCount > 0) lineItems.push({ name: 'Filing-Compliance Report', unitPrice: 29.99, quantity: fcCount });
  if (monitoringEntities > 0) lineItems.push({ name: `Account Monitoring (${periodStart} → ${periodEnd})`, unitPrice: Math.round((monitoringAmount / monitoringEntities) * 100) / 100, quantity: monitoringEntities });
  if (catchupAmount > 0) lineItems.push({ name: catchupMemo, unitPrice: catchupAmount, quantity: 1 });

  // ── Mercury invoice ───────────────────────────────────────────────────────
  if (!process.env.MERCURY_API_KEY) { L(`  ✗ MERCURY_API_KEY not set`); return null; }
  const netDays = client.billing_net_days ?? 5;
  const invoiceDate = new Date().toISOString().split('T')[0];
  const due = new Date(); due.setUTCDate(due.getUTCDate() + netDays);
  const dueDate = due.toISOString().split('T')[0];

  const mercuryInvoice = await createMercuryInvoice({
    customerId: client.mercury_customer_id,
    destinationAccountId: getDestinationAccountId(),
    dueDate,
    invoiceDate,
    invoiceNumber,
    lineItems,
    ccEmails: client.billing_ap_email_cc || [],
    creditCardEnabled: false,
    achDebitEnabled: true,
    useRealAccountNumber: false,
    sendEmailOption: 'DontSend', // We send our own via SendGrid below
    servicePeriodStartDate: periodStart,
    servicePeriodEndDate: periodEnd,
    payerMemo: `Reference: ${invoiceNumber}. ${client.name} ${periodStart.slice(0, 7)} IRS transcript verification. Net ${netDays} days. ACH Debit only.`,
  });
  const payUrl = getMercuryPayUrl(mercuryInvoice.slug);
  getMercuryInvoicePdfUrl(mercuryInvoice.slug); // available in Mercury dashboard
  L(`  ✓ Mercury invoice ${mercuryInvoice.id} (DontSend) — pay: ${payUrl}`);

  // ── Breakdown PDF ─────────────────────────────────────────────────────────
  const catchupLine = catchupAmount > 0 ? { amount: catchupAmount, memo: catchupMemo } : null;
  let pdfBuffer: Buffer | null = null;
  if (!deferSend) try {
    pdfBuffer = await generateInvoiceBreakdownPdf({
      clientName: client.name,
      invoiceNumber,
      periodStart,
      periodEnd,
      grandTotal,
      payUrl,
      isTest: false,
      processorGroups,
      monitoringDetails: monitorDetails,
      catchupLine,
    });
    L(`  ✓ Breakdown PDF generated (${pdfBuffer.length} bytes)`);
  } catch (err: any) {
    L(`  ! PDF generation failed: ${err?.message}`);
  }

  // ── SendGrid email ────────────────────────────────────────────────────────
  // Recipients: explicit override (managers + AP) when provided, else AP-only.
  const emailTo = recipients?.to?.length ? recipients.to : (client.billing_ap_email ? [client.billing_ap_email] : []);
  const emailCc = recipients?.to?.length
    ? (recipients.cc || [])
    : (client.billing_ap_email_cc?.length ? client.billing_ap_email_cc : []);
  if (!deferSend && process.env.SENDGRID_API_KEY && emailTo.length) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    const fmtDate = (s: string | null) => s ? s.slice(0, 10) : '';
    const procRows = processorGroups.map(g =>
      `<tr><td colspan="5" style="padding:12px 12px 3px;font-size:12px;font-weight:700;color:#295c9e;background:#f0f5ff;border-top:1px solid #e5e7eb;">${g.processor} &mdash; ${g.entities.length} ${g.entities.length === 1 ? 'entity' : 'entities'} &mdash; ${fmtUsd(g.subtotal)}</td></tr>` +
      g.entities.map(e => `<tr><td style="padding:5px 12px;font-size:12px;">${e.entity_name}${e.is_reorder ? ' <span style="background:#ede9fe;color:#6b21a8;padding:1px 5px;border-radius:6px;font-size:10px;">REORDER</span>' : ''}</td><td style="padding:5px 12px;font-size:11px;color:#6b7280;">${e.form_type || '&mdash;'}</td><td style="padding:5px 12px;font-size:11px;color:#6b7280;">${e.loan_number || '&mdash;'}</td><td style="padding:5px 12px;font-size:11px;color:#6b7280;">${fmtDate(e.completed_at)}</td><td style="padding:5px 12px;font-size:12px;text-align:right;font-family:monospace;">${fmtUsd(e.unit_price)}</td></tr>`).join('')
    ).join('');

    const monRows = monitorDetails.map(m =>
      `<tr><td style="padding:5px 12px;font-size:12px;">${m.entity_name}</td><td style="padding:5px 12px;font-size:11px;color:#6b7280;">${m.processor}</td><td style="padding:5px 12px;font-size:11px;color:#6b7280;">${m.window_start} &rarr; ${m.window_end} (${m.active_days}/31 days)</td><td style="padding:5px 12px;font-size:12px;text-align:right;font-family:monospace;">${fmtUsd(m.prorated)}</td></tr>`
    ).join('');

    const html = `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:800px;margin:0 auto;color:#1a2845;">
<div style="background:#0a1929;padding:20px 28px;"><h2 style="margin:0;color:#fff;font-size:18px;">${client.name} &mdash; Invoice ${invoiceNumber}</h2><p style="margin:4px 0 0;color:#94a3b8;font-size:12px;">Period: ${periodStart} &rarr; ${periodEnd} &nbsp;&middot;&nbsp; Due: ${dueDate} &nbsp;&middot;&nbsp; ACH Debit only</p></div>
<div style="padding:24px 28px;">
<p style="font-size:14px;">Please find your itemized breakdown below and the PDF attached. Pay via Mercury using the button at the bottom &mdash; ACH only, net ${netDays} days.</p>
${processorGroups.length > 0 ? `<h3 style="font-size:14px;color:#0a1929;margin:20px 0 6px;">Tax Verification &mdash; by loan officer</h3>
<table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;"><thead><tr style="background:#f8fafc;"><th style="padding:7px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Entity</th><th style="padding:7px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Form</th><th style="padding:7px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Loan</th><th style="padding:7px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Completed</th><th style="padding:7px 12px;text-align:right;font-size:10px;color:#6b7280;text-transform:uppercase;">Amount</th></tr></thead><tbody>${procRows}</tbody></table>` : ''}
${monitorDetails.length > 0 ? `<h3 style="font-size:14px;color:#0a1929;margin:20px 0 6px;">Account Monitoring</h3>
<table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;"><thead><tr style="background:#f8fafc;"><th style="padding:7px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Entity</th><th style="padding:7px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Loan Officer</th><th style="padding:7px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Window</th><th style="padding:7px 12px;text-align:right;font-size:10px;color:#6b7280;text-transform:uppercase;">Prorated</th></tr></thead><tbody>${monRows}</tbody></table>` : ''}
${catchupLine ? `<h3 style="font-size:14px;color:#b91c1c;margin:20px 0 6px;">Catch-up Balance</h3><div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:12px 16px;display:flex;justify-content:space-between;"><span style="font-size:13px;color:#7f1d1d;">${catchupLine.memo}</span><strong style="font-family:monospace;color:#7f1d1d;">${fmtUsd(catchupLine.amount)}</strong></div>` : ''}
<div style="margin:24px 0;padding:18px 24px;background:#f0fdf4;border:1px solid #00C48C;border-radius:8px;display:flex;justify-content:space-between;align-items:center;"><span style="font-weight:700;color:#0a1929;font-size:15px;">Total Due</span><span style="font-size:26px;font-weight:800;color:#0a1929;font-family:monospace;">${fmtUsd(grandTotal)}</span></div>
<div style="text-align:center;margin:24px 0;"><a href="${payUrl}" style="display:inline-block;background:#0a1929;color:#fff;padding:14px 36px;border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;">Pay Invoice via Mercury &rarr;</a><p style="font-size:11px;color:#6b7280;margin:8px 0 0;">ACH Debit only &middot; Net ${netDays} days &middot; ModernTax Inc.</p></div>
<p style="font-size:12px;color:#6b7280;margin-top:24px;">Full audit trail also at <a href="https://portal.moderntax.io/invoicing" style="color:#295c9e;">portal.moderntax.io/invoicing</a>. Questions? matt@moderntax.io</p>
</div>
<div style="background:#f8fafc;padding:12px 28px;font-size:10px;color:#94a3b8;border-top:1px solid #e5e7eb;">ModernTax Inc. &middot; IRS Practitioner Priority Service &middot; ${invoiceNumber}</div>
</div>`;

    try {
      await sgMail.send({
        to: emailTo,
        cc: emailCc.length ? emailCc : undefined,
        // active-accounts@ delivers reliably; no-reply@ was getting filtered.
        from: { email: 'active-accounts@moderntax.io', name: 'ModernTax Invoicing' },
        subject: `${invoiceNumber} — ${client.name} — ${fmtUsd(grandTotal)} due ${dueDate}`,
        html,
        text: `${client.name} ${periodStart.slice(0, 7)} invoice ${invoiceNumber}. Total due: ${fmtUsd(grandTotal)}. Pay: ${payUrl}. Itemized breakdown attached as PDF and viewable at https://portal.moderntax.io/invoicing.`,
        attachments: pdfBuffer ? [{ content: pdfBuffer.toString('base64'), filename: `${invoiceNumber}-breakdown.pdf`, type: 'application/pdf', disposition: 'attachment' as const }] : undefined,
      });
      L(`  ✓ SendGrid sent to ${client.billing_ap_email}${pdfBuffer ? ' with PDF' : ''}`);
    } catch (err: any) {
      L(`  ! SendGrid failed: ${err?.message}`);
    }
  }

  // ── Write invoices row ────────────────────────────────────────────────────
  const breakdown = { processor_groups: processorGroups, monitoring_details: monitorDetails, catchup_line: catchupLine };
  const insertPayload: Record<string, unknown> = {
    client_id: clientId,
    invoice_number: invoiceNumber,
    billing_period_start: periodStart,
    billing_period_end: periodEnd,
    total_entities: entities.length,
    total_amount: grandTotal,
    monitoring_entities: monitoringEntities,
    monitoring_amount: monitoringAmount,
    status: deferSend ? 'draft' : 'sent',
    payment_method: 'ach',
    due_date: dueDate,
    mercury_invoice_id: mercuryInvoice.id,
    mercury_pay_url: payUrl,
    breakdown,
  };
  let invoiceId: string | null = null;
  let { data: insRow, error: insErr } = await (admin.from('invoices') as any).insert(insertPayload).select('id').single();
  if (insErr && /breakdown|column.*does not exist|PGRST204/i.test(insErr.message || '')) {
    delete insertPayload.breakdown;
    ({ data: insRow, error: insErr } = await (admin.from('invoices') as any).insert(insertPayload).select('id').single());
  }
  if (insErr) L(`  ! invoices insert failed: ${insErr.message}`);
  else { invoiceId = insRow?.id || null; L(`  ✓ invoices ${deferSend ? 'DRAFT' : 'row'} written (${invoiceId})`); }

  return { invoiceNumber, total: grandTotal, payUrl, invoiceId, dueDate, netDays };
}

// ─── Route handler ────────────────────────────────────────────────────────────

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'matt@moderntax.io';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

/** Email Matt one summary with a signed 1-click "send to client" link per draft. */
async function sendReadyToSendSummary(
  ready: Array<{ name: string; invoiceNumber: string; total: number; invoiceId: string; dueDate: string }>,
  periodMonth: string,
): Promise<void> {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY!);
  const rows = ready.map(r => {
    const link = `${APP_URL}/api/public/invoice-send/${signInvoiceSendToken(r.invoiceId)}`;
    return `<tr><td style="padding:9px 12px;border-bottom:1px solid #eee;">${r.name}<br><span style="color:#6b7280;font-size:11px;">${r.invoiceNumber}</span></td><td style="padding:9px 12px;border-bottom:1px solid #eee;text-align:right;font-family:monospace;">${fmtUsd(r.total)}</td><td style="padding:9px 12px;border-bottom:1px solid #eee;color:#6b7280;font-size:12px;">due ${r.dueDate}</td><td style="padding:9px 12px;border-bottom:1px solid #eee;text-align:right;"><a href="${link}" style="display:inline-block;background:#0a1929;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:700;font-size:13px;">Review &amp; send &rarr;</a></td></tr>`;
  }).join('');
  await sgMail.send({
    to: ADMIN_EMAIL,
    from: { email: 'no-reply@moderntax.io', name: 'ModernTax Invoicing' },
    subject: `${ready.length} invoice${ready.length === 1 ? '' : 's'} ready to send — ${periodMonth}`,
    html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a2845;">
<h2 style="font-size:18px;">Monthly invoices ready to send — ${periodMonth}</h2>
<p style="font-size:14px;color:#374151;">Generated as drafts at 7pm PT on the last day of the month. Click <b>Review &amp; send</b> to email each client &mdash; you'll see a confirmation page first, and the invoice is only marked sent once the client email actually goes out.</p>
<table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;margin-top:12px;"><tbody>${rows}</tbody></table>
<p style="font-size:12px;color:#6b7280;margin-top:16px;">Full audit trail at <a href="${APP_URL}/invoicing">portal.moderntax.io/invoicing</a>.</p>
</div>`,
    text: `${ready.length} invoices ready to send (${periodMonth}): ` + ready.map(r => `${r.name} ${r.invoiceNumber} ${fmtUsd(r.total)} → ${APP_URL}/api/public/invoice-send/${signInvoiceSendToken(r.invoiceId)}`).join(' | '),
  });
}

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const now = new Date();
  const forceRun = request.nextUrl.searchParams.get('force') === '1';

  // Fire at 7pm PT on the LAST CALENDAR DAY of the month. Vercel crons are UTC
  // and DST-blind, so this is scheduled at 02:00 + 03:00 UTC on the 1st (= 7pm PT
  // on the last day of the prior month in PDT / PST respectively) and gated on the
  // real PT wall-clock so exactly one run fires, year-round. The billing period is
  // that prior PT month.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(now);
  const pt = (t: string) => Number(parts.find(p => p.type === t)?.value);
  const ptYear = pt('year'), ptMonth = pt('month'), ptDay = pt('day');
  let ptHour = pt('hour'); if (ptHour === 24) ptHour = 0; // Intl emits '24' at midnight
  const lastDayPt = new Date(Date.UTC(ptYear, ptMonth, 0)).getUTCDate();

  if (!forceRun && !(ptHour === 19 && ptDay === lastDayPt)) {
    return NextResponse.json({
      skipped: true,
      reason: `Not 7pm PT on the last day of the month (PT now: ${ptYear}-${String(ptMonth).padStart(2, '0')}-${String(ptDay).padStart(2, '0')} ${ptHour}:00; last day is ${lastDayPt}). Pass ?force=1 to override.`,
    });
  }

  const admin = createAdminClient();
  const log: string[] = [];
  const pad = (n: number) => String(n).padStart(2, '0');
  const periodStart = `${ptYear}-${pad(ptMonth)}-01`;
  const periodEnd = `${ptYear}-${pad(ptMonth)}-${pad(lastDayPt)}`;

  const results: Array<{ client: string; invoiceNumber?: string; total?: number; invoiceId?: string | null; error?: string }> = [];
  const ready: Array<{ name: string; invoiceNumber: string; total: number; invoiceId: string; dueDate: string }> = [];

  // Generate each invoice as a DRAFT (deferSend=true) — no client email yet.
  for (const client of MONTHLY_1CLICK_CLIENTS) {
    try {
      const result = await issueMonthlyInvoice(admin, client.id, periodStart, periodEnd, log, undefined, true);
      if (result) {
        results.push({ client: client.name, invoiceNumber: result.invoiceNumber, total: result.total, invoiceId: result.invoiceId });
        if (result.invoiceId) ready.push({ name: client.name, invoiceNumber: result.invoiceNumber, total: result.total, invoiceId: result.invoiceId, dueDate: result.dueDate || periodEnd });
      } else {
        results.push({ client: client.name, error: 'Nothing to bill' });
      }
    } catch (err: any) {
      log.push(`✗ ${client.name}: ${err?.message}`);
      results.push({ client: client.name, error: err?.message });
    }
  }

  // Email Matt one summary with a 1-click send link per draft (see-it-first).
  if (ready.length && process.env.SENDGRID_API_KEY) {
    try {
      await sendReadyToSendSummary(ready, periodStart.slice(0, 7));
      log.push(`✓ ready-to-send summary emailed to ${ADMIN_EMAIL} (${ready.length} draft${ready.length === 1 ? '' : 's'})`);
    } catch (err: any) {
      log.push(`! summary email failed: ${err?.message}`);
    }
  }

  return NextResponse.json({ success: true, period: { start: periodStart, end: periodEnd }, drafts_ready: ready.length, results, log });
}
