'use client';

/**
 * Button that opens the check-reissue request flow for a single quarter
 * surfaced by the ERC report. Lives on the ERC report page; renders only
 * for quarters where the status is `refund_returned_undelivered`.
 *
 * Billing model: Mercury ACH (manual invoice from Matt). NOT Stripe —
 * the $1,000 fee + multi-week service makes ACH invoicing the right fit
 * (margin too thin for card processing fees; customers prefer ACH on
 * larger one-off bills). The button records the request in
 * `check_reissue_requests` and the API emails matt@moderntax.io with
 * the context so he can send the Mercury invoice from the dashboard.
 *
 * On click:
 *   - POST /api/admin/check-reissue with the quarter context
 *   - API creates the row + notifies Matt
 *   - Button updates to show a "Mercury invoice incoming" confirmation
 *
 * Idempotent on the API side — if a row already exists for this quarter,
 * the API returns the existing row's id + status and we surface that.
 */

import { useState, useTransition } from 'react';

interface Props {
  entityId: string;
  taxYear: number;
  taxQuarter: 1 | 2 | 3 | 4;
  originalRefundAmount: number;
  originalRefundDate: string | null;
  returnedUndeliveredDate: string | null;
  /** If an active reissue request already exists, render in "already requested" state. */
  existingRequestId?: string | null;
  existingStatus?: string | null;
  serviceFee: number;
}

export function RequestCheckReissueButton({
  entityId,
  taxYear,
  taxQuarter,
  originalRefundAmount,
  originalRefundDate,
  returnedUndeliveredDate,
  existingRequestId,
  existingStatus,
  serviceFee,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [reqId, setReqId] = useState<string | null>(existingRequestId || null);
  const [status, setStatus] = useState<string | null>(existingStatus || null);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/check-reissue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entity_id: entityId,
            tax_year: taxYear,
            tax_quarter: taxQuarter,
            original_refund_amount: originalRefundAmount,
            original_refund_date: originalRefundDate,
            returned_undelivered_date: returnedUndeliveredDate,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Failed to request reissue');
          return;
        }
        // No Stripe redirect — the API has already notified Matt to send
        // the Mercury ACH invoice. Surface the request id so the user
        // sees confirmation. The page will re-render the persistent
        // "requested" pill on next load.
        setReqId(data.id);
        setStatus(data.status);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      }
    });
  };

  if (reqId) {
    const paid = status === 'paid';
    return (
      <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded text-xs font-semibold border ${paid ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'bg-blue-50 border-blue-300 text-blue-800'}`}>
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        {paid
          ? <>Reissue · paid · #{reqId.slice(0, 8)}</>
          : <>Reissue requested · Mercury invoice incoming · #{reqId.slice(0, 8)}</>}
      </div>
    );
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={submit}
        disabled={pending}
        className="inline-flex items-center gap-2 px-3 py-1.5 bg-amber-600 text-white rounded text-xs font-semibold hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pending ? 'Requesting…' : `Request Check Reissue · $${serviceFee.toLocaleString('en-US')} (Mercury ACH)`}
      </button>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
