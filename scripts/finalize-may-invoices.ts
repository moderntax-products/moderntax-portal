/**
 * Finalize May 2026 invoices for Centerstone + California Statewide CDC.
 *
 * Driver: 2026-05-22 — Matt's directive: "Finalize Centerstone and Cal
 * Statewide invoices for May to get sent out tomorrow and bill the accounts
 * next week." Memorial Day weekend (5/23 Sat–5/25 Mon) means no business
 * days remain in May after today, so we close the May books now.
 *
 * What this script does (NON-DESTRUCTIVE — no emails sent, no Mercury invoice
 * fired):
 *
 *   1. For each client, query:
 *      • All entities completed 2026-05-01 - 2026-05-31 (billable verification)
 *      • All entity_monitoring rows active during May (billable monitoring,
 *        prorated by active days × client.billing_rate_monitoring)
 *      • Pending entities (8821_sent / 8821_signed / irs_queue / processing)
 *        — INFORMATIONAL ONLY, surfaced in the "Pipeline preview" section
 *        of the breakdown PDF so the manager sees what's coming in June.
 *
 *   2. Insert a draft invoice row covering 2026-05-01 - 2026-05-31. The
 *      cron's idempotency check (`client_id + period_start + period_end`)
 *      means the regular June-1 auto-invoice cron will see this row and
 *      skip — no double-billing risk.
 *
 *   3. Render the breakdown PDF via lib/invoice-pdf to /tmp for review.
 *
 *   4. Print a summary table per client (line totals + grand total +
 *      pipeline preview + PDF path).
 *
 * Tomorrow (5/23): Matt reviews PDFs, sends breakdown emails to AP
 * recipients via /admin/billing UI (the "Send breakdown" button).
 *
 * Next week (5/26+): Matt creates Mercury invoices via the same admin UI;
 * Mercury triggers ACH and the auto-reconcile cron flips `paid_at` when
 * the wire posts.
 *
 * Run:
 *   npx -y dotenv-cli -e .env.local -- npx tsx scripts/finalize-may-invoices.ts
 */

import { writeFile } from 'fs/promises';
import { createClient } from '@supabase/supabase-js';
import { renderInvoicePdf, type VerificationGroup, type MonitoringGroup } from '../lib/invoice-pdf';

const PERIOD_START = '2026-05-01';
const PERIOD_END   = '2026-05-31';
const PERIOD_START_ISO = `${PERIOD_START}T00:00:00.000Z`;
const PERIOD_END_ISO   = `${PERIOD_END}T23:59:59.999Z`;
const DAYS_IN_MAY = 31;

const TARGET_CLIENT_NAMES = ['Centerstone SBA Lending', 'California Statewide CDC'];

// Pre-bill pending entities (status='8821_sent') so the May invoice covers
// them too. Each entity gets stamped with gross_receipts.pre_billed =
// { invoice_id, invoice_number, pre_billed_at, amount } — the auto-invoice
// cron checks this field and skips re-billing on completion (see auto-invoice
// route.ts: "Skip entities pre-billed on a prior invoice"). No double-bill.
// Set per client because not every client wants to pre-bill (Cal Statewide
// has 0 pending so this is moot for them).
const PRE_BILL_PENDING_BY_CLIENT: Record<string, boolean> = {
  'Centerstone SBA Lending':   true,  // Matt's 2026-05-22 directive
  'California Statewide CDC':  false, // 0 pending entities anyway
};

interface Summary {
  clientName: string;
  invoiceNumber: string;
  invoiceId: string;
  verificationEntities: number;
  verificationAmount: number;
  preBillEntities: number;
  preBillAmount: number;
  monitoringEntities: number;
  monitoringAmount: number;
  pipelineEntities: number;     // remaining pipeline (not pre-billed, informational)
  grandTotal: number;
  pdfPath: string;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const sb = createClient(url, key);
  const summaries: Summary[] = [];

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`Finalizing May 2026 invoices — ${PERIOD_START} - ${PERIOD_END}`);
  console.log(`Run time: ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(80)}`);

  for (const clientName of TARGET_CLIENT_NAMES) {
    const summary = await processClient(sb, clientName);
    if (summary) summaries.push(summary);
  }

  // -----------------------------------------------------------------------
  // Roll-up
  // -----------------------------------------------------------------------
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`SUMMARY`);
  console.log(`${'═'.repeat(80)}`);
  let totalRevenue = 0;
  for (const s of summaries) {
    console.log(`\n  ${s.clientName}`);
    console.log(`    Invoice:        ${s.invoiceNumber} (id=${s.invoiceId})`);
    console.log(`    Verification:   ${s.verificationEntities} entities = $${s.verificationAmount.toFixed(2)}`);
    if (s.preBillEntities > 0) {
      console.log(`    Pre-billed:     ${s.preBillEntities} entities = $${s.preBillAmount.toFixed(2)}  (8821_sent now, won't re-bill in June)`);
    }
    console.log(`    Monitoring:     ${s.monitoringEntities} entities = $${s.monitoringAmount.toFixed(2)} (prorated)`);
    console.log(`    Grand total:    $${s.grandTotal.toFixed(2)}`);
    console.log(`    Pipeline preview (informational): ${s.pipelineEntities} entities still in flight`);
    console.log(`    PDF:            ${s.pdfPath}`);
    totalRevenue += s.grandTotal;
  }
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`COMBINED MAY 2026 REVENUE BOOKED: $${totalRevenue.toFixed(2)}`);
  console.log(`${'─'.repeat(80)}\n`);
  console.log(`NEXT STEPS:`);
  console.log(`  1. Tomorrow (5/23): Review PDFs in /tmp, send breakdown emails via /admin/billing.`);
  console.log(`  2. Next week (5/26+): Create Mercury invoices via /admin/billing — ACH pulls automatically.`);
  console.log(`  3. Invoices are status='draft' until Mercury is fired; nothing has gone out yet.\n`);
}

async function processClient(sb: ReturnType<typeof createClient>, clientName: string): Promise<Summary | null> {
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`Client: ${clientName}`);
  console.log(`${'─'.repeat(80)}`);

  const { data: c } = await sb.from('clients')
    .select('id, name, slug, billing_payment_method, billing_rate_pdf, billing_rate_csv, billing_rate_monitoring, billing_net_days, billing_ap_email, billing_ap_email_cc, address_line1, address_line2, address_city, address_state, address_postal_code')
    .eq('name', clientName).single() as { data: any };
  if (!c) { console.error(`  ✗ Client not found: ${clientName}`); return null; }

  const ratePdf = c.billing_rate_pdf || 59.98;
  const monitoringRate = c.billing_rate_monitoring ?? 25;
  console.log(`  Rates: verification=$${ratePdf}/entity, monitoring=$${monitoringRate}/entity/mo`);

  // ----------- Idempotency check -----------
  const { data: existing } = await sb.from('invoices')
    .select('id, invoice_number, total_amount')
    .eq('client_id', c.id).eq('billing_period_start', PERIOD_START).eq('billing_period_end', PERIOD_END).maybeSingle() as { data: any };
  if (existing) {
    console.log(`  ✓ May invoice already exists: ${existing.invoice_number} ($${existing.total_amount}) — skipping create, will re-render PDF only.`);
  }

  // ----------- Pull completed entities -----------
  const { data: completed } = await sb.from('request_entities')
    .select(`id, entity_name, form_type, completed_at, signature_id, requests!inner(id, loan_number, intake_method, requested_by, client_id)`)
    .eq('status', 'completed').eq('requests.client_id', c.id)
    .gte('completed_at', PERIOD_START_ISO).lte('completed_at', PERIOD_END_ISO).order('completed_at') as { data: any[] };
  console.log(`  Completed entities (May 1 - today): ${completed?.length || 0}`);

  // Group by processor for the PDF
  const requesterIds = Array.from(new Set((completed || []).map((e: any) => e.requests.requested_by).filter(Boolean)));
  const profileMap = new Map<string, string>();
  if (requesterIds.length > 0) {
    const { data: profs } = await sb.from('profiles').select('id, full_name, email').in('id', requesterIds) as { data: any[] };
    for (const p of profs || []) profileMap.set(p.id, p.full_name || p.email || 'Unknown');
  }

  const verificationByProcessor = new Map<string, VerificationGroup>();
  let verificationAmount = 0;
  let selfSigned8821Count = 0;
  for (const e of (completed || [])) {
    const procName = profileMap.get(e.requests.requested_by) || 'Unattributed';
    let g = verificationByProcessor.get(procName);
    if (!g) { g = { processorName: procName, entities: [] }; verificationByProcessor.set(procName, g); }
    g.entities.push({
      entityName: e.entity_name || '(unnamed)',
      formType: e.form_type || '-',
      loanNumber: e.requests.loan_number || '',
      completedAt: formatMdy(e.completed_at),
      unitPrice: ratePdf,
    });
    verificationAmount += ratePdf;
    if (e.signature_id) selfSigned8821Count++;
  }
  verificationAmount = Math.round(verificationAmount * 100) / 100;
  const verificationGroups = Array.from(verificationByProcessor.values())
    .map(g => ({ ...g, entities: g.entities.sort((a, b) => a.completedAt.localeCompare(b.completedAt)) }))
    .sort((a, b) => b.entities.length - a.entities.length);

  // ----------- Pull monitoring (prorated) -----------
  // Only bill rows that were actually a paying subscription during May:
  // active / paused / mid-May-cancelled. Exclude expired (10-year 8821
  // window auto-cancellation) and pending (signup not yet completed).
  // The cron in /api/cron/auto-invoice has the same logic — keep these
  // numbers reconciled so the regular June-1 run won't drift.
  const { data: monitoring } = await sb.from('entity_monitoring')
    .select(`id, status, enrolled_at, cancelled_at, frequency, per_pull_fee, request_entities ( entity_name, requests ( loan_number, requested_by ) )`)
    .eq('client_id', c.id)
    .in('status', ['active', 'paused', 'cancelled'])
    .lte('enrolled_at', PERIOD_END_ISO)
    .or(`cancelled_at.is.null,cancelled_at.gte.${PERIOD_START}`) as { data: any[] };

  const monitoringByProcessor = new Map<string, MonitoringGroup>();
  let monitoringAmount = 0;
  let monitoringEntities = 0;
  const periodStartMs = new Date(PERIOD_START_ISO).getTime();
  const periodEndMs = new Date(PERIOD_END_ISO).getTime() + 1;
  for (const m of (monitoring || [])) {
    if (m.status === 'pending') continue;
    const enrolledMs = new Date(m.enrolled_at).getTime();
    const cancelledMs = m.cancelled_at ? new Date(m.cancelled_at).getTime() : Infinity;
    // Skip "enrolled-and-cancelled within the same billing period" rows.
    // These are bulk-enroll mistakes / test enrollments (e.g. Centerstone
    // had 216 rows enrolled 5/7 and cancelled 5/11-5/19 — Matt's bulk
    // enroll that the client opted out of). Billing for 4-12 days of an
    // explicitly-cancelled subscription would torch the relationship.
    if (enrolledMs >= periodStartMs && cancelledMs <= periodEndMs) {
      continue;
    }
    const ws = Math.max(enrolledMs, periodStartMs);
    const we = Math.min(cancelledMs, periodEndMs);
    if (we <= ws) continue;
    const activeDays = Math.ceil((we - ws) / 86400000);
    const prorated = Math.round((Math.min(activeDays, DAYS_IN_MAY) / DAYS_IN_MAY) * monitoringRate * 100) / 100;
    const requester = m.request_entities?.requests?.requested_by;
    const procName = profileMap.get(requester) || 'Unattributed';
    let g = monitoringByProcessor.get(procName);
    if (!g) { g = { processorName: procName, items: [] }; monitoringByProcessor.set(procName, g); }
    g.items.push({
      description: `${m.request_entities?.entity_name || '(entity)'} - Monitoring (${activeDays}/${DAYS_IN_MAY} days active in May)`,
      loanNumber: m.request_entities?.requests?.loan_number || '',
      date: formatMdy(m.enrolled_at),
      unitPrice: prorated,
    });
    monitoringAmount += prorated;
    monitoringEntities += 1;
  }
  monitoringAmount = Math.round(monitoringAmount * 100) / 100;
  const monitoringGroups = Array.from(monitoringByProcessor.values());
  console.log(`  Monitoring: ${monitoringEntities} entities (prorated) = $${monitoringAmount.toFixed(2)}`);

  // ----------- Pull pending entities -----------
  const { data: pending } = await sb.from('request_entities')
    .select(`id, entity_name, form_type, status, updated_at, gross_receipts, requests!inner(loan_number, requested_by, client_id)`)
    .eq('requests.client_id', c.id).in('status', ['8821_sent','8821_signed','irs_queue','processing']) as { data: any[] };

  // Decide: pre-bill these pending entities, or surface them as informational?
  const shouldPreBill = !!PRE_BILL_PENDING_BY_CLIENT[c.name];
  const preBillTargets = shouldPreBill ? (pending || []).filter((e: any) => !e.gross_receipts?.pre_billed?.invoice_id) : [];

  let preBillAmount = 0;
  const preBillByProcessor = new Map<string, VerificationGroup>();
  if (preBillTargets.length > 0) {
    for (const e of preBillTargets) {
      const procName = profileMap.get(e.requests.requested_by) || 'Unattributed';
      let g = preBillByProcessor.get(procName);
      if (!g) { g = { processorName: procName, entities: [] }; preBillByProcessor.set(procName, g); }
      g.entities.push({
        entityName: `${e.entity_name || '(unnamed)'} (PRE-BILL: ${prettyStatus(e.status)})`,
        formType: e.form_type || '-',
        loanNumber: e.requests.loan_number || '',
        completedAt: 'pending',
        unitPrice: ratePdf,
      });
      preBillAmount += ratePdf;
    }
    preBillAmount = Math.round(preBillAmount * 100) / 100;
    console.log(`  Pre-billing ${preBillTargets.length} pending entities × $${ratePdf} = $${preBillAmount.toFixed(2)}`);
  }

  // Merge pre-bill groups into verificationGroups so they render in the
  // standard "Tax Verification Services" PDF section, distinguished by the
  // "(PRE-BILL: ...)" suffix on the entity name. No new layout needed.
  for (const [proc, g] of preBillByProcessor) {
    const existing = verificationGroups.find(vg => vg.processorName === proc);
    if (existing) existing.entities.push(...g.entities);
    else verificationGroups.push(g);
  }
  // Re-sort merged groups
  verificationGroups.sort((a, b) => b.entities.length - a.entities.length);

  // Pipeline-preview note (covers any pending we did NOT pre-bill, or all pending if pre-bill was off)
  console.log(`  Pipeline (informational, not billed): ${(pending?.length || 0) - preBillTargets.length}`);
  const pipelineLines: string[] = [];
  const remainingPending = (pending || []).filter((e: any) => !preBillTargets.includes(e));
  if (remainingPending.length > 0) {
    const byStatus = remainingPending.reduce((m: any, e: any) => { m[e.status] = (m[e.status]||[]); m[e.status].push(e); return m; }, {});
    pipelineLines.push(``);
    pipelineLines.push(`PIPELINE PREVIEW (not billed in May — will appear on June invoice as completions land):`);
    for (const status of ['8821_sent','8821_signed','irs_queue','processing']) {
      const items = byStatus[status] || [];
      if (items.length === 0) continue;
      pipelineLines.push(`  ${prettyStatus(status)} (${items.length}):`);
      for (const e of items.slice(0, 20)) {
        const proc = profileMap.get(e.requests.requested_by) || 'Unattributed';
        pipelineLines.push(`     • ${e.entity_name} (${e.form_type || '-'}) - loan ${e.requests.loan_number || '-'} - submitted by ${proc}`);
      }
      if (items.length > 20) pipelineLines.push(`     ...and ${items.length - 20} more`);
    }
  }
  if (preBillTargets.length > 0) {
    pipelineLines.push(``);
    pipelineLines.push(`NOTE: ${preBillTargets.length} entit${preBillTargets.length === 1 ? 'y is' : 'ies are'} pre-billed on this invoice while awaiting IRS callback completion. They will NOT appear on the June invoice.`);
  }

  // ----------- Grand total -----------
  const grandTotal = Math.round((verificationAmount + preBillAmount + monitoringAmount) * 100) / 100;
  console.log(`  Verification: $${verificationAmount.toFixed(2)} | Pre-bill: $${preBillAmount.toFixed(2)} | Monitoring: $${monitoringAmount.toFixed(2)} | GRAND TOTAL: $${grandTotal.toFixed(2)}`);

  // ----------- Invoice row (or reuse existing) -----------
  let invoiceId: string;
  let invoiceNumber: string;
  if (existing) {
    invoiceId = existing.id;
    invoiceNumber = existing.invoice_number;
    // If totals differ from the existing draft (e.g. monitoring filter
    // tightened), update the row so Mercury bills the right amount.
    if (Math.abs(Number(existing.total_amount) - grandTotal) > 0.01) {
      console.log(`  ! Recomputing existing draft: was $${existing.total_amount}, now $${grandTotal.toFixed(2)} — updating`);
      await sb.from('invoices').update({
        total_entities: (completed?.length || 0) + preBillTargets.length,
        total_amount: grandTotal,
        monitoring_entities: monitoringEntities,
        monitoring_amount: monitoringAmount,
      } as any).eq('id', invoiceId);
    }
  } else {
    const slugUpper = (c.slug || c.name).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    invoiceNumber = `INV-2026-05-${slugUpper}`;
    const netDays = c.billing_net_days ?? 5;
    const invoiceDate = new Date().toISOString().split('T')[0];
    const dueDateObj = new Date(invoiceDate);
    dueDateObj.setUTCDate(dueDateObj.getUTCDate() + netDays);
    const dueDate = dueDateObj.toISOString().split('T')[0];

    const { data: ins, error: insErr } = await sb.from('invoices').insert({
      client_id: c.id,
      invoice_number: invoiceNumber,
      billing_period_start: PERIOD_START,
      billing_period_end: PERIOD_END,
      total_entities: (completed?.length || 0) + preBillTargets.length,
      total_amount: grandTotal,
      monitoring_entities: monitoringEntities,
      monitoring_amount: monitoringAmount,
      status: 'draft',
      payment_method: c.billing_payment_method || 'ach',
      due_date: dueDate,
      notes: 'May 2026 close — Memorial Day finalization (5/22). Mercury invoice + breakdown email staged separately.',
    }).select('id').single() as { data: any; error: any };
    if (insErr || !ins) { console.error(`  ✗ Failed to insert invoice:`, insErr); return null; }
    invoiceId = ins.id;
    console.log(`  ✓ Inserted draft invoice ${invoiceNumber} (id=${invoiceId})`);
  }

  // ----------- Stamp pre-bill on entities AFTER we have the invoice id -----------
  if (preBillTargets.length > 0) {
    const stampedAt = new Date().toISOString();
    for (const e of preBillTargets) {
      const merged = {
        ...(e.gross_receipts || {}),
        pre_billed: {
          invoice_id: invoiceId,
          invoice_number: invoiceNumber,
          pre_billed_at: stampedAt,
          amount: ratePdf,
          status_at_pre_bill: e.status,
        },
      };
      const { error: updErr } = await sb.from('request_entities').update({ gross_receipts: merged } as any).eq('id', e.id);
      if (updErr) console.error(`  ! Failed to stamp pre_billed on ${e.entity_name} (${e.id}): ${updErr.message}`);
    }
    console.log(`  ✓ Stamped pre_billed marker on ${preBillTargets.length} entities — June cron will skip them`);
  }

  // ----------- Render PDF -----------
  const pdfBytes = await renderInvoicePdf({
    invoiceNumber,
    invoiceDate: new Date().toISOString().split('T')[0],
    dueDate: (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + (c.billing_net_days ?? 5)); return d.toISOString().split('T')[0]; })(),
    billingPeriodStart: PERIOD_START,
    billingPeriodEnd: PERIOD_END,
    paymentTerms: `Net ${c.billing_net_days ?? 5} - ACH`,
    payUrl: null,  // Mercury pay URL will be generated when invoice fires next week
    client: {
      name: c.name,
      addressLine1: c.address_line1,
      addressLine2: c.address_line2,
      city: c.address_city,
      state: c.address_state,
      postalCode: c.address_postal_code,
    },
    verificationGroups,
    entityTranscripts: [],
    selfSigned8821: null,  // not used for these clients
    monitoringGroups,
    notes: [
      'Period covered: May 1 - May 31, 2026 (full month finalized 5/22 — Memorial Day weekend close).',
      'Mercury ACH invoice will be created next week (5/26+); pay link arrives via separate Mercury email.',
      'Auto-pay enrollment is one click on the Mercury pay page — saves us both the back-and-forth.',
      ...pipelineLines,
      "Questions? Reply to this email and I'll dig in.",
    ],
  });

  const safeName = c.slug || c.name.toLowerCase().replace(/\s+/g, '-');
  const pdfPath = `/tmp/${safeName}-may-2026-breakdown.pdf`;
  await writeFile(pdfPath, pdfBytes);
  console.log(`  ✓ PDF rendered: ${pdfPath}`);

  return {
    clientName: c.name,
    invoiceNumber,
    invoiceId,
    verificationEntities: completed?.length || 0,
    verificationAmount,
    preBillEntities: preBillTargets.length,
    preBillAmount,
    monitoringEntities,
    monitoringAmount,
    pipelineEntities: (pending?.length || 0) - preBillTargets.length,
    grandTotal,
    pdfPath,
  };
}

function formatMdy(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

function prettyStatus(s: string): string {
  switch (s) {
    case '8821_sent':   return '8821 sent (awaiting borrower signature)';
    case '8821_signed': return '8821 signed (ready for expert)';
    case 'irs_queue':   return 'In IRS PPS queue';
    case 'processing':  return 'Expert on IRS call';
    default:            return s;
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
