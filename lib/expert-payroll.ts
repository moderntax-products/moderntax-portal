/**
 * Expert payroll math — single source of truth for efficiency,
 * SLA-met %, gross-pay, and pay-period date computation.
 *
 * Originally modelled on the early-stage expert timesheet data at
 * 5 TINs / 1.5 hr ≈ 3.33 TINs/hr. Target was bumped to 5 TINs/hr
 * once the IRS Direct Sync script removed the per-transcript manual
 * upload step — experts no longer have to download and re-upload
 * PDFs, so per-hour throughput is expected to land in the 4–5 unique
 * entities range.
 *
 *   - Hourly pay (default $45.00, configurable per expert).
 *   - Target throughput = 5 TINs/hr (configurable per expert).
 *   - Expected TINs for a session/period = hours × target_tins_per_hour.
 *   - Efficiency % = clamp(0..1+, total_tins / expected_tins).
 *   - Gross pay = total_hours × hourly_rate. Efficiency does not (yet)
 *     gate pay; it's surfaced for performance review.
 *   - SLA-met % = subset of TINs whose business-hours elapsed at
 *     completion ≤ sla_business_hours (computed via lib/expert-sla).
 *
 * Pay periods: bi-weekly. Default schedule = Mon-Fri × 2 weeks, with
 * pay_date = period_end + 14 days (matches Tonya's CSV cadence: Nov
 * 17–21 → paid Dec 6, ~2-week lag).
 */

import { businessHoursElapsed, SLA_DEFAULTS } from './expert-sla';

export const PAYROLL_DEFAULTS = {
  HOURLY_RATE: 45.0,
  TARGET_TINS_PER_HOUR: 5.0, // bumped from 3.333 (5/1.5hr) once SOR sync removed manual uploads
  PAY_PERIOD_DAYS: 14, // bi-weekly
  PAY_DATE_LAG_DAYS: 14, // period_end → pay_date
};

export interface SessionTotals {
  hours: number;
  tinsCompleted: number;
  expectedTins: number;
  efficiencyPct: number; // 0..100+ (allowed to exceed 100 — overachievers)
  grossPay: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Margin-guard payout engine (Matt 2026-06-26 PRD).
//
// Protects platform gross margin: pay the hourly baseline UNLESS the expert was
// too slow, in which case a per-TIN piece-rate cap kicks in. Zero verified units
// in a period blocks the payout entirely. Efficiency (TINs/hr) is recorded for
// work-routing tiers. The hourly side honors each expert's configured rate; the
// cap is a fixed margin floor.
//   MAX_COST_PER_TIN = $32.99  ($59.98 min client bill − 45% target margin)
// ───────────────────────────────────────────────────────────────────────────
export const MARGIN_GUARD = {
  MAX_COST_PER_TIN: 32.99,
  MIN_EFFICIENCY_TARGET: 5.0, // TINs/hr — routing-tier target, NOT a pay gate
};

export type PayoutStatus =
  | 'APPROVED_FOR_PAYMENT'
  | 'BLOCKED_ZERO_PRODUCTION'
  | 'CAP_OVERRIDE_TRIGGERED';

export interface PayoutCalc {
  hours: number;
  tinsCompleted: number;
  efficiencyRate: number; // TINs/hr
  hourlyGross: number;    // hours × hourly rate (uncapped)
  pieceRateCap: number;   // tins × MAX_COST_PER_TIN
  payoutAmount: number;   // final, cap-protected & zero-blocked
  status: PayoutStatus;
  notes: string;
}

/**
 * Cap-protected, zero-blocked payout for a pay period. Single source of truth —
 * used by the live payroll view, the close-period (approval) step, and any
 * downstream Mercury draft. Mirrors the PRD pseudocode exactly.
 */
export function calculateExpertPayout(
  hours: number,
  tinsCompleted: number,
  hourlyRate: number = PAYROLL_DEFAULTS.HOURLY_RATE,
  maxCostPerTin: number = MARGIN_GUARD.MAX_COST_PER_TIN,
): PayoutCalc {
  const h = Math.max(0, Number(hours) || 0);
  const tins = Math.max(0, Math.trunc(Number(tinsCompleted) || 0));
  const efficiencyRate = h > 0 ? round2(tins / h) : 0;
  const hourlyGross = round2(h * hourlyRate);
  const pieceRateCap = round2(tins * maxCostPerTin);
  const base = { hours: round2(h), tinsCompleted: tins, efficiencyRate, hourlyGross, pieceRateCap };

  // Rule 1 — zero-production block (no verified units ⇒ no payout).
  if (tins === 0) {
    return { ...base, payoutAmount: 0, status: 'BLOCKED_ZERO_PRODUCTION',
      notes: 'No payout authorized. Zero units completed.' };
  }
  // Rule 2 — cap-protected hourly engine.
  if (hourlyGross <= pieceRateCap) {
    return { ...base, payoutAmount: hourlyGross, status: 'APPROVED_FOR_PAYMENT',
      notes: `Completed ${tins} TINs in ${round2(h)} hrs (${efficiencyRate} TINs/hr).` };
  }
  return { ...base, payoutAmount: pieceRateCap, status: 'CAP_OVERRIDE_TRIGGERED',
    notes: `Capped to protect margin — ${tins} TINs in ${round2(h)} hrs (${efficiencyRate} TINs/hr): `
      + `$${hourlyGross.toFixed(2)} hourly exceeds the $${pieceRateCap.toFixed(2)} per-TIN cap.` };
}

/**
 * Work-routing tier from rolling efficiency (PRD §5B). Frequent cap-overrides
 * demote to Tier 3 regardless of the headline rate.
 */
export function efficiencyTier(
  efficiencyRate: number,
  frequentlyCapped = false,
): { tier: 1 | 2 | 3; label: string } {
  if (frequentlyCapped || efficiencyRate < 2.0) return { tier: 3, label: 'Restricted' };
  if (efficiencyRate < 4.0) return { tier: 2, label: 'Standard' };
  return { tier: 1, label: 'High priority' };
}

/**
 * Roll up totals for a window. Pure math — caller passes the raw inputs.
 */
export function computeSessionTotals(
  hours: number,
  tinsCompleted: number,
  hourlyRate: number = PAYROLL_DEFAULTS.HOURLY_RATE,
  targetTinsPerHour: number = PAYROLL_DEFAULTS.TARGET_TINS_PER_HOUR,
): SessionTotals {
  const expectedTins = round2(hours * targetTinsPerHour);
  const efficiencyPct = expectedTins > 0
    ? round2((tinsCompleted / expectedTins) * 100)
    : 0;
  const grossPay = round2(hours * hourlyRate);
  return {
    hours: round2(hours),
    tinsCompleted,
    expectedTins,
    efficiencyPct,
    grossPay,
  };
}

/**
 * Compute the pay-period bucket containing a given date. Bi-weekly buckets
 * are anchored to a fixed reference date so they're stable across runs.
 *
 * Reference: 2025-11-10 (Tonya's PP0 start = Nov 10–14, but treated as
 * the 2-week window Mon Nov 10 → Sun Nov 23 since we count weekdays).
 *
 * For simplicity we use full 14-day calendar windows starting on Mondays.
 */
export function payPeriodFor(date: Date): { periodStart: Date; periodEnd: Date; payDate: Date } {
  // Anchor: Monday 2025-11-10 (the start of Tonya's PP0).
  const anchor = new Date(Date.UTC(2025, 10, 10)); // months are 0-indexed
  const msPerDay = 24 * 3600 * 1000;
  const daysSinceAnchor = Math.floor((date.getTime() - anchor.getTime()) / msPerDay);
  const periodIndex = Math.floor(daysSinceAnchor / PAYROLL_DEFAULTS.PAY_PERIOD_DAYS);
  const periodStart = new Date(anchor.getTime() + periodIndex * PAYROLL_DEFAULTS.PAY_PERIOD_DAYS * msPerDay);
  const periodEnd = new Date(periodStart.getTime() + (PAYROLL_DEFAULTS.PAY_PERIOD_DAYS - 1) * msPerDay);
  const payDate = new Date(periodEnd.getTime() + PAYROLL_DEFAULTS.PAY_DATE_LAG_DAYS * msPerDay);
  return { periodStart, periodEnd, payDate };
}

/**
 * Compute SLA-met % for a set of completed assignments by re-deriving
 * each one's business-hours elapsed at completion vs its budget.
 *
 * Caller passes the raw assignment rows (must include
 * expert_clock_started_at + completed_at + sla_business_hours +
 * the expert's iana_timezone). Returns null if no completions in set.
 */
export function computeSlaMetPct(
  completedAssignments: Array<{
    expert_clock_started_at: string | null;
    completed_at: string | null;
    sla_business_hours: number | null;
  }>,
  expertTz: string = SLA_DEFAULTS.EXPERT_TZ,
): number | null {
  const valid = completedAssignments.filter(a => a.expert_clock_started_at && a.completed_at);
  if (valid.length === 0) return null;
  const met = valid.filter(a => {
    const startedMs = new Date(a.expert_clock_started_at!).getTime();
    const completedMs = new Date(a.completed_at!).getTime();
    const elapsed = businessHoursElapsed(startedMs, completedMs, expertTz);
    const budget = a.sla_business_hours ?? SLA_DEFAULTS.DEFAULT_SLA_BUSINESS_HOURS;
    return elapsed <= budget;
  });
  return round2((met.length / valid.length) * 100);
}

/**
 * For an open work session (clocked in, not yet clocked out), compute
 * the live elapsed hours so the dashboard can show a running counter.
 */
export function liveSessionHours(startAtIso: string, breakMinutes = 0, nowMs = Date.now()): number {
  const start = new Date(startAtIso).getTime();
  const elapsedMs = Math.max(0, nowMs - start) - breakMinutes * 60_000;
  return round2(Math.max(0, elapsedMs / 3_600_000));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const formatCurrency = (n: number): string =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
