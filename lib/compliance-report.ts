/**
 * Tax-Guard-style Compliance Report — the core deliverable for the
 * Filing-Compliance Report product (MOD-228). Reads IRS Account Transcripts
 * (any form: 941 / 1040 / 1120 / 1065) and produces a funding-risk compliance
 * report modeled on the four sections of a Tax Guard report:
 *
 *   1. Verify Client Information — name/TIN/address on file, entity/form type,
 *      filing requirements (the periods covered).
 *   2. Report Summary (at-a-glance) — Tax Risk Score (0 worst → 100 best),
 *      Total Liability, Installment Agreement status, Liability w/ Liens Filed,
 *      Liability at Risk for Levy.
 *   3. Tax Liability Details — per form+period: return-filed amount, current
 *      liability (tax + penalties + interest, net of deposits), lien date,
 *      levy-risk date.
 *   4. Tax Compliance Overview — filing status per period (filed/unfiled),
 *      unfiled returns, and the tax-deposit trend.
 *
 * Parsing reuses the proven primitives behind lib/erc-analysis.ts
 * (parse941Transcript), generalized to any account transcript. Lien / levy /
 * installment-agreement detection keys off the transaction EXPLANATION text
 * (which the IRS prints in plain English) rather than action codes, which the
 * stripped-HTML form doesn't reliably expose.
 *
 * IRS transaction codes referenced (standard Account Transcript set):
 *   150 Return filed / tax assessed        582 Lien filed
 *   160/166 Failure-to-file penalty         583 Lien released
 *   170/176 Estimated-tax penalty           480 OIC pending
 *   270/276 Failure-to-pay penalty          530 Currently-not-collectible
 *   196/336/340 Interest assessed           971 Misc (IA / levy / notice — read explanation)
 *   650/660/670 Federal tax deposit/payment 846 Refund issued
 *   240 Misc civil penalty                  611/612 Payment dishonored
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComplianceTxn {
  code: string;
  explanation: string;
  date: string | null;   // ISO
  amount: number | null;
}

export interface CompliancePeriod {
  formType: string | null;       // "941", "1040", "1120", "1120S", "1065"
  taxPeriodEnding: string | null; // ISO YYYY-MM-DD
  label: string;                 // human period, e.g. "2023 Q2" or "TY 2023"
  returnFiled: boolean;          // TC 150 present
  liability: number;             // current account balance owed (>0 = owed)
  returnFiledAmount: number | null; // TC 150 amount (assessed tax per return)
  penalties: number;             // sum of penalty TCs
  interest: number;              // sum of interest TCs
  deposits: number;              // sum of FTD / payment TCs (abs)
  lienDate: string | null;       // TC 582 date
  levyRiskDate: string | null;   // intent-to-levy notice date
  installmentAgreement: boolean; // IA marker present for this period
  transactions: ComplianceTxn[];
}

export type IaStatus = 'none' | 'good_standing' | 'potential_default';

export interface ComplianceReport {
  // Section 1 — Verify Client Information
  clientInfo: {
    name: string | null;
    tin: string | null;
    formTypes: string[];          // distinct forms seen across transcripts
    periodsCovered: string[];     // labels
    establishmentDate: string | null; // best-effort (earliest activity)
  };
  // Section 2 — Report Summary
  summary: {
    riskScore: number;            // 0 worst → 100 best
    riskBand: 'low' | 'moderate' | 'elevated' | 'high';
    totalLiability: number;
    installmentAgreement: IaStatus;
    liabilityWithLiens: number;   // liability on periods with a lien filed
    liabilityAtRiskForLevy: number; // liability on periods with an intent-to-levy notice
    unfiledCount: number;
    lienCount: number;
  };
  // Section 3 — Tax Liability Details (per period, only those with liability or activity)
  liabilityDetail: CompliancePeriod[];
  // Section 4 — Tax Compliance Overview
  complianceOverview: {
    filingStatus: { label: string; formType: string | null; filed: boolean }[];
    unfiledReturns: string[];     // labels of unfiled periods
    depositTrend: { label: string; deposits: number }[];
  };
  generatedFrom: number;          // transcript count
}

// ---------------------------------------------------------------------------
// Primitives (mirrors lib/erc-analysis.ts — proven against live transcripts)
// ---------------------------------------------------------------------------

function stripHtml(input: string): string {
  let s = input.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function parseAmount(s: string): number | null {
  const cleaned = s.replace(/[$,]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseUsDate(s: string): string | null {
  const m = s.match(/(\d{2})[\/-](\d{2})[\/-](\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function periodLabel(formType: string | null, iso: string | null): string {
  if (!iso) return 'Unknown period';
  const m = iso.match(/^(\d{4})-(\d{2})-/);
  if (!m) return iso;
  const year = m[1], month = parseInt(m[2], 10);
  // Quarterly forms (941) → quarter label; annual forms → tax year
  if (formType === '941') {
    const q = month === 3 ? 1 : month === 6 ? 2 : month === 9 ? 3 : month === 12 ? 4 : null;
    return q ? `${year} Q${q}` : `${year}-${m[2]}`;
  }
  return `TY ${year}`;
}

// Penalty / interest / deposit transaction-code sets
const PENALTY_CODES = new Set(['160', '166', '170', '176', '234', '238', '240', '246', '270', '276', '280', '350']);
const INTEREST_CODES = new Set(['190', '196', '336', '340', '196']);
const DEPOSIT_CODES = new Set(['610', '430', '640', '650', '660', '670', '700', '710', '760']);

// ---------------------------------------------------------------------------
// Generalized account-transcript parser (any form)
// ---------------------------------------------------------------------------

export function parseAccountTranscript(input: string): CompliancePeriod | null {
  const text = stripHtml(input);
  if (!/Account\s+Transcript/i.test(text) && !/Form\s+Number:/i.test(text)) return null;

  const formMatch = text.match(/Form\s+Number:\s*([0-9A-Za-z\-]+)/i);
  const formType = formMatch ? formMatch[1] : null;

  const periodMatch = text.match(/Report for Tax Period Ending:\s*(\d{2}-\d{2}-\d{4})/i)
    || text.match(/Tax Period(?: Ending)?:\s*(\d{2}-\d{2}-\d{4})/i);
  const taxPeriodEnding = periodMatch ? parseUsDate(periodMatch[1]) : null;

  let accountBalance: number | null = null;
  const balIdx = text.search(/Account balance:/i);
  if (balIdx >= 0) {
    const raw = text.slice(balIdx, balIdx + 80).match(/Account balance:\s*(-?\$?[\d,]+\.?\d*)/i);
    accountBalance = raw ? parseAmount(raw[1]) : null;
  }

  // Transactions (same regex shape as parse941Transcript)
  const transactions: ComplianceTxn[] = [];
  const txStart = text.search(/TRANSACTIONS\s+CODE\s+EXPLANATION/i);
  if (txStart >= 0) {
    let body = text.slice(txStart);
    const endIdx = body.search(/This Product Contains Sensitive/i);
    if (endIdx > 0) body = body.slice(0, endIdx);
    const tcRegex = /\b(\d{3})\s+([A-Za-z][A-Za-z \-\/()&,.]{2,90}?)\s+(?:[\d-]+-\d+-\d+-\d+\s+)?(?:(\d{6})\s+)?(\d{2}-\d{2}-\d{4})\s+(-?\$?-?[\d,]+\.?\d*)/g;
    let m: RegExpExecArray | null;
    while ((m = tcRegex.exec(body)) !== null) {
      const [, code, expl, , dateStr, amtStr] = m;
      if (code === 'COD' || code === 'CODE') continue;
      transactions.push({
        code,
        explanation: expl.trim().replace(/\s+/g, ' '),
        date: parseUsDate(dateStr),
        amount: parseAmount(amtStr) ?? null,
      });
    }
  }

  const returnFiled = transactions.some((t) => t.code === '150');
  const returnFiledAmount = transactions.find((t) => t.code === '150')?.amount ?? null;

  // Lien / levy / installment-agreement detection via explanation text.
  const lienTxn = transactions.find((t) => t.code === '582' || /federal tax lien/i.test(t.explanation));
  const levyTxn = transactions.find((t) => /intent to levy|notice of levy|levy/i.test(t.explanation));
  const iaTxn = transactions.some((t) => /installment agreement/i.test(t.explanation))
    || /installment agreement/i.test(text);

  const penalties = transactions.filter((t) => PENALTY_CODES.has(t.code))
    .reduce((s, t) => s + Math.max(0, t.amount || 0), 0);
  const interest = transactions.filter((t) => INTEREST_CODES.has(t.code))
    .reduce((s, t) => s + Math.max(0, t.amount || 0), 0);
  const deposits = transactions.filter((t) => DEPOSIT_CODES.has(t.code))
    .reduce((s, t) => s + Math.abs(t.amount || 0), 0);

  return {
    formType,
    taxPeriodEnding,
    label: periodLabel(formType, taxPeriodEnding),
    returnFiled,
    liability: accountBalance && accountBalance > 0 ? accountBalance : 0,
    returnFiledAmount,
    penalties: Math.round(penalties * 100) / 100,
    interest: Math.round(interest * 100) / 100,
    deposits: Math.round(deposits * 100) / 100,
    lienDate: lienTxn?.date ?? null,
    levyRiskDate: levyTxn?.date ?? null,
    installmentAgreement: iaTxn,
    transactions,
  };
}

// ---------------------------------------------------------------------------
// Report assembly + risk scoring
// ---------------------------------------------------------------------------

function computeRiskScore(periods: CompliancePeriod[]): number {
  if (periods.length === 0) return 100;
  let score = 100;
  const totalLiability = periods.reduce((s, p) => s + p.liability, 0);
  const lienCount = periods.filter((p) => p.lienDate).length;
  const levyCount = periods.filter((p) => p.levyRiskDate).length;
  const unfiled = periods.filter((p) => !p.returnFiled).length;
  const hasIA = periods.some((p) => p.installmentAgreement);

  // Liability magnitude — up to -40 on a log scale ($1k ≈ -7, $50k ≈ -28, $250k+ ≈ -40)
  if (totalLiability > 0) {
    score -= Math.min(40, Math.round(Math.log10(totalLiability + 1) * 8));
  }
  // Liens — severe (filed = public, secured claim ahead of lender)
  score -= Math.min(30, lienCount * 15);
  // Active levy risk — most severe (imminent seizure)
  score -= Math.min(35, levyCount * 18);
  // Unfiled returns — hidden liabilities
  score -= Math.min(20, unfiled * 7);
  // Mitigation: an IA in place softens liability/levy risk
  if (totalLiability > 0 && hasIA) score += 12;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function riskBand(score: number): ComplianceReport['summary']['riskBand'] {
  if (score >= 80) return 'low';
  if (score >= 60) return 'moderate';
  if (score >= 35) return 'elevated';
  return 'high';
}

export function buildComplianceReport(
  entityName: string,
  tin: string | null,
  transcripts: { source: string; html: string }[],
): ComplianceReport {
  const periods = transcripts
    .map((t) => parseAccountTranscript(t.html))
    .filter((p): p is CompliancePeriod => p !== null)
    // newest period first
    .sort((a, b) => (b.taxPeriodEnding || '').localeCompare(a.taxPeriodEnding || ''));

  const formTypes = [...new Set(periods.map((p) => p.formType).filter(Boolean) as string[])];
  const totalLiability = Math.round(periods.reduce((s, p) => s + p.liability, 0) * 100) / 100;
  const liabilityWithLiens = Math.round(periods.filter((p) => p.lienDate).reduce((s, p) => s + p.liability, 0) * 100) / 100;
  const liabilityAtRiskForLevy = Math.round(periods.filter((p) => p.levyRiskDate).reduce((s, p) => s + p.liability, 0) * 100) / 100;
  const unfiled = periods.filter((p) => !p.returnFiled);
  const lienCount = periods.filter((p) => p.lienDate).length;
  const hasIA = periods.some((p) => p.installmentAgreement);

  let ia: IaStatus = 'none';
  if (hasIA) ia = (unfiled.length > 0 || liabilityAtRiskForLevy > 0) ? 'potential_default' : 'good_standing';

  const riskScore = computeRiskScore(periods);

  // earliest dated transaction = best-effort establishment / account-opening signal
  const allDates = periods.flatMap((p) => p.transactions.map((t) => t.date).filter(Boolean) as string[]).sort();
  const establishmentDate = allDates[0] || null;

  return {
    clientInfo: {
      name: entityName || periods[0]?.transactions.length ? entityName : null,
      tin,
      formTypes,
      periodsCovered: periods.map((p) => p.label),
      establishmentDate,
    },
    summary: {
      riskScore,
      riskBand: riskBand(riskScore),
      totalLiability,
      installmentAgreement: ia,
      liabilityWithLiens,
      liabilityAtRiskForLevy,
      unfiledCount: unfiled.length,
      lienCount,
    },
    liabilityDetail: periods.filter((p) => p.liability > 0 || p.returnFiled || p.transactions.length > 0),
    complianceOverview: {
      filingStatus: periods.map((p) => ({ label: p.label, formType: p.formType, filed: p.returnFiled })),
      unfiledReturns: unfiled.map((p) => p.label),
      depositTrend: periods
        .filter((p) => p.deposits > 0)
        .map((p) => ({ label: p.label, deposits: p.deposits }))
        .reverse(), // oldest → newest for trend reading
    },
    generatedFrom: periods.length,
  };
}
