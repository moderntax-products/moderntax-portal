'use client';

/**
 * Button that opens the check-reissue request flow for a single quarter
 * surfaced by the ERC report. Lives on the ERC report page; renders only
 * for quarters where the status is `refund_returned_undelivered`.
 *
 * On click:
 *   - POST /api/admin/check-reissue with the quarter context
 *   - If a request already exists for this quarter, the API dedupes
 *     and returns the existing row's id + status (we surface that
 *     directly instead of error-popping)
 *   - On success, button updates to show "Requested · #<id-short>"
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
        // Step 1: create the check_reissue_requests row (idempotent).
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
        // If the row was already paid (deduped), we don't need to charge again.
        if (data.deduped && data.status === 'paid') {
          setReqId(data.id);
          setStatus(data.status);
          return;
        }
        // Step 2: kick off Stripe Checkout for the $1,000 service fee.
        const purchaseRes = await fetch('/api/billing/purchase', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'check_reissue', check_reissue_id: data.id }),
        });
        const purchaseData = await purchaseRes.json();
        if (!purchaseRes.ok) {
          // If purchase fails the reissue row still exists; surface the error
          // but let the user retry by clicking again.
          setError(purchaseData.error || 'Could not start checkout');
          setReqId(data.id);
          setStatus(data.status);
          return;
        }
        // Redirect to Stripe Checkout. On success, customer returns to
        // /admin/erc-report/<entityId>?reissue=paid&session_id=... which
        // re-renders the page with the "Reissue requested · paid" pill
        // (the webhook will have flipped payment_status by then).
        window.location.href = purchaseData.url;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      }
    });
  };

  if (reqId) {
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-emerald-50 border border-emerald-300 rounded text-xs font-semibold text-emerald-800">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        Reissue requested · {status || 'in queue'} · #{reqId.slice(0, 8)}
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
        {pending ? 'Requesting…' : `Request Check Reissue · $${serviceFee.toLocaleString('en-US')}`}
      </button>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
