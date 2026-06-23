'use client';

/**
 * ModernTax Direct — back-year filing fee payment.
 *
 * Renders on the request page once the returns are completed: shows the fee
 * ($50 × years filed) and a "Pay now" button that opens Stripe Checkout via
 * /api/billing/filing-fee-checkout. Only shown when the entity has a recorded
 * billable year count and isn't already paid.
 *
 * Built 2026-06-23 (Matt: "$50 for each back year, payment via the portal
 * after completion").
 */

import { useState } from 'react';

interface Props {
  entityId: string;
  entityName: string;
  yearsFiled: number;
  feePerYear: number;
  /** Account credit applied (e.g. the ModernTax Direct deposit). */
  creditApplied?: number;
  paid?: boolean;
}

export function FilingFeePayment({ entityId, entityName, yearsFiled, feePerYear, creditApplied = 0, paid }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gross = yearsFiled * feePerYear;
  const credit = Math.min(creditApplied, gross);
  const total = gross - credit;

  const pay = async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/billing/filing-fee-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.url) { setError(data?.error || 'Could not start checkout.'); return; }
      window.location.href = data.url;
    } catch (err: any) {
      setError(err?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  };

  if (paid) {
    return (
      <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4 flex items-center gap-3">
        <svg className="w-5 h-5 text-green-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <span className="text-sm text-green-800 font-medium">Filing fee paid — thank you.</span>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-mt-green/30 bg-green-50/50 p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h4 className="text-sm font-semibold text-mt-dark">Return filing fee</h4>
          <p className="text-sm text-gray-600 mt-0.5">
            {yearsFiled} back-year return{yearsFiled === 1 ? '' : 's'} filed for {entityName} · ${feePerYear.toFixed(2)}/year
          </p>
          {credit > 0 && (
            <p className="text-xs text-gray-500 mt-1">
              ${gross.toFixed(2)} − ${credit.toFixed(2)} account credit
            </p>
          )}
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-mt-dark">${total.toFixed(2)}</div>
          <div className="text-xs text-gray-500">due now</div>
        </div>
      </div>
      {error && <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>}
      <button
        type="button"
        onClick={pay}
        disabled={loading}
        className="mt-4 w-full sm:w-auto px-5 py-2.5 text-sm font-semibold bg-mt-green text-white rounded-lg hover:opacity-90 disabled:opacity-50"
      >
        {loading ? 'Opening secure checkout…' : `Pay $${total.toFixed(2)} securely`}
      </button>
      <p className="text-xs text-gray-400 mt-2">Secure card payment via Stripe.</p>
    </div>
  );
}
