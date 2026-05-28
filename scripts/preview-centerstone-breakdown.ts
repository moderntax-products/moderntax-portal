/**
 * Render the Centerstone April breakdown locally — same data-pull as the
 * production endpoint, but writes PDF + email HTML to /tmp instead of
 * sending. Lets Matt eyeball the artifact before we fire for real.
 *
 * Run: npx tsx scripts/preview-centerstone-breakdown.ts
 */

import { writeFile } from 'fs/promises';
import { config } from 'dotenv';
config({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
import { renderInvoicePdf, type VerificationGroup, type MonitoringGroup } from '../lib/invoice-pdf';

const CENTERSTONE_INVOICE_ID = '31b840e9-e464-4c58-8e1c-1bb3e279357f';
const NEW_MODEL_EFFECTIVE = '2026-05-01';

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: inv } = await supabase
    .from('invoices')
    .select(
      'id, invoice_number, billing_period_start, billing_period_end, due_date, ' +
      'total_amount, mercury_pay_url, ' +
      'clients ( id, name, slug, free_trial, billing_ap_email, billing_ap_email_cc, billing_net_days, ' +
      'address_line1, address_line2, address_city, address_state, address_postal_code )',
    )
    .eq('id', CENTERSTONE_INVOICE_ID)
    .single() as { data: any };
  if (!inv) throw new Error('Centerstone invoice not found');
  const c = inv.clients;

  const periodStart = inv.billing_period_start;
  const periodEnd = inv.billing_period_end;
  const periodEndExclusive = `${periodEnd}T23:59:59.999Z`;
  const useNewRateModel = periodEnd >= NEW_MODEL_EFFECTIVE;

  // Pull entities
  const { data: rawEntities } = await supabase
    .from('request_entities')
    .select(
      'id, entity_name, form_type, completed_at, signature_id, ' +
      'requests!inner ( id, loan_number, intake_method, requested_by, client_id )',
    )
    .eq('status', 'completed')
    .eq('requests.client_id', c.id)
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
  let selfSignedCount = 0;
  for (const e of rawEntities || []) {
    const procName = profileMap.get(e.requests.requested_by) || 'Unattributed';
    let g = verificationByProcessor.get(procName);
    if (!g) { g = { processorName: procName, entities: [] }; verificationByProcessor.set(procName, g); }
    const intake = e.requests.intake_method || 'pdf';
    const unitPrice = intake === 'csv' ? 69.98 : 59.98;
    g.entities.push({
      entityName: e.entity_name || '(unnamed)',
      formType: e.form_type || '-',
      loanNumber: e.requests.loan_number || '',
      completedAt: formatMdy(e.completed_at),
      unitPrice,
    });
    if (e.signature_id) selfSignedCount++;
  }
  const verificationGroups = Array.from(verificationByProcessor.values())
    .map(g => ({ ...g, entities: g.entities.sort((a, b) => a.completedAt.localeCompare(b.completedAt)) }))
    .sort((a, b) => b.entities.length - a.entities.length);

  // Legacy monitoring ($25/mo prorated)
  const { data: legacyMon } = await supabase
    .from('entity_monitoring')
    .select('id, entity_id, frequency, enrolled_at, cancelled_at, status, ' +
      'request_entities ( entity_name, requests ( loan_number, requested_by ) )')
    .eq('client_id', c.id)
    .lte('enrolled_at', periodEndExclusive)
    .or(`cancelled_at.is.null,cancelled_at.gte.${periodStart}`) as { data: any[] | null };

  const monitoringByProcessor = new Map<string, MonitoringGroup>();
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
    const ent = m.request_entities?.entity_name || '(entity)';
    g.items.push({
      description: `${ent} - Monthly Monitoring (${activeDays}/${Math.round(daysInMonth)} days active)`,
      loanNumber: m.request_entities?.requests?.loan_number || '',
      date: formatMdy(m.enrolled_at),
      unitPrice: prorated,
    });
  }
  const monitoringGroups = Array.from(monitoringByProcessor.values());

  const verificationTotal = verificationGroups.reduce((s, g) => s + g.entities.reduce((a, e) => a + e.unitPrice, 0), 0);
  const monitoringTotal = monitoringGroups.reduce((s, g) => s + g.items.reduce((a, i) => a + i.unitPrice, 0), 0);
  const computedTotal = Math.round((verificationTotal + monitoringTotal) * 100) / 100;

  const pdfBytes = await renderInvoicePdf({
    invoiceNumber: inv.invoice_number,
    invoiceDate: new Date().toISOString().split('T')[0],
    dueDate: inv.due_date,
    billingPeriodStart: periodStart,
    billingPeriodEnd: periodEnd,
    paymentTerms: `Net ${c.billing_net_days ?? 5} - ACH`,
    payUrl: inv.mercury_pay_url,
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
    selfSigned8821: useNewRateModel && selfSignedCount > 0
      ? { count: selfSignedCount, unitPrice: 10, total: selfSignedCount * 10 } : null,
    monitoringGroups,
    notes: [
      'Payment via ACH. Mercury delivers the formal invoice + pay link separately.',
      'Auto-pay enrollment is one click on the Mercury pay page - saves us both the back-and-forth.',
      "Questions? Reply to this email and I'll dig in.",
    ],
  });

  await writeFile('/tmp/centerstone-april-breakdown.pdf', pdfBytes);
  console.log(`PDF: /tmp/centerstone-april-breakdown.pdf (${pdfBytes.length} bytes)`);
  console.log(`Recipient: ${c.billing_ap_email}`);
  console.log(`CC:        ${(c.billing_ap_email_cc || []).join(', ') || '(none)'}`);
  console.log(`Subject:   ${c.name} - April 2026 usage breakdown (${inv.invoice_number})`);
  console.log(`Verif total: $${verificationTotal.toFixed(2)}`);
  console.log(`Monitoring:  $${monitoringTotal.toFixed(2)}`);
  console.log(`Computed:    $${computedTotal.toFixed(2)}`);
  console.log(`Mercury bid: $${inv.total_amount}`);
  console.log(`Pay URL:     ${inv.mercury_pay_url}`);
}

function formatMdy(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

main().catch(e => { console.error(e); process.exit(1); });
