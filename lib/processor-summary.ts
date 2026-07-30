/**
 * Processor plain-language summary.
 *
 * Loan processors don't want to open 50 raw IRS transcript HTML files and read
 * transaction codes — they want the answer in plain English: is the borrower
 * compliant, do they owe anything, is there a risk to the loan. This turns the
 * structured TaxLiabilityReport (parsed from the transcripts) plus the pull
 * coverage into a short, readable summary the processor can act on.
 *
 * Pure + deterministic. The generation route parses the transcripts, calls
 * this, and stores the result on gross_receipts.processor_summary; the request
 * page renders it above the raw file list. Matt 2026-07-29.
 */

import type { TaxLiabilityReport } from './tax-liability-report';

const PAYROLL_FORMS = new Set(['941', '940', '943', '944']);
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

export type SummaryTone = 'ok' | 'warn' | 'crit';

export interface SummaryCoverage {
  /** e.g. "Income tax (1120S) — 2023, 2024, 2025" or '' if none pulled. */
  income: string;
  /** e.g. "Payroll tax (941) — 2023 Q1 through 2025 Q4 (11 quarters)". */
  payroll: string;
  /** e.g. "Unemployment (940) — 2023, 2024, 2025". */
  unemployment: string;
}

export interface ProcessorSummarySection {
  title: string;
  body: string;
  tone: SummaryTone;
}

export interface ProcessorSummary {
  headline: string;
  tone: SummaryTone;
  sections: ProcessorSummarySection[];
  bottomLine: string;
  generatedAt: string;
}

function worse(a: SummaryTone, b: SummaryTone): SummaryTone {
  const rank = { ok: 0, warn: 1, crit: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/** Build the plain-language summary from a parsed report + pull coverage. */
export function buildProcessorSummary(
  report: TaxLiabilityReport,
  coverage: SummaryCoverage,
  generatedAt: string,
): ProcessorSummary {
  const rows = report.taxLiabilities?.rows || [];
  const payrollBalance = rows.filter(r => PAYROLL_FORMS.has(r.form)).reduce((n, r) => n + (r.balance || 0) + (r.accrued || 0), 0);
  const incomeBalance = rows.filter(r => !PAYROLL_FORMS.has(r.form)).reduce((n, r) => n + (r.balance || 0) + (r.accrued || 0), 0);
  const totalOwed = Math.round(payrollBalance + incomeBalance);
  const unfiled = report.filingCompliance?.unfiled || [];
  const undelivered = report.ercRefundStatus?.totalUndelivered || 0;
  const name = report.entityName;

  let tone: SummaryTone = 'ok';
  const sections: ProcessorSummarySection[] = [];

  // 1. What we pulled — always first, plain coverage.
  const coverageLines = [coverage.income, coverage.payroll, coverage.unemployment].filter(Boolean);
  sections.push({
    title: 'What we pulled',
    tone: 'ok',
    body: coverageLines.length
      ? coverageLines.join('  •  ')
      : `IRS transcripts for ${name} (${report.transcriptsParsed} documents).`,
  });

  // 2. Income taxes.
  if (coverage.income) {
    const t: SummaryTone = incomeBalance > 0 ? 'crit' : 'ok';
    sections.push({
      title: 'Income taxes',
      tone: t,
      body: incomeBalance > 0
        ? `The business owes about ${usd(incomeBalance)} in income tax. See the balance detail below.`
        : `Returns are filed and there is no outstanding income-tax balance.`,
    });
    tone = worse(tone, t);
  }

  // 3. Payroll taxes — the trust-fund/lien-risk piece a lender cares about most.
  if (coverage.payroll) {
    const t: SummaryTone = payrollBalance > 0 ? 'crit' : 'ok';
    sections.push({
      title: 'Payroll taxes (Form 941)',
      tone: t,
      body: payrollBalance > 0
        ? `There is about ${usd(payrollBalance)} of unpaid payroll (trust-fund) tax. This is the IRS's highest collection priority and can file as a federal lien that subordinates a loan — worth resolving before closing.`
        : `Every quarter is filed and paid — no outstanding payroll-tax balance and no trust-fund exposure.`,
    });
    tone = worse(tone, t);
  }

  // 4. Unfiled returns — a real blocker even at $0 balance.
  if (unfiled.length) {
    sections.push({
      title: 'Unfiled returns',
      tone: 'warn',
      body: `${unfiled.length} return${unfiled.length === 1 ? '' : 's'} the IRS expected have no record of being filed: ${
        unfiled.slice(0, 6).map(u => `${u.form} ${u.period}`).join(', ')
      }${unfiled.length > 6 ? '…' : ''}. Getting these filed brings the borrower current.`,
    });
    tone = worse(tone, 'warn');
  }

  // 5. Refund sitting at the IRS (money owed TO the borrower).
  if (undelivered > 0) {
    sections.push({
      title: 'Undelivered refund',
      tone: 'warn',
      body: `${usd(undelivered)} in refunds the IRS issued but never delivered — recoverable for the borrower with a Form 3911 filing.`,
    });
  }

  // Headline + bottom line — the one-liner a processor reads first.
  let headline: string;
  let bottomLine: string;
  if (totalOwed > 0) {
    headline = `${name} has an outstanding IRS balance of about ${usd(totalOwed)}.`;
    bottomLine = payrollBalance > 0
      ? `Flag for the file: unpaid payroll tax is a federal-lien risk. Recommend resolving (or getting a plan in place) before the loan closes.`
      : `Recommend confirming a payment plan or payoff before closing.`;
  } else if (unfiled.length) {
    headline = `${name} has no outstanding IRS balance, but ${unfiled.length} return${unfiled.length === 1 ? '' : 's'} still need to be filed.`;
    bottomLine = `No money owed, but the borrower isn't fully current until the unfiled returns are in.`;
  } else {
    headline = `${name} is fully tax-compliant — all returns filed, no outstanding IRS balances.`;
    bottomLine = `Clean file: no income-tax balance, no payroll-tax exposure, no unfiled returns. Nothing here should hold up the loan.`;
  }

  return { headline, tone, sections, bottomLine, generatedAt };
}

/**
 * Derive plain-language coverage lines from the transcript filenames on the
 * entity (form + years/quarters), so the summary can say exactly what was
 * pulled without re-parsing.
 */
export function coverageFromFilenames(filenames: string[]): SummaryCoverage {
  const incomeYears = new Set<string>();
  const payrollQ = new Set<string>();
  const unempYears = new Set<string>();
  for (const raw of filenames) {
    const n = (raw.split('/').pop() || raw);
    const q = n.match(/\b(20\d\d)-Q([1-4])\b/);
    const y = n.match(/\b(20\d\d)\b/);
    if (/\b941\b/.test(n) && q) payrollQ.add(`${q[1]}-Q${q[2]}`);
    else if (/\b940\b/.test(n) && y) unempYears.add(y[1]);
    else if (/\b(1120S|1120|1065|1040)\b/.test(n) && y) incomeYears.add(y[1]);
  }
  const incomeForm = filenames.map(f => (f.match(/\b(1120S|1120|1065|1040)\b/) || [])[1]).find(Boolean) || 'income';
  const sortQ = [...payrollQ].sort();
  return {
    income: incomeYears.size ? `Income tax (${incomeForm}) — ${[...incomeYears].sort().join(', ')}` : '',
    payroll: sortQ.length
      ? `Payroll tax (941) — ${sortQ[0]} through ${sortQ[sortQ.length - 1]} (${sortQ.length} quarter${sortQ.length === 1 ? '' : 's'})`
      : '',
    unemployment: unempYears.size ? `Unemployment (940) — ${[...unempYears].sort().join(', ')}` : '',
  };
}
