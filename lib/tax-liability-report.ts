/**
 * Tax-Guard-parity Compliance Status Report aggregator.
 *
 * Takes all IRS transcripts on file for a single entity, runs each
 * through screenTranscriptHtml() (lib/compliance-screening.ts), and
 * folds them into three structured sections — the same shape Banc of
 * California (Erin Wilsey) flagged as the Tax Guard gap on 2026-05-12:
 *
 *   1. Filing Compliance      — required-vs-filed by form/period
 *   2. Tax Liabilities        — per-period balance breakdown w/ totals
 *   3. Repayment Plan Status  — IA / OIC / CNC presence + recommendation
 *
 * The public sample at /sample-transcripts/compliance-report already
 * renders this shape with hard-coded demo data; this module is what
 * powers the LIVE per-entity rendering at /admin/compliance-status/[id].
 *
 * Inputs come from request_entities + the transcript HTML files we
 * have in Supabase storage (bucket=uploads, path=transcripts/<entityId>/...).
 *
 * Pure function — no DB calls, no fetches. Caller assembles the
 * transcript HTMLs and passes them in. Easier to test, easier to
 * batch-process the historical backfill.
 */

import {
  screenTranscriptHtml,
  parseTranscriptMetadata,
  type ComplianceFlag,
  type TranscriptMetadata,
} from './compliance-screening';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FilingRow {
  /** "1120-S", "941", "940", "1099-MISC", etc. */
  form: string;
  /** "2023" for annual, "2021-Q3" for quarterly. */
  period: string;
  /** When the IRS recorded the return as filed (TC 150). May be null for unfiled. */
  filedOn: string | null;
  /** Free-form notes — e.g. "filed 14 days late". */
  notes: string[];
  /** What sourced this row — a transcript filename for filed rows, an entity-transcript filing-requirement note for unfiled rows. */
  source: string;
}

export interface LiabilityRow {
  form: string;
  period: string;
  /** Total assessed = total tax + late-filing + late-payment + interest if posted as separate TCs. */
  assessed: number;
  /** Total paid against assessment. */
  paid: number;
  /** Open balance owed to IRS. */
  balance: number;
  /** Accrued interest + penalty still climbing. */
  accrued: number;
  /** Human-readable status string. */
  statusLabel: string;
  /** Color category for UI: 'open' (red), 'partial' (amber), 'closed' (green). */
  statusKind: 'open' | 'partial' | 'closed';
  source: string;
}

export interface RepaymentPlanStatus {
  hasInstallmentAgreement: boolean;
  hasOfferInCompromise: boolean;
  hasCurrentlyNotCollectible: boolean;
  /** Detail strings — TC + date + amount for each plan event found. */
  details: string[];
  /** Recommended next step in plain English. */
  recommendation: string;
}

export interface EstimatedPaymentRow {
  /** Tax year the payment was credited to. */
  taxYear: string;
  /** Quarter — 1/2/3/4 for federal estimated tax. */
  quarter: 1 | 2 | 3 | 4 | null;
  /** Date the payment posted. */
  postedOn: string;
  /** Amount of the payment in dollars. */
  amount: number;
  /** Transaction code that recorded it (typically TC 670). */
  transactionCode: string;
  source: string;
}

export interface ExtensionAmendmentEvent {
  /** Kind of event: extension granted, amendment received, audit assessment, etc. */
  kind: 'extension_granted' | 'amendment_received' | 'amendment_processed' | 'audit_assessment' | 'audit_examination_started';
  /** Date the event posted. */
  date: string;
  /** Transaction code (TC 460, 977, 976, 290, 420, etc.). */
  transactionCode: string;
  /** Form + tax year context. */
  form: string;
  period: string;
  /** Dollar amount if applicable (e.g. audit assessment). */
  amount: number | null;
  source: string;
  /** Plain-English description for the UI. */
  description: string;
}

export interface TaxLiabilityReport {
  /** Entity context for the header / receipts. */
  entityName: string;
  tin: string;
  /** ISO timestamp of when the report was generated. */
  generatedAt: string;
  /** Count of transcript files actually consumed. */
  transcriptsParsed: number;
  /** Per-transcript source filenames (for the footer "Sources" citation). */
  sources: string[];

  // ── Section 1 ──
  filingCompliance: {
    filed: FilingRow[];
    unfiled: FilingRow[];
  };

  // ── Section 2 ──
  taxLiabilities: {
    rows: LiabilityRow[];
    totalAssessed: number;
    totalPaid: number;
    totalBalance: number;
    totalAccrued: number;
  };

  // ── Section 3 ──
  repaymentPlan: RepaymentPlanStatus;

  // ── Section 4 (NEW — Builds Collective ask) ──
  /** Federal estimated tax payments parsed from TC 670 entries. */
  estimatedPayments: EstimatedPaymentRow[];

  // ── Section 5 (NEW — Builds Collective ask) ──
  /** Extension grants (TC 460), amendments (TC 977/976), audit assessments (TC 290/420). */
  extensionsAndAmendments: ExtensionAmendmentEvent[];

  // ── Overall ──
  /** Worst severity across all flags found. */
  overallSeverity: 'CRITICAL' | 'WARNING' | 'CLEAN';
  /** Pre-baked banner text the UI can drop in. */
  headlineSummary: string;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface TranscriptInput {
  /** Filename / storage path — surfaces in the report's Sources list. */
  source: string;
  /** Raw HTML string of the transcript. */
  html: string;
}

/**
 * Aggregate a list of transcripts into a structured compliance report.
 *
 * Sequence:
 *   1. parseTranscriptMetadata + screenTranscriptHtml on each input
 *   2. Bucket by (form, period) — one filed row per (form, period) we saw a TC 150 on
 *   3. Cross-reference Entity Transcript filing requirements to fill the "unfiled" list
 *   4. Aggregate financial fields into the LiabilityRow list
 *   5. Scan flags for INSTALLMENT / OIC / COLLECTION → RepaymentPlanStatus
 *   6. Compose overall severity + headline
 */
export function buildTaxLiabilityReport(
  entityName: string,
  tin: string,
  transcripts: TranscriptInput[],
): TaxLiabilityReport {
  const parsed = transcripts.map(t => ({
    source: t.source,
    meta: parseTranscriptMetadata(t.html),
    screen: screenTranscriptHtml(t.html),
    /** Parsed tax-period-ending date from the modern IRS HTML (MM-DD-YYYY). */
    periodEnding: extractPeriodEnding(t.html),
  }));

  // ── Section 1: Filing Compliance ────────────────────────────────────────
  const filed: FilingRow[] = [];
  const unfiled: FilingRow[] = [];

  // 1a. Filed rows: any transcript that's not blank/unfiled gets a row.
  //     Period label uses YYYY for annual, YYYY-Qn for quarterly.
  for (const p of parsed) {
    if (p.screen.isBlank) {
      // Will be picked up by the "unfiled" pass below if filing was required.
      continue;
    }
    const periodLabel = formatPeriodLabel(p.periodEnding, p.meta);
    const formLabel = normalizeFormLabel(p.meta.formType, p.periodEnding);
    if (!formLabel) continue;

    const tc150 = p.screen.transactionCodes.find(tc => tc.code === '150');
    filed.push({
      form: formLabel,
      period: periodLabel,
      filedOn: tc150 ? normalizeDate(tc150.date) : null,
      notes: [],
      source: p.source,
    });
  }

  // 1b. Unfiled rows: every transcript that came back blank / no-record gets
  //     flagged as a required-but-unfiled period. Entity Transcripts (the
  //     IRS-side "what filings are required" report) widen the scope but
  //     even without one, an attempted pull that returned blank is
  //     itself the signal we're surfacing.
  for (const p of parsed) {
    if (!p.screen.isBlank) continue;
    const periodLabel = formatPeriodLabel(p.periodEnding, p.meta);
    const formLabel = normalizeFormLabel(p.meta.formType, p.periodEnding) || 'Unknown form';
    unfiled.push({
      form: formLabel,
      period: periodLabel,
      filedOn: null,
      notes: ['IRS returned "no record of return filed" for this tax period.'],
      source: p.source,
    });
  }

  // ── Section 2: Tax Liabilities by Period ────────────────────────────────
  const liabilityRows: LiabilityRow[] = [];
  let totalAssessed = 0, totalPaid = 0, totalBalance = 0, totalAccrued = 0;

  for (const p of parsed) {
    if (p.screen.isBlank) continue;
    const periodLabel = formatPeriodLabel(p.periodEnding, p.meta);
    const formLabel = normalizeFormLabel(p.meta.formType, p.periodEnding) || 'Unknown';
    const f = p.screen.financials;

    const balance = f.accountBalancePlusAccruals ?? f.accountBalance ?? 0;
    const accrued = (f.accruedInterest || 0) + (f.accruedPenalty || 0);
    const assessed = f.totalTax || 0;
    // We don't get "paid" directly from the screening; infer as assessed - balance.
    const paid = Math.max(0, assessed - Math.max(0, balance));

    let statusLabel: string;
    let statusKind: 'open' | 'partial' | 'closed';
    if (balance > 0) {
      statusLabel = accrued > 0 ? 'Open · accruing' : 'Open';
      statusKind = 'open';
    } else if (assessed > 0) {
      statusLabel = 'Closed · paid in full';
      statusKind = 'closed';
    } else {
      statusLabel = 'Zero balance';
      statusKind = 'closed';
    }

    liabilityRows.push({
      form: formLabel,
      period: periodLabel,
      assessed,
      paid,
      balance: Math.max(0, balance),
      accrued,
      statusLabel,
      statusKind,
      source: p.source,
    });

    totalAssessed += assessed;
    totalPaid += paid;
    totalBalance += Math.max(0, balance);
    totalAccrued += accrued;
  }

  // ── Section 4: Federal estimated tax payments (TC 670) ────────────────
  // Builds Collective ask: quarterly payment confirmation. TC 670 is the
  // IRS code for "subsequent payment" — used for both quarterly estimated
  // tax (1040-ES, 1120-W) and balance-due payments. We surface all of them
  // here so the lender can see the rhythm of estimated-tax remittance.
  const estimatedPayments: EstimatedPaymentRow[] = [];
  for (const p of parsed) {
    if (p.screen.isBlank) continue;
    const taxYear = p.periodEnding?.split('-')[2] || '';
    const txs = p.screen.transactionCodes.filter(tc => tc.code === '670' || tc.code === '660' /* tax payment */);
    for (const tc of txs) {
      const amt = parseAmount(tc.amount);
      if (amt === null) continue;
      estimatedPayments.push({
        taxYear,
        quarter: inferQuarterFromDate(tc.date),
        postedOn: normalizeDate(tc.date) || tc.date,
        amount: Math.abs(amt),  // TC 670 amounts can be negative (credit); we want positive
        transactionCode: tc.code,
        source: p.source,
      });
    }
  }
  estimatedPayments.sort((a, b) => b.postedOn.localeCompare(a.postedOn));

  // ── Section 5: Extension grants + amendments + audits ─────────────────
  // Builds Collective ask: extension/amendment tracking. Common codes:
  //   TC 460 — Extension of time to file granted
  //   TC 976 — Amended return filed (duplicate from taxpayer)
  //   TC 977 — Amended return forwarded for processing
  //   TC 290 — Additional tax assessed (audit, math error, etc.)
  //   TC 420 — Examination indicator (audit selected)
  //   TC 421 — Closed examination (audit closed)
  const extensionsAndAmendments: ExtensionAmendmentEvent[] = [];
  for (const p of parsed) {
    if (p.screen.isBlank) continue;
    const periodLabel = formatPeriodLabel(p.periodEnding, p.meta);
    const formLabel = normalizeFormLabel(p.meta.formType, p.periodEnding) || 'Unknown';
    for (const tc of p.screen.transactionCodes) {
      const amt = parseAmount(tc.amount);
      const date = normalizeDate(tc.date) || tc.date;
      switch (tc.code) {
        case '460':
          extensionsAndAmendments.push({
            kind: 'extension_granted', date, transactionCode: '460',
            form: formLabel, period: periodLabel, amount: null, source: p.source,
            description: `IRS granted an extension of time to file ${formLabel} for ${periodLabel}.`,
          });
          break;
        case '977':
          extensionsAndAmendments.push({
            kind: 'amendment_received', date, transactionCode: '977',
            form: formLabel, period: periodLabel, amount: null, source: p.source,
            description: `Amended return for ${formLabel} ${periodLabel} received by IRS, forwarded for processing.`,
          });
          break;
        case '976':
          extensionsAndAmendments.push({
            kind: 'amendment_processed', date, transactionCode: '976',
            form: formLabel, period: periodLabel, amount: null, source: p.source,
            description: `Amended return for ${formLabel} ${periodLabel} processed (duplicate from taxpayer).`,
          });
          break;
        case '290':
          if (amt && amt > 0) {
            extensionsAndAmendments.push({
              kind: 'audit_assessment', date, transactionCode: '290',
              form: formLabel, period: periodLabel, amount: amt, source: p.source,
              description: `IRS assessed additional tax of $${amt.toLocaleString('en-US', { minimumFractionDigits: 2 })} on ${formLabel} ${periodLabel} (audit, math error, or amendment outcome).`,
            });
          }
          break;
        case '420':
          extensionsAndAmendments.push({
            kind: 'audit_examination_started', date, transactionCode: '420',
            form: formLabel, period: periodLabel, amount: null, source: p.source,
            description: `IRS opened examination on ${formLabel} ${periodLabel}. Audit in progress.`,
          });
          break;
      }
    }
  }
  extensionsAndAmendments.sort((a, b) => b.date.localeCompare(a.date));

  // ── Section 3: Repayment Plan Status ────────────────────────────────────
  const allFlags: ComplianceFlag[] = parsed.flatMap(p => p.screen.flags);
  const installmentFlags = allFlags.filter(f => f.type === 'INSTALLMENT');
  const oicFlags = allFlags.filter(f => f.type === 'OIC');
  const collectionFlags = allFlags.filter(f => f.type === 'COLLECTION');

  const cncFlags = collectionFlags.filter(f => /TC 530/.test(f.message));
  const planDetails: string[] = [
    ...installmentFlags.map(f => f.message),
    ...oicFlags.map(f => f.message),
    ...cncFlags.map(f => f.message),
  ];

  const repaymentPlan: RepaymentPlanStatus = {
    hasInstallmentAgreement: installmentFlags.length > 0,
    hasOfferInCompromise: oicFlags.length > 0,
    hasCurrentlyNotCollectible: cncFlags.length > 0,
    details: planDetails,
    recommendation: recommendRepaymentPath(
      installmentFlags.length > 0,
      oicFlags.length > 0,
      cncFlags.length > 0,
      totalBalance,
    ),
  };

  // ── Overall severity + headline ─────────────────────────────────────────
  let overallSeverity: 'CRITICAL' | 'WARNING' | 'CLEAN' = 'CLEAN';
  if (allFlags.some(f => f.severity === 'CRITICAL') || totalBalance > 0 || unfiled.length > 0) {
    overallSeverity = 'CRITICAL';
  } else if (allFlags.some(f => f.severity === 'WARNING')) {
    overallSeverity = 'WARNING';
  }

  const headlineSummary = buildHeadline(
    overallSeverity,
    unfiled.length,
    totalBalance,
    repaymentPlan,
  );

  return {
    entityName,
    tin,
    generatedAt: new Date().toISOString(),
    transcriptsParsed: parsed.length,
    sources: parsed.map(p => p.source),
    filingCompliance: { filed, unfiled },
    taxLiabilities: {
      rows: liabilityRows,
      totalAssessed,
      totalPaid,
      totalBalance,
      totalAccrued,
    },
    repaymentPlan,
    estimatedPayments,
    extensionsAndAmendments,
    overallSeverity,
    headlineSummary,
  };
}

/** "$1,234.56" or "$-1,234.56" → 1234.56 / -1234.56. null if unparseable. */
function parseAmount(s: string | null | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[\$,\s]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

/** "MM-DD-YYYY" → infer quarter (1/2/3/4) from month. null if unparseable. */
function inferQuarterFromDate(date: string | null | undefined): 1 | 2 | 3 | 4 | null {
  if (!date) return null;
  const m = date.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  if (month >= 1 && month <= 3) return 1;
  if (month >= 4 && month <= 6) return 2;
  if (month >= 7 && month <= 9) return 3;
  if (month >= 10 && month <= 12) return 4;
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract Tax Period Ending from the modern IRS HTML (dd class="item-value"). */
function extractPeriodEnding(html: string): string | null {
  const m = html.match(/Report for Tax Period Ending:?[\s\S]{0,200}?<dd[^>]*>([0-9-]+)<\/dd>/i);
  if (m) return m[1];
  // Legacy format fallback: "Tax Period: 202109"
  const alt = html.match(/Tax Period[:\s]+(\d{6})/);
  if (alt) {
    const yr = alt[1].slice(0, 4);
    const mo = alt[1].slice(4, 6);
    return `${mo}-${endOfMonth(parseInt(yr), parseInt(mo))}-${yr}`;
  }
  return null;
}

/** Last day of month, two-digit string. */
function endOfMonth(year: number, month: number): string {
  const d = new Date(year, month, 0).getDate();
  return String(d).padStart(2, '0');
}

/** Format a tax period ending date into a human label: "2021 Q3" / "2023". */
function formatPeriodLabel(periodEnding: string | null, meta: TranscriptMetadata): string {
  if (!periodEnding) return meta.taxYear || 'Unknown period';
  // periodEnding is MM-DD-YYYY
  const [mm, _dd, yyyy] = periodEnding.split('-');
  if (!yyyy) return meta.taxYear || 'Unknown period';
  // Determine annual vs quarterly: month-end of 03/06/09/12 with day=31/30/30/31 → quarterly.
  // Annual is 12-31. Quarterly 941 ending months: 03, 06, 09, 12.
  const month = parseInt(mm, 10);
  // If form is 941 (quarterly), label by quarter. Otherwise annual.
  const isQuarterly = /^941/i.test(meta.formType || '');
  if (isQuarterly) {
    const quarter = ({ 3: 1, 6: 2, 9: 3, 12: 4 } as Record<number, number>)[month];
    return quarter ? `${yyyy} Q${quarter}` : `${yyyy}-${mm}`;
  }
  return yyyy;
}

/** Normalize form names: "1120S" → "1120-S", strip junk. */
function normalizeFormLabel(rawForm: string, periodEnding: string | null): string | null {
  if (!rawForm) {
    // Fallback: infer from period if it's quarterly month-end
    if (periodEnding) {
      const m = periodEnding.match(/^(\d{2})/);
      const month = m ? parseInt(m[1], 10) : null;
      if (month && [3, 6, 9, 12].includes(month)) return '941';
    }
    return null;
  }
  const r = rawForm.trim().toUpperCase();
  if (/^1120S$|^1120-S$/.test(r)) return '1120-S';
  if (/^1120$/.test(r)) return '1120';
  if (/^1065$/.test(r)) return '1065';
  if (/^1040$/.test(r)) return '1040';
  if (/^941$/.test(r)) return '941';
  if (/^940$/.test(r)) return '940';
  return rawForm;
}

/** "MM-DD-YYYY" → "YYYY-MM-DD" so it sorts/displays consistently. */
function normalizeDate(s: string): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : s;
}

/** Plain-English next-step suggestion for the Repayment Plan section. */
function recommendRepaymentPath(
  hasIA: boolean,
  hasOIC: boolean,
  hasCNC: boolean,
  totalBalance: number,
): string {
  if (hasIA) return 'Active installment agreement on file — satisfies SBA "active resolution" requirement. Monitor for default.';
  if (hasOIC) return 'Active Offer in Compromise pending. Loan decisions should wait for OIC acceptance/rejection from IRS.';
  if (hasCNC) return 'Currently Not Collectible status — account is paused. Reassess if financial situation improves.';
  if (totalBalance > 0 && totalBalance < 50_000) {
    return 'No active plan. Recommended: Online Payment Agreement (OPA) on the IRS portal — sub-$50K balances are typically approved within 24 hours and satisfy SBA "active resolution" requirements.';
  }
  if (totalBalance >= 50_000) {
    return 'No active plan and balance is $50K+. Form 9465 + Form 433-F required (financial disclosure). Slower process — start now to avoid loan-funding delays.';
  }
  return 'No outstanding balance and no active repayment plan — nothing required.';
}

function buildHeadline(
  severity: 'CRITICAL' | 'WARNING' | 'CLEAN',
  unfiledCount: number,
  totalBalance: number,
  plan: RepaymentPlanStatus,
): string {
  if (severity === 'CLEAN') {
    return 'No outstanding tax liabilities, no unfiled returns, no active collection action. Clean compliance profile.';
  }
  const parts: string[] = [];
  if (totalBalance > 0) {
    parts.push(`outstanding balance of $${totalBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  }
  if (unfiledCount > 0) {
    parts.push(`${unfiledCount} unfiled return${unfiledCount === 1 ? '' : 's'}`);
  }
  if (plan.hasInstallmentAgreement) parts.push('active installment agreement');
  else if (plan.hasOfferInCompromise) parts.push('pending Offer in Compromise');
  else if (plan.hasCurrentlyNotCollectible) parts.push('currently-not-collectible status');
  if (parts.length === 0) parts.push('flagged transaction codes — see findings below');
  // Generic closing phrase — works for lender, payments, factoring, and
  // any other downstream use case. Previously read "before SBA closing"
  // which was Vine/lender-specific and tripped on non-lender consumers
  // (e.g., Builds Collective payments underwriting).
  return `Findings: ${parts.join('; ')}. Review the per-period detail below before approval.`;
}
