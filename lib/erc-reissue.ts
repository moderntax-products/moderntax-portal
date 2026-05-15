/**
 * ERC Check Reissue — types, status pipeline, helpers.
 * MVP scaffolding to support the Mento $68K returned-checks engagement
 * (productized 2026-05-15 post-call with Alex Marcus).
 */

export type ErcReissueStatus =
  | 'awaiting_intake'           // engagement created, waiting on merchant form
  | 'awaiting_payment'          // intake done but invoice unpaid
  | 'intake_complete'           // form submitted, payment received, ready to assign expert
  | 'expert_assigned'           // expert has the case in their queue
  | 'irs_contact_in_progress'   // expert is on the phone with the IRS Business Line
  | 'trace_filed'               // refund trace officially logged with IRS
  | 'irs_verifying'             // BFS (Bureau of Fiscal Service) verification window
  | 'check_in_mail'             // IRS has issued the replacement check
  | 'check_received'            // merchant confirmed receipt
  | 'closed';                   // engagement closed

export interface ErcReissueStatusHistoryEntry {
  status: ErcReissueStatus;
  changed_at: string;
  changed_by?: string;             // user id or 'system'
  note_internal?: string;
  note_merchant_visible?: string;
}

/**
 * Ordered status pipeline (for timeline rendering). The first 2 (awaiting_intake,
 * awaiting_payment) are gated on the merchant; the rest are expert-driven.
 */
export const ERC_REISSUE_PIPELINE: { status: ErcReissueStatus; label: string; merchantCopy: string }[] = [
  { status: 'awaiting_intake',          label: 'Awaiting intake',        merchantCopy: 'Waiting on your address + Form 3911 details' },
  { status: 'awaiting_payment',         label: 'Awaiting payment',       merchantCopy: 'Form submitted, payment processing' },
  { status: 'intake_complete',          label: 'Ready to file',          merchantCopy: 'All required info received — call to IRS scheduled' },
  { status: 'expert_assigned',          label: 'Expert assigned',        merchantCopy: 'A ModernTax expert is handling your case' },
  { status: 'irs_contact_in_progress',  label: 'On the line with IRS',   merchantCopy: 'Expert is on the phone with the IRS Business & Specialty Tax Line' },
  { status: 'trace_filed',              label: 'Refund trace filed',     merchantCopy: 'IRS has logged the trace request — verification window begins' },
  { status: 'irs_verifying',            label: 'IRS verifying',          merchantCopy: 'Bureau of Fiscal Service confirming check was not cashed' },
  { status: 'check_in_mail',            label: 'Check in the mail',      merchantCopy: 'IRS has issued the replacement check — should arrive in ~1 week' },
  { status: 'check_received',           label: 'Check received',         merchantCopy: 'You confirmed receipt — engagement complete!' },
  { status: 'closed',                   label: 'Closed',                 merchantCopy: 'Engagement closed' },
];

export function pipelineIndex(status: ErcReissueStatus): number {
  return ERC_REISSUE_PIPELINE.findIndex(s => s.status === status);
}

export interface ErcIntakeData {
  submitted_at?: string;
  new_mailing_address?: {
    address1: string;
    address2?: string;
    city: string;
    state: string;
    zip: string;
    country?: string;
  };
  authorized_officer?: {
    name: string;
    title: string;
    signature_typed: string;
    signature_date: string;
  };
  // Per-quarter certification box selection (1 = didn't receive; 3 = received then lost/destroyed)
  certification_box_per_quarter?: Record<string, 1 | 3>;
  consent_to_call_irs?: boolean;
  irs_2848_poa_on_file?: boolean;
  additional_notes?: string;
}

/**
 * Resolve which IRS service center receives the Form 3911 fax based on
 * the taxpayer's state (per IRS Publication where to file for businesses).
 * Western/central states → Ogden, UT. Eastern → Cincinnati, OH.
 */
const OGDEN_STATES = new Set([
  'AK', 'AZ', 'CA', 'CO', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'MI', 'MN', 'MT',
  'NE', 'NV', 'NM', 'ND', 'OK', 'OR', 'SD', 'UT', 'WA', 'WI', 'WY',
]);

export function resolveServiceCenter(stateCode: string): 'ogden' | 'cincinnati' {
  return OGDEN_STATES.has(stateCode.toUpperCase()) ? 'ogden' : 'cincinnati';
}

export function formatUsdAmount(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
