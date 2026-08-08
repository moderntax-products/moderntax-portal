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
// Piece-rate payout engine (Matt 2026-08-07). Replaces the earlier
// min(hourly, $32.99/TIN cap) margin-guard with a straight per-TIN piece rate
// plus a platform take. Pay aligns to output, not clocked hours:
//   • PIECE_RATE_PER_TIN $28 — paid per completed TIN, but only for TINs earned
//     on the two productive channels: time on the phone with an IRS agent
//     ('manual' + 'irs_direct_dial') and running the SOR-inbox script
//     ('sor_upload'). Setup/idle sources (e.g. 'bookmarklet_session') don't pay.
//   • PLATFORM_TAKE_PCT 10% — retained by the platform from gross; expert nets 90%.
//   • Zero billable TINs ⇒ no payout.
// Hours are still recorded for the efficiency read-out, but no longer drive pay,
// so a slow or idle session can't cost more than the work it produced.
// ───────────────────────────────────────────────────────────────────────────
export const PIECE_RATE = {
  PER_TIN: 28.0,
  PLATFORM_TAKE_PCT: 0.10,
  MIN_EFFICIENCY_TARGET: 5.0, // TINs/hr — routing-tier target, NOT a pay gate
  /** Log sources that count toward pay: IRS-agent phone time + SOR-inbox script. */
  BILLABLE_SOURCES: ['manual', 'irs_direct_dial', 'sor_upload'] as const,
};

/** Is a time-log source a paying channel (IRS phone / SOR script)? */
export function isBillableSource(source: string | null | undefined): boolean {
  return !!source && (PIECE_RATE.BILLABLE_SOURCES as readonly string[]).includes(source);
}

export type PayoutStatus =
  | 'APPROVED_FOR_PAYMENT'
  | 'BLOCKED_ZERO_PRODUCTION'
  | 'PARTIALLY_PAID';

export interface PayoutCalc {
  hours: number;
  billableTins: number;   // TINs earned on paying channels only
  efficiencyRate: number; // TINs/hr (all hours, for display)
  grossPay: number;       // billableTins × PER_TIN
  platformTake: number;   // grossPay × PLATFORM_TAKE_PCT
  payoutAmount: number;   // net owed = grossPay − platformTake
  status: PayoutStatus;
  notes: string;
}

/**
 * Piece-rate payout for a pay period. Single source of truth — used by the live
 * payroll view, the close-period (approval) step, and any downstream Mercury
 * draft. `billableTins` must already be filtered to paying channels by the
 * caller (see isBillableSource); `hours` is display-only.
 */
export function calculateExpertPayout(
  hours: number,
  billableTins: number,
  _hourlyRate: number = PAYROLL_DEFAULTS.HOURLY_RATE, // kept for signature compat; unused
  perTin: number = PIECE_RATE.PER_TIN,
  takePct: number = PIECE_RATE.PLATFORM_TAKE_PCT,
): PayoutCalc {
  const h = Math.max(0, Number(hours) || 0);
  const tins = Math.max(0, Math.trunc(Number(billableTins) || 0));
  const efficiencyRate = h > 0 ? round2(tins / h) : 0;
  const grossPay = round2(tins * perTin);
  const platformTake = round2(grossPay * takePct);
  const payoutAmount = round2(grossPay - platformTake);
  const base = { hours: round2(h), billableTins: tins, efficiencyRate, grossPay, platformTake, payoutAmount };

  if (tins === 0) {
    return { ...base, grossPay: 0, platformTake: 0, payoutAmount: 0, status: 'BLOCKED_ZERO_PRODUCTION',
      notes: 'No payout authorized. Zero billable TINs (IRS-phone + SOR-script channels) in period.' };
  }
  return { ...base, status: 'APPROVED_FOR_PAYMENT',
    notes: `${tins} TINs × $${perTin.toFixed(2)} = $${grossPay.toFixed(2)} gross − ${Math.round(takePct * 100)}% take `
      + `($${platformTake.toFixed(2)}) = $${payoutAmount.toFixed(2)} net.` };
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
