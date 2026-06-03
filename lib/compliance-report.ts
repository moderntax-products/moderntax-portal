/**
 * Tax-Guard-style Compliance Report — the core deliverable for the
 * Filing-Compliance Report product (MOD-228). Reads IRS Account Transcripts
 * (any form: 941 / 1040 / 1120 / 1120S / 1065) PLUS the IRS Civil Penalty
 * module (MFT 13, pulled as a "Civil Penalty Account Transcript"), and merges
 * them BY TAX YEAR into a funding-risk compliance report modeled on the four
 * sections of a Tax Guard report:
 *
 *   1. Verify Client Information — name/TIN on file, entity/form type, periods.
 *   2. Report Summary (at-a-glance) — Tax Risk Score (0 worst → 100 best),
 *      Total Liability, Civil Penalties, Installment Agreement status,
 *      Liability w/ Liens Filed, Liability at Risk for Levy.
 *   3. Tax Liability Details — per tax YEAR: return filed?, liability,
 *      civil penalty, penalties, interest, lien date, levy-risk date.
 *   4. Tax Compliance Overview — filing status per year, unfiled returns,
 *      tax-deposit trend.
 *
 * Each year combines its income/account transcript (filing status, liability,
 * liens, levies) with its Civil Penalty transcript (assessed penalty, or
 * "none" when the IRS returns no record for the MFT-13 module). A "Requested
 * data not found" income transcript ⇒ no return on file (unfiled); the same on
 * a Civil Penalty module ⇒ no civil penalty (clean).
 *
 * Parsing reuses the proven primitives behind lib/erc-analysis.ts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComplianceTxn {
  code: string;
  explanation: string;
  date: string | null;
  amount: number | null;
}

/** One parsed transcript (either an income/account transcript or a civil-penalty module). */
export interface CompliancePeriod {
  kind: 'tax' | 'civil_penalty';
  formType: string | null;
  taxPeriodEnding: string | null;
  year: number | null;
  noRecord: boolean;              // "Requested data not found"
  returnFiled: boolean;           // TC 150 present (tax kind)
  returnFiledAmount: number | null;
  liability: number;              // account balance owed (>0 = owed)
  penalties: number;              // sum of penalty TCs on this module
  interest: number;
  deposits: number;
  civilPenaltyAmount: number;     // assessed civil penalty (civil_penalty kind)
  lienDate: string | null;
  levyRiskDate: string | null;
  installmentAgreement: boolean;
  transactions: ComplianceTxn[];
}

export type FilingStatus = 'filed' | 'unfiled' | 'not_checked';
export type CivilPenaltyStatus = 'none' | 'assessed' | 'not_checked';

/** One tax YEAR — the income/account transcript merged with its civil-penalty module. */
export interface ComplianceYearRow {
  year: number | null;
  label: string;                  // "TY 2023" / "2023 Q2" for quarterly
  formType: string | null;
  filingStatus: FilingStatus;
  returnFiledAmount: number | null;
  liability: number;
  penalties: number;
  interest: number;
  civilPenalty: number;
  civilPenaltyStatus: CivilPenaltyStatus;
  lienDate: string | null;
  levyRiskDate: string | null;
}

export type IaStatus = 'none' | 'good_standing' | 'potential_default';

export interface ComplianceReport {
  clientInfo: {
    name: string | null;
    tin: string | null;
    formTypes: string[];
    yearsCovered: string[];
    establishmentDate: string | null;
  };
  summary: {
    riskScore: number;
    riskBand: 'low' | 'moderate' | 'elevated' | 'high';
    totalLiability: number;
    totalCivilPenalties: number;
    installmentAgreement: IaStatus;
    liabilityWithLiens: number;
    liabilityAtRiskForLevy: number;
    unfiledCount: number;
    lienCount: number;
  };
  liabilityDetail: ComplianceYearRow[];
  complianceOverview: {
    filingStatus: { label: string; formType: string | null; status: FilingStatus }[];
    unfiledReturns: string[];
    civilPenalties: { label: string; status: CivilPenaltyStatus; amount: number }[];
    depositTrend: { label: string; deposits: number }[];
  };
  generatedFrom: number;
}

// ---------------------------------------------------------------------------
// Primitives (mirror lib/erc-analysis.ts — proven against live transcripts)
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

function yearOf(iso: string | null): number | null {
  const m = (iso || '').match(/^(\d{4})-/);
  return m ? parseInt(m[1], 10) : null;
}


const PENALTY_CODES = new Set(['160', '166', '170', '176', '234', '238', '240', '246', '270', '276', '280', '350']);
const INTEREST_CODES = new Set(['190', '196', '336', '340']);
const DEPOSIT_CODES = new Set(['610', '430', '640', '650', '660', '670', '700', '710', '760']);

// ---------------------------------------------------------------------------
// Generalized transcript parser (income/account OR civil-penalty module)
// ---------------------------------------------------------------------------

export function parseAccountTranscript(input: string): CompliancePeriod | null {
  const text = stripHtml(input);
  if (!/Account\s+Transcript/i.test(text) && !/Form\s+Number:/i.test(text) && !/Record of Account/i.test(text)) return null;

  const isCivilPenalty = /Form\s+Number:\s*Civil\s+Penalty/i.test(text) || /Civil\s+Penalty/i.test(text);
  // Income/account form type — guard against grabbing "Civil" from "Civil Penalty".
  let formType: string | null = null;
  if (!isCivilPenalty) {
    const fm = text.match(/Form\s+Number:\s*(1120S|1120|1065|1040|941|990|1041)\b/i);
    formType = fm ? fm[1].toUpperCase() : (text.match(/Form\s+Number:\s*([0-9A-Za-z]+)/i)?.[1] ?? null);
  }

  const periodMatch = text.match(/Report for Tax Period Ending:\s*(\d{2}-\d{2}-\d{4})/i)
    || text.match(/Tax Period(?: Ending)?:\s*(\d{2}-\d{2}-\d{4})/i);
  const taxPeriodEnding = periodMatch ? parseUsDate(periodMatch[1]) : null;
  const noRecord = /Requested data not found/i.test(text);

  let accountBalance: number | null = null;
  const balIdx = text.search(/Account balance:/i);
  if (balIdx >= 0) {
    const raw = text.slice(balIdx, balIdx + 80).match(/Account balance:\s*(-?\$?[\d,]+\.?\d*)/i);
    accountBalance = raw ? parseAmount(raw[1]) : null;
  }

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
      transactions.push({ code, explanation: expl.trim().replace(/\s+/g, ' '), date: parseUsDate(dateStr), amount: parseAmount(amtStr) ?? null });
    }
  }

  const returnFiled = !isCivilPenalty && transactions.some((t) => t.code === '150');
  const returnFiledAmount = transactions.find((t) => t.code === '150')?.amount ?? null;
  const lienTxn = transactions.find((t) => t.code === '582' || /federal tax lien/i.test(t.explanation));
  const levyTxn = transactions.find((t) => /intent to levy|notice of levy|levy/i.test(t.explanation));
  const iaTxn = transactions.some((t) => /installment agreement/i.test(t.explanation));

  const penalties = transactions.filter((t) => PENALTY_CODES.has(t.code)).reduce((s, t) => s + Math.max(0, t.amount || 0), 0);
  const interest = transactions.filter((t) => INTEREST_CODES.has(t.code)).reduce((s, t) => s + Math.max(0, t.amount || 0), 0);
  const deposits = transactions.filter((t) => DEPOSIT_CODES.has(t.code)).reduce((s, t) => s + Math.abs(t.amount || 0), 0);
  // Civil-penalty module: any assessed amount on the module (penalty TCs or net balance).
  const civilPenaltyAmount = isCivilPenalty
    ? Math.max(penalties, accountBalance && accountBalance > 0 ? accountBalance : 0)
    : 0;

  return {
    kind: isCivilPenalty ? 'civil_penalty' : 'tax',
    formType,
    taxPeriodEnding,
    year: yearOf(taxPeriodEnding),
    noRecord,
    returnFiled,
    returnFiledAmount,
    liability: accountBalance && accountBalance > 0 ? accountBalance : 0,
    penalties: Math.round(penalties * 100) / 100,
    interest: Math.round(interest * 100) / 100,
    deposits: Math.round(deposits * 100) / 100,
    civilPenaltyAmount: Math.round(civilPenaltyAmount * 100) / 100,
    lienDate: lienTxn?.date ?? null,
    levyRiskDate: levyTxn?.date ?? null,
    installmentAgreement: iaTxn,
    transactions,
  };
}

// ---------------------------------------------------------------------------
// Report assembly + risk scoring
// ---------------------------------------------------------------------------

function computeRiskScore(rows: ComplianceYearRow[]): number {
  if (rows.length === 0) return 100;
  let score = 100;
  const totalLiability = rows.reduce((s, r) => s + r.liability, 0);
  const totalCivil = rows.reduce((s, r) => s + r.civilPenalty, 0);
  const lienCount = rows.filter((r) => r.lienDate).length;
  const levyCount = rows.filter((r) => r.levyRiskDate).length;
  const unfiled = rows.filter((r) => r.filingStatus === 'unfiled').length;
  const civilCount = rows.filter((r) => r.civilPenaltyStatus === 'assessed').length;
  const hasIA = false; // IA derived at report level below

  if (totalLiability > 0) score -= Math.min(40, Math.round(Math.log10(totalLiability + 1) * 8));
  if (totalCivil > 0) score -= Math.min(15, Math.round(Math.log10(totalCivil + 1) * 4) + civilCount * 2);
  score -= Math.min(30, lienCount * 15);
  score -= Math.min(35, levyCount * 18);
  score -= Math.min(20, unfiled * 7);
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
    .filter((p): p is CompliancePeriod => p !== null);

  // Group by year, separating the income/account transcript from the civil-penalty module.
  const years = [...new Set(periods.map((p) => p.year).filter((y): y is number => y != null))].sort((a, b) => b - a);

  const rows: ComplianceYearRow[] = years.map((yr) => {
    const yearPeriods = periods.filter((p) => p.year === yr);
    const taxPeriods = yearPeriods.filter((p) => p.kind === 'tax');
    const cpPeriods = yearPeriods.filter((p) => p.kind === 'civil_penalty');
    // Prefer the income transcript that actually has a return / activity.
    const tax = taxPeriods.find((p) => p.returnFiled) || taxPeriods.find((p) => !p.noRecord) || taxPeriods[0] || null;

    let filingStatus: FilingStatus = 'not_checked';
    if (tax) filingStatus = tax.returnFiled ? 'filed' : 'unfiled';

    // Civil penalty: any module with an assessed amount → assessed; a module present
    // (even no-record) → 'none'; no module at all → not_checked.
    let civilPenalty = 0;
    let civilPenaltyStatus: CivilPenaltyStatus = 'not_checked';
    if (cpPeriods.length > 0) {
      civilPenalty = Math.round(cpPeriods.reduce((s, p) => s + p.civilPenaltyAmount, 0) * 100) / 100;
      civilPenaltyStatus = civilPenalty > 0 ? 'assessed' : 'none';
    }

    const formType = tax?.formType || (taxPeriods[0]?.formType ?? null);
    return {
      year: yr,
      label: `TY ${yr}`,
      formType,
      filingStatus,
      returnFiledAmount: tax?.returnFiledAmount ?? null,
      liability: tax?.liability ?? 0,
      penalties: tax?.penalties ?? 0,
      interest: tax?.interest ?? 0,
      civilPenalty,
      civilPenaltyStatus,
      lienDate: tax?.lienDate ?? null,
      levyRiskDate: tax?.levyRiskDate ?? null,
    };
  });

  const totalLiability = Math.round(rows.reduce((s, r) => s + r.liability, 0) * 100) / 100;
  const totalCivilPenalties = Math.round(rows.reduce((s, r) => s + r.civilPenalty, 0) * 100) / 100;
  const liabilityWithLiens = Math.round(rows.filter((r) => r.lienDate).reduce((s, r) => s + r.liability, 0) * 100) / 100;
  const liabilityAtRiskForLevy = Math.round(rows.filter((r) => r.levyRiskDate).reduce((s, r) => s + r.liability, 0) * 100) / 100;
  const unfiled = rows.filter((r) => r.filingStatus === 'unfiled');
  const lienCount = rows.filter((r) => r.lienDate).length;
  const hasIA = periods.some((p) => p.installmentAgreement);

  let ia: IaStatus = 'none';
  if (hasIA) ia = (unfiled.length > 0 || liabilityAtRiskForLevy > 0) ? 'potential_default' : 'good_standing';

  const riskScore = computeRiskScore(rows);
  const formTypes = [...new Set(rows.map((r) => r.formType).filter(Boolean) as string[])];
  const allDates = periods.flatMap((p) => p.transactions.map((t) => t.date).filter(Boolean) as string[]).sort();

  return {
    clientInfo: {
      name: entityName || null,
      tin,
      formTypes,
      yearsCovered: rows.map((r) => r.label),
      establishmentDate: allDates[0] || null,
    },
    summary: {
      riskScore,
      riskBand: riskBand(riskScore),
      totalLiability,
      totalCivilPenalties,
      installmentAgreement: ia,
      liabilityWithLiens,
      liabilityAtRiskForLevy,
      unfiledCount: unfiled.length,
      lienCount,
    },
    liabilityDetail: rows,
    complianceOverview: {
      filingStatus: rows.map((r) => ({ label: r.label, formType: r.formType, status: r.filingStatus })),
      unfiledReturns: unfiled.map((r) => r.label),
      civilPenalties: rows
        .filter((r) => r.civilPenaltyStatus !== 'not_checked')
        .map((r) => ({ label: r.label, status: r.civilPenaltyStatus, amount: r.civilPenalty })),
      depositTrend: [],
    },
    generatedFrom: periods.length,
  };
}
