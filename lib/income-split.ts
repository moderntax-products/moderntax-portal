/**
 * Earned vs. Passive income split — Guardian Life claims-verification offering
 * (feature C). Examiners need a claimant's income separated into EARNED (current
 * earning capacity: wages, self-employment) vs. PASSIVE (investment / non-labor:
 * interest, dividends, capital gains, rents, retirement) so disability/claims
 * decisions key off the right number.
 *
 * Input: the income_sources produced by lib/wage-income-parser (the IRS Wage &
 * Income transcript), optionally across multiple filers (joint returns) and
 * years. Output: earned / passive / review subtotals per year + per-source
 * detail, ready for the report and the Excel export (feature D).
 *
 * Categorization basis: standard federal treatment. Where the active/passive
 * character genuinely can't be determined from a W&I transcript alone (K-1
 * material-participation, 1099-MISC "other income" box 3), the source is flagged
 * `review` rather than silently bucketed — to be confirmed at the Guardian
 * working session against their underwriting definitions (open question).
 */

import type { IncomeSource, ParsedTranscript } from './wage-income-parser';

export type IncomeCategory = 'earned' | 'passive' | 'review';

export interface SplitSource {
  formType: string;
  payerName: string;
  taxYear: string;
  filer: string;          // recipient name (distinguishes joint filers)
  amount: number;
  category: IncomeCategory;
  note?: string;
}

export interface YearSplit {
  taxYear: string;
  earned: number;
  passive: number;
  review: number;
  total: number;
  sources: SplitSource[];
}

export interface IncomeSplitResult {
  byYear: YearSplit[];
  totals: { earned: number; passive: number; review: number; total: number };
  filers: string[];       // distinct recipients seen (1 = single, 2+ = joint)
}

// Default category per IRS form type. 1099-MISC + K-1 are box/character-dependent
// → handled in categorizeSource(), not here.
const CATEGORY_BY_FORM: Record<string, IncomeCategory> = {
  'W-2': 'earned',         // wages
  'W-2G': 'passive',       // gambling winnings — not earned
  '1099-NEC': 'earned',    // nonemployee / self-employment comp
  '1099-INT': 'passive',   // interest
  '1099-DIV': 'passive',   // dividends
  '1099-B': 'passive',     // securities proceeds / capital gains
  '1099-R': 'passive',     // retirement / pension / annuity distributions
  '1099-G': 'passive',     // unemployment / govt payments
  '1099-K': 'earned',      // payment-card receipts → business activity
  '1099-S': 'passive',     // real-estate sale proceeds
  'SSA-1099': 'passive',   // social security benefits
  '1098': 'review',        // mortgage interest paid (not income; flag)
};

const norm = (s: string) => (s || '').toUpperCase().replace(/\s+/g, '').replace(/^FORM/, '');

/** Pull the primary dollar amount from a source's `fields` box map. */
export function primaryAmount(source: IncomeSource): number {
  const fields = source.fields || {};
  const entries = Object.entries(fields).map(([k, v]) => [k.toLowerCase(), num(v)] as const).filter(([, v]) => v > 0);
  if (!entries.length) return 0;
  const ft = norm(source.form_type);
  // Preferred primary box per form (avoids double-counting subsets like
  // 1099-DIV box 1b ⊂ 1a). Falls back to the largest positive field.
  const prefer: Record<string, RegExp> = {
    'W-2': /wage|box1|compensation/,
    '1099-NEC': /nonemployee|box1|compensation/,
    '1099-INT': /interest income|box1|^interest/,
    '1099-DIV': /ordinary dividend|total ordinary|box1a|box 1a/,
    '1099-R': /gross distribution|box1|^gross/,
    '1099-G': /unemployment|box1/,
    '1099-B': /proceed|gain|box1/,
    'SSA-1099': /net benefit|box5|benefit/,
    'W-2G': /gross winning|winning|box1/,
  };
  const pat = prefer[ft];
  if (pat) {
    const hit = entries.find(([k]) => pat.test(k));
    if (hit) return hit[1];
  }
  return Math.max(...entries.map(([, v]) => v));
}

/** Categorize a single income source (handles box-level forms). */
export function categorizeSource(source: IncomeSource): { category: IncomeCategory; note?: string } {
  const ft = norm(source.form_type);
  if (ft === '1099-MISC') {
    const keys = Object.keys(source.fields || {}).map(k => k.toLowerCase()).join(' ');
    if (/rent/.test(keys)) return { category: 'passive', note: 'rents' };
    if (/royalt/.test(keys)) return { category: 'passive', note: 'royalties' };
    if (/nonemployee/.test(keys)) return { category: 'earned', note: 'nonemployee comp' };
    return { category: 'review', note: '1099-MISC — box character needs review' };
  }
  if (/K-?1|1065|1120S/.test(ft)) {
    return { category: 'review', note: 'K-1 — active vs passive depends on material participation' };
  }
  const cat = CATEGORY_BY_FORM[ft];
  return cat ? { category: cat } : { category: 'review', note: `unmapped form ${source.form_type}` };
}

function num(v: string | number): number {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Build the earned/passive split from one or more parsed W&I transcripts.
 * Accepts ParsedTranscript[] (joint filers / multiple years all flatten in).
 */
export function buildIncomeSplit(transcripts: ParsedTranscript[] | IncomeSource[]): IncomeSplitResult {
  const sources: IncomeSource[] = Array.isArray(transcripts) && transcripts.length && 'income_sources' in (transcripts[0] as any)
    ? (transcripts as ParsedTranscript[]).flatMap(t => t.income_sources || [])
    : (transcripts as IncomeSource[]);

  const split: SplitSource[] = sources.map(s => {
    const { category, note } = categorizeSource(s);
    return {
      formType: s.form_type,
      payerName: s.payer_name || '—',
      taxYear: s.tax_year || '—',
      filer: s.recipient_name || '—',
      amount: r2(primaryAmount(s)),
      category, note,
    };
  });

  const years = [...new Set(split.map(s => s.taxYear))].sort();
  const byYear: YearSplit[] = years.map(y => {
    const rows = split.filter(s => s.taxYear === y);
    const sum = (c: IncomeCategory) => r2(rows.filter(s => s.category === c).reduce((a, s) => a + s.amount, 0));
    const earned = sum('earned'), passive = sum('passive'), review = sum('review');
    return { taxYear: y, earned, passive, review, total: r2(earned + passive + review), sources: rows };
  });

  const tot = (c: IncomeCategory) => r2(split.filter(s => s.category === c).reduce((a, s) => a + s.amount, 0));
  const earned = tot('earned'), passive = tot('passive'), review = tot('review');
  return {
    byYear,
    totals: { earned, passive, review, total: r2(earned + passive + review) },
    filers: [...new Set(split.map(s => s.filer))].filter(f => f && f !== '—'),
  };
}
