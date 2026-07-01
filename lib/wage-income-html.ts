/**
 * IRS Wage & Income (W&I) transcript parser — HTML format (2026-06-29).
 *
 * Complements lib/wage-income-parser.ts (which handles pdf-parse TEXT from
 * older PDF pulls). The current UNMASKED W&I transcripts are delivered as HTML
 * (label / $value blocks per "Form XXX ..." section). This parses that HTML into
 * structured income for the draft-1040 engine + an itemized form list.
 *
 * Conservative by design: only clean ordinary-income items (W-2 wages, 1099-INT,
 * 1099-NEC, 1099-MISC/G) and ALL federal withholding feed the draft total. Items
 * needing preparer judgment or their own schedule (1099-B capital gains,
 * 1099-DIV qualified-rate, 1099-R taxable-amount) are listed + flagged as
 * warnings, never silently summed. Validated against the B. Every 2022-2024 W&I.
 */

import type { WageIncome } from './draft-1040';

export interface ParsedForm {
  type: string;
  payer: string | null;
  payerTin: string | null;
  amount: number | null;
  amountLabel: string | null;
  federalWithholding: number;
}

export interface WageIncomeParseResult {
  taxYear: number | null;
  recipientTin: string | null;
  forms: ParsedForm[];
  income: WageIncome;
  warnings: string[];
}

const FORM_HEADER = /\bForm (W-2G|W-2|1099-[A-Z]+|1098[A-Z-]*|5498[A-Z-]*|1042-S)\b/g;

const PRIMARY_LABELS: Record<string, string[]> = {
  'W-2': ['Wages, Tips and Other Compensation'],
  '1099-NEC': ['Non-Employee Compensation'],
  '1099-MISC': ['Other Income', 'Rents', 'Nonemployee Compensation'],
  '1099-INT': ['Interest'],
  '1099-DIV': ['Ordinary Dividends', 'Total Ordinary Dividends'],
  '1099-G': ['Unemployment Compensation', 'Taxable Grants'],
  '1099-R': ['Taxable Amount', 'Gross Distribution'],
  '1099-B': ['Proceeds', 'Aggregate Profit'],
};

const NEEDS_REVIEW = new Set(['1099-B', '1099-DIV', '1099-R']);
const NON_INCOME = new Set(['1098', '5498', '1099-SA']);

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

const toNum = (s: string) => Number(s.replace(/[$,]/g, '')) || 0;

function amountFor(block: string, labels: string[]): { value: number; label: string } | null {
  for (const label of labels) {
    const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*\\$?([\\d,]+\\.\\d{2})');
    const m = block.match(re);
    if (m) return { value: toNum(m[1]), label };
  }
  return null;
}

export function parseWageIncomeHtml(html: string): WageIncomeParseResult {
  const text = htmlToText(html);

  const taxYear = (() => {
    const m = text.match(/Tax Period Requested:\s*December,?\s*(\d{4})/i) || text.match(/\b(20\d{2})\b/);
    return m ? Number(m[1]) : null;
  })();
  const recipientTin = (text.match(/Recipient'?s? Identification Number:\s*([X\d-]{9,})/i) || [])[1] || null;

  const headers = [...text.matchAll(FORM_HEADER)];
  const forms: ParsedForm[] = [];
  for (let i = 0; i < headers.length; i++) {
    const type = headers[i][1];
    const start = headers[i].index!;
    const end = i + 1 < headers.length ? headers[i + 1].index! : text.length;
    const block = text.slice(start, end);
    if (NON_INCOME.has(type)) continue;

    const payer = (block.match(/(?:Employer|Payer|Issuer\/Provider)[^\n]*\n(?:[^\n]*\n)?(?:[A-Z][A-Z0-9 .,&'\-]{2,})/) || [])[0]
      ?.split('\n').slice(-1)[0]?.trim() || null;
    const payerTin = (block.match(/(?:Identification Number|FIN|EIN)[^\n]*\n\s*(\d{2}-\d{7})/) || [])[1] || null;
    const prim = amountFor(block, PRIMARY_LABELS[type] || []);
    const wh = block.match(/Federal Income Tax Withheld:\s*\$?([\d,]+\.\d{2})/);

    forms.push({
      type, payer, payerTin,
      amount: prim ? prim.value : null,
      amountLabel: prim ? prim.label : null,
      federalWithholding: wh ? toNum(wh[1]) : 0,
    });
  }

  const income: WageIncome = { wages: 0, fedWithholding: 0, interest: 0, otherOrdinary: 0, nonEmployeeComp: 0, notes: [] };
  const warnings: string[] = [];
  for (const f of forms) {
    income.fedWithholding += f.federalWithholding;
    if (f.amount == null) continue;
    if (f.type === 'W-2') income.wages! += f.amount;
    else if (f.type === '1099-INT') income.interest! += f.amount;
    else if (f.type === '1099-NEC') income.nonEmployeeComp! += f.amount;
    else if (f.type === '1099-MISC' || f.type === '1099-G') income.otherOrdinary! += f.amount;
    if (NEEDS_REVIEW.has(f.type)) {
      warnings.push(`${f.type} from ${f.payer || 'unknown payer'} ($${f.amount.toLocaleString()}) needs preparer handling (${f.type === '1099-B' ? 'Schedule D / basis' : f.type === '1099-DIV' ? 'qualified-dividend rate' : 'taxable-amount determination'}) - not in the draft total.`);
    }
  }
  const bCount = forms.filter((f) => f.type === '1099-B').length;
  if (bCount > 3) warnings.push(`${bCount} 1099-B transactions present - Schedule D required; this taxpayer is NOT a simple W-2 return.`);

  income.notes = [`Parsed ${forms.length} income form(s): ` +
    Object.entries(forms.reduce((a: Record<string, number>, f) => ((a[f.type] = (a[f.type] || 0) + 1), a), {}))
      .map(([t, n]) => `${n}x${t}`).join(', ')];

  return { taxYear, recipientTin, forms, income, warnings };
}
