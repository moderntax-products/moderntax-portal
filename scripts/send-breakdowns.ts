/**
 * Local one-shot: render + send invoice breakdown emails for the
 * three April backfill targets. Bypasses the Vercel endpoint so we
 * don't have to debug a serverless cold-start issue right now.
 *
 * Run: npx tsx scripts/send-breakdowns.ts <target>
 *   targets: calstatewide | clearfirm | tmc-reminder | all
 */

import { writeFile } from 'fs/promises';
import { config } from 'dotenv';
config({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
import sgMail from '@sendgrid/mail';
import {
  renderInvoicePdf,
  type InvoicePdfInput,
  type VerificationGroup,
  type MonitoringGroup,
} from '../lib/invoice-pdf';
import { sendInvoiceBreakdownEmail } from '../lib/sendgrid';

const NEW_MODEL_EFFECTIVE = '2026-05-01';

const target = process.argv[2] || '';
if (!['calstatewide', 'clearfirm', 'tmc-reminder', 'all'].includes(target)) {
  console.error('Usage: npx tsx scripts/send-breakdowns.ts <calstatewide|clearfirm|tmc-reminder|all>');
  process.exit(1);
}

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function buildBreakdownInput(opts: {
  clientId: string;
  periodStart: string;
  periodEnd: string;
  invoiceNumber: string;
  invoiceRow: any | null;  // null = trial mode
}): Promise<{ input: InvoicePdfInput; client: any; computedTotal: number }> {
  const { clientId, periodStart, periodEnd, invoiceNumber, invoiceRow } = opts;
  const periodEndExclusive = `${periodEnd}T23:59:59.999Z`;
  const useNewRateModel = periodEnd >= NEW_MODEL_EFFECTIVE;

  const { data: client } = await supabase
    .from('clients')
    .select('id, name, slug, free_trial, billing_ap_email, billing_ap_email_cc, ' +
      'billing_net_days, billing_model, subscription_monthly_amount, subscription_included_entities, ' +
      'subscription_overage_rate, billing_rate_pdf, billing_rate_csv, ' +
      'address_line1, address_line2, address_city, address_state, address_postal_code')
    .eq('id', clientId).single() as { data: any };

  const isSubscription = client.billing_model === 'subscription';
  const ratePdf = client.billing_rate_pdf || 59.98;
  const rateCsv = client.billing_rate_csv || 69.98;

  const { data: rawEntities } = await supabase
    .from('request_entities')
    .select('id, entity_name, form_type, completed_at, signature_id, ' +
      'requests!inner ( id, loan_number, intake_method, requested_by, client_id )')
    .eq('status', 'completed')
    .eq('requests.client_id', clientId)
    .gte('completed_at', `${periodStart}T00:00:00Z`)
    .lte('completed_at', periodEndExclusive) as { data: any[] | null };

  const requesterIds = Array.from(new Set((rawEntities || []).map(e => e.requests.requested_by).filter(Boolean)));
  const profileMap = new Map<string, string>();
  if (requesterIds.length > 0) {
    const { data: profs } = await supabase.from('profiles').select('id, full_name, email').in('id', requesterIds);
    for (const p of profs || []) {
      profileMap.set((p as any).id, (p as any).full_name || (p as any).email || 'Unknown');
    }
  }

  const verificationByProcessor = new Map<string, VerificationGroup>();
  const totalCompletedCount = (rawEntities || []).length;
  for (const e of rawEntities || []) {
    const procName = profileMap.get(e.requests.requested_by) || 'Unattributed';
    let g = verificationByProcessor.get(procName);
    if (!g) { g = { processorName: procName, entities: [] }; verificationByProcessor.set(procName, g); }
    const intake = e.requests.intake_method || 'pdf';
    const unitPrice = isSubscription ? 0 : (intake === 'csv' ? rateCsv : ratePdf);
    g.entities.push({
      entityName: e.entity_name || '(unnamed)',
      formType: e.form_type || '-',
      loanNumber: e.requests.loan_number || '',
      completedAt: formatMdy(e.completed_at),
      unitPrice,
    });
  }
  let verificationGroups = Array.from(verificationByProcessor.values())
    .map(g => ({ ...g, entities: g.entities.sort((a, b) => a.completedAt.localeCompare(b.completedAt)) }))
    .sort((a, b) => b.entities.length - a.entities.length);

  if (isSubscription) {
    const usedCount = totalCompletedCount;
    const overageCount = Math.max(0, usedCount - (client.subscription_included_entities || 0));
    const subscriptionGroup: VerificationGroup = {
      processorName: 'Monthly Subscription Plan',
      entities: [{
        entityName: `Flat monthly fee  -  up to ${client.subscription_included_entities} entities included`,
        formType: '-', loanNumber: '-',
        completedAt: `${formatMdy(periodStart)} - ${formatMdy(periodEnd)}`,
        unitPrice: client.subscription_monthly_amount || 0,
      }],
    };
    if (overageCount > 0) {
      subscriptionGroup.entities.push({
        entityName: `Overage:  ${overageCount} entities above included quota`,
        formType: '-', loanNumber: '-', completedAt: '-',
        unitPrice: overageCount * (client.subscription_overage_rate || 0),
      });
    }
    verificationGroups = [subscriptionGroup, ...verificationGroups];
  }

  // Legacy monitoring (Apr period): $25/mo prorated
  const monitoringByProcessor = new Map<string, MonitoringGroup>();
  const { data: legacyMon } = await supabase
    .from('entity_monitoring')
    .select('id, entity_id, frequency, enrolled_at, cancelled_at, status, ' +
      'request_entities ( entity_name, requests ( loan_number, requested_by ) )')
    .eq('client_id', clientId)
    .lte('enrolled_at', periodEndExclusive)
    .or(`cancelled_at.is.null,cancelled_at.gte.${periodStart}`) as { data: any[] | null };

  const periodStartMs = new Date(`${periodStart}T00:00:00Z`).getTime();
  const periodEndMs = new Date(periodEndExclusive).getTime();
  const daysInMonth = (periodEndMs - periodStartMs) / 86400000;
  for (const m of legacyMon || []) {
    if (m.status === 'pending') continue;
    const requester = m.request_entities?.requests?.requested_by;
    const procName = profileMap.get(requester) || 'Unattributed';
    const enrolledMs = new Date(m.enrolled_at).getTime();
    const cancelledMs = m.cancelled_at ? new Date(m.cancelled_at).getTime() : Infinity;
    const ws = Math.max(enrolledMs, periodStartMs);
    const we = Math.min(cancelledMs, periodEndMs);
    if (we <= ws) continue;
    const activeDays = Math.ceil((we - ws) / 86400000);
    const prorated = Math.round((Math.min(activeDays, daysInMonth) / daysInMonth) * 25 * 100) / 100;
    let g = monitoringByProcessor.get(procName);
    if (!g) { g = { processorName: procName, items: [] }; monitoringByProcessor.set(procName, g); }
    g.items.push({
      description: `${m.request_entities?.entity_name || '(entity)'} - Monthly Monitoring (${activeDays}/${Math.round(daysInMonth)} days active)`,
      loanNumber: m.request_entities?.requests?.loan_number || '',
      date: formatMdy(m.enrolled_at), unitPrice: prorated,
    });
  }
  const monitoringGroups: MonitoringGroup[] = Array.from(monitoringByProcessor.values());

  const verificationTotal = verificationGroups.reduce((s, g) => s + g.entities.reduce((a, e) => a + e.unitPrice, 0), 0);
  const monitoringTotal = monitoringGroups.reduce((s, g) => s + g.items.reduce((a, i) => a + i.unitPrice, 0), 0);
  const computedTotal = Math.round((verificationTotal + monitoringTotal) * 100) / 100;

  // Notes vary by mode
  const isTrial = !invoiceRow;
  const notes: string[] = isTrial
    ? [
        'Trial Credit applied - nothing owed for this period.',
        'Going forward you will be billed on the 1st of each month for the prior month\'s usage, Net 15 via Mercury ACH.',
        'To enroll in Mercury auto-pay, reply to this email.',
        "Questions? Reply here and I'll dig in.",
      ]
    : [
        'Payment via ACH. Mercury delivered the formal invoice with pay link separately.',
        'Auto-pay enrollment is one click on the Mercury pay page - saves us both the back-and-forth.',
        "Questions? Reply to this email and I'll dig in.",
      ];

  return {
    input: {
      invoiceNumber,
      invoiceDate: invoiceRow?.invoice_date || new Date().toISOString().split('T')[0],
      dueDate: invoiceRow?.due_date || new Date(Date.now() + 5 * 86400000).toISOString().split('T')[0],
      billingPeriodStart: periodStart,
      billingPeriodEnd: periodEnd,
      paymentTerms: isTrial ? 'Free Trial - no payment due' : `Net ${client.billing_net_days ?? 5} - ACH`,
      payUrl: invoiceRow?.mercury_pay_url || null,
      client: {
        name: client.name,
        addressLine1: client.address_line1,
        addressLine2: client.address_line2,
        city: client.address_city, state: client.address_state, postalCode: client.address_postal_code,
      },
      verificationGroups, entityTranscripts: [],
      selfSigned8821: null,
      monitoringGroups, notes,
    },
    client,
    computedTotal: useNewRateModel ? computedTotal : computedTotal, // placeholder for future rate model
  };
}

async function sendCalStatewide() {
  const { data: c } = await supabase.from('clients').select('id').eq('slug', 'california-statewide-cdc').single() as { data: any };
  const { input, client, computedTotal } = await buildBreakdownInput({
    clientId: c.id, periodStart: '2026-04-01', periodEnd: '2026-04-30',
    invoiceNumber: 'USAGE-2026-04-CALSTATE', invoiceRow: null,
  });
  const pdf = await renderInvoicePdf(input);
  await writeFile('/tmp/calstatewide-april-trial.pdf', pdf);
  console.log(`Cal Statewide PDF: /tmp/calstatewide-april-trial.pdf (${pdf.length} bytes)`);
  await sendInvoiceBreakdownEmail({
    to: client.billing_ap_email, cc: client.billing_ap_email_cc || [],
    clientName: client.name,
    invoiceNumber: 'USAGE-2026-04-CALSTATE',
    billingPeriodStart: '2026-04-01', billingPeriodEnd: '2026-04-30',
    totalAmount: computedTotal, totalEntities: input.verificationGroups.reduce((s, g) => s + g.entities.length, 0),
    pdfBytes: pdf, pdfFilename: 'ModernTax-USAGE-2026-04-CALSTATE.pdf',
    mode: 'trial', trialCreditApplied: computedTotal,
  });
  console.log(`Cal Statewide email sent → ${client.billing_ap_email} ($${computedTotal} usage, $0 due)`);
}

async function sendClearfirm() {
  const invoiceId = '6519dad1-8e58-4604-b3a7-0bbe71ed487b';
  const { data: inv } = await supabase.from('invoices').select('*').eq('id', invoiceId).single() as { data: any };
  const { data: c } = await supabase.from('clients').select('id').eq('slug', 'clearfirm').single() as { data: any };
  const { input, client, computedTotal } = await buildBreakdownInput({
    clientId: c.id, periodStart: inv.billing_period_start, periodEnd: inv.billing_period_end,
    invoiceNumber: inv.invoice_number, invoiceRow: inv,
  });
  const pdf = await renderInvoicePdf(input);
  await writeFile('/tmp/clearfirm-april-breakdown.pdf', pdf);
  console.log(`Clearfirm PDF: /tmp/clearfirm-april-breakdown.pdf (${pdf.length} bytes)`);
  await sendInvoiceBreakdownEmail({
    to: client.billing_ap_email, cc: client.billing_ap_email_cc || [],
    clientName: client.name, invoiceNumber: inv.invoice_number,
    billingPeriodStart: inv.billing_period_start, billingPeriodEnd: inv.billing_period_end,
    totalAmount: Number(inv.total_amount), totalEntities: input.verificationGroups.reduce((s, g) => s + g.entities.length, 0),
    pdfBytes: pdf, pdfFilename: `ModernTax-${inv.invoice_number}.pdf`,
    mode: 'billed', payUrl: inv.mercury_pay_url || undefined,
  });
  console.log(`Clearfirm email sent → ${client.billing_ap_email} (CC ${(client.billing_ap_email_cc || []).join(', ') || 'none'})`);
}

async function sendTmcReminder() {
  // INV-16 is a $2,500 onboarding deposit, not a usage invoice.
  // Send a simple reminder email with the Mercury pay link, no breakdown PDF.
  const grace = 'grace@tmcfinancing.com';
  const kisha = 'kisha@tmcfinancing.com';
  const payUrl = 'https://app.mercury.com/pay/3s0yc77lxlvfkjnn';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; line-height:1.6; color:#333; max-width:600px; margin:0 auto; padding:24px;">
<div style="background:linear-gradient(135deg,#0A1929 0%,#102A43 100%); color:#fff; padding:32px 24px; border-radius:8px 8px 0 0; border-bottom:4px solid #00C48C;">
<h1 style="margin:0; font-size:22px;">TMC Financing - Activation Invoice Reminder</h1>
</div>
<div style="background:#fff; padding:32px 24px; border-radius:0 0 8px 8px; box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<p>Hi Grace, Kisha,</p>
<p>Quick reminder that the <strong>$2,500 ModernTax activation invoice (INV-16)</strong> is due <strong>by Tuesday, May 5</strong>. Once paid, your account is fully activated and TMC moves to the contracted PAYG rate of $59.98 per Complete Verification (TRT + ROA).</p>
<table style="width:100%; border-collapse:collapse; margin:20px 0; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px;">
<tr><td style="padding:10px 14px; border-bottom:1px solid #e2e8f0;"><strong>Invoice number</strong></td><td style="padding:10px 14px; border-bottom:1px solid #e2e8f0; text-align:right;">INV-16</td></tr>
<tr><td style="padding:10px 14px; border-bottom:1px solid #e2e8f0;"><strong>Description</strong></td><td style="padding:10px 14px; border-bottom:1px solid #e2e8f0; text-align:right;">Onboarding + Credits (deposit)</td></tr>
<tr><td style="padding:10px 14px; border-bottom:1px solid #e2e8f0;"><strong>Amount due</strong></td><td style="padding:10px 14px; border-bottom:1px solid #e2e8f0; text-align:right; font-size:18px; color:#0a1929;"><strong>$2,500.00</strong></td></tr>
<tr><td style="padding:10px 14px;"><strong>Due date</strong></td><td style="padding:10px 14px; text-align:right; color:#dc2626;"><strong>Tuesday, May 5, 2026</strong></td></tr>
</table>
<p style="text-align:center; margin:32px 0;">
<a href="${payUrl}" style="display:inline-block; background:#00C48C; color:#fff; padding:14px 32px; border-radius:6px; text-decoration:none; font-weight:600; font-size:15px;">Pay $2,500 via Mercury &nbsp;&rarr;</a>
</p>
<p style="text-align:center; font-size:13px; color:#666;">Direct link: <a href="${payUrl}" style="color:#0066cc;">${payUrl}</a></p>
<p style="font-size:13px; color:#666; margin-top:24px;"><strong>Tip:</strong> Mercury supports auto-pay enrollment from the pay page - one-click setup means future monthly usage invoices auto-debit. Saves us both the AR back-and-forth.</p>
<p>The deposit is applied as credit against your first month of usage at the $59.98 rate. Questions? Reply here and I'll dig in.</p>
<p>Thanks,<br>Matt Parker<br>ModernTax</p>
</div>
</body></html>`;

  await sgMail.send({
    to: grace, cc: [kisha],
    from: process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io',
    subject: 'TMC Financing - $2,500 activation invoice reminder (due May 5)',
    html, replyTo: 'matt@moderntax.io',
  });
  console.log(`TMC reminder sent → ${grace} (CC ${kisha})`);
}

async function main() {
  if (target === 'calstatewide' || target === 'all') await sendCalStatewide();
  if (target === 'clearfirm' || target === 'all') await sendClearfirm();
  if (target === 'tmc-reminder' || target === 'all') await sendTmcReminder();
}

function formatMdy(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

main().catch(e => { console.error(e); process.exit(1); });
