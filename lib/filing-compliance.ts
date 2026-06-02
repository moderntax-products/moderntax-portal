/**
 * Filing-Compliance Report parser (MOD-228 Phase 5).
 *
 * Parses IRS **Account Transcripts** (any form type — 1040, 1120, 1120S, 1065,
 * 941, etc.) to answer two questions per tax period, WITHOUT income/wage data:
 *   1. Was a return filed?  → TC 150 (return filed & tax assessed) present.
 *   2. Civil penalties assessed?  → TC 160/166/170/176/234/238/240/246/270/276/
 *      280/320/350 with positive amounts.
 *
 * Reuses the same transaction-extraction approach proven in lib/erc-analysis.ts
 * (`parse941Transcript`) but generalized to any form/period. The helpers are
 * inlined here so this module stays self-contained.
 *
 * ⚠️ VALIDATION: the TC-extraction regex + penalty-code set should be validated
 * against a spread of real Account Transcripts (different forms/years) before
 * this is exposed customer-facing. Admin-only for now.
 */

// ── Small parsing helpers (inlined, mirror lib/erc-analysis.ts) ──────────────

function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseUsDate(s: string): string | null {
  const m = s.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`; // YYYY-MM-DD
}

function parseAmount(s: string): number | null {
  const neg = /-/.test(s);
  const n = parseFloat(s.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface FCTransaction {
  code: string;
  explanation: string;
  date: string | null;
  amount: number | null;
}

export interface FCPeriod {
  /** Tax year (derived from the tax-period-ending date). */
  year: number;
  /** Tax-period-ending date as printed (YYYY-MM-DD). */
  periodEnding: string | null;
  formNumber: string | null;
  returnFiled: boolean;
  /** Date the return posted (TC 150), if filed. */
  returnFiledDate: string | null;
  /** Civil-penalty transactions with positive assessed amounts. */
  penalties: FCTransaction[];
  totalPenalties: number;
  accountBalance: number | null;
  source: string;
}

export interface FilingComplianceReport {
  entityName: string;
  tid: string;
  periods: FCPeriod[];
  summary: {
    yearsCovered: number;
    yearsFiled: number;
    yearsUnfiled: number;
    yearsWithPenalties: number;
    totalPenalties: number;
  };
}

// Civil-penalty transaction codes (assessment side). FTF/FTP/FTD + misc.
const PENALTY_CODES = new Set([
  '160', '166', '170', '176', '234', '238', '240', '246',
  '270', '276', '280', '290', '320', '350',
]);
// TC 290 is "additional tax assessed" — only treat as penalty-adjacent when it
// carries a positive amount AND no TC 150 context; we keep it out of the core
// penalty set by default to avoid false positives, but surface it in notes.
PENALTY_CODES.delete('290');

/** Extract every transaction from an account-transcript's TRANSACTIONS block. */
function extractTransactions(text: string): FCTransaction[] {
  const out: FCTransaction[] = [];
  const txStart = text.search(/TRANSACTIONS\s+CODE\s+EXPLANATION/i);
  if (txStart < 0) return out;
  let body = text.slice(txStart);
  const endIdx = body.search(/This Product Contains Sensitive/i);
  if (endIdx > 0) body = body.slice(0, endIdx);

  const tcRegex = /\b(\d{3})\s+([A-Za-z][A-Za-z \-\/()&,]{2,80}?)\s+(?:[\d-]+-\d+-\d+-\d+\s+)?(?:(\d{6})\s+)?(\d{2}-\d{2}-\d{4})\s+(-?\$?-?[\d,]+\.?\d*)/g;
  let m: RegExpExecArray | null;
  while ((m = tcRegex.exec(body)) !== null) {
    const [, code, expl, , dateStr, amtStr] = m;
    if (code === 'COD' || code === 'CODE') continue;
    out.push({
      code,
      explanation: expl.trim(),
      date: parseUsDate(dateStr),
      amount: parseAmount(amtStr),
    });
  }
  return out;
}

/** Parse a single Account Transcript HTML into one period's compliance facts. */
export function parseAccountTranscript(html: string, source = ''): FCPeriod | null {
  const text = stripHtml(html);
  if (!/Account\s+Transcript/i.test(text)) return null;

  const formMatch = text.match(/Form\s+Number:\s*([0-9A-Za-z-]+)/i);
  const periodMatch = text.match(/Report for Tax Period Ending:\s*(\d{2}-\d{2}-\d{4})/i)
    || text.match(/Tax Period Ending:\s*(\d{2}-\d{2}-\d{4})/i);
  const periodEnding = periodMatch ? parseUsDate(periodMatch[1]) : null;
  const year = periodEnding ? Number(periodEnding.slice(0, 4)) : NaN;

  let accountBalance: number | null = null;
  const balIdx = text.search(/Account balance:/i);
  if (balIdx >= 0) {
    const raw = text.slice(balIdx, balIdx + 80).match(/Account balance:\s*(-?\$?[\d,]+\.?\d*)/i);
    accountBalance = raw ? parseAmount(raw[1]) : null;
  }

  const transactions = extractTransactions(text);
  const tc150 = transactions.find((t) => t.code === '150');
  const penalties = transactions.filter((t) => PENALTY_CODES.has(t.code) && (t.amount ?? 0) > 0);
  const totalPenalties = Math.round(penalties.reduce((s, t) => s + (t.amount ?? 0), 0) * 100) / 100;

  if (!periodEnding && !tc150 && transactions.length === 0) return null;

  return {
    year: Number.isFinite(year) ? year : 0,
    periodEnding,
    formNumber: formMatch ? formMatch[1] : null,
    returnFiled: !!tc150,
    returnFiledDate: tc150?.date ?? null,
    penalties,
    totalPenalties,
    accountBalance,
    source,
  };
}

/**
 * Build the full report from an entity's account transcripts. Collapses
 * multiple transcripts for the same year (keeps the richest), and surfaces
 * requested years that have NO transcript on file as "no transcript pulled".
 */
export function buildFilingComplianceReport(
  entityName: string,
  tid: string,
  transcripts: { source: string; html: string }[],
  requestedYears: string[] = [],
): FilingComplianceReport {
  const parsed: FCPeriod[] = [];
  for (const t of transcripts) {
    const p = parseAccountTranscript(t.html, t.source);
    if (p) parsed.push(p);
  }

  // De-dupe by year — prefer the period with the most transactions/penalties.
  const byYear = new Map<number, FCPeriod>();
  for (const p of parsed) {
    const prev = byYear.get(p.year);
    if (!prev || (p.penalties.length + (p.returnFiled ? 1 : 0)) > (prev.penalties.length + (prev.returnFiled ? 1 : 0))) {
      byYear.set(p.year, p);
    }
  }

  // Add requested years with no transcript on file as unfiled-unknown rows.
  for (const yStr of requestedYears) {
    const y = Number(yStr);
    if (Number.isFinite(y) && !byYear.has(y)) {
      byYear.set(y, {
        year: y, periodEnding: null, formNumber: null,
        returnFiled: false, returnFiledDate: null,
        penalties: [], totalPenalties: 0, accountBalance: null,
        source: 'NO_TRANSCRIPT_ON_FILE',
      });
    }
  }

  const periods = Array.from(byYear.values()).sort((a, b) => b.year - a.year);
  const withTranscript = periods.filter((p) => p.source !== 'NO_TRANSCRIPT_ON_FILE');

  return {
    entityName,
    tid,
    periods,
    summary: {
      yearsCovered: periods.length,
      yearsFiled: withTranscript.filter((p) => p.returnFiled).length,
      yearsUnfiled: withTranscript.filter((p) => !p.returnFiled).length,
      yearsWithPenalties: withTranscript.filter((p) => p.totalPenalties > 0).length,
      totalPenalties: Math.round(withTranscript.reduce((s, p) => s + p.totalPenalties, 0) * 100) / 100,
    },
  };
}
