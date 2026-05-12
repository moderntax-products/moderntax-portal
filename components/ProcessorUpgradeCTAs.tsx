'use client';

/**
 * ProcessorUpgradeCTAs — slim banner for processor-role dashboards.
 *
 * Processors don't control client-level toggles (those live on the manager
 * Upgrade-Your-Team panel), but they should still see the per-feature value
 * prop so they ask their manager to turn it on. This banner shows up to two
 * inline CTAs:
 *
 *   1. Cash-Flow Pack — visible when the processor has at least one completed
 *      entity. Pitches the $49.99/loan SBA worksheet with an inline
 *      "ask your manager" mailto link.
 *
 *   2. Continuous Monitoring — visible when monitoringDefaultEnabled=false on
 *      the client AND the team has any completed entities. Pitches recurring
 *      revenue + default-risk early warning.
 *
 * Both CTAs collapse silently when irrelevant (zero completed entities, or
 * the feature is already enabled).
 */

import Link from 'next/link';

interface ProcessorUpgradeCTAsProps {
  monitoringDefaultEnabled: boolean;
  monitoredEntitiesCount: number;
  unmonitoredCompletedCount: number;
  cashFlowAutoAttach: boolean;
  managerEmail?: string | null;
  /** Processor's full name for the mailto subject. */
  processorName?: string;
}

export function ProcessorUpgradeCTAs({
  monitoringDefaultEnabled,
  monitoredEntitiesCount: _monitoredEntitiesCount,
  unmonitoredCompletedCount,
  cashFlowAutoAttach,
  managerEmail,
  processorName,
}: ProcessorUpgradeCTAsProps) {
  const hasCompleted = unmonitoredCompletedCount > 0;
  const showMonitoring = !monitoringDefaultEnabled && hasCompleted;
  const showCashFlow = !cashFlowAutoAttach && hasCompleted;

  if (!showMonitoring && !showCashFlow) return null;

  const askManagerHref = managerEmail
    ? `mailto:${managerEmail}?subject=${encodeURIComponent(`${processorName || 'Processor'}: Enable ModernTax add-ons`)}&body=${encodeURIComponent(
        `Hey,\n\nI'd like to enable the following ModernTax add-ons for our team:\n\n` +
          (showMonitoring ? `• Continuous Monitoring ($19.99/entity/mo) — auto-pulls fresh transcripts every quarter on every funded loan, flags new tax liens / balance dues / unfiled returns. Catches default risk before servicing.\n\n` : '') +
          (showCashFlow ? `• Cash-Flow Analysis Pack ($49.99/loan) — auto-renders SBA-format 3-year cash-flow worksheet from the transcripts I pull. Saves underwriting ~30 min per file.\n\n` : '') +
          `Both are toggle-on from your dashboard ("Upgrade Your Team" panel). Worth a look.\n\n` +
          `Thanks!`,
      )}`
    : `/`;

  return (
    <div className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-3">
      {/* CTA 1 — Cash-Flow Pack */}
      {showCashFlow && (
        <div className="bg-gradient-to-br from-indigo-50 to-white border border-indigo-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <div className="shrink-0 w-9 h-9 bg-indigo-100 rounded-lg flex items-center justify-center">
              <svg className="w-5 h-5 text-indigo-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold text-sm text-mt-dark">Skip 30 min of underwriter Excel work</h3>
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">$49.99/loan</span>
              </div>
              <p className="text-xs text-gray-600 mt-1">
                Auto-render an SBA-format cash-flow worksheet from each completed entity&rsquo;s transcripts.
                {' '}<strong>You can generate per-loan from any completed entity card</strong> — or ask your manager to auto-attach for the whole team.
              </p>
              <div className="mt-2 flex gap-3 items-center text-xs">
                {managerEmail ? (
                  <a href={askManagerHref} className="font-semibold text-indigo-700 hover:underline">
                    Ask your manager →
                  </a>
                ) : (
                  <Link href="/plans" className="font-semibold text-indigo-700 hover:underline">Learn more →</Link>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* CTA 2 — Continuous Monitoring */}
      {showMonitoring && (
        <div className="bg-gradient-to-br from-emerald-50 to-white border border-emerald-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <div className="shrink-0 w-9 h-9 bg-emerald-100 rounded-lg flex items-center justify-center">
              <svg className="w-5 h-5 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold text-sm text-mt-dark">Catch default risk before servicing</h3>
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">$19.99/entity/mo</span>
              </div>
              <p className="text-xs text-gray-600 mt-1">
                Continuous monitoring auto-pulls fresh transcripts every quarter on every funded loan
                and alerts on new tax liens, balance dues, or unfiled returns.
                {' '}<strong>{unmonitoredCompletedCount} completed loan{unmonitoredCompletedCount === 1 ? '' : 's'} not yet enrolled</strong>.
              </p>
              <div className="mt-2 flex gap-3 items-center text-xs">
                {managerEmail ? (
                  <a href={askManagerHref} className="font-semibold text-emerald-700 hover:underline">
                    Ask your manager to enable →
                  </a>
                ) : (
                  <Link href="/plans" className="font-semibold text-emerald-700 hover:underline">Learn more →</Link>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
