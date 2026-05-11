/**
 * Single source of truth for ModernTax pricing.
 *
 * Historical note: pricing constants used to live scattered across
 * components (CsvUploadFlow, PdfUploadFlow, ManualEntryFlow,
 * UpgradeYourTeamPanel, cash-flow/generate, repeat-entity) and
 * app/plans/page.tsx. When we needed to change one, finding all the
 * call sites was error-prone. This module is the new authoritative
 * home. New surfaces should import from here; existing duplicated
 * constants will get migrated when their files are next touched.
 *
 * All amounts are USD. ERC + check-reissue tiers added May 2026
 * for the TaxTaker POC.
 */

// ---------------------------------------------------------------------------
// Standard transcript ordering — the legacy SBA-lender intake mix
// ---------------------------------------------------------------------------

/** Per-entity pay-as-you-go transcript pull. Up to 3 years standard. */
export const PRICE_PAYG = 79.98;

/** Per-entity deposit-model transcript pull (volume discount tier). */
export const PRICE_DEPOSIT = 59.98;

/** Per-entity API platform-tier price (highest-volume customers). */
export const PRICE_PLATFORM = 39.99;

/** Monthly platform fee for API-tier customers. */
export const PRICE_PLATFORM_MONTHLY = 2500;

/** One-time deposit onboarding fee for the deposit billing model. */
export const PRICE_DEPOSIT_ONBOARDING = 2500;

// ---------------------------------------------------------------------------
// Add-ons
// ---------------------------------------------------------------------------

/** Entity Transcript (filing reqs + NAICS lookup) for EIN entities. */
export const PRICE_ENTITY_TRANSCRIPT = 19.99;

/** SBA Cash-Flow Pack PDF (auto-generated after transcripts complete). */
export const PRICE_CASH_FLOW_PACK = 49.99;

/** Monitoring enrollment fee (one-time per entity at enroll). */
export const PRICE_MONITORING_MONTHLY = 19.99;

/** Per-pull fee charged when a monitoring sweep returns fresh transcripts. */
export const PRICE_MONITORING_PER_PULL = 39.99;

// ---------------------------------------------------------------------------
// ERC / 941 tier — added May 2026 for TaxTaker POC
//
// Why distinct pricing: ERC analysis is materially more work per entity
// than standard SBA transcript pulls:
//   • Quarterly transcripts (4 per year) vs annual (1 per year) — 4× the
//     IRS PPS labor per year of coverage
//   • The eligible window spans 7 quarters (2020 Q2 → 2021 Q4) vs the
//     typical 3-year lookback
//   • Each quarter requires per-quarter status determination (TC 766, 846,
//     740, 290, 470, 971, 976, 977 interpretation)
//   • Post-call analysis output (ERC report) drives a meaningful client
//     decision (file 8822-B, appeal denial, etc.)
//
// Tier shape:
//   $79.98 base    — covers up to 3 ERC-eligible quarters + ERC analysis
//   +$79.98 premium — pulls ALL 6-7 eligible quarters (full coverage)
//
// Rationale on the premium amount: the full sweep takes roughly 2× the
// PPS-call airtime vs a 3-quarter pull (more transcripts to request, more
// agent interaction). Matching the base price keeps the math simple and
// gives partners a clear "double for double the coverage" framing.
// ---------------------------------------------------------------------------

/** Base ERC entity request — covers up to 3 ERC-eligible quarters. */
export const PRICE_ERC_BASE = 79.98;

/**
 * Premium add-on to pull ALL eligible ERC quarters (2020 Q2–Q4 + 2021 Q1–Q3,
 * plus Q4 2021 for Recovery Startup Businesses). Total per-entity with the
 * premium = $79.98 + $79.98 = $159.96.
 */
export const PRICE_ERC_FULL_SWEEP_PREMIUM = 79.98;

/** Convenience: bundled "full ERC analysis" price (base + premium). */
export const PRICE_ERC_FULL_SWEEP_TOTAL = PRICE_ERC_BASE + PRICE_ERC_FULL_SWEEP_PREMIUM;

// ---------------------------------------------------------------------------
// Check Reissue Service — added May 2026 for TaxTaker POC
//
// When a 941 transcript shows TC 846 + TC 740 (refund issued + check
// returned undelivered), the client has money sitting at the IRS that
// won't move until someone calls the IRS and requests reissue. This is a
// distinct PPS call to a different IRS line (Business & Specialty Tax
// line, not the practitioner-priority service) and involves:
//
//   1. Confirming the address-of-record on file with IRS
//   2. Filing Form 8822-B if the address needs to change
//   3. Calling the reissuance line to request a new check
//   4. Tracking the reissue order to confirmation
//
// Flat per-check pricing reflects the bounded scope (one IRS call + form
// + follow-up). Each additional check on the same entity is the same
// price — even if pulled in the same engagement, each check is a
// separate IRS workflow.
// ---------------------------------------------------------------------------

/** Flat fee to recover one undelivered IRS refund check. */
export const PRICE_CHECK_REISSUE = 1000;

// ---------------------------------------------------------------------------
// Helper for currency formatting — used by UI surfaces that display prices.
// ---------------------------------------------------------------------------

export function fmtUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Same, but rounds to whole dollars when the cents are .00. */
export function fmtUsdShort(n: number): string {
  if (n === Math.floor(n)) return `$${n.toLocaleString('en-US')}`;
  return fmtUsd(n);
}
