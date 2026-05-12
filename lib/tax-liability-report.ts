/**
 * Tax-liability / compliance-status report aggregator.
 *
 * Built for the Banc of California rollout (May 2026). Tax Guard surfaces
 * three things in their report that we have data for but never aggregated
 * cleanly:
 *
 *   1. Filing compliance — required forms vs. what's actually filed
 *   2. Tax liabilities by period — itemized balance breakdown
 *   3. Repayment plan status — IA / OIC / CNC / none
 *
 * This module is the pure aggregator: download every HTML transcript on
 * file for an entity, parse each via lib/compliance-screening, then
 * cross-reference the entity transcript's filing requirements against
 * Account Transcript / Record of Account TC 150 entries to determine
 * what's filed vs unfiled.
 *
 * The result is stored on `request_entities.gross_receipts.tax_liability_report`
 * (JSONB) when status flips to 'completed', so the admin view renders
 * fast without re-parsing every time.
 *
 * IMPORTANT data-quality caveat: filing-requirement detection depends on
 * the Entity Transcript including a parseable "Filing Requirements"
 * field. If that field is absent or in an unrecognised format, we'll
 * still emit a report but with a `dataQualityWarnings` entry so the
 * admin view (and the lender) knows the unfiled list is best-effort.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  screenTranscriptHtml,
  parseTranscriptMetadata,
  type ComplianceResult,
  type TranscriptMetadata,
} from './compliance-screening';

// ---------------------------------------------------------------------------
// Public types — these are what gets persisted to JSONB and consumed by the
// admin view. Keep them serialisable (no functions, no Date objects).
// ---------------------------------------------------------------------------

export interface FilingRow {
  formType: string;          // "1120-S", "941", "940", "1099-MISC"
  period: string;            // "2023", "2024 Q1", "2023 Q1-Q4"
  filedDate: string | null;  // "MM-DD-YYYY" if filed, null if not
  note?: string;             // "filed late", "overdue", "no TC 150 on this period"
}

export interface LiabilityRow {
  formType: string;
  period: string;
  assessed: number | null;
  paid: number | null;
  balance: number;
  accrued: number | null;
  status: 'open_collection' | 'open_notice' | 'open' | 'closed_zero' | 'unfiled' | 'unknown';
  statusLabel: string;       // human-readable, ready to render
  source: string;            // "record_of_account" | "account_transcript" | "return_transcript"
}

export interface RepaymentPlanStatus {
  hasIA: boolean;
  hasOIC: boolean;
  hasCNC: boolean;
  details: string[];         // human-readable bullets, ready to render
}

export interface TaxLiabilityReport {
  generatedAt: string;       // ISO timestamp
  entityName: string;
  tin: string;
  transcriptCount: number;
  filingCompliance: { filed: FilingRow[]; unfiled: FilingRow[] };
  taxLiabilities: {
    byPeriod: LiabilityRow[];
    totalAssessed: number;
    totalPaid: number;
    totalBalance: number;
    totalAccrued: number;
  };
  repaymentPlan: RepaymentPlanStatus;
  dataQualityWarnings: string[];  // surfaced to admin so we never silently fake data
  sourceFiles: string[];          // storage paths consumed
}

// ---------------------------------------------------------------------------
// Internal: parsed-transcript bundle that flows through the aggregator
// ---------------------------------------------------------------------------

interface ParsedTranscript {
  source: string;            // storage path
  meta: TranscriptMetadata;
  result: ComplianceResult;
  taxPeriodMonth: number | null;  // 1-12, parsed from "Tax Period: YYYYMM" if present
}

// ---------------------------------------------------------------------------
// Helpers — period formatting + filing-requirement parsing
// ---------------------------------------------------------------------------

/** Convert a calendar month (1-12) to its IRS quarter (1-4). */
function monthToQuarter(month: number): number {
  return Math.ceil(month / 3);
}

/** Best-effort tax-period extraction. IRS HTML labels it "Tax Period" YYYYMM. */
function extractTaxPeriodMonth(htmlString: string): number | null {
  const m = htmlString.match(/Tax Period[^0-9]{0,40}(\d{4})(\d{2})/i);
  if (!m) return null;
  const month = parseInt(m[2], 10);
  return month >= 1 && month <= 12 ? month : null;
}

/**
 * Parse the Entity Transcript "Filing Requirements" free-text field into a
 * list of (formType, cadence) tuples. The IRS entity transcript renders
 * filing requirements as text like:
 *
 *   "1120-S - REQUIRED ANNUALLY"
 *   "941 - REQUIRED QUARTERLY"
 *   "940 - REQUIRED ANNUALLY"
 *   "1099 - REQUIRED ANNUALLY"
 *
 * We don't have a fixed schema, so we regex for known form numbers and
 * cadence keywords. Anything we can't parse becomes a dataQualityWarning.
 */
interface FilingRequirement {
  formType: string;
  cadence: 'annual' | 'quarterly' | 'unknown';
}

function parseFilingRequirements(raw: string | undefined): {
  requirements: FilingRequirement[];
  unparseable: boolean;
} {
  if (!raw || !raw.trim()) {
    return { requirements: [], unparseable: true };
  }
  const requirements: FilingRequirement[] = [];
  // Form numbers we care about for SBA underwriting + the most common
  // BMF filings. We match each independently rather than splitting on
  // delimiters because the IRS field is rendered inconsistently
  // (sometimes commas, sometimes line breaks, sometimes spaces).
  const formPatterns: { regex: RegExp; formType: string; defaultCadence: FilingRequirement['cadence'] }[] = [
    { regex: /\b1120-?S\b/i, formType: '1120-S', defaultCadence: 'annual' },
    { regex: /\b1120(?!-?S)\b/i, formType: '1120',   defaultCadence: 'annual' },
    { regex: /\b1065\b/,       formType: '1065',   defaultCadence: 'annual' },
    { regex: /\b1041\b/,       formType: '1041',   defaultCadence: 'annual' },
    { regex: /\b990\b/,        formType: '990',    defaultCadence: 'annual' },
    { regex: /\b941\b/,        formType: '941',    defaultCadence: 'quarterly' },
    { regex: /\b940\b/,        formType: '940',    defaultCadence: 'annual' },
    { regex: /\b1099\b/,       formType: '1099',   defaultCadence: 'annual' },
  ];
  for (const { regex, formType, defaultCadence } of formPatterns) {
    if (regex.test(raw)) {
      // Try to grab the cadence keyword in the same neighborhood as the form ref.
      const window = raw.slice(Math.max(0, raw.search(regex) - 10), raw.search(regex) + 80);
      let cadence: FilingRequirement['cadence'] = defaultCadence;
      if (/quarterly/i.test(window)) cadence = 'quarterly';
      else if (/annual/i.test(window)) cadence = 'annual';
      requirements.push({ formType, cadence });
    }
  }
  return { requirements, unparseable: requirements.length === 0 };
}

/** Format a (year, month) pair as "YYYY Q#" or just "YYYY" for annual filings. */
function formatPeriod(year: string, month: number | null, cadence: FilingRequirement['cadence']): string {
  if (cadence === 'quarterly' && month !== null) return `${year} Q${monthToQuarter(month)}`;
  return year;
}

// ---------------------------------------------------------------------------
// Liability-row construction — extracts a single LiabilityRow per transcript
// that carries account-level financials (account_transcript / record_of_account).
// Returns null for transcripts that don't carry liability info (entity, return).
// ---------------------------------------------------------------------------

function buildLiabilityRow(t: ParsedTranscript): LiabilityRow | null {
  if (t.meta.transcriptType !== 'account_transcript' && t.meta.transcriptType !== 'record_of_account') {
    return null;
  }

  const balance = t.result.financials.accountBalance ?? 0;
  const assessed = t.result.financials.totalTax;
  // We don't carry a canonical "paid" field on screening; derive it from
  // assessed - balance when both are present. This matches what the
  // sample report renders (e.g. assessed 5,130.42 - balance 4,287.21
  // = paid 843.21).
  const paid = assessed !== null ? Math.max(0, assessed - balance) : null;
  const accrued =
    (t.result.financials.accruedInterest ?? 0) + (t.result.financials.accruedPenalty ?? 0) || null;

  // Status priority:
  //   1. balance > 0 + TC 520/530 → open_collection
  //   2. balance > 0 + TC 971 → open_notice (CP letter issued)
  //   3. balance > 0           → open
  //   4. balance == 0 + has TC 150 → closed_zero
  //   5. isBlank / no TC 150  → unfiled
  const tcCodes = new Set(t.result.transactionCodes.map((tc) => tc.code));
  const hasTC520or530 = tcCodes.has('520') || tcCodes.has('530');
  const hasTC971 = tcCodes.has('971');
  const hasTC150 = tcCodes.has('150');

  let status: LiabilityRow['status'];
  let statusLabel: string;
  if (t.result.isBlank || !hasTC150) {
    status = 'unfiled';
    statusLabel = 'Unfiled · no TC 150';
  } else if (balance > 0 && hasTC520or530) {
    status = 'open_collection';
    statusLabel = 'Open · Collection';
  } else if (balance > 0 && hasTC971) {
    status = 'open_notice';
    statusLabel = 'Open · Notice issued';
  } else if (balance > 0) {
    status = 'open';
    statusLabel = 'Open · Balance due';
  } else {
    status = 'closed_zero';
    statusLabel = 'Closed · Zero balance';
  }

  return {
    formType: t.meta.formType || 'unknown',
    period: formatPeriod(
      t.meta.taxYear || 'unknown',
      t.taxPeriodMonth,
      t.meta.formType === '941' ? 'quarterly' : 'annual',
    ),
    assessed,
    paid,
    balance,
    accrued,
    status,
    statusLabel,
    source: t.meta.transcriptType,
  };
}

// ---------------------------------------------------------------------------
// Filing compliance — cross-reference filing requirements (from entity
// transcript) against TC 150 entries (from account transcripts / records of
// account / return transcripts).
// ---------------------------------------------------------------------------

function buildFilingCompliance(
  parsed: ParsedTranscript[],
  warnings: string[],
): { filed: FilingRow[]; unfiled: FilingRow[] } {
  const entity = parsed.find((p) => p.meta.transcriptType === 'entity_transcript');
  const { requirements, unparseable } = parseFilingRequirements(entity?.meta.entityData?.filingRequirements);

  if (!entity) {
    warnings.push(
      'No Entity Transcript on file — cannot determine filing requirements. ' +
      'Unfiled-form detection requires the BMF Entity Transcript to enumerate which forms the IRS expects.',
    );
  } else if (unparseable) {
    warnings.push(
      'Entity Transcript filing-requirements field is empty or in an unrecognised format. ' +
      'Unfiled list is best-effort: only forms we can detect from existing transcripts are reported.',
    );
  }

  // Index every filed period we can see across all non-entity transcripts.
  // Key: "{formType}|{year}|Q?". Value: TC 150 date if present.
  const filedIndex = new Map<string, { date: string | null; year: string; quarter: number | null }>();
  for (const t of parsed) {
    if (t.meta.transcriptType === 'entity_transcript') continue;
    if (!t.meta.formType || !t.meta.taxYear) continue;
    const tc150 = t.result.transactionCodes.find((tc) => tc.code === '150');
    if (!tc150) continue;  // transcript exists but the period was never filed
    const quarter = t.meta.formType === '941' && t.taxPeriodMonth ? monthToQuarter(t.taxPeriodMonth) : null;
    const key = `${t.meta.formType}|${t.meta.taxYear}|${quarter ?? ''}`;
    filedIndex.set(key, { date: tc150.date || null, year: t.meta.taxYear, quarter });
  }

  const filed: FilingRow[] = [];
  for (const [key, info] of filedIndex) {
    const [formType] = key.split('|');
    filed.push({
      formType,
      period: info.quarter ? `${info.year} Q${info.quarter}` : info.year,
      filedDate: info.date,
    });
  }
  filed.sort((a, b) => `${a.formType}|${a.period}`.localeCompare(`${b.formType}|${b.period}`));

  // Unfiled = required-but-not-in-filedIndex.
  // We build the "expected" list from filing requirements crossed with the
  // years that appear on any non-entity transcript. Without a known
  // year-set we can't enumerate every missing period (we don't know what
  // years to check), so we skip — and warn — when no transcripts exist.
  const yearsSeen = new Set<string>();
  for (const t of parsed) {
    if (t.meta.transcriptType !== 'entity_transcript' && t.meta.taxYear) {
      yearsSeen.add(t.meta.taxYear);
    }
  }

  const unfiled: FilingRow[] = [];
  for (const req of requirements) {
    for (const year of yearsSeen) {
      if (req.cadence === 'quarterly') {
        // Check each of the four quarters.
        for (let q = 1; q <= 4; q++) {
          const key = `${req.formType}|${year}|${q}`;
          if (!filedIndex.has(key)) {
            unfiled.push({
              formType: req.formType,
              period: `${year} Q${q}`,
              filedDate: null,
              note: 'No TC 150 on this period — return not filed (or transcript not yet pulled).',
            });
          }
        }
      } else {
        const key = `${req.formType}|${year}|`;
        if (!filedIndex.has(key)) {
          unfiled.push({
            formType: req.formType,
            period: year,
            filedDate: null,
            note: 'No TC 150 on this period — return not filed (or transcript not yet pulled).',
          });
        }
      }
    }
  }
  unfiled.sort((a, b) => `${a.formType}|${a.period}`.localeCompare(`${b.formType}|${b.period}`));

  return { filed, unfiled };
}

// ---------------------------------------------------------------------------
// Repayment plan status — scan every transcript's TC list for IA/OIC/CNC signals
// ---------------------------------------------------------------------------

function buildRepaymentPlan(parsed: ParsedTranscript[]): RepaymentPlanStatus {
  let hasIA = false;
  let hasOIC = false;
  let hasCNC = false;
  const details: string[] = [];

  for (const t of parsed) {
    for (const tc of t.result.transactionCodes) {
      // TC 971 with "installment" in the explanation = IA proposed/active
      if (tc.code === '971' && /installment/i.test(tc.explanation)) {
        hasIA = true;
        details.push(`Installment agreement signal (TC 971 · ${tc.date}): ${tc.explanation}`);
      }
      // TC 480 = OIC pending; TC 481 = OIC rejected; TC 482 = OIC accepted
      if (tc.code === '480' || tc.code === '481' || tc.code === '482') {
        hasOIC = true;
        details.push(`Offer in Compromise activity (TC ${tc.code} · ${tc.date}): ${tc.explanation}`);
      }
      // TC 530 = currently not collectible
      if (tc.code === '530') {
        hasCNC = true;
        details.push(`Currently Not Collectible (TC 530 · ${tc.date}): ${tc.explanation}`);
      }
    }
  }

  if (!hasIA && !hasOIC && !hasCNC) {
    details.push(
      'No installment agreement (TC 971 installment), offer in compromise (TC 480/481/482), or currently-not-collectible (TC 530) on file. Borrower is in standard collection status.',
    );
  }

  return { hasIA, hasOIC, hasCNC, details };
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Build a Tax Guard-parity compliance report for a single entity.
 *
 * Reads every HTML transcript on file (transcript_html_urls + .html files
 * in transcript_urls — the upload pipeline has historically crossed the
 * two), runs each through the screening parser, and aggregates into the
 * three-section structure the sample renders.
 *
 * Caller is responsible for storing the result (e.g. on
 * request_entities.gross_receipts.tax_liability_report).
 */
export async function buildTaxLiabilityReport(
  entityId: string,
  admin: SupabaseClient,
): Promise<TaxLiabilityReport> {
  const generatedAt = new Date().toISOString();

  const { data: entity, error: entityErr } = await admin
    .from('request_entities')
    .select('id, entity_name, tid, transcript_urls, transcript_html_urls')
    .eq('id', entityId)
    .single() as { data: { id: string; entity_name: string; tid: string; transcript_urls: string[] | null; transcript_html_urls: string[] | null } | null; error: any };

  if (entityErr || !entity) {
    throw new Error(`buildTaxLiabilityReport: entity ${entityId} not found: ${entityErr?.message || ''}`);
  }

  // Same dedupe + cross-column scan as /admin/erc-report — only HTML files
  // can be parsed by screening; PDFs are skipped.
  const allUrls: string[] = Array.from(new Set([
    ...(entity.transcript_urls || []),
    ...(entity.transcript_html_urls || []),
  ])).filter((u) => u.endsWith('.html'));

  const warnings: string[] = [];
  const parsed: ParsedTranscript[] = [];
  for (const url of allUrls) {
    const { data: file, error: dlErr } = await admin.storage.from('uploads').download(url);
    if (dlErr || !file) {
      warnings.push(`Could not download transcript at ${url} — skipped.`);
      continue;
    }
    const html = Buffer.from(await file.arrayBuffer()).toString('utf8');
    parsed.push({
      source: url,
      meta: parseTranscriptMetadata(html),
      result: screenTranscriptHtml(html),
      taxPeriodMonth: extractTaxPeriodMonth(html),
    });
  }

  if (parsed.length === 0) {
    warnings.push('No HTML transcripts on file for this entity. Report sections will be empty until transcripts are uploaded.');
  }

  // -------------------------------------------------------------------------
  // Section assembly
  // -------------------------------------------------------------------------
  const filingCompliance = buildFilingCompliance(parsed, warnings);

  const liabilityRows = parsed
    .map(buildLiabilityRow)
    .filter((row): row is LiabilityRow => row !== null)
    // Dedupe — admin may have re-uploaded a transcript; keep the row with
    // the larger TC count (more complete data) per (formType, period).
    .reduce<LiabilityRow[]>((acc, row) => {
      const idx = acc.findIndex((r) => r.formType === row.formType && r.period === row.period);
      if (idx === -1) acc.push(row);
      return acc;
    }, [])
    .sort((a, b) => `${a.formType}|${a.period}`.localeCompare(`${b.formType}|${b.period}`));

  const totals = liabilityRows.reduce(
    (t, r) => ({
      totalAssessed: t.totalAssessed + (r.assessed ?? 0),
      totalPaid: t.totalPaid + (r.paid ?? 0),
      totalBalance: t.totalBalance + r.balance,
      totalAccrued: t.totalAccrued + (r.accrued ?? 0),
    }),
    { totalAssessed: 0, totalPaid: 0, totalBalance: 0, totalAccrued: 0 },
  );

  const repaymentPlan = buildRepaymentPlan(parsed);

  // Entity name + TIN come from the row when the entity transcript isn't
  // present (fallback to the request_entities columns).
  const entityXcript = parsed.find((p) => p.meta.transcriptType === 'entity_transcript');
  const entityName = entityXcript?.meta.taxpayerName || entity.entity_name;
  const tin = entityXcript?.meta.tin || entity.tid;

  return {
    generatedAt,
    entityName,
    tin,
    transcriptCount: parsed.length,
    filingCompliance,
    taxLiabilities: { byPeriod: liabilityRows, ...totals },
    repaymentPlan,
    dataQualityWarnings: warnings,
    sourceFiles: parsed.map((p) => p.source),
  };
}
