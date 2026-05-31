/**
 * POST /api/admin/issue-final-may-invoices
 *
 * One-shot production invoice run for May 2026.
 *
 * CENTERSTONE: 27 entities × $59.98 = $1,619.46. No monitoring (disabled).
 * CAL STATEWIDE: 3 net-new entities × $79.98 = $239.94, monitoring $25.26,
 *   catch-up $260.32 (INV-2026-05-CALI was $920.10 invoiced, $659.78 paid).
 *   Total: $525.52.
 *
 * Each invoice: Mercury (DontSend) → PDF → SendGrid w/ PDF attached → DB row.
 * Idempotent: skips if INV-2026-05-CENT or INV-2026-05-CALI already in DB.
 *
 * Auth: CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { PRICE_POST_CLOSE_MONITORING_MONTHLY } from '@/lib/pricing';
import {
  createMercuryInvoice,
  getDestinationAccountId,
  getMercuryPayUrl,
} from '@/lib/mercury';
import { generateInvoiceBreakdownPdf } from '@/lib/invoice-breakdown-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const PERIOD_START = '2026-05-01';
const PERIOD_END   = '2026-05-31';
const CALI_PRIOR_CUTOFF = '2026-05-23T02:22:24Z'; // INV-2026-05-CALI created_at
const CALI_PRIOR_INV = 'INV-2026-05-CALI';
const CALI_PRIOR_PAID = 659.78;

function fmt(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function issueInvoice(
  admin: ReturnType<typeof createAdminClient>,
  clientId: string,
  entityCutoff: string | null,
  catchupInvoiceNumber: string | null,
  knownPriorPaid: number,
  log: string[],
) {
  const L = (s: string) => { log.push(s); console.log('[issue-may] ' + s); };

  const { data: client } = await admin.from('clients')
    .select('id,name,slug,billing_ap_email,billing_ap_email_cc,billing_net_days,billing_rate_pdf,billing_rate_monitoring,disable_monitoring,mercury_customer_id')
    .eq('id', clientId).single() as { data: any };
  if (!client) { L('client not found'); return null; }
  L('\n=== ' + client.name + ' ===');

  const slugUpper = (client.slug || client.name).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  // -F suffix (Final) avoids Mercury collision with the auto-cron that
  // already created INV-2026-05-CENT on the Saturday schedule (vercel.json
  // 0 15 * * 6). The customer sees the same invoice number format.
  const invoiceNumber = 'INV-2026-05-' + slugUpper + '-F';

  // Idempotency
  const { data: existing } = await (admin.from('invoices') as any)
    .select('id,invoice_number,total_amount,mercury_pay_url').eq('invoice_number', invoiceNumber).maybeSingle();
  if (existing) {
    L('Already issued ' + invoiceNumber + ' (' + fmt(Number(existing.total_amount)) + ') — skipping');
    return { invoiceNumber, total: Number(existing.total_amount), payUrl: existing.mercury_pay_url };
  }

  const ratePdf = Number(client.billing_rate_pdf || 59.98);
  const monRate = client.billing_rate_monitoring ?? PRICE_POST_CLOSE_MONITORING_MONTHLY;

  // Catch-up line
  let catchupAmount = 0, catchupMemo = '';
  if (catchupInvoiceNumber) {
    const { data: priorInv } = await (admin.from('invoices') as any)
      .select('invoice_number,total_amount').eq('invoice_number', catchupInvoiceNumber).maybeSingle();
    if (priorInv) {
      catchupAmount = Math.round((Number(priorInv.total_amount) - knownPriorPaid) * 100) / 100;
      catchupMemo = 'Catch-up balance on ' + catchupInvoiceNumber + ' (' + fmt(Number(priorInv.total_amount)) + ' invoiced, ' + fmt(knownPriorPaid) + ' ACH received 2026-05-28)';
      L('Catch-up: ' + catchupMemo + ' = ' + fmt(catchupAmount));
    }
  }

  // Entities
  let q = admin.from('request_entities')
    .select('entity_name,form_type,completed_at,gross_receipts,requests!inner(loan_number,client_id,profiles!requests_requested_by_fkey(full_name))')
    .eq('requests.client_id', clientId).eq('status', 'completed')
    .lte('completed_at', PERIOD_END + 'T23:59:59Z') as any;
  q = entityCutoff
    ? q.gt('completed_at', entityCutoff)
    : q.gte('completed_at', PERIOD_START + 'T00:00:00Z');
  const { data: rawEntities } = await q as { data: any[] | null };
  const entities = (rawEntities || []).filter((e: any) => !e.gross_receipts?.pre_billed?.invoice_id);
  L('Entities: ' + entities.length + ' billable');

  // Build processor groups
  type PG = { processor: string; entities: any[]; subtotal: number };
  const byProc: Record<string, PG> = {};
  for (const e of entities) {
    const proc = (e.requests as any)?.profiles?.full_name || 'Unattributed';
    const isReorder = e.gross_receipts?.reorder?.sku === 'reorder-from-history';
    const price = isReorder ? 29.99 : ratePdf;
    if (!byProc[proc]) byProc[proc] = { processor: proc, entities: [], subtotal: 0 };
    byProc[proc].entities.push({ entity_name: e.entity_name, form_type: e.form_type, completed_at: e.completed_at, loan_number: (e.requests as any)?.loan_number || null, unit_price: price, is_reorder: isReorder });
    byProc[proc].subtotal = Math.round((byProc[proc].subtotal + price) * 100) / 100;
  }
  const processorGroups = Object.values(byProc).sort((a, b) => a.processor.localeCompare(b.processor));
  const verifyTotal = Math.round(processorGroups.reduce((s, g) => s + g.subtotal, 0) * 100) / 100;
  L('Verification: ' + fmt(verifyTotal));
  for (const g of processorGroups) L('  ' + g.processor + ': ' + g.entities.length + ' × ' + fmt(ratePdf) + ' = ' + fmt(g.subtotal));

  // Monitoring
  let monAmt = 0, monCount = 0;
  const monDetails: any[] = [];
  if (!client.disable_monitoring) {
    const monLow = entityCutoff
      ? Math.max(Date.parse(PERIOD_START + 'T00:00:00Z'), Date.parse(entityCutoff))
      : Date.parse(PERIOD_START + 'T00:00:00Z');
    const periodEndMs = Date.parse(PERIOD_END + 'T23:59:59Z') + 1;
    const { data: monitors } = await admin.from('entity_monitoring')
      .select('enrolled_at,cancelled_at,status,request_entities!inner(entity_name,requests!inner(profiles!requests_requested_by_fkey(full_name)))')
      .eq('client_id', clientId).lte('enrolled_at', PERIOD_END + 'T23:59:59Z')
      .or('cancelled_at.is.null,cancelled_at.gte.' + PERIOD_START) as { data: any[] | null };
    for (const m of (monitors || [])) {
      if (m.status === 'pending') continue;
      const enr = Date.parse(m.enrolled_at);
      const can = m.cancelled_at ? Date.parse(m.cancelled_at) : Infinity;
      if (enr >= monLow && can <= periodEndMs) continue;
      const ws = Math.max(enr, monLow), we = Math.min(can, periodEndMs);
      if (we <= ws) continue;
      const days = Math.ceil((we - ws) / 86400000);
      const prorated = Math.round((Math.min(days, 31) / 31) * monRate * 100) / 100;
      const re = m.request_entities as any;
      monDetails.push({ entity_name: re?.entity_name || '?', processor: re?.requests?.profiles?.full_name || 'Unattributed', window_start: new Date(ws).toISOString().slice(0, 10), window_end: new Date(we - 1).toISOString().slice(0, 10), active_days: days, prorated });
      monAmt += prorated; monCount++;
    }
    monAmt = Math.round(monAmt * 100) / 100;
    monDetails.sort((a, b) => a.processor.localeCompare(b.processor) || a.entity_name.localeCompare(b.entity_name));
    if (monCount > 0) L('Monitoring: ' + monCount + ' enrollments = ' + fmt(monAmt));
  }

  const grandTotal = Math.round((verifyTotal + monAmt + catchupAmount) * 100) / 100;
  L('Grand total: ' + fmt(grandTotal));

  // Mercury line items (summary)
  const lineItems: any[] = [];
  const stdCount = processorGroups.reduce((s, g) => s + g.entities.filter((e: any) => !e.is_reorder).length, 0);
  const reoCount = processorGroups.reduce((s, g) => s + g.entities.filter((e: any) => e.is_reorder).length, 0);
  if (stdCount > 0) lineItems.push({ name: 'Tax Verification — ' + client.name + ' (May 2026)', unitPrice: ratePdf, quantity: stdCount });
  if (reoCount > 0) lineItems.push({ name: 'Tax Verification — Reorder (May 2026)', unitPrice: 29.99, quantity: reoCount });
  if (monCount > 0) lineItems.push({ name: 'Account Monitoring — May 2026', unitPrice: Math.round((monAmt / monCount) * 100) / 100, quantity: monCount });
  if (catchupAmount > 0) lineItems.push({ name: catchupMemo, unitPrice: catchupAmount, quantity: 1 });

  if (!process.env.MERCURY_API_KEY) { L('MERCURY_API_KEY not set'); return null; }
  const netDays = client.billing_net_days ?? 5;
  const invoiceDate = new Date().toISOString().split('T')[0];
  const due = new Date(); due.setUTCDate(due.getUTCDate() + netDays);
  const dueDate = due.toISOString().split('T')[0];

  const mercuryInvoice = await createMercuryInvoice({
    customerId: client.mercury_customer_id, destinationAccountId: getDestinationAccountId(),
    dueDate, invoiceDate, invoiceNumber, lineItems,
    ccEmails: client.billing_ap_email_cc || [],
    creditCardEnabled: false, achDebitEnabled: true, useRealAccountNumber: false,
    sendEmailOption: 'DontSend',
    servicePeriodStartDate: PERIOD_START, servicePeriodEndDate: PERIOD_END,
    payerMemo: 'Reference: ' + invoiceNumber + '. ' + client.name + ' May 2026 IRS transcript verification. Net ' + netDays + ' days. ACH Debit only.',
  });
  const payUrl = getMercuryPayUrl(mercuryInvoice.slug);
  L('Pay URL: ' + payUrl);

  const catchupLine = catchupAmount > 0 ? { amount: catchupAmount, memo: catchupMemo } : null;
  let pdfBuffer: Buffer | null = null;
  try {
    pdfBuffer = await generateInvoiceBreakdownPdf({
      clientName: client.name, invoiceNumber, periodStart: PERIOD_START, periodEnd: PERIOD_END,
      grandTotal, payUrl, isTest: false, processorGroups, monitoringDetails: monDetails, catchupLine,
    });
    L('PDF generated (' + pdfBuffer.length + ' bytes)');
  } catch (err: any) { L('PDF failed: ' + err?.message); }

  // SendGrid
  if (process.env.SENDGRID_API_KEY && client.billing_ap_email) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    const fd = (s: string | null) => s ? s.slice(0, 10) : '';
    const procRows = processorGroups.map((g: any) =>
      '<tr><td colspan="5" style="padding:12px 12px 3px;font-size:12px;font-weight:700;color:#295c9e;background:#f0f5ff;border-top:2px solid #e5e7eb;">' + g.processor + ' &mdash; ' + g.entities.length + ' ' + (g.entities.length === 1 ? 'entity' : 'entities') + ' &mdash; ' + fmt(g.subtotal) + '</td></tr>' +
      g.entities.map((e: any) =>
        '<tr style="border-bottom:1px solid #f3f4f6;"><td style="padding:5px 12px;font-size:12px;">' + e.entity_name + (e.is_reorder ? ' <span style="background:#ede9fe;color:#6b21a8;padding:1px 5px;border-radius:6px;font-size:10px;font-weight:700;">REORDER</span>' : '') + '</td>' +
        '<td style="padding:5px 12px;font-size:11px;color:#6b7280;">' + (e.form_type || '&mdash;') + '</td>' +
        '<td style="padding:5px 12px;font-size:11px;color:#6b7280;">' + (e.loan_number || '&mdash;') + '</td>' +
        '<td style="padding:5px 12px;font-size:11px;color:#6b7280;">' + fd(e.completed_at) + '</td>' +
        '<td style="padding:5px 12px;font-size:12px;text-align:right;font-family:monospace;">' + fmt(e.unit_price) + '</td></tr>'
      ).join('')
    ).join('');
    const monRows = monDetails.map((m: any) =>
      '<tr style="border-bottom:1px solid #f3f4f6;"><td style="padding:5px 12px;font-size:12px;">' + m.entity_name + '</td>' +
      '<td style="padding:5px 12px;font-size:11px;color:#6b7280;">' + m.processor + '</td>' +
      '<td style="padding:5px 12px;font-size:11px;color:#6b7280;">' + m.window_start + ' &rarr; ' + m.window_end + ' (' + m.active_days + '/31 days)</td>' +
      '<td style="padding:5px 12px;font-size:12px;text-align:right;font-family:monospace;">' + fmt(m.prorated) + '</td></tr>'
    ).join('');

    const html = '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:800px;margin:0 auto;color:#1a2845;">' +
      '<div style="background:#0a1929;padding:22px 28px;"><h2 style="margin:0;color:#fff;font-size:19px;">' + client.name + ' &mdash; Invoice ' + invoiceNumber + '</h2>' +
      '<p style="margin:5px 0 0;color:#94a3b8;font-size:12px;">Period: ' + PERIOD_START + ' &rarr; ' + PERIOD_END + ' &nbsp;&middot;&nbsp; Due: ' + dueDate + ' (Net ' + netDays + ' days) &nbsp;&middot;&nbsp; ACH Debit only</p></div>' +
      '<div style="padding:24px 28px;"><p style="font-size:14px;color:#374151;">Itemized breakdown below. PDF attached. Pay via Mercury button at the bottom.</p>' +
      (processorGroups.length > 0 ? '<h3 style="font-size:14px;font-weight:700;color:#0a1929;margin:24px 0 8px;">Tax Verification &mdash; by loan officer</h3><table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;"><thead><tr style="background:#f8fafc;"><th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Entity</th><th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Form</th><th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Loan</th><th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Completed</th><th style="padding:8px 12px;text-align:right;font-size:10px;color:#6b7280;text-transform:uppercase;">Amount</th></tr></thead><tbody>' + procRows + '</tbody></table>' : '') +
      (monDetails.length > 0 ? '<h3 style="font-size:14px;font-weight:700;color:#0a1929;margin:24px 0 8px;">Account Monitoring</h3><table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;"><thead><tr style="background:#f8fafc;"><th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Entity</th><th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Loan Officer</th><th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Window</th><th style="padding:8px 12px;text-align:right;font-size:10px;color:#6b7280;text-transform:uppercase;">Prorated</th></tr></thead><tbody>' + monRows + '</tbody></table>' : '') +
      (catchupLine ? '<h3 style="font-size:14px;font-weight:700;color:#b91c1c;margin:24px 0 8px;">Catch-up Balance</h3><div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:16px;"><span style="font-size:13px;color:#7f1d1d;flex:1;">' + catchupLine.memo + '</span><strong style="font-family:monospace;font-size:16px;color:#7f1d1d;white-space:nowrap;">' + fmt(catchupLine.amount) + '</strong></div>' : '') +
      '<div style="margin:28px 0;padding:20px 24px;background:#f0fdf4;border:2px solid #00C48C;border-radius:8px;display:flex;justify-content:space-between;align-items:center;"><div><div style="font-size:11px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.5px;">Total Due</div><div style="font-size:30px;font-weight:800;color:#0a1929;font-family:monospace;">' + fmt(grandTotal) + '</div></div><a href="' + payUrl + '" style="display:inline-block;background:#0a1929;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;">Pay via Mercury &rarr;</a></div>' +
      '<p style="font-size:12px;color:#6b7280;text-align:center;">ACH Debit only &middot; Net ' + netDays + ' days &middot; ModernTax Inc.</p>' +
      '<p style="font-size:12px;color:#6b7280;margin-top:20px;">PDF attached. Audit trail at <a href="https://portal.moderntax.io/invoicing" style="color:#295c9e;">portal.moderntax.io/invoicing</a>. Questions? matt@moderntax.io</p></div>' +
      '<div style="background:#f8fafc;padding:12px 28px;font-size:10px;color:#94a3b8;border-top:1px solid #e5e7eb;">ModernTax Inc. &middot; IRS Practitioner Priority Service &middot; ' + invoiceNumber + '</div></div>';

    try {
      await sgMail.send({
        to: client.billing_ap_email,
        cc: client.billing_ap_email_cc?.length ? client.billing_ap_email_cc : undefined,
        from: { email: 'no-reply@moderntax.io', name: 'ModernTax Invoicing' },
        subject: invoiceNumber + ' — ' + client.name + ' — ' + fmt(grandTotal) + ' due ' + dueDate,
        html,
        text: client.name + ' May 2026 invoice ' + invoiceNumber + '. Total due: ' + fmt(grandTotal) + '. Pay: ' + payUrl + '. Breakdown PDF attached.',
        attachments: pdfBuffer ? [{ content: pdfBuffer.toString('base64'), filename: invoiceNumber + '-breakdown.pdf', type: 'application/pdf', disposition: 'attachment' as const }] : undefined,
      });
      L('SendGrid sent to ' + client.billing_ap_email + (client.billing_ap_email_cc?.length ? ' CC ' + client.billing_ap_email_cc.join(', ') : '') + (pdfBuffer ? ' with PDF' : ''));
    } catch (err: any) { L('SendGrid failed: ' + err?.message); }
  }

  // DB row
  const breakdown = { processor_groups: processorGroups, monitoring_details: monDetails, catchup_line: catchupLine };
  const row: Record<string, unknown> = { client_id: clientId, invoice_number: invoiceNumber, billing_period_start: PERIOD_START, billing_period_end: PERIOD_END, total_entities: entities.length, total_amount: grandTotal, monitoring_entities: monCount, monitoring_amount: monAmt, status: 'sent', payment_method: 'ach', due_date: dueDate, mercury_invoice_id: mercuryInvoice.id, mercury_pay_url: payUrl, breakdown };
  let { error: insErr } = await (admin.from('invoices') as any).insert(row);
  if (insErr && /breakdown|column.*does not exist|PGRST204/i.test(insErr.message || '')) {
    delete row.breakdown;
    ({ error: insErr } = await (admin.from('invoices') as any).insert(row));
  }
  if (insErr) L('invoices insert: ' + insErr.message);
  else L('invoices row written');

  return { invoiceNumber, total: grandTotal, payUrl };
}

export async function POST(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  // ?client=centerstone | cal_statewide | all (default: all, but run one at a time
  // to avoid the Vercel 300s limit — each client takes ~60-90s alone).
  const clientParam = request.nextUrl.searchParams.get('client') || 'all';

  const admin = createAdminClient();
  const log: string[] = [];
  const results: any[] = [];

  if (clientParam === 'centerstone' || clientParam === 'all') {
    try {
      const r = await issueInvoice(admin, '60f80d60-03ad-42d7-95da-c0f1cd311523', null, null, 0, log);
      results.push({ client: 'Centerstone SBA Lending', ...r });
    } catch (err: any) {
      log.push('Centerstone error: ' + err?.message);
      results.push({ client: 'Centerstone SBA Lending', error: err?.message });
    }
  }

  if (clientParam === 'cal_statewide' || clientParam === 'all') {
    try {
      const r = await issueInvoice(admin, '3256293c-6c98-42bc-a828-2b73a603048e', CALI_PRIOR_CUTOFF, CALI_PRIOR_INV, CALI_PRIOR_PAID, log);
      results.push({ client: 'California Statewide CDC', ...r });
    } catch (err: any) {
      log.push('Cal Statewide error: ' + err?.message);
      results.push({ client: 'California Statewide CDC', error: err?.message });
    }
  }

  return NextResponse.json({ success: true, client: clientParam, results, log });
}
// deploy-bump: 2026-05-31T05:43:41Z
