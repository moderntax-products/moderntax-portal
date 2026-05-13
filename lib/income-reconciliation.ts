/**
 * Income Reconciliation — post-funding monitoring of new tax-return filings
 * vs. the income figures used at loan approval.
 *
 * Driver: Enterprise Bank (Derek Le, 2026-05-11) asked for income
 * monitoring "for when the bank follow-ups on the filing of business /
 * personal tax return post loan funding to reconcile to the information
 * provided for loan approval." Tax Guard offers this; we now do too.
 *
 * Flow:
 *   1. Loan funding event captures baseline income figures from the
 *      original transcript pull → income_baseline JSONB on the entity
 *      (gross_receipts, total_income, total_tax, agi for individuals).
 *   2. Each subsequent monitoring re-pull extracts the same fields from
 *      the new transcript.
 *   3. compareIncomeSnapshots() returns a Variance — absolute dollar
 *      delta + percentage delta per field — and classifies severity:
 *        - INFO     ≤ 5%       no alert
 *        - WARNING  5% – 15%   informational note in dashboard
 *        - MATERIAL > 15%      email alert to the lender (loan officer)
 *   4. UI surfaces the variance on /admin/compliance-status/[id] as a
 *      new "Income Reconciliation" section when a baseline exists.
 *
 * This file is the pure-function core. Wiring into the monitoring-repull
 * cron + the alert email is the next-iteration TODO.
 */

import { screenTranscriptHtml } from './compliance-screening';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IncomeSnapshot {
  /** Captured from a transcript pull. Null = field not in this transcript. */
  grossReceipts: number | null;
  totalIncome: number | null;
  totalTax: number | null;
  /** Adjusted Gross Income — meaningful for 1040 individuals only. */
  agi: number | null;
  /** ISO date of the transcript this snapshot came from. */
  capturedAt: string;
  /** Tax year this snapshot represents. */
  taxYear: string;
  /** Source transcript filename for the audit trail. */
  source: string;
}

export interface FieldVariance {
  field: 'grossReceipts' | 'totalIncome' | 'totalTax' | 'agi';
  baseline: number | null;
  current: number | null;
  /** current - baseline (positive = grew, negative = shrank). */
  deltaAbsolute: number | null;
  /** delta / baseline as fraction. null if baseline is 0 or absent. */
  deltaPct: number | null;
  severity: 'INFO' | 'WARNING' | 'MATERIAL';
}

export interface ReconciliationResult {
  baseline: IncomeSnapshot;
  current: IncomeSnapshot;
  fields: FieldVariance[];
  /** Worst severity across all fields. */
  overallSeverity: 'INFO' | 'WARNING' | 'MATERIAL';
  /** Pre-baked headline for emails + dashboards. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Snapshot extraction
// ---------------------------------------------------------------------------

/**
 * Extract income figures from a single transcript. Returns null if the
 * transcript is blank/unfiled (no signal to baseline against).
 */
export function extractIncomeSnapshot(
  html: string,
  taxYear: string,
  source: string,
): IncomeSnapshot | null {
  const result = screenTranscriptHtml(html);
  if (result.isBlank) return null;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

  // AGI is a 1040-specific field — pull from "ADJUSTED GROSS INCOME"
  const agiMatch = text.match(/ADJUSTED GROSS INCOME[^:]*:\s*\$([\d,.-]+)/i);
  const agi = agiMatch ? parseFloat(agiMatch[1].replace(/,/g, '')) : null;

  return {
    grossReceipts: result.financials.grossReceipts,
    totalIncome: result.financials.totalIncome,
    totalTax: result.financials.totalTax,
    agi: agi,
    capturedAt: new Date().toISOString(),
    taxYear,
    source,
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Compare a baseline snapshot (captured at loan-funding time) against a
 * current snapshot (latest monitoring pull). Returns per-field variance
 * with severity classification.
 */
export function compareIncomeSnapshots(
  baseline: IncomeSnapshot,
  current: IncomeSnapshot,
): ReconciliationResult {
  const fields: FieldVariance[] = [];
  for (const field of ['grossReceipts', 'totalIncome', 'totalTax', 'agi'] as const) {
    const b = baseline[field];
    const c = current[field];
    if (b === null || c === null) {
      fields.push({ field, baseline: b, current: c, deltaAbsolute: null, deltaPct: null, severity: 'INFO' });
      continue;
    }
    const deltaAbsolute = c - b;
    const deltaPct = b !== 0 ? deltaAbsolute / b : null;
    let severity: 'INFO' | 'WARNING' | 'MATERIAL' = 'INFO';
    if (deltaPct !== null) {
      const absPct = Math.abs(deltaPct);
      if (absPct > 0.15) severity = 'MATERIAL';
      else if (absPct > 0.05) severity = 'WARNING';
    }
    fields.push({ field, baseline: b, current: c, deltaAbsolute, deltaPct, severity });
  }

  const overallSeverity: 'INFO' | 'WARNING' | 'MATERIAL' =
    fields.some(f => f.severity === 'MATERIAL') ? 'MATERIAL' :
    fields.some(f => f.severity === 'WARNING') ? 'WARNING' : 'INFO';

  const fmtPct = (p: number) => `${(p * 100).toFixed(1)}%`;
  const materialChanges = fields.filter(f => f.severity === 'MATERIAL' && f.deltaPct !== null);
  let summary: string;
  if (materialChanges.length === 0) {
    summary = `Income figures for ${baseline.taxYear} → ${current.taxYear} are consistent with loan-approval baseline (no material variance).`;
  } else {
    const parts = materialChanges.map(f =>
      `${humanField(f.field)} ${f.deltaPct! > 0 ? 'up' : 'down'} ${fmtPct(Math.abs(f.deltaPct!))} (baseline $${(f.baseline || 0).toLocaleString('en-US')}, current $${(f.current || 0).toLocaleString('en-US')})`
    );
    summary = `Material variance detected: ${parts.join('; ')}. Recommend reviewing the new tax return against loan-approval income figures.`;
  }

  return { baseline, current, fields, overallSeverity, summary };
}

function humanField(f: FieldVariance['field']): string {
  switch (f) {
    case 'grossReceipts': return 'Gross receipts';
    case 'totalIncome':   return 'Total income';
    case 'totalTax':      return 'Total tax';
    case 'agi':           return 'AGI';
  }
}
