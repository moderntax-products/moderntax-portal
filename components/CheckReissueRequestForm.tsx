'use client';

/**
 * Public, no-auth check-reissue request widget. Lives on the ERC sample
 * (/sample-transcripts/erc-report) inside the action-items panel for
 * quarters where the refund check came back undelivered.
 *
 * TWO billing paths — customer chooses:
 *
 *   1. Stripe Checkout ($999.99) — pay-now-with-card. Clicks the
 *      primary green button → POST /api/billing/self-serve-checkout
 *      pack='check-reissue-stripe' → redirect to Stripe → back to
 *      /welcome on success. Webhook emails Matt to start the work.
 *
 *   2. Mercury ACH invoice ($1,000) — net-15-friendly. Clicks the
 *      secondary outline button → form expands asking for email +
 *      business name + optional EIN/notes → POST
 *      /api/billing/check-reissue-request → SendGrid email to Matt
 *      to send a Mercury invoice from the dashboard. Customer pays
 *      via ACH from their business bank.
 *
 * No portal account is created in either path — this is intentional.
 * Off-platform onboarding once the work begins.
 */

import { useState, useTransition } from 'react';

interface Props {
  /** Pre-filled context surfaced from the ERC report row. */
  prefill?: {
    refundQuarter?: string;     // e.g. "2020 Q4"
    refundAmount?: number;      // dollars
  };
}

export function CheckReissueRequestForm({ prefill }: Props) {
  // Three UI states:
  //   'closed'        — only the two side-by-side trigger buttons show
  //   'mercury_form'  — Mercury ACH form fields are visible
  //   'stripe_pending'— user clicked the Stripe button, we're POSTing
  //   'confirmed'     — Mercury form submitted; show success message
  const [uiState, setUiState] = useState<'closed' | 'mercury_form' | 'stripe_pending' | 'confirmed'>('closed');
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [ein, setEin] = useState('');
  const [notes, setNotes] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  const startStripe = () => {
    setError(null);
    setUiState('stripe_pending');
    startTransition(async () => {
      try {
        const res = await fetch('/api/billing/self-serve-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pack: 'check-reissue-stripe' }),
        });
        const data = await res.json();
        if (!res.ok || !data.url) {
          setError(data.error || 'Could not start Stripe checkout');
          setUiState('closed');
          return;
        }
        window.location.href = data.url;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
        setUiState('closed');
      }
    });
  };

  const submitMercury = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/billing/check-reissue-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email.trim(),
            businessName: businessName.trim(),
            ein: ein.trim() || undefined,
            refundQuarter: prefill?.refundQuarter,
            refundAmount: prefill?.refundAmount,
            notes: notes.trim() || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Could not submit request');
          return;
        }
        setConfirmation(
          data.message ||
            `Thanks — we'll send a Mercury ACH invoice for $1,000 to ${email.trim()} within 1 business day.`,
        );
        setUiState('confirmed');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      }
    });
  };

  // ─── Confirmed (Mercury form submitted) ────────────────────────────────
  if (uiState === 'confirmed' && confirmation) {
    return (
      <div className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 max-w-md">
        <div className="flex items-start gap-2">
          <svg className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <div>
            <p className="font-semibold">Request received — Mercury ACH invoice incoming</p>
            <p className="mt-1 text-emerald-800">{confirmation}</p>
          </div>
        </div>
      </div>
    );
  }

  // ─── Mercury form expanded ─────────────────────────────────────────────
  if (uiState === 'mercury_form') {
    return (
      <form onSubmit={submitMercury} className="rounded border border-amber-300 bg-white px-4 py-3 max-w-lg w-full text-xs">
        <div className="mb-2 flex items-center justify-between">
          <p className="font-semibold text-amber-900">
            Request Mercury ACH invoice · $1,000
          </p>
          <button
            type="button"
            onClick={() => setUiState('closed')}
            className="text-[11px] text-gray-500 hover:text-gray-700"
          >
            cancel
          </button>
        </div>
        <p className="text-[11px] text-gray-600 mb-3">
          We&apos;ll email you a Mercury ACH invoice. Pay via business bank ACH (net-15). Once
          paid, we file Form 8822-B and call the IRS Business &amp; Specialty Tax line.
          {prefill?.refundQuarter && (
            <> Pre-filled context: <strong>{prefill.refundQuarter}</strong>
              {prefill.refundAmount ? ` · $${prefill.refundAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} returned` : ''}.
            </>
          )}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
          <label className="block">
            <span className="text-[11px] font-medium text-gray-700">Email *</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@firm.com"
              className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-mt-green focus:ring-1 focus:ring-mt-green"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium text-gray-700">Business name *</span>
            <input
              type="text"
              required
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="Acme Tax Services LLC"
              className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-mt-green focus:ring-1 focus:ring-mt-green"
            />
          </label>
        </div>

        <label className="block mb-2">
          <span className="text-[11px] font-medium text-gray-700">Client EIN (optional)</span>
          <input
            type="text"
            value={ein}
            onChange={(e) => setEin(e.target.value)}
            placeholder="12-3456789"
            className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-mt-green focus:ring-1 focus:ring-mt-green"
          />
        </label>

        <label className="block mb-3">
          <span className="text-[11px] font-medium text-gray-700">Notes (optional)</span>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. mailing address has changed, multiple checks involved, etc."
            className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-mt-green focus:ring-1 focus:ring-mt-green"
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center px-3 py-1.5 bg-amber-600 text-white rounded text-xs font-semibold hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pending ? 'Submitting…' : 'Send my Mercury invoice request →'}
          </button>
          <span className="text-[10px] text-gray-500">
            Invoice arrives within 1 business day.
          </span>
        </div>
        {error && <p className="mt-2 text-[11px] text-red-600">{error}</p>}
      </form>
    );
  }

  // ─── Default: two side-by-side trigger buttons ─────────────────────────
  return (
    <div className="inline-flex flex-col items-start gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={startStripe}
          disabled={pending || uiState === 'stripe_pending'}
          className="inline-flex items-center gap-2 px-3 py-1.5 bg-amber-600 text-white rounded text-xs font-semibold hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {uiState === 'stripe_pending' ? 'Starting checkout…' : 'Pay $999.99 now (Stripe) →'}
        </button>
        <span className="text-[11px] text-amber-800">or</span>
        <button
          type="button"
          onClick={() => setUiState('mercury_form')}
          disabled={pending}
          className="inline-flex items-center gap-2 px-3 py-1.5 bg-white border border-amber-400 text-amber-800 rounded text-xs font-semibold hover:bg-amber-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Request Mercury ACH invoice ($1,000)
        </button>
      </div>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
