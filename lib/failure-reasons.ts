/**
 * Plain-language, processor-facing descriptions of why an IRS pull failed.
 *
 * The raw reason code lives on expert_assignments.miss_reason (set by the
 * expert via /api/expert/update-status flag_issue). We surface WHY to the
 * processor — Elena (BFC) + Sonja (Cal Statewide) both called out "blind
 * rejections with no reason" as their #1 pain — but we never surface WHO
 * (the expert). This module maps the code to a clean title + explanation and
 * the recommended fix, and produces the message used for the in-portal note.
 *
 * `primaryFix` drives which recovery action the UI highlights:
 *   edit        — correct entity details (address, name, EIN/SSN, form type)
 *   upload_8821 — a corrected / legible / wet-signed 8821 is needed
 *   retry       — an IRS-side timing issue; just re-submit for another pull
 *   contact     — needs a human; point them at support
 *
 * Matt 2026-07-31.
 */

export type FailureFix = 'edit' | 'upload_8821' | 'retry' | 'contact';

export interface FailureInfo {
  code: string;
  title: string;
  explanation: string;
  primaryFix: FailureFix;
  /** Message for the in-portal support note (behind login; no expert identity). */
  processorMessage: string;
}

const MAP: Record<string, Omit<FailureInfo, 'code'>> = {
  no_record: {
    title: 'The IRS has no record for the requested year(s)',
    explanation:
      'The IRS returned no transcript for this entity and the year(s) requested. That usually means the return was not filed for those years — or the tax ID or a year is off by a digit.',
    primaryFix: 'edit',
    processorMessage:
      'The IRS has no record on file for the requested year(s). Please double-check the tax ID and the years — if they are correct, the return may not have been filed for those years. Update the details and re-submit, or contact support if you expected a record.',
  },
  taxpayer_not_found: {
    title: 'The IRS could not locate this taxpayer',
    explanation:
      'The IRS could not match this entity to a taxpayer record. The business name, tax ID, or address may not match exactly what the IRS has on file.',
    primaryFix: 'edit',
    processorMessage:
      'The IRS could not locate this taxpayer. Please verify the business/taxpayer name and tax ID match the IRS records exactly, correct anything that is off, and re-submit.',
  },
  bad_address: {
    title: 'The address did not match IRS records',
    explanation:
      'The IRS rejected the request because the address on file did not match their records for this taxpayer. Update the address to the one the IRS has on file.',
    primaryFix: 'edit',
    processorMessage:
      'The address did not match the IRS records for this taxpayer. Please update the address to match what the IRS has on file and re-submit.',
  },
  wrong_ein: {
    title: 'The EIN did not match',
    explanation: 'The EIN on the authorization did not match the IRS records for this entity.',
    primaryFix: 'edit',
    processorMessage:
      'The EIN on the 8821 is incorrect. Please correct the EIN so it matches the IRS records, then re-submit. (The EIN must be typed and legible — only the signature may be handwritten.)',
  },
  wrong_ssn: {
    title: 'The SSN did not match',
    explanation: 'The SSN on the authorization did not match the IRS records for this taxpayer.',
    primaryFix: 'edit',
    processorMessage:
      'The SSN on the 8821 is incorrect. Please correct the SSN so it matches the IRS records, then re-submit. (The SSN must be typed and legible — only the signature may be handwritten.)',
  },
  illegible_tid: {
    title: 'The tax ID on the 8821 was unreadable',
    explanation:
      'The EIN/SSN on the signed 8821 was handwritten or illegible, so it could not be verified. A corrected copy with the tax ID typed is needed.',
    primaryFix: 'upload_8821',
    processorMessage:
      'The EIN/SSN on the signed 8821 is handwritten or illegible. Please obtain a corrected 8821 with the tax ID typed (only the signature may be handwritten) and upload it here.',
  },
  wrong_business_name: {
    title: 'The business name did not match IRS records',
    explanation: 'The IRS rejected the request because the business name did not match their records for this entity.',
    primaryFix: 'edit',
    processorMessage:
      'The business name did not match the IRS records. Please update the entity name to match the IRS exactly and re-submit.',
  },
  wrong_taxpayer_name: {
    title: "The taxpayer / authorized party name did not match IRS records",
    explanation: "The IRS rejected the request because the taxpayer / authorized-party name on the 8821 did not match their records.",
    primaryFix: 'edit',
    processorMessage:
      "The taxpayer / authorized-party name did not match the IRS records. Please correct the name to match the IRS exactly and re-submit.",
  },
  missing_tax_years: {
    title: 'The requested tax years were not covered',
    explanation:
      'The authorization on file did not cover the tax year(s) requested, so the IRS would not release those transcripts.',
    primaryFix: 'upload_8821',
    processorMessage:
      'The signed 8821 did not cover the tax year(s) requested. Please upload an 8821 that lists the correct years, then re-submit.',
  },
  wrong_form_type: {
    title: 'The form type did not match this entity',
    explanation:
      'The form type requested did not match what the IRS has on file for this entity (for example, a 1065 request on an 1120S filer).',
    primaryFix: 'edit',
    processorMessage:
      'The form type did not match what the IRS has on file for this entity. Please correct the form type and re-submit.',
  },
  '8821_not_on_file': {
    title: 'The IRS did not have the signed 8821 on file',
    explanation:
      'The IRS could not find the authorization on file for this taxpayer. A signed 8821 needs to be uploaded (or re-uploaded) so we can re-submit.',
    primaryFix: 'upload_8821',
    processorMessage:
      'The IRS did not have the signed 8821 on file. Please upload the signed 8821 here and re-submit.',
  },
  irs_rejected: {
    title: 'The IRS rejected the e-signature on the 8821',
    explanation:
      'The IRS would not accept the electronic signature on the 8821. We have emailed the signer a copy to wet-sign and fax back; upload the wet-signed copy here once returned.',
    primaryFix: 'upload_8821',
    processorMessage:
      'The IRS rejected the electronic signature on the 8821. We have emailed the signer a copy to wet-sign and return. Upload the wet-signed 8821 here once you have it, then re-submit.',
  },
};

const DEFAULT: Omit<FailureInfo, 'code'> = {
  title: "This pull could not be completed",
  explanation:
    'Our processing team flagged an issue that prevented this pull from completing. Review the entity details, update anything that looks off or upload a corrected 8821, and re-submit — or contact support.',
  primaryFix: 'contact',
  processorMessage:
    'Our team flagged an issue that prevented this pull from completing. Please review the entity details and the signed 8821, correct anything that is off, and re-submit — or contact support@moderntax.io.',
};

export function describeFailure(missReason: string | null | undefined): FailureInfo {
  const code = (missReason || 'other').trim();
  const base = MAP[code] || DEFAULT;
  return { code, ...base };
}
