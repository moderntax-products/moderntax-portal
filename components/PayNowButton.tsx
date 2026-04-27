'use client';

/**
 * PayNowButton — manager-facing CTA that creates an early Mercury invoice
 * for the current month's running total and opens the Mercury hosted pay
 * page in a new tab.
 *
 * Used in the "This Month So Far" panel so a manager can pay before the
 * 1st-of-month auto-invoice cron fires (e.g., closing out the month
 * mid-month, or paying as you go).
 *
 * Disabled when:
 *   - No billable amount this month (free trial covers everything, or
 *     no completed entities yet)
 *   - Mercury isn't enrolled yet (button label shifts to "Enroll first")
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  billableThisMonth: number;
  amountThisMonth: number;
  mercuryEnrolled: boolean;
}

export function PayNowButton({ billableThisMonth, amountThisMonth, mercuryEnrolled }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const disabled = billableThisMonth === 0 || !mercuryEnrolled || submitting;

  const handlePay = async () => {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/billing/pay-now', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || data.error || 'Failed to create payment');
        setSubmitting(false);
        return;
      }
      // Open Mercury hosted pay page in new tab
      if (data.pay_url) window.open(data.pay_url, '_blank', 'noopener,noreferrer');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create payment');
    } finally {
      setSubmitting(false);
    }
  };

  if (!mercuryEnrolled) {
    return (
      <div className="text-right">
        <button
          disabled
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-gray-200 text-gray-500 text-sm font-bold rounded-lg cursor-not-allowed"
          title="Enroll in Mercury auto-pay first (Payment Settings card above)"
        >
          Pay Now →
        </button>
        <p className="text-[10px] text-gray-500 mt-1">Enroll above to enable</p>
      </div>
    );
  }

  if (billableThisMonth === 0) {
    return (
      <div className="text-right">
        <button
          disabled
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-gray-200 text-gray-500 text-sm font-bold rounded-lg cursor-not-allowed"
          title="No billable usage this month yet"
        >
          Pay Now →
        </button>
        <p className="text-[10px] text-gray-500 mt-1">Nothing to pay yet</p>
      </div>
    );
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={handlePay}
        disabled={disabled}
        className="inline-flex items-center gap-2 px-5 py-2.5 bg-mt-green text-white text-sm font-bold rounded-lg hover:bg-mt-green/90 shadow-sm hover:shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? (
          <>
            <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
            </svg>
            Creating invoice…
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
            </svg>
            Pay ${amountThisMonth.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} →
          </>
        )}
      </button>
      <p className="text-[10px] text-gray-600 mt-1">Opens Mercury · ACH or wire</p>
      {error && <p className="text-xs text-red-600 mt-1 max-w-xs">{error}</p>}
    </div>
  );
}
