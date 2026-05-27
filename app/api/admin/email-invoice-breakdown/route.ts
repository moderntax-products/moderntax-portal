/**
 * Email Invoice Breakdown
 *
 * Generates the standardized itemized PDF (entities × processor × monitoring,
 * INV-17 style) and emails it to the client's AP recipients as a follow-up
 * to the Mercury invoice email.
 *
 * Usage:
 *   POST /api/admin/email-invoice-breakdown
 *     ?invoiceId=<uuid>          → billed mode (Mercury invoice exists)
 *     ?clientSlug=<slug>&period=YYYY-MM  → trial mode (no Mercury invoice;
 *                                   nudges client to set up billing)
 *     ?dryRun=1                  → preview the input without sending
 *
 * Auth: Bearer CRON_SECRET (matches the auto-invoice cron's auth model so
 * a single secret rotation covers the whole billing pipeline).
 *
 * Notes:
 *   - Designed to be safe to re-run. The PDF is regenerated each call from
 *     the live entity data; mailing the same breakdown twice is fine.
 *   - Trial mode is for clients with `clients.free_trial = true` so they
 *     still receive the usage recap + a nudge to set up Mercury billing
 *     before the trial ends.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import {
  renderInvoicePdf,
  type InvoicePdfInput,
  type VerificationGroup,
  type MonitoringGroup,
} from '@/lib/invoice-pdf';
import { sendInvoiceBreakdownEmail } from '@/lib/sendgrid';
import { requireBearer } from '@/lib/auth-util';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function handle(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const invoiceId = url.searchParams.get('invoiceId');
  const clientSlug = url.searchParams.get('clientSlug');
  const periodArg = url.searchParams.get('period'); // "YYYY-MM"
  const dryRun = url.searchParams.get('dryRun') === '1';

  const supabase = createAdminClient();

  // Resolve client + period bounds + Mercury context
  let mode: 'billed' | 'trial';
  let clientRow: any;
  let invoiceRow: any | null = null;
  let periodStart: string;
  let periodEnd: string;
  let invoiceNumber: string;

  if (invoiceId) {
    const { data, error } = await supabase
      .from('invoices')
      .select(
        'id, invoice_number, billing_period_start, billing_period_end, due_date, ' +
        'total_amount, total_entities, mercury_pay_url, ' +
        'clients ( id, name, slug, free_trial, billing_ap_email, billing_ap_email_cc, billing_net_days, ' +
        'address_line1, address_line2, address_city, address_state, address_postal_code )',
      )
      .eq('id', invoiceId)
      .single() as { data: any; error: any };
    if (error || !data) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }
    invoiceRow = data;
    clientRow = data.clients;
    if (!clientRow) {
      return NextResponse.json({ error: 'Invoice has no joined client row' }, { status: 500 });
    }
    mode = clientRow.free_trial ? 'trial' : 'billed';
    periodStart = data.billing_period_start;
    periodEnd = data.billing_period_end;
    invoiceNumber = data.invoice_number;
  } else if (clientSlug && periodArg) {
    const { data: c } = await supabase
      .from('clients')
      .select('id, name, slug, free_trial, billing_ap_email, billing_ap_email_cc, billing_net_days, ' +
        'address_line1, address_line2, address_city, address_state, address_postal_code')
      .eq('slug', clientSlug)
      .single();
    if (!c) return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    clientRow = c;
    // clientSlug+period mode is for clients with no invoice yet (free trial,
    // pre-MSA usage, MSA-effective-mid-period, etc.). Always treat as trial-
    // mode for the email — usage recap + Mercury billing-setup CTA. The
    // free_trial flag isn't required: any "we didn't bill you" surface gets
    // the same treatment.
    mode = 'trial';
    const [yearStr, monthStr] = periodArg.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    if (!year || !month) {
      return NextResponse.json({ error: 'period must be YYYY-MM' }, { status: 400 });
    }
    periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
    periodEnd = new Date(year, month, 0).toISOString().split('T')[0];
    invoiceNumber = `USAGE-${year}-${String(month).padStart(2, '0')}-${(c as any).slug.toUpperCase().slice(0, 6).replace(/[^A-Z0-9]/g, '')}`;
  } else {
    return NextResponse.json(
      { error: 'Provide either invoiceId, or clientSlug + period (YYYY-MM)' },
      { status: 400 },
    );
  }

  if (!clientRow.billing_ap_email) {
    return NextResponse.json(
      { error: `Client ${clientRow.name} has no billing_ap_email - cannot send breakdown` },
      { status: 400 },
    );
  }

  // Rate model cutover: the new rate spec ($10 self-signed 8821 surcharge,
  // monitoring billed event-based at $19.99 enrollment + $39.99/pull) lands
  // 2026-05-01. Any billing period ending before that uses the legacy model
  // (no 8821 surcharge, monitoring prorated at $25/month) so the breakdown
  // reconciles to what Mercury actually billed in March/April.
  const NEW_MODEL_EFFECTIVE = '2026-05-01';
  const useNewRateModel = periodEnd >= NEW_MODEL_EFFECTIVE;

  // Re-fetch the client's billing model so we know whether this is per-TIN or
  // subscription. Subscription clients (Clearfirm) are billed a flat monthly
  // fee — the breakdown shows the entities used in the period as informational
  // context, not as line items charged at the per-TIN rate.
  const { data: billingConfig } = await supabase
    .from('clients')
    .select('billing_model, subscription_monthly_amount, subscription_included_entities, ' +
      'subscription_overage_rate, billing_rate_pdf, billing_rate_csv')
    .eq('id', clientRow.id)
    .single() as { data: any };
  const isSubscription = billingConfig?.billing_model === 'subscription';
  const subscriptionMonthly = billingConfig?.subscription_monthly_amount || 0;
  const subscriptionIncluded = billingConfig?.subscription_included_entities || 0;
  const subscriptionOverageRate = billingConfig?.subscription_overage_rate || 0;
  const ratePdf = billingConfig?.billing_rate_pdf || 59.98;
  const rateCsv = billingConfig?.billing_rate_csv || 69.98;

  // Pull the period's completed entities, joined to processor + request meta.
  const periodEndExclusive = `${periodEnd}T23:59:59.999Z`;
  const { data: rawEntities, error: entError } = await supabase
    .from('request_entities')
    .select(
      'id, entity_name, form_type, completed_at, signature_id, ' +
      'requests!inner ( id, loan_number, intake_method, requested_by, client_id )',
    )
    .eq('status', 'completed')
    .eq('requests.client_id', clientRow.id)
    .gte('completed_at', `${periodStart}T00:00:00Z`)
    .lte('completed_at', periodEndExclusive) as { data: any[] | null; error: any };

  if (entError) {
    return NextResponse.json({ error: 'Failed to load entities', details: entError.message }, { status: 500 });
  }

  // Resolve processor names — collect distinct requester IDs and look up profiles
  const requesterIds = Array.from(new Set((rawEntities || []).map(e => e.requests.requested_by).filter(Boolean)));
  const profileMap = new Map<string, string>();
  if (requesterIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('id', requesterIds);
    for (const p of profiles || []) {
      profileMap.set((p as any).id, (p as any).full_name || (p as any).email || 'Unknown');
    }
  }

  // Group verification entities by processor.
  // Per-TIN clients: each entity's unitPrice is the actual rate billed.
  // Subscription clients: entities shown at unitPrice=0 (informational only,
  //   subscription fee handled as a single line below). Overage entities (above
  //   subscription_included_entities) are billed at subscription_overage_rate.
  const verificationByProcessor = new Map<string, VerificationGroup>();
  let selfSignedCount = 0;
  const totalCompletedCount = (rawEntities || []).length;
  for (const e of rawEntities || []) {
    const procName = profileMap.get(e.requests.requested_by) || 'Unattributed';
    let group = verificationByProcessor.get(procName);
    if (!group) {
      group = { processorName: procName, entities: [] };
      verificationByProcessor.set(procName, group);
    }
    let unitPrice: number;
    if (isSubscription) {
      // Subscription model: entities are zero-priced in the listing; the flat
      // fee + overage are emitted separately below.
      unitPrice = 0;
    } else {
      // Per Matt 2026-05-01 + Mathew's 2026-05-26 reconciliation pushback:
      // every per-TIN client uses a single flat rate (billing_rate_pdf)
      // regardless of intake method. The CSV/PDF split was a pre-contract
      // assumption that isn't in any signed SOW — Centerstone + TMC + Cal
      // Statewide are all "$59.98 flat per Complete Verification". The
      // auto-invoice cron and Mercury invoice both bill flat; this
      // breakdown was the lone caller still using the old split and
      // producing totals that didn't reconcile to Mercury. Now flat too.
      unitPrice = ratePdf;
      void rateCsv;  // intentionally unused — keep for legacy reference
    }
    group.entities.push({
      entityName: e.entity_name || '(unnamed)',
      formType: e.form_type || '-',
      loanNumber: e.requests.loan_number || '',
      completedAt: formatMdy(e.completed_at),
      unitPrice,
    });
    if (e.signature_id) selfSignedCount += 1;
  }

  // Sort processors by group total descending so biggest contributor shows first
  let verificationGroups: VerificationGroup[] = Array.from(verificationByProcessor.values())
    .map(g => ({
      ...g,
      entities: g.entities.sort((a, b) => a.completedAt.localeCompare(b.completedAt)),
    }))
    .sort((a, b) => b.entities.length - a.entities.length);

  // Subscription clients: prepend a synthetic "Monthly Subscription Plan" row
  // showing the flat fee, then optionally an overage row. The per-entity rows
  // below stay zero-priced (informational). This keeps the breakdown total
  // reconciling to what Mercury billed for subscription accounts.
  if (isSubscription) {
    const usedCount = totalCompletedCount;
    const overageCount = Math.max(0, usedCount - subscriptionIncluded);
    const subscriptionGroup: VerificationGroup = {
      processorName: 'Monthly Subscription Plan',
      entities: [{
        entityName: `Flat monthly fee  -  up to ${subscriptionIncluded} entities included`,
        formType: '-',
        loanNumber: '-',
        completedAt: `${formatMdy(periodStart)} - ${formatMdy(periodEnd)}`,
        unitPrice: subscriptionMonthly,
      }],
    };
    if (overageCount > 0) {
      subscriptionGroup.entities.push({
        entityName: `Overage:  ${overageCount} entities above included quota`,
        formType: '-',
        loanNumber: '-',
        completedAt: '-',
        unitPrice: overageCount * subscriptionOverageRate,
      });
    }
    verificationGroups = [subscriptionGroup, ...verificationGroups];
  }

  // Self-signed 8821 surcharge ($10/entity). Per Matt 2026-05-01: every
  // CSV-uploaded or manually-entered entity triggers an 8821 send so this
  // catches the bulk of entities. Direct-uploaded pre-signed PDFs (no
  // signature_id) are excluded. Only applies under the new rate model;
  // pre-May invoices were billed without this surcharge.
  const selfSigned8821 = useNewRateModel && selfSignedCount > 0
    ? { count: selfSignedCount, unitPrice: 10, total: selfSignedCount * 10 }
    : null;

  // Monitoring activity in the period.
  // Two rate models — pick based on cutover date:
  //   New (2026-05-01+): $19.99 enrollment one-time + $39.99 per pull (event-based).
  //   Legacy (pre-2026-05-01): $25/month per active subscription, prorated by
  //   active days in period — matches what the auto-invoice cron actually
  //   billed in Mercury for March + April so the breakdown reconciles.
  const monitoringByProcessor = new Map<string, MonitoringGroup>();

  if (useNewRateModel) {
    // Event-based: enrollments (started in period) + repulls (completed in period)
    const { data: monitoringRows } = await supabase
      .from('entity_monitoring')
      .select('id, entity_id, frequency, enrolled_at, last_pulled_at, status, ' +
        'request_entities ( entity_name, requests ( loan_number, requested_by ) )')
      .eq('client_id', clientRow.id)
      .gte('enrolled_at', `${periodStart}T00:00:00Z`)
      .lte('enrolled_at', periodEndExclusive) as { data: any[] | null };

    const { data: monitoringRepulls } = await supabase
      .from('requests')
      .select('id, loan_number, requested_by, completed_at, request_entities ( entity_name )')
      .eq('client_id', clientRow.id)
      .eq('intake_method', 'monitoring_repull')
      .gte('completed_at', `${periodStart}T00:00:00Z`)
      .lte('completed_at', periodEndExclusive) as { data: any[] | null };

    for (const m of monitoringRows || []) {
      const requester = m.request_entities?.requests?.requested_by;
      const procName = profileMap.get(requester) || (await resolveProcessorName(supabase, requester));
      if (requester && !profileMap.has(requester)) profileMap.set(requester, procName);
      let group = monitoringByProcessor.get(procName);
      if (!group) { group = { processorName: procName, items: [] }; monitoringByProcessor.set(procName, group); }
      const ent = m.request_entities?.entity_name || '(entity)';
      const loan = m.request_entities?.requests?.loan_number || '';
      group.items.push({
        description: `${ent} - Monitoring Enrollment (${m.frequency || 'weekly'})`,
        loanNumber: loan,
        date: formatMdy(m.enrolled_at),
        unitPrice: 19.99,
      });
      if (m.last_pulled_at) {
        group.items.push({
          description: `${ent} - Initial Monitoring Pull`,
          loanNumber: loan,
          date: formatMdy(m.last_pulled_at),
          unitPrice: 39.99,
        });
      }
    }
    for (const r of monitoringRepulls || []) {
      const requester = r.requested_by;
      const procName = profileMap.get(requester) || (await resolveProcessorName(supabase, requester));
      if (requester && !profileMap.has(requester)) profileMap.set(requester, procName);
      let group = monitoringByProcessor.get(procName);
      if (!group) { group = { processorName: procName, items: [] }; monitoringByProcessor.set(procName, group); }
      const ent = r.request_entities?.[0]?.entity_name || '(entity)';
      group.items.push({
        description: `${ent} - Monitoring Update Pull`,
        loanNumber: r.loan_number || '',
        date: formatMdy(r.completed_at),
        unitPrice: 39.99,
      });
    }
  } else {
    // Legacy: $25/month per active subscription, prorated by active days
    const { data: legacyMonitoring } = await supabase
      .from('entity_monitoring')
      .select('id, entity_id, frequency, enrolled_at, cancelled_at, status, ' +
        'request_entities ( entity_name, requests ( loan_number, requested_by ) )')
      .eq('client_id', clientRow.id)
      .lte('enrolled_at', periodEndExclusive)
      .or(`cancelled_at.is.null,cancelled_at.gte.${periodStart}`) as { data: any[] | null };

    const periodStartMs = new Date(`${periodStart}T00:00:00Z`).getTime();
    const periodEndMs = new Date(periodEndExclusive).getTime();
    const daysInMonth = (periodEndMs - periodStartMs) / 86400000;
    for (const m of legacyMonitoring || []) {
      if (m.status === 'pending') continue;
      const requester = m.request_entities?.requests?.requested_by;
      const procName = profileMap.get(requester) || (await resolveProcessorName(supabase, requester));
      if (requester && !profileMap.has(requester)) profileMap.set(requester, procName);
      const enrolledMs = new Date(m.enrolled_at).getTime();
      const cancelledMs = m.cancelled_at ? new Date(m.cancelled_at).getTime() : Infinity;
      const windowStart = Math.max(enrolledMs, periodStartMs);
      const windowEnd = Math.min(cancelledMs, periodEndMs);
      if (windowEnd <= windowStart) continue;
      const activeDays = Math.ceil((windowEnd - windowStart) / 86400000);
      const prorated = Math.round((Math.min(activeDays, daysInMonth) / daysInMonth) * 25 * 100) / 100;
      let group = monitoringByProcessor.get(procName);
      if (!group) { group = { processorName: procName, items: [] }; monitoringByProcessor.set(procName, group); }
      const ent = m.request_entities?.entity_name || '(entity)';
      const loan = m.request_entities?.requests?.loan_number || '';
      group.items.push({
        description: `${ent} - Monthly Monitoring (${activeDays}/${Math.round(daysInMonth)} days active)`,
        loanNumber: loan,
        date: formatMdy(m.enrolled_at),
        unitPrice: prorated,
      });
    }
  }

  const monitoringGroups: MonitoringGroup[] = Array.from(monitoringByProcessor.values());

  // Recompute total from line items so the email + PDF agree exactly.
  const verificationTotal = verificationGroups.reduce(
    (s, g) => s + g.entities.reduce((a, e) => a + e.unitPrice, 0), 0);
  const monitoringTotal = monitoringGroups.reduce(
    (s, g) => s + g.items.reduce((a, i) => a + i.unitPrice, 0), 0);
  const selfSigned8821Total = selfSigned8821?.total || 0;
  const computedTotal = Math.round((verificationTotal + monitoringTotal + selfSigned8821Total) * 100) / 100;

  // Notes — different per mode
  const notes: string[] = [];
  if (mode === 'billed') {
    notes.push('Payment via ACH. Mercury delivers the formal invoice + pay link separately.');
    notes.push('Auto-pay enrollment is one click on the Mercury pay page - saves us both the back-and-forth.');
  } else {
    notes.push('Free trial active - nothing owed for this period.');
    notes.push('Set up Mercury billing so usage continues uninterrupted when the trial ends.');
  }
  notes.push("Questions? Reply to this email and I'll dig in.");

  const input: InvoicePdfInput = {
    invoiceNumber,
    invoiceDate: invoiceRow?.invoice_date || new Date().toISOString().split('T')[0],
    dueDate: invoiceRow?.due_date || new Date(Date.now() + 5 * 86400000).toISOString().split('T')[0],
    billingPeriodStart: periodStart,
    billingPeriodEnd: periodEnd,
    paymentTerms: mode === 'billed'
      ? `Net ${clientRow.billing_net_days ?? 5} - ACH`
      : 'Free Trial — no payment due',
    payUrl: invoiceRow?.mercury_pay_url || null,
    client: {
      name: clientRow.name,
      addressLine1: clientRow.address_line1,
      addressLine2: clientRow.address_line2,
      city: clientRow.address_city,
      state: clientRow.address_state,
      postalCode: clientRow.address_postal_code,
    },
    verificationGroups,
    entityTranscripts: [], // future: track entity-transcript opt-ins per entity
    selfSigned8821,
    monitoringGroups,
    notes,
  };

  if (dryRun) {
    return NextResponse.json({
      mode,
      invoiceNumber,
      periodStart,
      periodEnd,
      verificationGroups: verificationGroups.map(g => ({
        processor: g.processorName,
        entities: g.entities.length,
        subtotal: g.entities.reduce((s, e) => s + e.unitPrice, 0),
      })),
      selfSigned8821,
      monitoringGroups: monitoringGroups.map(g => ({
        processor: g.processorName,
        items: g.items.length,
        subtotal: g.items.reduce((s, i) => s + i.unitPrice, 0),
      })),
      computedTotal,
      to: clientRow.billing_ap_email,
      cc: clientRow.billing_ap_email_cc || [],
    });
  }

  const pdfBytes = await renderInvoicePdf(input);

  const filename = `ModernTax-${invoiceNumber}.pdf`;
  await sendInvoiceBreakdownEmail({
    to: clientRow.billing_ap_email,
    cc: clientRow.billing_ap_email_cc || [],
    clientName: clientRow.name,
    invoiceNumber,
    billingPeriodStart: periodStart,
    billingPeriodEnd: periodEnd,
    totalAmount: mode === 'billed' ? Number(invoiceRow?.total_amount || computedTotal) : computedTotal,
    totalEntities: verificationGroups.reduce((s, g) => s + g.entities.length, 0),
    pdfBytes,
    pdfFilename: filename,
    mode,
    payUrl: invoiceRow?.mercury_pay_url || undefined,
    trialBillingSetupUrl: mode === 'trial'
      ? `${process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io'}/manager/billing`
      : undefined,
    trialCreditApplied: mode === 'trial' ? computedTotal : undefined,
  });

  return NextResponse.json({
    success: true,
    mode,
    invoiceNumber,
    sentTo: clientRow.billing_ap_email,
    cc: clientRow.billing_ap_email_cc || [],
    totalAmount: computedTotal,
    pdfBytes: pdfBytes.length,
  });
}

async function resolveProcessorName(
  supabase: ReturnType<typeof createAdminClient>,
  uid: string | null | undefined,
): Promise<string> {
  if (!uid) return 'Unattributed';
  const { data } = await supabase.from('profiles').select('full_name, email').eq('id', uid).maybeSingle();
  return ((data as any)?.full_name || (data as any)?.email || 'Unknown');
}

function formatMdy(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const y = d.getUTCFullYear();
  return `${m}/${day}/${y}`;
}

export async function GET(request: NextRequest)  { return handle(request); }
export async function POST(request: NextRequest) { return handle(request); }
