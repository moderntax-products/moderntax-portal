/**
 * Client-facing monthly invoice email builder.
 *
 * Extracted from the monthly-client-invoices cron so the one-click send
 * endpoint (app/api/public/invoice-send/[token]) can rebuild the exact same
 * email from the invoice's stored breakdown when Matt approves the send.
 */

export interface InvoiceEmailProcessorGroup {
  processor: string;
  entities: Array<{
    entity_name: string;
    form_type: string | null;
    loan_number: string | null;
    completed_at: string | null;
    unit_price: number;
    is_reorder?: boolean;
  }>;
  subtotal: number;
}

export interface InvoiceEmailMonitorDetail {
  entity_name: string;
  processor: string;
  window_start: string;
  window_end: string;
  active_days: number;
  prorated: number;
}

export interface ClientInvoiceEmailInput {
  clientName: string;
  invoiceNumber: string;
  periodStart: string;
  periodEnd: string;
  grandTotal: number;
  payUrl: string;
  dueDate: string;
  netDays: number;
  processorGroups: InvoiceEmailProcessorGroup[];
  monitorDetails: InvoiceEmailMonitorDetail[];
  catchupLine: { amount: number; memo: string } | null;
}

const fmtUsd = (n: number) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (s: string | null) => (s ? s.slice(0, 10) : '');

export function buildClientInvoiceEmail(input: ClientInvoiceEmailInput): { subject: string; html: string; text: string } {
  const { clientName, invoiceNumber, periodStart, periodEnd, grandTotal, payUrl, dueDate, netDays, processorGroups, monitorDetails, catchupLine } = input;

  const procRows = processorGroups.map(g =>
    `<tr><td colspan="5" style="padding:12px 12px 3px;font-size:12px;font-weight:700;color:#295c9e;background:#f0f5ff;border-top:1px solid #e5e7eb;">${g.processor} &mdash; ${g.entities.length} ${g.entities.length === 1 ? 'entity' : 'entities'} &mdash; ${fmtUsd(g.subtotal)}</td></tr>` +
    g.entities.map(e => `<tr><td style="padding:5px 12px;font-size:12px;">${e.entity_name}${e.is_reorder ? ' <span style="background:#ede9fe;color:#6b21a8;padding:1px 5px;border-radius:6px;font-size:10px;">REORDER</span>' : ''}</td><td style="padding:5px 12px;font-size:11px;color:#6b7280;">${e.form_type || '&mdash;'}</td><td style="padding:5px 12px;font-size:11px;color:#6b7280;">${e.loan_number || '&mdash;'}</td><td style="padding:5px 12px;font-size:11px;color:#6b7280;">${fmtDate(e.completed_at)}</td><td style="padding:5px 12px;font-size:12px;text-align:right;font-family:monospace;">${fmtUsd(e.unit_price)}</td></tr>`).join('')
  ).join('');

  const monRows = monitorDetails.map(m =>
    `<tr><td style="padding:5px 12px;font-size:12px;">${m.entity_name}</td><td style="padding:5px 12px;font-size:11px;color:#6b7280;">${m.processor}</td><td style="padding:5px 12px;font-size:11px;color:#6b7280;">${m.window_start} &rarr; ${m.window_end} (${m.active_days}/31 days)</td><td style="padding:5px 12px;font-size:12px;text-align:right;font-family:monospace;">${fmtUsd(m.prorated)}</td></tr>`
  ).join('');

  const html = `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:800px;margin:0 auto;color:#1a2845;">
<div style="background:#0a1929;padding:20px 28px;"><h2 style="margin:0;color:#fff;font-size:18px;">${clientName} &mdash; Invoice ${invoiceNumber}</h2><p style="margin:4px 0 0;color:#94a3b8;font-size:12px;">Period: ${periodStart} &rarr; ${periodEnd} &nbsp;&middot;&nbsp; Due: ${dueDate} &nbsp;&middot;&nbsp; ACH Debit only</p></div>
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

  return {
    subject: `${invoiceNumber} — ${clientName} — ${fmtUsd(grandTotal)} due ${dueDate}`,
    html,
    text: `${clientName} ${periodStart.slice(0, 7)} invoice ${invoiceNumber}. Total due: ${fmtUsd(grandTotal)}. Pay: ${payUrl}. Itemized breakdown attached as PDF and viewable at https://portal.moderntax.io/invoicing.`,
  };
}
