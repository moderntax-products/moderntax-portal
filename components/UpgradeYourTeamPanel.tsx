'use client';

/**
 * UpgradeYourTeamPanel — Manager-only dashboard section.
 *
 * Shows the team's current add-on plan + projected MRR/per-loan revenue from
 * enabling each upgrade, with one-click toggles. Two upgrades land here today;
 * more will be added as new SKUs ship (annual reviews, eligibility scoring,
 * doc-hub etc.).
 *
 * Toggles bulk-apply across the whole client:
 *   • Continuous monitoring (default-on at completion) — $19.99/entity/mo
 *     The toggle flips clients.monitoring_default_enabled; existing
 *     enrollments are NOT cancelled when set false (only future
 *     auto-enrolls stop). Manager can also bulk-enroll any
 *     completed-but-unmonitored entities with a single click.
 *   • Cash-Flow Analysis Pack auto-attach — $49.99/loan
 *     When on, every completed loan auto-generates the pack as a billable
 *     add-on. When off (default), processors generate per-entity manually
 *     via CashFlowPackButton.
 *
 * Tier upgrade buttons (PAYG → Deposit → Platform) link to /plans where
 * the full feature tour + tier comparison + how-it-works walkthrough lives.
 * Tier upgrades themselves require an MSA signature (mailto sales).
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { TierUpgradeButton } from './TierUpgradeButton';

interface UpgradeYourTeamPanelProps {
  clientId: string;
  monitoringDefaultEnabled: boolean;
  cashFlowAutoAttach: boolean;
  monitoredEntitiesCount: number;
  unmonitoredCompletedCount: number;
}

const MONITORING_RATE = 19.99;     // per entity per month
const CASH_FLOW_PACK_PRICE = 49.99; // per pack

export function UpgradeYourTeamPanel({
  clientId,
  monitoringDefaultEnabled,
  cashFlowAutoAttach,
  monitoredEntitiesCount,
  unmonitoredCompletedCount,
}: UpgradeYourTeamPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [bulkEnrolling, setBulkEnrolling] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ enrolled: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const projectedMrr = unmonitoredCompletedCount * MONITORING_RATE;

  const updateClientFlag = async (flag: 'monitoring_default_enabled' | 'cash_flow_auto_attach', value: boolean) => {
    setError(null);
    try {
      const res = await fetch('/api/team/upgrade-toggles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, flag, value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update');
    }
  };

  const bulkEnrollMonitoring = async () => {
    setBulkEnrolling(true);
    setError(null);
    try {
      const res = await fetch('/api/team/bulk-enroll-monitoring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setBulkResult({ enrolled: body.enrolled || 0, skipped: body.skipped || 0 });
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk enroll failed');
    } finally {
      setBulkEnrolling(false);
    }
  };

  return (
    <section className="mb-8">
      <div className="bg-white rounded-xl border-2 border-mt-green/30 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-mt-green/10 to-transparent px-6 py-4 border-b border-mt-green/20">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h2 className="text-lg font-bold text-mt-dark flex items-center gap-2">
                <svg className="w-5 h-5 text-mt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
                Upgrade Your Team
              </h2>
              <p className="text-sm text-gray-600 mt-0.5">
                Default-on add-ons that turn each loan into recurring revenue + faster underwriting.
              </p>
            </div>
            <Link
              href="/plans"
              className="text-xs font-semibold text-mt-green hover:underline whitespace-nowrap"
            >
              Compare plans →
            </Link>
          </div>
        </div>

        <div className="divide-y divide-gray-100">
          {/* ROW 1 — Continuous Monitoring */}
          <div className="px-6 py-4 flex flex-col md:flex-row md:items-center gap-4 justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold text-mt-dark">Continuous Monitoring</h3>
                <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                  ${MONITORING_RATE}/entity/mo
                </span>
                {monitoringDefaultEnabled ? (
                  <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-green-100 text-green-800">DEFAULT ON</span>
                ) : (
                  <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">DEFAULT OFF</span>
                )}
              </div>
              <p className="text-xs text-gray-600 mt-1 leading-relaxed">
                Auto-pulls fresh transcripts every quarter on every funded loan.
                Early-warning alerts on new tax liens, balance dues, unfiled returns —
                catches default risk before it hits servicing.
                <strong className="text-gray-800"> Currently monitoring {monitoredEntitiesCount} entities</strong>
                {unmonitoredCompletedCount > 0 && (
                  <span className="text-amber-700">
                    {' '}· {unmonitoredCompletedCount} completed entities NOT yet enrolled
                    {' '}<strong>(~${projectedMrr.toFixed(0)}/mo MRR if you bulk-enroll)</strong>
                  </span>
                )}
              </p>
              {bulkResult && (
                <p className="text-xs text-emerald-700 mt-1.5">
                  ✓ Enrolled {bulkResult.enrolled} entities {bulkResult.skipped > 0 ? `· ${bulkResult.skipped} already enrolled` : ''}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2 items-stretch md:items-end shrink-0">
              <button
                onClick={() => updateClientFlag('monitoring_default_enabled', !monitoringDefaultEnabled)}
                disabled={isPending}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                  monitoringDefaultEnabled
                    ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    : 'bg-mt-green text-white hover:bg-emerald-600'
                } disabled:opacity-50`}
              >
                {monitoringDefaultEnabled ? 'Turn OFF default' : 'Turn ON default'}
              </button>
              {unmonitoredCompletedCount > 0 && (
                <button
                  onClick={bulkEnrollMonitoring}
                  disabled={bulkEnrolling}
                  className="px-3 py-1.5 text-xs font-semibold bg-emerald-50 border border-emerald-300 text-emerald-800 rounded-lg hover:bg-emerald-100 disabled:opacity-50 whitespace-nowrap"
                >
                  {bulkEnrolling ? 'Enrolling…' : `Bulk-enroll ${unmonitoredCompletedCount} now`}
                </button>
              )}
            </div>
          </div>

          {/* ROW 2 — Cash-Flow Analysis Pack */}
          <div className="px-6 py-4 flex flex-col md:flex-row md:items-center gap-4 justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold text-mt-dark">Cash-Flow Analysis Pack</h3>
                <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
                  ${CASH_FLOW_PACK_PRICE}/loan
                </span>
                {cashFlowAutoAttach ? (
                  <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-green-100 text-green-800">AUTO-ATTACH</span>
                ) : (
                  <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">MANUAL ONLY</span>
                )}
              </div>
              <p className="text-xs text-gray-600 mt-1 leading-relaxed">
                SBA-format 3-year cash-flow worksheet auto-rendered from each entity&rsquo;s
                transcripts. Replaces the ~30 min of Excel rekey your underwriter does
                today. When auto-attach is on, every completed entity generates the pack
                automatically and bills on the next invoice cycle.
              </p>
            </div>
            <div className="shrink-0">
              <button
                onClick={() => updateClientFlag('cash_flow_auto_attach', !cashFlowAutoAttach)}
                disabled={isPending}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                  cashFlowAutoAttach
                    ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    : 'bg-mt-green text-white hover:bg-emerald-600'
                } disabled:opacity-50`}
              >
                {cashFlowAutoAttach ? 'Turn OFF auto-attach' : 'Turn ON auto-attach'}
              </button>
            </div>
          </div>

          {/* ROW 3 — Tier upgrade. Self-serve via Stripe Checkout — no longer
              gated by mailto-to-sales. Tier B = $2,500 one-time deposit;
              Tier C = $2,500/mo subscription. Webhook flips billing_model +
              rates the moment payment confirms. */}
          <div className="px-6 py-4 bg-gray-50">
            <div className="flex items-center gap-2 mb-2">
              <h3 className="font-semibold text-mt-dark">Plan tier</h3>
              <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                PAYG / Deposit / Platform
              </span>
            </div>
            <p className="text-xs text-gray-600 mb-3 leading-relaxed">
              <strong>Tier B (Deposit):</strong> –25% per-pull rate after a $2,500 prepaid balance.
              {' '}<strong>Tier C (Platform):</strong> $39.99/entity flat + $2,500/mo subscription unlocks the borrower doc hub + API access.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <TierUpgradeButton tier="B" isSignedIn={true} variant="primary-dark" label="Upgrade to Tier B — $2,500 deposit" />
              <TierUpgradeButton tier="C" isSignedIn={true} variant="primary-dark" label="Upgrade to Tier C — $2,500/mo" />
              <Link
                href="/plans"
                className="inline-block w-full text-center px-4 py-2.5 text-sm font-semibold bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Compare tiers
              </Link>
            </div>
            <p className="mt-2 text-[11px] text-gray-500">
              Self-serve via Stripe — your billing rates update instantly on payment. No call required.
            </p>
          </div>
        </div>

        {error && (
          <p className="px-6 py-2 text-xs text-red-600 border-t border-red-200 bg-red-50">{error}</p>
        )}
      </div>
    </section>
  );
}
