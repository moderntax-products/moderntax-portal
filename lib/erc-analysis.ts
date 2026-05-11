/**
 * Employee Retention Credit (ERC) analysis for 941 Account Transcripts.
 *
 * Built for the TaxTaker POC (May 2026): partners that take ERC-recovery
 * contingency work need to know, per quarter, whether the IRS has
 * actually paid the credit, denied it, has it pending, or never received
 * a claim. This module turns the raw 941 transcript text into a
 * structured per-quarter status grid.
 *
 * ELIGIBILITY WINDOWS (per IRS guidance):
 *   2020: Q2 (from March 13), Q3, Q4
 *   2021: Q1, Q2, Q3 (most businesses); Q4 only for Recovery Startup Businesses
 *
 * FILING DEADLINES (now closed for new claims):
 *   2020 quarters: April 15, 2024 — passed
 *   2021 quarters: April 15, 2025 — passed
 *   2021 Q3/Q4 OBBBA disallowance: claims filed after Jan 31, 2024 won't be paid
 *
 * TRANSACTION CODE INTERPRETATION (the meat of the analysis):
 *   TC 150  Original return filed
 *   TC 290  Additional tax assessed — when positive on an ERC quarter, often
 *           means the IRS REDUCED or REVERSED an ERC claim. When zero alongside
 *           TC 971/977, often just a placeholder for the amendment hitting the
 *           system.
 *   TC 291  Reduced or removed prior tax — IRS accepting an ERC adjustment in
 *           the taxpayer's favor (the assessed tax goes down).
 *   TC 470  Claim pending review
 *   TC 740  Refund check returned undelivered — money was approved but the
 *           check came back. Taxpayer needs to update IRS address.
 *   TC 766  Credit to account — the actual ERC credit posting (negative
 *           amount = credit to taxpayer).
 *   TC 767  Credit reversed
 *   TC 776  Interest credited to taxpayer (negative = credit)
 *   TC 777  Interest reversed
 *   TC 846  REFUND ISSUED — the IRS cut a check. Positive amount = $$ paid.
 *   TC 960  Appointed representative — just a Power of Attorney / 8821
 *           record entry, not a money event.
 *   TC 971  Notice issued / pending action. Includes Letter 105-C
 *           (disallowance) when accompanied by certain action codes.
 *   TC 976  Duplicate / amended return filed (often the 941-X arriving)
 *   TC 977  Amended return filed
 *
 * STATUS MAPPING per quarter (priority order — first match wins):
 *   1. TC 846 with TC 740 (returned)  → 'refund_returned_undelivered'  ($$ owed!)
 *   2. TC 846 without TC 740           → 'refund_paid'                 ($$ paid)
 *   3. TC 470 present, no TC 846       → 'claim_pending_irs_review'    (waiting)
 *   4. TC 290 positive (post-TC 971/977) without TC 766 → 'claim_denied_or_reduced'
 *   5. TC 971 / 976 / 977 present without subsequent activity → 'amendment_received_no_action'
 *   6. No TC 971/976/977/766/846 at all → 'no_claim_filed'
 *   7. Otherwise → 'unknown' (admin review)
 */

export interface ParsedTransaction {
  code: string;          // e.g. '846'
  explanation: string;   // e.g. 'Refund issued'
  date: string | null;   // ISO date string, e.g. '2022-08-29'
  cycle: string | null;  // IRS cycle code (e.g. '202142'), if present
  amount: number | null; // dollar amount; negative = credit to taxpayer
}

export interface ParsedQuarter {
  year: number;             // e.g. 2021
  quarter: 1 | 2 | 3 | 4;   // e.g. 3
  taxPeriodEnding: string;  // 'YYYY-MM-DD'
  trackingId: string | null;
  taxpayerTin: string | null;   // masked, last 4 digits
  taxpayerName: string | null;
  totalTaxPerTaxpayer: number | null;
  accountBalance: number | null; // negative = credit balance owed to taxpayer
  returnFiled: boolean;
  transactions: ParsedTransaction[];
}

export type ERCStatus =
  | 'refund_returned_undelivered'  // PAID but check came back — taxpayer action needed
  | 'refund_paid'                  // $$ in the bank
  | 'claim_pending_irs_review'     // wait
  | 'claim_denied_or_reduced'      // appeal opportunity
  | 'amendment_received_no_action' // 941-X arrived but no IRS activity yet
  | 'no_claim_filed'               // never claimed
  | 'unknown';                     // admin review

export interface ERCQuarter {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  taxPeriodEnding: string;
  eligible: boolean;          // 2020 Q2-Q4 + 2021 Q1-Q3 = eligible by default
  eligibilityNote?: string;   // e.g. "Q4 2021 only eligible for Recovery Startup Businesses"
  filingDeadline: string;     // ISO date
  deadlinePassed: boolean;
  status: ERCStatus;
  ercCreditAmount: number | null;  // from TC 766 (credit to account)
  refundIssuedAmount: number | null; // from TC 846
  refundIssuedDate: string | null;
  refundReturnedDate: string | null;
  interestAmount: number | null;     // from TC 776
  currentAccountBalance: number | null; // negative = $$ owed to taxpayer
  totalRecoverable: number;   // best estimate of money still claimable
  actionRequired: string | null; // human-readable next step
  notes: string[];            // free-form observations
  raw: ParsedQuarter | null;  // source transcript (null if quarter wasn't pulled)
}

export interface ERCReport {
  entityName: string;
  tin: string | null;
  quarters: ERCQuarter[];
  summary: {
    totalRecoverable: number;
    quartersPaid: number;
    quartersPending: number;
    quartersDenied: number;
    quartersNoClaim: number;
    quartersUndelivered: number;
    quartersMissingTranscript: number;
    actionRequiredCount: number;
  };
  missingQuarters: { year: number; quarter: number }[];
}

// ---------------------------------------------------------------------------
// Eligibility + deadline rules
// ---------------------------------------------------------------------------

const ALL_ELIGIBLE_PERIODS: Array<{ year: number; quarter: 1 | 2 | 3 | 4; note?: string }> = [
  { year: 2020, quarter: 2 },
  { year: 2020, quarter: 3 },
  { year: 2020, quarter: 4 },
  { year: 2021, quarter: 1 },
  { year: 2021, quarter: 2 },
  { year: 2021, quarter: 3 },
  { year: 2021, quarter: 4, note: 'Q4 2021 eligible only for Recovery Startup Businesses (RSBs). All other businesses are NOT eligible for Q4 2021.' },
];

function filingDeadlineFor(year: number, _quarter: number): string {
  // 2020 quarters: April 15, 2024
  // 2021 quarters: April 15, 2025
  // (OBBBA further restricts Q3/Q4 2021 to Jan 31, 2024 — handled separately
  // in the deadline note if relevant)
  if (year === 2020) return '2024-04-15';
  if (year === 2021) return '2025-04-15';
  return '';
}

function taxPeriodEnding(year: number, quarter: 1 | 2 | 3 | 4): string {
  const monthDay = { 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' };
  return `${year}-${monthDay[quarter]}`;
}

function quarterFromTaxPeriodEnding(iso: string): { year: number; quarter: 1 | 2 | 3 | 4 } | null {
  const m = iso.match(/^(\d{4})-(\d{2})-/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const quarter = month === 3 ? 1 : month === 6 ? 2 : month === 9 ? 3 : month === 12 ? 4 : null;
  if (!quarter) return null;
  return { year, quarter: quarter as 1 | 2 | 3 | 4 };
}

// ---------------------------------------------------------------------------
// Transcript parsing — works against the IRS Account Transcript HTML or its
// stripped-text form. The IRS layout is dense but consistent across 941
// quarters.
// ---------------------------------------------------------------------------

/**
 * Strip HTML, normalize whitespace, return a flat text string suitable
 * for the regexes below. Robust to the IRS's <style> tag block at the
 * top of every transcript.
 */
function stripHtml(input: string): string {
  // Drop <style>…</style> entirely
  let s = input.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
  // Drop any other tags
  s = s.replace(/<[^>]+>/g, ' ');
  // Normalize whitespace + entities
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function parseAmount(s: string): number | null {
  // Strip $, commas; allow leading minus
  const m = s.match(/^-?\$?-?[\d,]+\.?\d*$/);
  if (!m) return null;
  const cleaned = s.replace(/[$,]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseUsDate(s: string): string | null {
  // 'MM-DD-YYYY' or 'MM/DD/YYYY'
  const m = s.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

/**
 * Parse a single 941 Account Transcript HTML/text into a ParsedQuarter.
 * Returns null if the text doesn't look like a 941 transcript.
 */
export function parse941Transcript(input: string): ParsedQuarter | null {
  const text = stripHtml(input);

  // Required: "Form 941 Account Transcript" or "Form Number: 941"
  if (!/Form\s+Number:\s*941/i.test(text) && !/Form\s+941\s+Account\s+Transcript/i.test(text)) {
    return null;
  }

  // Tax period ending — drives quarter mapping
  const periodMatch = text.match(/Report for Tax Period Ending:\s*(\d{2}-\d{2}-\d{4})/i);
  const taxPeriodEnding = periodMatch ? parseUsDate(periodMatch[1]) : null;
  if (!taxPeriodEnding) return null;
  const yq = quarterFromTaxPeriodEnding(taxPeriodEnding);
  if (!yq) return null;

  const trackingMatch = text.match(/Tracking Number:\s*(\d+)/i);
  const tinMatch = text.match(/Taxpayer Identification Number:\s*([X\-\d]+)/i);
  // Taxpayer name appears after the TIN, before the address block.
  // Heuristic: the next chunk of uppercase characters after the masked TIN.
  const nameMatch = text.match(/Taxpayer Identification Number:\s*[X\-\d]+\s+([A-Z][A-Z \-&%]{2,40})/);
  const taxpayerName = nameMatch ? nameMatch[1].trim().replace(/\s+%$/, '').trim() : null;

  const totalTaxMatch = text.match(/Total Tax per Taxpayer\s*\$?([-\d,]+\.?\d*)/i);
  const totalTax = totalTaxMatch ? parseAmount('$' + totalTaxMatch[1]) : null;

  const balanceMatch = text.match(/Account balance:\s*-?\$?([-\d,]+\.?\d*)/i);
  // The transcript prints negative balances as "-$31,700.00" — preserve sign.
  let accountBalance: number | null = null;
  if (balanceMatch) {
    const idx = text.search(/Account balance:/i);
    const raw = text.slice(idx, idx + 80).match(/Account balance:\s*(-?\$?[\d,]+\.?\d*)/i);
    accountBalance = raw ? parseAmount(raw[1]) : null;
  }

  // Transaction codes — the IRS lays them out in a tabular form:
  //   <code> <explanation> [<cycle>] <date MM-DD-YYYY> <amount>
  // After stripping HTML they become a long single line. Use a regex
  // that anchors on the 3-digit TC at the start and captures forward
  // until the next 3-digit TC or end-of-section.
  const transactions: ParsedTransaction[] = [];
  // Find the TRANSACTIONS section
  const txStart = text.search(/TRANSACTIONS\s+CODE\s+EXPLANATION/i);
  if (txStart >= 0) {
    let body = text.slice(txStart);
    // End at the trailing "This Product Contains Sensitive Taxpayer Data"
    const endIdx = body.search(/This Product Contains Sensitive/i);
    if (endIdx > 0) body = body.slice(0, endIdx);

    // Walk through TC entries. Each TC is a 3-digit code at a word boundary
    // followed by an explanation (multiple words) followed (optionally) by a
    // cycle code (6 digits), a date, and an amount.
    const tcRegex = /\b(\d{3})\s+([A-Za-z][A-Za-z \-\/()&,]{2,80}?)\s+(?:[\d-]+-\d+-\d+-\d+\s+)?(?:(\d{6})\s+)?(\d{2}-\d{2}-\d{4})\s+(-?\$?-?[\d,]+\.?\d*)/g;
    let m: RegExpExecArray | null;
    while ((m = tcRegex.exec(body)) !== null) {
      const [, code, expl, cycle, dateStr, amtStr] = m;
      // Skip the header row which can look like a TC match
      if (code === 'COD' || code === 'CODE') continue;
      transactions.push({
        code,
        explanation: expl.trim(),
        cycle: cycle || null,
        date: parseUsDate(dateStr),
        amount: parseAmount(amtStr.replace(/^-?\$/, m1 => (m1.startsWith('-') ? '-' : ''))) ?? (() => {
          // Defensive: handle " -$32,967.45 " shape
          const a = amtStr.replace(/\$/g, '');
          const n = parseFloat(a.replace(/,/g, ''));
          return Number.isFinite(n) ? n : null;
        })(),
      });
    }
  }

  return {
    year: yq.year,
    quarter: yq.quarter,
    taxPeriodEnding,
    trackingId: trackingMatch ? trackingMatch[1] : null,
    taxpayerTin: tinMatch ? tinMatch[1] : null,
    taxpayerName,
    totalTaxPerTaxpayer: totalTax,
    accountBalance,
    returnFiled: transactions.some(t => t.code === '150'),
    transactions,
  };
}

// ---------------------------------------------------------------------------
// Status determination — turn a ParsedQuarter into an ERCQuarter
// ---------------------------------------------------------------------------

function determineERCStatus(parsed: ParsedQuarter): {
  status: ERCStatus;
  ercCredit: number | null;
  refundIssued: number | null;
  refundDate: string | null;
  refundReturnedDate: string | null;
  interest: number | null;
  totalRecoverable: number;
  actionRequired: string | null;
  notes: string[];
} {
  const tx = parsed.transactions;
  const has = (code: string) => tx.some(t => t.code === code);
  const find = (code: string) => tx.find(t => t.code === code);
  const findAll = (code: string) => tx.filter(t => t.code === code);
  const notes: string[] = [];

  const tc766 = findAll('766').reduce((s, t) => s + (t.amount || 0), 0);  // sum of credits to account
  const tc846 = find('846');
  const tc740 = find('740');
  const tc776 = findAll('776').reduce((s, t) => s + (t.amount || 0), 0);  // interest credited
  const tc290PositiveCount = findAll('290').filter(t => (t.amount || 0) > 0).length;
  const tc971 = has('971');
  const tc976 = has('976');
  const tc977 = has('977');
  const tc470 = has('470');
  const tc960 = has('960');

  if (tc960) {
    notes.push('TC 960 present — a Power of Attorney / 8821 is on record at the IRS.');
  }

  // 1. Refund issued AND returned undelivered → money is owed but stuck
  if (tc846 && tc740) {
    const refundAmt = tc846.amount || 0;
    const returnedAmt = Math.abs(tc740.amount || 0);
    const matches = Math.abs(refundAmt - returnedAmt) < 0.01;
    notes.push(`Refund of $${refundAmt.toFixed(2)} was issued on ${tc846.date || '(date unknown)'} but TC 740 shows the check was returned undelivered on ${tc740.date || '(date unknown)'}.`);
    if (matches) notes.push('The returned amount matches the refund amount exactly — the entire check came back, not a partial.');
    return {
      status: 'refund_returned_undelivered',
      ercCredit: tc766 || null,
      refundIssued: refundAmt,
      refundDate: tc846.date,
      refundReturnedDate: tc740.date,
      interest: tc776 || null,
      totalRecoverable: refundAmt,
      actionRequired: 'Update mailing address with IRS (Form 8822-B for business). Once updated, the IRS will reissue the check. May also call PPS and request reissue once address is updated.',
      notes,
    };
  }

  // 2. Refund issued, not returned → money is paid
  if (tc846 && !tc740) {
    const refundAmt = tc846.amount || 0;
    return {
      status: 'refund_paid',
      ercCredit: tc766 || null,
      refundIssued: refundAmt,
      refundDate: tc846.date,
      refundReturnedDate: null,
      interest: tc776 || null,
      totalRecoverable: 0,
      actionRequired: null,
      notes: [`Refund of $${refundAmt.toFixed(2)} was issued on ${tc846.date}. Should be in client's account.`],
    };
  }

  // 3. Claim pending review
  if (tc470 && !tc846) {
    return {
      status: 'claim_pending_irs_review',
      ercCredit: tc766 || null,
      refundIssued: null,
      refundDate: null,
      refundReturnedDate: null,
      interest: null,
      totalRecoverable: Math.abs(parsed.accountBalance || 0),
      actionRequired: 'Wait for IRS review to complete. The IRS may request additional documentation; respond promptly if so. Approx 41K claims remain under examination as of early 2026.',
      notes: ['TC 470 indicates the claim is pending IRS review.'],
    };
  }

  // 4. Claim denied/reduced (TC 290 with positive amount, no offsetting TC 766)
  if (tc290PositiveCount > 0 && !tc846 && tc766 >= 0) {
    return {
      status: 'claim_denied_or_reduced',
      ercCredit: null,
      refundIssued: null,
      refundDate: null,
      refundReturnedDate: null,
      interest: null,
      totalRecoverable: 0,
      actionRequired: 'Check for IRS Letter 105-C (disallowance notice) in client mail. If received, evaluate appeal — must be filed within 2 years of disallowance. If not received, request transcripts of notices issued.',
      notes: ['TC 290 with positive amount and no TC 766 credit — claim was likely denied or significantly reduced.'],
    };
  }

  // 5. Amendment received but no IRS action yet (claim filed, processing)
  if (tc971 || tc976 || tc977) {
    return {
      status: 'amendment_received_no_action',
      ercCredit: tc766 || null,
      refundIssued: null,
      refundDate: null,
      refundReturnedDate: null,
      interest: null,
      totalRecoverable: Math.abs(parsed.accountBalance || 0),
      actionRequired: 'Amendment received by IRS but no refund decision yet. Average processing is 4-8 months but has stretched to 12-18 months for ERC claims. Monitor monthly.',
      notes: ['TC 971/976/977 indicates the 941-X (amendment) was received by the IRS, but no refund or denial transaction has been posted yet.'],
    };
  }

  // 6. No claim filed
  if (!tc971 && !tc976 && !tc977 && !tc766 && !tc846) {
    return {
      status: 'no_claim_filed',
      ercCredit: null,
      refundIssued: null,
      refundDate: null,
      refundReturnedDate: null,
      interest: null,
      totalRecoverable: 0,
      actionRequired: null,
      notes: ['No TC 971/976/977 (amendment receipt) or TC 766/846 (credit / refund) on this transcript — appears no ERC claim was ever filed for this quarter.'],
    };
  }

  // 7. Unknown — admin review
  return {
    status: 'unknown',
    ercCredit: tc766 || null,
    refundIssued: null,
    refundDate: null,
    refundReturnedDate: null,
    interest: null,
    totalRecoverable: 0,
    actionRequired: 'Admin review — transaction codes do not fit a standard pattern.',
    notes,
  };
}

// ---------------------------------------------------------------------------
// Public API — build a full ERC report from a set of transcripts
// ---------------------------------------------------------------------------

export function buildERCReport(
  entityName: string,
  tin: string | null,
  transcripts: { source: string; html: string }[],
): ERCReport {
  // Parse each transcript and key by year+quarter
  const parsedByKey = new Map<string, ParsedQuarter>();
  for (const t of transcripts) {
    const p = parse941Transcript(t.html);
    if (p) {
      const k = `${p.year}-Q${p.quarter}`;
      parsedByKey.set(k, p);
    }
  }

  const quarters: ERCQuarter[] = [];
  for (const period of ALL_ELIGIBLE_PERIODS) {
    const key = `${period.year}-Q${period.quarter}`;
    const parsed = parsedByKey.get(key) || null;
    const deadline = filingDeadlineFor(period.year, period.quarter);
    const today = new Date().toISOString().split('T')[0];

    let status: ERCStatus;
    let ercCredit: number | null = null;
    let refundIssued: number | null = null;
    let refundDate: string | null = null;
    let refundReturnedDate: string | null = null;
    let interest: number | null = null;
    let totalRecoverable = 0;
    let actionRequired: string | null = null;
    let notes: string[] = [];
    let currentAccountBalance: number | null = null;

    if (parsed) {
      const d = determineERCStatus(parsed);
      status = d.status;
      ercCredit = d.ercCredit;
      refundIssued = d.refundIssued;
      refundDate = d.refundDate;
      refundReturnedDate = d.refundReturnedDate;
      interest = d.interest;
      totalRecoverable = d.totalRecoverable;
      actionRequired = d.actionRequired;
      notes = d.notes;
      currentAccountBalance = parsed.accountBalance;
    } else {
      status = 'unknown';
      notes = ['Transcript for this quarter was not included in the request. Pull the 941 Account Transcript for this period to see its actual status.'];
    }

    quarters.push({
      year: period.year,
      quarter: period.quarter,
      taxPeriodEnding: taxPeriodEnding(period.year, period.quarter),
      eligible: true,
      eligibilityNote: period.note,
      filingDeadline: deadline,
      deadlinePassed: deadline ? deadline < today : false,
      status,
      ercCreditAmount: ercCredit,
      refundIssuedAmount: refundIssued,
      refundIssuedDate: refundDate,
      refundReturnedDate,
      interestAmount: interest,
      currentAccountBalance,
      totalRecoverable,
      actionRequired,
      notes,
      raw: parsed,
    });
  }

  const missingQuarters = quarters
    .filter(q => q.raw === null)
    .map(q => ({ year: q.year, quarter: q.quarter }));

  const summary = {
    totalRecoverable: quarters.reduce((s, q) => s + q.totalRecoverable, 0),
    quartersPaid: quarters.filter(q => q.status === 'refund_paid').length,
    quartersPending: quarters.filter(q => q.status === 'claim_pending_irs_review' || q.status === 'amendment_received_no_action').length,
    quartersDenied: quarters.filter(q => q.status === 'claim_denied_or_reduced').length,
    quartersNoClaim: quarters.filter(q => q.status === 'no_claim_filed').length,
    quartersUndelivered: quarters.filter(q => q.status === 'refund_returned_undelivered').length,
    quartersMissingTranscript: missingQuarters.length,
    actionRequiredCount: quarters.filter(q => q.actionRequired !== null).length,
  };

  return { entityName, tin, quarters, summary, missingQuarters };
}

// ---------------------------------------------------------------------------
// Human-readable label for an ERCStatus — used by the admin view and any
// other surface that needs to display the status.
// ---------------------------------------------------------------------------
export function ercStatusLabel(s: ERCStatus): string {
  switch (s) {
    case 'refund_returned_undelivered': return 'Refund returned undelivered';
    case 'refund_paid':                  return 'Refund paid';
    case 'claim_pending_irs_review':     return 'Claim pending IRS review';
    case 'claim_denied_or_reduced':      return 'Claim denied or reduced';
    case 'amendment_received_no_action': return 'Amendment received, no action yet';
    case 'no_claim_filed':               return 'No claim filed';
    case 'unknown':                      return 'Unknown / transcript missing';
  }
}
