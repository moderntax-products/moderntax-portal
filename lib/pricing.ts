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

/**
 * Standard per-request transcript price for all NEW / non-grandfathered
 * clients (2026-06-06). Net-new clients start here and must have a card on
 * file to order (auto-billed per order). Only two legacy clients are
 * grandfathered below their standard rate: Centerstone ($59.98 TR/ROA) and
 * California Statewide ($79.98 RT/ROA/CIVPEN). Their rates live explicitly on
 * their `clients.billing_rate_pdf/csv` rows; everyone else resolves to this.
 */
export const PRICE_STANDARD = 99.99;

/** Slugs of the only clients grandfathered below PRICE_STANDARD. */
export const GRANDFATHERED_CLIENT_SLUGS = ['centerstone', 'california-statewide-cdc', 'calstatewide', 'cal-statewide-cdc'];

/**
 * Prepaid credit packs (2026-06-06). Standard-plan clients pre-buy a USD credit
 * wallet; each request debits `ratePerRequest`. Buying more unlocks a lower
 * per-request rate:
 *   - $1,000 → $59.99/request (40% off the $99.99 standard)
 *   - $2,000 → $39.99/request (60% off)
 * The pack amount IS the dollars added to the wallet; the discount is expressed
 * as the reduced per-request debit rate.
 */
export interface CreditPack {
  id: 'credits-1000' | 'credits-2000';
  amount: number;          // USD added to the wallet (= price charged)
  ratePerRequest: number;  // per-request debit rate this purchase unlocks
  discountPct: number;     // off PRICE_STANDARD, for display
  label: string;
}
export const CREDIT_PACKS: CreditPack[] = [
  { id: 'credits-1000', amount: 1000, ratePerRequest: 59.99, discountPct: 40, label: '$1,000 credits — 40% off ($59.99/request)' },
  { id: 'credits-2000', amount: 2000, ratePerRequest: 39.99, discountPct: 60, label: '$2,000 credits — 60% off ($39.99/request)' },
];

export function getCreditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

/** The lower (better) of two per-request rates — used when stacking purchases. */
export function bestCreditRate(currentRate: number | null | undefined, packRate: number): number {
  const cur = typeof currentRate === 'number' && currentRate > 0 ? currentRate : PRICE_STANDARD;
  return Math.min(cur, packRate);
}

/** Per-request debit rate for a client (their locked-in credit_rate, else standard). */
export function creditRequestRate(client: { credit_rate?: number | null } | null | undefined): number {
  const r = client?.credit_rate;
  return typeof r === 'number' && r > 0 ? r : PRICE_STANDARD;
}

/** Can this client place `count` requests from their prepaid wallet right now? */
export function hasCreditsToOrder(
  client: { credit_balance?: number | null; credit_rate?: number | null } | null | undefined,
  count = 1,
): boolean {
  const balance = Number(client?.credit_balance) || 0;
  return balance >= creditRequestRate(client) * count;
}

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

/** Entity Transcript (filing reqs + NAICS lookup) for EIN entities.
 *  Free as of 2026-07-17 — a no-charge verification on every order (removes the
 *  volume-processor billing friction; BFC / Cal Statewide ask). */
export const PRICE_ENTITY_TRANSCRIPT = 0;

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

/**
 * Stripe Checkout variant of the same service — $0.01 lower than the
 * Mercury ACH price as a "pay now via card" psychological nudge. The
 * cent-shave covers Stripe's 2.9% + $0.30 = ~$29.30 processing fee
 * roughly even on the $999.99 charge. Customers who want net-15
 * invoicing pick the $1,000 Mercury route; customers who want to
 * just-pay-and-start pick this one.
 */
export const PRICE_CHECK_REISSUE_STRIPE = 999.99;

// ---------------------------------------------------------------------------
// Self-serve packs — added May 2026
//
// For prospects landing on /sample-transcripts/erc-report who want to try
// the service without first creating a portal account. They pay via Stripe
// Checkout (anonymous purchase, customer_creation: 'always'); after payment
// we onboard them off-platform: webhook emails matt@moderntax.io with the
// new customer's contact info, Matt creates their portal account + processes
// their requested EINs within 24 hours.
//
// Pricing reflects "try-before-you-onboard" psychology: the 3-pack matches
// the standard 3× per-entity ERC base, and the 5-pack offers a small
// volume discount to reward larger commits.
//
// NOTE on check-reissue: TWO billing paths now, customer's choice:
//   • Mercury ACH ($1,000) — manual invoice from Matt, net-15 friendly.
//     Flow lives at /api/billing/check-reissue-request (no Stripe;
//     just emails Matt to send a Mercury invoice).
//   • Stripe Checkout ($999.99) — pay-now-with-card variant. Lives in
//     this catalog as the 'check-reissue-stripe' SKU; the cent-shave
//     against the Mercury price approximately covers Stripe's
//     processing fee so net revenue lands in the same place.
// ---------------------------------------------------------------------------

/** 3 ERC entity pulls — exactly 3 × $79.98 (no discount). */
export const PRICE_ERC_STARTER_PACK = 239.94;
export const PRICE_ERC_STARTER_PACK_QUANTITY = 3;

/** 5 ERC entity pulls — small volume discount (~5%). */
export const PRICE_ERC_FIVE_PACK = 379.99;
export const PRICE_ERC_FIVE_PACK_QUANTITY = 5;

/**
 * Catalog of self-serve packs. Drives both /api/billing/self-serve-checkout
 * (price + product-name source-of-truth) and the /welcome page receipt.
 * Adding a new SKU = add a row here + adjust the union type below; no
 * other touch points needed.
 *
 * Check-reissue is intentionally NOT here — see the Mercury ACH note above.
 */
export const SELF_SERVE_CATALOG = {
  'erc-3-pack':            { price: PRICE_ERC_STARTER_PACK,        quantity: 3, name: 'ModernTax — ERC Starter Pack (3 entities)',   description: '3 ERC entity pulls. Each pulls 941 Account Transcripts for up to 3 ERC-eligible quarters + auto-generates the per-quarter ERC status report.' },
  'erc-5-pack':            { price: PRICE_ERC_FIVE_PACK,           quantity: 5, name: 'ModernTax — ERC 5-Pack (volume discount)',     description: '5 ERC entity pulls — saves vs. ordering individually. Each pulls 941 Account Transcripts for up to 3 ERC-eligible quarters + auto-generates the ERC status report.' },
  'erc-full-sweep':        { price: PRICE_ERC_FULL_SWEEP_TOTAL,    quantity: 1, name: 'ModernTax — ERC Full Sweep (single entity)',   description: 'One ERC entity pull covering ALL 6–7 ERC-eligible quarters (2020 Q2–Q4 + 2021 Q1–Q3, plus Q4 2021 for Recovery Startup Businesses).' },
  'check-reissue-stripe':  { price: PRICE_CHECK_REISSUE_STRIPE,    quantity: 1, name: 'ModernTax — IRS Check Reissue Recovery Service', description: 'Recover one undelivered IRS refund check. We file Form 8822-B + call the IRS Business & Specialty Tax line on the client\'s behalf. Flat per-check fee. Service typically completes in 4–8 weeks plus mail delivery time.' },
} as const;

export type SelfServePackId = keyof typeof SELF_SERVE_CATALOG;

// ---------------------------------------------------------------------------
// 2026-05-28 SKU expansion — driven by Centerstone renegotiation +
// Enterprise Bank discovery + the broader product-stack synthesis. Three
// new SKUs, each tied to a specific customer ask:
//   - REORDER:      Mathew Paek (Centerstone) "fine to charge us again
//                   as long as it shows" → explicit reorder SKU at a
//                   discount vs. new request.
//   - POST_CLOSE_MONITORING: Derek + Jasmine (Enterprise) named this as
//                   their primary use case ("we condition for tax
//                   returns to be filed... reconcile post closing").
//                   Flat monthly rate replaces the legacy per-pull
//                   model (PRICE_MONITORING_PER_PULL) for clarity.
//   - CONSOLIDATION_REPORT: Mathew Paek's "loan with 15 affiliates"
//                   pipeline growth → per-loan SKU separate from
//                   per-entity verification, sold to the underwriter.
// ---------------------------------------------------------------------------

/**
 * Reorder pricing — clone of a prior completed entity into a fresh
 * request with new years. Discounted vs. PRICE_DEPOSIT because:
 *   1. The existing 8821 is reused (no Dropbox Sign cost)
 *   2. Vision/OCR results cached from the source entity
 *   3. Expert PPS time is ~30% of a new pull (less identity verification,
 *      designee already known)
 * Surfaces in /admin/email-intake "Reorder from history" tab.
 */
export const PRICE_REORDER = 29.99;

/**
 * Post-close monitoring — flat monthly rate per enrolled entity, runs
 * until the IRS finally has the transcript and we auto-unenroll. Matt
 * confirmed this is the model going forward on the 2026-05-27
 * Centerstone + Enterprise Bank calls. Replaces the legacy
 * PRICE_MONITORING_MONTHLY ($19.99 enrollment) +
 * PRICE_MONITORING_PER_PULL ($39.99 per fresh transcript) pair, which
 * was confusing customers and producing surprise bills. The legacy
 * constants stay exported for backwards-compat with auto-invoice cron
 * paths that haven't been migrated yet.
 */
export const PRICE_POST_CLOSE_MONITORING_MONTHLY = 29.00;

/**
 * Loan-package consolidation report — single PDF + Excel that rolls up
 * findings across all entities on a multi-entity loan. Sold per-loan
 * (not per-entity), targets the underwriter / credit officer (not the
 * loan processor). Anchored at $99 to drive adoption; revisit upward
 * once we have signal on attach rate.
 */
export const PRICE_CONSOLIDATION_REPORT = 99.00;

/** Minimum entity count on a loan before the consolidation report is offered. */
export const CONSOLIDATION_REPORT_MIN_ENTITIES = 3;

/**
 * Filing-Compliance Report (2026-06-01, Banc of California pilot — Erin Wilsey
 * ask). A standalone product that returns civil-penalty assessments + filed vs.
 * unfiled status from the IRS Account Transcript WITHOUT pulling income/wage
 * transcripts. Lighter than a full verification ($59.98) — priced like a
 * reorder to drive pilot volume. Ordered per individual/entity.
 */
export const PRICE_FILING_COMPLIANCE = 29.99;

/**
 * Back-year return filing (ModernTax Direct) — flat $50 per prior-year return
 * we prepare and file for a direct taxpayer client (e.g. Marquis Steadman's
 * delinquent 2020/2022/2023/2025 1040s). Billed per year filed, paid by the
 * client through the portal AFTER the returns are completed (see
 * /api/billing/filing-fee-checkout + components/FilingFeePayment). Matt
 * 2026-06-23.
 */
export const PRICE_BACKYEAR_FILING = 50.00;

/**
 * Expedited ("rush") back-year filing premium (ModernTax Direct) — a flat fee
 * a direct taxpayer can pay ON TOP of the per-year filing fee to jump the
 * expert queue and get a priority SLA (rush=true routes them to the front of
 * assignment + a tighter turnaround). One flat fee per order, not per year.
 * The $50/yr base is only a starting quote — the assigned expert quotes the
 * full price once they have context, so this rush fee is the incremental
 * upcharge for speed, independent of the eventual quoted total. Configurable
 * via the PRICE_FILING_EXPEDITE_FEE env override. Matt 2026-06-30.
 */
export const PRICE_FILING_EXPEDITE_FEE =
  Number(process.env.PRICE_FILING_EXPEDITE_FEE) > 0
    ? Number(process.env.PRICE_FILING_EXPEDITE_FEE)
    : 99.00;

// ---------------------------------------------------------------------------
// Unified invoice SKU catalog — single source of truth for Mercury line
// items + Stripe Products. Used by:
//   - scripts/register-invoice-skus-stripe.ts (creates Stripe Products
//     + Prices, writes IDs back to env/DB)
//   - Mercury invoice creation (line-item name + unit price)
//   - The per-loan billing forecast widget on intake surfaces
//   - The auto-invoice cron when building the breakdown PDF
//
// Each entry encodes everything billing systems need:
//   - sku:         stable identifier used in code + DB writes
//   - name:        what the customer sees on their invoice
//   - description: longer-form explanation for invoice PDF + Stripe portal
//   - unitPrice:   USD amount per unit (entity / loan / month, see cadence)
//   - cadence:     'one_time' | 'monthly' (drives Stripe recurring config)
//   - unit:        'entity' | 'loan' | 'enrollment' (for line-item math)
//   - stripeMetadata: tags written to Stripe products for searchability
// ---------------------------------------------------------------------------

export type SkuCadence = 'one_time' | 'monthly';
export type SkuUnit = 'entity' | 'loan' | 'enrollment' | 'pack';

export interface InvoiceSku {
  sku: string;
  name: string;
  description: string;
  unitPrice: number;
  cadence: SkuCadence;
  unit: SkuUnit;
  stripeMetadata: Record<string, string>;
}

export const INVOICE_SKU_CATALOG: Record<string, InvoiceSku> = {
  // Verification tiers — match the three customer contracts today.
  'verification-self-serve': {
    sku: 'verification-self-serve',
    name: 'Tax Verification (Self-Serve)',
    description: 'Per-entity IRS tax verification on Self-Serve tier. Client uploads pre-signed 8821. Includes Record of Account + Tax Return Transcripts for up to 3 years.',
    unitPrice: 49.98,
    cadence: 'one_time',
    unit: 'entity',
    stripeMetadata: { tier: 'self_serve', category: 'verification' },
  },
  'verification-managed': {
    sku: 'verification-managed',
    name: 'Tax Verification (Managed)',
    description: 'Per-entity IRS tax verification on Managed tier. ModernTax handles 8821 acquisition + signing. Includes Record of Account + Tax Return Transcripts for up to 3 years.',
    unitPrice: PRICE_DEPOSIT, // 59.98
    cadence: 'one_time',
    unit: 'entity',
    stripeMetadata: { tier: 'managed', category: 'verification' },
  },
  'verification-enterprise': {
    sku: 'verification-enterprise',
    name: 'Tax Verification (Enterprise)',
    description: 'Per-entity IRS tax verification on Enterprise tier. Includes Record of Account + Tax Return Transcripts for up to 3 years, plus same-day SLA + dedicated expert routing + portfolio reporting eligibility.',
    unitPrice: PRICE_PAYG, // 79.98
    cadence: 'one_time',
    unit: 'entity',
    stripeMetadata: { tier: 'enterprise', category: 'verification' },
  },

  // Reorder — new 2026-05-28 SKU.
  'reorder-from-history': {
    sku: 'reorder-from-history',
    name: 'Tax Verification — Reorder',
    description: 'Re-pull of an existing entity for new years. Reuses the prior signed 8821 (within 120-day validity window). Discounted vs. a new request.',
    unitPrice: PRICE_REORDER, // 29.99
    cadence: 'one_time',
    unit: 'entity',
    stripeMetadata: { tier: 'add_on', category: 'reorder' },
  },

  // Monitoring — new flat monthly model.
  'post-close-monitoring': {
    sku: 'post-close-monitoring',
    name: 'Post-Close Monitoring',
    description: 'Monthly per-entity monitoring while we re-poll the IRS until the conditioned transcript lands. Auto-cancels the month the transcript arrives. Replaces the legacy enrollment + per-pull bill.',
    unitPrice: PRICE_POST_CLOSE_MONITORING_MONTHLY, // 29.00
    cadence: 'monthly',
    unit: 'enrollment',
    stripeMetadata: { tier: 'add_on', category: 'monitoring' },
  },

  // Loan-package consolidation — new per-loan SKU.
  'loan-consolidation-report': {
    sku: 'loan-consolidation-report',
    name: 'Loan-Package Consolidation Report',
    description: `Underwriter-ready PDF + Excel consolidating findings across every entity on a multi-entity loan (filing status, no-record-found years with reason codes, civil penalty flags, aggregate exposure). Offered on loans with ${CONSOLIDATION_REPORT_MIN_ENTITIES}+ entities.`,
    unitPrice: PRICE_CONSOLIDATION_REPORT, // 99.00
    cadence: 'one_time',
    unit: 'loan',
    stripeMetadata: { tier: 'add_on', category: 'reporting' },
  },

  // Existing add-ons brought into the catalog for unified handling.
  'entity-transcript-addon': {
    sku: 'entity-transcript-addon',
    name: 'Entity Transcript Add-On',
    description: 'Pre-verification entity transcript that confirms IRS filing requirements + NAICS code before we pull the income transcripts. Reduces blank-result frustration on form-type mismatches.',
    unitPrice: PRICE_ENTITY_TRANSCRIPT, // 19.99
    cadence: 'one_time',
    unit: 'entity',
    stripeMetadata: { tier: 'add_on', category: 'verification' },
  },
  'cash-flow-pack': {
    sku: 'cash-flow-pack',
    name: 'SBA Cash-Flow Pack',
    description: 'Auto-generated cash-flow analysis PDF after the income transcripts complete. DSCR, trend, and ratio analysis ready for underwriter review.',
    unitPrice: PRICE_CASH_FLOW_PACK, // 49.99
    cadence: 'one_time',
    unit: 'entity',
    stripeMetadata: { tier: 'add_on', category: 'reporting' },
  },

  // Filing-Compliance Report — standalone, no income transcripts.
  'filing-compliance-report': {
    sku: 'filing-compliance-report',
    name: 'Filing-Compliance Report',
    description: 'Standalone IRS filing-compliance check: civil-penalty assessments + filed vs. unfiled status per year, sourced from the IRS Account Transcript. Does NOT include income/wage transcripts.',
    unitPrice: PRICE_FILING_COMPLIANCE, // 29.99
    cadence: 'one_time',
    unit: 'entity',
    stripeMetadata: { tier: 'add_on', category: 'compliance' },
  },
};

export type InvoiceSkuId = keyof typeof INVOICE_SKU_CATALOG;

/**
 * Resolve the billable rate + product kind for a completed entity from its
 * `gross_receipts` JSONB. Centralizes per-entity pricing so the invoice cron,
 * the breakdown PDF, and the live /invoicing projection all agree.
 *
 * - Filing-Compliance Report  → $29.99 (account transcript only)
 * - Reorder-from-history       → $29.99 (reuses prior 8821)
 * - Everything else            → the client's contracted PDF rate
 */
export function entityBillableRate(
  grossReceipts: any,
  clientRatePdf: number,
): { price: number; kind: 'standard' | 'reorder' | 'filing_compliance' } {
  if (grossReceipts?.product_type === 'filing_compliance') {
    return { price: PRICE_FILING_COMPLIANCE, kind: 'filing_compliance' };
  }
  if (grossReceipts?.reorder?.sku === 'reorder-from-history') {
    return { price: PRICE_REORDER, kind: 'reorder' };
  }
  return { price: clientRatePdf, kind: 'standard' };
}

/**
 * Resolve a client's standard per-request rate by intake method. Reads the
 * explicit `billing_rate_pdf` / `billing_rate_csv` on the client row and falls
 * back to PRICE_STANDARD ($99.99) when unset — so any new client without an
 * explicit contracted rate bills at the standard price. Grandfathered clients
 * (Centerstone, Cal Statewide) carry their lower rate explicitly on the row.
 */
export function clientRequestRate(
  client: { billing_rate_pdf?: number | null; billing_rate_csv?: number | null } | null | undefined,
  intakeMethod: 'pdf' | 'csv' | string = 'pdf',
): number {
  const col = intakeMethod === 'csv' ? client?.billing_rate_csv : client?.billing_rate_pdf;
  return typeof col === 'number' ? col : PRICE_STANDARD;
}

/** Resolve an SKU ID to its catalog entry. Throws if unknown — fail loud. */
export function getInvoiceSku(sku: string): InvoiceSku {
  const entry = INVOICE_SKU_CATALOG[sku];
  if (!entry) {
    throw new Error(`Unknown invoice SKU: ${sku}. Add it to INVOICE_SKU_CATALOG in lib/pricing.ts.`);
  }
  return entry;
}

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
