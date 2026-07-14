/**
 * Gross financial summary for an arbitrary period (day / week / month).
 *
 * Revenue = billable completions in [startUtc, endUtc) × each client's per-entity
 * rate (csv/pdf), excluding prepaid (credit_paid) and W&I (W2_INCOME) entities —
 * the same core rule the daily ops summary uses. COGS reuses computeDailyCogs
 * (period-aware: fixed monthly costs amortized ÷30 × days; voice + payouts summed
 * over the range). Powers the weekly + monthly gross reports.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { computeDailyCogs, grossMargin, type DailyCogsBreakdown } from './daily-cogs';

export interface PerClientRevenue {
  clientId: string;
  name: string;
  billable: number;
  revenue: number;
}

export interface GrossSummary {
  periodLabel: string;   // e.g. "Weekly" / "Monthly"
  periodStart: string;   // YYYY-MM-DD
  periodEnd: string;     // YYYY-MM-DD (inclusive last day)
  days: number;
  totalCompleted: number;
  revenue: number;
  perClient: PerClientRevenue[];
  cogs: DailyCogsBreakdown;
  grossMarginDollars: number;
  grossMarginPct: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function computeGrossSummary(
  supabase: SupabaseClient,
  startUtc: string,
  endUtc: string,
  periodLabel: string,
): Promise<GrossSummary> {
  // ── Revenue: billable completions × per-client rate ──────────────────────
  const { data: rows } = await supabase
    .from('request_entities')
    .select('id, form_type, credit_paid, requests!inner(intake_method, client_id, clients!inner(id, name, billing_rate_pdf, billing_rate_csv))')
    .eq('status', 'completed')
    .gte('completed_at', startUtc)
    .lt('completed_at', endUtc) as { data: any[] | null };

  const perClient = new Map<string, PerClientRevenue>();
  let revenue = 0;
  let totalCompleted = 0;

  for (const e of rows || []) {
    totalCompleted++;
    // Prepaid (drawn from a credit pool) + W&I entities are not billable revenue.
    if (e.credit_paid === true) continue;
    if (e.form_type === 'W2_INCOME') continue;

    const client = e.requests?.clients;
    if (!client?.id) continue;
    const intake = e.requests?.intake_method;
    const rate = intake === 'csv'
      ? Number(client.billing_rate_csv ?? client.billing_rate_pdf ?? 79.98)
      : Number(client.billing_rate_pdf ?? 79.98);

    revenue += rate;
    const bucket = perClient.get(client.id) || { clientId: client.id, name: client.name, billable: 0, revenue: 0 };
    bucket.billable += 1;
    bucket.revenue += rate;
    perClient.set(client.id, bucket);
  }

  revenue = round2(revenue);
  const perClientArr = [...perClient.values()]
    .map(c => ({ ...c, revenue: round2(c.revenue) }))
    .sort((a, b) => b.revenue - a.revenue);

  // ── COGS (period-aware) + margin ─────────────────────────────────────────
  const cogs = await computeDailyCogs(supabase, startUtc, endUtc, revenue);
  const margin = grossMargin(revenue, cogs.total);
  const days = Math.max(1, Math.round((Date.parse(endUtc) - Date.parse(startUtc)) / 86_400_000));

  return {
    periodLabel,
    periodStart: startUtc.slice(0, 10),
    periodEnd: new Date(Date.parse(endUtc) - 86_400_000).toISOString().slice(0, 10),
    days,
    totalCompleted,
    revenue,
    perClient: perClientArr,
    cogs,
    grossMarginDollars: margin.dollars,
    grossMarginPct: margin.pct,
  };
}

const fmtUsd = (n: number) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Render the gross summary as an email {subject, html}. */
export function renderGrossSummaryEmail(s: GrossSummary): { subject: string; html: string } {
  const clientRows = s.perClient.length
    ? s.perClient.map(c => `<tr><td style="padding:5px 12px;font-size:13px;">${c.name}</td><td style="padding:5px 12px;font-size:13px;text-align:right;">${c.billable}</td><td style="padding:5px 12px;font-size:13px;text-align:right;font-family:monospace;">${fmtUsd(c.revenue)}</td></tr>`).join('')
    : `<tr><td colspan="3" style="padding:8px 12px;font-size:13px;color:#6b7280;">No billable completions this period.</td></tr>`;

  const cogsRows = s.cogs.line_items.map(li =>
    `<tr><td style="padding:5px 12px;font-size:13px;">${li.label}</td><td style="padding:5px 12px;font-size:11px;color:#6b7280;">${li.detail}</td><td style="padding:5px 12px;font-size:13px;text-align:right;font-family:monospace;">${fmtUsd(li.amount)}</td></tr>`
  ).join('');

  const marginColor = s.grossMarginDollars >= 0 ? '#2f6e4f' : '#b91c1c';

  const html = `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:720px;margin:0 auto;color:#1a2845;">
<div style="background:#0a1929;padding:20px 28px;color:#fff;"><h2 style="margin:0;font-size:19px;">ModernTax — ${s.periodLabel} Gross Report</h2>
<p style="margin:4px 0 0;color:#94a3b8;font-size:13px;">${s.periodStart} → ${s.periodEnd} · ${s.days} day${s.days === 1 ? '' : 's'} · ${s.totalCompleted} completions</p></div>
<div style="padding:22px 28px;">
<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:20px;">
<div style="flex:1;min-width:150px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;"><div style="font-size:11px;color:#6b7280;text-transform:uppercase;">Revenue</div><div style="font-size:24px;font-weight:800;font-family:monospace;">${fmtUsd(s.revenue)}</div></div>
<div style="flex:1;min-width:150px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;"><div style="font-size:11px;color:#6b7280;text-transform:uppercase;">COGS</div><div style="font-size:24px;font-weight:800;font-family:monospace;">${fmtUsd(s.cogs.total)}</div></div>
<div style="flex:1;min-width:150px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:14px;"><div style="font-size:11px;color:#6b7280;text-transform:uppercase;">Gross Margin</div><div style="font-size:24px;font-weight:800;font-family:monospace;color:${marginColor};">${fmtUsd(s.grossMarginDollars)}</div><div style="font-size:12px;color:${marginColor};">${s.grossMarginPct.toFixed(1)}%</div></div>
</div>
<h3 style="font-size:14px;margin:16px 0 6px;">Revenue by client</h3>
<table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;"><thead><tr style="background:#f8fafc;"><th style="padding:6px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Client</th><th style="padding:6px 12px;text-align:right;font-size:10px;color:#6b7280;text-transform:uppercase;">Billable</th><th style="padding:6px 12px;text-align:right;font-size:10px;color:#6b7280;text-transform:uppercase;">Revenue</th></tr></thead><tbody>${clientRows}</tbody></table>
<h3 style="font-size:14px;margin:20px 0 6px;">Cost of Goods Sold</h3>
<table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;"><thead><tr style="background:#f8fafc;"><th style="padding:6px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Category</th><th style="padding:6px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;">Detail</th><th style="padding:6px 12px;text-align:right;font-size:10px;color:#6b7280;text-transform:uppercase;">Amount</th></tr></thead><tbody>${cogsRows}
<tr style="border-top:2px solid #1a2845;"><td style="padding:7px 12px;font-size:13px;font-weight:700;">Total COGS</td><td></td><td style="padding:7px 12px;font-size:13px;text-align:right;font-weight:700;font-family:monospace;">${fmtUsd(s.cogs.total)}</td></tr></tbody></table>
${s.cogs.warnings.length ? `<p style="font-size:11px;color:#9ca3af;margin-top:12px;">Telemetry: ${s.cogs.warnings.join(' · ')}</p>` : ''}
</div>
<div style="background:#f8fafc;padding:12px 28px;font-size:10px;color:#94a3b8;border-top:1px solid #e5e7eb;">ModernTax Inc. · ${s.periodLabel} gross financial summary · COGS = Infra + SendGrid + Fax.plus + Anthropic + Voice AI + Expert Payouts</div>
</div>`;

  return {
    subject: `ModernTax ${s.periodLabel} Gross — ${fmtUsd(s.revenue)} rev · ${fmtUsd(s.grossMarginDollars)} margin (${s.grossMarginPct.toFixed(0)}%) · ${s.periodStart}→${s.periodEnd}`,
    html,
  };
}
