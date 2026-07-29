'use client';

/**
 * ModernTax Direct — the taxpayer experience.
 *
 * A single, outcome-oriented surface for a direct-to-taxpayer client: it tells
 * them where they stand with the IRS (diagnosis), frames the fix as OUTCOMES
 * (recover refunds / file back taxes / resolve what you owe), and presents a
 * line-itemed Purchase Order they can approve and pay in one Stripe checkout.
 *
 * Replaces the old experience where a `direct_user` was dumped onto the
 * partner request layout with no narrative. Built around the taxpayer, not the
 * transcript. Matt 2026-07-27.
 */

import { useState } from 'react';
import { OUTCOME_META, type DirectPurchaseOrder, type DetectedSituation, type OutcomeKey } from '@/lib/direct-purchase-order';
import { DirectResolutionRoadmap } from '@/components/DirectResolutionRoadmap';

const usd = (n: number) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usd0 = (n: number) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

interface Props {
  token: string;
  entityName: string;
  po: DirectPurchaseOrder;
  situation: DetectedSituation;
  resolution?: any;
  ownerName?: string;
  alreadyPaid: boolean;
}

export default function DirectExperience({ token, entityName, po, situation, resolution, ownerName, alreadyPaid }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paid = alreadyPaid || po.status === 'paid';
  const hasContingency = po.lineItems.some((l) => l.billing === 'contingency');
  const showWindow = !paid && !!situation.payrollBalance && !!situation.preEnforcement;
  const firstName = (ownerName || '').trim().split(/\s+/)[0] || '';

  function downloadSummary() {
    // Print-to-PDF the on-page diagnosis + plan + order, so the owner can hand
    // a clean leave-behind to their own CPA / tax attorney.
    window.print();
  }

  async function pay() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/direct-po-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start checkout');
      window.location.href = data.url;
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  }

  // The headline figure: prefer the biggest concrete number in the situation.
  const heroNumber =
    situation.payrollPayoff || situation.payrollBalance || situation.undeliveredRefunds || 0;
  const heroKind = situation.payrollBalance
    ? 'owed in back payroll taxes'
    : situation.undeliveredRefunds
      ? 'in refunds waiting at the IRS'
      : 'in IRS exposure';

  const outcomes = po.outcomes as OutcomeKey[];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: #fff !important; }
          section { break-inside: avoid; }
        }
      `}</style>
      {/* ── Hero ───────────────────────────────────────────────── */}
      <div className="bg-gradient-to-br from-mt-dark via-mt-navy to-mt-dark text-white">
        <div className="max-w-4xl mx-auto px-6 py-10">
          <div className="flex items-center gap-2 mb-8">
            <span className="text-mt-green font-black text-lg tracking-tight">ModernTax</span>
            <span className="text-white/40 text-sm">Direct</span>
          </div>
          <p className="text-white/60 text-sm mb-1">Prepared for {entityName}</p>
          <h1 className="text-2xl sm:text-3xl font-bold leading-tight mb-4">
            {firstName ? `${firstName}, here's` : "Here's"} exactly where {entityName} stands with the IRS — and how we fix it.
          </h1>
          {heroNumber > 0 && (
            <div className="inline-flex items-baseline gap-3 bg-white/5 border border-white/10 rounded-xl px-5 py-4 mt-2">
              <span className="text-3xl sm:text-4xl font-black text-white">{usd0(heroNumber)}</span>
              <span className="text-white/60 text-sm">{heroKind}</span>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
        {paid && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-5 flex items-start gap-3">
            <span className="text-2xl">✅</span>
            <div>
              <p className="font-semibold text-emerald-900">You&apos;re all set — your order is confirmed.</p>
              <p className="text-emerald-800 text-sm mt-0.5">
                Your ModernTax case team has been notified and will reach out within one business day to begin. PO {po.poNumber}.
              </p>
            </div>
          </div>
        )}

        {showWindow && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
            <span className="text-xl">⏳</span>
            <p className="text-sm text-amber-900">
              <span className="font-semibold">You still have the window.</span> No lien, levy notice, or Revenue Officer has
              been filed on your account yet — so we can resolve this on your terms before the IRS enforcement machine turns
              on. That advantage is measured in weeks, not months.
            </p>
          </div>
        )}

        {/* ── Diagnosis ─────────────────────────────────────────── */}
        <section>
          <h2 className="text-lg font-bold mb-3">Where you stand</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {situation.payrollBalance && situation.payrollBalance > 0 && (
              <DiagCard
                sev="crit"
                title="Unpaid payroll taxes"
                value={usd0(situation.payrollPayoff || situation.payrollBalance)}
                body={`Across ${situation.payrollQuartersOpen || 'several'} quarters. This is trust-fund money the IRS pursues aggressively${
                  situation.shareholderExposure ? ' — and the owners can be held personally liable (TFRP).' : '.'
                }`}
              />
            )}
            {situation.undeliveredRefunds && situation.undeliveredRefunds > 0 && (
              <DiagCard
                sev="opp"
                title="Refunds the IRS never delivered"
                value={usd0(situation.undeliveredRefunds)}
                body={`${situation.undeliveredCount || 1} refund${
                  (situation.undeliveredCount || 1) === 1 ? '' : 's'
                } issued to you but returned undelivered. Recoverable with a Form 3911 filing.`}
              />
            )}
            {situation.unfiledYears && situation.unfiledYears.length > 0 && (
              <DiagCard
                sev="warn"
                title="Delinquent returns"
                value={`${situation.unfiledYears.length} year${situation.unfiledYears.length === 1 ? '' : 's'}`}
                body="Unfiled federal returns keep penalties accruing and block any state payment plan. We file them for you."
              />
            )}
            {situation.hasPenalties && (
              <DiagCard
                sev="warn"
                title="Penalties & interest accruing"
                value="Reducible"
                body="Much of the balance is penalties. First-time-abatement or reasonable-cause requests can remove a large share of it."
              />
            )}
          </div>
        </section>

        {/* ── Outcome tracks ────────────────────────────────────── */}
        <section>
          <h2 className="text-lg font-bold mb-3">Your plan</h2>
          <div className="space-y-3">
            {outcomes.map((oc) => {
              const meta = OUTCOME_META[oc];
              const items = po.lineItems.filter((l) => l.outcome === oc);
              return (
                <div key={oc} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-2xl">{meta.icon}</span>
                    <div>
                      <h3 className="font-bold">{meta.label}</h3>
                      <p className="text-xs text-gray-500">{meta.tagline}</p>
                    </div>
                  </div>
                  <ul className="space-y-2">
                    {items.map((l) => (
                      <li key={l.code} className="text-sm text-gray-700 flex gap-2">
                        <span className="text-mt-green mt-0.5">→</span>
                        <span>
                          <span className="font-semibold text-gray-900">{l.label}.</span> {l.description}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── Optional resolution roadmap (reuses the Direct roadmap) ── */}
        {resolution && (Array.isArray(resolution.unfiled_years) ? resolution.unfiled_years.length : true) && (
          <section>
            <h2 className="text-lg font-bold mb-3">The order we do it in</h2>
            <DirectResolutionRoadmap resolution={resolution} />
          </section>
        )}

        {/* ── How it works ──────────────────────────────────────── */}
        <section>
          <h2 className="text-lg font-bold mb-3">How it works</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { n: 1, t: 'You approve', b: 'Approve the plan and start the first phase. Or download the summary and take it to your own advisor — no obligation.' },
              { n: 2, t: 'An expert opens your case', b: 'A dedicated IRS-credentialed specialist (CAF authorization already on file) is assigned within one business day.' },
              { n: 3, t: 'We move before enforcement', b: 'We lock down current compliance and negotiate the agreement through the IRS — while your account is still clean.' },
              { n: 4, t: 'We keep the owners shielded', b: 'We structure payments to protect you personally (TFRP) and keep you updated at every step until it&apos;s resolved.' },
            ].map((s) => (
              <div key={s.n} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
                <div className="w-7 h-7 rounded-full bg-mt-dark text-white flex items-center justify-center text-xs font-bold mb-2">
                  {s.n}
                </div>
                <p className="font-semibold text-sm text-gray-900">{s.t}</p>
                <p className="text-xs text-gray-500 mt-1" dangerouslySetInnerHTML={{ __html: s.b }} />
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-gray-500">
            <span>✓ IRS-authorized (CAF on file)</span>
            <span>✓ Licensed tax professionals — CPAs &amp; EAs</span>
            <span>✓ No obligation to opt in</span>
          </div>
        </section>

        {/* ── Purchase order ────────────────────────────────────── */}
        <section>
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold">Your order</h2>
                <p className="text-xs text-gray-500">Purchase order {po.poNumber}</p>
              </div>
              <StatusPill status={paid ? 'paid' : po.status} />
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
                  <th className="px-5 py-2 font-medium">Service</th>
                  <th className="px-5 py-2 font-medium text-right">Qty</th>
                  <th className="px-5 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {po.lineItems.map((l) => (
                  <tr key={l.code} className="border-t border-gray-100">
                    <td className="px-5 py-3">
                      <span className="font-medium text-gray-900">{l.label}</span>
                      {l.billLater && (
                        <span className="ml-2 text-[10px] font-bold uppercase text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 whitespace-nowrap">
                          {l.billTrigger}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-500">{l.qty}</td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      {l.billLater ? (
                        <span className="text-amber-700">
                          {l.billing === 'contingency' ? '~' : ''}
                          {usd(l.amount)}
                        </span>
                      ) : (
                        usd(l.amount)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {po.deferredTotal > 0 && (
                  <tr className="border-t border-gray-100">
                    <td className="px-5 py-2 text-gray-500" colSpan={2}>Total engagement</td>
                    <td className="px-5 py-2 text-right text-gray-700 tabular-nums">{usd(po.engagementTotal)}</td>
                  </tr>
                )}
                {po.creditApplied > 0 && (
                  <tr className="border-t border-gray-100">
                    <td className="px-5 py-2 text-gray-500" colSpan={2}>Account credit applied</td>
                    <td className="px-5 py-2 text-right text-mt-green tabular-nums">−{usd(po.creditApplied)}</td>
                  </tr>
                )}
                <tr className="border-t-2 border-gray-200 bg-gray-50">
                  <td className="px-5 py-3 font-bold" colSpan={2}>{po.deferredTotal > 0 ? 'Due today to begin' : 'Due today'}</td>
                  <td className="px-5 py-3 text-right font-black text-lg tabular-nums">{usd(po.chargeableTotal)}</td>
                </tr>
              </tfoot>
            </table>

            {po.deferredTotal > 0 && (
              <p className="px-5 py-3 text-xs text-gray-500 border-t border-gray-100">
                {hasContingency
                  ? `Refund-recovery work is billed only if we succeed — an estimated ${usd(
                      po.deferredTotal,
                    )} on the funds we actually recover. Nothing for it is charged today.`
                  : `This is a phased engagement. Only the first phase is due today to begin the pre-emptive strike; the remaining ${usd(
                      po.deferredTotal,
                    )} bills as each phase starts.`}
              </p>
            )}

            {!paid && (
              <div className="px-5 py-5 border-t border-gray-100 no-print">
                {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
                <div className="flex flex-col sm:flex-row gap-3">
                  <button
                    onClick={pay}
                    disabled={loading || po.chargeableTotal <= 0}
                    className="flex-1 bg-mt-green hover:brightness-95 disabled:opacity-50 text-white font-bold px-8 py-3 rounded-lg transition"
                  >
                    {loading ? 'Starting secure checkout…' : `Approve & have our experts begin — ${usd(po.chargeableTotal)}`}
                  </button>
                  <button
                    onClick={downloadSummary}
                    className="sm:w-auto border border-gray-300 hover:border-gray-400 text-gray-700 font-semibold px-6 py-3 rounded-lg transition"
                  >
                    Download summary
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-3">
                  Secure payment by Stripe. Approving authorizes ModernTax&apos;s IRS-credentialed expert network to begin the
                  work above. Prefer your own CPA or tax attorney? <span className="text-gray-500 font-medium">Download the
                  summary</span> and hand it to them — it has everything they need to start.
                </p>
              </div>
            )}
          </div>
        </section>

        {/* ── Trust footer ──────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-gray-400 pt-2">
          <span>🔒 Bank-level encryption</span>
          <span>IRS-authorized (CAF on file)</span>
          <span>Questions? support@moderntax.io</span>
        </div>
      </div>
    </div>
  );
}

function DiagCard({ sev, title, value, body }: { sev: 'crit' | 'warn' | 'opp'; title: string; value: string; body: string }) {
  const styles =
    sev === 'crit'
      ? 'border-red-200 bg-red-50'
      : sev === 'opp'
        ? 'border-emerald-200 bg-emerald-50'
        : 'border-amber-200 bg-amber-50';
  const valColor = sev === 'crit' ? 'text-red-700' : sev === 'opp' ? 'text-emerald-700' : 'text-amber-700';
  return (
    <div className={`rounded-xl border p-4 ${styles}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</p>
      <p className={`text-2xl font-black mt-1 ${valColor}`}>{value}</p>
      <p className="text-sm text-gray-600 mt-1">{body}</p>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-600',
    approved: 'bg-amber-100 text-amber-700',
    paid: 'bg-emerald-100 text-emerald-700',
    void: 'bg-gray-100 text-gray-400 line-through',
  };
  return (
    <span className={`text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full ${map[status] || map.draft}`}>
      {status}
    </span>
  );
}
