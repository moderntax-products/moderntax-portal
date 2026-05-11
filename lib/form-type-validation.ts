/**
 * Form-type / tid_kind validation.
 *
 * The 8821 covers SPECIFIC form types, and the IRS rejects authorizations where
 * the form code doesn't match the filer type:
 *   • Individuals (SSN / ITIN) file a 1040 (and get W-2 / 1099 Wage & Income).
 *   • Business entities (EIN) file 1065 / 1120 / 1120S / 990 / 1041 — NOT 1040.
 *
 * Every intake path in this codebase defaults `form_type` to '1040' if the
 * field is absent on the payload. That silent default produced 116 rows in
 * production where an EIN entity was filed under 1040 — the Form 8821 was
 * technically misrouted at the IRS end, and our experts pulled the wrong
 * transcript types.
 *
 * This module centralises the rules and the normalization so every intake
 * route can enforce them identically.
 */

export const VALID_FORM_TYPES = ['1040', '1065', '1120', '1120S', '990', '1041', '941', 'W2_INCOME'] as const;
export type FormType = (typeof VALID_FORM_TYPES)[number];

export type TidKind = 'SSN' | 'EIN' | 'ITIN';

const INDIVIDUAL_KINDS: TidKind[] = ['SSN', 'ITIN'];
const INDIVIDUAL_FORMS = new Set(['1040', 'W2_INCOME']);
// 941 is the employer quarterly payroll tax return — business-only.
// Added as a first-class form_type to support ERC verification workflows
// (TaxTaker POC, May 2026): partners need to confirm whether ERC refund
// checks have been issued or denied. The transcript artifact requested
// is a 941 Record of Account, which shows the TC 846 (refund issued) /
// TC 290 (additional assessment) / TC 470 (claim pending) transaction
// codes that identify ERC status by quarter.
const BUSINESS_FORMS = new Set(['1065', '1120', '1120S', '990', '1041', '941']);

/**
 * Strict compatibility check — returns null if valid, or a human-readable
 * reason string if the pair is incompatible.
 */
export function validateFormTypeMatchesTidKind(
  tidKind: TidKind | string | null | undefined,
  formType: FormType | string | null | undefined,
): string | null {
  if (!tidKind || !formType) return null; // caller decides whether to require both

  const k = String(tidKind).toUpperCase() as TidKind;
  const f = String(formType).replace(/[\s-]/g, '').toUpperCase();

  if (INDIVIDUAL_KINDS.includes(k) && BUSINESS_FORMS.has(f)) {
    return `Entity has ${k} (individual taxpayer) but form_type=${formType} is a business form. Individuals must use 1040 or W2_INCOME.`;
  }
  if (k === 'EIN' && INDIVIDUAL_FORMS.has(f)) {
    return `Entity has EIN (business taxpayer) but form_type=${formType} is an individual form. Businesses must use 1065, 1120, 1120S, 990, 1041, or 941.`;
  }
  return null;
}

/**
 * Infer the correct form_type when the caller didn't provide one.
 * Falls back to a safe default based on tid_kind:
 *   SSN/ITIN → '1040'
 *   EIN      → '1120' (generic C-corp placeholder; user should confirm)
 */
export function inferFormTypeFromTidKind(tidKind: TidKind | string | null | undefined): FormType {
  if (!tidKind) return '1040';
  const k = String(tidKind).toUpperCase();
  return k === 'EIN' ? '1120' : '1040';
}

/**
 * Normalize user-provided form type strings into one of VALID_FORM_TYPES.
 * Strips whitespace/dashes, upper-cases, and maps common variants
 * ('FORM1040', '1120-S', '1120 S', 'corp', 'partnership', 'scorp' → canonical).
 * Returns null if no valid mapping exists.
 */
export function normalizeFormType(raw: string | null | undefined): FormType | null {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s-]/g, '').toUpperCase();

  if ((VALID_FORM_TYPES as readonly string[]).includes(cleaned)) return cleaned as FormType;

  // Common aliases
  const aliases: Record<string, FormType> = {
    'FORM1040': '1040',
    'FORM1065': '1065',
    'FORM1120': '1120',
    'FORM1120S': '1120S',
    'CORP': '1120',
    'CCORP': '1120',
    'C_CORP': '1120',
    'SCORP': '1120S',
    'S_CORP': '1120S',
    'PARTNERSHIP': '1065',
    'INDIVIDUAL': '1040',
    'PERSONAL': '1040',
    'SOLE': '1040',
    'SOLEPROP': '1040',
    'SOLEPROPRIETOR': '1040',
    'W2': 'W2_INCOME',
    'WI': 'W2_INCOME',
    'WAGEINCOME': 'W2_INCOME',
    'W2INCOME': 'W2_INCOME',
    'W_2_INCOME': 'W2_INCOME',
    // 941 (employer quarterly payroll) and its ERC-flavored aliases.
    // Partners (TaxTaker, R&D credit shops) commonly describe these
    // requests as "ERC check verification" rather than "941" — accept
    // both phrasings so the CSV import doesn't reject legitimate intake.
    'FORM941': '941',
    'PAYROLL': '941',
    'QUARTERLY': '941',
    'QUARTERLYPAYROLL': '941',
    'EMPLOYERSQUARTERLY': '941',
    'ERC': '941',
    'ERC941': '941',
    'ERCCLAIM': '941',
    'ERCREFUND': '941',
    'ERTC': '941',
    'EMPLOYEERETENTIONCREDIT': '941',
  };

  return aliases[cleaned] || null;
}

/**
 * Resolve a final form_type from user input + tid_kind, enforcing compatibility.
 *
 * Behavior:
 *   • If `formType` is provided and valid — use it, but error if it mismatches tid_kind.
 *   • If `formType` is absent — infer from tid_kind.
 *   • If `formType` is provided but unparseable — return error.
 *
 * Returns { formType, error } — caller should return 400 if `error` is set.
 */
export function resolveFormType(
  formType: string | null | undefined,
  tidKind: TidKind | string | null | undefined,
): { formType: FormType | null; error: string | null } {
  // No form type provided → infer from tid_kind (keeps backward compat for legacy callers)
  if (!formType) {
    return { formType: inferFormTypeFromTidKind(tidKind), error: null };
  }

  const normalized = normalizeFormType(formType);
  if (!normalized) {
    return {
      formType: null,
      error: `Invalid form_type "${formType}". Must be one of: ${VALID_FORM_TYPES.join(', ')}.`,
    };
  }

  const mismatch = validateFormTypeMatchesTidKind(tidKind, normalized);
  if (mismatch) {
    return { formType: null, error: mismatch };
  }

  return { formType: normalized, error: null };
}
