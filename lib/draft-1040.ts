/**
 * Draft 1040 preparation engine (2026-06-29).
 *
 * Computes a DRAFT individual federal return (Form 1040) from Wage & Income
 * transcript data + the taxpayer's filing intake, for the 2019–2024 tax years.
 *
 * IMPORTANT — this produces a DRAFT for a CREDENTIALED PREPARER to review,
 * correct, and sign. It is NOT a filed return and must never be presented as
 * final tax advice. The taxpayer also signs (Form 8879 e-file authorization).
 * Every output carries the draft disclaimer + a warnings list for the preparer.
 *
 * Scope today (matches the Marquis Steadman engagement — Matt 2026-06-29):
 *   - Filing status: single. Standard deduction. No dependents.
 *   - Income: W-2 wages + federal withholding, 1099 interest, other ordinary
 *     income. NO self-employment (per intake) — a 1099-NEC therefore triggers a
 *     warning for the preparer rather than silent Schedule C / SE tax.
 *   - Federal tax via the year's ordinary single-filer brackets.
 *   - State (NC) is a flagged ESTIMATE only — the preparer finalizes state.
 *
 * All bracket / standard-deduction figures are public IRS amounts, kept in one
 * auditable table so a preparer can sanity-check them at a glance.
 */

export type FilingStatus = 'single'; // extend (mfj, hoh, …) as the channel grows

interface YearParams {
  standardDeduction: Record<FilingStatus, number>;
  /** Ordinary brackets: [upperBound, rate]; last bound is Infinity. Single only today. */
  brackets: Record<FilingStatus, Array<[number, number]>>;
  /** NC flat rate + single standard deduction for the state ESTIMATE. */
  nc: { rate: number; standardDeduction: number };
}

// Single-filer figures, tax years 2019–2024. (Public IRS / NCDOR amounts.)
export const TAX_YEAR_PARAMS: Record<number, YearParams> = {
  2019: { standardDeduction: { single: 12200 }, nc: { rate: 0.0525, standardDeduction: 10000 },
    brackets: { single: [[9700, .10], [39475, .12], [84200, .22], [160725, .24], [204100, .32], [510300, .35], [Infinity, .37]] } },
  2020: { standardDeduction: { single: 12400 }, nc: { rate: 0.0525, standardDeduction: 10000 },
    brackets: { single: [[9875, .10], [40125, .12], [85525, .22], [163300, .24], [207350, .32], [518400, .35], [Infinity, .37]] } },
  2021: { standardDeduction: { single: 12550 }, nc: { rate: 0.0525, standardDeduction: 10750 },
    brackets: { single: [[9950, .10], [40525, .12], [86375, .22], [164925, .24], [209425, .32], [523600, .35], [Infinity, .37]] } },
  2022: { standardDeduction: { single: 12950 }, nc: { rate: 0.0499, standardDeduction: 12750 },
    brackets: { single: [[10275, .10], [41775, .12], [89075, .22], [170050, .24], [215950, .32], [539900, .35], [Infinity, .37]] } },
  2023: { standardDeduction: { single: 13850 }, nc: { rate: 0.0475, standardDeduction: 12750 },
    brackets: { single: [[11000, .10], [44725, .12], [95375, .22], [182100, .24], [231250, .32], [578125, .35], [Infinity, .37]] } },
  2024: { standardDeduction: { single: 14600 }, nc: { rate: 0.045, standardDeduction: 12750 },
    brackets: { single: [[11600, .10], [47150, .12], [100525, .22], [191950, .24], [243725, .32], [609350, .35], [Infinity, .37]] } },
};

/** Parsed Wage & Income figures for one taxpayer / one year (preparer-verifiable). */
export interface WageIncome {
  /** Sum of W-2 box 1 across all employers. */
  wages: number;
  /** Sum of W-2 box 2 + any 1099 federal withholding. */
  fedWithholding: number;
  /** 1099-INT taxable interest. */
  interest?: number;
  /** Other ordinary income that is NOT self-employment (1099-MISC rents/other, etc.). */
  otherOrdinary?: number;
  /** Non-employee comp present on the W&I — flagged, NOT auto-treated as SE. */
  nonEmployeeComp?: number;
  /** Free-form notes carried from the parser (e.g., payer count). */
  notes?: string[];
}

export interface DraftIntake {
  filingStatus: FilingStatus;
  state?: 'NC';
  standardDeduction: boolean; // true today; itemized would need Schedule A
  dependents: number;
}

export interface DraftReturn {
  taxYear: number;
  filingStatus: FilingStatus;
  // Federal 1040 lines
  totalIncome: number;
  adjustments: number;
  agi: number;
  standardDeduction: number;
  taxableIncome: number;
  federalTax: number;
  federalWithholding: number;
  /** Positive = balance due; negative = refund. */
  federalBalance: number;
  // State estimate (preparer finalizes)
  stateEstimate: { state: string; taxableIncome: number; rate: number; tax: number; note: string } | null;
  warnings: string[];
  disclaimer: string;
}

const round = (n: number) => Math.round(n);

/** Progressive tax from an ordinary bracket table. */
function bracketTax(taxable: number, brackets: Array<[number, number]>): number {
  if (taxable <= 0) return 0;
  let tax = 0, prev = 0;
  for (const [bound, rate] of brackets) {
    const slice = Math.min(taxable, bound) - prev;
    if (slice > 0) tax += slice * rate;
    if (taxable <= bound) break;
    prev = bound;
  }
  return tax;
}

const DISCLAIMER =
  'DRAFT — auto-prepared from IRS transcripts + taxpayer intake. Must be reviewed, ' +
  'corrected, and signed by a credentialed tax preparer (PTIN) before filing. Not final tax advice.';

/**
 * Prepare a draft federal 1040 (single, standard deduction) for one year.
 * Always returns a draft; surfaces anything that needs preparer judgment in
 * `warnings` rather than guessing.
 */
export function computeDraft1040(taxYear: number, income: WageIncome, intake: DraftIntake): DraftReturn {
  const params = TAX_YEAR_PARAMS[taxYear];
  const warnings: string[] = [...(income.notes || [])];
  if (!params) {
    throw new Error(`No tax-year parameters for ${taxYear} — add it to TAX_YEAR_PARAMS before drafting.`);
  }
  if (intake.filingStatus !== 'single') warnings.push(`Filing status "${intake.filingStatus}" not yet supported by the draft engine — preparer must prepare manually.`);
  if (!intake.standardDeduction) warnings.push('Intake indicates itemized deductions — Schedule A required; draft uses standard deduction as a placeholder.');
  if (intake.dependents > 0) warnings.push(`${intake.dependents} dependent(s) indicated — draft does not yet compute CTC/credits.`);
  if ((income.nonEmployeeComp || 0) > 0) warnings.push(`Non-employee compensation ($${round(income.nonEmployeeComp!).toLocaleString()}) on the W&I, but intake reports no self-employment — preparer must resolve (Schedule C / SE tax vs. wages).`);

  const totalIncome = round((income.wages || 0) + (income.interest || 0) + (income.otherOrdinary || 0) + (income.nonEmployeeComp || 0));
  const adjustments = 0;
  const agi = totalIncome - adjustments;
  const standardDeduction = params.standardDeduction[intake.filingStatus];
  const taxableIncome = Math.max(0, agi - standardDeduction);
  const federalTax = round(bracketTax(taxableIncome, params.brackets[intake.filingStatus]));
  const federalWithholding = round(income.fedWithholding || 0);
  const federalBalance = federalTax - federalWithholding;

  let stateEstimate: DraftReturn['stateEstimate'] = null;
  if (intake.state === 'NC') {
    const ncTaxable = Math.max(0, agi - params.nc.standardDeduction);
    stateEstimate = {
      state: 'NC', taxableIncome: ncTaxable, rate: params.nc.rate, tax: round(ncTaxable * params.nc.rate),
      note: 'NC ESTIMATE ONLY — preparer must verify NC standard deduction, additions/deductions, and withholding (D-400).',
    };
  }

  return {
    taxYear, filingStatus: intake.filingStatus,
    totalIncome, adjustments, agi, standardDeduction, taxableIncome,
    federalTax, federalWithholding, federalBalance,
    stateEstimate, warnings, disclaimer: DISCLAIMER,
  };
}

const usd = (n: number) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US');

/** Readable draft summary for the preparer-review surface. */
export function renderDraftSummary(d: DraftReturn): string {
  const lines = [
    `DRAFT FORM 1040 — TAX YEAR ${d.taxYear} (${d.filingStatus})`,
    `  Total income .............. ${usd(d.totalIncome)}`,
    `  Adjusted gross income ..... ${usd(d.agi)}`,
    `  Standard deduction ........ ${usd(d.standardDeduction)}`,
    `  Taxable income ............ ${usd(d.taxableIncome)}`,
    `  Federal tax ............... ${usd(d.federalTax)}`,
    `  Federal withholding ....... ${usd(d.federalWithholding)}`,
    `  ${d.federalBalance >= 0 ? 'Balance due' : 'Refund'} ............... ${usd(Math.abs(d.federalBalance))}`,
  ];
  if (d.stateEstimate) {
    lines.push(`  NC tax (ESTIMATE) ......... ${usd(d.stateEstimate.tax)} @ ${(d.stateEstimate.rate * 100).toFixed(2)}%`);
  }
  if (d.warnings.length) {
    lines.push('  ⚠ PREPARER MUST RESOLVE:');
    for (const w of d.warnings) lines.push(`     - ${w}`);
  }
  lines.push(`  ${d.disclaimer}`);
  return lines.join('\n');
}
