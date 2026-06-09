/**
 * Claims-verification Excel export (Guardian Life offering, feature D).
 *
 * Produces an .xlsx the examiner can drop into their calculation workflow:
 *   - "Summary" sheet: earned / passive / review subtotals per tax year.
 *   - "Income Detail" sheet: every income source with form, payer, filer,
 *     amount, and earned/passive classification.
 *
 * NOTE (open question for the Guardian working session): the exact cell-level
 * mapping into Guardian's own calculation template is TBD until they hand over
 * the template. This is a clean, self-describing default layout; once we have
 * their workbook we add a template-specific writer alongside this one.
 */
import * as XLSX from 'xlsx';
import type { IncomeSplitResult } from './income-split';

export interface ClaimsExportMeta {
  claimantName: string;
  claimNumber?: string;
  tinLast4?: string;
  preparedFor?: string; // e.g. "Guardian Life — Claims"
  generatedOn: string;  // ISO date (caller stamps it; keep lib pure)
}

const usd = (n: number) => Math.round(n * 100) / 100;

export function buildClaimsWorkbook(split: IncomeSplitResult, meta: ClaimsExportMeta): Buffer {
  const wb = XLSX.utils.book_new();

  // --- Summary sheet ---
  const summary: (string | number)[][] = [
    ['ModernTax — Claims Income Verification'],
    ['Prepared for', meta.preparedFor || 'Guardian Life — Claims'],
    ['Claimant', meta.claimantName],
    ['Claim #', meta.claimNumber || '—'],
    ['TIN (last 4)', meta.tinLast4 ? `xxx-xx-${meta.tinLast4}` : '—'],
    ['Filers', split.filers.length ? split.filers.join(', ') : '—'],
    ['Generated', meta.generatedOn],
    [],
    ['Tax Year', 'Earned Income', 'Passive Income', 'Needs Review', 'Total'],
    ...split.byYear.map(y => [y.taxYear, usd(y.earned), usd(y.passive), usd(y.review), usd(y.total)]),
    ['All years', usd(split.totals.earned), usd(split.totals.passive), usd(split.totals.review), usd(split.totals.total)],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(summary);
  ws1['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

  // --- Income Detail sheet ---
  const detail: (string | number)[][] = [
    ['Tax Year', 'Filer', 'Form', 'Payer', 'Amount', 'Classification', 'Note'],
    ...split.byYear.flatMap(y =>
      y.sources
        .slice()
        .sort((a, b) => b.amount - a.amount)
        .map(s => [s.taxYear, s.filer, s.formType, s.payerName, usd(s.amount),
          s.category === 'earned' ? 'Earned' : s.category === 'passive' ? 'Passive' : 'Needs Review',
          s.note || ''])
    ),
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(detail);
  ws2['!cols'] = [{ wch: 10 }, { wch: 22 }, { wch: 12 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Income Detail');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
