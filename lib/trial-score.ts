/**
 * Trial qualification scoring — pure function, no side-effects, no DB calls.
 *
 * Kill criteria live HERE in code, not in Matt's head.
 * Called from /api/auth/signup BEFORE creating the auth user.
 */

export type QualSegment =
  | 'sba_lender_bank' | 'sba_lender_cdc' | 'commercial_bank' | 'fintech_originator'
  | 'accountant_cpa' | 'individual_borrower' | 'insurance' | 'employment_verif' | 'other';

export type QualVolume = '0' | '1_5' | '6_25' | '26_100' | '101_plus';

export type QualScore = 'auto_qualified' | 'manual_review' | 'disqualified';

export interface QualInput {
  qual_segment: QualSegment | string | null;
  qual_monthly_volume: QualVolume | string | null;
  qual_current_vendor?: string | null;
  qual_team_size?: string | null;
}

export interface QualResult {
  score: QualScore;
  reason: string;
  /** Human-readable message shown to the user if disqualified */
  user_message?: string;
}

const ICP_CORE: QualSegment[] = ['sba_lender_bank','sba_lender_cdc','commercial_bank','fintech_originator'];
const HIGH_VOLUME: QualVolume[] = ['6_25','26_100','101_plus'];

export function scoreQualification(input: QualInput): QualResult {
  const seg = input.qual_segment as QualSegment | null;
  const vol = input.qual_monthly_volume as QualVolume | null;

  // K1: Individual borrower
  if (seg === 'individual_borrower') {
    return {
      score: 'disqualified',
      reason: 'K1: individual_borrower segment',
      user_message: 'ModernTax is built for SBA lenders and financial institutions, not individual borrowers. If you are working with a lender that uses ModernTax, ask them to pull your transcripts directly.',
    };
  }

  // K2: Zero-volume / just exploring
  if (vol === '0') {
    return {
      score: 'disqualified',
      reason: 'K2: zero monthly volume',
      user_message: 'It sounds like you are still in research mode — that is totally fine. When you have an active lending pipeline to verify, come back and we will get you set up in minutes.',
    };
  }

  // F1: Insurance
  if (seg === 'insurance') {
    return { score: 'manual_review', reason: 'F1: insurance segment — confirm IRS transcript use case before activating' };
  }

  // F2: Employment verification
  if (seg === 'employment_verif') {
    return { score: 'manual_review', reason: 'F2: employment_verif segment — confirm transcript pull vs ClearFirm' };
  }

  // F3: CPA
  if (seg === 'accountant_cpa') {
    return { score: 'manual_review', reason: 'F3: accountant_cpa — confirm active SBA/commercial clients' };
  }

  // F4: Other + low volume
  if (seg === 'other' && (vol === '1_5' || vol === '6_25')) {
    return { score: 'manual_review', reason: 'F4: other segment with low-moderate volume' };
  }

  // F5: Low volume + non-ICP
  if (vol === '1_5' && seg && !ICP_CORE.includes(seg as QualSegment)) {
    return { score: 'manual_review', reason: 'F5: low volume + non-core segment' };
  }

  // AUTO-QUALIFY: ICP core + meaningful volume
  if (seg && ICP_CORE.includes(seg as QualSegment) && vol && HIGH_VOLUME.includes(vol as QualVolume)) {
    return { score: 'auto_qualified', reason: `auto_qualified: ICP (${seg}) + volume (${vol})` };
  }

  // Default: manual review
  return { score: 'manual_review', reason: `manual_review: seg=${seg} vol=${vol}` };
}
