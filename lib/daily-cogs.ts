/**
 * Compute daily cost-of-goods-sold (COGS) for the admin daily summary.
 *
 * Categories:
 *  1. Infrastructure (fixed monthly, amortized to per-day)
 *      Vercel Pro, Supabase Pro, GitHub, domain
 *  2. Email (SendGrid) — usage-based, scaled by template volume
 *  3. E-sign (Dropbox Sign) — per signature fired today
 *  4. Voice AI (Bland + Retell) — sum of estimated_cost on today's
 *      irs_call_sessions
 *  5. AI extraction (Anthropic) — vision + text on convert-8821 + processor-AI
 *      (negligible today; ~$0.01-0.03 per call). Falls back to 0 if untracked.
 *  6. Payment rails (Stripe + Mercury) — % of revenue collected today
 *  7. Expert payouts (the big one) — hours_worked × profiles.hourly_rate
 *      from expert_time_logs that started today
 *
 * Returns a DailyCogsBreakdown matching AdminDailySummaryStats.cogs.
 * If a particular category is unconfigured or fails to compute, it's
 * recorded as 0 with a note in the warnings list — the email still
 * renders with whatever we can compute.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface CogsLineItem {
  category:
    | 'infrastructure'
    | 'email'
    | 'esign'
    | 'voice_ai'
    | 'ai_extraction'
    | 'payment_rails'
    | 'expert_payouts';
  label: string;
  amount: number; // dollars, rounded to cents
  detail: string; // human-readable explanation (shown in the email)
}

export interface DailyCogsBreakdown {
  total: number;
  line_items: CogsLineItem[];
  warnings: string[];
  // Convenience for the email: revenue_today minus COGS, and the margin %
  // (the cron handler will supply revenue_today when calling computeDailyCogs)
}

/**
 * Fixed-cost amortization. Update these monthly when invoices change.
 * Source of truth: docs/cogs-monthly-fixed.md (TODO: create) — until then,
 * the literals here are the agreed-upon current numbers (best estimates from
 * the 2026-05-20 cost-analysis audit).
 */
const FIXED_MONTHLY = {
  vercel_pro: 20,          // 1 seat
  supabase_pro: 25,        // Pro tier
  github_org: 4,           // Free org + a Pro seat amortized
  dropbox_sign_plan: 60,   // Flat $60/mo plan (signatures included) — own line
  quickbooks: 70,          // Online Essentials
  domain: 2,               // moderntax.io annual ÷ 12
  sendgrid_plan: 34.95,    // SendGrid flat monthly plan (amortized on its own line)
  claude_max_plus: 200,    // Claude Max Plus base — usage top-ups billed on top
  faxplus_plan: 34.99,     // Fax.plus flat monthly plan (IRS 8821 fax delivery)
} as const;

/** Per-unit usage rates (update when vendor pricing changes). */
const UNIT_RATES = {
  sendgrid_per_email: 0.001,        // ~$1/k emails on Essentials, conservative
  dropbox_sign_per_signature: 3,    // ~$3 per signature on usage plans
  stripe_pct: 0.029,                // 2.9% of card revenue
  stripe_per_txn: 0.30,             // + $0.30 per Stripe transaction
  mercury_ach_pct: 0.005,           // 0.5% of inbound ACH (Mercury IO Business)
  anthropic_per_extraction: 0.02,   // sonnet-4-5 vision on a 1-2 page PDF
} as const;

export async function computeDailyCogs(
  supabase: SupabaseClient,
  dayStartUtc: string,
  dayEndUtc: string,
  // _revenueToday is currently unused inside this function (margin is
  // computed by grossMargin() in the caller) but kept on the signature so
  // callers can pass it without re-fetching, and so a future cost line
  // (e.g. floating-rate contingency payouts as % of revenue) can hook in
  // without a signature change. Underscore prefix tells both TS and ESLint
  // to skip the unused-var warning.
  _revenueToday: number,
): Promise<DailyCogsBreakdown> {
  const items: CogsLineItem[] = [];
  const warnings: string[] = [];

  // ─── 1. Infrastructure (fixed amortized) ─────────────────────────────────
  const dailyFixed =
    (FIXED_MONTHLY.vercel_pro +
      FIXED_MONTHLY.supabase_pro +
      FIXED_MONTHLY.github_org +
      FIXED_MONTHLY.quickbooks +
      FIXED_MONTHLY.domain) / 30;
  items.push({
    category: 'infrastructure',
    label: 'Infrastructure (fixed amortized)',
    amount: round2(dailyFixed),
    detail: 'Vercel Pro + Supabase Pro + GitHub + QuickBooks + domain, monthly ÷ 30',
  });

  // ─── 2. Email (SendGrid) ─────────────────────────────────────────────────
  // SendGrid is a flat $34.95/month plan (transactional volume is within it),
  // so book it as real amortized cost — not a usage estimate that read $0
  // without the (unwired) event webhook.
  items.push({
    category: 'email',
    label: 'SendGrid (transactional emails)',
    amount: round2(FIXED_MONTHLY.sendgrid_plan / 30),
    detail: `SendGrid plan $${FIXED_MONTHLY.sendgrid_plan.toFixed(2)}/mo ÷ 30 (flat; volume included)`,
  });

  // ─── 3. E-sign (Dropbox Sign) ────────────────────────────────────────────
  // Flat $60/month plan (signatures included), so book it amortized — not a
  // per-signature charge on top.
  items.push({
    category: 'esign',
    label: 'Dropbox Sign (e-signatures)',
    amount: round2(FIXED_MONTHLY.dropbox_sign_plan / 30),
    detail: `Dropbox Sign plan $${FIXED_MONTHLY.dropbox_sign_plan.toFixed(2)}/mo ÷ 30 (flat; signatures included)`,
  });

  // ─── 3b. Fax (Fax.plus — IRS 8821 fax delivery) ──────────────────────────
  items.push({
    category: 'esign',
    label: 'Fax.plus (IRS fax delivery)',
    amount: round2(FIXED_MONTHLY.faxplus_plan / 30),
    detail: `Fax.plus plan $${FIXED_MONTHLY.faxplus_plan.toFixed(2)}/mo ÷ 30 (flat; faxes included)`,
  });

  // ─── 4. Voice AI (Bland + Retell IRS calls) ──────────────────────────────
  try {
    const { data: calls } = await supabase
      .from('irs_call_sessions')
      .select('estimated_cost, bland_call_id, duration_seconds')
      .gte('created_at', dayStartUtc)
      .lt('created_at', dayEndUtc);
    let voiceCost = 0;
    let callCount = 0;
    let totalSeconds = 0;
    for (const c of (calls || []) as any[]) {
      callCount++;
      totalSeconds += Number(c.duration_seconds || 0);
      voiceCost += Number(c.estimated_cost || 0);
    }
    items.push({
      category: 'voice_ai',
      label: 'Voice AI (PPS calls)',
      amount: round2(voiceCost),
      detail: `${callCount} IRS calls, ${Math.round(totalSeconds / 60)} call-min total (Bland @ $0.09/min, Retell @ ~$0.07/min)`,
    });
  } catch (err) {
    items.push({ category: 'voice_ai', label: 'Voice AI', amount: 0, detail: '(query failed)' });
    warnings.push(`Voice cost: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // ─── 5. AI (Claude — vision on convert-8821 + processor-AI) ──────────────
  // Claude Max Plus base plan ($200/mo) booked amortized. Usage top-ups are
  // billed on top but aren't metered here yet — flagged as the one telemetry gap.
  items.push({
    category: 'ai_extraction',
    label: 'Claude (vision + processor-AI)',
    amount: round2(FIXED_MONTHLY.claude_max_plus / 30),
    detail: `Claude Max Plus $${FIXED_MONTHLY.claude_max_plus.toFixed(2)}/mo ÷ 30 (base; usage top-ups billed on top, not yet metered)`,
  });
  warnings.push('Claude usage top-ups (beyond the $200/mo base) are not metered — AI line is base-only');

  // ─── 6. Payment rails (Stripe + Mercury, % of revenue) ───────────────────
  // We don't yet split by payment method per invoice; approximate as a
  // weighted blend (assume 80% ACH via Mercury, 20% card via Stripe) until
  // we can split properly from invoices.payment_method.
  try {
    const { data: paidToday } = await supabase
      .from('invoices')
      .select('total_amount, payment_method')
      .gte('paid_at', dayStartUtc)
      .lt('paid_at', dayEndUtc);
    let mercuryFees = 0;
    let stripeFees = 0;
    for (const inv of (paidToday || []) as any[]) {
      const amt = Number(inv.total_amount || 0);
      const method = (inv.payment_method || '').toLowerCase();
      if (method === 'ach' || method === 'wire') {
        mercuryFees += amt * UNIT_RATES.mercury_ach_pct;
      } else if (method === 'card' || method === 'stripe') {
        stripeFees += amt * UNIT_RATES.stripe_pct + UNIT_RATES.stripe_per_txn;
      } else {
        // Unknown — assume ACH (default)
        mercuryFees += amt * UNIT_RATES.mercury_ach_pct;
      }
    }
    items.push({
      category: 'payment_rails',
      label: 'Payment processing (Stripe + Mercury)',
      amount: round2(mercuryFees + stripeFees),
      detail: `Mercury ACH ${UNIT_RATES.mercury_ach_pct * 100}% + Stripe 2.9%+$0.30 (${paidToday?.length || 0} invoices paid today)`,
    });
  } catch (err) {
    items.push({ category: 'payment_rails', label: 'Payment rails', amount: 0, detail: '(query failed)' });
    warnings.push(`Payment cost: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // ─── 7. Expert payouts (the big one) ─────────────────────────────────────
  // Sum hours_worked from expert_time_logs that STARTED today (UTC), times
  // each expert's profiles.hourly_rate. Falls back to a $40/hr default if
  // the expert hasn't been rate-configured.
  try {
    const { data: logsToday } = await supabase
      .from('expert_time_logs')
      .select('expert_id, hours_worked')
      .gte('start_at', dayStartUtc)
      .lt('start_at', dayEndUtc);
    const expertIds = Array.from(new Set((logsToday || []).map((l: any) => l.expert_id).filter(Boolean)));
    const rates: Record<string, number> = {};
    if (expertIds.length > 0) {
      const { data: experts } = await supabase
        .from('profiles')
        .select('id, hourly_rate')
        .in('id', expertIds);
      for (const e of (experts || []) as any[]) rates[e.id] = Number(e.hourly_rate || 40);
    }
    let payouts = 0;
    let totalHours = 0;
    for (const l of (logsToday || []) as any[]) {
      const rate = rates[l.expert_id] ?? 40;
      const hrs = Number(l.hours_worked || 0);
      payouts += hrs * rate;
      totalHours += hrs;
    }
    items.push({
      category: 'expert_payouts',
      label: 'Expert payouts',
      amount: round2(payouts),
      detail: `${totalHours.toFixed(2)} hours logged across ${expertIds.length} expert(s) (per-expert hourly rates from profile)`,
    });
  } catch (err) {
    items.push({ category: 'expert_payouts', label: 'Expert payouts', amount: 0, detail: '(query failed)' });
    warnings.push(`Expert payouts: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  const total = round2(items.reduce((s, it) => s + it.amount, 0));
  // Cap warnings at 5 to keep the email compact
  return { total, line_items: items, warnings: warnings.slice(0, 5) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Helper for the email template: gross margin in $ + percent.
 */
export function grossMargin(revenue: number, cogs: number): { dollars: number; pct: number } {
  const dollars = round2(revenue - cogs);
  const pct = revenue > 0 ? Math.round((dollars / revenue) * 1000) / 10 : 0;
  return { dollars, pct };
}
