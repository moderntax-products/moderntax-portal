/**
 * Filter transcript URLs to only the ones matching what the processor
 * actually requested on the original entity submission (form_type + years).
 *
 * Driver: Centerstone's Justin Thomas (JTC Business LLC, loan 18034)
 * requested 1065 transcripts for 2022/2023/2024. During the IRS PPS
 * call, Matt also pulled a bonus 3 × 941 quarters as an ERC discovery
 * sweep. The bonus 941s landed in `request_entities.transcript_html_urls`
 * alongside the 1065s. The processor should only see the 8 × 1065 they
 * asked for, not the 3 × 941 internal discovery files (which are still
 * available on the admin compliance-status page).
 *
 * Naming conventions parsed (from the iCloud expert's SOR-uploaded files):
 *
 *   <timestamp>-<TAXPAYER> - <FORM>[VARIANT] <TYPE> Transcript - <YEAR>.<ext>
 *
 * Examples:
 *   "...JT BUSI LL - 1065MEF Account Transcript - 2023.html"
 *   "...JT BUSI LL - 1065 Series Account Transcript - 2025.html"
 *   "...Unknown - 941 Account Transcript - 2020.html"
 *   "...Form 1040 Record of Account - John Smith - 2023.html"  (older format)
 */

export interface ParsedTranscriptFilename {
  /** Bare form code, normalized: "1065" | "1120" | "1120S" | "1040" | "941" | null */
  form: string | null;
  /** 4-digit calendar year referenced in the filename, or null. */
  year: string | null;
  /** Transcript type bucket: ROA | TRT | ACCT | WIT | UNKNOWN */
  type: 'ROA' | 'TRT' | 'ACCT' | 'WIT' | 'UNKNOWN';
  /** True if the filename mentions any 941 quarter (bonus ERC pull on a 1065/1120 entity). */
  isBonusErcSweep: boolean;
}

/** Pull (form, year, type) out of an upload-pipeline-styled filename. */
export function parseTranscriptFilename(path: string): ParsedTranscriptFilename {
  const fname = path.split('/').pop() || path;
  // Strip the leading timestamp prefix and extension for cleaner matching.
  const stem = fname
    .replace(/^\d{10,16}-/, '')
    .replace(/\.(html|pdf)$/i, '')
    .trim();

  // Form: 1065 / 1065MEF / 1120 / 1120-S / 1120S / 1040 / 941, plus the
  // IRS family-form fallbacks "1120 Series" / "1040 Series" / "1065 Series".
  // The IRS only renders the family-form label when there's no specific
  // return on file for that year — so a "1120 Series" filename is a
  // no-record-found stub and needs to be recognized as its own form code
  // (not collapsed to "1120") so the filter's stub-family branch in
  // filterRequestedTranscripts() actually fires. Filed 2026-05-22 by
  // Justin Kim (Centerstone loan 18037 — Jaygopal / Honey Hospitality
  // / Jaykumar Patel 2025 transcripts hidden after first fix attempt).
  const formMatch = stem.match(/\b(1120-?S|1120(?:\s*Series)?|1065(?:MEF)?(?:\s*Series)?|1040(?:\s*Series)?|941)\b/i);
  let form: string | null = null;
  if (formMatch) {
    const raw = formMatch[1].toUpperCase().replace(/\s|-/g, '');
    if (raw === '1065SERIES')      form = '1065SERIES';
    else if (raw === '1120SERIES') form = '1120SERIES';
    else if (raw === '1040SERIES') form = '1040SERIES';
    else if (raw.startsWith('1065')) form = '1065';
    else if (raw.startsWith('1120S')) form = '1120S';
    else if (raw === '1120')       form = '1120';
    else if (raw === '1040')       form = '1040';
    else if (raw === '941')        form = '941';
  }

  // Year: 4 digits, prefer the LAST 4-digit run in the filename (avoids
  // grabbing a year from inside a form variant like "1065MEF").
  const yearMatches = [...stem.matchAll(/\b(20\d{2})\b/g)];
  const year = yearMatches.length > 0 ? yearMatches[yearMatches.length - 1][1] : null;

  // Type: Record of Account vs Return Transcript vs Account Transcript vs Wage & Income
  let type: ParsedTranscriptFilename['type'] = 'UNKNOWN';
  if (/Record of Account|\bRoA\b/i.test(stem)) type = 'ROA';
  else if (/Return Transcript|\bTRT\b/i.test(stem)) type = 'TRT';
  else if (/Account Transcript|\bACCT\b/i.test(stem)) type = 'ACCT';
  else if (/Wage (?:and|&) Income|\bWIT\b/i.test(stem)) type = 'WIT';

  return {
    form,
    year,
    type,
    isBonusErcSweep: form === '941',
  };
}

/**
 * Given an entity's full transcript URL list and its requested (form, years),
 * return only the URLs matching the original ask.
 *
 * Matching rules:
 *   - The transcript's parsed `form` must equal the entity's requested form_type.
 *   - The transcript's parsed `year` must be in the entity's requested years[] array.
 *   - Any transcript type (ROA / TRT / Account / Return) is shown if form+year match.
 *     The processor is paying for "transcripts for form X year Y" — both ROA and
 *     TRT for the same year are valid deliverables; we don't hide either.
 *
 * Anything that doesn't match is presumed to be an internal-discovery pull
 * (most commonly the bonus 941 ERC sweep, or a different form pulled by the
 * agent in error). Those stay on the entity row for admin visibility but
 * aren't shown to the processor.
 */
export interface RequestedFilterResult {
  /** Transcript URLs the processor requested (matches form + year). */
  requested: string[];
  /** Transcript URLs from internal-discovery / bonus pulls. */
  internalOnly: string[];
  /** Count of internal pulls in each category — useful for the small "internal also pulled X" note. */
  internalSummary: {
    bonusErcSweep: number;       // 941 transcripts on a non-941 entity
    differentForm: number;       // any other off-form pull
    yearOutOfScope: number;      // right form, wrong year
  };
  /**
   * True when the year filter would have hidden EVERY transcript (no
   * file matched the requested years) and we fell back to showing the
   * same-form, year-mismatched transcripts instead. See the fail-open
   * guard in filterRequestedTranscripts().
   */
  yearFallbackApplied: boolean;
}

export function filterRequestedTranscripts(
  urls: string[],
  requestedFormType: string | null,
  requestedYears: string[] | null,
): RequestedFilterResult {
  const requested: string[] = [];
  const internalOnly: string[] = [];
  // Same-form transcripts whose year wasn't in the requested set. Tracked
  // separately so we can fall back to them if the year filter would
  // otherwise leave the processor with nothing to download.
  const yearOutOfScopeUrls: string[] = [];
  const summary = { bonusErcSweep: 0, differentForm: 0, yearOutOfScope: 0 };

  if (!requestedFormType || !requestedYears || requestedYears.length === 0) {
    // No basis for filtering — return everything as "requested" to avoid
    // hiding valid data from the processor when the entity row is incomplete.
    return { requested: urls, internalOnly: [], internalSummary: summary, yearFallbackApplied: false };
  }

  // Normalize the requested form for comparison. The DB stores 1120S without
  // the dash; filenames may have "1120-S" or "1120 S".
  const reqForm = requestedFormType.toUpperCase().replace(/[\s-]/g, '');

  // Track unique (form, year, type) triples for the SUMMARY counts so we
  // don't double-count when both HTML and PDF copies of the same transcript
  // are present (which is the common case from SOR uploads).
  const internalUniqueKeys: Record<keyof typeof summary, Set<string>> = {
    bonusErcSweep: new Set(),
    differentForm: new Set(),
    yearOutOfScope: new Set(),
  };

  for (const url of urls) {
    const parsed = parseTranscriptFilename(url);
    const transcriptForm = parsed.form?.toUpperCase().replace(/[\s-]/g, '') ?? null;
    const triple = `${parsed.form}|${parsed.year}|${parsed.type}`;

    if (!transcriptForm) {
      // Couldn't classify — show to processor by default (better to over-show
      // than hide a paid deliverable because of a parser miss).
      requested.push(url);
      continue;
    }

    // The IRS labels "no record found" / "data not yet posted" stubs with
    // the generic family form name like "1120 Series" or "1040 Series"
    // instead of the specific variant (1120S, 1120-S). Without this guard,
    // the stub for a 1120S taxpayer's 2025 return (deadline still in the
    // future) gets hidden from the processor view as "different form" —
    // looks like a missing transcript. Filed 2026-05-22 by Justin Kim
    // (Centerstone, loan 18037, Jaygopal/Honey Hospitality/Kalamazoo 2025).
    const isStubFamilyForm = /^1120SERIES$|^1040SERIES$|^1065SERIES$/.test(transcriptForm);
    const reqFormFamily =
      reqForm.startsWith('1120') ? '1120SERIES' :
      reqForm.startsWith('1040') ? '1040SERIES' :
      reqForm.startsWith('1065') ? '1065SERIES' : null;
    const matchesViaStubFamily = isStubFamilyForm && transcriptForm === reqFormFamily;

    if (transcriptForm !== reqForm && !matchesViaStubFamily) {
      internalOnly.push(url);
      if (parsed.isBonusErcSweep) internalUniqueKeys.bonusErcSweep.add(triple);
      else internalUniqueKeys.differentForm.add(triple);
      continue;
    }

    if (parsed.year && !requestedYears.includes(parsed.year)) {
      internalOnly.push(url);
      yearOutOfScopeUrls.push(url);
      internalUniqueKeys.yearOutOfScope.add(triple);
      continue;
    }

    requested.push(url);
  }

  // Fail-open guard: if the year filter hid EVERY transcript (processor would
  // see nothing to download) but we DID pull same-form transcripts for other
  // years, show those instead of hiding a paid deliverable. This is the case
  // where the entity's recorded request year is wrong/stale — e.g. Green
  // Diamond Landscaping (Cal Statewide, 2026-06-16) recorded years=["2026"]
  // for a 1120S, but the only transcripts on file (and the only ones that CAN
  // exist) are 2022/2023/2024, so all 6 were hidden and Sonja saw only the
  // 8821. A same-form transcript is the actual product — never an internal
  // discovery bonus (those are off-form, e.g. 941, and stay hidden). Only
  // triggers when `requested` is empty, so it never over-shows when the
  // requested years legitimately matched something.
  let yearFallbackApplied = false;
  if (requested.length === 0 && yearOutOfScopeUrls.length > 0) {
    const fallback = new Set(yearOutOfScopeUrls);
    requested.push(...yearOutOfScopeUrls);
    // These are now shown, so drop them from the hidden set + its summary.
    for (let i = internalOnly.length - 1; i >= 0; i--) {
      if (fallback.has(internalOnly[i])) internalOnly.splice(i, 1);
    }
    internalUniqueKeys.yearOutOfScope.clear();
    yearFallbackApplied = true;
  }

  // Materialize summary counts from the unique-triples sets (de-duplicates
  // HTML+PDF pairs of the same transcript).
  summary.bonusErcSweep = internalUniqueKeys.bonusErcSweep.size;
  summary.differentForm = internalUniqueKeys.differentForm.size;
  summary.yearOutOfScope = internalUniqueKeys.yearOutOfScope.size;

  return { requested, internalOnly, internalSummary: summary, yearFallbackApplied };
}

/**
 * Format the small note that explains internal-only pulls to the processor
 * without revealing the files. Returns null when there are no internal pulls.
 */
export function formatInternalPullsNote(summary: RequestedFilterResult['internalSummary']): string | null {
  const parts: string[] = [];
  if (summary.bonusErcSweep > 0) {
    parts.push(`${summary.bonusErcSweep} bonus Form 941 quarter${summary.bonusErcSweep === 1 ? '' : 's'} (Employee Retention Credit discovery sweep)`);
  }
  if (summary.differentForm > 0) {
    parts.push(`${summary.differentForm} off-form transcript${summary.differentForm === 1 ? '' : 's'} (internal QA)`);
  }
  if (summary.yearOutOfScope > 0) {
    parts.push(`${summary.yearOutOfScope} additional year${summary.yearOutOfScope === 1 ? '' : 's'} outside the original request scope`);
  }
  if (parts.length === 0) return null;
  return `Our team also pulled ${parts.join(' + ')} during the IRS PPS call as part of standard discovery work. Findings will surface separately if anything actionable was identified.`;
}
