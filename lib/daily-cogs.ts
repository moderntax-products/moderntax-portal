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
 *  7. Expert payouts (the big one) — expert_time_logs that started today,
 *      run PER EXPERT through the same margin-guard payout engine payroll
 *      uses (calculateExpertPayout): zero verified units ⇒ $0, and a slow
 *      expert is capped at the per-TIN piece rate. Raw hours × rate is NOT
 *      the cost — a forgotten clock-out with 0 completions costs $0, not
 *      6 hrs of payout (that phantom faked a −89% margin on 2026-07-09).
 *
 * Returns a DailyCogsBreakdown matching AdminDailySummaryStats.cogs.
 * If a particular category is unconfigured or fails to compute, it's
 * recorded as 0 with a note in the warnings list — the email still
 * renders with whatever we can compute.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { calculateExpertPayout, PAYROLL_DEFAULTS } from './expert-payroll';

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
  dropbox_sign_plan: 75,   // Mid-tier API plan; per-signature on top
  quickbooks: 70,          // Online Essentials
  domain: 2,               // moderntax.io annual ÷ 12
  // Note: SendGrid base plan ($15-90) is folded into the per-email cost below
  //  since their pricing is usage-tiered. Net daily fixed = ~$196 ÷ 30 = ~$6.53/day.
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
      FIXED_MONTHLY.dropbox_sign_plan +
      FIXED_MONTHLY.quickbooks +
      FIXED_MONTHLY.domain) / 30;
  items.push({
    category: 'infrastructure',
    label: 'Infrastructure (fixed amortized)',
    amount: round2(dailyFixed),
    detail: 'Vercel Pro + Supabase Pro + GitHub + Dropbox Sign base + QuickBooks + domain, monthly ÷ 30',
  });

  // ─── 2. Email (SendGrid usage) ───────────────────────────────────────────
  // Until SendGrid event webhook is plumbed, we approximate by counting
  // every email-sending audit log event today. If none, estimate from
  // completions × ~2 emails (admin + customer per completion).
  try {
    const { count: emailCount } = await supabase
      .from('sendgrid_events')
      .select('*', { count: 'exact', head: true })
      .eq('event', 'processed')
      .gte('created_at', dayStartUtc)
      .lt('created_at', dayEndUtc);
    const emails = emailCount || 0;
    const emailCost = emails * UNIT_RATES.sendgrid_per_email;
    items.push({
      category: 'email',
      label: 'SendGrid (transactional emails)',
      amount: round2(emailCost),
      detail: emails > 0
        ? `${emails} emails × $${UNIT_RATES.sendgrid_per_email.toFixed(3)}/email`
        : 'No event webhook telemetry yet — estimate $0',
    });
    if (emails === 0) warnings.push('SendGrid event webhook not wired — email cost shown as $0');
  } catch (err) {
    items.push({ category: 'email', label: 'SendGrid', amount: 0, detail: '(query failed)' });
    warnings.push(`Email cost: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // ─── 3. E-sign (Dropbox Sign per-signature) ──────────────────────────────
  // Counts request_entities where signature_id was first populated today.
  try {
    const { data: signedToday } = await supabase
      .from('request_entities')
      .select('id, signature_created_at')
      .gte('signature_created_at', dayStartUtc)
      .lt('signature_created_at', dayEndUtc)
      .not('signature_id', 'is', null);
    const signs = signedToday?.length || 0;
    items.push({
      category: 'esign',
      label: 'Dropbox Sign (per-signature)',
      amount: round2(signs * UNIT_RATES.dropbox_sign_per_signature),
      detail: `${signs} 8821 e-signatures × $${UNIT_RATES.dropbox_sign_per_signature.toFixed(2)}/sig (on top of monthly plan)`,
    });
  } catch (err) {
    items.push({ category: 'esign', label: 'Dropbox Sign', amount: 0, detail: '(query failed)' });
    warnings.push(`E-sign cost: ${err instanceof Error ? err.message : 'unknown'}`);
  }

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

  // ─── 5. AI extraction (Anthropic — Convert-8821 + processor-AI) ──────────
  // No per-call audit logging yet; approximate from new requests today (each
  // potentially triggers ≤1 conversion + processor questions).
  // Conservative placeholder: zero unless ANTHROPIC_API_KEY is configured.
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { count: newReqs } = await supabase
        .from('requests')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', dayStartUtc)
        .lt('created_at', dayEndUtc);
      const estimated = (newReqs || 0) * UNIT_RATES.anthropic_per_extraction;
      items.push({
        category: 'ai_extraction',
        label: 'Anthropic (vision + processor-AI)',
        amount: round2(estimated),
        detail: `~${newReqs || 0} potential extractions × $${UNIT_RATES.anthropic_per_extraction.toFixed(2)} (estimate — no per-call telemetry yet)`,
      });
    } catch {
      items.push({ category: 'ai_extraction', label: 'Anthropic', amount: 0, detail: '(estimate unavailable)' });
    }
  } else {
    items.push({
      category: 'ai_extraction',
      label: 'Anthropic (vision + processor-AI)',
      amount: 0,
      detail: 'API key not configured',
    });
  }

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
  // COGS is what we'd actually PAY, not raw clocked hours. Aggregate today's
  // logs per expert (hours + tins_completed), then run each expert through the
  // same margin-guard engine payroll uses: zero completions ⇒ $0 (blocked),
  // and a slow expert is capped at the per-TIN piece rate. This mirrors the
  // real payable and stops a forgotten clock-out (0 TINs) from faking a margin
  // crisis in the daily summary — the failure that showed up 2026-07-09.
  try {
    const { data: logsToday } = await supabase
      .from('expert_time_logs')
      .select('expert_id, hours_worked, tins_completed')
      .gte('start_at', dayStartUtc)
      .lt('start_at', dayEndUtc);
    const expertIds = Array.from(new Set((logsToday || []).map((l: any) => l.expert_id).filter(Boolean)));
    const rates: Record<string, number> = {};
    if (expertIds.length > 0) {
      const { data: experts } = await supabase
        .from('profiles')
        .select('id, hourly_rate')
        .in('id', expertIds);
      for (const e of (experts || []) as any[]) rates[e.id] = Number(e.hourly_rate || PAYROLL_DEFAULTS.HOURLY_RATE);
    }
    // Aggregate hours + TINs per expert (the engine works on period totals).
    const perExpert: Record<string, { hours: number; tins: number }> = {};
    for (const l of (logsToday || []) as any[]) {
      const id = l.expert_id;
      if (!id) continue;
      const agg = perExpert[id] || (perExpert[id] = { hours: 0, tins: 0 });
      agg.hours += Number(l.hours_worked || 0);
      agg.tins += Number(l.tins_completed || 0);
    }
    let payouts = 0;
    let totalHours = 0;
    let totalTins = 0;
    let blockedHours = 0; // hours that produced $0 (zero-completion / phantom)
    let cappedCount = 0;
    for (const [id, agg] of Object.entries(perExpert)) {
      const rate = rates[id] ?? PAYROLL_DEFAULTS.HOURLY_RATE;
      const calc = calculateExpertPayout(agg.hours, agg.tins, rate);
      payouts += calc.payoutAmount;
      totalHours += agg.hours;
      totalTins += agg.tins;
      if (calc.status === 'BLOCKED_ZERO_PRODUCTION') blockedHours += agg.hours;
      if (calc.status === 'CAP_OVERRIDE_TRIGGERED') cappedCount += 1;
    }
    const flags: string[] = [];
    if (blockedHours > 0) flags.push(`${blockedHours.toFixed(2)}h unpaid (0 completions — not billable)`);
    if (cappedCount > 0) flags.push(`${cappedCount} capped to margin floor`);
    items.push({
      category: 'expert_payouts',
      label: 'Expert payouts',
      amount: round2(payouts),
      detail:
        `${totalHours.toFixed(2)}h / ${totalTins} TINs across ${expertIds.length} expert(s), ` +
        `run through the margin-guard engine` +
        (flags.length ? ` — ${flags.join('; ')}` : ''),
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
