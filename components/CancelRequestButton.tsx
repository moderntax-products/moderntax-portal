'use client';

/**
 * Cancel Request button — shown on /request/[id] for the request owner,
 * managers on the same client, or admins. Only renders when the request
 * is in a cancellable status (submitted, 8821_sent, 8821_signed). Once
 * IRS pull begins, cancellation is no longer safe and the button is
 * absent.
 *
 * Two-step confirmation:
 *   1. First click → opens a modal with optional reason field.
 *   2. Confirm in modal → POST /api/expert/cancel-request → reload the page.
 *
 * Reason text is captured for audit history but is optional.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  requestId: string;
  loanNumber?: string | null;
  status: string;
}

const CANCELLABLE_STATUSES = ['submitted', '8821_sent', '8821_signed'];

export function CancelRequestButton({ requestId, loanNumber, status }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!CANCELLABLE_STATUSES.includes(status)) return null;

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/expert/cancel-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, reason }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to cancel');
        setSubmitting(false);
        return;
      }
      router.refresh();
      setOpen(false);
    } catch {
      setError('Network error');
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-sm font-medium text-red-700 border border-red-300 rounded-md hover:bg-red-50 transition-colors"
      >
        Cancel Request
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => !submitting && setOpen(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-mt-dark mb-2">Cancel this request?</h3>
            <p className="text-sm text-gray-600 mb-1">
              Loan {loanNumber || 'request'} will be cancelled. All pending entities and expert assignments will be marked failed.
            </p>
            <p className="text-xs text-gray-500 mb-4">
              You can only cancel requests that haven&apos;t started IRS pulling yet. Once an expert begins processing, the request must be completed or contact support.
            </p>

            <label className="block text-xs font-medium text-gray-700 mb-1">Reason (optional)</label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. wrong borrower, duplicate of another request, no longer needed"
              maxLength={500}
              rows={3}
              className="w-full text-sm border border-gray-300 rounded p-2 mb-3 focus:ring-2 focus:ring-mt-green/30 focus:border-mt-green"
            />

            {error && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-3">{error}</div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                disabled={submitting}
                className="px-3 py-1.5 text-sm font-medium text-gray-700 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
              >
                Keep Request
              </button>
              <button
                onClick={handleConfirm}
                disabled={submitting}
                className="px-3 py-1.5 text-sm font-semibold text-white bg-red-600 rounded hover:bg-red-700 disabled:opacity-50"
              >
                {submitting ? 'Cancelling…' : 'Cancel Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
