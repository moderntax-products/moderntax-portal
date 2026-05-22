/**
 * Tax Classification Verification
 *
 * Detects mismatches between:
 *   1. Borrower-declared filing form (from intake — entity.form_type)
 *   2. IRS-of-record filing requirement (from BMF Entity Transcript)
 *   3. Recent Account Transcript content (real data vs. "Requested data not found" stub)
 *   4. Form 2553 election status (from PPS specialty-line lookup)
 *
 * Driver: Derek Le @ Enterprise Bank, 2026-05-22. K.O.K. Trucking LLC
 * filed Form 2553 retroactive to 2024 FY, but the IRS hadn't processed it
 * yet — so 2024 came back as a "1120 Series" stub even though the
 * borrower (correctly) thought of themselves as 1120-S. We productize
 * this with a per-entity flag + structured detection.
 *
 * Pricing: $20-30 add-on per entity at intake time (sold as "Tax
 * Classification Verification"). For SBA C&I lenders this is automatic.
 *
 * See:
 *   supabase/migration-tax-classification-verification.sql
 *   app/api/admin/compliance-status/[entityId] (UI renderer)
 */

export type TaxClassificationSeverity = 'WARNING' | 'CRITICAL';
export type TaxClassificationSource = 'bmf_entity' | 'transcript_stub' | '2553_lag';

export interface Form2553Status {
  received_date: string | null;        // "YYYY-MM-DD" — when IRS received the 2553
  effective_date: string | null;       // "YYYY-MM-DD" — retro/forward effective date elected
  processing_status: 'pending' | 'accepted' | 'rejected' | 'not_on_file' | null;
  raw_notes: string;                   // free-form notes from the PPS agent
}

export interface TaxClassificationMismatch {
  detected_at: string;                 // ISO-8601
  declared_form: string;               // borrower's intake claim ("1120S", "1120", "1065", etc.)
  irs_form: string | null;             // what IRS shows on BMF Entity or the stub label
  source: TaxClassificationSource;
  severity: TaxClassificationSeverity;
  message: string;                     // human-readable summary
  suggested_borrower_action: string;   // what the borrower should do
  form_2553_relevant: boolean;         // hint to surface the 2553 status block on the UI
}

interface ParsedTranscript {
  filename: string;
  text: string;                        // plaintext extract from HTML or PDF
  isStubResponse: boolean;             // "Requested data not found"
  irsFormLabel: string | null;         // "1120 Series" / "1120-S" / etc. extracted from the transcript header
  taxPeriodEnding: string | null;      // "MM-DD-YYYY"
}

interface BmfEntitySnapshot {
  filing_requirements: string | null;  // e.g. "Form 1120-S, U.S. Income Tax Return for an S Corporation"
  primary_name: string | null;
  raw_notes: string | null;
}

const FAMILY_FORMS = ['1040', '1065', '1120', '1120S', '1120-S'] as const;

/** Normalize a form string for comparison. "1120-S" → "1120S", "1120 Series" → "1120SERIES". */
function normalizeForm(f: string | null | undefined): string {
  if (!f) return '';
  return f.toUpperCase().replace(/[\s\-_]/g, '');
}

/** Extract the IRS family token from a normalized form. "1120SERIES" → "1120", "1120S" → "1120". */
function familyOf(normalized: string): string | null {
  const m = normalized.match(/^(1040|1065|1120)/);
  return m ? m[1] : null;
}

/** Lightweight BMF Entity parser — pulls the Filing Requirements value out of the HTML. */
export function parseBmfEntity(html: string): BmfEntitySnapshot {
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const filingMatch = stripped.match(/Filing Requirements?:?\s*([^.]+?(?:Form\s+\d+[A-Z\-]*[^.]*)?)\s*(?:Fiscal Year|Limited Liability|North American|Sort Name|$)/i);
  const nameMatch = stripped.match(/Primary Name:?\s*([A-Z0-9 &,'.\-]+?)\s*(?:Sort Name|Name Control|Filing|Street|City|State|ZIP|$)/i);
  return {
    filing_requirements: filingMatch?.[1]?.trim().slice(0, 240) || null,
    primary_name: nameMatch?.[1]?.trim() || null,
    raw_notes: stripped.slice(0, 1200),
  };
}

/** Pull the IRS form label (e.g. "1120 Series", "1120-S", "1040") from an Account/Return Transcript HTML. */
export function parseTranscriptHeader(html: string, filename = ''): ParsedTranscript {
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const formMatch = stripped.match(/Form\s+Number:?\s*([0-9]{3,4}[A-Z\-]?(?:\s+Series)?)/i);
  const periodMatch = stripped.match(/Report for Tax Period Ending:?\s*(\d{2}-\d{2}-\d{4})/i);
  const isStub = /Requested data not found|No record of return filed/i.test(stripped);
  return {
    filename,
    text: stripped.slice(0, 4000),
    isStubResponse: isStub,
    irsFormLabel: formMatch?.[1]?.trim() || null,
    taxPeriodEnding: periodMatch?.[1] || null,
  };
}

/**
 * Inspect an entity's declared form against its BMF Entity transcript + the
 * most-recent Account Transcript and return a structured mismatch finding
 * (or null if everything checks out).
 *
 * Three trigger paths, in priority order:
 *
 *  (a) BMF Entity Filing Requirements explicitly says one form (e.g.
 *      "Form 1120-S") and the borrower declared another (e.g. "1120").
 *      Highest signal — IRS is the system of record.
 *
 *  (b) The most-recent year's Account Transcript came back as a "1120
 *      Series" stub (form_label is the generic family, not the specific
 *      variant) AND the borrower claims to have filed. Likely a 2553
 *      election in flight that IRS hasn't processed yet.
 *
 *  (c) The borrower declares 1120S and the BMF Entity Filing Requirements
 *      doesn't yet mention "S Corporation" / "1120-S" — but a 2553 lookup
 *      result is present + status="pending". Same fact pattern as (b)
 *      with explicit corroboration from the 2553 row.
 */
export function detectTaxClassificationMismatch(input: {
  declared_form: string;                            // from request_entities.form_type
  bmf_entity?: BmfEntitySnapshot | null;
  recent_transcript?: ParsedTranscript | null;     // most recent year's Account Transcript
  form_2553_status?: Form2553Status | null;
  borrower_claims_filed_year?: number | null;       // lender hint: borrower says they filed this most-recent year
}): TaxClassificationMismatch | null {
  const declared = normalizeForm(input.declared_form);
  if (!declared) return null;
  const declaredFamily = familyOf(declared);
  if (!declaredFamily) return null;
  const now = new Date().toISOString();

  // (a) BMF Entity disagrees with declared
  const bmfFiling = input.bmf_entity?.filing_requirements || '';
  if (bmfFiling) {
    const upper = bmfFiling.toUpperCase();
    const bmfIsScorp = /\bFORM\s*1120\-?S\b|\bS\s*CORPORATION\b/.test(upper);
    const bmfIs1120 = /\bFORM\s*1120\b(?!\-?S)/.test(upper) && !bmfIsScorp;
    const bmfIsPartner = /\bFORM\s*1065\b|\bPARTNERSHIP\b/.test(upper);
    const bmfIs1040 = /\bFORM\s*1040\b/.test(upper);
    const bmfFamily = bmfIsScorp ? '1120S' : bmfIs1120 ? '1120' : bmfIsPartner ? '1065' : bmfIs1040 ? '1040' : null;
    if (bmfFamily && bmfFamily !== declared && !(declared === '1120-S' && bmfFamily === '1120S')) {
      const message = `Borrower declared Form ${input.declared_form} on the intake, but IRS BMF Entity shows filing requirement "${bmfFiling}". IRS treats this taxpayer as ${bmfFamily === '1120S' ? 'an S-Corp' : bmfFamily === '1120' ? 'a C-Corp' : bmfFamily === '1065' ? 'a partnership' : 'an individual'} for tax purposes.`;
      return {
        detected_at: now,
        declared_form: input.declared_form,
        irs_form: bmfFamily,
        source: 'bmf_entity',
        severity: 'WARNING',
        message,
        suggested_borrower_action: declared === '1120S' && bmfFamily === '1120'
          ? 'Confirm whether Form 2553 (S-Corp election) has been filed and accepted by IRS. If filed but not yet processed, borrower should call IRS Entity Specialty line at 1-800-829-4933 to escalate processing.'
          : `Confirm with borrower that they actually file Form ${input.declared_form}, and consider verifying with the IRS Entity Specialty line at 1-800-829-4933 if there's any chance the IRS-of-record is wrong.`,
        form_2553_relevant: declared === '1120S' && bmfFamily === '1120',
      };
    }
  }

  // (b) Recent transcript is a stub for the family — likely the 2553 lag pattern
  const recent = input.recent_transcript;
  if (recent && recent.isStubResponse) {
    const transcriptFormNorm = normalizeForm(recent.irsFormLabel);
    const transcriptFamily = familyOf(transcriptFormNorm);
    const isFamilyStub = transcriptFormNorm.endsWith('SERIES') && transcriptFamily === declaredFamily;
    if (isFamilyStub && input.borrower_claims_filed_year) {
      return {
        detected_at: now,
        declared_form: input.declared_form,
        irs_form: recent.irsFormLabel,
        source: 'transcript_stub',
        severity: 'WARNING',
        message: `Borrower declared Form ${input.declared_form} and says they filed for tax year ${input.borrower_claims_filed_year}, but IRS returned a "${recent.irsFormLabel}" stub ("Requested data not found") for that year. The return may have been e-filed under the wrong classification, or a recent Form 2553 (S-Corp election) hasn't been processed by IRS yet.`,
        suggested_borrower_action: 'Confirm Form 2553 election status. If 2553 was filed, contact IRS Entity Specialty line at 1-800-829-4933 referencing the e-filing acknowledgment to escalate processing.',
        form_2553_relevant: declared === '1120S',
      };
    }
  }

  // (c) Explicit 2553 status corroborates a 1120-S declaration that IRS hasn't caught up to
  const s2553 = input.form_2553_status;
  if (declared === '1120S' && s2553) {
    if (s2553.processing_status === 'pending') {
      return {
        detected_at: now,
        declared_form: input.declared_form,
        irs_form: input.bmf_entity ? '1120' : null,
        source: '2553_lag',
        severity: 'WARNING',
        message: `Form 2553 (S-Corp election) on file with IRS — received ${s2553.received_date || 'date unknown'}, effective ${s2553.effective_date || 'date unknown'}, processing PENDING. Until IRS finishes processing, transcripts for affected years will come back as "1120 Series" stubs instead of "1120-S".`,
        suggested_borrower_action: 'No action required if borrower can wait for IRS to process the election (4-12 weeks typical). To expedite, borrower can call IRS Entity Specialty line at 1-800-829-4933 with the 2553 received date and request a status check.',
        form_2553_relevant: true,
      };
    }
    if (s2553.processing_status === 'rejected') {
      return {
        detected_at: now,
        declared_form: input.declared_form,
        irs_form: input.bmf_entity ? '1120' : null,
        source: '2553_lag',
        severity: 'CRITICAL',
        message: `Form 2553 (S-Corp election) was REJECTED by IRS. Borrower's declared Form 1120-S filing requirement is not supported by an active IRS election. ${s2553.raw_notes || ''}`,
        suggested_borrower_action: 'Borrower should consult their tax professional. IRS rejection typically means a late-election relief request is needed (Rev. Proc. 2013-30) or refiling Form 2553 with corrected information.',
        form_2553_relevant: true,
      };
    }
    if (s2553.processing_status === 'not_on_file' && input.borrower_claims_filed_year) {
      return {
        detected_at: now,
        declared_form: input.declared_form,
        irs_form: '1120',
        source: '2553_lag',
        severity: 'CRITICAL',
        message: `Borrower declared 1120-S filing but IRS has NO Form 2553 election on file. The entity is being treated as a 1120 C-Corp (or default-classification entity) by the IRS.`,
        suggested_borrower_action: 'Borrower needs to file Form 2553 immediately. If 2553 was previously filed and lost, they should refile with proof-of-filing documentation. Without an accepted 2553, the IRS will not treat the entity as an S-Corp regardless of how the borrower has been filing.',
        form_2553_relevant: true,
      };
    }
  }

  return null;
}

/**
 * Render a friendly explanation block for the admin compliance panel.
 * Returns plain markdown — caller may convert to HTML or display verbatim.
 */
export function formatMismatchForUI(m: TaxClassificationMismatch): { headline: string; bullets: string[]; action: string } {
  const formLabel = (s: string | null) => s ? s.replace(/^1120S$/, '1120-S').replace(/^1120SERIES$/, '1120 Series') : '(unknown)';
  return {
    headline: `Tax classification ${m.severity === 'CRITICAL' ? 'BLOCK' : 'flag'} — borrower says ${formLabel(m.declared_form)}, IRS shows ${formLabel(m.irs_form)}.`,
    bullets: [
      `Detected via: ${m.source === 'bmf_entity' ? 'BMF Entity Transcript (Filing Requirements)' : m.source === 'transcript_stub' ? 'Account Transcript stub on most-recent year' : 'Form 2553 election status lookup'}`,
      `Severity: ${m.severity}`,
      m.message,
    ],
    action: m.suggested_borrower_action,
  };
}

/**
 * Compose the borrower-facing email body for the "Send Borrower Communication"
 * button on the admin compliance panel. Includes IRS phone numbers + sample
 * language so the borrower can resolve the issue with minimal back-and-forth.
 */
export function buildBorrowerCommunication(input: {
  entity_name: string;
  tin: string;
  mismatch: TaxClassificationMismatch;
  form_2553_status?: Form2553Status | null;
  lender_name?: string;
}): { subject: string; body: string } {
  const lenderClause = input.lender_name ? `your lender (${input.lender_name})` : 'your lender';
  const subject = `Action needed on ${input.entity_name} — IRS tax-classification status`;

  let body = `Hi,\n\nWe're processing the IRS transcripts for ${input.entity_name} (EIN ${input.tin}) on behalf of ${lenderClause}, and we've run into an IRS-side issue we need your help resolving.\n\n`;
  body += `**What we found:**\n${input.mismatch.message}\n\n`;
  body += `**What you can do:**\n${input.mismatch.suggested_borrower_action}\n\n`;

  if (input.form_2553_status) {
    body += `**Form 2553 status from IRS (as of our last check):**\n`;
    body += `• Received date: ${input.form_2553_status.received_date || 'unknown'}\n`;
    body += `• Effective date: ${input.form_2553_status.effective_date || 'unknown'}\n`;
    body += `• Processing status: ${input.form_2553_status.processing_status || 'unknown'}\n`;
    if (input.form_2553_status.raw_notes) body += `• Notes from IRS: ${input.form_2553_status.raw_notes}\n`;
    body += '\n';
  }

  body += `**Useful IRS contact info:**\n`;
  body += `• IRS Business & Specialty Tax Line: 1-800-829-4933 (Mon-Fri 7am-7pm local)\n`;
  body += `• Have ready: EIN ${input.tin}, your name + title, any 2553 fax confirmation\n\n`;
  body += `Once the IRS confirms the correct status, reply with what they tell you and we'll re-pull transcripts. Most of these resolve in 1-2 weeks once IRS is contacted directly.\n\nThanks,\nModernTax`;

  return { subject, body };
}

export { FAMILY_FORMS };
