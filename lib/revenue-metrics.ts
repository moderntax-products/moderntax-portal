/**
 * Revenue metrics — computed from the invoices table, which is kept in sync
 * with Mercury via the daily mercury-reconcile cron. No Mercury API call is
 * made here (fast server-side computation for the admin dashboard).
 *
 * Returned shape is used by app/admin/page.tsx to render:
 *   • Headline KPIs (all-time, YTD, Q2 paid, Q2 booked, open AR)
 *   • Q2 progress bar vs $228,000 target
 *   • Per-client breakdown (current billing status, last paid, MTD activity)
 *   • Open AR aging buckets
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface RevenueMetrics {
  today_iso: string;
  quarter_label: string;
  q2_target_dollars: number;

  totals: {
    paid_all_time: number;
    paid_ytd: number;
    paid_q2: number;
    open_ar_q2: number;           // billed but not yet paid in Q2
    booked_q2: number;            // paid_q2 + open_ar_q2
    projected_q2: number;         // booked_q2 + expected subscription fills
  };

  client_rows: ClientRevenueRow[];
  ar_aging: ArAgingBuckets;
}

export interface ClientRevenueRow {
  client_id: string;
  client_name: string;
  billing_model: 'per_tin' | 'subscription';
  paid_all_time: number;
  paid_ytd: number;
  paid_q2: number;
  open_ar: number;
  last_paid_at: string | null;
  last_paid_amount: number | null;
  billing_notes: string | null;
  pending_signature: boolean;
  /** Entities completed this calendar month (for subscription usage + PAYG tracking). */
  entities_mtd: number;
  subscription_included: number | null;
  subscription_monthly_amount: number | null;
}

export interface ArAgingBuckets {
  current: { invoice_count: number; amount: number };   // 0–14 days since due
  overdue_15_30: { invoice_count: number; amount: number };
  overdue_30_plus: { invoice_count: number; amount: number };
  /** Invoices whose underlying contract is not yet countersigned (e.g. TMC). */
  pending_signature: { invoice_count: number; amount: number };
  /** All open-AR invoices, highest amount first, for a compact table. */
  rows: ArAgingRow[];
}

export interface ArAgingRow {
  invoice_id: string;
  invoice_number: string;
  client_id: string;
  client_name: string;
  amount: number;
  due_date: string;
  days_overdue: number;
  status: string;
  bucket: 'current' | 'overdue_15_30' | 'overdue_30_plus' | 'pending_signature';
  notes: string | null;
}

const Q2_START = '2026-04-01';
const Q2_END   = '2026-06-30';
const Q2_TARGET = 228_000;

function toCents(n: number | null | undefined): number {
  if (typeof n !== 'number' || isNaN(n)) return 0;
  return Math.round(n * 100) / 100;
}

export async function computeRevenueMetrics(
  supabase: SupabaseClient,
): Promise<RevenueMetrics> {
  const today = new Date();
  const todayISO = today.toISOString().split('T')[0];
  const yearStart = `${today.getUTCFullYear()}-01-01`;
  const monthStart = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`;

  // Pull all clients with their billing config
  const { data: clients } = await supabase
    .from('clients')
    .select(
      'id, name, ' +
      'billing_model, subscription_monthly_amount, subscription_included_entities, subscription_overage_rate'
    ) as { data: any[] | null };

  // Optional columns — only fetched if the migration ran. billing_notes /
  // pending_signature marker / billing_effective_from land here.
  const { data: clientsOptional } = await supabase
    .from('clients' as any)
    .select('id, billing_notes, billing_effective_from' as any) as { data: any[] | null };
  const optionalById = new Map<string, any>(
    (clientsOptional || []).map((c: any) => [c.id, c]),
  );

  // Pull all invoices with client join (mercury-reconcile keeps these authoritative)
  const { data: invoices } = await supabase
    .from('invoices')
    .select('id, invoice_number, client_id, total_amount, status, due_date, sent_at, paid_at, billing_period_start, notes')
    .order('billing_period_start', { ascending: false }) as { data: any[] | null };

  // Pull this month's completed entities per client (for MTD usage tracking)
  const { data: mtdCompletions } = await supabase
    .from('request_entities')
    .select('id, completed_at, requests!inner(client_id)')
    .eq('status', 'completed')
    .gte('completed_at', monthStart) as { data: any[] | null };

  const mtdByClient = new Map<string, number>();
  for (const e of (mtdCompletions || [])) {
    const cid = e.requests?.client_id;
    if (!cid) continue;
    mtdByClient.set(cid, (mtdByClient.get(cid) || 0) + 1);
  }

  // Aggregate per client
  const byClient = new Map<string, ClientRevenueRow>();
  for (const c of (clients || [])) {
    const extra = optionalById.get(c.id) ?? {};
    const notes: string | null = extra.billing_notes ?? null;
    byClient.set(c.id, {
      client_id: c.id,
      client_name: c.name,
      billing_model: (c.billing_model === 'subscription' ? 'subscription' : 'per_tin'),
      paid_all_time: 0,
      paid_ytd: 0,
      paid_q2: 0,
      open_ar: 0,
      last_paid_at: null,
      last_paid_amount: null,
      billing_notes: notes,
      pending_signature: /pending.?sig|awaiting.?signature|unsigned|pre.?signature/i.test(notes || ''),
      entities_mtd: mtdByClient.get(c.id) || 0,
      subscription_included: c.subscription_included_entities ?? null,
      subscription_monthly_amount: c.subscription_monthly_amount ?? null,
    });
  }

  // Process invoices
  const arRows: ArAgingRow[] = [];
  const totals = { paid_all_time: 0, paid_ytd: 0, paid_q2: 0, open_ar_q2: 0 };

  for (const inv of (invoices || [])) {
    const row = byClient.get(inv.client_id);
    const amt = typeof inv.total_amount === 'number' ? inv.total_amount : parseFloat(inv.total_amount) || 0;
    const periodStart: string = inv.billing_period_start || '';
    const invoicePendingSignature = /pending.?sig|awaiting.?signature|pre.?signature/i.test(inv.notes || '');
    const rowPendingSignature = row?.pending_signature || false;
    const pendingSignature = invoicePendingSignature || rowPendingSignature;

    if (inv.status === 'paid') {
      totals.paid_all_time += amt;
      if (periodStart >= yearStart) totals.paid_ytd += amt;
      if (periodStart >= Q2_START && periodStart <= Q2_END) totals.paid_q2 += amt;
      if (row) {
        row.paid_all_time += amt;
        if (periodStart >= yearStart) row.paid_ytd += amt;
        if (periodStart >= Q2_START && periodStart <= Q2_END) row.paid_q2 += amt;
        if (inv.paid_at && (!row.last_paid_at || inv.paid_at > row.last_paid_at)) {
          row.last_paid_at = inv.paid_at;
          row.last_paid_amount = amt;
        }
      }
    } else if (inv.status === 'sent' || inv.status === 'draft' || inv.status === 'processing' || inv.status === 'overdue') {
      if (periodStart >= Q2_START && periodStart <= Q2_END) totals.open_ar_q2 += amt;
      if (row) row.open_ar += amt;

      // AR aging bucket
      const dueDate = inv.due_date ? new Date(inv.due_date) : null;
      const daysOverdue = dueDate ? Math.floor((today.getTime() - dueDate.getTime()) / (24 * 3600 * 1000)) : 0;
      const bucket: ArAgingRow['bucket'] = pendingSignature
        ? 'pending_signature'
        : daysOverdue <= 14
          ? 'current'
          : daysOverdue <= 30
            ? 'overdue_15_30'
            : 'overdue_30_plus';
      arRows.push({
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        client_id: inv.client_id,
        client_name: row?.client_name ?? 'Unknown',
        amount: amt,
        due_date: inv.due_date,
        days_overdue: daysOverdue,
        status: inv.status,
        bucket,
        notes: inv.notes,
      });
    }
  }

  // Round all totals
  for (const r of byClient.values()) {
    r.paid_all_time = toCents(r.paid_all_time);
    r.paid_ytd      = toCents(r.paid_ytd);
    r.paid_q2       = toCents(r.paid_q2);
    r.open_ar       = toCents(r.open_ar);
    r.last_paid_amount = toCents(r.last_paid_amount);
  }

  // Sort client rows: highest paid_all_time first, subscription clients surfaced when non-zero
  const client_rows = Array.from(byClient.values())
    .filter(r => r.paid_all_time > 0 || r.open_ar > 0 || r.entities_mtd > 0 || r.billing_model === 'subscription')
    .sort((a, b) => b.paid_all_time - a.paid_all_time);

  // Aging buckets
  const ar_aging: ArAgingBuckets = {
    current: { invoice_count: 0, amount: 0 },
    overdue_15_30: { invoice_count: 0, amount: 0 },
    overdue_30_plus: { invoice_count: 0, amount: 0 },
    pending_signature: { invoice_count: 0, amount: 0 },
    rows: arRows.sort((a, b) => b.amount - a.amount),
  };
  for (const row of arRows) {
    ar_aging[row.bucket].invoice_count += 1;
    ar_aging[row.bucket].amount += row.amount;
  }
  for (const key of ['current', 'overdue_15_30', 'overdue_30_plus', 'pending_signature'] as const) {
    ar_aging[key].amount = toCents(ar_aging[key].amount);
  }

  // Subscription Q2 projection: for each subscription client, fill the
  // remaining quarter months with their flat fee as a base projection.
  let subscriptionFill = 0;
  for (const r of client_rows) {
    if (r.billing_model !== 'subscription' || !r.subscription_monthly_amount) continue;
    // Months in Q2 not yet invoiced = months with no paid_q2 for this client
    // Naive fill: assume full Q2 of subscription × 3 months, minus what's paid.
    const fullQ2 = r.subscription_monthly_amount * 3;
    subscriptionFill += Math.max(0, fullQ2 - r.paid_q2);
  }

  const booked_q2   = toCents(totals.paid_q2 + totals.open_ar_q2);
  const projected_q2 = toCents(booked_q2 + subscriptionFill);

  return {
    today_iso: todayISO,
    quarter_label: 'Q2 2026',
    q2_target_dollars: Q2_TARGET,
    totals: {
      paid_all_time: toCents(totals.paid_all_time),
      paid_ytd: toCents(totals.paid_ytd),
      paid_q2: toCents(totals.paid_q2),
      open_ar_q2: toCents(totals.open_ar_q2),
      booked_q2,
      projected_q2,
    },
    client_rows,
    ar_aging,
  };
}

export function formatDollars(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
