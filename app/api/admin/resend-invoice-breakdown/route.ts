/**
 * POST /api/admin/resend-invoice-breakdown
 *
 * Re-sends the itemized breakdown email + PDF for an existing invoice
 * that was issued without breakdown data (e.g. before migration-invoices-
 * breakdown.sql was applied, or before the itemization code shipped).
 *
 * Does NOT create a new Mercury invoice — uses the existing pay URL.
 * Queries the entities directly from the DB so the breakdown is accurate.
 * Also stamps invoices.breakdown JSONB so the portal shows the detail.
 *
 * Body: { invoice_number: string, to?: string, cc?: string[] }
 * Auth: CRON_SECRET
 */

import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { PRICE_POST_CLOSE_MONITORING_MONTHLY } from '@/lib/pricing';
import { generateInvoiceBreakdownPdf } from '@/lib/invoice-breakdown-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function fmt(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function POST(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  let body: { invoice_number?: string; to?: string; cc?: string[] };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const invoiceNumber = body.invoice_number?.trim();
  if (!invoiceNumber) return NextResponse.json({ error: 'invoice_number required' }, { status: 400 });

  const admin = createAdminClient();
  const log: string[] = [];
  const L = (s: string) => { log.push(s); console.log('[resend-breakdown] ' + s); };

  // Load the invoice row
  const { data: invoice } = await (admin.from('invoices') as any)
    .select('id, invoice_number, client_id, total_amount, billing_period_start, billing_period_end, mercury_pay_url, due_date, breakdown')
    .eq('invoice_number', invoiceNumber).single() as { data: any };

  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  L(`Invoice: ${invoice.invoice_number} — ${fmt(Number(invoice.total_amount))} — pay: ${invoice.mercury_pay_url}`);

  // Load client config for billing email + name
  const { data: client } = await admin.from('clients')
    .select('id, name, billing_rate_pdf, billing_rate_monitoring, disable_monitoring, billing_ap_email, billing_ap_email_cc, billing_net_days')
    .eq('id', invoice.client_id).single() as { data: any };
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  L(`Client: ${client.name}`);

  const toEmail = body.to?.trim() || client.billing_ap_email;
  const ccEmails: string[] = body.cc || client.billing_ap_email_cc || [];

  if (!toEmail) return NextResponse.json({ error: 'No billing email on file and no to: provided' }, { status: 400 });

  const ratePdf = Number(client.billing_rate_pdf || 59.98);
  const monRate = client.billing_rate_monitoring ?? PRICE_POST_CLOSE_MONITORING_MONTHLY;

  // The cron that created this invoice stored the run date (2026-05-30) as
  // billing_period_start/end instead of the actual month bounds. Override
  // to the correct billing month derived from the invoice number (INV-YYYY-MM-*).
  const invParts = invoiceNumber.match(/INV-(\d{4})-(\d{2})-/);
  const correctedYear = invParts ? invParts[1] : invoice.billing_period_start.slice(0, 4);
  const correctedMonth = invParts ? invParts[2] : invoice.billing_period_start.slice(5, 7);
  const periodStart = `${correctedYear}-${correctedMonth}-01`;
  const lastDay = new Date(Number(correctedYear), Number(correctedMonth), 0).getDate();
  const periodEnd = `${correctedYear}-${correctedMonth}-${String(lastDay).padStart(2, '0')}`;
  L(`Period: ${periodStart} → ${periodEnd} (corrected from stored: ${invoice.billing_period_start} → ${invoice.billing_period_end})`);

  // Step 1a: Get request IDs + loan numbers (no join — keep it fast)
  const { data: reqRows } = await admin.from('requests')
    .select('id, loan_number, requested_by')
    .eq('client_id', invoice.client_id)
    .limit(2000) as { data: any[] | null };
  const reqIds = (reqRows || []).map((r: any) => r.id);
  const loanMap: Record<string, string | null> = {};
  const requestedByMap: Record<string, string> = {};
  for (const r of (reqRows || [])) {
    loanMap[r.id] = r.loan_number || null;
    requestedByMap[r.id] = r.requested_by;
  }
  L(`Requests found for client: ${reqIds.length}`);

  // Step 1b: Get processor names separately (by unique requested_by user IDs)
  const uniqueUserIds = [...new Set(Object.values(requestedByMap))];
  const { data: profRows } = await admin.from('profiles')
    .select('id, full_name')
    .in('id', uniqueUserIds) as { data: any[] | null };
  const profMap: Record<string, string> = {};
  for (const p of (profRows || [])) {
    profMap[p.id] = p.full_name || 'Unattributed';
  }

  // reqMap: request_id → { loan_number, proc_name }
  const reqMap: Record<string, { loan_number: string | null; proc_name: string }> = {};
  for (const id of reqIds) {
    reqMap[id] = { loan_number: loanMap[id] || null, proc_name: profMap[requestedByMap[id]] || 'Unattributed' };
  }

  // Step 2: Get completed entities in the billing period — batch the in() to avoid limits
  let rawEntities: any[] = [];
  for (let i = 0; i < reqIds.length; i += 200) {
    const batch = reqIds.slice(i, i + 200);
    const { data: batchEntities } = await admin.from('request_entities')
      .select('entity_name, form_type, completed_at, gross_receipts, request_id')
      .in('request_id', batch)
      .eq('status', 'completed')
      .gte('completed_at', `${periodStart}T00:00:00Z`)
      .lte('completed_at', `${periodEnd}T23:59:59Z`)
      .order('completed_at', { ascending: true }) as { data: any[] | null };
    rawEntities = rawEntities.concat(batchEntities || []);
  }

  const entities = rawEntities.filter((e: any) => !e.gross_receipts?.pre_billed?.invoice_id);
  L(`Entities found: ${entities.length}`);
  L(`Entities found: ${entities.length}`);

  // Build processor groups using the reqMap lookup
  const byProc: Record<string, { processor: string; entities: any[]; subtotal: number }> = {};
  for (const e of entities) {
    const reqCtx = reqMap[e.request_id] || { loan_number: null, proc_name: 'Unattributed' };
    const proc = reqCtx.proc_name;
    const isReorder = e.gross_receipts?.reorder?.sku === 'reorder-from-history';
    const price = isReorder ? 29.99 : ratePdf;
    if (!byProc[proc]) byProc[proc] = { processor: proc, entities: [], subtotal: 0 };
    byProc[proc].entities.push({ entity_name: e.entity_name, form_type: e.form_type, completed_at: e.completed_at, loan_number: reqCtx.loan_number, unit_price: price, is_reorder: isReorder });
    byProc[proc].subtotal = Math.round((byProc[proc].subtotal + price) * 100) / 100;
  }
  const processorGroups = Object.values(byProc).sort((a, b) => a.processor.localeCompare(b.processor));
  L(`Processor groups: ${processorGroups.map(g => `${g.processor} (${g.entities.length})`).join(', ')}`);

  // Monitoring
  let monAmt = 0, monCount = 0;
  const monDetails: any[] = [];
  if (!client.disable_monitoring) {
    const { data: monitors } = await admin.from('entity_monitoring')
      .select('enrolled_at, cancelled_at, status, request_entities!inner(entity_name, requests!inner(profiles!requests_requested_by_fkey(full_name)))')
      .eq('client_id', invoice.client_id)
      .lte('enrolled_at', `${periodEnd}T23:59:59Z`)
      .or(`cancelled_at.is.null,cancelled_at.gte.${periodStart}`) as { data: any[] | null };
    const pStartMs = Date.parse(`${periodStart}T00:00:00Z`);
    const pEndMs = Date.parse(`${periodEnd}T23:59:59Z`) + 1;
    for (const m of (monitors || [])) {
      if (m.status === 'pending') continue;
      const enr = Date.parse(m.enrolled_at);
      const can = m.cancelled_at ? Date.parse(m.cancelled_at) : Infinity;
      if (enr >= pStartMs && can <= pEndMs) continue;
      const ws = Math.max(enr, pStartMs), we = Math.min(can, pEndMs);
      if (we <= ws) continue;
      const days = Math.ceil((we - ws) / 86400000);
      const prorated = Math.round((Math.min(days, 31) / 31) * monRate * 100) / 100;
      const re = m.request_entities as any;
      monDetails.push({ entity_name: re?.entity_name || '?', processor: re?.requests?.profiles?.full_name || 'Unattributed', window_start: new Date(ws).toISOString().slice(0, 10), window_end: new Date(we - 1).toISOString().slice(0, 10), active_days: days, prorated });
      monAmt += prorated; monCount++;
    }
    monAmt = Math.round(monAmt * 100) / 100;
    monDetails.sort((a: any, b: any) => a.processor.localeCompare(b.processor) || a.entity_name.localeCompare(b.entity_name));
  }

  const grandTotal = Number(invoice.total_amount);
  const payUrl = invoice.mercury_pay_url;
  const dueDate = invoice.due_date || 'Upon receipt';
  const netDays = client.billing_net_days ?? 5;

  // Generate PDF
  let pdfBuffer: Buffer | null = null;
  try {
    pdfBuffer = await generateInvoiceBreakdownPdf({
      clientName: client.name, invoiceNumber: invoice.invoice_number,
      periodStart, periodEnd, grandTotal, payUrl, isTest: false,
      processorGroups, monitoringDetails: monDetails, catchupLine: null,
    });
    L(`PDF generated: ${pdfBuffer.length} bytes`);
  } catch (err: any) { L(`PDF failed: ${err?.message}`); }

  // Build HTML email
  const fd = (s: string | null) => s ? s.slice(0, 10) : '';
  const procRows = processorGroups.map((g: any) =>
    `<tr><td colspan="5" style="padding:12px 12px 3px;font-size:12px;font-weight:700;color:#295c9e;background:#f0f5ff;border-top:2px solid #e5e7eb;">${g.processor} &mdash; ${g.entities.length} ${g.entities.length === 1 ? 'entity' : 'entities'} &mdash; ${fmt(g.subtotal)}</td></tr>` +
    g.entities.map((e: any) =>
      `<tr style="border-bottom:1px solid #f3f4f6;">
        <td style="padding:5px 12px;font-size:12px;">${e.entity_name}${e.is_reorder ? ' <span style="background:#ede9fe;color:#6b21a8;padding:1px 5px;border-radius:6px;font-size:10px;font-weight:700;">REORDER</span>' : ''}</td>
        <td style="padding:5px 12px;font-size:11px;color:#6b7280;">${e.form_type || '&mdash;'}</td>
        <td style="padding:5px 12px;font-size:11px;color:#6b7280;">${e.loan_number || '&mdash;'}</td>
        <td style="padding:5px 12px;font-size:11px;color:#6b7280;">${fd(e.completed_at)}</td>
        <td style="padding:5px 12px;font-size:12px;text-align:right;font-family:monospace;">${fmt(e.unit_price)}</td>
      </tr>`
    ).join('')
  ).join('');

  const monRows = monDetails.map((m: any) =>
    `<tr style="border-bottom:1px solid #f3f4f6;">
      <td style="padding:5px 12px;font-size:12px;">${m.entity_name}</td>
      <td style="padding:5px 12px;font-size:11px;color:#6b7280;">${m.processor}</td>
      <td style="padding:5px 12px;font-size:11px;color:#6b7280;">${m.window_start} &rarr; ${m.window_end} (${m.active_days}/31 days)</td>
      <td style="padding:5px 12px;font-size:12px;text-align:right;font-family:monospace;">${fmt(m.prorated)}</td>
    </tr>`
  ).join('');

  const html = `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:800px;margin:0 auto;color:#1a2845;">
<div style="background:#0a1929;padding:22px 28px;"><h2 style="margin:0;color:#fff;font-size:19px;">${client.name} &mdash; Invoice ${invoice.invoice_number}</h2>
<p style="margin:5px 0 0;color:#94a3b8;font-size:12px;">Period: ${periodStart} &rarr; ${periodEnd} &nbsp;&middot;&nbsp; Due: ${dueDate} &nbsp;&middot;&nbsp; ACH Debit only</p>
<p style="margin:6px 0 0;color:#f59e0b;font-size:11px;">CORRECTION: This replaces the earlier email which showed 0 items due to a rendering issue. All line items are below.</p></div>
<div style="padding:24px 28px;"><p style="font-size:14px;color:#374151;">Itemized breakdown for your records. The PDF is attached. Pay via Mercury button below.</p>
${processorGroups.length > 0 ? `<h3 style="font-size:14px;font-weight:700;color:#0a1929;margin:24px 0 8px;">Tax Verification &mdash; by loan officer</h3>
<table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;"><thead><tr style="background:#f8fafc;">
<th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Entity</th>
<th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Form</th>
<th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Loan</th>
<th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Completed</th>
<th style="padding:8px 12px;text-align:right;font-size:10px;color:#6b7280;text-transform:uppercase;">Amount</th>
</tr></thead><tbody>${procRows}</tbody></table>` : ''}
${monDetails.length > 0 ? `<h3 style="font-size:14px;font-weight:700;color:#0a1929;margin:24px 0 8px;">Account Monitoring</h3>
<table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;"><thead><tr style="background:#f8fafc;">
<th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Entity</th>
<th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Loan Officer</th>
<th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Window</th>
<th style="padding:8px 12px;text-align:right;font-size:10px;color:#6b7280;text-transform:uppercase;">Prorated</th>
</tr></thead><tbody>${monRows}</tbody></table>` : ''}
<div style="margin:28px 0;padding:20px 24px;background:#f0fdf4;border:2px solid #00C48C;border-radius:8px;display:flex;justify-content:space-between;align-items:center;">
<div><div style="font-size:11px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.5px;">Total Due</div>
<div style="font-size:30px;font-weight:800;color:#0a1929;font-family:monospace;">${fmt(grandTotal)}</div></div>
<a href="${payUrl}" style="display:inline-block;background:#0a1929;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;">Pay via Mercury &rarr;</a></div>
<p style="font-size:12px;color:#6b7280;text-align:center;">ACH Debit only &middot; Net ${netDays} days &middot; ModernTax Inc.</p>
<p style="font-size:12px;color:#6b7280;margin-top:20px;">PDF attached. Audit trail at <a href="https://portal.moderntax.io/invoicing" style="color:#295c9e;">portal.moderntax.io/invoicing</a>. Questions? matt@moderntax.io</p>
</div>
<div style="background:#f8fafc;padding:12px 28px;font-size:10px;color:#94a3b8;border-top:1px solid #e5e7eb;">ModernTax Inc. &middot; IRS Practitioner Priority Service &middot; ${invoice.invoice_number}</div>
</div>`;

  if (!process.env.SENDGRID_API_KEY) return NextResponse.json({ error: 'SENDGRID_API_KEY not set', log }, { status: 500 });
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  await sgMail.send({
    to: toEmail,
    cc: ccEmails.length > 0 ? ccEmails : undefined,
    from: { email: 'no-reply@moderntax.io', name: 'ModernTax Invoicing' },
    subject: `CORRECTED: ${invoice.invoice_number} — ${client.name} — ${fmt(grandTotal)} — itemized breakdown`,
    html,
    text: `CORRECTION: ${client.name} May 2026 invoice ${invoice.invoice_number}. Total due: ${fmt(grandTotal)}. This replaces the earlier email that showed 0 items. Breakdown PDF attached. Pay: ${payUrl}`,
    attachments: pdfBuffer ? [{
      content: pdfBuffer.toString('base64'),
      filename: `${invoice.invoice_number}-breakdown.pdf`,
      type: 'application/pdf',
      disposition: 'attachment' as const,
    }] : undefined,
  });
  L(`✓ SendGrid sent to ${toEmail}${ccEmails.length ? ` CC ${ccEmails.join(', ')}` : ''}${pdfBuffer ? ' with PDF' : ''}`);

  // Stamp the breakdown on the invoice row so the portal shows it
  const breakdownJson = { processor_groups: processorGroups, monitoring_details: monDetails, catchup_line: null };
  await (admin.from('invoices') as any).update({ breakdown: breakdownJson }).eq('id', invoice.id);
  L(`✓ invoices.breakdown updated`);

  return NextResponse.json({
    success: true,
    invoice_number: invoiceNumber,
    entities_found: entities.length,
    processor_groups: processorGroups.length,
    email_sent_to: toEmail,
    pdf_attached: !!pdfBuffer,
    log,
  });
}
