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

export const metadata = {
  title: 'Plans & Add-Ons — ModernTax',
  description: 'Compare ModernTax plan tiers and add-ons for SBA lender teams. PAYG, Deposit, and Platform tiers + Continuous Monitoring and Cash-Flow Analysis Pack add-ons.',
};

interface PlansPageProps {
  searchParams: Promise<{ upgrade?: string; tier?: string; session_id?: string }>;
}

// Pricing constants — kept in sync with the API/billing layer manually since
// they're spread across multiple route files. If pricing changes, grep for
// these dollar amounts in:
//   app/api/cron/auto-invoice/route.ts (per-pull rates + monitoring rate)
//   app/api/cash-flow/generate/route.ts (CASH_FLOW_PACK_PRICE)
//   components/UpgradeYourTeamPanel.tsx (display constants)
//   lib/repeat-entity.ts (MONITORING_PER_PULL_FEE)
const PRICE_PAYG = 79.98;
const PRICE_DEPOSIT = 59.98;
const PRICE_PLATFORM = 39.99;
const PRICE_PLATFORM_MONTHLY = 2500;
const PRICE_DEPOSIT_ONBOARDING = 2500;
const PRICE_MONITORING_MONTHLY = 19.99;
const PRICE_ERC_BASE = 79.98;
const PRICE_ERC_FULL_SWEEP_TOTAL = 159.96;
const PRICE_CHECK_REISSUE = 1000;
const PRICE_MONITORING_PER_PULL = 39.99;
const PRICE_CASH_FLOW_PACK = 49.99;
const PRICE_ENTITY_TRANSCRIPT = 19.99;

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
            3 free trial pulls
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
              <Feature>3 free trial pulls</Feature>
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
            {/* Add-on 1 — Continuous Monitoring */}
            <AddOnCard
              colorClass="border-emerald-300 bg-gradient-to-br from-emerald-50 to-white"
              accentClass="bg-emerald-100 text-emerald-800"
              icon={
                <svg className="w-6 h-6 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
              }
              title="Continuous Monitoring"
              priceLine={`$${PRICE_MONITORING_MONTHLY}/entity/mo · $${PRICE_MONITORING_PER_PULL}/pull`}
              tagline="Catch default risk before servicing"
              body="Automatically pull fresh transcripts every quarter on every funded loan. The minute a borrower picks up a new tax lien, balance due, or unfiled return, your servicing team gets an alert — months before it would have shown up in a manual annual review."
              steps={[
                { title: 'Auto-enroll on completion', body: 'When an entity reaches "Complete," it auto-enrolls in quarterly monitoring (default-on, opt-out per client).' },
                { title: 'Quarterly transcript pull', body: 'Cron pulls Records of Account every 90 days at the per-pull rate. Same expert pipeline as your initial verification.' },
                { title: 'Compliance screening', body: 'Each pull runs the screener — flags balance dues, liens, audits, unfiled returns. Severity tagged CLEAN / WARNING / CRITICAL.' },
                { title: 'Alert + dashboard tile', body: 'Servicing dashboard shows monitored entities + new flags since last pull. Email alert on any CRITICAL change.' },
              ]}
              cta={{
                href: isSignedIn && role === 'manager' ? '/' : 'mailto:matt@moderntax.io?subject=Enable%20Continuous%20Monitoring',
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
        </div>
      </section>

      {/* ---------- Lifecycle revenue example ---------- */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="bg-mt-dark text-white rounded-2xl p-8 sm:p-12">
          <h2 className="text-2xl sm:text-3xl font-bold">What one funded SBA loan is worth</h2>
          <p className="mt-2 text-gray-300 text-sm">Average 7(a) loan with 3 entities (borrower + 2 affiliates).</p>

          <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white/5 rounded-lg p-5">
              <div className="text-xs uppercase tracking-wide text-gray-400">Phase 1–2 (Days 1–60)</div>
              <div className="mt-2 text-3xl font-bold">$240</div>
              <div className="text-xs text-gray-400 mt-1">3 entity verifications @ ${PRICE_PAYG}</div>
              <div className="mt-3 text-sm text-gray-300">+ ${PRICE_CASH_FLOW_PACK} cash-flow pack</div>
            </div>
            <div className="bg-white/5 rounded-lg p-5">
              <div className="text-xs uppercase tracking-wide text-gray-400">Year 1 monitoring</div>
              <div className="mt-2 text-3xl font-bold">$240</div>
              <div className="text-xs text-gray-400 mt-1">3 entities × ${PRICE_MONITORING_MONTHLY}/mo × 12</div>
              <div className="mt-3 text-sm text-gray-300">+ 4 quarterly pulls @ ${PRICE_MONITORING_PER_PULL}</div>
            </div>
            <div className="bg-mt-green/20 border border-mt-green rounded-lg p-5">
              <div className="text-xs uppercase tracking-wide text-mt-green">Year 1 total</div>
              <div className="mt-2 text-3xl font-bold text-mt-green">~$830</div>
              <div className="text-xs text-mt-green mt-1">vs. ~$240 (transcripts only)</div>
              <div className="mt-3 text-sm text-gray-300">Recurring through SBA loan life (10–25 years)</div>
            </div>
          </div>

          <p className="mt-6 text-sm text-gray-300">
            For a lender funding ~70 loans/year (Centerstone, Cal Statewide scale): <strong className="text-white">~$50K/yr new MRR by Q4</strong> with the add-ons enabled, on top of base verification revenue.
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
            Yes. Once an entity is enrolled it pulls quarterly indefinitely. Manager can pause or cancel any individual entity from the monitoring panel. Bulk pause/cancel via support.
          </Faq>
          <Faq q="Can I generate a Cash-Flow Pack on a loan I already closed?">
            Yes — any completed entity can generate a pack from the entity card. The pack uses whatever transcripts are on file. If you re-pull transcripts, generate a fresh pack.
          </Faq>
          <Faq q="Is the Cash-Flow Pack acceptable for SBA submission?">
            The pack is a worksheet, not a substitute for the underwriter&rsquo;s full credit memo. SBA expects the lender to verify all add-back assumptions; the pack just removes the data-entry step.
          </Faq>
          <Faq q="What's included in the trial?">
            3 free entity verifications across your team — applies to any tier on signup. After 3, billing kicks in at your tier&rsquo;s per-pull rate.
          </Faq>
        </div>
      </section>

      {/* ---------- Bottom CTA ---------- */}
      <section className="bg-mt-green/10 border-y border-mt-green/30 py-16 text-center">
        <h2 className="text-3xl font-bold text-mt-dark">Ready to extend each loan?</h2>
        <p className="mt-3 text-gray-600 max-w-xl mx-auto">
          15-minute call walks you through the right tier + add-ons for your loan volume. We&rsquo;ll set up a free trial in real time.
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
