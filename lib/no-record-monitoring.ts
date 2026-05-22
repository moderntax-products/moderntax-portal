/**
 * No-Record-Found Auto-Monitoring Detector
 *
 * Driver: Justin Kim @ Centerstone confirmed 2026-05-22 ("Yes, that would be
 * great") that he wants monitoring enabled on entities where the IRS returned
 * a "no record of return filed" stub for the most-recent year requested.
 *
 * The standard auto-enroll cron skips clients with
 * `clients.monitoring_default_enabled = false` — Centerstone is one such
 * client. But the no-record case is different: the lender needs to know
 * when the borrower actually files the missing year, and we own that
 * watch. So we override the per-client opt-out flag for entities matching
 * this specific shape:
 *
 *   1. The most-recent requested year has at least one "no record" stub
 *      transcript on file (filename suffix `-no-record-` or the file
 *      content carries "Requested data not found" / "No record of return
 *      filed"). The filename check is cheap and used here; the
 *      content check happens during stub-detection earlier in the pipeline.
 *   2. The unextended filing deadline for that year+form_type has passed.
 *      Without this gate we'd auto-enroll a 1040 filed 2026-04-01 on a
 *      4-day-old "no record" stub — that's noise, IRS hasn't processed it
 *      yet. We wait until the deadline (3/15 or 4/15 of the following year)
 *      to start polling.
 *
 * Returns `true` when an entity meets BOTH conditions.
 */

/** Calendar-year filing deadlines (unextended). */
const FILING_DEADLINES_MMDD: Record<string, string> = {
  '1120S': '03-15',
  '1065':  '03-15',
  '1040':  '04-15',
  '1120':  '04-15',
};

/**
 * Compute the unextended filing deadline (Date) for a given form_type + tax year.
 * Returns null if form_type isn't in the deadline map (e.g. 941 quarterlies,
 * which we don't monitor on this rule).
 */
export function filingDeadlineForYear(formType: string, taxYear: number): Date | null {
  // Normalize form_type to bare code (strip variant): "1120S-MEF" → "1120S"
  const bare = formType.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/MEF$/, '');
  const mmdd = FILING_DEADLINES_MMDD[bare] || null;
  if (!mmdd) return null;
  const [mm, dd] = mmdd.split('-').map(Number);
  // Deadline year is the year AFTER the tax year: 2025 returns are due in 2026.
  return new Date(Date.UTC(taxYear + 1, mm - 1, dd));
}

/**
 * Return true if any URL in the list looks like a "no record found" stub
 * for the given target year. Two filename conventions in the wild:
 *
 *   1. v6.10 batch script (public/irs-batch-v6.js): injects a
 *      `-no-record-<msgid>` suffix into the filename when isStub=true.
 *      E.g. "...- 1120 Series Account Transcript - 2025-no-record-abc.html".
 *
 *   2. iCloud expert / manual SOR uploads (Matt's expert): files keep their
 *      original IRS SOR filename, which uses the IRS's family-form label
 *      ("1120 Series", "1040 Series", "1065 Series") instead of the
 *      borrower's actual variant. The IRS only renders the family-form name
 *      when there's no return on file for that year — so the family-form
 *      string in the filename is itself the stub signal.
 *      E.g. "...JAYG IN - 1120 Series Account Transcript - 2025.pdf".
 *
 * Either pattern + the target year in the filename = stub.
 */
export function hasNoRecordStubForYear(transcriptUrls: string[], targetYear: string): boolean {
  if (!targetYear) return false;
  return transcriptUrls.some((u) => {
    const fname = (u.split('/').pop() || '');
    if (!fname.includes(targetYear)) return false;
    // Pattern 1: v6.10 batch script suffix
    if (/-no-record-/i.test(fname)) return true;
    // Pattern 2: IRS family-form label (only appears on no-record stubs)
    if (/\b(?:1120|1040|1065)\s*Series\b/i.test(fname)) return true;
    return false;
  });
}

export interface NoRecordAutoEnrollDecision {
  shouldEnroll: boolean;
  reason: string;
  targetYear: string | null;
  deadlinePassed: boolean | null;
}

/**
 * Decide whether an entity should be auto-enrolled under the "no-record-found
 * for the most-recent year, deadline passed" rule.
 *
 * @param entity        Loaded `request_entities` row with form_type + years[]
 *                      + transcript_urls + transcript_html_urls.
 * @param now           Current Date (injectable for tests).
 */
export function shouldAutoEnrollForNoRecord(
  entity: {
    form_type: string | null;
    years: (string | number)[] | null;
    transcript_urls: string[] | null;
    transcript_html_urls: string[] | null;
  },
  now: Date = new Date(),
): NoRecordAutoEnrollDecision {
  if (!entity.form_type) {
    return { shouldEnroll: false, reason: 'no form_type', targetYear: null, deadlinePassed: null };
  }
  const yrs = (entity.years || []).map((y) => String(y).trim()).filter(Boolean);
  if (yrs.length === 0) {
    return { shouldEnroll: false, reason: 'no years requested', targetYear: null, deadlinePassed: null };
  }

  // Most recent requested year — the one most likely to be unfiled.
  const mostRecent = yrs.slice().sort().reverse()[0];
  const yrNum = parseInt(mostRecent, 10);
  if (!Number.isFinite(yrNum)) {
    return { shouldEnroll: false, reason: `unparseable year ${mostRecent}`, targetYear: mostRecent, deadlinePassed: null };
  }

  const deadline = filingDeadlineForYear(entity.form_type, yrNum);
  if (!deadline) {
    return {
      shouldEnroll: false,
      reason: `no deadline rule for form_type=${entity.form_type}`,
      targetYear: mostRecent,
      deadlinePassed: null,
    };
  }
  const deadlinePassed = now >= deadline;
  if (!deadlinePassed) {
    return {
      shouldEnroll: false,
      reason: `deadline ${deadline.toISOString().slice(0, 10)} not yet passed`,
      targetYear: mostRecent,
      deadlinePassed: false,
    };
  }

  const allUrls = [
    ...((entity.transcript_urls as string[]) || []),
    ...((entity.transcript_html_urls as string[]) || []),
  ];
  const hasStub = hasNoRecordStubForYear(allUrls, mostRecent);
  if (!hasStub) {
    return {
      shouldEnroll: false,
      reason: `no no-record stub for year ${mostRecent}`,
      targetYear: mostRecent,
      deadlinePassed: true,
    };
  }

  return {
    shouldEnroll: true,
    reason: `no-record stub for ${entity.form_type} TY${mostRecent}; deadline ${deadline.toISOString().slice(0, 10)} passed`,
    targetYear: mostRecent,
    deadlinePassed: true,
  };
}
