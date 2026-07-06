/**
 * One-click monthly-invoice send: /api/public/invoice-send/[token]
 *
 * The monthly cron generates each invoice as a DRAFT and emails Matt a summary
 * with a signed link here. GET renders a confirmation page; POST actually emails
 * the client (rebuilding the email + breakdown PDF from the stored data) and —
 * only on a confirmed successful send — marks the invoice 'sent' + records
 * sent_at. If the send fails the invoice stays 'draft' and the error is shown,
 * so "created but not delivered" can never masquerade as sent again.
 *
 * Auth: the signed token (verifyInvoiceSendToken). The GET→POST confirm step
 * prevents email link-prefetchers from triggering a send.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { verifyInvoiceSendToken } from '@/lib/invoice-send-token';
import { buildClientInvoiceEmail } from '@/lib/invoice-email';
import { generateInvoiceBreakdownPdf } from '@/lib/invoice-breakdown-pdf';
import sgMail from '@sendgrid/mail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const fmtUsd = (n: number) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function page(title: string, bodyHtml: string, accent = '#0a1929'): NextResponse {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#1a2845;">
<div style="max-width:560px;margin:40px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
<div style="background:${accent};padding:18px 24px;color:#fff;font-weight:700;font-size:16px;">ModernTax Invoicing</div>
<div style="padding:24px;">${bodyHtml}</div></div></body></html>`;
  return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function loadInvoice(token: string) {
  const invoiceId = verifyInvoiceSendToken(token);
  if (!invoiceId) return { error: 'This link isn’t valid or has expired.' as string } as const;
  const admin = createAdminClient();
  const { data: inv } = await admin.from('invoices')
    .select('id, client_id, invoice_number, billing_period_start, billing_period_end, total_amount, due_date, mercury_pay_url, breakdown, status, sent_at')
    .eq('id', invoiceId).single() as { data: any };
  if (!inv) return { error: 'Invoice not found.' as string } as const;
  const { data: client } = await admin.from('clients')
    .select('id, name, billing_ap_email, billing_ap_email_cc, billing_net_days').eq('id', inv.client_id).single() as { data: any };
  return { admin, inv, client } as const;
}

export async function GET(_request: NextRequest, { params }: { params: { token: string } }) {
  const r = await loadInvoice(params.token);
  if ('error' in r) return page('Invalid link', `<p style="font-size:14px;color:#6b7280;">${r.error}</p>`);
  const { inv, client } = r;

  if (inv.status === 'sent') {
    return page('Already sent', `<h2 style="margin:0 0 8px;font-size:18px;color:#2f6e4f;">Already sent ✓</h2>
<p style="font-size:14px;color:#374151;">Invoice <b>${inv.invoice_number}</b> (${fmtUsd(Number(inv.total_amount))}) was already emailed to ${client?.name || 'the client'}${inv.sent_at ? ` on ${String(inv.sent_at).slice(0, 10)}` : ''}. No action needed.</p>`, '#2f6e4f');
  }

  const to = client?.billing_ap_email || '(no billing email on file)';
  const cc = (client?.billing_ap_email_cc || []).join(', ');
  return page('Confirm send', `<h2 style="margin:0 0 6px;font-size:18px;">Send this invoice?</h2>
<table style="width:100%;font-size:14px;margin:12px 0;">
<tr><td style="padding:4px 0;color:#6b7280;">Client</td><td style="padding:4px 0;text-align:right;font-weight:600;">${client?.name || '—'}</td></tr>
<tr><td style="padding:4px 0;color:#6b7280;">Invoice</td><td style="padding:4px 0;text-align:right;">${inv.invoice_number}</td></tr>
<tr><td style="padding:4px 0;color:#6b7280;">Amount</td><td style="padding:4px 0;text-align:right;font-weight:700;font-family:monospace;">${fmtUsd(Number(inv.total_amount))}</td></tr>
<tr><td style="padding:4px 0;color:#6b7280;">Due</td><td style="padding:4px 0;text-align:right;">${inv.due_date || '—'}</td></tr>
<tr><td style="padding:4px 0;color:#6b7280;">To</td><td style="padding:4px 0;text-align:right;">${to}${cc ? `<br><span style="font-size:11px;color:#6b7280;">cc ${cc}</span>` : ''}</td></tr>
</table>
<form method="POST" style="margin-top:16px;">
<button type="submit" style="width:100%;background:#0a1929;color:#fff;border:none;padding:14px;border-radius:8px;font-weight:700;font-size:15px;cursor:pointer;">Confirm &amp; send to ${client?.name || 'client'} →</button>
</form>
<p style="font-size:11px;color:#9ca3af;margin-top:10px;text-align:center;">The client is only emailed after you click. Nothing has been sent yet.</p>`);
}

export async function POST(_request: NextRequest, { params }: { params: { token: string } }) {
  const r = await loadInvoice(params.token);
  if ('error' in r) return page('Invalid link', `<p style="font-size:14px;color:#6b7280;">${r.error}</p>`);
  const { admin, inv, client } = r;

  if (inv.status === 'sent') {
    return page('Already sent', `<p style="font-size:14px;color:#2f6e4f;">Invoice ${inv.invoice_number} was already sent. No action taken.</p>`, '#2f6e4f');
  }
  if (!client?.billing_ap_email) {
    return page('Missing email', `<h2 style="margin:0 0 8px;font-size:18px;color:#b91c1c;">Can’t send — no billing email</h2>
<p style="font-size:14px;color:#374151;">${client?.name || 'This client'} has no <code>billing_ap_email</code> on file, so the invoice can’t be emailed. Add one, then re-send. The invoice stays a draft.</p>`, '#b91c1c');
  }

  const netDays = client.billing_net_days ?? 5;
  const bd = inv.breakdown || {};
  const email = buildClientInvoiceEmail({
    clientName: client.name,
    invoiceNumber: inv.invoice_number,
    periodStart: inv.billing_period_start,
    periodEnd: inv.billing_period_end,
    grandTotal: Number(inv.total_amount),
    payUrl: inv.mercury_pay_url || '',
    dueDate: inv.due_date,
    netDays,
    processorGroups: Array.isArray(bd.processor_groups) ? bd.processor_groups : [],
    monitorDetails: Array.isArray(bd.monitoring_details) ? bd.monitoring_details : [],
    catchupLine: bd.catchup_line || null,
  });

  // Regenerate the breakdown PDF (best-effort — email still sends without it).
  let pdfBuffer: Buffer | null = null;
  try {
    pdfBuffer = await generateInvoiceBreakdownPdf({
      clientName: client.name,
      invoiceNumber: inv.invoice_number,
      periodStart: inv.billing_period_start,
      periodEnd: inv.billing_period_end,
      grandTotal: Number(inv.total_amount),
      payUrl: inv.mercury_pay_url || '',
      isTest: false,
      processorGroups: Array.isArray(bd.processor_groups) ? bd.processor_groups : [],
      monitoringDetails: Array.isArray(bd.monitoring_details) ? bd.monitoring_details : [],
      catchupLine: bd.catchup_line || null,
    });
  } catch (err: any) {
    console.warn('[invoice-send] PDF regen failed (sending without):', err?.message);
  }

  if (!process.env.SENDGRID_API_KEY) {
    return page('Not configured', `<p style="font-size:14px;color:#b91c1c;">SendGrid isn’t configured — can’t send. Invoice stays a draft.</p>`, '#b91c1c');
  }
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  try {
    await sgMail.send({
      to: client.billing_ap_email,
      cc: client.billing_ap_email_cc?.length ? client.billing_ap_email_cc : undefined,
      // active-accounts@ is the sender that reliably delivers (ClearFirm's June
      // breakdown landed from it; the old no-reply@ send to Cal Statewide did not).
      from: { email: 'active-accounts@moderntax.io', name: 'ModernTax Invoicing' },
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: pdfBuffer ? [{ content: pdfBuffer.toString('base64'), filename: `${inv.invoice_number}-breakdown.pdf`, type: 'application/pdf', disposition: 'attachment' as const }] : undefined,
    });
  } catch (err: any) {
    // Send failed → invoice STAYS a draft. Delivery is never faked.
    console.error(`[invoice-send] SendGrid failed for ${inv.invoice_number}:`, err?.message);
    return page('Send failed', `<h2 style="margin:0 0 8px;font-size:18px;color:#b91c1c;">Send failed — not delivered</h2>
<p style="font-size:14px;color:#374151;">The email to ${client.billing_ap_email} didn’t go through: <code>${err?.message || 'unknown error'}</code>. The invoice is still a draft — nothing was marked sent. Try again in a minute.</p>`, '#b91c1c');
  }

  // Confirmed delivered → mark sent + timestamp.
  await (admin.from('invoices') as any)
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', inv.id);

  return page('Sent', `<h2 style="margin:0 0 8px;font-size:18px;color:#2f6e4f;">Sent ✓</h2>
<p style="font-size:14px;color:#374151;">Invoice <b>${inv.invoice_number}</b> (${fmtUsd(Number(inv.total_amount))}) was emailed to <b>${client.billing_ap_email}</b>${client.billing_ap_email_cc?.length ? ` (cc ${client.billing_ap_email_cc.join(', ')})` : ''} and marked sent.</p>`, '#2f6e4f');
}
