/**
 * /plans — Plan tiers + add-on tour.
 *
 * The destination for every "Compare plans" CTA from the dashboard panels.
 * Visitors include:
 *   - Logged-in managers / processors weighing an upgrade
 *   - Prospects following a marketing link (no auth required)
 *
 * Page structure:
 *   1. Hero with the value prop in one line
 *   2. Three-tier comparison table (PAYG / Deposit / Platform)
 *   3. Add-on cards (Continuous Monitoring, Cash-Flow Analysis Pack)
 *   4. "How it works" walkthrough for each add-on
 *   5. Lifecycle revenue example (the $700/loan year-1 number)
 *   6. FAQ
 *   7. CTAs — "Talk to sales" mailto + "Back to dashboard" for signed-in users
 *
 * Server component for SEO + speed. Auth state read for CTA personalization
 * but never required.
 */

import Link from 'next/link';
import { createServerComponentClient } from '@/lib/supabase-server';
import { TierUpgradeButton } from '@/components/TierUpgradeButton';
// Single source of truth: lib/pricing.ts INVOICE_SKU_CATALOG. No more
// drift between this marketing page, the cron, and the forecast widget.
import {
  PRICE_PAYG,
  PRICE_DEPOSIT,
  PRICE_PLATFORM,
  PRICE_PLATFORM_MONTHLY,
  PRICE_DEPOSIT_ONBOARDING,
  PRICE_POST_CLOSE_MONITORING_MONTHLY,
  PRICE_ERC_BASE,
  PRICE_ERC_FULL_SWEEP_TOTAL,
  PRICE_CHECK_REISSUE,
  PRICE_CASH_FLOW_PACK,
  PRICE_ENTITY_TRANSCRIPT,
  PRICE_REORDER,
  PRICE_CONSOLIDATION_REPORT,
  CONSOLIDATION_REPORT_MIN_ENTITIES,
} from '@/lib/pricing';

export const metadata = {
  title: 'Plans & Add-Ons — ModernTax',
  description: 'Compare ModernTax plan tiers and add-ons for SBA lender teams. PAYG, Deposit, Platform tiers + Premium SLA upgrade + Post-Close Monitoring, Loan-Package Consolidation Report, Reorder, Cash-Flow Analysis Pack add-ons.',
};

interface PlansPageProps {
  searchParams: Promise<{ upgrade?: string; tier?: string; session_id?: string }>;
}

export default async function PlansPage({ searchParams }: PlansPageProps) {
  const { upgrade: upgradeStatus, tier: upgradedTier } = await searchParams;
  // Read auth state so signed-in users see a personalized CTA (back to their
  // dashboard) instead of a generic sign-up prompt.
  const supabase = await createServerComponentClient();
  const { data: { user } } = await supabase.auth.getUser();
  let isSignedIn = false;
  let role: string | null = null;
  if (user) {
    isSignedIn = true;
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single() as { data: { role: string } | null };
    role = profile?.role || null;
  }

  return (
    <div className="min-h-screen bg-white">
      {/* ---------- Top nav ---------- */}
      <nav className="border-b border-gray-200 bg-white sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between">
          <Link href="/" className="text-xl font-bold text-mt-dark">ModernTax</Link>
          <div className="flex items-center gap-3">
            {isSignedIn ? (
              <Link
                href={role === 'admin' ? '/admin' : '/'}
                className="text-sm font-semibold text-mt-green hover:underline"
              >
                ← Back to dashboard
              </Link>
            ) : (
              <Link
                href="/login"
                className="text-sm font-semibold text-mt-dark hover:underline"
              >
                Sign in
              </Link>
            )}
            <a
              href="mailto:matt@moderntax.io?subject=ModernTax%20pricing"
              className="px-3 py-1.5 text-sm font-semibold bg-mt-dark text-white rounded-lg hover:bg-gray-800"
            >
              Talk to sales
            </a>
          </div>
        </div>
      </nav>

      {/* Tier-upgrade return banners. Stripe redirects back to
          /plans?upgrade=success|cancel after Checkout. Webhook handles the
          actual billing_model flip; the banner is just user-visible feedback. */}
      {upgradeStatus === 'success' && (
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pt-6">
          <div className="rounded-xl bg-emerald-50 border-2 border-emerald-300 p-4 flex items-start gap-3">
            <svg className="w-6 h-6 shrink-0 text-emerald-700" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/>
            </svg>
            <div>
              <p className="text-sm font-bold text-emerald-900">Tier {upgradedTier || ''} upgrade in progress</p>
              <p className="text-xs text-emerald-800 mt-0.5">
                Your payment was received by Stripe. Billing rates and tier flag will update on your account within ~10 seconds (the webhook is finalizing now). Refresh your dashboard if you don&rsquo;t see the change immediately.
              </p>
            </div>
          </div>
        </div>
      )}
      {upgradeStatus === 'cancel' && (
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pt-6">
          <div className="rounded-xl bg-amber-50 border-2 border-amber-300 p-4 flex items-start gap-3">
            <svg className="w-6 h-6 shrink-0 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <p className="text-sm font-bold text-amber-900">Upgrade canceled</p>
              <p className="text-xs text-amber-800 mt-0.5">
                You backed out of Stripe Checkout. No charge, no billing change. Click any tier button below to try again.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Hero ---------- */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-12 pb-8 text-center">
        <h1 className="text-4xl sm:text-5xl font-bold text-mt-dark tracking-tight">
          Pick the plan that grows with your loan portfolio.
        </h1>
        <p className="mt-4 text-lg text-gray-600 max-w-2xl mx-auto">
          ModernTax pricing scales with how you do SBA underwriting — pay per pull, prepay a deposit, or run on the Platform tier with API access. Add-ons turn each funded loan into recurring revenue.
        </p>
        <div className="mt-6 inline-flex gap-3 text-xs text-gray-500">
          <span className="inline-flex items-center gap-1">
            <svg className="w-3.5 h-3.5 text-mt-green" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/></svg>
            No setup fee on PAYG
          </span>
          <span className="inline-flex items-center gap-1">
            <svg className="w-3.5 h-3.5 text-mt-green" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/></svg>
            Switch tiers any time
          </span>
          <span className="inline-flex items-center gap-1">
            <svg className="w-3.5 h-3.5 text-mt-green" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/></svg>
            Prepaid credits — save up to 60%
          </span>
        </div>
      </section>

      {/* ---------- Tier comparison ---------- */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Tier A — PAYG */}
          <div className="bg-white rounded-xl border-2 border-gray-200 p-6 flex flex-col">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-mt-dark">Tier A · Pay-As-You-Go</h3>
            </div>
            <p className="text-xs text-gray-500 mt-1">Best for &lt;15 loans/month</p>
            <div className="mt-4 mb-4">
              <span className="text-4xl font-bold text-mt-dark">${PRICE_PAYG}</span>
              <span className="text-gray-600 text-sm"> / verified entity</span>
            </div>
            <p className="text-sm text-gray-600 mb-4">Bill monthly via Mercury for what your team actually pulled. No commitment.</p>
            <ul className="space-y-2 text-sm text-gray-700 flex-1">
              <Feature>Unlimited team seats</Feature>
              <Feature>CSV / PDF / email intake</Feature>
              <Feature>Auto-sent 8821s via Dropbox Sign</Feature>
              <Feature>Return Transcripts + Records of Account</Feature>
              <Feature>Compliance flag screening</Feature>
              <Feature>Prepaid credits — as low as $39.99/pull</Feature>
            </ul>
            <a
              href="mailto:matt@moderntax.io?subject=Start%20on%20Tier%20A%20(PAYG)"
              className="mt-6 px-4 py-2.5 text-sm font-semibold bg-white border-2 border-mt-dark text-mt-dark rounded-lg hover:bg-gray-50 text-center"
            >
              Start PAYG
            </a>
          </div>

          {/* Tier B — Deposit */}
          <div className="bg-white rounded-xl border-2 border-mt-green p-6 flex flex-col relative shadow-md">
            <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-mt-green text-white text-[11px] font-bold px-3 py-1 rounded-full uppercase tracking-wide">
              Most popular
            </span>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-mt-dark">Tier B · Deposit</h3>
            </div>
            <p className="text-xs text-gray-500 mt-1">Best for 15–60 loans/month</p>
            <div className="mt-4 mb-4">
              <span className="text-4xl font-bold text-mt-dark">${PRICE_DEPOSIT}</span>
              <span className="text-gray-600 text-sm"> / verified entity</span>
              <p className="text-xs text-gray-500 mt-1">25% off PAYG · ${PRICE_DEPOSIT_ONBOARDING.toLocaleString()} prepaid balance</p>
            </div>
            <p className="text-sm text-gray-600 mb-4">Prepay a $2,500 balance to lock the lower per-pull rate. Each verification draws against the balance.</p>
            <ul className="space-y-2 text-sm text-gray-700 flex-1">
              <Feature highlight>Everything in PAYG</Feature>
              <Feature highlight>25% lower per-pull rate</Feature>
              <Feature highlight>Priority support (4h response)</Feature>
              <Feature highlight>Quarterly account reviews</Feature>
              <Feature highlight>Bulk Fire-All-8821s for processors</Feature>
            </ul>
            <div className="mt-6">
              <TierUpgradeButton tier="B" isSignedIn={isSignedIn} variant="primary-green" />
              <p className="text-[11px] text-gray-500 text-center mt-1.5">
                Pay $2,500 deposit via Stripe — rate locks instantly
              </p>
            </div>
          </div>

          {/* Tier C — Platform */}
          <div className="bg-mt-dark text-white rounded-xl p-6 flex flex-col">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold">Tier C · Platform</h3>
            </div>
            <p className="text-xs text-gray-400 mt-1">Best for 60+ loans/month or LOS integrations</p>
            <div className="mt-4 mb-4">
              <span className="text-4xl font-bold">${PRICE_PLATFORM}</span>
              <span className="text-gray-300 text-sm"> / verified entity</span>
              <p className="text-xs text-gray-400 mt-1">+ ${PRICE_PLATFORM_MONTHLY.toLocaleString()}/mo subscription · 50% off PAYG</p>
            </div>
            <p className="text-sm text-gray-300 mb-4">Lowest per-pull rate, dedicated API, white-label borrower doc hub, and SLAs.</p>
            <ul className="space-y-2 text-sm text-gray-200 flex-1">
              <Feature dark>Everything in Deposit</Feature>
              <Feature dark>50% lower per-pull rate</Feature>
              <Feature dark>REST API + webhook delivery</Feature>
              <Feature dark>White-label borrower doc hub</Feature>
              <Feature dark>Dedicated CSM + 24h SLA</Feature>
              <Feature dark>SOC 2 documentation</Feature>
            </ul>
            <div className="mt-6">
              <TierUpgradeButton tier="C" isSignedIn={isSignedIn} variant="primary-green" />
              <p className="text-[11px] text-gray-400 text-center mt-1.5">
                $2,500/mo subscription via Stripe — start instantly
              </p>
            </div>
          </div>
        </div>

        <p className="mt-4 text-xs text-gray-500 text-center">
          All tiers include audit logging, MFA, and IRS Practitioner Priority Service routing. Tier upgrades require an MSA signature.
        </p>
      </section>

      {/* ---------- Add-ons ---------- */}
      <section className="bg-gray-50 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-mt-dark">Add-ons that extend each funded loan</h2>
            <p className="mt-3 text-gray-600 max-w-2xl mx-auto">
              Every plan tier supports these add-ons. They turn one-time per-pull revenue into ongoing per-loan revenue across the full 25-year SBA loan life.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Add-on 1 — Post-Close Monitoring (refreshed 2026-05-29 to
                match the new flat-rate SKU at $29/mo, auto-cancel on
                transcript arrival). Replaces the legacy $19.99 enrollment
                + $39.99 per-pull model — same value, simpler bill. */}
            <AddOnCard
              colorClass="border-emerald-300 bg-gradient-to-br from-emerald-50 to-white"
              accentClass="bg-emerald-100 text-emerald-800"
              icon={
                <svg className="w-6 h-6 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
              }
              title="Post-Close Monitoring"
              priceLine={`$${PRICE_POST_CLOSE_MONITORING_MONTHLY}/entity/mo · auto-cancel`}
              tagline="One flat fee until the transcript lands"
              body="When a borrower owes a tax return as a closing condition, enroll the entity in monitoring at intake. We re-poll the IRS monthly until the conditioned transcript arrives, then auto-cancel — no manual unenroll, no per-pull surprise. One predictable line item per entity per month."
              steps={[
                { title: 'Opt in at intake', body: 'Per-entity checkbox on every intake flow. Manager can also flip on team-wide auto-enroll from the dashboard.' },
                { title: 'Monthly IRS sweep', body: 'Cron re-pulls Records of Account on a 30-day cadence using the same expert pipeline as your initial verification. Cadence configurable per client.' },
                { title: 'Auto-cancel on landing', body: 'The first month the conditioned transcript actually lands, the enrollment closes itself. You stop being billed. No "did I remember to unenroll" cleanup.' },
                { title: 'Compliance screening', body: 'Every pull runs the flag screener. CLEAN / WARNING / CRITICAL severity tags so your servicing team can triage at a glance.' },
              ]}
              cta={{
                href: isSignedIn && role === 'manager' ? '/' : 'mailto:matt@moderntax.io?subject=Enable%20Post-Close%20Monitoring',
                label: isSignedIn && role === 'manager' ? 'Toggle on from your dashboard →' : 'Enable monitoring →',
              }}
            />

            {/* Add-on 2 — Cash-Flow Analysis Pack */}
            <AddOnCard
              colorClass="border-indigo-300 bg-gradient-to-br from-indigo-50 to-white"
              accentClass="bg-indigo-100 text-indigo-800"
              icon={
                <svg className="w-6 h-6 text-indigo-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              }
              title="Cash-Flow Analysis Pack"
              priceLine={`$${PRICE_CASH_FLOW_PACK}/loan`}
              tagline="Skip 30 minutes of underwriter Excel work"
              body="An SBA-format 3-year cash-flow worksheet, auto-rendered from each entity's transcripts the moment they're complete. Gross receipts, total income, deductions, net income, total tax — all five lines pre-filled. Add-back rows (depreciation, interest, owner comp, non-recurring) wait for the underwriter to fill in."
              steps={[
                { title: 'Generate per-entity', body: 'On any completed entity, the "+ Cash-Flow Pack ($49.99)" button renders the PDF in a few seconds. Two-step confirm prevents accidental spend.' },
                { title: 'Or auto-attach team-wide', body: 'Manager toggles "Auto-attach" in the team panel. Every newly-completed entity gets the pack generated + billed automatically.' },
                { title: 'SBA-format worksheet', body: 'Three-year side-by-side table. Gross receipts → total income → total deductions → net income → total tax. Sources cited at the bottom (e.g., 1120S Record of Account 2024).' },
                { title: 'Underwriter fill-in rows', body: 'Pre-formatted boxes for Depreciation, Interest, Owner Comp, Non-recurring items. Adjusted Cash Flow row in green at the bottom.' },
              ]}
              cta={{
                href: isSignedIn ? '/' : 'mailto:matt@moderntax.io?subject=Enable%20Cash-Flow%20Pack',
                label: isSignedIn ? 'Generate one from your dashboard →' : 'Enable pack →',
              }}
            />
          </div>

          {/* Add-on: ERC / 941 analysis — new for May 2026 (TaxTaker POC) */}
          <div className="mt-6 bg-white rounded-xl border-2 border-amber-300 p-5">
            <div className="flex items-start gap-4 flex-wrap">
              <div className="shrink-0 w-10 h-10 bg-amber-100 rounded-lg flex items-center justify-center">
                <svg className="w-5 h-5 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-mt-dark">ERC / 941 Analysis</h3>
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                    ${PRICE_ERC_BASE} base · ${PRICE_ERC_FULL_SWEEP_TOTAL} full sweep
                  </span>
                </div>
                <p className="text-sm text-gray-600 mt-1">
                  For ERC-recovery firms working stuck claims. We pull the 941 Account Transcripts, parse the IRS
                  transaction codes (TC 766 / 846 / 740 / 290 / 470 / 971), and deliver an auto-generated per-quarter
                  status report: refund paid, claim pending, denied, or check returned undelivered.
                </p>
                <ul className="text-xs text-gray-600 mt-2 space-y-0.5 list-disc list-inside">
                  <li><strong>Base ${PRICE_ERC_BASE}/entity</strong> — up to 3 ERC-eligible quarters + automated ERC report</li>
                  <li><strong>Full sweep ${PRICE_ERC_FULL_SWEEP_TOTAL}/entity</strong> — all 6–7 eligible quarters (2020 Q2–Q4, 2021 Q1–Q3, plus Q4 2021 for Recovery Startup Businesses)</li>
                </ul>
              </div>
            </div>
          </div>

          {/* Add-on: Check Reissue Service — new for May 2026 */}
          <div className="mt-6 bg-white rounded-xl border-2 border-emerald-300 p-5">
            <div className="flex items-start gap-4 flex-wrap">
              <div className="shrink-0 w-10 h-10 bg-emerald-100 rounded-lg flex items-center justify-center">
                <svg className="w-5 h-5 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-mt-dark">Check Reissue Recovery Service</h3>
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
                    ${PRICE_CHECK_REISSUE.toLocaleString()}/check
                  </span>
                </div>
                <p className="text-sm text-gray-600 mt-1">
                  When the ERC report surfaces a refund-returned-undelivered status (IRS issued a check but it came
                  back), we recover it on the client&apos;s behalf. Flat fee per check — typically 30–50× ROI relative
                  to the refund amount being recovered.
                </p>
                <ul className="text-xs text-gray-600 mt-2 space-y-0.5 list-disc list-inside">
                  <li>File Form 8822-B with the IRS to update the business address of record</li>
                  <li>Call the IRS Business &amp; Specialty Tax line to request reissue</li>
                  <li>Track the reissue order to delivery + confirm with the client</li>
                  <li>Each additional check on the same entity is the same flat fee — no per-quarter markup</li>
                </ul>
              </div>
            </div>
          </div>

          {/* Add-on 3 — Entity Transcript (already shipped, included for completeness) */}
          <div className="mt-6 bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-start gap-4 flex-wrap">
              <div className="shrink-0 w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                <svg className="w-5 h-5 text-blue-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-mt-dark">Entity Transcript Add-On</h3>
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-blue-100 text-blue-800">
                    ${PRICE_ENTITY_TRANSCRIPT}/entity
                  </span>
                </div>
                <p className="text-sm text-gray-600 mt-1">
                  Add an Entity Transcript to any verification. Pulls business filing requirements, NAICS, establishment date — useful for SBA size-standard checks and KYB.
                </p>
              </div>
              <a
                href={isSignedIn ? '/new/csv' : 'mailto:matt@moderntax.io?subject=Entity%20Transcript%20Add-On'}
                className="px-3 py-2 text-xs font-semibold bg-white border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 whitespace-nowrap"
              >
                {isSignedIn ? 'Add to next upload' : 'Learn more'}
              </a>
            </div>
          </div>

          {/* Add-on 4 — Reorder from history (new SKU 2026-05-28).
              Discounted re-pull when the existing 8821 is reused. */}
          <div className="mt-6 bg-white rounded-xl border border-violet-300 p-5">
            <div className="flex items-start gap-4 flex-wrap">
              <div className="shrink-0 w-10 h-10 bg-violet-100 rounded-lg flex items-center justify-center">
                <svg className="w-5 h-5 text-violet-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-mt-dark">Reorder from history</h3>
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-violet-100 text-violet-800">
                    ${PRICE_REORDER}/entity
                  </span>
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">50% off new verification</span>
                </div>
                <p className="text-sm text-gray-600 mt-1">
                  Re-pull a prior entity for new years (e.g. amended 2024 return just landed). We reuse the existing 8821 when it&apos;s within the 120-day validity window — no CSV upload, no re-signature, no full verification rate. One-click from the processor dashboard.
                </p>
                <p className="text-xs text-gray-500 mt-1.5">
                  Why discounted: 8821 is cached, vision/OCR results are cached, expert PPS time is ~30% of a new pull. Fair to the customer, profitable to us.
                </p>
              </div>
              <a
                href={isSignedIn ? '/new/reorder' : 'mailto:matt@moderntax.io?subject=Reorder%20from%20history'}
                className="px-3 py-2 text-xs font-semibold bg-white border border-violet-300 text-violet-700 rounded-lg hover:bg-violet-50 whitespace-nowrap"
              >
                {isSignedIn ? 'Open reorder flow →' : 'Learn more'}
              </a>
            </div>
          </div>

          {/* Add-on 5 — Loan-Package Consolidation Report (new SKU
              2026-05-28). Per-loan SKU for the underwriter. */}
          <div className="mt-6 bg-white rounded-xl border border-indigo-300 p-5">
            <div className="flex items-start gap-4 flex-wrap">
              <div className="shrink-0 w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center">
                <svg className="w-5 h-5 text-indigo-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-mt-dark">Loan-Package Consolidation Report</h3>
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-indigo-100 text-indigo-800">
                    ${PRICE_CONSOLIDATION_REPORT}/loan
                  </span>
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-gray-100 text-gray-700">
                    {CONSOLIDATION_REPORT_MIN_ENTITIES}+ entities
                  </span>
                </div>
                <p className="text-sm text-gray-600 mt-1">
                  One PDF that consolidates findings across every entity on a multi-entity loan: filing status, no-record-found years with reason codes, civil penalty flags, aggregate balance-due exposure, and a recommended underwriter next-step. Designed for the 15-affiliate-loan cases — solves the &quot;now I have 15 separate PDFs, how do I read these as a portfolio&quot; problem.
                </p>
                <p className="text-xs text-gray-500 mt-1.5">
                  Sold per-loan (not per-entity). Different buyer (the underwriter / credit officer) than per-entity verification (the loan processor). Auto-generated on demand from the request detail page.
                </p>
              </div>
              <a
                href={isSignedIn ? '/' : 'mailto:matt@moderntax.io?subject=Loan-Package%20Consolidation%20Report'}
                className="px-3 py-2 text-xs font-semibold bg-white border border-indigo-300 text-indigo-700 rounded-lg hover:bg-indigo-50 whitespace-nowrap"
              >
                {isSignedIn ? 'Generate from a request →' : 'Learn more'}
              </a>
            </div>
          </div>

          {/* Add-on 6 — Premium SLA tier upgrade. Same-day turnaround
              target + expert-routing priority. */}
          <div className="mt-6 bg-gradient-to-r from-violet-50 to-indigo-50 rounded-xl border-2 border-violet-300 p-5">
            <div className="flex items-start gap-4 flex-wrap">
              <div className="shrink-0 w-10 h-10 bg-violet-200 rounded-lg flex items-center justify-center">
                <span className="text-xl">⚡</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-violet-900">Premium SLA</h3>
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-violet-200 text-violet-900">
                    Account upgrade
                  </span>
                </div>
                <p className="text-sm text-violet-900 mt-1">
                  Upgrade your whole account to a same-day turnaround target on every verification. Your loans get expert-routing priority on the assignment queue, you get a Premium SLA badge across your customer-facing surfaces, and your team gets dedicated SLA monitoring on every request.
                </p>
                <ul className="text-xs text-violet-800 mt-2 space-y-0.5 list-disc list-inside">
                  <li>Same-day target on standard pulls (vs. 24-48h on standard accounts)</li>
                  <li>Expert-routing priority — your loans jump the assignment queue</li>
                  <li>Premium SLA badge on the dashboard + request detail pages</li>
                  <li>Dedicated SLA tracking + escalation when a request slips</li>
                </ul>
              </div>
              <a
                href={isSignedIn ? '/' : 'mailto:matt@moderntax.io?subject=Upgrade%20to%20Premium%20SLA'}
                className="px-3 py-2 text-xs font-semibold bg-violet-600 text-white rounded-lg hover:bg-violet-700 whitespace-nowrap"
              >
                {isSignedIn ? 'Request upgrade →' : 'Talk to sales'}
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- Lifecycle revenue example ---------- */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="bg-mt-dark text-white rounded-2xl p-8 sm:p-12">
          <h2 className="text-2xl sm:text-3xl font-bold">What one funded SBA loan is worth</h2>
          <p className="mt-2 text-gray-300 text-sm">Average 7(a) loan with 3 entities (borrower + 2 affiliates) on Tier A (PAYG).</p>

          <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white/5 rounded-lg p-5">
              <div className="text-xs uppercase tracking-wide text-gray-400">Intake (Days 1–60)</div>
              <div className="mt-2 text-3xl font-bold">${(3 * PRICE_PAYG + PRICE_CASH_FLOW_PACK + PRICE_CONSOLIDATION_REPORT).toFixed(0)}</div>
              <div className="text-xs text-gray-400 mt-1">3 verifications @ ${PRICE_PAYG} = ${(3 * PRICE_PAYG).toFixed(2)}</div>
              <div className="mt-1 text-xs text-gray-400">+ ${PRICE_CASH_FLOW_PACK} cash-flow pack</div>
              <div className="mt-1 text-xs text-gray-400">+ ${PRICE_CONSOLIDATION_REPORT} consolidation report</div>
            </div>
            <div className="bg-white/5 rounded-lg p-5">
              <div className="text-xs uppercase tracking-wide text-gray-400">Post-close (avg)</div>
              <div className="mt-2 text-3xl font-bold">${(3 * PRICE_POST_CLOSE_MONITORING_MONTHLY * 4 + PRICE_REORDER).toFixed(0)}</div>
              <div className="text-xs text-gray-400 mt-1">3 entities × ${PRICE_POST_CLOSE_MONITORING_MONTHLY}/mo × ~4 months</div>
              <div className="mt-1 text-xs text-gray-400">until the conditioned transcript lands (auto-cancels)</div>
              <div className="mt-1 text-xs text-gray-400">+ ~1 reorder @ ${PRICE_REORDER}</div>
            </div>
            <div className="bg-mt-green/20 border border-mt-green rounded-lg p-5">
              <div className="text-xs uppercase tracking-wide text-mt-green">Year-1 total per loan</div>
              <div className="mt-2 text-3xl font-bold text-mt-green">~${(3 * PRICE_PAYG + PRICE_CASH_FLOW_PACK + PRICE_CONSOLIDATION_REPORT + 3 * PRICE_POST_CLOSE_MONITORING_MONTHLY * 4 + PRICE_REORDER).toFixed(0)}</div>
              <div className="text-xs text-mt-green mt-1">vs. ~${(3 * PRICE_PAYG).toFixed(0)} verifications-only</div>
              <div className="mt-3 text-sm text-gray-300">~{((3 * PRICE_PAYG + PRICE_CASH_FLOW_PACK + PRICE_CONSOLIDATION_REPORT + 3 * PRICE_POST_CLOSE_MONITORING_MONTHLY * 4 + PRICE_REORDER) / (3 * PRICE_PAYG)).toFixed(1)}× ARPU lift per loan</div>
            </div>
          </div>

          <p className="mt-6 text-sm text-gray-300">
            For a lender funding ~70 loans/year (Centerstone, Cal Statewide scale): <strong className="text-white">~${Math.round((3 * PRICE_PAYG + PRICE_CASH_FLOW_PACK + PRICE_CONSOLIDATION_REPORT + 3 * PRICE_POST_CLOSE_MONITORING_MONTHLY * 4 + PRICE_REORDER) * 70 / 1000)}K/yr add-on revenue</strong> on top of base verification at PAYG. Tier B and Tier C convert more of that into prepaid + recurring MRR.
          </p>
        </div>
      </section>

      {/* ---------- FAQ ---------- */}
      <section className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pb-20">
        <h2 className="text-2xl font-bold text-mt-dark text-center mb-8">FAQ</h2>
        <div className="space-y-4">
          <Faq q="Can I switch tiers mid-month?">
            Yes. Tier downgrades take effect the next billing cycle (1st of the following month). Upgrades take effect immediately and prorate the difference. Switching requires an MSA amendment.
          </Faq>
          <Faq q="What happens to my prepaid Tier B balance if I leave?">
            Unused balance is refunded within 30 days of termination. Any verifications in flight at termination still draw against the balance.
          </Faq>
          <Faq q="Does monitoring renew automatically?">
            Post-Close Monitoring runs at ${PRICE_POST_CLOSE_MONITORING_MONTHLY}/entity/mo until the conditioned transcript actually lands at the IRS, then auto-cancels — no manual unenroll. Most entities self-cancel within 2-6 months. Manager can also pause or cancel any individual entity from the monitoring panel at any time.
          </Faq>
          <Faq q="Can I generate a Cash-Flow Pack on a loan I already closed?">
            Yes — any completed entity can generate a pack from the entity card. The pack uses whatever transcripts are on file. If you re-pull transcripts, generate a fresh pack.
          </Faq>
          <Faq q="Is the Cash-Flow Pack acceptable for SBA submission?">
            The pack is a worksheet, not a substitute for the underwriter&rsquo;s full credit memo. SBA expects the lender to verify all add-back assumptions; the pack just removes the data-entry step.
          </Faq>
          <Faq q="How does pricing work?">
            Prepaid credits power every order. Load $1,000 and your rate drops to $59.99/pull (40% off); load $2,000 for $39.99/pull (60% off). Add a card, buy credits, and your whole team can order.
          </Faq>
        </div>
      </section>

      {/* ---------- Bottom CTA ---------- */}
      <section className="bg-mt-green/10 border-y border-mt-green/30 py-16 text-center">
        <h2 className="text-3xl font-bold text-mt-dark">Ready to extend each loan?</h2>
        <p className="mt-3 text-gray-600 max-w-xl mx-auto">
          15-minute call walks you through the right tier + add-ons for your loan volume. We&rsquo;ll get your team ordering with credits in real time.
        </p>
        <div className="mt-6 flex gap-3 justify-center flex-wrap">
          <a
            href="https://meetings.hubspot.com/matt-moderntax/moderntax-intro"
            target="_blank"
            rel="noopener noreferrer"
            className="px-6 py-3 text-sm font-semibold bg-mt-green text-white rounded-lg hover:bg-emerald-600"
          >
            Book a 15-min call
          </a>
          <a
            href="mailto:matt@moderntax.io?subject=ModernTax%20pricing%20question"
            className="px-6 py-3 text-sm font-semibold bg-white border-2 border-mt-dark text-mt-dark rounded-lg hover:bg-gray-50"
          >
            Email matt@moderntax.io
          </a>
          {isSignedIn && (
            <Link
              href={role === 'admin' ? '/admin' : '/'}
              className="px-6 py-3 text-sm font-semibold text-mt-dark hover:underline"
            >
              ← Back to dashboard
            </Link>
          )}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents (server-rendered, presentational only)
// ---------------------------------------------------------------------------

function Feature({ children, highlight = false, dark = false }: { children: React.ReactNode; highlight?: boolean; dark?: boolean }) {
  const checkColor = dark ? 'text-mt-green' : highlight ? 'text-mt-green' : 'text-gray-500';
  return (
    <li className="flex items-start gap-2">
      <svg className={`w-4 h-4 mt-0.5 shrink-0 ${checkColor}`} fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/>
      </svg>
      <span>{children}</span>
    </li>
  );
}

function AddOnCard(props: {
  colorClass: string;
  accentClass: string;
  icon: React.ReactNode;
  title: string;
  priceLine: string;
  tagline: string;
  body: string;
  steps: Array<{ title: string; body: string }>;
  cta: { href: string; label: string };
}) {
  return (
    <div className={`rounded-2xl border-2 p-6 ${props.colorClass}`}>
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${props.accentClass.split(' ')[0]}`}>
          {props.icon}
        </div>
        <div>
          <h3 className="text-xl font-bold text-mt-dark">{props.title}</h3>
          <p className={`text-xs font-semibold ${props.accentClass}`}>{props.priceLine}</p>
        </div>
      </div>
      <p className="text-sm font-semibold text-mt-dark">{props.tagline}</p>
      <p className="text-sm text-gray-700 mt-2 leading-relaxed">{props.body}</p>

      <h4 className="mt-5 text-xs font-bold uppercase tracking-wide text-gray-500">How it works</h4>
      <ol className="mt-2 space-y-3">
        {props.steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className={`shrink-0 w-6 h-6 rounded-full ${props.accentClass} flex items-center justify-center text-xs font-bold`}>
              {i + 1}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-mt-dark">{s.title}</div>
              <div className="text-xs text-gray-600 mt-0.5">{s.body}</div>
            </div>
          </li>
        ))}
      </ol>

      <a
        href={props.cta.href}
        className="mt-6 inline-flex items-center gap-1 text-sm font-semibold text-mt-dark hover:underline"
      >
        {props.cta.label}
      </a>
    </div>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="bg-white rounded-lg border border-gray-200 px-5 py-3 group">
      <summary className="font-semibold text-mt-dark cursor-pointer list-none flex items-center justify-between">
        {q}
        <svg className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd"/>
        </svg>
      </summary>
      <p className="mt-3 text-sm text-gray-600 leading-relaxed">{children}</p>
    </details>
  );
}
