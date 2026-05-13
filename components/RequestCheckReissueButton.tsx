'use client';

/**
 * In-portal Check Reissue request widget — TWO billing paths.
 *
 * Lives on the ERC report admin page (/admin/erc-report/[entityId]),
 * one instance per quarter row where status='refund_returned_undelivered'.
 *
 * Billing paths (admin picks per quarter):
 *
 *   1. Pay $999.99 via Stripe (instant) — fastest start
 *      - POST /api/admin/check-reissue creates the row
 *      - POST /api/billing/purchase {kind:'check_reissue', check_reissue_id}
 *      - Redirect to Stripe Checkout
 *      - On payment confirmation webhook flips payment_status='paid'
 *      - Service begins immediately
 *
 *   2. Request $1,000 Mercury ACH invoice — net-15 friendly
 *      - POST /api/admin/check-reissue creates the row
 *      - That endpoint emails Matt with the Mercury invoice details
 *      - Matt creates and sends the Mercury invoice from the dashboard
 *      - Service begins on Mercury payment confirmation
 *
 * Both paths first hit /api/admin/check-reissue (idempotent — same row
 * across both flows). The Stripe path then chains the purchase call.
 *
 * The button collapses to a single "Requested" pill once a row exists.
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
}: Props) {
  const [pending, startTransition] = useTransition();
  const [reqId, setReqId] = useState<string | null>(existingRequestId || null);
  const [status, setStatus] = useState<string | null>(existingStatus || null);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  // Helper — both paths first need a check_reissue_requests row.
  const ensureRow = async (): Promise<string | null> => {
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
      setError(data.error || 'Failed to create reissue request');
      return null;
    }
    return data.id as string;
  };

  // Path A: pay $999.99 via Stripe, redirect to checkout
  const startStripe = () => {
    setError(null);
    startTransition(async () => {
      try {
        const id = await ensureRow();
        if (!id) return;
        const purchaseRes = await fetch('/api/billing/purchase', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'check_reissue', check_reissue_id: id }),
        });
        const data = await purchaseRes.json();
        if (!purchaseRes.ok || !data.url) {
          setError(data.error || 'Could not start Stripe checkout');
          setReqId(id);
          setStatus('requested');
          return;
        }
        // Redirect to Stripe Checkout
        window.location.href = data.url;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      }
    });
  };

  // Path B: Mercury ACH invoice — just create the row, /api/admin/check-reissue
  // emails Matt with the Mercury invoice details. No redirect.
  const startMercury = () => {
    setError(null);
    startTransition(async () => {
      try {
        const id = await ensureRow();
        if (!id) return;
        setReqId(id);
        setStatus('requested');
        setConfirmation('Mercury ACH invoice will be sent within 1 business day. Service starts on payment.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      }
    });
  };

  // Already requested OR Mercury-confirmation state
  if (reqId) {
    const paid = status === 'paid';
    return (
      <div className="space-y-1">
        <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded text-xs font-semibold border ${paid ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'bg-blue-50 border-blue-300 text-blue-800'}`}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {paid
            ? <>Reissue · paid · #{reqId.slice(0, 8)}</>
            : <>Reissue requested · #{reqId.slice(0, 8)}</>}
        </div>
        {confirmation && (
          <p className="text-[11px] text-emerald-700 max-w-md">{confirmation}</p>
        )}
      </div>
    );
  }

  // Initial state — two side-by-side payment options
  return (
    <div className="space-y-2 w-full">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={startStripe}
          disabled={pending}
          className="inline-flex items-center gap-2 px-3 py-1.5 bg-mt-green text-white rounded text-xs font-semibold hover:bg-mt-green/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending ? 'Starting…' : 'Pay $999.99 now (Stripe)'}
        </button>
        <button
          type="button"
          onClick={startMercury}
          disabled={pending}
          className="inline-flex items-center gap-2 px-3 py-1.5 bg-white text-mt-dark border border-mt-dark rounded text-xs font-semibold hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Request $1,000 Mercury ACH invoice
        </button>
      </div>
      <p className="text-[11px] text-gray-600 max-w-2xl leading-relaxed">
        <strong>Expected timeline once paid:</strong> Form 8822-B filed within 1 business day · IRS
        Business &amp; Specialty Tax line called within 3 business days · IRS reissues check within
        4–8 weeks of address update · check arrives by mail 2–3 weeks after reissue.
        Recoverable amount on this quarter: <strong>${originalRefundAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>.
      </p>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
